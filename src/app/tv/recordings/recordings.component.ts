import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { RecordingPlaybackProgressService } from '../../services/recording-playback-progress.service';
import { ReturnNavigationContext, ReturnNavigationService } from '../../services/return-navigation.service';
import { SpatialNavService } from '../../services/spatial-nav.service';
import { TvheadendService } from '../../services/tvheadend.service';

interface RecordingProgramStack {
  key: string;
  title: string;
  entries: any[];
  anchorEntry: any;
  childEntries: any[];
  unwatchedCount: number;
  latestStart: number;
}

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
  filterInputValue = '';
  pendingActionUuid = '';
  confirmingRemoveUuid = '';
  confirmingRemoveStackKey = '';
  expandedActionsUuid = '';
  editingUuid = '';
  expandedStackKey = '';
  expandedStackVisibleChildren = 0;
  editForm = {
    title: '',
    start: '',
    stop: ''
  };
  private pendingReturnContext: ReturnNavigationContext | null = null;
  private shouldApplyInitialRowFocus = true;
  private brokenChannelIcons = new Set<string>();
  private actionSheetTriggerElement: HTMLElement | null = null;
  private pendingPostDeleteFocusUuid = '';
  private readonly stackChildPreviewLimit = 3;
  private readonly stackChildRevealStep = 4;
  private stackLastFocusedChildIndex = new Map<string, number>();
  private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stacksCacheKey = '';
  private stacksCacheResult: RecordingProgramStack[] = [];
  private stacksCacheRevision = 0;

  constructor(
    private tvh: TvheadendService,
    private router: Router,
    private route: ActivatedRoute,
    private returnNavigation: ReturnNavigationService,
    private recordingProgress: RecordingPlaybackProgressService,
    private spatialNav: SpatialNavService
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
        this.upcoming = this.sortUpcomingFirst(upcoming);
        this.finished = this.sortMostRecentFirst(finished);
        this.failed = this.sortMostRecentFirst(failed);
        this.brokenChannelIcons.clear();
        if (this.expandedStackKey && !this.getProgramStacks().some(stack => stack.key === this.expandedStackKey)) {
          this.expandedStackKey = '';
          this.expandedStackVisibleChildren = 0;
        }
        this.loading = false;
        this.restoreReturnFocusIfNeeded();
        this.restorePostDeleteFocusIfNeeded();
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
    this.confirmingRemoveStackKey = '';
    this.expandedActionsUuid = '';
    this.expandedStackKey = '';
    this.expandedStackVisibleChildren = 0;
    this.stackLastFocusedChildIndex.clear();
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
    if (!this.usesProgramStacks()) {
      return this.getFilteredEntriesByQuery();
    }

    const visibleEntries: any[] = [];
    for (const stack of this.getProgramStacks()) {
      visibleEntries.push(stack.anchorEntry);
      if (this.isStackExpanded(stack)) {
        visibleEntries.push(...this.getVisibleChildEntries(stack));
      }
    }

    return visibleEntries;
  }

  getProgramStacks(): RecordingProgramStack[] {
    const cacheKey = `${this.activeTab}|${this.filterQuery}|${this.finished.length}|${this.upcoming.length}|${this.failed.length}|${this.stacksCacheRevision}`;
    if (cacheKey === this.stacksCacheKey) {
      return this.stacksCacheResult;
    }
    this.stacksCacheKey = cacheKey;
    this.stacksCacheResult = this.buildProgramStacks();
    return this.stacksCacheResult;
  }

  private buildProgramStacks(): RecordingProgramStack[] {
    const filteredEntries = this.getFilteredEntriesByQuery();
    if (!filteredEntries.length) {
      return [];
    }

    const groupedEntries = new Map<string, any[]>();
    const orderedKeys: string[] = [];

    for (const entry of filteredEntries) {
      const key = this.usesProgramStacks()
        ? `stack:${this.getProgramGroupingKey(entry)}`
        : `single:${String(entry?.uuid || this.getProgramGroupingKey(entry)).trim()}`;

      if (!groupedEntries.has(key)) {
        groupedEntries.set(key, []);
        orderedKeys.push(key);
      }

      groupedEntries.get(key)?.push(entry);
    }

    return orderedKeys.map(key => {
      const entries = groupedEntries.get(key) || [];
      const anchorEntry = this.resolveStackAnchorEntry(entries);
      const anchorUuid = String(anchorEntry?.uuid || '').trim();
      const childEntries = entries.filter(candidate => String(candidate?.uuid || '').trim() !== anchorUuid);
      const unwatchedCount = entries.filter(candidate => !this.isMarkedWatched(candidate)).length;
      const latestStart = entries.reduce((maxStart, candidate) => {
        const candidateStart = Number(candidate?.start || 0);
        return candidateStart > maxStart ? candidateStart : maxStart;
      }, 0);

      return {
        key,
        title: String(anchorEntry?.disp_title || anchorEntry?.title || 'Untitled Recording').trim() || 'Untitled Recording',
        entries,
        anchorEntry,
        childEntries,
        unwatchedCount,
        latestStart
      };
    });
  }

  getStackVisibleEntries(stack: RecordingProgramStack): any[] {
    if (!this.isStackExpanded(stack)) {
      return [stack.anchorEntry];
    }

    return [stack.anchorEntry, ...this.getVisibleChildEntries(stack)];
  }

  trackByStackKey(_: number, stack: RecordingProgramStack): string {
    return stack.key;
  }

  isStackExpanded(stack: RecordingProgramStack): boolean {
    return !!stack.childEntries.length && this.expandedStackKey === stack.key;
  }

  toggleStack(stack: RecordingProgramStack): void {
    if (!stack.childEntries.length) {
      return;
    }

    const isSameStack = this.expandedStackKey === stack.key;
    this.expandedStackKey = isSameStack ? '' : stack.key;
    this.expandedStackVisibleChildren = isSameStack
      ? 0
      : Math.min(this.stackChildPreviewLimit, stack.childEntries.length);
  }

  getStackToggleLabel(stack: RecordingProgramStack): string {
    const count = stack.childEntries.length;
    if (!count) {
      return '';
    }

    return this.isStackExpanded(stack) ? 'Collapse' : `Show ${count} more`;
  }

  getStackEpisodeCountLabel(stack: RecordingProgramStack): string {
    const count = stack.entries.length;
    return `${count} item${count === 1 ? '' : 's'}`;
  }

  getStackShowAllLabel(stack: RecordingProgramStack): string {
    const hiddenCount = this.getStackHiddenChildCount(stack);
    if (hiddenCount <= 0) {
      return 'Show less';
    }

    const nextReveal = Math.min(hiddenCount, this.stackChildRevealStep);
    return `Show ${nextReveal} more`;
  }

  shouldShowStackShowAllToggle(stack: RecordingProgramStack): boolean {
    if (!this.isStackExpanded(stack)) {
      return false;
    }

    return stack.childEntries.length > this.stackChildPreviewLimit;
  }

  getStackHiddenChildCount(stack: RecordingProgramStack): number {
    if (!this.isStackExpanded(stack)) {
      return 0;
    }

    return Math.max(0, stack.childEntries.length - this.getVisibleChildCountForStack(stack));
  }

  toggleShowAllInStack(stack: RecordingProgramStack): void {
    if (!this.shouldShowStackShowAllToggle(stack)) {
      return;
    }

    if (this.getStackHiddenChildCount(stack) > 0) {
      this.revealMoreChildrenInStack(stack);
      return;
    }

    this.expandedStackVisibleChildren = Math.min(this.stackChildPreviewLimit, stack.childEntries.length);
  }

  rememberFocusedEntryInStack(entry: any, stack: RecordingProgramStack, isParent: boolean): void {
    if (!this.usesProgramStacks()) {
      return;
    }

    if (isParent) {
      this.stackLastFocusedChildIndex.set(stack.key, -1);
      return;
    }

    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) {
      return;
    }

    const index = stack.childEntries.findIndex(candidate => String(candidate?.uuid || '').trim() === uuid);
    if (index >= 0) {
      this.stackLastFocusedChildIndex.set(stack.key, index);
    }
  }

  handleRowArrowRight(entry: any, stack: RecordingProgramStack, isParent: boolean, event: KeyboardEvent): void {
    if (!isParent || !stack.childEntries.length || !this.usesProgramStacks() || this.isEditing(entry)) {
      return;
    }

    if (this.getPrimaryActionEntryId(entry)) {
      return;
    }

    if (this.isStackExpanded(stack) && this.getStackHiddenChildCount(stack) > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.revealMoreChildrenInStack(stack);

      setTimeout(() => {
        const preferredChild = this.getPreferredChildEntry(stack);
        if (!preferredChild) {
          return;
        }

        this.spatialNav.focusByElementId(this.getRowBodyId(preferredChild));
      });
      return;
    }

    if (!this.isStackExpanded(stack)) {
      event.preventDefault();
      event.stopPropagation();
      this.expandedStackKey = stack.key;
      this.expandedStackVisibleChildren = Math.min(this.stackChildPreviewLimit, stack.childEntries.length);

      setTimeout(() => {
        const preferredChild = this.getPreferredChildEntry(stack);
        if (!preferredChild) {
          return;
        }

        this.spatialNav.focusByElementId(this.getRowBodyId(preferredChild));
      });
    }
  }

  getRowBodyRightTarget(entry: any, stack: RecordingProgramStack, isParent: boolean): string {
    const primaryActionId = this.getPrimaryActionEntryId(entry);
    if (primaryActionId) {
      return primaryActionId;
    }

    if (!isParent || !stack.childEntries.length || !this.usesProgramStacks()) {
      return this.getRowBodyId(entry);
    }

    if (!this.isStackExpanded(stack)) {
      return this.getRowBodyId(entry);
    }

    const preferredChild = this.getPreferredChildEntry(stack);
    if (preferredChild) {
      return this.getRowBodyId(preferredChild);
    }

    return this.getRowBodyId(entry);
  }

  handleRowBodyActivate(entry: any, stack: RecordingProgramStack, isParent: boolean): void {
    if (this.isEditing(entry)) {
      return;
    }

    if (isParent && stack.childEntries.length) {
      if (this.isStackExpanded(stack) && this.getStackHiddenChildCount(stack) > 0) {
        this.revealMoreChildrenInStack(stack);
        return;
      }

      this.toggleStack(stack);
      return;
    }

    if (this.canWatch(entry)) {
      void this.watchRecording(entry);
      return;
    }
  }

  private usesProgramStacks(): boolean {
    return this.activeTab !== 'upcoming';
  }

  private shouldIgnoreGlobalRecordingsKeys(target: HTMLElement | null): boolean {
    if (this.loading || !!this.error || this.getFilteredEntries().length === 0) {
      return true;
    }

    if (this.confirmingRemoveUuid || this.confirmingRemoveStackKey || this.expandedActionsUuid) {
      return true;
    }

    if (!target) {
      return false;
    }

    return !!target.closest('input, textarea, select, [contenteditable="true"], .recording-actions-modal, .recording-confirm-modal');
  }

  private getRecordingsKeyTarget(event: KeyboardEvent): HTMLElement | null {
    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement && activeElement !== document.body) {
      return activeElement;
    }

    return event.target as HTMLElement | null;
  }

  private getChannelPageDirection(event: KeyboardEvent): -1 | 1 | null {
    const key = String(event.key || '').trim();
    const code = String((event as any).code || '').trim();
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);
    const isBareChannelUp = keyCode === 33 && !key && !code;
    const isBareChannelDown = keyCode === 34 && !key && !code;

    if (
      key === 'ChannelUp'
      || key === 'MediaChannelUp'
      || code === 'ChannelUp'
      || code === 'MediaChannelUp'
      || isBareChannelUp
      || keyCode === 92
      || keyCode === 166
      || keyCode === 427
    ) {
      return -1;
    }

    if (
      key === 'ChannelDown'
      || key === 'MediaChannelDown'
      || code === 'ChannelDown'
      || code === 'MediaChannelDown'
      || isBareChannelDown
      || keyCode === 93
      || keyCode === 167
      || keyCode === 428
    ) {
      return 1;
    }

    return null;
  }

  private moveRecordingFocusByPage(target: EventTarget | null, direction: -1 | 1): boolean {
    const visibleEntries = this.getFilteredEntries();
    if (!visibleEntries.length) {
      return false;
    }

    const sourceUuid = this.resolveRecordingUuidFromTarget(target)
      || this.resolveRecordingUuidFromTarget(document.activeElement as HTMLElement | null)
      || String(visibleEntries[0]?.uuid || '').trim();
    const currentIndex = visibleEntries.findIndex(entry => String(entry?.uuid || '').trim() === sourceUuid);
    const fallbackIndex = direction > 0 ? 0 : Math.max(0, visibleEntries.length - 1);
    const baseIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
    const pageSize = Math.max(1, this.currentRecordingPageSize());
    const nextIndex = Math.max(0, Math.min(visibleEntries.length - 1, baseIndex + (direction * pageSize)));
    const nextUuid = String(visibleEntries[nextIndex]?.uuid || '').trim();
    if (!nextUuid) {
      return false;
    }

    this.expandStackForEntry(nextUuid);
    return this.focusRecordingRowByUuid(nextUuid);
  }

  private resolveRecordingUuidFromTarget(target: EventTarget | null): string {
    const element = target as HTMLElement | null;
    const row = element?.closest('[data-recording-row-uuid]') as HTMLElement | null;
    return String(row?.getAttribute('data-recording-row-uuid') || '').trim();
  }

  private focusRecordingRowByUuid(uuid: string): boolean {
    const rowUuid = String(uuid || '').trim();
    if (!rowUuid) {
      return false;
    }

    setTimeout(() => {
      this.spatialNav.focusByElementId(`recording-body-${rowUuid}`);
    });
    return true;
  }

  private currentRecordingPageSize(): number {
    const rows = Array.from(document.querySelectorAll('[data-recording-row-uuid]')) as HTMLElement[];
    if (!rows.length) {
      return 6;
    }

    const sampleCount = Math.min(8, rows.length);
    const sample = rows.slice(0, sampleCount);
    const totalHeight = sample.reduce((sum, element) => sum + Math.max(1, element.getBoundingClientRect().height), 0);
    const averageHeight = Math.max(1, totalHeight / sampleCount);
    const viewportHeight = window.innerHeight || 1080;
    const estimatedRows = Math.floor((viewportHeight * 0.75) / averageHeight);
    return Math.max(3, estimatedRows);
  }

  private getVisibleChildEntries(stack: RecordingProgramStack): any[] {
    if (!this.isStackExpanded(stack)) {
      return [];
    }

    return stack.childEntries.slice(0, this.getVisibleChildCountForStack(stack));
  }

  private getVisibleChildCountForStack(stack: RecordingProgramStack): number {
    if (!this.isStackExpanded(stack)) {
      return 0;
    }

    const minVisible = Math.min(this.stackChildPreviewLimit, stack.childEntries.length);
    const requestedVisible = Math.max(minVisible, Number(this.expandedStackVisibleChildren || 0));
    return Math.min(stack.childEntries.length, requestedVisible);
  }

  private revealMoreChildrenInStack(stack: RecordingProgramStack): void {
    const currentVisible = this.getVisibleChildCountForStack(stack);
    const nextVisible = currentVisible + this.stackChildRevealStep;
    this.expandedStackVisibleChildren = Math.min(stack.childEntries.length, nextVisible);
  }

  private getFilteredEntriesByQuery(): any[] {
    const query = String(this.filterQuery || '').trim().toLowerCase();
    const entries = this.getActiveEntries();
    if (!query) {
      return entries;
    }

    return entries.filter(entry => this.buildEntrySearchText(entry).includes(query));
  }

  getVisibleCount(): number {
    return this.getFilteredEntriesByQuery().length;
  }

  getFilterSummary(): string {
    const total = this.getActiveEntries().length;
    const visible = this.getVisibleCount();
    if (!this.filterQuery.trim()) {
      return `${visible} visible`;
    }

    return `${visible} of ${total} shown`;
  }

  onFilterInputChange(): void {
    if (this.filterDebounceTimer !== null) {
      clearTimeout(this.filterDebounceTimer);
    }
    this.filterDebounceTimer = setTimeout(() => {
      this.filterQuery = this.filterInputValue;
      this.filterDebounceTimer = null;
    }, 350);
  }

  clearFilter(): void {
    if (this.filterDebounceTimer !== null) {
      clearTimeout(this.filterDebounceTimer);
      this.filterDebounceTimer = null;
    }
    this.filterInputValue = '';
    this.filterQuery = '';
  }

  getWatchedSummary(): string {
    const activeEntries = this.getActiveEntries();
    if (!activeEntries.length || this.activeTab === 'upcoming') {
      return '';
    }

    const watchedCount = activeEntries.filter(entry => this.isMarkedWatched(entry)).length;
    return `${watchedCount} watched`;
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

  getSortSummary(): string {
    if (this.activeTab === 'upcoming') {
      return 'Soonest first';
    }

    return 'Newest first';
  }

  shouldShowExpandedDetails(entry: any): boolean {
    return this.activeTab === 'failed'
      || this.isActionPanelOpen(entry)
      || this.isEditing(entry);
  }

  getHeaderSummary(): string {
    const total = this.getActiveEntries().length;
    const visible = this.getVisibleCount();
    const watchedSummary = this.getWatchedSummary();
    const visibility = this.filterQuery.trim() ? `${visible}/${total}` : `${visible}`;
    return watchedSummary ? `${visibility} items • ${watchedSummary}` : `${visibility} items`;
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

  getPrimaryWatchLabel(entry: any): string {
    return this.getResumeLabel(entry) ? 'Resume Recording' : 'Play Recording';
  }

  getPrimaryWatchCompactLabel(entry: any): string {
    return this.getResumeLabel(entry) ? 'Resume' : 'Play';
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
    this.expandedActionsUuid = '';
    this.expandStackForEntry(uuid);
    this.editingUuid = uuid;
    this.editForm = {
      title: String(entry?.disp_title || entry?.title || '').trim(),
      start: this.formatDateTimeInput(entry?.start),
      stop: this.formatDateTimeInput(entry?.stop)
    };

    setTimeout(() => {
      this.spatialNav.focusByElementId(`recording-edit-stop-plus-30-${uuid}`);
    });
  }

  cancelEdit(): void {
    this.editingUuid = '';
    this.editForm = {
      title: '',
      start: '',
      stop: ''
    };
  }

  isActionPanelOpen(entry: any): boolean {
    const uuid = String(entry?.uuid || '').trim();
    return !!uuid && (this.expandedActionsUuid === uuid || this.confirmingRemoveUuid === uuid);
  }

  toggleActionPanel(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid || this.pendingActionUuid) {
      return;
    }

    if (this.expandedActionsUuid === uuid) {
      this.closeActionPanel();
      return;
    }

    this.actionSheetTriggerElement = document.activeElement as HTMLElement | null;
    this.confirmingRemoveUuid = '';
    this.expandedActionsUuid = uuid;

    setTimeout(() => {
      const firstActionId = this.getSecondaryActionFirstId(entry) || this.getActionSheetCloseId();
      this.spatialNav.focusByElementId(firstActionId);
    });
  }

  handleRowLongPress(entry: any, event?: Event): void {
    if (!this.hasSecondaryActions(entry) || this.isEditing(entry)) {
      return;
    }

    if (event?.cancelable) {
      event.preventDefault();
    }

    const uuid = String(entry?.uuid || '').trim();
    if (!uuid || this.pendingActionUuid) {
      return;
    }

    this.actionSheetTriggerElement = this.actionSheetTriggerElement || (document.activeElement as HTMLElement | null);
    this.confirmingRemoveUuid = '';
    this.expandedActionsUuid = uuid;

    setTimeout(() => {
      const firstActionId = this.getSecondaryActionFirstId(entry) || this.getActionSheetCloseId();
      this.spatialNav.focusByElementId(firstActionId);
    });
  }

  handleRowContextMenu(entry: any, event: MouseEvent): void {
    event.preventDefault();
    this.handleRowLongPress(entry, event);
  }

  @HostListener('document:keydown.escape')
  handleEscapeKey(): void {
    if (this.confirmingRemoveStackKey) {
      this.clearRemoveConfirmation();
      return;
    }

    if (this.confirmingRemoveUuid) {
      this.clearRemoveConfirmation();
      return;
    }

    if (this.expandedActionsUuid) {
      this.closeActionPanel();
    }
  }

  @HostListener('document:keydown.pageup', ['$event'])
  handlePageUp(event: KeyboardEvent): void {
    const target = this.getRecordingsKeyTarget(event);
    if (this.shouldIgnoreGlobalRecordingsKeys(target)) {
      return;
    }

    event.preventDefault();
    this.moveRecordingFocusByPage(target, -1);
  }

  @HostListener('document:keydown.pagedown', ['$event'])
  handlePageDown(event: KeyboardEvent): void {
    const target = this.getRecordingsKeyTarget(event);
    if (this.shouldIgnoreGlobalRecordingsKeys(target)) {
      return;
    }

    event.preventDefault();
    this.moveRecordingFocusByPage(target, 1);
  }

  @HostListener('document:keydown', ['$event'])
  handleChannelPageKeys(event: KeyboardEvent): void {
    const direction = this.getChannelPageDirection(event);
    if (!direction) {
      return;
    }

    const target = this.getRecordingsKeyTarget(event);
    if (this.shouldIgnoreGlobalRecordingsKeys(target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.moveRecordingFocusByPage(target, direction);
  }

  hasSecondaryActions(entry: any): boolean {
    return !!this.getResumeLabel(entry)
      || this.canExtendStop(entry)
      || !!String(entry?.uuid || '').trim()
      || this.activeTab !== 'upcoming';
  }

  getActionPanelLabel(entry: any): string {
    return this.isActionPanelOpen(entry) ? 'Hide Tools' : 'Tools';
  }

  getActionPanelCompactLabel(entry: any): string {
    return this.isActionPanelOpen(entry) ? 'Less' : 'More';
  }

  getActionSheetEntry(): any | null {
    const uuid = String(this.expandedActionsUuid || '').trim();
    if (!uuid) {
      return null;
    }

    const allEntries = [...this.upcoming, ...this.finished, ...this.failed];
    return allEntries.find(entry => String(entry?.uuid || '').trim() === uuid) || null;
  }

  getActionSheetTitle(entry: any): string {
    return String(entry?.disp_title || entry?.title || 'Recording').trim();
  }

  getActionSheetCloseId(): string {
    return 'recording-actions-close';
  }

  closeActionPanel(skipFocusRestore = false): void {
    this.expandedActionsUuid = '';
    if (skipFocusRestore) {
      this.actionSheetTriggerElement = null;
      return;
    }

    const restoreTarget = this.actionSheetTriggerElement;
    this.actionSheetTriggerElement = null;
    setTimeout(() => {
      restoreTarget?.focus();
    });
  }

  useBrowserEllipsisActions(): boolean {
    return !this.isCapacitorNativePlatform();
  }

  /**
   * Returns the ID of the button immediately to the LEFT of the action-panel toggle
   * in the primary action row, matching the visual DOM order:
   *   upcoming:  ... Adjust → Cancel → [toggle]
   *   watchable: ... Play → [toggle]
   *   other:     body → [toggle]
   */
  getActionToggleNavLeft(entry: any): string {
    if (this.canWatch(entry)) {
      return this.getPrimaryWatchId(entry);
    }
    if (this.activeTab === 'upcoming') {
      return this.getPrimaryCancelId(entry);
    }
    return this.getRowBodyId(entry);
  }

  getRowBodyId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    return uuid ? `recording-body-${uuid}` : '';
  }

  getPrimaryWatchId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    return uuid ? `recording-primary-watch-${uuid}` : '';
  }

  getPrimaryAdjustId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    return uuid ? `recording-primary-adjust-${uuid}` : '';
  }

  getPrimaryCancelId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    return uuid ? `recording-primary-cancel-${uuid}` : '';
  }

  getPrimaryActionEntryId(entry: any): string {
    if (this.canWatch(entry)) {
      return this.getPrimaryWatchId(entry);
    }

    if (this.activeTab === 'upcoming' && this.canEdit(entry)) {
      return this.getPrimaryAdjustId(entry);
    }

    if (this.activeTab === 'upcoming') {
      return this.getPrimaryCancelId(entry);
    }

    if (this.hasSecondaryActions(entry)) {
      return this.getActionPanelToggleId(entry);
    }

    return '';
  }

  getActionPanelToggleId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    return uuid ? `recording-tools-toggle-${uuid}` : '';
  }

  getVerticalTargetId(entry: any, direction: 'up' | 'down', controlType: string): string {
    const currentControlId = this.getControlIdForEntry(entry, controlType);
    const adjacentEntry = this.getAdjacentVisibleEntry(entry, direction);

    if (!adjacentEntry) {
      return currentControlId;
    }

    const sameControlId = this.getControlIdForEntry(adjacentEntry, controlType);
    if (sameControlId) {
      return sameControlId;
    }

    const adjacentPrimary = this.getPrimaryActionEntryId(adjacentEntry);
    if (adjacentPrimary) {
      return adjacentPrimary;
    }

    return this.getRowBodyId(adjacentEntry) || currentControlId;
  }

  getSecondaryActionFirstId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) {
      return '';
    }

    if (this.showWatchedAction(entry)) {
      return `recording-secondary-watched-${uuid}`;
    }

    if (this.canExtendStop(entry)) {
      return `recording-secondary-extend-30-${uuid}`;
    }

    if (this.getResumeLabel(entry)) {
      return `recording-secondary-restart-${uuid}`;
    }

    if (this.showSecondaryAutorecAction()) {
      return `recording-secondary-autorec-${uuid}`;
    }

    if (this.showSecondaryEditAction(entry)) {
      return `recording-secondary-edit-${uuid}`;
    }

    if (this.activeTab !== 'upcoming') {
      return `recording-secondary-remove-${uuid}`;
    }

    return '';
  }

  showSecondaryAutorecAction(): boolean {
    return this.activeTab !== 'finished';
  }

  showSecondaryEditAction(entry: any): boolean {
    return this.activeTab !== 'upcoming' && this.activeTab !== 'finished' && this.canEdit(entry);
  }

  showSecondaryRemoveAllAction(entry: any): boolean {
    if (this.activeTab === 'upcoming') {
      return false;
    }

    const stack = this.getStackForEntry(entry);
    return !!stack && stack.entries.length > 1;
  }

  getRemoveAllActionLabel(entry: any): string {
    const stack = this.getStackForEntry(entry);
    const count = Number(stack?.entries.length || 0);
    if (this.activeTab === 'failed') {
      return count > 1 ? `Clear Group (${count})` : 'Clear Group';
    }
    return count > 1 ? `Remove Group (${count})` : 'Remove Group';
  }

  getRestartActionLabel(entry: any): string {
    return this.activeTab === 'failed' ? 'Restart Capture' : 'Start Over';
  }

  showWatchedAction(entry: any): boolean {
    return this.activeTab !== 'upcoming' && !!String(entry?.uuid || '').trim();
  }

  isMarkedWatched(entry: any): boolean {
    return Number(entry?.watched ?? 0) > 0;
  }

  toggleWatched(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid || this.pendingActionUuid) {
      return;
    }

    const nowWatched = !this.isMarkedWatched(entry);
    this.pendingActionUuid = uuid;
    this.actionError = '';

    this.tvh.markRecordingWatched(uuid, nowWatched).subscribe({
      next: () => {
        this.pendingActionUuid = '';
        entry.watched = nowWatched ? 1 : 0;
        this.stacksCacheRevision++;
        this.actionMessage = nowWatched ? 'Marked as watched.' : 'Marked as unwatched.';
      },
      error: (error: any) => {
        this.pendingActionUuid = '';
        this.actionError = this.describeError(error);
      }
    });
  }

  getWatchedActionLabel(entry: any): string {
    return this.isMarkedWatched(entry) ? 'Mark Unwatched' : 'Mark Watched';
  }

  getSecondaryWatchedRightId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) { return ''; }
    if (this.getResumeLabel(entry)) { return `recording-secondary-restart-${uuid}`; }
    if (this.showSecondaryAutorecAction()) { return `recording-secondary-autorec-${uuid}`; }
    if (this.showSecondaryEditAction(entry)) { return `recording-secondary-edit-${uuid}`; }
    return `recording-secondary-remove-${uuid}`;
  }

  getSecondaryRestartLeftId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) { return ''; }
    return this.showWatchedAction(entry) ? `recording-secondary-watched-${uuid}` : `recording-secondary-restart-${uuid}`;
  }

  getSecondaryRestartRightId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) { return ''; }
    if (this.showSecondaryAutorecAction()) { return `recording-secondary-autorec-${uuid}`; }
    if (this.showSecondaryEditAction(entry)) { return `recording-secondary-edit-${uuid}`; }
    return `recording-secondary-remove-${uuid}`;
  }

  getSecondaryAutorecLeftId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) { return ''; }
    if (this.getResumeLabel(entry)) { return `recording-secondary-restart-${uuid}`; }
    if (this.showWatchedAction(entry)) { return `recording-secondary-watched-${uuid}`; }
    return `recording-secondary-autorec-${uuid}`;
  }

  getSecondaryRemoveLeftId(entry: any): string {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) { return ''; }
    if (this.showSecondaryEditAction(entry)) { return `recording-secondary-edit-${uuid}`; }
    if (this.showSecondaryAutorecAction()) { return `recording-secondary-autorec-${uuid}`; }
    if (this.getResumeLabel(entry)) { return `recording-secondary-restart-${uuid}`; }
    if (this.showWatchedAction(entry)) { return `recording-secondary-watched-${uuid}`; }
    return `recording-secondary-remove-${uuid}`;
  }

  private getControlIdForEntry(entry: any, controlType: string): string {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) {
      return '';
    }

    switch (controlType) {
      case 'row-body':
        return this.getRowBodyId(entry);
      case 'primary-watch':
        return this.canWatch(entry) ? this.getPrimaryWatchId(entry) : '';
      case 'primary-adjust':
        return this.activeTab === 'upcoming' && this.canEdit(entry) ? this.getPrimaryAdjustId(entry) : '';
      case 'primary-cancel':
        return this.activeTab === 'upcoming' ? this.getPrimaryCancelId(entry) : '';
      case 'action-toggle':
        return this.hasSecondaryActions(entry) ? this.getActionPanelToggleId(entry) : '';
      case 'secondary-watched':
        return this.isActionPanelOpen(entry) && this.showWatchedAction(entry) ? `recording-secondary-watched-${uuid}` : '';
      case 'secondary-restart':
        return this.isActionPanelOpen(entry) && !!this.getResumeLabel(entry) ? `recording-secondary-restart-${uuid}` : '';
      case 'secondary-autorec':
        return this.isActionPanelOpen(entry) && this.showSecondaryAutorecAction() ? `recording-secondary-autorec-${uuid}` : '';
      case 'secondary-edit':
        return this.isActionPanelOpen(entry) && this.showSecondaryEditAction(entry) ? `recording-secondary-edit-${uuid}` : '';
      case 'secondary-remove':
        if (!this.isActionPanelOpen(entry) || this.activeTab === 'upcoming') {
          return '';
        }
        return `recording-secondary-remove-${uuid}`;
      case 'secondary-keep':
        return '';
      default:
        return '';
    }
  }

  private getAdjacentVisibleEntry(entry: any, direction: 'up' | 'down'): any | null {
    const currentUuid = String(entry?.uuid || '').trim();
    if (!currentUuid) {
      return null;
    }

    const visibleEntries = this.getFilteredEntries();
    const index = visibleEntries.findIndex(candidate => String(candidate?.uuid || '').trim() === currentUuid);
    if (index < 0) {
      return null;
    }

    const adjacentIndex = direction === 'up' ? index - 1 : index + 1;
    if (adjacentIndex < 0 || adjacentIndex >= visibleEntries.length) {
      return null;
    }

    return visibleEntries[adjacentIndex];
  }

  getAutorecActionLabel(): string {
    return this.activeTab === 'upcoming' ? 'Create Rule' : 'Series Rule';
  }

  getEditActionLabel(): string {
    return this.activeTab === 'upcoming' ? 'Adjust' : 'Edit Details';
  }

  getRemoveActionLabel(): string {
    return this.activeTab === 'failed' ? 'Clear Failure' : 'Remove Recording';
  }

  getConfirmRemoveActionLabel(): string {
    if (this.pendingActionUuid) {
      return this.activeTab === 'failed' ? 'Clearing…' : 'Removing…';
    }

    return this.activeTab === 'failed' ? 'Yes, Clear' : 'Yes, Remove';
  }

  getConfirmingRemoveEntry(): any | null {
    const uuid = String(this.confirmingRemoveUuid || '').trim();
    if (!uuid) {
      return null;
    }

    const allEntries = [...this.upcoming, ...this.finished, ...this.failed];
    return allEntries.find(entry => String(entry?.uuid || '').trim() === uuid) || null;
  }

  getConfirmRemovePrompt(): string {
    return this.activeTab === 'failed'
      ? 'Are you sure you want to clear this failed recording from the list?'
      : 'Are you sure you want to remove this recording?';
  }

  requestRemoveConfirmation(entry: any): void {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid || this.pendingActionUuid) {
      return;
    }

    if (this.expandedActionsUuid) {
      this.closeActionPanel(true);
    }

    this.confirmingRemoveStackKey = '';
    this.confirmingRemoveUuid = uuid;
    this.actionError = '';

    setTimeout(() => {
      this.spatialNav.focusByElementId('recording-remove-confirm-yes');
    });
  }

  requestRemoveStackConfirmation(entry: any): void {
    if (this.pendingActionUuid) {
      return;
    }

    const stack = this.getStackForEntry(entry);
    if (!stack || stack.entries.length <= 1) {
      return;
    }

    if (this.expandedActionsUuid) {
      this.closeActionPanel(true);
    }

    this.confirmingRemoveUuid = '';
    this.confirmingRemoveStackKey = stack.key;
    this.actionError = '';

    setTimeout(() => {
      this.spatialNav.focusByElementId('recording-remove-stack-confirm-yes');
    });
  }

  isEditing(entry: any): boolean {
    return this.editingUuid === String(entry?.uuid || '').trim();
  }

  getConfirmingRemoveStackEntries(): any[] | null {
    const stackKey = String(this.confirmingRemoveStackKey || '').trim();
    if (!stackKey) {
      return null;
    }

    const stack = this.getProgramStacks().find(candidate => candidate.key === stackKey);
    if (!stack || !stack.entries.length) {
      return null;
    }

    return stack.entries;
  }

  getConfirmRemoveStackPrompt(): string {
    const stackEntries = this.getConfirmingRemoveStackEntries();
    const count = Number(stackEntries?.length || 0);
    if (!count) {
      return '';
    }

    if (this.activeTab === 'failed') {
      return count > 1
        ? `Are you sure you want to clear all ${count} failed recordings in this group?`
        : 'Are you sure you want to clear this failed recording from the list?';
    }

    return count > 1
      ? `Are you sure you want to remove all ${count} recordings in this group?`
      : 'Are you sure you want to remove this recording?';
  }

  getConfirmRemoveStackTarget(): string {
    const stackEntries = this.getConfirmingRemoveStackEntries();
    if (!stackEntries?.length) {
      return '';
    }

    const first = stackEntries[0];
    const title = String(first?.disp_title || first?.title || 'Selected group').trim() || 'Selected group';
    const count = stackEntries.length;
    return count > 1 ? `${title} (${count} items)` : title;
  }

  getConfirmRemoveStackActionLabel(): string {
    if (this.pendingActionUuid) {
      return this.activeTab === 'failed' ? 'Clearing…' : 'Removing…';
    }

    return this.activeTab === 'failed' ? 'Yes, Clear Group' : 'Yes, Remove Group';
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
      const currentStart = Number(entry?.start || 0);
      const nextStop = this.parseDateTimeInput(this.editForm.stop);
      if (!currentStart || !nextStop) {
        this.actionError = 'Stop time is required for upcoming recordings.';
        return;
      }
      if (nextStop <= currentStart) {
        this.actionError = 'Stop time must be after the recording start.';
        return;
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

    // Selecting a recording should collapse any currently expanded nested stack.
    this.expandedStackKey = '';
    this.expandedStackVisibleChildren = 0;

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

    this.expandStackForEntry(uuid);

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

    const visibleEntries = this.getFilteredEntries();
    const firstUuid = String(visibleEntries[0]?.uuid || '').trim();
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

  private restorePostDeleteFocusIfNeeded(): void {
    const focusUuid = String(this.pendingPostDeleteFocusUuid || '').trim();
    if (!focusUuid) {
      return;
    }

    this.pendingPostDeleteFocusUuid = '';
    this.shouldApplyInitialRowFocus = false;

    setTimeout(() => {
      const escapedUuid = focusUuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const target = document.querySelector(`[data-recording-row-uuid="${escapedUuid}"]`) as HTMLElement | null;
      if (target) {
        target.focus();
        return;
      }

      const fallback = document.querySelector('[data-recording-row-uuid]') as HTMLElement | null;
      fallback?.focus();
    }, 0);
  }

  private resolvePostDeleteFocusUuid(removedUuid: string): string {
    const trimmed = String(removedUuid || '').trim();
    if (!trimmed) {
      return '';
    }

    const visibleEntries = this.getFilteredEntries();
    const index = visibleEntries.findIndex(entry => String(entry?.uuid || '').trim() === trimmed);
    if (index < 0) {
      return '';
    }

    const next = visibleEntries[index + 1];
    if (next) {
      return String(next?.uuid || '').trim();
    }

    const previous = visibleEntries[index - 1];
    if (previous) {
      return String(previous?.uuid || '').trim();
    }

    return '';
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

  confirmRemoveRecording(): void {
    const uuid = String(this.confirmingRemoveUuid || '').trim();
    if (!uuid) {
      return;
    }

    this.pendingPostDeleteFocusUuid = this.resolvePostDeleteFocusUuid(uuid);
    this.shouldApplyInitialRowFocus = false;

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

  confirmRemoveStack(): void {
    const stackEntries = this.getConfirmingRemoveStackEntries();
    if (!stackEntries?.length) {
      this.confirmingRemoveStackKey = '';
      return;
    }

    const uuids = stackEntries
      .map(entry => String(entry?.uuid || '').trim())
      .filter(Boolean);

    if (!uuids.length) {
      this.confirmingRemoveStackKey = '';
      return;
    }

    this.pendingPostDeleteFocusUuid = this.resolvePostDeleteFocusUuid(uuids[0]);
    this.shouldApplyInitialRowFocus = false;

    this.pendingActionUuid = uuids[0];
    this.confirmingRemoveUuid = '';
    this.confirmingRemoveStackKey = '';
    this.actionError = '';

    const removals = uuids.map(uuid =>
      this.tvh.removeRecording(uuid).pipe(catchError(error => of({ error, uuid })))
    );

    forkJoin(removals).subscribe({
      next: (results: any[]) => {
        this.pendingActionUuid = '';
        const failures = results.filter(result => !!result?.error);
        if (failures.length) {
          if (failures.length === uuids.length) {
            this.actionError = this.describeError(failures[0].error);
          } else {
            this.actionError = `Removed ${uuids.length - failures.length} items. ${failures.length} failed.`;
          }
        }
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
    this.confirmingRemoveStackKey = '';
  }

  getEditDateTimeLabel(value: string): string {
    const timestamp = this.parseDateTimeInput(value);
    if (!timestamp) {
      return 'Time unavailable';
    }

    return this.formatDateTime(timestamp);
  }

  shiftEditDateTime(field: 'start' | 'stop', minutes: number): void {
    const currentValue = this.parseDateTimeInput(this.editForm[field]);
    const deltaMinutes = Number(minutes || 0);
    if (!currentValue || !deltaMinutes) {
      return;
    }

    const nextValue = currentValue + (deltaMinutes * 60);
    if (nextValue <= 0) {
      return;
    }

    this.editForm = {
      ...this.editForm,
      [field]: this.formatDateTimeInput(nextValue)
    };
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
      const channelUuid = this.resolveChannelUuid(entry);
      if (channelUuid) {
        const channel = this.channels.find(candidate => String(candidate?.uuid || '').trim() === channelUuid);
        if (channel && typeof channel === 'object') {
          this.tvh.recordChannelIconLoadFailure(String(channel?.icon || '').trim());
          channel.icon = '';
        }
      }
      this.brokenChannelIcons.add(key);
    }
  }

  trackByUuid(_: number, entry: any): string {
    return String(entry?.uuid || entry?.disp_title || entry?.title || _);
  }

  private expandStackForEntry(uuid: string): void {
    const targetUuid = String(uuid || '').trim();
    if (!targetUuid || !this.usesProgramStacks()) {
      return;
    }

    const containingStack = this.getProgramStacks().find(stack =>
      stack.childEntries.some(candidate => String(candidate?.uuid || '').trim() === targetUuid)
      || String(stack.anchorEntry?.uuid || '').trim() === targetUuid
    );

    if (containingStack?.childEntries.length) {
      this.expandedStackKey = containingStack.key;
      const childIndex = containingStack.childEntries.findIndex(candidate => String(candidate?.uuid || '').trim() === targetUuid);
      if (childIndex < 0) {
        this.expandedStackVisibleChildren = Math.min(this.stackChildPreviewLimit, containingStack.childEntries.length);
      } else {
        this.expandedStackVisibleChildren = Math.max(
          Math.min(this.stackChildPreviewLimit, containingStack.childEntries.length),
          childIndex + 1
        );
      }
    }
  }

  private getPreferredChildEntry(stack: RecordingProgramStack): any | null {
    const visibleChildren = this.getVisibleChildEntries(stack);
    if (!visibleChildren.length) {
      return null;
    }

    const preferredIndex = Number(this.stackLastFocusedChildIndex.get(stack.key));
    if (Number.isFinite(preferredIndex) && preferredIndex >= 0) {
      const inVisible = visibleChildren[preferredIndex];
      if (inVisible) {
        return inVisible;
      }

      const byUuid = stack.childEntries[preferredIndex];
      if (byUuid && visibleChildren.some(candidate => String(candidate?.uuid || '').trim() === String(byUuid?.uuid || '').trim())) {
        return byUuid;
      }
    }

    return visibleChildren[0];
  }

  private getStackForEntry(entry: any): RecordingProgramStack | null {
    const uuid = String(entry?.uuid || '').trim();
    if (!uuid) {
      return null;
    }

    return this.getProgramStacks().find(stack =>
      stack.entries.some(candidate => String(candidate?.uuid || '').trim() === uuid)
    ) || null;
  }

  private resolveStackAnchorEntry(entries: any[]): any {
    if (!entries.length) {
      return null;
    }

    const resumedEntry = entries.find(candidate => !!this.getResumeLabel(candidate));
    if (resumedEntry) {
      return resumedEntry;
    }

    const unwatchedEntry = entries.find(candidate => !this.isMarkedWatched(candidate));
    if (unwatchedEntry) {
      return unwatchedEntry;
    }

    return entries[0];
  }

  private getProgramGroupingKey(entry: any): string {
    const rawTitle = String(entry?.disp_title || entry?.title || '').trim().toLowerCase();
    const normalizedTitle = rawTitle
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (normalizedTitle) {
      return normalizedTitle;
    }

    return String(entry?.uuid || entry?.channelname || 'untitled').trim().toLowerCase();
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
      this.isMarkedWatched(entry) ? 'watched' : 'unwatched',
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

  private sortMostRecentFirst(entries: any[]): any[] {
    return [...(entries || [])].sort((left, right) => this.resolveEntryRecency(right) - this.resolveEntryRecency(left));
  }

  private isCapacitorNativePlatform(): boolean {
    return !!(window as any)?.Capacitor?.isNativePlatform?.();
  }

  private sortUpcomingFirst(entries: any[]): any[] {
    return [...(entries || [])].sort((left, right) => this.resolveUpcomingOrder(left) - this.resolveUpcomingOrder(right));
  }

  private resolveEntryRecency(entry: any): number {
    const candidates = [
      entry?.stop,
      entry?.start,
      entry?.sched_status_stamp,
      entry?.last_error,
      entry?.updated,
      entry?.timestamp,
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeEpoch(candidate);
      if (normalized > 0) {
        return normalized;
      }
    }

    return 0;
  }

  private resolveUpcomingOrder(entry: any): number {
    const candidates = [
      entry?.start,
      entry?.stop,
      entry?.sched_status_stamp,
      entry?.updated,
      entry?.timestamp,
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeEpoch(candidate);
      if (normalized > 0) {
        return normalized;
      }
    }

    return Number.MAX_SAFE_INTEGER;
  }

  private normalizeEpoch(value: any): number {
    const numericValue = Number(value || 0);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return 0;
    }

    return numericValue > 100000000000 ? numericValue : numericValue * 1000;
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