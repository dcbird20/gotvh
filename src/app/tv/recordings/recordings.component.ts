import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { ReturnNavigationContext, ReturnNavigationService } from '../../services/return-navigation.service';
import { TvheadendService } from '../../services/tvheadend.service';

@Component({
  selector: 'app-recordings',
  standalone: true,
  imports: [CommonModule, TvFocusableDirective],
  templateUrl: './recordings.component.html',
  styleUrls: ['./recordings.component.scss']
})
export class RecordingsComponent implements OnInit {
  loading = true;
  error = '';
  actionError = '';
  upcoming: any[] = [];
  finished: any[] = [];
  failed: any[] = [];
  activeTab: 'upcoming' | 'finished' | 'failed' = 'upcoming';
  pendingActionUuid = '';
  private pendingReturnContext: ReturnNavigationContext | null = null;
  private shouldApplyInitialRowFocus = true;

  constructor(
    private tvh: TvheadendService,
    private router: Router,
    private route: ActivatedRoute,
    private returnNavigation: ReturnNavigationService
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
      upcoming: this.tvh.getScheduledRecordings().pipe(catchError(() => of([]))),
      finished: this.tvh.getFinishedRecordings().pipe(catchError(() => of([]))),
      failed: this.tvh.getFailedRecordings().pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ upcoming, finished, failed }) => {
        this.upcoming = upcoming;
        this.finished = finished;
        this.failed = failed;
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

  removeRecording(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) {
      return;
    }

    this.pendingActionUuid = uuid;
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