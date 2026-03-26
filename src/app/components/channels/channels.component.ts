import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of, Subject } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { ReturnNavigationContext, ReturnNavigationService } from '../../services/return-navigation.service';
import { TvheadendService } from '../../services/tvheadend.service';
import { ViewStateCacheService } from '../../services/view-state-cache.service';


@Component({
  selector: 'app-channels',
  standalone: true,
  imports: [CommonModule, FormsModule, TvFocusableDirective],
  templateUrl: './channels.component.html',
  styleUrls: ['./channels.component.scss']
})
export class ChannelsComponent implements OnInit, OnDestroy {
  private readonly viewCacheKey = 'channels';
  private readonly favoritesStorageKey = 'gotvh_fav_channels';
  channels: any[] = [];
  filteredChannels: any[] = [];
  epgEvents: any[] = [];
  focusedChannel: any = null;
  focusedChannelProgram: any = null;
  focusedNextProgram: any = null;
  searchQuery = '';
  searchVisible = false;
  favoritesOnly = false;
  sortMode: 'favorites' | 'number' | 'name' = 'favorites';
  loading = true;
  errorMessage = '';
  epgWarning = '';
  favoriteWarning = '';
  favorites: Set<string> = new Set();
  brokenChannelIcons = new Set<string>();
  private favoriteTagUuid: string | null = null;
  private favoriteSaveInFlight = new Set<string>();
  private pendingReturnContext: ReturnNavigationContext | null = null;
  private activationInProgress = false;

  private destroy$ = new Subject<void>();

  constructor(
    private tvh: TvheadendService,
    private router: Router,
    private route: ActivatedRoute,
    private returnNavigation: ReturnNavigationService,
    private viewStateCache: ViewStateCacheService
  ) {}

  ngOnInit(): void {
    this.capturePendingReturnContext();
    this.restoreCachedViewState();
    this.loadFavorites();
    this.loadData();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadFavorites(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(this.favoritesStorageKey) || '[]');
      this.favorites = new Set(saved);
    } catch {
      this.favorites = new Set();
    }
  }

  private loadData(): void {
    this.epgWarning = '';

    forkJoin({
      channels: this.tvh.getChannelsWithResolvedTags(),
      favoriteTagUuid: this.tvh.getFavoriteChannelTagUuid().pipe(
        catchError(() => of(null))
      ),
      epg: this.tvh.getEpg().pipe(
        catchError((error: any) => {
          this.epgWarning = this.resolveEpgWarning(error);
          return of([]);
        })
      )
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: ({ channels, favoriteTagUuid, epg }) => {
        this.channels = [...channels].sort((a, b) => this.compareByChannelNumber(a, b));
        this.favoriteTagUuid = favoriteTagUuid;
        this.epgEvents = epg;
        this.brokenChannelIcons.clear();
        this.syncFavoritesFromChannels();
        this.updateFavoriteWarning();
        if (!this.epgWarning && this.channels.length > 0 && this.epgEvents.length === 0) {
          this.epgWarning = 'Programme listings are temporarily unavailable from TVHeadend right now. Channels can still be opened.';
        }
        this.filterChannels();
        this.loading = false;
        this.errorMessage = '';

        if (this.filteredChannels.length) {
          const currentUuid = String(this.focusedChannel?.uuid || '').trim();
          const currentMatch = this.filteredChannels.find(channel => String(channel?.uuid || '').trim() === currentUuid);
          this.selectChannel(currentMatch || this.filteredChannels[0]);
        }

        this.persistViewState();
        this.restoreReturnFocusIfNeeded();
      },
      error: (error: any) => {
        this.loading = false;
        this.errorMessage = this.resolveErrorMessage(error);
      }
    });
  }

  private resolveErrorMessage(error: any): string {
    const status = Number(error?.status || 0);

    if (status === 401) {
      return 'TVHeadend requires authentication. Use TVH Login in the sidebar and reload channels.';
    }


    if (status === 403) {
      return 'TVHeadend denied access for the current account. Check API and streaming permissions for this user.';
    }

    if (status === 0) {
      return 'TVHeadend is unreachable. Check that the backend is running and the proxy target is correct.';
    }

    return 'TVHeadend returned an unexpected error while loading channels.';
  }

  private resolveEpgWarning(error: any): string {
    const status = Number(error?.status || 0);

    if (status === 401 || status === 403) {
      return 'Current programme data is unavailable for this account. Channels can still be opened.';
    }

    if (status === 404) {
      return 'Current programme data is unavailable on this TVHeadend build. Channels can still be opened.';
    }

    if (status === 0) {
      return 'Current programme data could not be reached. Channels can still be opened.';
    }

    return 'Current programme data is temporarily unavailable. Channels can still be opened.';
  }

  filterChannels(): void {
    const q = this.searchQuery.toLowerCase().trim();
    const filtered = q
      ? this.channels.filter(ch =>
          (ch.name || '').toLowerCase().includes(q) ||
          String(ch.number || '').includes(q) ||
          String(this.getCurrentProgram(ch)?.title || '').toLowerCase().includes(q) ||
          (ch.__resolvedTagNames || []).some((t: string) =>
            t.toLowerCase().includes(q)
          )
        )
      : [...this.channels];

    const scopeFiltered = this.favoritesOnly
      ? filtered.filter(ch => this.favorites.has(ch.uuid))
      : filtered;

    this.filteredChannels = this.sortVisibleChannels(scopeFiltered);

    const currentUuid = String(this.focusedChannel?.uuid || '').trim();
    const currentMatch = this.filteredChannels.find(ch => String(ch?.uuid || '').trim() === currentUuid);
    if (currentMatch) {
      this.selectChannel(currentMatch);
    } else if (this.filteredChannels.length > 0) {
      this.selectChannel(this.filteredChannels[0]);
    } else {
      this.focusedChannel = null;
      this.focusedChannelProgram = null;
      this.focusedNextProgram = null;
    }

    this.persistViewState();
  }

  cycleSortMode(): void {
    this.sortMode = this.sortMode === 'favorites'
      ? 'number'
      : this.sortMode === 'number'
        ? 'name'
        : 'favorites';
    this.filterChannels();
  }

  getSortModeLabel(): string {
    if (this.sortMode === 'number') {
      return 'Sort: Channel #';
    }

    if (this.sortMode === 'name') {
      return 'Sort: Name';
    }

    return 'Sort: Favorites';
  }

  getSortSummary(): string {
    if (this.sortMode === 'number') {
      return 'Sorted by channel number';
    }

    if (this.sortMode === 'name') {
      return 'Sorted by channel name';
    }

    return 'Favorites first';
  }

  selectChannel(channel: any): void {
    this.focusedChannel = channel;
    this.focusedChannelProgram = this.getCurrentProgram(channel);
    this.focusedNextProgram = this.getNextProgram(channel);
    this.persistViewState();
  }

  handleChannelCardPointerDown(event: PointerEvent, channel: any): void {
    if (!event.isPrimary) {
      return;
    }

    this.selectChannel(channel);

    const target = event.currentTarget as HTMLElement | null;
    target?.focus({ preventScroll: true });
  }

  handleChannelCardClick(event: MouseEvent, channel: any): void {
    this.selectChannel(channel);

    const target = event.currentTarget as HTMLElement | null;
    target?.focus({ preventScroll: true });

    // Remote/select activation arrives here as a synthetic click from the
    // focus directive, so route it into the detail actions explicitly.
    if (event.detail === 0) {
      this.focusDetailActionButton();
    }
  }

  activateChannel(channel: any): void {
    if (!channel) {
      return;
    }

    if (this.activationInProgress) {
      return;
    }

    this.selectChannel(channel);
    void this.watchChannel(channel);
  }

  async watchChannel(channel: any): Promise<void> {
    if (!channel || this.activationInProgress) {
      return;
    }

    this.activationInProgress = true;

    try {
    const hasAuth = await this.tvh.ensureBasicAuth('Enter your TVHeadend credentials to watch live TV.');
    if (!hasAuth) {
      this.activationInProgress = false;
      return;
    }

    const returnToken = this.returnNavigation.createToken({
      source: 'channels',
      payload: {
        channelUuid: String(channel?.uuid || '').trim()
      }
    });

    this.router.navigate(['/player', channel.uuid], {
      queryParams: {
        name: channel.name || 'Live TV',
        returnTo: this.router.url,
        returnToken
      }
    });
    } finally {
      setTimeout(() => {
        this.activationInProgress = false;
      }, 300);
    }
  }

  @HostListener('document:keydown', ['$event'])
  handleChannelTileSelect(event: KeyboardEvent): void {
    this.captureRemoteKey(event);

    if (this.handleDirectionalFocus(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!this.isSelectKey(event) || this.loading || !!this.errorMessage || this.activationInProgress) {
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    const channelCard = active?.closest('.channel-card') as HTMLElement | null;
    if (!channelCard) {
      return;
    }

    const channelUuid = String(channelCard.getAttribute('data-channel-uuid') || '').trim();
    if (!channelUuid) {
      return;
    }

    const match = this.filteredChannels.find(channel => String(channel?.uuid || '').trim() === channelUuid);
    if (!match) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.selectChannel(match);
    this.focusDetailActionButton();
  }

  private capturePendingReturnContext(): void {
    const token = String(this.route.snapshot.queryParamMap.get('returnToken') || '').trim();
    if (!token) {
      return;
    }

    const context = this.returnNavigation.consumeToken(token);
    if (context?.source === 'channels') {
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
    const channelUuid = String(context.payload['channelUuid'] || '').trim();
    if (!channelUuid) {
      return;
    }

    const match = this.filteredChannels.find(channel => String(channel?.uuid || '').trim() === channelUuid);
    if (match) {
      this.selectChannel(match);
    }

    setTimeout(() => {
      const escapedUuid = channelUuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const target = document.querySelector(`.channel-card[data-channel-uuid="${escapedUuid}"]`) as HTMLElement | null;
      target?.focus();
    }, 0);
  }

  private restoreCachedViewState(): void {
    const cached = this.viewStateCache.get<{
      channels: any[];
      epgEvents: any[];
      searchQuery: string;
      searchVisible: boolean;
      favoritesOnly: boolean;
      sortMode: 'favorites' | 'number' | 'name';
      focusedChannelUuid: string;
    }>(this.viewCacheKey);

    if (!cached?.channels?.length) {
      return;
    }

    this.channels = cached.channels;
    this.epgEvents = cached.epgEvents || [];
    this.searchQuery = String(cached.searchQuery || '');
    this.searchVisible = !!cached.searchVisible;
    this.favoritesOnly = !!cached.favoritesOnly;
    this.sortMode = cached.sortMode === 'number' || cached.sortMode === 'name' || cached.sortMode === 'favorites'
      ? cached.sortMode
      : 'favorites';
    this.filterChannels();

    const focusedUuid = String(cached.focusedChannelUuid || '').trim();
    const match = this.filteredChannels.find(channel => String(channel?.uuid || '').trim() === focusedUuid);
    if (match) {
      this.selectChannel(match);
    } else if (this.filteredChannels.length) {
      this.selectChannel(this.filteredChannels[0]);
    }

    this.loading = false;
  }

  private persistViewState(): void {
    if (!this.channels.length) {
      return;
    }

    this.viewStateCache.set(this.viewCacheKey, {
      channels: this.channels,
      epgEvents: this.epgEvents,
      searchQuery: this.searchQuery,
      searchVisible: this.searchVisible,
      favoritesOnly: this.favoritesOnly,
      sortMode: this.sortMode,
      focusedChannelUuid: String(this.focusedChannel?.uuid || '').trim()
    });
  }

  private sortVisibleChannels(channels: any[]): any[] {
    const source = [...(channels || [])];

    if (this.sortMode === 'number') {
      return source.sort((left, right) => this.compareByChannelNumber(left, right));
    }

    if (this.sortMode === 'name') {
      return source.sort((left, right) => this.compareByChannelName(left, right));
    }

    const favorites = source
      .filter(channel => this.favorites.has(String(channel?.uuid || '').trim()))
      .sort((left, right) => this.compareByChannelNumber(left, right));
    const nonFavorites = source
      .filter(channel => !this.favorites.has(String(channel?.uuid || '').trim()))
      .sort((left, right) => this.compareByChannelNumber(left, right));

    return [...favorites, ...nonFavorites];
  }

  private compareByChannelNumber(left: any, right: any): number {
    const leftNumber = this.resolveChannelNumberSortValue(left);
    const rightNumber = this.resolveChannelNumberSortValue(right);
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }

    return this.compareByChannelName(left, right);
  }

  private resolveChannelNumberSortValue(channel: any): number {
    const raw = String(channel?.number ?? '').trim();
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return Number.MAX_SAFE_INTEGER;
  }

  private compareByChannelName(left: any, right: any): number {
    const leftName = String(left?.name || '').trim();
    const rightName = String(right?.name || '').trim();
    return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: 'base' });
  }

  toggleFavorite(channel: any): void {
    const channelUuid = String(channel?.uuid || '').trim();
    if (!channelUuid || this.favoriteSaveInFlight.has(channelUuid)) {
      return;
    }

    const nextFavoriteState = !this.favorites.has(channelUuid);
    this.applyFavoriteState(channelUuid, nextFavoriteState);

    if (!this.favoriteTagUuid) {
      this.updateFavoriteWarning();
      return;
    }

    this.favoriteSaveInFlight.add(channelUuid);
    this.tvh.updateChannelFavorite(channel, this.favoriteTagUuid, nextFavoriteState)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (nextTags) => {
          this.favoriteSaveInFlight.delete(channelUuid);
          this.assignChannelTags(channelUuid, nextTags);
          this.persistFavoritesLocally();
        },
        error: () => {
          this.favoriteSaveInFlight.delete(channelUuid);
          this.applyFavoriteState(channelUuid, !nextFavoriteState);
          this.favoriteWarning = 'Could not save favorites to TVHeadend. Your last change was not persisted.';
        }
      });
  }

  toggleSearch(): void {
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.searchQuery = '';
      this.filterChannels();
    }
  }

  toggleFavoritesOnly(): void {
    this.favoritesOnly = !this.favoritesOnly;
    this.filterChannels();
  }

  isFavorite(channel: any): boolean {
    return this.favorites.has(channel.uuid);
  }

  private syncFavoritesFromChannels(): void {
    if (!this.favoriteTagUuid) {
      this.persistFavoritesLocally();
      return;
    }

    const tagUuid = this.favoriteTagUuid;
    this.favorites = new Set(
      this.channels
        .filter(channel => this.getChannelTagIds(channel).includes(tagUuid))
        .map(channel => String(channel?.uuid || '').trim())
        .filter(Boolean)
    );
    this.persistFavoritesLocally();
  }

  private updateFavoriteWarning(): void {
    if (this.favoriteTagUuid) {
      if (this.favoriteWarning.startsWith('Favorites are being stored on this device')) {
        this.favoriteWarning = '';
      }
      return;
    }

    this.favoriteWarning = 'Favorites are being stored on this device because TVHeadend has no favorites channel tag configured.';
  }

  private applyFavoriteState(channelUuid: string, favorite: boolean): void {
    if (favorite) {
      this.favorites.add(channelUuid);
    } else {
      this.favorites.delete(channelUuid);
    }

    if (this.favoriteTagUuid) {
      this.assignChannelFavoriteTag(channelUuid, favorite);
    }

    this.persistFavoritesLocally();
    this.filterChannels();
  }

  private assignChannelFavoriteTag(channelUuid: string, favorite: boolean): void {
    if (!this.favoriteTagUuid) {
      return;
    }

    const favoriteTagUuid = this.favoriteTagUuid;
    this.forEachChannelByUuid(channelUuid, channel => {
      const nextTags = favorite
        ? Array.from(new Set([...this.getChannelTagIds(channel), favoriteTagUuid]))
        : this.getChannelTagIds(channel).filter(tagUuid => tagUuid !== favoriteTagUuid);

      channel.tags = nextTags;
      channel.__resolvedTagNames = this.resolveLocalTagNames(channel, nextTags);
    });
  }

  private assignChannelTags(channelUuid: string, tags: string[]): void {
    this.forEachChannelByUuid(channelUuid, channel => {
      channel.tags = [...tags];
      channel.__resolvedTagNames = this.resolveLocalTagNames(channel, tags);
    });
  }

  private forEachChannelByUuid(channelUuid: string, callback: (channel: any) => void): void {
    const seen = new Set<any>();
    [this.channels, this.filteredChannels, [this.focusedChannel]].forEach(group => {
      (group || []).forEach((channel: any) => {
        if (!channel || seen.has(channel)) {
          return;
        }

        if (String(channel?.uuid || '').trim() === channelUuid) {
          seen.add(channel);
          callback(channel);
        }
      });
    });
  }

  private getChannelTagIds(channel: any): string[] {
    const sourceValues = [channel?.tags, channel?.tag, channel?.channelTags, channel?.channeltags];
    const flattened: string[] = [];

    sourceValues.forEach(value => this.flattenTagValues(value, flattened));

    return Array.from(new Set(flattened.map(value => String(value || '').trim()).filter(Boolean)));
  }

  private flattenTagValues(value: any, accumulator: string[]): void {
    if (value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(entry => this.flattenTagValues(entry, accumulator));
      return;
    }

    if (typeof value === 'object') {
      [value.uuid, value.id, value.key, value.name, value.title, value.tag].forEach(entry => this.flattenTagValues(entry, accumulator));
      return;
    }

    const normalized = String(value || '').trim();
    if (!normalized) {
      return;
    }

    if (normalized.includes(',') || normalized.includes(';')) {
      normalized.split(/[;,]/).forEach(entry => this.flattenTagValues(entry, accumulator));
      return;
    }

    accumulator.push(normalized);
  }

  private resolveLocalTagNames(channel: any, tags: string[]): string[] {
    const existingNames = Array.isArray(channel?.__resolvedTagNames)
      ? channel.__resolvedTagNames.map((name: any) => String(name || '').trim()).filter(Boolean)
      : [];

    if (!this.favoriteTagUuid) {
      return existingNames;
    }

    const namesWithoutFavorite = existingNames.filter(name => name.toLowerCase() !== 'streaming favorites' && name.toLowerCase() !== 'favorites');
    if (tags.includes(this.favoriteTagUuid)) {
      namesWithoutFavorite.push('Streaming Favorites');
    }

    return Array.from(new Set(namesWithoutFavorite));
  }

  private persistFavoritesLocally(): void {
    localStorage.setItem(this.favoritesStorageKey, JSON.stringify([...this.favorites]));
  }

  hasRenderableChannelIcon(channel: any): boolean {
    const channelId = String(channel?.uuid || channel?.id || '').trim();
    return !!String(channel?.icon || '').trim() && !this.brokenChannelIcons.has(channelId);
  }

  handleChannelIconError(channel: any): void {
    const channelId = String(channel?.uuid || channel?.id || '').trim();
    if (!channelId) {
      return;
    }

    this.tvh.recordChannelIconLoadFailure(String(channel?.icon || '').trim());
    if (channel && typeof channel === 'object') {
      channel.icon = '';
    }
    this.brokenChannelIcons.add(channelId);
  }

  getResultCountSummary(): string {
    const total = this.channels.length;
    const visible = this.filteredChannels.length;
    if (this.favoritesOnly && this.searchQuery.trim()) {
      return `${visible} favorite result${visible === 1 ? '' : 's'}`;
    }
    if (this.favoritesOnly) {
      return `${visible} favorite channel${visible === 1 ? '' : 's'}`;
    }
    if (this.searchQuery.trim()) {
      return `${visible} of ${total} channels`;
    }
    return `${visible} channels`;
  }

  getCurrentProgram(channel: any): any {
    const nowSec = Date.now() / 1000;
    return this.epgEvents.find(e =>
      e.channelUuid === channel.uuid &&
      Number(e.start) <= nowSec &&
      Number(e.stop) >= nowSec
    ) ?? null;
  }

  getNextProgram(channel: any): any {
    const nowSec = Date.now() / 1000;
    return this.getChannelPrograms(channel).find(e => Number(e.start) > nowSec) ?? null;
  }

  getProgramProgressPercent(program: any): number {
    if (!program) {
      return 0;
    }

    const nowSec = Date.now() / 1000;
    const start = Number(program.start || 0);
    const stop = Number(program.stop || 0);
    if (!start || !stop || stop <= start) {
      return 0;
    }

    const progress = ((nowSec - start) / (stop - start)) * 100;
    return Math.max(0, Math.min(100, progress));
  }

  hasActiveFilters(): boolean {
    return this.favoritesOnly || !!this.searchQuery.trim();
  }

  getEmptyStateTitle(): string {
    return this.hasActiveFilters() ? 'No matching channels' : 'No channels found';
  }

  getEmptyStateMessage(): string {
    if (this.favoritesOnly && this.searchQuery.trim()) {
      return 'Try a different search or turn off Favorites only.';
    }
    if (this.favoritesOnly) {
      return 'Mark some channels as favorites to build a quicker watch list.';
    }
    if (this.searchQuery.trim()) {
      return 'Try a different channel name, number, tag, or current show.';
    }
    return 'TVHeadend did not return any channels.';
  }

  formatTimeRange(program: any): string {
    if (!program) { return ''; }
    const fmt = (t: number) =>
      new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${fmt(Number(program.start))} – ${fmt(Number(program.stop))}`;
  }

  private getChannelPrograms(channel: any): any[] {
    return this.epgEvents
      .filter(e => e.channelUuid === channel.uuid)
      .sort((left, right) => Number(left?.start || 0) - Number(right?.start || 0));
  }

  private handleDirectionalFocus(event: KeyboardEvent): boolean {
    if (this.loading || !!this.errorMessage || this.isEditableTarget(event.target as HTMLElement | null)) {
      return false;
    }

    if (this.isDirectionalKey(event, 'down')) {
      const activeElement = document.activeElement as HTMLElement | null;
      const channelCard = activeElement?.closest('.channel-card') as HTMLElement | null;
      if (channelCard && this.isLastChannelRow(channelCard)) {
        return this.focusDetailActionButton();
      }
    }

    if (this.isDirectionalKey(event, 'up')) {
      const activeElement = document.activeElement as HTMLElement | null;
      const actionArea = activeElement?.closest('.detail-strip__actions') as HTMLElement | null;
      if (actionArea) {
        return this.focusSelectedChannelCard();
      }
    }

    return false;
  }

  private isLastChannelRow(channelCard: HTMLElement): boolean {
    const cards = Array.from(document.querySelectorAll('.channel-grid .channel-card')) as HTMLElement[];
    if (!cards.length) {
      return false;
    }

    const lastRowTop = Math.max(...cards.map(card => Math.round(card.getBoundingClientRect().top)));
    const activeTop = Math.round(channelCard.getBoundingClientRect().top);
    return Math.abs(activeTop - lastRowTop) <= 8;
  }

  private focusDetailActionButton(): boolean {
    const target = document.querySelector('.detail-strip__actions .tv-btn') as HTMLElement | null;
    if (!target) {
      return false;
    }

    target.focus();
    return true;
  }

  private focusSelectedChannelCard(): boolean {
    const channelUuid = String(this.focusedChannel?.uuid || '').trim();
    if (!channelUuid) {
      return false;
    }

    const escapedUuid = channelUuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const target = document.querySelector(`.channel-card[data-channel-uuid="${escapedUuid}"]`) as HTMLElement | null;
    if (!target) {
      return false;
    }

    target.focus();
    return true;
  }

  private isEditableTarget(target: HTMLElement | null): boolean {
    if (!target) {
      return false;
    }

    return !!target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]');
  }

  private isSelectKey(event: KeyboardEvent): boolean {
    const key = String(event.key || '');
    const code = String((event as any).code || '');
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);
    const looksLikePrintableKeyboardInput = (key.length === 1 && key !== ' ')
      || code.startsWith('Key')
      || code.startsWith('Digit');

    return key === 'Enter'
      || key === 'BrowserSelect'
      || key === 'NumpadEnter'
      || key === 'Select'
      || key === 'OK'
      || key === ' '
      || key === 'Spacebar'
      || code === 'BrowserSelect'
      || code === 'Enter'
      || code === 'NumpadEnter'
      || code === 'Space'
      || keyCode === 13
      || keyCode === 23
      || keyCode === 32
        || (keyCode === 66 && !looksLikePrintableKeyboardInput)
      || keyCode === 160;
  }

  private isDirectionalKey(event: KeyboardEvent, direction: 'up' | 'down' | 'left' | 'right'): boolean {
    const key = String(event.key || '');
    const code = String((event as any).code || '');
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);

    if (direction === 'up') {
      return key === 'ArrowUp' || code === 'ArrowUp' || keyCode === 19 || keyCode === 38;
    }

    if (direction === 'down') {
      return key === 'ArrowDown' || code === 'ArrowDown' || keyCode === 20 || keyCode === 40;
    }

    if (direction === 'left') {
      return key === 'ArrowLeft' || code === 'ArrowLeft' || keyCode === 21 || keyCode === 37;
    }

    return key === 'ArrowRight' || code === 'ArrowRight' || keyCode === 22 || keyCode === 39;
  }

  private captureRemoteKey(event: KeyboardEvent): void {
    const key = String(event.key || '');
    const code = String((event as any).code || '');
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);
  }
}
