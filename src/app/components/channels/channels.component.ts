import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
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
  channels: any[] = [];
  filteredChannels: any[] = [];
  epgEvents: any[] = [];
  focusedChannel: any = null;
  focusedChannelProgram: any = null;
  searchQuery = '';
  searchVisible = false;
  loading = true;
  errorMessage = '';
  favorites: Set<string> = new Set();
  private pendingReturnContext: ReturnNavigationContext | null = null;

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
      const saved = JSON.parse(localStorage.getItem('gotvh_fav_channels') || '[]');
      this.favorites = new Set(saved);
    } catch {
      this.favorites = new Set();
    }
  }

  private loadData(): void {
    forkJoin({
      channels: this.tvh.getChannelsWithResolvedTags(),
      epg: this.tvh.getEpg()
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: ({ channels, epg }) => {
        this.channels = [...channels].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
        this.epgEvents = epg;
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

  filterChannels(): void {
    const q = this.searchQuery.toLowerCase().trim();
    const filtered = q
      ? this.channels.filter(ch =>
          (ch.name || '').toLowerCase().includes(q) ||
          String(ch.number || '').includes(q) ||
          (ch.__resolvedTagNames || []).some((t: string) =>
            t.toLowerCase().includes(q)
          )
        )
      : [...this.channels];

    // Favorites first
    this.filteredChannels = [
      ...filtered.filter(ch => this.favorites.has(ch.uuid)),
      ...filtered.filter(ch => !this.favorites.has(ch.uuid))
    ];

    this.persistViewState();
  }

  selectChannel(channel: any): void {
    this.focusedChannel = channel;
    const nowSec = Date.now() / 1000;
    this.focusedChannelProgram = this.epgEvents.find(e =>
      e.channelUuid === channel.uuid &&
      Number(e.start) <= nowSec &&
      Number(e.stop) >= nowSec
    ) ?? null;
    this.persistViewState();
  }

  activateChannel(channel: any): void {
    if (!channel) {
      return;
    }

    this.selectChannel(channel);
    void this.watchChannel(channel);
  }

  async watchChannel(channel: any): Promise<void> {
    const hasAuth = await this.tvh.ensureBasicAuth('Enter your TVHeadend credentials to watch live TV.');
    if (!hasAuth) {
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
      focusedChannelUuid: string;
    }>(this.viewCacheKey);

    if (!cached?.channels?.length) {
      return;
    }

    this.channels = cached.channels;
    this.epgEvents = cached.epgEvents || [];
    this.searchQuery = String(cached.searchQuery || '');
    this.searchVisible = !!cached.searchVisible;
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
      focusedChannelUuid: String(this.focusedChannel?.uuid || '').trim()
    });
  }

  toggleFavorite(channel: any): void {
    if (this.favorites.has(channel.uuid)) {
      this.favorites.delete(channel.uuid);
    } else {
      this.favorites.add(channel.uuid);
    }
    localStorage.setItem('gotvh_fav_channels', JSON.stringify([...this.favorites]));
    this.filterChannels();
  }

  toggleSearch(): void {
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.searchQuery = '';
      this.filterChannels();
    }
  }

  isFavorite(channel: any): boolean {
    return this.favorites.has(channel.uuid);
  }

  getCurrentProgram(channel: any): any {
    const nowSec = Date.now() / 1000;
    return this.epgEvents.find(e =>
      e.channelUuid === channel.uuid &&
      Number(e.start) <= nowSec &&
      Number(e.stop) >= nowSec
    ) ?? null;
  }

  formatTimeRange(program: any): string {
    if (!program) { return ''; }
    const fmt = (t: number) =>
      new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${fmt(Number(program.start))} – ${fmt(Number(program.stop))}`;
  }
}
