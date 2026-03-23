import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { RecordingPlaybackProgressService } from '../../services/recording-playback-progress.service';
import { ReturnNavigationContext, ReturnNavigationService } from '../../services/return-navigation.service';
import { TvheadendService } from '../../services/tvheadend.service';

@Component({
  selector: 'app-recordings',
  standalone: true,
  imports: [CommonModule, FormsModule, TvFocusableDirective],
  templateUrl: './recordings.component.html',
  styleUrls: ['./recordings.component.scss']
})
export class RecordingsComponent implements OnInit {
  loading = true;
  error = '';
  actionError = '';
  actionMessage = '';
  upcoming: any[] = [];
  finished: any[] = [];
  failed: any[] = [];
  channels: any[] = [];
  activeTab: 'upcoming' | 'finished' | 'failed' = 'finished';
  filterQuery = '';
  pendingActionUuid = '';
  confirmingRemoveUuid = '';
  editingUuid = '';
  editForm = {
    title: '',
    start: '',
    stop: ''
  };
  private pendingReturnContext: ReturnNavigationContext | null = null;
  private shouldApplyInitialRowFocus = true;
  private brokenChannelIcons = new Set<string>();

  constructor(
    private tvh: TvheadendService,
    private router: Router,
    private route: ActivatedRoute,
    private returnNavigation: ReturnNavigationService,
    private recordingProgress: RecordingPlaybackProgressService
  ) {}

  ngOnInit(): void {
    this.capturePendingReturnContext();
    this.refresh();
  }

  refresh(): void {
    this.loading = true;
    this.error = '';
    this.actionError = '';

    forkJoin({
      channels: this.tvh.getChannels().pipe(catchError(() => of([]))),
      upcoming: this.tvh.getScheduledRecordings().pipe(catchError(() => of([]))),
      finished: this.tvh.getFinishedRecordings().pipe(catchError(() => of([]))),
      failed: this.tvh.getFailedRecordings().pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ channels, upcoming, finished, failed }) => {
        this.channels = channels;
        this.upcoming = upcoming;
        this.finished = finished;
        this.failed = failed;
        this.brokenChannelIcons.clear();
        this.loading = false;
        this.restoreReturnFocusIfNeeded();
        this.focusFirstRowOnEntryIfNeeded();
      },
      error: (error: any) => {
        this.loading = false;
        this.error = this.describeError(error);
      }
    });
  }

  selectTab(tab: 'upcoming' | 'finished' | 'failed'): void {
    this.activeTab = tab;
    this.confirmingRemoveUuid = '';
    this.cancelEdit();
  }

  getActiveEntries(): any[] {
    if (this.activeTab === 'finished') {
      return this.finished;
    }
    if (this.activeTab === 'failed') {
      return this.failed;
    }
    return this.upcoming;
  }

  getFilteredEntries(): any[] {
    const query = String(this.filterQuery || '').trim().toLowerCase();
    const entries = this.getActiveEntries();
    if (!query) {
      return entries;
    }

    return entries.filter(entry => this.buildEntrySearchText(entry).includes(query));
  }

  getVisibleCount(): number {
    return this.getFilteredEntries().length;
  }

  getFilterSummary(): string {
    const total = this.getActiveEntries().length;
    const visible = this.getVisibleCount();
    if (!this.filterQuery.trim()) {
      return `${visible} visible`;
    }

    return `${visible} of ${total} shown`;
  }

  getActiveTabLabel(): string {
    if (this.activeTab === 'finished') {
      return 'Completed library';
    }
    if (this.activeTab === 'failed') {
      return 'Failures needing attention';
    }
    return 'Upcoming queue';
  }

  getEntryStateLabel(entry: any): string {
    return String(entry?.status || entry?.state || (this.activeTab === 'upcoming' ? 'Scheduled' : this.activeTab === 'failed' ? 'Failed' : 'Finished')).trim();
  }

  getEntryTone(entry: any): 'ok' | 'warn' | 'danger' | 'neutral' {
    const state = this.getEntryStateLabel(entry).toLowerCase();
    if (state.includes('fail') || state.includes('error') || state.includes('miss')) {
      return 'danger';
    }
    if (state.includes('sched') || state.includes('record') || state.includes('run')) {
      return 'warn';
    }
    if (state.includes('finish') || state.includes('complete') || state.includes('done')) {
      return 'ok';
    }
    return 'neutral';
  }

  canWatch(entry: any): boolean {
    return this.activeTab !== 'upcoming' && !!this.getRecordingRef(entry) && !Number(entry?.fileremoved || 0);
  }

  canEdit(entry: any): boolean {
    return !!String(entry?.uuid || '').trim();
  }

  canEditSchedule(): boolean {
    return this.activeTab === 'upcoming';
  }

  canExtendStop(entry: any): boolean {
    return this.activeTab === 'upcoming' && !!String(entry?.uuid || '').trim() && Number(entry?.stop || 0) > 0;
  }

  startEdit(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid || this.pendingActionUuid) {
      return;
    }

    this.actionError = '';
    this.confirmingRemoveUuid = '';
    this.editingUuid = uuid;
    this.editForm = {
      title: String(entry?.disp_title || entry?.title || '').trim(),
      start: this.formatDateTimeInput(entry?.start),
      stop: this.formatDateTimeInput(entry?.stop)
    };
  }

  cancelEdit(): void {
    this.editingUuid = '';
    this.editForm = {
      title: '',
      start: '',
      stop: ''
    };
  }

  isEditing(entry: any): boolean {
    return this.editingUuid === String(entry?.uuid || '').trim();
  }

  saveEdit(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    const title = String(this.editForm.title || '').trim();
    if (!uuid || !title || this.pendingActionUuid) {
      if (!title) {
        this.actionError = 'A title is required.';
      }
      return;
    }

    const changes: { disp_title?: string; start?: number; stop?: number } = {};
    const currentTitle = String(entry?.disp_title || entry?.title || '').trim();
    if (title !== currentTitle) {
      changes.disp_title = title;
    }

    if (this.canEditSchedule()) {
      const nextStart = this.parseDateTimeInput(this.editForm.start);
      const nextStop = this.parseDateTimeInput(this.editForm.stop);
      if (!nextStart || !nextStop) {
        this.actionError = 'Start and stop times are required for upcoming recordings.';
        return;
      }
      if (nextStop <= nextStart) {
        this.actionError = 'Stop time must be after start time.';
        return;
      }

      if (nextStart !== Number(entry?.start || 0)) {
        changes.start = nextStart;
      }
      if (nextStop !== Number(entry?.stop || 0)) {
        changes.stop = nextStop;
      }
    }

    if (Object.keys(changes).length === 0) {
      this.cancelEdit();
      return;
    }

    this.pendingActionUuid = uuid;
    this.actionError = '';
    this.tvh.updateRecording(uuid, changes).subscribe({
      next: () => {
        this.pendingActionUuid = '';
        this.cancelEdit();
        this.refresh();
      },
      error: (error: any) => {
        this.pendingActionUuid = '';
        this.actionError = this.describeError(error);
      }
    });
  }

  async watchRecording(entry: any): Promise<void> {
    const recordingRef = this.getRecordingRef(entry);
    if (!recordingRef) {
      return;
    }

    const hasAuth = await this.tvh.ensureBasicAuth('Enter your TVHeadend credentials to play this recording.');
    if (!hasAuth) {
      return;
    }

    const returnToken = this.returnNavigation.createToken({
      source: 'recordings',
      payload: {
        tab: this.activeTab,
        uuid: String(entry?.uuid || '').trim()
      }
    });

    this.router.navigate(['/player', String(entry?.uuid || 'recording').trim() || 'recording'], {
      queryParams: {
        name: entry?.disp_title || entry?.title || entry?.channelname || 'Recording',
        playback: 'recording',
        recordingRef,
        returnTo: '/recordings',
        returnToken
      }
    });
  }

  async restartRecording(entry: any): Promise<void> {
    const recordingRef = this.getRecordingRef(entry);
    if (!recordingRef) {
      return;
    }

    this.recordingProgress.clear(recordingRef);
    await this.watchRecording(entry);
  }

  private capturePendingReturnContext(): void {
    const token = String(this.route.snapshot.queryParamMap.get('returnToken') || '').trim();
    if (!token) {
      return;
    }

    const context = this.returnNavigation.consumeToken(token);
    if (context?.source === 'recordings') {
      this.pendingReturnContext = context;
    }

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { returnToken: null },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  private restoreReturnFocusIfNeeded(): void {
    const context = this.pendingReturnContext;
    if (!context) {
      return;
    }

    this.pendingReturnContext = null;
    this.shouldApplyInitialRowFocus = false;
    const tab = String(context.payload['tab'] || '').trim();
    const uuid = String(context.payload['uuid'] || '').trim();

    if (tab === 'upcoming' || tab === 'finished' || tab === 'failed') {
      this.activeTab = tab;
    }

    if (!uuid) {
      return;
    }

    setTimeout(() => {
      const escapedUuid = uuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const target = document.querySelector(`[data-recording-row-uuid="${escapedUuid}"]`) as HTMLElement | null;
      target?.focus();
    }, 0);
  }

  private focusFirstRowOnEntryIfNeeded(): void {
    if (!this.shouldApplyInitialRowFocus || this.pendingReturnContext) {
      return;
    }

    const activeEntries = this.getActiveEntries();
    const firstUuid = String(activeEntries[0]?.uuid || '').trim();
    if (!firstUuid) {
      return;
    }

    this.shouldApplyInitialRowFocus = false;
    setTimeout(() => {
      const escapedUuid = firstUuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const target = document.querySelector(`[data-recording-row-uuid="${escapedUuid}"]`) as HTMLElement | null;
      target?.focus();
    }, 0);
  }

  cancelRecording(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) {
      return;
    }

    this.pendingActionUuid = uuid;
    this.actionError = '';
    this.tvh.cancelRecording(uuid).subscribe({
      next: () => {
        this.pendingActionUuid = '';
        this.refresh();
      },
      error: (error: any) => {
        this.pendingActionUuid = '';
        this.actionError = this.describeError(error);
      }
    });
  }

  extendStopTime(entry: any, minutes: number): void {
    const uuid = String(entry?.uuid || '').trim();
    const stop = Number(entry?.stop || 0);
    const extensionMinutes = Number(minutes || 0);
    if (!uuid || !stop || extensionMinutes <= 0 || this.pendingActionUuid) {
      return;
    }

    this.pendingActionUuid = uuid;
    this.actionError = '';
    this.actionMessage = '';
    this.tvh.updateRecording(uuid, { stop: stop + (extensionMinutes * 60) }).subscribe({
      next: () => {
        this.pendingActionUuid = '';
        this.actionMessage = `Extended stop time by ${extensionMinutes} minute${extensionMinutes === 1 ? '' : 's'}.`;
        this.refresh();
      },
      error: (error: any) => {
        this.pendingActionUuid = '';
        this.actionError = this.describeError(error);
      }
    });
  }

  createAutorecFromEntry(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    const title = String(entry?.disp_title || entry?.title || '').trim();
    if (!uuid || !title || this.pendingActionUuid) {
      if (!title) {
        this.actionError = 'A recording title is required to create an Auto-Rec rule.';
      }
      return;
    }

    const conf: any = {
      enabled: 1,
      title: `^${this.escapeRegex(title)}$`,
      fulltext: 0,
      comment: `Created from recording: ${title}`
    };

    const channelUuid = this.resolveChannelUuid(entry);
    if (channelUuid) {
      conf.channel = channelUuid;
    }

    const configName = String(entry?.config_name || '').trim();
    if (configName) {
      conf.config_name = configName;
    }

    this.pendingActionUuid = uuid;
    this.actionError = '';
    this.actionMessage = '';
    this.tvh.createAutorec(conf).subscribe({
      next: () => {
        this.pendingActionUuid = '';
        this.actionMessage = channelUuid
          ? 'Created an Auto-Rec rule for this title on the same channel.'
          : 'Created an Auto-Rec rule for this title.';
      },
      error: (error: any) => {
        this.pendingActionUuid = '';
        this.actionError = this.describeError(error);
      }
    });
  }

  removeRecording(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) {
      return;
    }

    if (this.confirmingRemoveUuid !== uuid) {
      this.confirmingRemoveUuid = uuid;
      return;
    }

    this.pendingActionUuid = uuid;
    this.confirmingRemoveUuid = '';
    this.actionError = '';
    this.tvh.removeRecording(uuid).subscribe({
      next: () => {
        this.pendingActionUuid = '';
        this.refresh();
      },
      error: (error: any) => {
        this.pendingActionUuid = '';
        this.actionError = this.describeError(error);
      }
    });
  }

  isBusy(entry: any): boolean {
    return this.pendingActionUuid !== '' && this.pendingActionUuid === String(entry?.uuid || '').trim();
  }

  isConfirmingRemove(entry: any): boolean {
    return this.confirmingRemoveUuid === String(entry?.uuid || '').trim();
  }

  clearRemoveConfirmation(): void {
    this.confirmingRemoveUuid = '';
  }

  formatDateTime(value: any): string {
    const numericValue = Number(value || 0);
    if (!numericValue) {
      return 'Unknown';
    }
    const epochMs = numericValue > 100000000000 ? numericValue : numericValue * 1000;
    return new Date(epochMs).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatDuration(entry: any): string {
    const start = Number(entry?.start || 0);
    const stop = Number(entry?.stop || 0);
    if (!start || !stop || stop <= start) {
      return '';
    }
    const minutes = Math.round((stop - start) / 60);
    if (minutes >= 60) {
      return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
  }

  getSummary(entry: any): string {
    const raw = entry?.description ?? entry?.subtitle ?? entry?.comment ?? '';
    if (raw == null) {
      return '';
    }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      return String(raw).trim();
    }
    if (Array.isArray(raw)) {
      return raw.map(item => this.flattenValue(item)).filter(Boolean).join(' · ').trim();
    }
    return this.flattenValue(raw).trim();
  }

  getVisibleSummary(entry: any): string {
    const summary = this.getSummary(entry);
    const failureDetail = this.getFailureDetail(entry);
    if (summary && failureDetail && summary.toLowerCase() === failureDetail.toLowerCase()) {
      return '';
    }
    return summary;
  }

  getFailureDetail(entry: any): string {
    if (this.activeTab !== 'failed') {
      return '';
    }

    const state = this.getEntryStateLabel(entry).trim().toLowerCase();
    const candidates = [
      entry?.error,
      entry?.errors,
      entry?.message,
      entry?.status_reason,
      entry?.last_error,
      entry?.errorcode,
      entry?.sched_status,
    ].map(value => this.flattenValue(value).trim())
      .filter(Boolean)
      .filter(value => value.toLowerCase() !== state);

    return candidates[0] || '';
  }

  getFileStateLabel(entry: any): string {
    if (Number(entry?.fileremoved || 0)) {
      return 'File removed';
    }

    if (this.activeTab !== 'upcoming' && !this.canWatch(entry)) {
      return 'Playback unavailable';
    }

    return '';
  }

  getResumeLabel(entry: any): string {
    if (!this.canWatch(entry)) {
      return '';
    }

    const recordingRef = this.getRecordingRef(entry);
    const progress = recordingRef ? this.recordingProgress.get(recordingRef) : null;
    const seconds = Number(progress?.positionSeconds || 0);
    if (seconds < 30) {
      return '';
    }

    return `Resume at ${this.formatClock(seconds)}`;
  }

  getChannelIcon(entry: any): string {
    const key = this.getChannelIconKey(entry);
    if (!key || this.brokenChannelIcons.has(key)) {
      return '';
    }

    const channelUuid = this.resolveChannelUuid(entry);
    if (!channelUuid) {
      return '';
    }

    const channel = this.channels.find(candidate => String(candidate?.uuid || '').trim() === channelUuid);
    return String(channel?.icon || '').trim();
  }

  handleChannelIconError(entry: any): void {
    const key = this.getChannelIconKey(entry);
    if (key) {
      this.brokenChannelIcons.add(key);
    }
  }

  trackByUuid(_: number, entry: any): string {
    return String(entry?.uuid || entry?.disp_title || entry?.title || _);
  }

  private getRecordingRef(entry: any): string {
    const directUrl = String(entry?.url || '').trim();
    if (directUrl) {
      return directUrl;
    }

    if (this.activeTab === 'upcoming') {
      return '';
    }

    return String(entry?.uuid || '').trim();
  }

  private flattenValue(value: any): string {
    if (value == null) {
      return '';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.flattenValue(item)).filter(Boolean).join(' ');
    }
    if (typeof value === 'object') {
      return Object.values(value).map(item => this.flattenValue(item)).filter(Boolean).join(' ');
    }
    return '';
  }

  private buildEntrySearchText(entry: any): string {
    return [
      entry?.disp_title,
      entry?.title,
      entry?.channelname,
      this.getEntryStateLabel(entry),
      this.getFailureDetail(entry),
      this.getSummary(entry),
      this.getFileStateLabel(entry),
      this.formatDateTime(entry?.start),
      this.formatDuration(entry)
    ].map(value => this.flattenValue(value).trim().toLowerCase()).filter(Boolean).join(' ');
  }

  private resolveChannelUuid(entry: any): string {
    const directChannel = String(entry?.channel || '').trim();
    if (directChannel) {
      return directChannel;
    }

    const channelName = String(entry?.channelname || '').trim().toLowerCase();
    if (!channelName) {
      return '';
    }

    const exactMatch = this.channels.find(channel => String(channel?.name || '').trim().toLowerCase() === channelName);
    if (exactMatch?.uuid) {
      return String(exactMatch.uuid).trim();
    }

    const looseMatch = this.channels.find(channel => {
      const candidate = String(channel?.name || '').trim().toLowerCase();
      return candidate.includes(channelName) || channelName.includes(candidate);
    });

    return String(looseMatch?.uuid || '').trim();
  }

  private getChannelIconKey(entry: any): string {
    return String(entry?.uuid || entry?.channel || entry?.channelname || '').trim().toLowerCase();
  }

  private escapeRegex(value: string): string {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private formatDateTimeInput(value: any): string {
    const numericValue = Number(value || 0);
    if (!numericValue) {
      return '';
    }

    const epochMs = numericValue > 100000000000 ? numericValue : numericValue * 1000;
    const date = new Date(epochMs);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  }

  private parseDateTimeInput(value: string): number {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return 0;
    }

    const epochMs = new Date(normalizedValue).getTime();
    if (!Number.isFinite(epochMs) || epochMs <= 0) {
      return 0;
    }

    return Math.floor(epochMs / 1000);
  }

  private formatClock(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds || 0)));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  private describeError(error: any): string {
    const status = Number(error?.status || 0);
    if (status === 401) {
      return 'Authentication required. Use TVH Login in the sidebar and refresh.';
    }
    if (status === 403) {
      return 'The current TVHeadend account does not have DVR access.';
    }
    if (status === 0) {
      return 'TVHeadend is unreachable. Check the backend and proxy configuration.';
    }
    return 'TVHeadend returned an unexpected DVR response.';
  }
}