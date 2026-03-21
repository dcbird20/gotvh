import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { ReturnNavigationContext, ReturnNavigationService } from '../../services/return-navigation.service';
import { TvheadendService } from '../../services/tvheadend.service';
import { ViewStateCacheService } from '../../services/view-state-cache.service';
import { TvCardComponent } from '../../shared/tv-card/tv-card.component';

interface OnNowItem {
  channel: any;
  program: any | null;
}


@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, TvFocusableDirective, TvCardComponent],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly viewCacheKey = 'home';
  onNowItems: OnNowItem[] = [];
  upcomingRecordings: any[] = [];
  finishedRecordings: any[] = [];
  heroChannel: any = null;
  heroProgram: any = null;
  loading = true;
  error = false;
  errorMessage = 'Could not connect to TVHeadend. Check your proxy config.';

  private heroIndex = 0;
  private heroTimer?: ReturnType<typeof setInterval>;
  private destroy$ = new Subject<void>();
  private pendingReturnContext: ReturnNavigationContext | null = null;

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
    this.loading = !this.onNowItems.length && !this.upcomingRecordings.length && !this.finishedRecordings.length;
    setTimeout(() => {
      if (this.loading) {
        this.loading = false;
        this.error = true;
        this.errorMessage = 'TVHeadend is not responding. Check that the backend is running and the proxy target is correct.';
      }
    }, 5000);
    this.loadData();
  }


  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.heroTimer) {
      clearInterval(this.heroTimer);
    }
  }

  private loadData(): void {
    const nowSec = Date.now() / 1000;

    forkJoin({
      channels: this.tvh.getChannelsWithResolvedTags(),
      epg: this.tvh.getEpg(),
      upcoming: this.tvh.getScheduledRecordings(),
      finished: this.tvh.getFinishedRecordings()
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: ({ channels, epg, upcoming, finished }) => {
        const sorted = [...channels].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

        this.onNowItems = sorted.slice(0, 20).map(channel => {
          const program = epg.find((e: any) =>
            e.channelUuid === channel.uuid &&
            Number(e.start) <= nowSec &&
            Number(e.stop) >= nowSec
          ) ?? null;
          return { channel, program };
        });

        this.upcomingRecordings = upcoming.slice(0, 10);
        this.finishedRecordings = finished.slice(0, 10);

        if (this.onNowItems.length) {
          const currentHeroUuid = String(this.heroChannel?.uuid || '').trim();
          const cachedHeroIndex = this.onNowItems.findIndex(item => String(item?.channel?.uuid || '').trim() === currentHeroUuid);
          this.setHero(cachedHeroIndex >= 0 ? cachedHeroIndex : 0);
          this.startHeroRotation();
        }

        this.loading = false;
        this.persistViewState();
        this.restoreReturnFocusIfNeeded();
      },
      error: (error: any) => {
        this.loading = false;
        this.error = true;
        this.errorMessage = this.resolveErrorMessage(error);
      }
    });
  }

  private resolveErrorMessage(error: any): string {
    const status = Number(error?.status || 0);

    if (status === 401) {
      return 'TVHeadend requires authentication. Use TVH Login in the sidebar and try again.';
    }

    if (status === 403) {
      return 'TVHeadend denied access for the current account. Check that this user has API, DVR, and streaming permissions.';
    }

    if (status === 0) {
      return 'TVHeadend is unreachable. Check that the backend is running and the dev proxy points to the correct host.';
    }

    return 'TVHeadend returned an unexpected error. Check backend access control and server logs.';
  }

  private setHero(index: number): void {
    const item = this.onNowItems[index];
    if (item) {
      this.heroIndex = index;
      this.heroChannel = item.channel;
      this.heroProgram = item.program;
      this.persistViewState();
    }
  }

  private startHeroRotation(): void {
    const max = Math.min(6, this.onNowItems.length);
    this.heroTimer = setInterval(() => {
      this.heroIndex = (this.heroIndex + 1) % max;
      this.setHero(this.heroIndex);
    }, 8000);
  }

  async watchChannel(channel: any, origin: 'hero' | 'on-now' = 'hero'): Promise<void> {
    const hasAuth = await this.tvh.ensureBasicAuth('Enter your TVHeadend credentials to watch live TV.');
    if (!hasAuth) {
      return;
    }

    const returnToken = this.returnNavigation.createToken({
      source: 'home',
      payload: {
        channelUuid: String(channel?.uuid || '').trim(),
        origin
      }
    });

    this.router.navigate(['/player', channel.uuid], {
      queryParams: {
        name: channel.name || 'Live TV',
        returnTo: this.router.url,
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
    if (context?.source === 'home') {
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
    const origin = String(context.payload['origin'] || 'hero').trim();
    if (!channelUuid) {
      return;
    }

    const matchedIndex = this.onNowItems.findIndex(item => String(item?.channel?.uuid || '').trim() === channelUuid);
    if (matchedIndex >= 0) {
      this.heroIndex = matchedIndex;
      this.setHero(matchedIndex);
    }

    setTimeout(() => {
      const escapedUuid = channelUuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const selector = origin === 'on-now'
        ? `app-tv-card[data-channel-uuid="${escapedUuid}"]`
        : '.hero__watch-btn';
      const target = document.querySelector(selector) as HTMLElement | null;
      target?.focus();
    }, 0);
  }

  private restoreCachedViewState(): void {
    const cached = this.viewStateCache.get<{
      onNowItems: OnNowItem[];
      upcomingRecordings: any[];
      finishedRecordings: any[];
      heroIndex: number;
    }>(this.viewCacheKey);

    if (!cached) {
      return;
    }

    this.onNowItems = cached.onNowItems || [];
    this.upcomingRecordings = cached.upcomingRecordings || [];
    this.finishedRecordings = cached.finishedRecordings || [];

    if (this.onNowItems.length) {
      this.setHero(Math.max(0, Math.min(this.onNowItems.length - 1, Number(cached.heroIndex || 0))));
    }
  }

  private persistViewState(): void {
    if (!this.onNowItems.length && !this.upcomingRecordings.length && !this.finishedRecordings.length) {
      return;
    }

    this.viewStateCache.set(this.viewCacheKey, {
      onNowItems: this.onNowItems,
      upcomingRecordings: this.upcomingRecordings,
      finishedRecordings: this.finishedRecordings,
      heroIndex: this.heroIndex
    });
  }

  goToChannels(): void {
    this.router.navigate(['/channels']);
  }

  formatTime(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatRecordingTime(rec: any): string {
    if (!rec?.start) { return ''; }
    const d = new Date(rec.start * 1000);
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatDuration(rec: any): string {
    if (!rec?.start || !rec?.stop) { return ''; }
    const mins = Math.round((Number(rec.stop) - Number(rec.start)) / 60);
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  }
}
