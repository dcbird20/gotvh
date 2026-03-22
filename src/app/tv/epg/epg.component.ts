import { CommonModule } from '@angular/common';
import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { ReturnNavigationContext, ReturnNavigationService } from '../../services/return-navigation.service';
import { GuideDataSnapshot, RecordingScheduleResult, TvheadendService } from '../../services/tvheadend.service';

interface HourTick {
  label: string;
  dateLabel: string;
  isDayBoundary: boolean;
}

interface DayBanner {
  label: string;
  offsetPx: number;
}

interface CategoryLegendItem {
  label: string;
  background: string;
}

interface PrimaryCategory {
  label: string;
  keywords: string[];
  background: string;
}


@Component({
  selector: 'app-epg',
  standalone: true,
  imports: [CommonModule, FormsModule, TvFocusableDirective],
  templateUrl: './epg.component.html',
  styleUrls: ['./epg.component.scss']
})
export class EpgComponent implements OnInit, OnDestroy, AfterViewInit {

  @ViewChild('timelineOuter') timelineOuter!: ElementRef<HTMLDivElement>;
  @ViewChild('watchLiveButton') watchLiveButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('nowButton') nowButton?: ElementRef<HTMLButtonElement>;

  readonly hourWidthPx = 150;
  readonly channelColWidthPx = 220;
  visibleHours = 3;
  filterQuery = '';
  showScheduledOnly = false;
  selectedCategories: string[] = [];
  useVerticalGuide = false;
  guideOptionsExpanded = false;

  readonly primaryCategories: PrimaryCategory[] = [
    {
      label: 'News',
      keywords: ['news', 'newscast', 'current affairs', 'journal'],
      background: 'linear-gradient(90deg, #2e66d2 60%, #1e3058 100%)'
    },
    {
      label: 'Sports',
      keywords: [
        'sport', 'sports', 'esport', 'e sport', 'motorsport', 'motor sport',
        'football', 'soccer', 'futbol', 'basketball', 'nba',
        'baseball', 'mlb', 'softball',
        'hockey', 'nhl',
        'rugby', 'cricket', 'golf', 'tennis', 'atp', 'wta',
        'boxing', 'mma', 'ufc', 'wrestling',
        'volleyball', 'handball', 'table tennis', 'ping pong',
        'cycling', 'bike race', 'tour',
        'racing', 'formula 1', 'f1', 'nascar', 'motogp',
        'athletics', 'track and field', 'olympic', 'swimming', 'ski', 'snowboard'
      ],
      background: 'linear-gradient(90deg, #1f9a53 60%, #165b34 100%)'
    },
    {
      label: 'Movie',
      keywords: ['movie', 'film', 'cinema', 'thriller'],
      background: 'linear-gradient(90deg, #9a4b22 60%, #5f2e14 100%)'
    },
    {
      label: 'Drama',
      keywords: ['drama', 'series', 'soap', 'telenovela', 'comedy', 'sitcom', 'humor'],
      background: 'linear-gradient(90deg, #7d3cae 60%, #4a2365 100%)'
    },
    {
      label: 'Docs',
      keywords: ['documentary', 'history', 'science', 'nature', 'education', 'culture'],
      background: 'linear-gradient(90deg, #22838f 60%, #17545d 100%)'
    },
    {
      label: 'Kids',
      keywords: ['kids', 'children', 'childrens', 'youth', 'cartoon', 'animation', 'family'],
      background: 'linear-gradient(90deg, #cc4f2f 60%, #7a311e 100%)'
    }
  ];

  readonly categoryLegend: CategoryLegendItem[] = this.primaryCategories.map(item => ({
    label: item.label,
    background: item.background,
  }));
  readonly categoryOptions = this.primaryCategories.map(item => item.label.toLowerCase());

  programs: any[] = [];
  channels: any[] = [];
  programsByChannel: { [channelId: string]: any[] } = {};
  filteredProgramsByChannel: { [channelId: string]: any[] } = {};
  filteredVerticalProgramsByChannel: { [channelId: string]: any[] } = {};
  filteredChannels: any[] = [];
  visibleProgramsByChannel: { [channelId: string]: any[] } = {};
  verticalProgramsByChannel: { [channelId: string]: any[] } = {};
  renderedChannels: any[] = [];
  selectedProgram: any | null = null;
  channelSpotlightId = '';
  channelSpotlightName = '';

  /** Maps XMLTV channel.id → TVHeadend channel UUID for player navigation. */
  private channelUuidMap = new Map<string, string>();

  /** Remembers which grid cell opened the program modal, so focus can be restored on close. */
  private lastFocusedGridElement: HTMLElement | null = null;

  recordingAction: 'schedule' | 'cancel' | null = null;
  autorecAction: 'create' | null = null;
  recordingStatusDetail: string | null = null;
  recordingMessage: string | null = null;
  recordingError: string | null = null;
  scheduledRecordingKeys = new Set<string>();

  loading = false;
  error: string | null = null;
  currentTime: Date = new Date();
  timelineStart: Date = new Date();
  timelineSpanMs = this.visibleHours * 60 * 60 * 1000;
  hourTicks: HourTick[] = [];
  dayBoundaryOffsetsPx: number[] = [];
  dayBanners: DayBanner[] = [];
  timelineWidthPx = 0;
  isNowInTimelineWindow = false;
  nowOffsetPx = 0;
  focusedChannelId = '';
  private timelineAnchorTimeMs: number | null = null;
  private preserveTimelineColumnAnchor = false;

  readonly rangeOptions = [3, 6, 12];
  readonly verticalChannelPageSize = 10;
  readonly timelineChannelPageSize = 8;
  channelWindowStart = 0;
  private pendingReturnContext: ReturnNavigationContext | null = null;
  private readonly rangeStorageKey = 'epg.visibleHours.v2';
  private readonly layoutStorageKey = 'epg.verticalGuide';
  private timeUpdateTimer: any;
  private shouldApplyInitialGuideFocus = true;

  constructor(
    private tvheadendService: TvheadendService,
    private router: Router,
    private route: ActivatedRoute,
    private returnNavigation: ReturnNavigationService
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────

  ngOnInit(): void {
    this.capturePendingReturnContext();
    this.restoreVisibleHoursPreference();
    this.clearLegacyChannelFilterPreference();
    this.restoreGuideLayoutPreference();
    this.timelineSpanMs = this.visibleHours * 60 * 60 * 1000;
    this.generateHourTicks();
    this.fetchEpgData();
    this.startCurrentTimeUpdater();
  }

  ngAfterViewInit(): void {
    this.scrollToCurrent();
  }

  ngOnDestroy(): void {
    clearInterval(this.timeUpdateTimer);
  }

  private startCurrentTimeUpdater(): void {
    this.timeUpdateTimer = setInterval(() => {
      this.currentTime = new Date();
      this.refreshTimelineMetrics();
    }, 60000);
  }

  // ── Data loading ─────────────────────────────────────────────

  fetchEpgData(): void {
    this.loading = true;
    this.error = null;

    const cachedSnapshot = this.tvheadendService.peekGuideDataSnapshot();
    if (cachedSnapshot) {
      this.applyGuideSnapshot(cachedSnapshot);
      this.refreshScheduledRecordings();
      this.finalizeGuideLoad(cachedSnapshot, true);

      this.tvheadendService.refreshGuideData().subscribe({
        next: (snapshot: GuideDataSnapshot) => {
          this.applyGuideSnapshot(snapshot);
          this.refreshScheduledRecordings();
          this.finalizeGuideLoad(snapshot, false);
        }
      });
      return;
    }

    this.tvheadendService.getGuideData().subscribe({
      next: (snapshot: GuideDataSnapshot) => {
        this.applyGuideSnapshot(snapshot);
        this.refreshScheduledRecordings();
        this.finalizeGuideLoad(snapshot, true);
      },
      error: (error: any) => {
        if (error?.status === 401 || error?.status === 403) {
          void this.requestAuth();
          return;
        }
        this.error = 'Error fetching EPG data: ' + (error?.message || error);
        this.loading = false;
      }
    });
  }

  private applyGuideSnapshot(snapshot: GuideDataSnapshot): void {
    this.channels = snapshot.channels || [];
    this.programs = snapshot.programs || [];
    this.programsByChannel = snapshot.programsByChannel || {};
    this.channelUuidMap = new Map(snapshot.channelUuidEntries || []);
    this.rebuildGuideViewModel();
  }

  private finalizeGuideLoad(snapshot: GuideDataSnapshot, applyInitialFocus: boolean): void {
    if (this.programs.length === 0 && (snapshot.xmltvError || snapshot.tvheadendEpgError)) {
      this.error = this.describeGuideDataError(snapshot.xmltvError, snapshot.tvheadendEpgError);
    } else {
      this.error = null;
    }

    this.updateTimelineStart();
    this.loading = false;

    if (!applyInitialFocus) {
      return;
    }

    setTimeout(() => {
      const restored = this.restoreReturnFocusIfNeeded();
      this.scrollToCurrent();
      this.scrollToFocusedChannel();
      if (!restored) {
        this.focusGuideEntryIfNeeded();
      }
    }, 0);
  }

  private describeGuideDataError(xmltvError: any, tvheadendEpgError: any): string {
    const errors = [xmltvError, tvheadendEpgError].filter(Boolean);
    const statuses = errors
      .map(error => Number(error?.status || 0))
      .filter(status => status > 0);

    if (statuses.some(status => status === 401)) {
      return 'Guide data requires authentication. Use TVH Login and reload the guide.';
    }

    if (statuses.some(status => status === 403)) {
      return 'The current TVHeadend account cannot read guide data.';
    }

    if (statuses.some(status => status === 404)) {
      return 'Guide data endpoints are unavailable on this TVHeadend setup.';
    }

    if (errors.some(error => Number(error?.status || 0) === 0)) {
      return 'Guide data could not be reached. Check backend and proxy settings.';
    }

    return 'Guide data could not be loaded from XMLTV or TVHeadend EPG sources.';
  }

  private async requestAuth(): Promise<void> {
    const hasAuth = await this.tvheadendService.ensureBasicAuth('Enter your TVHeadend credentials to load EPG.');
    if (hasAuth) {
      this.fetchEpgData();
      return;
    }
    this.error = 'Authentication required to load EPG.';
    this.loading = false;
  }

  private buildChannelUuidMap(tvhChannels: any[]): void {
    this.channelUuidMap.clear();
    const normName = (s: string) => String(s || '').trim().toLowerCase();

    // First pass: match by name
    for (const xmlCh of this.channels) {
      const xmlName = normName(xmlCh.name);
      const match = tvhChannels.find(
        (tvhCh: any) => normName(tvhCh.name) === xmlName
      ) || tvhChannels.find(
        (tvhCh: any) => {
          const tvhName = normName(tvhCh.name);
          return tvhName && (tvhName.includes(xmlName) || xmlName.includes(tvhName));
        }
      );
      if (match?.uuid) {
        this.channelUuidMap.set(xmlCh.id, String(match.uuid).trim());
      }
    }
  }

  private mapTvheadendEpgFallback(tvheadendEpg: any[], tvhChannels: any[]): void {
    const byUuid = new Map<string, any>();
    const byName = new Map<string, any>();

    (tvhChannels || []).forEach((ch: any) => {
      const uuid = String(ch?.uuid || '').trim();
      const name = String(ch?.name || '').trim();
      if (uuid) {
        byUuid.set(uuid, ch);
      }
      if (name) {
        byName.set(name.toLowerCase(), ch);
      }
    });

    const channelIndex = new Map<string, any>();
    this.channelUuidMap.clear();

    this.programs = (tvheadendEpg || []).map((entry: any) => {
      const channelUuid = String(entry?.channelUuid || '').trim();
      const channelName = String(entry?.channelName || entry?.channelname || '').trim();
      const channelFromGrid = (channelUuid && byUuid.get(channelUuid)) || byName.get(channelName.toLowerCase());
      const resolvedUuid = String(channelFromGrid?.uuid || channelUuid || '').trim();
      const resolvedName = String(channelFromGrid?.name || channelName || resolvedUuid || 'Unknown Channel').trim();
      const channelId = resolvedUuid || resolvedName;

      if (!channelIndex.has(channelId)) {
        channelIndex.set(channelId, {
          id: channelId,
          name: resolvedName,
          icon: '',
        });
      }

      if (resolvedUuid) {
        this.channelUuidMap.set(channelId, resolvedUuid);
      }

      const title = String(entry?.title || entry?.disp_title || 'Untitled').trim() || 'Untitled';
      const desc = String(entry?.summary || entry?.description || entry?.desc || '').trim();

      return {
        channel: channelId,
        startTime: this.parseEpgTime(entry?.start),
        endTime: this.parseEpgTime(entry?.stop),
        title,
        desc,
        category: this.mergeCategorySources(entry?.category || entry?.genre || '', desc),
        eventId: entry?.eventId != null ? Number(entry.eventId) : 0,
        dvrUuid: entry?.dvrUuid || '',
        dvrState: entry?.dvrState || '',
      };
    }).filter((program: any) => program.startTime > 0 && program.endTime > 0);

    this.channels = Array.from(channelIndex.values()).sort((a, b) => this.compareChannels(a, b));
    this.groupProgramsByChannel();
  }

  /** Resolve a player-navigable UUID for an XMLTV channel id. */
  getChannelUuid(xmltvChannelId: string): string {
    return this.channelUuidMap.get(xmltvChannelId) || '';
  }

  // ── Timeline ─────────────────────────────────────────────────

  updateTimelineStart(): void {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    this.timelineStart = now;
    this.timelineSpanMs = this.visibleHours * 60 * 60 * 1000;
    this.generateHourTicks();
    this.rebuildGuideViewModel();
  }

  private generateHourTicks(): void {
    this.hourTicks = [];
    this.dayBoundaryOffsetsPx = [];
    this.dayBanners = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStartMs = today.getTime();
    const totalHours = this.timelineSpanMs / (60 * 60 * 1000);

    for (let h = 0; h < totalHours; h++) {
      const tick = new Date(this.timelineStart.getTime() + h * 60 * 60 * 1000);
      const label = tick.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      const dateLabel = this.getBoundaryLabel(tick, todayStartMs);
      const isDayBoundary = h === 0 || tick.getHours() === 0;

      this.hourTicks.push({ label, dateLabel, isDayBoundary });

      if (isDayBoundary && h > 0) {
        this.dayBoundaryOffsetsPx.push(h * this.hourWidthPx);
      }
      if (isDayBoundary) {
        this.dayBanners.push({ label: dateLabel, offsetPx: h * this.hourWidthPx });
      }
    }

    this.refreshTimelineMetrics();
  }

  private getBoundaryLabel(tick: Date, todayStartMs: number): string {
    const dayStart = new Date(tick);
    dayStart.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dayStart.getTime() - todayStartMs) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) { return 'Today'; }
    if (diffDays === 1) { return 'Tomorrow'; }
    return tick.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  }

  getTimelineWidthPx(): number {
    return this.timelineWidthPx;
  }

  setVisibleHours(hours: number): void {
    if (!this.rangeOptions.includes(hours)) { return; }
    this.visibleHours = hours;
    this.saveVisibleHoursPreference(hours);
    this.updateTimelineStart();
    this.scrollToCurrent();
  }

  getTimelineWindowLabel(): string {
    const start = this.timelineStart;
    const end = new Date(start.getTime() + this.timelineSpanMs);
    const sameDay = start.toDateString() === end.toDateString();
    const startLabel = start.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const endLabel = end.toLocaleString([], sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    );
    return `${startLabel} - ${endLabel}`;
  }

  shiftTimelineWindow(direction: -1 | 1): void {
    const stepMs = this.getTimelineStepHours() * 60 * 60 * 1000;
    this.timelineStart = new Date(this.timelineStart.getTime() + (direction * stepMs));
    this.generateHourTicks();
    this.rebuildGuideViewModel();
    setTimeout(() => this.focusCurrentProgramInView(), 0);
  }

  jumpToNow(): void {
    this.updateTimelineStart();
    setTimeout(() => this.focusCurrentProgramInView(), 0);
  }

  isNowInWindow(): boolean {
    return this.isNowInTimelineWindow;
  }

  getNowOffsetPx(): number {
    return this.nowOffsetPx;
  }

  private refreshTimelineMetrics(): void {
    this.timelineWidthPx = (this.timelineSpanMs / (60 * 60 * 1000)) * this.hourWidthPx;
    const now = this.currentTime.getTime();
    const windowStart = this.timelineStart.getTime();
    const windowEnd = windowStart + this.timelineSpanMs;
    this.isNowInTimelineWindow = now >= windowStart && now <= windowEnd;

    const elapsedMs = now - windowStart;
    const elapsedHours = elapsedMs / (60 * 60 * 1000);
    this.nowOffsetPx = Math.max(0, Math.min(this.timelineWidthPx, elapsedHours * this.hourWidthPx));
  }

  private scrollToCurrent(): void {
    if (!this.timelineOuter?.nativeElement) { return; }
    this.timelineOuter.nativeElement.scrollTo({ left: 0, behavior: 'auto' });
  }

  private scrollToFocusedChannel(): void {
    if (!this.focusedChannelId || !this.timelineOuter?.nativeElement) { return; }
    const container = this.timelineOuter.nativeElement;
    const escaped = this.escapeForAttributeSelector(this.focusedChannelId);
    const row = container.querySelector(`.epg-focus-row[data-channel-id="${escaped}"]`) as HTMLElement | null;
    if (!row) { return; }
    const header = container.querySelector('.epg-timeline-header') as HTMLElement | null;
    const stickyHeaderHeight = header?.offsetHeight || 0;
    const safetyGap = 10;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const visibleTop = containerRect.top + stickyHeaderHeight + safetyGap;
    const visibleBottom = containerRect.bottom - safetyGap;

    let nextTop = container.scrollTop;
    if (rowRect.top < visibleTop) {
      nextTop -= visibleTop - rowRect.top;
    } else if (rowRect.bottom > visibleBottom) {
      nextTop += rowRect.bottom - visibleBottom;
    }

    const clampedTop = Math.max(0, Math.min(nextTop, container.scrollHeight - container.clientHeight));
    if (Math.abs(clampedTop - container.scrollTop) < 1) {
      return;
    }

    container.scrollTo({ top: clampedTop, left: 0, behavior: 'auto' });
  }

  currentChannelPageSize(): number {
    return this.useVerticalGuide ? this.verticalChannelPageSize : this.timelineChannelPageSize;
  }

  hasPreviousChannelPage(): boolean {
    return this.channelWindowStart > 0;
  }

  hasNextChannelPage(): boolean {
    return this.channelWindowStart + this.currentChannelPageSize() < this.filteredChannels.length;
  }

  getChannelWindowLabel(): string {
    if (this.filteredChannels.length === 0) {
      return '0 channels';
    }
    const start = this.channelWindowStart + 1;
    const end = Math.min(this.filteredChannels.length, this.channelWindowStart + this.currentChannelPageSize());
    return `${start}-${end} of ${this.filteredChannels.length}`;
  }

  shiftChannelWindow(direction: -1 | 1): void {
    const pageSize = this.currentChannelPageSize();
    const maxStart = Math.max(0, this.filteredChannels.length - pageSize);
    const nextStart = Math.max(0, Math.min(maxStart, this.channelWindowStart + direction * pageSize));
    if (nextStart === this.channelWindowStart) {
      return;
    }
    this.rebuildRenderedChannels(nextStart);
    setTimeout(() => this.focusFirstRenderedChannel(), 0);
  }

  private focusFirstRenderedChannel(): void {
    const channelId = String(this.renderedChannels[0]?.id || '').trim();
    if (!channelId) {
      return;
    }

    this.focusChannelButtonForChannel(channelId);
  }

  private focusCurrentProgramInView(): void {
    if (this.focusedChannelId && this.focusChannelButtonForChannel(this.focusedChannelId)) {
      return;
    }

    const currentProgram = this.findCurrentProgramChannelId();
    if (currentProgram && this.focusChannelButtonForChannel(currentProgram)) {
      return;
    }

    this.focusFirstRenderedChannel();
  }

  private findCurrentProgramChannelId(): string {
    const container = this.timelineOuter?.nativeElement;
    if (!container) {
      return '';
    }

    const currentProgram = container.querySelector('.epg-program-bar.current, .epg-vertical-program-item.current') as HTMLElement | null;
    return String(currentProgram?.getAttribute('data-channel-id') || '').trim();
  }

  private focusElement(target: HTMLElement | null | undefined, preventScroll = true): boolean {
    if (!target) {
      return false;
    }

    if (document.activeElement === target) {
      return true;
    }

    try {
      target.focus({ preventScroll });
    } catch {
      target.focus();
    }

    return true;
  }

  private focusGuideHeaderControls(): void {
    this.focusElement(this.nowButton?.nativeElement);
  }

  private capturePendingReturnContext(): void {
    const token = String(this.route.snapshot.queryParamMap.get('returnToken') || '').trim();
    if (!token) {
      return;
    }

    const context = this.returnNavigation.consumeToken(token);
    if (context?.source === 'epg') {
      this.pendingReturnContext = context;
    }

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { returnToken: null },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  private restoreReturnFocusIfNeeded(): boolean {
    const context = this.pendingReturnContext;
    if (!context) {
      return false;
    }

    this.pendingReturnContext = null;
    this.shouldApplyInitialGuideFocus = false;
    const channelId = String(context.payload['channelId'] || '').trim();
    const start = String(context.payload['startTime'] || '').trim();
    const end = String(context.payload['endTime'] || '').trim();

    if (channelId) {
      this.focusedChannelId = channelId;
      this.ensureFocusedChannelVisible();
    }

    setTimeout(() => {
      const container = this.timelineOuter?.nativeElement;
      if (!container) {
        return;
      }

      const escapedChannelId = this.escapeForAttributeSelector(channelId);
      let target: HTMLElement | null = null;

      if (channelId && start && end) {
        target = container.querySelector(
          `.epg-program-bar[data-channel-id="${escapedChannelId}"][data-program-start="${start}"][data-program-end="${end}"], .epg-vertical-program-item[data-channel-id="${escapedChannelId}"][data-program-start="${start}"][data-program-end="${end}"]`
        ) as HTMLElement | null;
      }

      if (!target && channelId) {
        target = this.queryChannelButton(container, channelId);
      }

      this.focusElement(target);
      this.scrollToFocusedChannel();
    }, 0);
    return true;
  }

  private focusGuideEntryIfNeeded(): void {
    if (!this.shouldApplyInitialGuideFocus || this.loading || this.error || this.filteredChannels.length === 0) {
      return;
    }

    this.shouldApplyInitialGuideFocus = false;
    if (this.timelineOuter?.nativeElement) {
      this.timelineOuter.nativeElement.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
    this.focusFirstRenderedChannel();
  }

  private getTimelineStepHours(): number {
    return Math.max(1, Math.floor(this.visibleHours / 2));
  }

  private ensureFocusedChannelVisible(): void {
    this.rebuildRenderedChannels();
  }

  private rebuildRenderedChannels(preferredStart?: number): void {
    const pageSize = this.currentChannelPageSize();
    const maxStart = Math.max(0, this.filteredChannels.length - pageSize);
    let nextStart = typeof preferredStart === 'number' ? preferredStart : this.channelWindowStart;

    if (typeof preferredStart !== 'number' && this.focusedChannelId) {
      const focusedIndex = this.filteredChannels.findIndex(channel => String(channel?.id || '').trim() === this.focusedChannelId);
      if (focusedIndex >= 0) {
        nextStart = Math.floor(focusedIndex / pageSize) * pageSize;
      }
    }

    this.channelWindowStart = Math.max(0, Math.min(maxStart, nextStart));
    this.renderedChannels = this.filteredChannels.slice(this.channelWindowStart, this.channelWindowStart + pageSize);
    this.rebuildRenderedProgramMaps();
  }

  private rebuildRenderedProgramMaps(): void {
    const nextVisibleProgramsByChannel: { [channelId: string]: any[] } = {};
    const nextVerticalProgramsByChannel: { [channelId: string]: any[] } = {};

    for (const channel of this.renderedChannels) {
      const channelId = String(channel?.id || '').trim();
      if (!channelId) {
        continue;
      }

      const visiblePrograms = this.filteredProgramsByChannel[channelId] || [];
      const verticalPrograms = this.filteredVerticalProgramsByChannel[channelId] || visiblePrograms;

      nextVisibleProgramsByChannel[channelId] = visiblePrograms.map(program => this.decorateProgramForGuide(program));
      nextVerticalProgramsByChannel[channelId] = verticalPrograms.map(program => this.decorateProgramForGuide(program));
    }

    this.visibleProgramsByChannel = nextVisibleProgramsByChannel;
    this.verticalProgramsByChannel = nextVerticalProgramsByChannel;
  }

  private escapeForAttributeSelector(value: string): string {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // ── Program positioning ───────────────────────────────────────

  getProgramLeftPx(program: any): number {
    if (typeof program?.__leftPx === 'number') {
      return program.__leftPx;
    }

    const start = this.parseEpgTime(program.startTime);
    const windowStart = this.timelineStart.getTime();
    const windowEnd = windowStart + this.timelineSpanMs;

    if (start >= windowEnd) {
      return (this.timelineSpanMs / (60 * 60 * 1000)) * this.hourWidthPx;
    }
    if (start <= windowStart) {
      return 0;
    }

    const visibleStart = Math.max(start, windowStart);
    const visibleHoursFromStart = (visibleStart - windowStart) / (60 * 60 * 1000);
    const maxLeft = (this.timelineSpanMs / (60 * 60 * 1000)) * this.hourWidthPx;
    return Math.max(0, Math.min(maxLeft, visibleHoursFromStart * this.hourWidthPx));
  }

  getProgramWidthPx(program: any): number {
    if (typeof program?.__widthPx === 'number') {
      return program.__widthPx;
    }

    const start = this.parseEpgTime(program.startTime);
    const end = this.parseEpgTime(program.endTime);
    const windowStart = this.timelineStart.getTime();
    const windowEnd = windowStart + this.timelineSpanMs;

    const visibleStart = Math.max(start, windowStart);
    const visibleEnd = Math.min(end, windowEnd);
    if (visibleEnd <= visibleStart) { return 0; }
    const visibleHours = (visibleEnd - visibleStart) / (60 * 60 * 1000);
    return Math.max(8, visibleHours * this.hourWidthPx);
  }

  isProgramVisible(program: any): boolean {
    if (typeof program?.__isVisible === 'boolean') {
      return program.__isVisible;
    }

    const start = this.parseEpgTime(program.startTime);
    const end = this.parseEpgTime(program.endTime);
    const windowStart = this.timelineStart.getTime();
    const windowEnd = windowStart + this.timelineSpanMs;
    return end > windowStart && start < windowEnd;
  }

  isCurrent(program: any): boolean {
    const startMs = typeof program?.__startMs === 'number' ? program.__startMs : this.parseEpgTime(program?.startTime);
    const endMs = typeof program?.__endMs === 'number' ? program.__endMs : this.parseEpgTime(program?.endTime);
    if (!startMs || !endMs) { return false; }
    const now = this.currentTime.getTime();
    return now >= startMs && now < endMs;
  }

  getProgramTooltip(program: any): string {
    if (typeof program?.__tooltip === 'string') {
      return program.__tooltip;
    }

    const start = new Date(this.parseEpgTime(program.startTime));
    const end = new Date(this.parseEpgTime(program.endTime));
    const startLabel = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const endLabel = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const desc = (program.desc || '').trim();
    return desc
      ? `${program.title}\n${startLabel} - ${endLabel}\n${desc}`
      : `${program.title}\n${startLabel} - ${endLabel}`;
  }

  // ── Filtering ─────────────────────────────────────────────────

  getFilteredChannels(): any[] {
    return this.filteredChannels;
  }

  getProgramsForChannel(channelId: string): any[] {
    return this.visibleProgramsByChannel[channelId] || [];
  }

  getProgramsForChannelVertical(channelId: string): any[] {
    return this.verticalProgramsByChannel[channelId] || [];
  }

  onFilterQueryChange(): void {
    this.focusedChannelId = '';
    this.channelWindowStart = 0;
    this.rebuildGuideViewModel();
  }

  isFocusedChannel(channelId: string): boolean {
    return !!this.focusedChannelId && String(channelId || '').trim() === this.focusedChannelId;
  }

  toggleScheduledOnly(): void {
    this.showScheduledOnly = !this.showScheduledOnly;
    this.rebuildGuideViewModel();
  }

  toggleGuideOrientation(): void {
    this.useVerticalGuide = !this.useVerticalGuide;
    this.persistGuideLayoutPreference(this.useVerticalGuide);
    this.ensureFocusedChannelVisible();
    setTimeout(() => {
      this.scrollToFocusedChannel();
      this.focusCurrentProgramInView();
    }, 0);
  }

  openChannelVerticalView(channel: any): void {
    const channelId = String(channel?.id || '').trim();
    if (!channelId) { return; }
    this.useVerticalGuide = true;
    this.persistGuideLayoutPreference(true);
    this.focusedChannelId = channelId;
    this.channelSpotlightId = channelId;
    this.channelSpotlightName = String(channel?.name || channelId).trim();
    this.rebuildGuideViewModel();
    setTimeout(() => {
      this.scrollToFocusedChannel();
      this.focusCurrentProgramInView();
    }, 0);
  }

  clearChannelSpotlight(): void {
    this.channelSpotlightId = '';
    this.channelSpotlightName = '';
    this.rebuildGuideViewModel();
    setTimeout(() => this.focusCurrentProgramInView(), 0);
  }

  clearTransientFilters(): void {
    this.filterQuery = '';
    this.selectedCategories = [];
    this.showScheduledOnly = false;
    this.channelSpotlightId = '';
    this.channelSpotlightName = '';
    this.focusedChannelId = '';
    this.channelWindowStart = 0;
    this.rebuildGuideViewModel();
    setTimeout(() => this.focusCurrentProgramInView(), 0);
  }

  enterChannelRow(channelId: string): void {
    const normalized = String(channelId || '').trim();
    if (!normalized) {
      return;
    }

    this.handleChannelFocus(normalized);
    setTimeout(() => {
      this.focusFirstProgramForChannel(normalized);
    }, 0);
  }

  toggleGuideOptions(): void {
    this.guideOptionsExpanded = !this.guideOptionsExpanded;
  }

  handleChannelFocus(channelId: string): void {
    const normalized = String(channelId || '').trim();
    if (!normalized) {
      return;
    }
    this.focusedChannelId = normalized;
    this.ensureFocusedChannelVisible();
    setTimeout(() => this.scrollToFocusedChannel(), 0);
  }

  handleProgramFocus(program: any): void {
    const channelId = String(program?.channel || '').trim();
    if (!channelId) {
      return;
    }
    const activeElement = document.activeElement as HTMLElement | null;
    if (!this.preserveTimelineColumnAnchor) {
      this.updateTimelineAnchor(activeElement);
    }
    this.preserveTimelineColumnAnchor = false;
    this.focusedChannelId = channelId;
  }

  private updateTimelineAnchor(element: HTMLElement | null): void {
    const programCell = element?.closest('.epg-program-bar, .epg-vertical-program-item') as HTMLElement | null;
    if (!programCell) {
      return;
    }

    const timeRange = this.getProgramTimeRange(programCell);
    if (!timeRange) {
      return;
    }

    const duration = Math.max(1, timeRange.end - timeRange.start);
    this.timelineAnchorTimeMs = timeRange.start + duration * 0.33;
  }

  private getProgramTimeRange(element: HTMLElement | null): { start: number; end: number } | null {
    const programCell = element?.closest('.epg-program-bar, .epg-vertical-program-item') as HTMLElement | null;
    const start = Number(programCell?.getAttribute('data-program-start') || NaN);
    const end = Number(programCell?.getAttribute('data-program-end') || NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    return { start, end };
  }

  private hasActiveCategoryFilter(): boolean {
    return this.selectedCategories.length > 0;
  }

  private matchesSelectedCategory(program: any): boolean {
    if (!this.hasActiveCategoryFilter()) { return true; }
    const matched = this.getMatchedPrimaryCategory(program);
    return this.selectedCategories.includes(matched);
  }

  toggleCategory(category: string): void {
    const key = String(category || '').toLowerCase();
    if (!key) { return; }
    if (this.selectedCategories.includes(key)) {
      this.selectedCategories = this.selectedCategories.filter(item => item !== key);
    } else {
      this.selectedCategories = [...this.selectedCategories, key];
    }
    this.rebuildGuideViewModel();
  }

  clearCategoryFilters(): void {
    this.selectedCategories = [];
    this.rebuildGuideViewModel();
  }

  hasActiveGuideFilters(): boolean {
    return !!this.filterQuery.trim()
      || this.showScheduledOnly
      || this.selectedCategories.length > 0
      || !!this.channelSpotlightId;
  }

  getActiveFilterLabels(): string[] {
    const labels: string[] = [];
    const query = this.filterQuery.trim();

    if (query) {
      labels.push(`Search: ${query}`);
    }

    if (this.showScheduledOnly) {
      labels.push('Scheduled only');
    }

    if (this.channelSpotlightId) {
      labels.push(`Channel: ${this.channelSpotlightName || this.getChannelName(this.channelSpotlightId)}`);
    }

    for (const category of this.selectedCategories) {
      labels.push(`Category: ${this.toTitleCase(category)}`);
    }

    return labels;
  }

  hasChannelDataWithoutPrograms(): boolean {
    return this.channels.length > 0 && this.programs.length === 0;
  }

  getGuideSummaryLabel(): string {
    const channelCount = this.filteredChannels.length;
    const programCount = this.filteredChannels.reduce((count, channel) => {
      const channelId = String(channel?.id || '').trim();
      return count + (this.filteredProgramsByChannel[channelId] || []).length;
    }, 0);
    return `${channelCount} channels • ${programCount} items`;
  }

  resetGuideFilters(): void {
    this.clearTransientFilters();
  }

  isCategorySelected(category: string): boolean {
    return this.selectedCategories.includes(String(category || '').toLowerCase());
  }

  private toTitleCase(value: string): string {
    return String(value || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  // ── Program colours ───────────────────────────────────────────

  getProgramBackground(program: any): string {
    if (typeof program?.__background === 'string') {
      return program.__background;
    }

    return this.resolveProgramBackground(program);
  }

  private resolveProgramBackground(program: any): string {
    const matched = this.getMatchedPrimaryCategory(program);
    const category = this.primaryCategories.find(item => item.label.toLowerCase() === matched);
    if (category) { return category.background; }
    return 'linear-gradient(90deg, #3576ff 60%, #1e2e4d 100%)';
  }

  getProgramCategoryBadgeStyle(program: any): { [key: string]: string } {
    return { background: this.getProgramBackground(program), color: '#ffffff' };
  }

  private getMatchedPrimaryCategory(program: any): string {
    const categoryText = this.normalizeCategory(this.getProgramCategoryText(program));
    const categoryTokens = this.getCategoryTokens(program?.category);
    const rawCategoryJson = this.normalizeCategory(this.safeJsonString(program?.category));
    const categorySearchText = `${categoryText} ${rawCategoryJson}`.trim();

    for (const item of this.primaryCategories) {
      if (
        categoryTokens.some(token => this.containsAny(token, item.keywords))
        || this.containsAny(categorySearchText, item.keywords)
      ) {
        return item.label.toLowerCase();
      }
    }
    return 'other';
  }

  private getProgramCategoryText(program: any): string {
    return this.flattenToText(program?.category);
  }

  // ── Channel helpers ───────────────────────────────────────────

  getChannelName(channelId: string): string {
    const channel = this.channels.find(ch => ch.id === channelId);
    return channel?.name || channelId || 'Unknown Channel';
  }

  // ── Program details modal ─────────────────────────────────────

  openProgramDetails(program: any): void {
    this.lastFocusedGridElement = document.activeElement as HTMLElement | null;
    this.selectedProgram = program;
    this.resetRecordingState();
    setTimeout(() => {
      this.focusElement(this.watchLiveButton?.nativeElement);
    }, 0);
  }

  closeProgramDetails(skipFocusRestore = false): void {
    this.selectedProgram = null;
    this.resetRecordingState();
    if (skipFocusRestore) {
      this.lastFocusedGridElement = null;
      return;
    }
    const restoreTarget = this.lastFocusedGridElement;
    this.lastFocusedGridElement = null;
    setTimeout(() => {
      this.focusElement(restoreTarget);
    }, 0);
  }

  @HostListener('document:keydown.escape')
  handleEscapeKey(): void {
    if (this.selectedProgram) { this.closeProgramDetails(); }
  }

  @HostListener('document:keydown.pageup', ['$event'])
  handlePageUp(event: KeyboardEvent): void {
    const target = this.getGuideKeyTarget(event);
    if (this.selectedProgram || this.shouldIgnoreGlobalGuideKeys(target)) {
      return;
    }
    event.preventDefault();
    this.moveGuideFocusByPage(target, -1);
  }

  @HostListener('document:keydown.pagedown', ['$event'])
  handlePageDown(event: KeyboardEvent): void {
    const target = this.getGuideKeyTarget(event);
    if (this.selectedProgram || this.shouldIgnoreGlobalGuideKeys(target)) {
      return;
    }
    event.preventDefault();
    this.moveGuideFocusByPage(target, 1);
  }

  @HostListener('document:keydown', ['$event'])
  handleChannelPageKeys(event: KeyboardEvent): void {
    const direction = this.getChannelPageDirection(event);
    if (!direction) {
      return;
    }

    const target = this.getGuideKeyTarget(event);
    if (this.selectedProgram || this.shouldIgnoreGlobalGuideKeys(target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.moveGuideFocusByPage(target, direction);
  }

  @HostListener('document:keydown.home', ['$event'])
  handleHome(event: KeyboardEvent): void {
    const target = this.getGuideKeyTarget(event);
    if (this.selectedProgram || this.shouldIgnoreGlobalGuideKeys(target)) {
      return;
    }
    event.preventDefault();
    this.jumpToNow();
  }

  @HostListener('document:keydown.arrowup', ['$event'])
  handleArrowUp(event: KeyboardEvent): void {
    const target = this.getGuideKeyTarget(event);
    if (this.selectedProgram || this.shouldIgnoreGlobalGuideKeys(target)) {
      return;
    }

    if (this.moveGuideFocusByRow(target, -1)) {
      event.preventDefault();
      return;
    }

    if (!this.isGuideGridTarget(target)) {
      return;
    }

    event.preventDefault();
    this.focusGuideHeaderControls();
  }

  @HostListener('document:keydown.arrowdown', ['$event'])
  handleArrowDown(event: KeyboardEvent): void {
    const target = this.getGuideKeyTarget(event);
    if (this.selectedProgram || this.shouldIgnoreGlobalGuideKeys(target)) {
      return;
    }

    if (this.moveGuideFocusByRow(target, 1)) {
      event.preventDefault();
      return;
    }

    if (!this.isGuideHeaderTarget(target)) {
      return;
    }

    event.preventDefault();
    this.focusCurrentProgramInView();
  }

  @HostListener('document:keydown.arrowleft', ['$event'])
  handleArrowLeft(event: KeyboardEvent): void {
    const target = this.getGuideKeyTarget(event);
    if (!this.selectedProgram) {
      if (this.focusAdjacentProgramForTarget(target, -1)) {
        event.preventDefault();
        return;
      }

      if (this.focusChannelButtonForProgramTarget(target)) {
        event.preventDefault();
        return;
      }
    }

    if (!this.shouldHandleProgramArrowNavigation(event) || !this.hasPreviousProgram()) { return; }
    event.preventDefault();
    this.showPreviousProgram();
  }

  @HostListener('document:keydown.arrowright', ['$event'])
  handleArrowRight(event: KeyboardEvent): void {
    const target = this.getGuideKeyTarget(event);
    if (!this.selectedProgram) {
      if (this.focusAdjacentProgramForTarget(target, 1)) {
        event.preventDefault();
        return;
      }

      if (this.focusProgramForChannelTarget(target)) {
        event.preventDefault();
        return;
      }
    }

    if (!this.shouldHandleProgramArrowNavigation(event) || !this.hasNextProgram()) { return; }
    event.preventDefault();
    this.showNextProgram();
  }

  private shouldHandleProgramArrowNavigation(event: KeyboardEvent): boolean {
    if (!this.selectedProgram) {
      return false;
    }

    const target = this.getGuideKeyTarget(event);
    if (!target) {
      return true;
    }

    // When modal controls are focused, let spatial-nav move focus between buttons.
    const interactive = target.closest('button, input, textarea, select, [contenteditable="true"]');
    if (interactive) {
      return false;
    }

    return true;
  }

  private shouldIgnoreGlobalGuideKeys(target: HTMLElement | null): boolean {
    if (!target) {
      return false;
    }

    return !!target.closest('input, textarea, select, [contenteditable="true"]');
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

  private getGuideKeyTarget(event: KeyboardEvent): HTMLElement | null {
    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement && activeElement !== document.body) {
      return activeElement;
    }

    return event.target as HTMLElement | null;
  }

  private isGuideGridTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) {
      return false;
    }

    return !!element.closest('.epg-program-bar, .epg-vertical-program-item, .epg-channel-col-clickable, .epg-vertical-channel-header-btn');
  }

  private isGuideHeaderTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) {
      return false;
    }

    return !!element.closest('.epg-header-controls-scroll, .epg-filter');
  }

  private focusProgramForChannelTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    const channelButton = element?.closest('.epg-channel-col-clickable, .epg-vertical-channel-header-btn') as HTMLElement | null;
    if (!channelButton) {
      return false;
    }

    const channelId = String(channelButton.getAttribute('data-channel-button-id') || channelButton.getAttribute('data-channel-id') || '').trim();
    if (!channelId) {
      return false;
    }

    return this.focusFirstProgramForChannel(channelId);
  }

  private moveGuideFocusByPage(target: EventTarget | null, direction: -1 | 1): boolean {
    const sourceElement = this.resolveGuidePageSourceElement(target);
    const sourceChannelId = sourceElement
      ? this.resolveGuideChannelIdFromTarget(sourceElement)
      : String(this.focusedChannelId || '').trim();

    const currentIndex = this.filteredChannels.findIndex(channel => String(channel?.id || '').trim() === sourceChannelId);
    const fallbackIndex = direction > 0 ? 0 : Math.max(0, this.filteredChannels.length - 1);
    const baseIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
    const pageSize = Math.max(1, this.currentChannelPageSize());
    const nextIndex = Math.max(0, Math.min(this.filteredChannels.length - 1, baseIndex + (direction * pageSize)));
    const nextChannelId = String(this.filteredChannels[nextIndex]?.id || '').trim();
    if (!nextChannelId) {
      return false;
    }

    const currentWindowContainsNextChannel = this.renderedChannels.some(channel => String(channel?.id || '').trim() === nextChannelId);
    if (!currentWindowContainsNextChannel && !this.showRenderedWindowForChannel(nextChannelId)) {
      return false;
    }

    if (!sourceElement) {
      return this.focusGuideTargetAfterRender(() => this.focusChannelButtonForChannel(nextChannelId));
    }

    if (this.useVerticalGuide) {
      return this.focusGuideTargetAfterRender(() => this.focusVerticalGuideRowTarget(sourceElement, sourceChannelId, nextChannelId));
    }

    return this.focusGuideTargetAfterRender(() => this.focusTimelineRowTarget(sourceElement, nextChannelId));
  }

  private resolveGuidePageSourceElement(target: EventTarget | null): HTMLElement | null {
    const element = target as HTMLElement | null;
    if (element && this.isGuideGridTarget(element)) {
      return element;
    }

    const focusedChannelId = String(this.focusedChannelId || '').trim();
    if (!focusedChannelId) {
      return null;
    }

    const container = this.timelineOuter?.nativeElement || document;
    const escapedChannelId = this.escapeForAttributeSelector(focusedChannelId);
    return (container.querySelector(
      `.epg-program-bar[data-channel-id="${escapedChannelId}"], .epg-vertical-program-item[data-channel-id="${escapedChannelId}"], .epg-channel-col-clickable[data-channel-button-id="${escapedChannelId}"], .epg-vertical-channel-header-btn[data-channel-button-id="${escapedChannelId}"]`
    ) as HTMLElement | null);
  }

  private focusChannelButtonForProgramTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    const programCell = element?.closest('.epg-program-bar, .epg-vertical-program-item') as HTMLElement | null;
    if (!programCell) {
      return false;
    }

    const channelId = String(programCell.getAttribute('data-channel-id') || '').trim();
    if (!channelId) {
      return false;
    }

    const container = this.timelineOuter?.nativeElement || document;
    const channelButton = this.queryChannelButton(container, channelId);
    if (!channelButton) {
      return false;
    }

    return this.focusElement(channelButton);
  }

  private focusAdjacentProgramForTarget(target: EventTarget | null, direction: -1 | 1): boolean {
    const element = target as HTMLElement | null;
    const programCell = element?.closest('.epg-program-bar, .epg-vertical-program-item') as HTMLElement | null;
    if (!programCell) {
      return false;
    }

    const channelId = String(programCell.getAttribute('data-channel-id') || '').trim();
    if (!channelId) {
      return false;
    }

    const container = this.timelineOuter?.nativeElement || document;
    const escapedChannelId = this.escapeForAttributeSelector(channelId);
    const selector = this.useVerticalGuide
      ? `.epg-vertical-program-item[data-channel-id="${escapedChannelId}"]`
      : `.epg-program-bar[data-channel-id="${escapedChannelId}"]`;
    const items = Array.from(container.querySelectorAll(selector)) as HTMLElement[];
    const currentIndex = items.indexOf(programCell);
    if (currentIndex < 0) {
      return false;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= items.length) {
      return false;
    }

    return this.focusElement(items[nextIndex]);
  }

  private focusFirstProgramForChannel(channelId: string): boolean {
    const container = this.timelineOuter?.nativeElement || document;
    const escapedChannelId = this.escapeForAttributeSelector(channelId);
    const selector = this.useVerticalGuide
      ? `.epg-vertical-program-item[data-channel-id="${escapedChannelId}"]`
      : `.epg-program-bar[data-channel-id="${escapedChannelId}"]`;
    const target = container.querySelector(selector) as HTMLElement | null;
    if (!target) {
      return false;
    }

    return this.focusElement(target);
  }

  private focusChannelButtonForChannel(channelId: string): boolean {
    const container = this.timelineOuter?.nativeElement || document;
    const target = this.queryChannelButton(container, channelId);
    if (!target) {
      return false;
    }

    return this.focusElement(target);
  }

  private queryChannelButton(container: ParentNode, channelId: string): HTMLElement | null {
    const escapedChannelId = this.escapeForAttributeSelector(channelId);
    return container.querySelector(
      `.epg-channel-col-clickable[data-channel-button-id="${escapedChannelId}"], .epg-vertical-channel-header-btn[data-channel-button-id="${escapedChannelId}"]`
    ) as HTMLElement | null;
  }

  private moveGuideFocusByRow(target: EventTarget | null, direction: -1 | 1): boolean {
    const element = target as HTMLElement | null;
    if (!element) {
      return false;
    }

    const channelId = this.resolveGuideChannelIdFromTarget(element);
    if (!channelId) {
      return false;
    }

    const currentIndex = this.renderedChannels.findIndex(channel => String(channel?.id || '').trim() === channelId);
    if (currentIndex < 0) {
      return false;
    }

    const globalIndex = this.filteredChannels.findIndex(channel => String(channel?.id || '').trim() === channelId);
    if (globalIndex < 0) {
      return false;
    }

    const globalNextIndex = globalIndex + direction;
    if (globalNextIndex < 0 || globalNextIndex >= this.filteredChannels.length) {
      return false;
    }

    const nextChannelId = String(this.filteredChannels[globalNextIndex]?.id || '').trim();
    if (!nextChannelId) {
      return false;
    }

    const nextIsRendered = this.renderedChannels.some(channel => String(channel?.id || '').trim() === nextChannelId);
    if (!nextIsRendered) {
      if (!this.showRenderedWindowForChannel(nextChannelId)) {
        return false;
      }

      if (this.useVerticalGuide) {
        return this.focusGuideTargetAfterRender(() => this.focusVerticalGuideRowTarget(element, channelId, nextChannelId));
      }

      return this.focusGuideTargetAfterRender(() => this.focusTimelineRowTarget(element, nextChannelId));
    }

    if (this.useVerticalGuide) {
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= this.renderedChannels.length) {
        return false;
      }

      const nextChannelId = String(this.renderedChannels[nextIndex]?.id || '').trim();
      if (!nextChannelId) {
        return false;
      }

      return this.focusVerticalGuideRowTarget(element, channelId, nextChannelId);
    }

    for (let nextIndex = currentIndex + direction; nextIndex >= 0 && nextIndex < this.renderedChannels.length; nextIndex += direction) {
      const nextChannelId = String(this.renderedChannels[nextIndex]?.id || '').trim();
      if (!nextChannelId) {
        continue;
      }

      if (this.focusTimelineRowTarget(element, nextChannelId)) {
        return true;
      }
    }

    return false;
  }

  private resolveGuideChannelIdFromTarget(element: HTMLElement): string {
    const programCell = element.closest('.epg-program-bar, .epg-vertical-program-item') as HTMLElement | null;
    if (programCell) {
      return String(programCell.getAttribute('data-channel-id') || '').trim();
    }

    const channelButton = element.closest('.epg-channel-col-clickable, .epg-vertical-channel-header-btn') as HTMLElement | null;
    if (channelButton) {
      return String(channelButton.getAttribute('data-channel-button-id') || channelButton.getAttribute('data-channel-id') || '').trim();
    }

    const row = element.closest('.epg-focus-row') as HTMLElement | null;
    return String(row?.getAttribute('data-channel-id') || '').trim();
  }

  private focusTimelineRowTarget(currentElement: HTMLElement, nextChannelId: string): boolean {
    const container = this.timelineOuter?.nativeElement || document;
    const escapedChannelId = this.escapeForAttributeSelector(nextChannelId);
    const nextChannelButton = this.queryChannelButton(container, nextChannelId);
    const currentChannelButton = currentElement.closest('.epg-channel-col-clickable, .epg-vertical-channel-header-btn') as HTMLElement | null;

    if (currentChannelButton) {
      return this.focusElement(nextChannelButton);
    }

    const candidates = Array.from(container.querySelectorAll(`.epg-program-bar[data-channel-id="${escapedChannelId}"]`)) as HTMLElement[];
    if (candidates.length === 0) {
      return false;
    }

    const currentTimeRange = this.getProgramTimeRange(currentElement);
    const currentAnchorTime = this.timelineAnchorTimeMs
      ?? (currentTimeRange ? currentTimeRange.start + ((currentTimeRange.end - currentTimeRange.start) * 0.33) : null);

    if (currentAnchorTime !== null) {
      const bestByTime = candidates.reduce((closest, candidate) => {
        const timeRange = this.getProgramTimeRange(candidate);
        if (!timeRange) {
          return closest;
        }

        const duration = Math.max(1, timeRange.end - timeRange.start);
        const midpoint = timeRange.start + duration / 2;
        const containsAnchor = timeRange.start <= currentAnchorTime && timeRange.end > currentAnchorTime;
        const edgeDistance = containsAnchor
          ? 0
          : Math.min(Math.abs(timeRange.start - currentAnchorTime), Math.abs(timeRange.end - currentAnchorTime));
        const midpointDistance = Math.abs(midpoint - currentAnchorTime);
        const durationPenalty = duration * 0.05;
        const score = containsAnchor
          ? midpointDistance + durationPenalty
          : edgeDistance * 1000 + midpointDistance + durationPenalty;

        if (!closest || score < closest.score) {
          return { element: candidate, score };
        }
        return closest;
      }, null as { element: HTMLElement; score: number } | null);

      const target = bestByTime?.element || nextChannelButton;
      if (target?.matches('.epg-program-bar, .epg-vertical-program-item')) {
        this.preserveTimelineColumnAnchor = true;
      }
      return this.focusElement(target);
    }

    const currentRect = currentElement.getBoundingClientRect();
    const currentCenter = currentRect.left + currentRect.width / 2;
    const best = candidates.reduce((closest, candidate) => {
      const rect = candidate.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const containsCurrentCenter = rect.left <= currentCenter && rect.right >= currentCenter;
      const edgeDistance = containsCurrentCenter
        ? 0
        : Math.min(Math.abs(rect.left - currentCenter), Math.abs(rect.right - currentCenter));
      const centerDistance = Math.abs(center - currentCenter);
      const score = containsCurrentCenter
        ? centerDistance * 0.2
        : edgeDistance * 10 + centerDistance;

      if (!closest || score < closest.score) {
        return { element: candidate, score };
      }
      return closest;
    }, null as { element: HTMLElement; score: number } | null);

    const target = best?.element || nextChannelButton;
    if (target?.matches('.epg-program-bar, .epg-vertical-program-item')) {
      this.preserveTimelineColumnAnchor = true;
    }
    return this.focusElement(target);
  }

  private focusVerticalGuideRowTarget(currentElement: HTMLElement, currentChannelId: string, nextChannelId: string): boolean {
    const container = this.timelineOuter?.nativeElement || document;
    const currentEscapedChannelId = this.escapeForAttributeSelector(currentChannelId);
    const nextEscapedChannelId = this.escapeForAttributeSelector(nextChannelId);
    const currentItems = Array.from(container.querySelectorAll(`.epg-vertical-program-item[data-channel-id="${currentEscapedChannelId}"]`)) as HTMLElement[];
    const nextItems = Array.from(container.querySelectorAll(`.epg-vertical-program-item[data-channel-id="${nextEscapedChannelId}"]`)) as HTMLElement[];
    const nextChannelButton = this.queryChannelButton(container, nextChannelId);
    const currentChannelButton = currentElement.closest('.epg-vertical-channel-header-btn') as HTMLElement | null;
    if (currentChannelButton) {
      return this.focusElement(nextChannelButton);
    }

    if (nextItems.length === 0) {
      return this.focusElement(nextChannelButton);
    }

    const currentItem = currentElement.closest('.epg-vertical-program-item') as HTMLElement | null;
    if (!currentItem) {
      return this.focusElement(nextItems[0]);
    }

    const currentIndex = Math.max(0, currentItems.indexOf(currentItem));
    const targetIndex = Math.min(currentIndex, nextItems.length - 1);
    return this.focusElement(nextItems[targetIndex]);
  }

  private showRenderedWindowForChannel(channelId: string): boolean {
    const targetIndex = this.filteredChannels.findIndex(channel => String(channel?.id || '').trim() === channelId);
    if (targetIndex < 0) {
      return false;
    }

    const pageSize = Math.max(1, this.currentChannelPageSize());
    const nextStart = Math.floor(targetIndex / pageSize) * pageSize;
    this.focusedChannelId = channelId;
    this.rebuildRenderedChannels(nextStart);
    return true;
  }

  private focusGuideTargetAfterRender(action: () => boolean): boolean {
    setTimeout(() => {
      action();
    }, 0);
    return true;
  }

  hasPreviousProgram(): boolean { return this.getAdjacentProgram(-1) !== null; }
  hasNextProgram(): boolean { return this.getAdjacentProgram(1) !== null; }

  showPreviousProgram(): void {
    const prev = this.getAdjacentProgram(-1);
    if (prev) { this.selectedProgram = prev; this.resetRecordingState(); }
  }

  showNextProgram(): void {
    const next = this.getAdjacentProgram(1);
    if (next) { this.selectedProgram = next; this.resetRecordingState(); }
  }

  private getAdjacentProgram(offset: number): any | null {
    if (!this.selectedProgram?.channel) { return null; }
    const channelPrograms = this.programsByChannel[this.selectedProgram.channel] || [];
    const currentIndex = channelPrograms.findIndex(p =>
      p === this.selectedProgram || (
        p.startTime === this.selectedProgram.startTime &&
        p.endTime === this.selectedProgram.endTime &&
        p.title === this.selectedProgram.title
      )
    );
    if (currentIndex < 0) { return null; }
    const nextIndex = currentIndex + offset;
    if (nextIndex < 0 || nextIndex >= channelPrograms.length) { return null; }
    return channelPrograms[nextIndex];
  }

  // ── Playback ──────────────────────────────────────────────────

  async playChannel(program: any): Promise<void> {
    const channelId = String(program?.channel || '').trim();
    if (!channelId) { return; }

    const uuid = await this.resolvePlayableChannelUuid(channelId);
    if (!uuid) {
      this.recordingError = 'Unable to start playback: could not resolve channel UUID.';
      return;
    }

    this.closeProgramDetails(true);
    const returnToken = this.returnNavigation.createToken({
      source: 'epg',
      payload: {
        channelId,
        startTime: this.parseEpgTime(program.startTime),
        endTime: this.parseEpgTime(program.endTime)
      }
    });
    this.router.navigate(['/player', uuid], {
      queryParams: {
        name: this.getChannelName(channelId),
        returnTo: this.router.url,
        returnToken
      }
    });
  }

  private async resolvePlayableChannelUuid(channelId: string): Promise<string> {
    const direct = String(this.getChannelUuid(channelId) || '').trim();
    if (direct) {
      return direct;
    }

    const fromChannelRow = this.channels.find(ch => String(ch?.id || '').trim() === channelId);
    const channelName = String(fromChannelRow?.name || this.getChannelName(channelId) || '').trim();
    const normalizedName = channelName.toLowerCase();

    try {
      const channels = await new Promise<any[]>((resolve) => {
        this.tvheadendService.getTvheadendChannelGrid().subscribe({
          next: (rows) => resolve(Array.isArray(rows) ? rows : []),
          error: () => resolve([])
        });
      });

      // Accept UUID-like channel IDs that already exist in TVHeadend.
      const byUuid = channels.find((ch: any) => String(ch?.uuid || '').trim() === channelId);
      if (byUuid?.uuid) {
        return String(byUuid.uuid).trim();
      }

      const exact = channels.find((ch: any) => String(ch?.name || '').trim().toLowerCase() === normalizedName);
      if (exact?.uuid) {
        return String(exact.uuid).trim();
      }

      const partial = channels.find((ch: any) => {
        const name = String(ch?.name || '').trim().toLowerCase();
        return !!name && (name.includes(normalizedName) || normalizedName.includes(name));
      });
      if (partial?.uuid) {
        return String(partial.uuid).trim();
      }
    } catch {
      // Ignore lookup errors and fall through to empty UUID.
    }

    return '';
  }

  // ── Recording ─────────────────────────────────────────────────

  recordProgram(program: any): void {
    const target = program || this.selectedProgram;
    const channelId = String(target?.channel || '').trim();
    const startTime = Number(target?.startTime || 0);
    const endTime = Number(target?.endTime || 0);

    if (!channelId || !startTime || !endTime) {
      this.recordingError = 'Unable to schedule recording: missing program timing or channel info.';
      return;
    }

    this.recordingAction = 'schedule';
    this.recordingStatusDetail = null;
    this.recordingMessage = null;
    this.recordingError = null;

    const channelName = this.getChannelName(channelId);
    const eventId = Number(target?.eventId || 0);

    this.tvheadendService.scheduleRecording(
      channelName, startTime, endTime, target?.title || 'Untitled', target?.desc || '', eventId
    ).subscribe({
      next: (result: RecordingScheduleResult) => {
        this.recordingAction = null;
        this.recordingMessage = 'Recording scheduled successfully.';
        this.recordingStatusDetail = result?.method === 'event' ? 'Matched by event ID.' : 'Scheduled as manual time-based recording.';
        this.markProgramAsScheduled(target, result);
        this.refreshScheduledRecordings();
      },
      error: (error: any) => {
        if (error?.status === 401 || error?.status === 403) {
          this.recordingAction = null;
          void this.tvheadendService.ensureBasicAuth('Enter your TVHeadend credentials to schedule this recording.').then(hasAuth => {
            if (hasAuth) { this.recordProgram(target); return; }
            this.recordingError = 'Authentication required to schedule recording.';
          });
          return;
        }
        this.recordingAction = null;
        this.recordingError = `Recording failed: ${error?.error?.message || error?.message || 'Unknown error'}`;
      }
    });
  }

  autoRecordProgram(program: any): void {
    const target = program || this.selectedProgram;
    const channelId = String(target?.channel || '').trim();
    const startTime = Number(target?.startTime || 0);
    const endTime = Number(target?.endTime || 0);
    const title = String(target?.title || '').trim();

    if (!channelId || !startTime || !endTime || !title) {
      this.recordingError = 'Unable to create auto-record rule: missing program timing, title, or channel info.';
      return;
    }

    this.autorecAction = 'create';
    this.recordingStatusDetail = null;
    this.recordingMessage = null;
    this.recordingError = null;

    const channelName = this.getChannelName(channelId);

    forkJoin({
      channels: this.tvheadendService.getTvheadendChannelGrid().pipe(catchError(() => of([]))),
      configs: this.tvheadendService.getDvrConfigs().pipe(catchError(() => of([])))
    }).subscribe({
      next: ({ channels, configs }: any) => {
        const channelUuid = this.resolveAutorecChannelUuid(channels || [], channelName);
        const configUuid = String(configs?.[0]?.uuid || '').trim();
        const conf = this.buildAutorecConf(target, channelUuid, configUuid);

        this.tvheadendService.createAutorec(conf).subscribe({
          next: () => {
            this.autorecAction = null;
            this.recordingMessage = 'Auto-record rule created.';
            this.recordingStatusDetail = 'Future episodes matching this title will be scheduled.';
          },
          error: (error: any) => {
            if (error?.status === 401 || error?.status === 403) {
              this.autorecAction = null;
              void this.tvheadendService.ensureBasicAuth('Enter your TVHeadend credentials to create this auto-record rule.').then(hasAuth => {
                if (hasAuth) { this.autoRecordProgram(target); return; }
                this.recordingError = 'Authentication required to create auto-record rule.';
              });
              return;
            }
            this.autorecAction = null;
            this.recordingError = `Auto-record failed: ${error?.error?.message || error?.message || 'Unknown error'}`;
          }
        });
      },
      error: (error: any) => {
        this.autorecAction = null;
        this.recordingError = `Auto-record failed: ${error?.error?.message || error?.message || 'Unknown error'}`;
      }
    });
  }

  cancelProgram(program: any): void {
    const target = program || this.selectedProgram;
    const dvrUuid = target?.dvrUuid || '';
    if (!dvrUuid) {
      this.recordingError = 'Unable to cancel recording: missing DVR entry UUID.';
      return;
    }
    this.recordingAction = 'cancel';
    this.recordingMessage = null;
    this.recordingError = null;
    this.recordingStatusDetail = null;

    this.tvheadendService.cancelRecording(dvrUuid).subscribe({
      next: () => {
        this.recordingAction = null;
        this.recordingMessage = 'Recording unscheduled successfully.';
        this.markProgramAsUnscheduled(target);
        this.refreshScheduledRecordings();
      },
      error: (error: any) => {
        if (error?.status === 401 || error?.status === 403) {
          this.recordingAction = null;
          void this.tvheadendService.ensureBasicAuth('Enter your TVHeadend credentials to cancel this recording.').then(hasAuth => {
            if (hasAuth) { this.cancelProgram(target); return; }
            this.recordingError = 'Authentication required to cancel recording.';
          });
          return;
        }
        this.recordingAction = null;
        this.recordingError = `Cancel failed: ${error?.error?.message || error?.message || 'Unknown error'}`;
      }
    });
  }

  isProgramScheduled(program: any): boolean {
    if (!program) { return false; }
    const dvrState = this.normalizeLookupText(program?.dvrState || '');
    if (program?.dvrUuid || dvrState === 'scheduled' || dvrState === 'recording') { return true; }

    const startMs = this.parseEpgTime(program.startTime);
    const endMs = this.parseEpgTime(program.endTime);
    const title = this.normalizeLookupText(program.title || '');
    const channelId = this.normalizeLookupText(program.channel || '');
    const channelName = this.normalizeLookupText(this.getChannelName(program.channel || ''));

    const keys = [
      this.makeRecordingKey(channelId, startMs, endMs, title),
      this.makeRecordingKey(channelName, startMs, endMs, title),
      this.makeRecordingLooseKey(channelId, startMs, title),
      this.makeRecordingLooseKey(channelName, startMs, title),
    ];
    return keys.some(key => this.scheduledRecordingKeys.has(key));
  }

  getRecordingMethodLabel(program: any): string {
    const method = String(program?.recordingMethod || '').trim();
    if (method === 'event') { return 'Event Match'; }
    if (method === 'manual') { return 'Manual Fallback'; }
    return '';
  }

  private markProgramAsScheduled(program: any, result?: RecordingScheduleResult): void {
    program.dvrState = 'scheduled';
    program.dvrUuid = result?.dvrUuid || program.dvrUuid || '';
    program.recordingMethod = result?.method || '';
    const startMs = this.parseEpgTime(program?.startTime);
    const endMs = this.parseEpgTime(program?.endTime);
    const title = this.normalizeLookupText(program?.title || '');
    const channelId = this.normalizeLookupText(program?.channel || '');
    const channelName = this.normalizeLookupText(this.getChannelName(program?.channel || ''));
    const next = new Set(this.scheduledRecordingKeys);
    next.add(this.makeRecordingKey(channelId, startMs, endMs, title));
    next.add(this.makeRecordingKey(channelName, startMs, endMs, title));
    next.add(this.makeRecordingLooseKey(channelId, startMs, title));
    next.add(this.makeRecordingLooseKey(channelName, startMs, title));
    this.scheduledRecordingKeys = next;
  }

  private markProgramAsUnscheduled(program: any): void {
    program.dvrState = '';
    program.dvrUuid = '';
    program.recordingMethod = '';
  }

  private refreshScheduledRecordings(): void {
    this.tvheadendService.getScheduledRecordings().subscribe({
      next: (entries) => {
        this.scheduledRecordingKeys = this.buildScheduledRecordingIndex(entries || []);
        this.rebuildGuideViewModel();
      },
      error: () => {
        this.scheduledRecordingKeys = new Set<string>();
        this.rebuildGuideViewModel();
      }
    });
  }

  private buildScheduledRecordingIndex(entries: any[]): Set<string> {
    const index = new Set<string>();
    entries.forEach(entry => {
      const channelRaw = this.normalizeLookupText(entry?.channelname || entry?.channelName || entry?.channel || '');
      const title = this.normalizeLookupText(entry?.disp_title || entry?.title || entry?.name || '');
      const startMs = this.normalizeRecordingTimestamp(entry?.start_real ?? entry?.start ?? entry?.startTime);
      const endMs = this.normalizeRecordingTimestamp(entry?.stop_real ?? entry?.stop ?? entry?.stopTime);
      if (!channelRaw || !title || !startMs) { return; }
      index.add(this.makeRecordingKey(channelRaw, startMs, endMs, title));
      index.add(this.makeRecordingLooseKey(channelRaw, startMs, title));
    });
    return index;
  }

  private resetRecordingState(): void {
    this.recordingAction = null;
    this.autorecAction = null;
    this.recordingStatusDetail = null;
    this.recordingMessage = null;
    this.recordingError = null;
  }

  private buildAutorecConf(program: any, channelUuid: string, configUuid: string): any {
    const title = String(program?.title || 'Untitled').trim();
    const startDate = new Date(this.parseEpgTime(program?.startTime));
    const endDate = new Date(this.parseEpgTime(program?.endTime));
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();
    const weekday = startDate.getDay() === 0 ? 7 : startDate.getDay();

    return {
      enabled: 1,
      name: `Auto: ${title}`,
      title,
      fulltext: 1,
      channel: channelUuid || '',
      config_uuid: configUuid || '',
      weekdays: [weekday],
      start: startMinutes,
      start_window: endMinutes > startMinutes ? endMinutes : startMinutes,
      start_extra: 0,
      stop_extra: 0,
      comment: `Auto-created from guide: ${title}`,
    };
  }

  private resolveAutorecChannelUuid(channels: any[], channelName: string): string {
    const target = String(channelName || '').trim().toLowerCase();
    if (!target) { return ''; }

    const exact = channels.find((ch: any) => String(ch?.name || '').trim().toLowerCase() === target);
    if (exact?.uuid) { return String(exact.uuid).trim(); }

    const partial = channels.find((ch: any) => {
      const name = String(ch?.name || '').trim().toLowerCase();
      return !!name && (name.includes(target) || target.includes(name));
    });

    return String(partial?.uuid || '').trim();
  }

  // ── Data helpers ──────────────────────────────────────────────

  private groupProgramsByChannel(): void {
    this.programsByChannel = {};
    const knownChannelIds = new Set(this.channels.map(ch => ch.id));
    for (const program of this.programs) {
      if (!this.programsByChannel[program.channel]) {
        this.programsByChannel[program.channel] = [];
        if (!knownChannelIds.has(program.channel)) {
          this.channels.push({ id: program.channel, name: program.channel, icon: '' });
          knownChannelIds.add(program.channel);
        }
      }
      this.programsByChannel[program.channel].push(program);
    }
    this.channels.sort((a, b) => this.compareChannels(a, b));
    this.rebuildGuideViewModel();
  }

  private compareChannels(left: any, right: any): number {
    const leftName = String(left?.name || left?.id || '').trim();
    const rightName = String(right?.name || right?.id || '').trim();
    return leftName.localeCompare(rightName, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  private rebuildGuideViewModel(): void {
    const query = this.filterQuery.trim().toLowerCase();
    const nextFilteredProgramsByChannel: { [channelId: string]: any[] } = {};
    const nextFilteredVerticalProgramsByChannel: { [channelId: string]: any[] } = {};
    const nextFilteredChannels: any[] = [];

    for (const channel of this.channels) {
      const channelId = String(channel?.id || '').trim();
      if (this.channelSpotlightId && channelId !== this.channelSpotlightId) {
        continue;
      }
      const allPrograms = this.programsByChannel[channelId] || [];
      const scheduled = this.showScheduledOnly
        ? allPrograms.filter(program => this.isProgramScheduled(program))
        : allPrograms;
      const categoryFiltered = this.hasActiveCategoryFilter()
        ? scheduled.filter(program => this.matchesSelectedCategory(program))
        : scheduled;

      let visiblePrograms = categoryFiltered;
      if (query) {
        const channelName = String(channel?.name || '').toLowerCase();
        const channelMatch = channelName.includes(query) || channelId.toLowerCase().includes(query);
        visiblePrograms = channelMatch
          ? categoryFiltered
          : categoryFiltered.filter(program => String(program?.title || '').toLowerCase().includes(query));
      }

      if ((query || this.showScheduledOnly || this.hasActiveCategoryFilter()) && visiblePrograms.length === 0) {
        continue;
      }

      nextFilteredChannels.push(channel);
      const sortedPrograms = [...visiblePrograms]
        .sort((a, b) => this.parseEpgTime(a.startTime) - this.parseEpgTime(b.startTime));
      const inWindow = sortedPrograms.filter(program => this.isProgramWithinTimelineWindow(program));
      nextFilteredProgramsByChannel[channelId] = inWindow;
      nextFilteredVerticalProgramsByChannel[channelId] = inWindow.length > 0 ? inWindow : sortedPrograms;
    }

    this.filteredChannels = nextFilteredChannels;
    this.filteredProgramsByChannel = nextFilteredProgramsByChannel;
    this.filteredVerticalProgramsByChannel = nextFilteredVerticalProgramsByChannel;
    this.ensureFocusedChannelVisible();
  }

  private isProgramWithinTimelineWindow(program: any): boolean {
    const start = this.parseEpgTime(program?.startTime);
    const end = this.parseEpgTime(program?.endTime);
    const windowStart = this.timelineStart.getTime();
    const windowEnd = windowStart + this.timelineSpanMs;
    return end > windowStart && start < windowEnd;
  }

  private decorateProgramForGuide(program: any): any {
    const startMs = this.parseEpgTime(program.startTime);
    const endMs = this.parseEpgTime(program.endTime);
    const windowStart = this.timelineStart.getTime();
    const windowEnd = windowStart + this.timelineSpanMs;
    const visibleStart = Math.max(startMs, windowStart);
    const visibleEnd = Math.min(endMs, windowEnd);
    const isVisible = visibleEnd > visibleStart;
    const visibleHoursFromStart = (visibleStart - windowStart) / (60 * 60 * 1000);
    const visibleHours = (visibleEnd - visibleStart) / (60 * 60 * 1000);
    const leftPx = startMs <= windowStart ? 0 : Math.max(0, Math.min(this.timelineWidthPx, visibleHoursFromStart * this.hourWidthPx));
    const widthPx = isVisible ? Math.max(8, visibleHours * this.hourWidthPx) : 0;
    const startDate = new Date(startMs);
    const endDate = new Date(endMs);
    const startLabel = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const endLabel = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const desc = String(program?.desc || '').trim();
    const tooltip = desc
      ? `${program.title}\n${startLabel} - ${endLabel}\n${desc}`
      : `${program.title}\n${startLabel} - ${endLabel}`;

    return {
      ...program,
      __startMs: startMs,
      __endMs: endMs,
      __isVisible: isVisible,
      __leftPx: leftPx,
      __widthPx: widthPx,
      __tooltip: tooltip,
      __background: this.resolveProgramBackground(program)
    };
  }

  trackByChannelId(_: number, channel: any): string {
    return String(channel?.id || '');
  }

  trackByProgram(_: number, program: any): string {
    return `${program?.channel || ''}|${program?.startTime || ''}|${program?.endTime || ''}|${program?.title || ''}`;
  }

  trackByValue(_: number, value: any): string {
    return String(value);
  }

  private attachTvheadendEpgMetadata(entries: any[]): void {
    const grouped = new Map<string, any[]>();
    entries.forEach(entry => {
      const channelName = this.normalizeLookupText(entry?.channelName || entry?.channelname || '');
      const title = this.normalizeLookupText(entry?.title || entry?.disp_title || '');
      if (!channelName || !title) { return; }
      const key = `${channelName}|${title}`;
      const existing = grouped.get(key) || [];
      existing.push(entry);
      grouped.set(key, existing);
    });

    this.programs = this.programs.map(program => {
      const channelName = this.normalizeLookupText(this.getChannelName(program.channel || ''));
      const title = this.normalizeLookupText(program.title || '');
      const key = `${channelName}|${title}`;
      const candidates = grouped.get(key) || [];
      const programStart = this.parseEpgTime(program.startTime);
      const programEnd = this.parseEpgTime(program.endTime);

      const nearMatch = candidates.find(entry => {
        const entryStart = this.parseEpgTime(entry?.start);
        const entryEnd = this.parseEpgTime(entry?.stop);
        return Math.abs(entryStart - programStart) <= 300000 && Math.abs(entryEnd - programEnd) <= 300000;
      });

      if (!nearMatch) { return program; }
      return {
        ...program,
        eventId: nearMatch?.eventId != null ? Number(nearMatch.eventId) : program.eventId,
        dvrUuid: nearMatch?.dvrUuid || program.dvrUuid || '',
        dvrState: nearMatch?.dvrState || program.dvrState || '',
        channelUuid: nearMatch?.channelUuid || program.channelUuid || '',
      };
    });

    this.groupProgramsByChannel();
  }

  private parseXmltvDate(val: string): number {
    if (!val) { return 0; }
    const trimmed = val.trim();
    const match = trimmed.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);
    if (!match) { return new Date(trimmed).getTime(); }
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    return new Date(year, month, day, hour, minute, second).getTime();
  }

  private parseEpgTime(val: any): number {
    if (val == null) { return 0; }
    if (typeof val === 'number') {
      return val < 1_000_000_000_000 ? val * 1000 : val;
    }
    if (typeof val === 'string' && /^\d+$/.test(val)) {
      const parsed = parseInt(val, 10);
      return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
    }
    return new Date(val).getTime();
  }

  private mergeCategorySources(rawCategory: any, desc: any): any {
    const explicitCategories = this.extractCategoryEntries(rawCategory);
    const descCategories = this.extractCategoriesFromDescription(desc);
    const merged = explicitCategories.concat(descCategories)
      .filter((value, index, arr) => arr.findIndex(item => item.toLowerCase() === value.toLowerCase()) === index);
    return merged.length > 0 ? merged : '';
  }

  private extractCategoriesFromDescription(desc: any): string[] {
    const text = String(desc || '');
    const match = text.match(/categories?\s*:\s*([^\n\r]+)/i);
    if (!match || !match[1]) { return []; }
    return match[1].split(/[,;|/]/).map(item => item.trim()).filter(Boolean);
  }

  private getCategoryTokens(rawCategory: any): string[] {
    return this.extractCategoryEntries(rawCategory)
      .map(token => this.normalizeCategory(token))
      .filter(Boolean);
  }

  private extractCategoryEntries(value: any): string[] {
    if (value == null) { return []; }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value).split(/[,;|]/).map(item => item.trim()).filter(Boolean);
    }
    if (Array.isArray(value)) {
      return value.reduce((acc: string[], item: any) => acc.concat(this.extractCategoryEntries(item)), []);
    }
    if (typeof value === 'object') {
      return (Object.values(value) as any[]).reduce((acc: string[], item: any) => acc.concat(this.extractCategoryEntries(item)), []);
    }
    return [];
  }

  private flattenToText(value: any): string {
    if (value == null) { return ''; }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return String(value); }
    if (Array.isArray(value)) { return value.map(item => this.flattenToText(item)).filter(Boolean).join(' '); }
    if (typeof value === 'object') { return Object.values(value).map(item => this.flattenToText(item)).filter(Boolean).join(' '); }
    return '';
  }

  private normalizeCategory(category: string): string {
    return category
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\/_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private containsAny(value: string, keywords: string[]): boolean {
    return keywords.some(keyword => value.includes(keyword));
  }

  private safeJsonString(value: any): string {
    try { return JSON.stringify(value || ''); } catch { return ''; }
  }

  private normalizeLookupText(value: any): string {
    return String(value || '').trim().toLowerCase();
  }

  private normalizeRecordingTimestamp(value: any): number {
    const parsed = this.parseEpgTime(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private makeRecordingKey(channel: string, startMs: number, endMs: number, title: string): string {
    return `${channel}|${Math.floor(startMs / 1000)}|${Math.floor(endMs / 1000)}|${title}`;
  }

  private makeRecordingLooseKey(channel: string, startMs: number, title: string): string {
    return `${channel}|${Math.floor(startMs / 1000)}|${title}`;
  }

  // ── Preferences ───────────────────────────────────────────────

  private restoreVisibleHoursPreference(): void {
    try {
      const stored = localStorage.getItem(this.rangeStorageKey);
      if (!stored) { return; }
      const parsed = parseInt(stored, 10);
      if (this.rangeOptions.includes(parsed)) { this.visibleHours = parsed; }
    } catch { /* ignore */ }
  }

  private saveVisibleHoursPreference(hours: number): void {
    try { localStorage.setItem(this.rangeStorageKey, String(hours)); } catch { /* ignore */ }
  }

  private persistGuideLayoutPreference(vertical: boolean): void {
    try { localStorage.setItem(this.layoutStorageKey, vertical ? '1' : '0'); } catch { /* ignore */ }
  }

  private restoreGuideLayoutPreference(): void {
    this.useVerticalGuide = false;
    this.persistGuideLayoutPreference(false);
  }

  private clearLegacyChannelFilterPreference(): void {
    try { localStorage.removeItem('epg.channelFilter'); } catch { /* ignore */ }
  }

  @HostListener('document:keydown', ['$event'])
  handleFilterClearKeys(event: KeyboardEvent): void {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.tagName !== 'INPUT' || !active.classList.contains('epg-filter-input')) return;
    if ((event.key === 'Escape' || event.key === 'Backspace') && this.filterQuery) {
      this.clearFilterQuery(active as HTMLInputElement);
      event.preventDefault();
      event.stopPropagation();
    }
  }

  clearFilterQuery(input: HTMLInputElement): void {
    this.filterQuery = '';
    this.onFilterQueryChange();
    setTimeout(() => input.focus(), 0);
  }
}
