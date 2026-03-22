import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { registerPlugin } from '@capacitor/core';
import { take } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { RemoteKeyDebugService } from '../../services/remote-key-debug.service';
import { RecordingPlaybackProgress, RecordingPlaybackProgressService } from '../../services/recording-playback-progress.service';
import { TvheadendService } from '../../services/tvheadend.service';
import { environment } from '../../../environments/environment';

const NativeVideo = registerPlugin<{
  open(options: { url: string; title?: string; mimeType?: string; authHeader?: string; allowLiveFallback?: boolean; fallbackProfiles?: string }): Promise<{ launched: boolean }>;
  openKodiHtsp(options: { url: string; title?: string; fallbackUrl?: string }): Promise<{ launched: boolean; fallback?: boolean }>;
}>('NativeVideo');

interface PlayerDiagnostic {
  label: string;
  value: string;
}

interface MpegtsErrorInfo {
  code?: number;
  msg?: string;
}

type PlaybackTransport = 'direct' | 'proxy' | 'native';

interface StreamHealthCheck {
  label: string;
  outcome: 'pass' | 'warn' | 'fail';
  detail: string;
}


@Component({
  selector: 'app-player',
  standalone: true,
  imports: [CommonModule, TvFocusableDirective],
  templateUrl: './player.component.html',
  styleUrls: ['./player.component.scss']
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('playerVideo', { static: true })
  playerVideo?: ElementRef<HTMLVideoElement>;

  playbackType: 'live' | 'recording' = 'live';
  channelId = '';
  recordingRef = '';
  channelName = 'Live TV';
  returnTo = '/channels';
  returnToken = '';
  streamUrl = '';
  directStreamUrl = '';
  proxyStreamUrl = '';
  proxiedStreamUrlWithAuth = '';
  rawStreamUrl = '';
  playerError = '';
  playerStatus = 'Preparing playback...';
  diagnostics: PlayerDiagnostic[] = [];
  lastErrorDetail = '';
  selectedTransport: PlaybackTransport = 'direct';
  runningHealthCheck = false;
  healthChecks: StreamHealthCheck[] = [];
  healthSummary = '';
  copyingDebugReport = false;
  debugReportCopied = false;
  downloadingDebugReport = false;
  hasAc3Audio = false;
  awaitingNativeInteraction = false;
  nativeProfileLabel = '';
  hasResumePoint = false;
  resumePositionLabel = '';
  readonly diagnosticsEnabled = false;

  private mpegtsPlayer: any | null = null;
  private activePlaybackMode = 'none';
  private nativeRetryVideo: HTMLVideoElement | null = null;
  private activeNativeProfileIndex = 0;
  private readonly mpegtsProfile = 'webtv-h264-aac-mpegts';
  private nativeFallbackProfiles: string[] = [];
  private pendingResumePositionSeconds = 0;
  private hasAppliedResumePosition = false;
  private lastPersistedPositionSeconds = -1;
  private readonly resumePersistIntervalSeconds = 5;
  private readonly resumeMinimumSeconds = 30;
  private readonly resumeCompletionThresholdSeconds = 30;
  private availableLiveChannels: any[] = [];
  private loadingLiveChannelsPromise: Promise<any[]> | null = null;
  private channelSurfInProgress = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private remoteKeyDebug: RemoteKeyDebugService,
    private tvh: TvheadendService,
    private recordingProgress: RecordingPlaybackProgressService
  ) {
    this.playbackType = this.route.snapshot.queryParamMap.get('playback') === 'recording' ? 'recording' : 'live';
    this.channelId = this.route.snapshot.paramMap.get('channelId') || '';
    this.recordingRef = String(this.route.snapshot.queryParamMap.get('recordingRef') || '').trim();
    this.channelName = this.route.snapshot.queryParamMap.get('name') || (this.isRecordingPlayback() ? 'Recording' : 'Live TV');
    this.nativeFallbackProfiles = this.buildNativeFallbackProfiles();
    this.selectedTransport = this.isCapacitorNative() ? 'native' : 'direct';
    const requestedReturnTo = this.route.snapshot.queryParamMap.get('returnTo') || '';
    if (requestedReturnTo.startsWith('/')) {
      this.returnTo = requestedReturnTo;
    }
    this.returnToken = String(this.route.snapshot.queryParamMap.get('returnToken') || '').trim();
    this.refreshStreamUrls();
    this.restoreRecordingResumeState();
    this.refreshDiagnostics();
  }

  ngAfterViewInit(): void {
    void this.startPlayback();
  }

  ngOnDestroy(): void {
    this.destroyMpegtsPlayer();

    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }

    video.pause();
    video.removeAttribute('src');
    video.load();
    this.persistRecordingProgress(true);
  }

  async startPlayback(): Promise<void> {
    const video = this.playerVideo?.nativeElement;
    if (!this.isCapacitorNative() && (!video || !this.streamUrl)) {
      this.playerError = this.isRecordingPlayback()
        ? 'Missing playback URL for this recording.'
        : 'Missing stream URL for this channel.';
      this.playerStatus = this.isRecordingPlayback() ? 'No recording URL' : 'No stream URL';
      this.refreshDiagnostics();
      return;
    }

    // Ensure stream endpoints are authenticated before playback starts.
    if (!this.tvh.hasStoredAuth()) {
      const granted = await this.tvh.ensureBasicAuth(
        this.isRecordingPlayback()
          ? 'TVHeadend login is required for recording playback.'
          : 'TVHeadend login is required for live playback.'
      );
      if (!granted) {
        this.playerError = 'Playback requires TVHeadend credentials. Open TVH Login and try again.';
        this.playerStatus = 'Authentication required';
        this.refreshDiagnostics();
        return;
      }
      this.refreshStreamUrls();
    }

    this.playerError = '';
    this.lastErrorDetail = '';
    this.awaitingNativeInteraction = false;
    this.playerStatus = 'Starting playback...';
    this.refreshDiagnostics();

    if (this.isCapacitorNative()) {
      await this.openNativeAndroidPlayer();
      return;
    }

    if (this.selectedTransport === 'native') {
      this.startNativePlayback(video);
      return;
    }

    // In Capacitor/APK context, prefer mpegts.js with worker disabled so
    // network requests stay on the main thread (where Capacitor HTTP patches apply).
    if (this.isCapacitorNative()) {
      this.streamUrl = this.resolveMpegtsStreamUrl();
      const nativeMpegtsStarted = await this.startMpegtsPlayback(video, true);
      if (nativeMpegtsStarted) {
        return;
      }
      this.streamUrl = this.resolveActiveStreamUrl();
    }

    this.streamUrl = this.resolveMpegtsStreamUrl();
    const mpegtsStarted = await this.startMpegtsPlayback(video);
    if (mpegtsStarted) {
      return;
    }

    this.streamUrl = this.resolveActiveStreamUrl();
    this.startNativePlayback(video);
  }

  openExternal(): void {
    window.open(this.rawStreamUrl, '_blank', 'noopener');
  }

  openInVLC(): void {
    window.open(this.proxiedStreamUrlWithAuth, '_blank', 'noopener');
  }

  onVideoLoadedMetadata(): void {
    if (!this.isRecordingPlayback() || this.hasAppliedResumePosition || this.pendingResumePositionSeconds <= 0) {
      return;
    }

    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }

    const duration = Number(video.duration || 0);
    const maxSeekTarget = duration > this.resumeCompletionThresholdSeconds
      ? duration - this.resumeCompletionThresholdSeconds
      : duration;
    const targetPosition = maxSeekTarget > 0
      ? Math.min(this.pendingResumePositionSeconds, maxSeekTarget)
      : this.pendingResumePositionSeconds;

    if (targetPosition < this.resumeMinimumSeconds) {
      this.pendingResumePositionSeconds = 0;
      this.hasResumePoint = false;
      this.resumePositionLabel = '';
      return;
    }

    try {
      video.currentTime = targetPosition;
      this.hasAppliedResumePosition = true;
      this.resumePositionLabel = this.formatPlaybackClock(targetPosition);
      this.playerStatus = `Resumed at ${this.resumePositionLabel}`;
      this.refreshDiagnostics();
    } catch {
      // Ignore seeking failures until metadata is stable.
    }
  }

  onVideoTimeUpdate(): void {
    this.persistRecordingProgress();
  }

  onVideoPause(): void {
    this.persistRecordingProgress(true);
  }

  onVideoEnded(): void {
    if (!this.isRecordingPlayback()) {
      return;
    }

    this.recordingProgress.clear(this.recordingRef);
    this.hasResumePoint = false;
    this.resumePositionLabel = '';
    this.pendingResumePositionSeconds = 0;
    this.lastPersistedPositionSeconds = -1;
  }

  restartRecording(): void {
    if (!this.isRecordingPlayback()) {
      return;
    }

    this.recordingProgress.clear(this.recordingRef);
    this.pendingResumePositionSeconds = 0;
    this.hasResumePoint = false;
    this.resumePositionLabel = '';
    this.hasAppliedResumePosition = true;
    this.lastPersistedPositionSeconds = 0;

    const video = this.playerVideo?.nativeElement;
    if (video) {
      video.currentTime = 0;
      if (video.paused) {
        void video.play().catch(() => {
          // Ignore autoplay failures here; existing start button flow handles them.
        });
      }
    }
  }

  showResumeNotice(): boolean {
    return this.isRecordingPlayback() && this.hasResumePoint;
  }

  getPlaybackEyebrow(): string {
    return this.isRecordingPlayback() ? 'Recording Playback' : 'Live Playback';
  }

  getExternalActionLabel(): string {
    return this.isRecordingPlayback() ? 'Open Recording File' : 'Open Raw Stream';
  }

  goBack(): void {
    this.router.navigateByUrl(this.buildReturnUrl());
  }

  @HostListener('document:keydown', ['$event'])
  handleRemoteChannelKey(event: KeyboardEvent): void {
    if (this.isRecordingPlayback()) {
      return;
    }

    const direction = this.resolveChannelSurfDirection(event);
    if (!direction) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void this.surfLiveChannel(direction);
  }

  private buildReturnUrl(): string {
    try {
      const tree = this.router.parseUrl(this.returnTo);
      if (this.returnToken) {
        tree.queryParams = {
          ...tree.queryParams,
          returnToken: this.returnToken
        };
      }
      return this.router.serializeUrl(tree);
    } catch {
      return this.returnTo;
    }
  }

  private resolveChannelSurfDirection(event: KeyboardEvent): -1 | 1 | null {
    const key = String(event.key || '').trim();
    const code = String((event as any).code || '').trim();
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);

    if (
      key === 'ChannelUp'
      || key === 'MediaChannelUp'
      || key === 'PageUp'
      || code === 'ChannelUp'
      || code === 'MediaChannelUp'
      || code === 'PageUp'
      || keyCode === 33
      || keyCode === 92
      || keyCode === 166
      || keyCode === 427
    ) {
      return -1;
    }

    if (
      key === 'ChannelDown'
      || key === 'MediaChannelDown'
      || key === 'PageDown'
      || code === 'ChannelDown'
      || code === 'MediaChannelDown'
      || code === 'PageDown'
      || keyCode === 34
      || keyCode === 93
      || keyCode === 167
      || keyCode === 428
    ) {
      return 1;
    }

    return null;
  }

  private async surfLiveChannel(direction: -1 | 1): Promise<void> {
    if (this.channelSurfInProgress) {
      return;
    }

    this.channelSurfInProgress = true;

    try {
      const channels = await this.getLiveChannels();
      if (channels.length === 0) {
        this.playerStatus = 'No channels available for remote channel switching';
        this.refreshDiagnostics();
        return;
      }

      const currentChannelId = String(this.channelId || '').trim();
      const currentIndex = channels.findIndex(channel => String(channel?.uuid || '').trim() === currentChannelId);
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (baseIndex + direction + channels.length) % channels.length;
      const nextChannel = channels[nextIndex];
      const nextChannelId = String(nextChannel?.uuid || '').trim();

      if (!nextChannelId || nextChannelId === currentChannelId) {
        return;
      }

      await this.switchToLiveChannel(nextChannel);
    } finally {
      setTimeout(() => {
        this.channelSurfInProgress = false;
      }, 250);
    }
  }

  private async getLiveChannels(): Promise<any[]> {
    if (this.availableLiveChannels.length > 0) {
      return this.availableLiveChannels;
    }

    if (!this.loadingLiveChannelsPromise) {
      this.loadingLiveChannelsPromise = this.tvh.getChannelsWithResolvedTags().pipe(take(1)).toPromise()
        .then(channels => {
          const sorted = [...(channels || [])].sort((left, right) => this.compareChannels(left, right));
          this.availableLiveChannels = sorted;
          return sorted;
        })
        .catch(() => [])
        .finally(() => {
          this.loadingLiveChannelsPromise = null;
        });
    }

    return this.loadingLiveChannelsPromise;
  }

  private compareChannels(left: any, right: any): number {
    const leftNumber = Number(left?.number ?? Number.MAX_SAFE_INTEGER);
    const rightNumber = Number(right?.number ?? Number.MAX_SAFE_INTEGER);
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }

    const leftName = String(left?.name || '').trim().toLowerCase();
    const rightName = String(right?.name || '').trim().toLowerCase();
    return leftName.localeCompare(rightName);
  }

  private async switchToLiveChannel(channel: any): Promise<void> {
    const nextChannelId = String(channel?.uuid || '').trim();
    if (!nextChannelId) {
      return;
    }

    this.destroyCurrentPlayback();
    this.playbackType = 'live';
    this.channelId = nextChannelId;
    this.recordingRef = '';
    this.channelName = String(channel?.name || 'Live TV').trim() || 'Live TV';
    this.playerError = '';
    this.lastErrorDetail = '';
    this.hasResumePoint = false;
    this.resumePositionLabel = '';
    this.pendingResumePositionSeconds = 0;
    this.hasAppliedResumePosition = false;
    this.lastPersistedPositionSeconds = -1;
    this.refreshStreamUrls();
    this.playerStatus = `Switching to ${this.channelName}...`;
    this.refreshDiagnostics();

    await this.router.navigate(['/player', nextChannelId], {
      queryParams: {
        name: this.channelName,
        returnTo: this.returnTo,
        returnToken: this.returnToken || null
      },
      replaceUrl: true
    });

    await this.startPlayback();
  }

  async selectTransport(transport: PlaybackTransport): Promise<void> {
    if (this.selectedTransport === transport) {
      return;
    }

    this.selectedTransport = transport;
    this.streamUrl = this.resolveActiveStreamUrl();
    this.destroyCurrentPlayback();
    this.refreshDiagnostics();
    await this.startPlayback();
  }

  isTransportSelected(transport: PlaybackTransport): boolean {
    return this.selectedTransport === transport;
  }

  async runStreamHealthCheck(): Promise<void> {
    if (!this.diagnosticsEnabled) {
      return;
    }

    if (this.runningHealthCheck) {
      return;
    }

    this.runningHealthCheck = true;
    this.healthChecks = [];
    this.healthSummary = '';

    const authHeaders = this.tvh.getStreamRequestHeaders();
    const checks: StreamHealthCheck[] = [];

    const proxyResult = await this.probeRequest(this.proxyStreamUrl, {
      headers: authHeaders,
      timeoutMs: 7000
    });
    checks.push(this.toHealthCheck('Proxy stream request', proxyResult));

    const directCorsResult = await this.probeRequest(this.directStreamUrl, {
      headers: authHeaders,
      timeoutMs: 7000
    });
    checks.push(this.toHealthCheck('Direct stream request (CORS)', directCorsResult));

    const directNoCorsResult = await this.probeRequest(this.directStreamUrl, {
      mode: 'no-cors',
      timeoutMs: 7000
    });
    checks.push(this.toHealthCheck('Direct stream request (no-cors)', directNoCorsResult));

    this.healthChecks = checks;
    this.healthSummary = this.buildHealthSummary(checks);
    this.runningHealthCheck = false;
  }

  async copyDebugReport(): Promise<void> {
    if (!this.diagnosticsEnabled) {
      return;
    }

    if (this.copyingDebugReport) {
      return;
    }

    this.copyingDebugReport = true;
    this.debugReportCopied = false;

    const report = this.buildDebugReport();
    const copied = await this.writeTextToClipboard(report);

    this.copyingDebugReport = false;
    this.debugReportCopied = copied;

    if (copied) {
      setTimeout(() => {
        this.debugReportCopied = false;
      }, 2200);
    }
  }

  downloadDebugReport(): void {
    if (!this.diagnosticsEnabled) {
      return;
    }

    if (this.downloadingDebugReport) {
      return;
    }

    this.downloadingDebugReport = true;
    const report = this.buildDebugReport();

    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `gotvh-debug-report-${timestamp}.txt`;

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(objectUrl);
    this.downloadingDebugReport = false;
  }

  onVideoError(): void {
    this.playerError = 'The browser could not play this stream directly. Try Open Raw Stream or verify TVHeadend stream permissions.';
    this.playerStatus = 'Video element reported an error';
    this.refreshDiagnostics();
  }

  private async startMpegtsPlayback(video: HTMLVideoElement, disableWorker = false): Promise<boolean> {
    try {
      const imported = await import('mpegts.js');
      const mpegts = (imported as any).default || imported;

      if (!mpegts?.isSupported?.()) {
        this.playerStatus = 'mpegts.js unsupported in this browser';
        this.refreshDiagnostics();
        return false;
      }

      const features = mpegts.getFeatureList?.() || {};
      if (!features.mseLivePlayback) {
        this.playerStatus = 'MSE live playback unavailable';
        this.refreshDiagnostics();
        return false;
      }

      this.destroyMpegtsPlayer();
      this.activePlaybackMode = 'mpegts.js';
      this.playerStatus = this.isRecordingPlayback()
        ? 'Using mpegts.js recording playback'
        : disableWorker
          ? 'Using mpegts.js live playback (worker disabled)'
          : 'Using mpegts.js live playback';
      this.refreshDiagnostics();

      this.mpegtsPlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: !this.isRecordingPlayback(),
        url: this.streamUrl,
        withCredentials: false
      }, {
        enableWorker: !disableWorker,
        headers: this.tvh.getStreamRequestHeaders()
      });

      this.mpegtsPlayer.attachMediaElement(video);
      this.mpegtsPlayer.load();

      if (mpegts.Events?.ERROR) {
        this.mpegtsPlayer.on(
          mpegts.Events.ERROR,
          (errorType: string, errorDetail: string, errorInfo?: MpegtsErrorInfo) => {
            this.lastErrorDetail = [errorType, errorDetail, errorInfo?.code, errorInfo?.msg]
              .filter(value => value !== undefined && value !== null && value !== '')
              .join(' | ');

            if (this.isUnsupportedAc3Error(errorDetail, errorInfo)) {
              this.hasAc3Audio = true;
              this.playerError = this.isRecordingPlayback()
                ? 'This recording uses AC-3 audio, which this browser cannot play through MSE. Try "🎬 Open in VLC" or "Open Recording File" to play it in an external media player.'
                : 'This stream uses AC-3 audio, which this browser cannot play through MSE. Try "🎬 Open in VLC" or "Open Raw Stream" to play in an external media player.';
              this.playerStatus = 'Switching to native/raw playback';
              this.selectedTransport = 'native';
              this.streamUrl = this.resolveActiveStreamUrl();
              this.refreshDiagnostics();
              setTimeout(() => this.startNativePlayback(video), 0);
              return;
            }

            this.playerError = this.describePlaybackError(errorDetail, errorInfo);
            this.playerStatus = 'mpegts.js playback error';
            this.refreshDiagnostics();
          }
        );
      }

      const playPromise = video.play();
      if (playPromise) {
        playPromise.catch(() => {
          this.playerError = 'Playback could not start automatically. Press play or verify TVHeadend stream permissions.';
          this.playerStatus = 'Autoplay blocked or playback failed';
          this.refreshDiagnostics();
        });
      }

      return true;
    } catch {
      this.playerStatus = 'mpegts.js unavailable';
      this.refreshDiagnostics();
      return false;
    }
  }

  private startNativePlayback(video: HTMLVideoElement): void {
    this.destroyMpegtsPlayer();
    this.activePlaybackMode = 'native video';
    this.tryNativePlaybackWithFallback(video, 0);
  }

  private tryNativePlaybackWithFallback(video: HTMLVideoElement, profileIndex: number): void {
    const profile = this.nativeFallbackProfiles[profileIndex];
    if (!profile) {
      this.playerError = 'Native playback could not start with any tested profile. The stream format may be unsupported on this device.';
      this.playerStatus = 'All native profile attempts failed';
      this.refreshDiagnostics();
      return;
    }

    this.streamUrl = this.withProfile(this.rawStreamUrl, profile);
    this.activeNativeProfileIndex = profileIndex;
    this.nativeProfileLabel = profile;
    this.playerStatus = `Using native HTML5 video playback (${profile})`;
    this.refreshDiagnostics();

    // Some Android TV WebViews require muted + inline flags to be applied
    // immediately before play() to pass autoplay policy checks.
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');

    video.pause();
    video.src = this.streamUrl;
    video.load();

    const playPromise = video.play();
    if (playPromise) {
      let switched = false;
      const timeoutId = window.setTimeout(() => {
        if (switched || this.awaitingNativeInteraction) {
          return;
        }
        switched = true;
        video.removeEventListener('playing', onPlaying);
        this.playerStatus = `No media data for profile ${profile}, trying fallback...`;
        this.refreshDiagnostics();
        this.tryNativePlaybackWithFallback(video, profileIndex + 1);
      }, 8000);

      const onPlaying = () => {
        window.clearTimeout(timeoutId);
        video.removeEventListener('playing', onPlaying);
      };
      video.addEventListener('playing', onPlaying, { once: true });

      playPromise.catch(() => {
        window.clearTimeout(timeoutId);
        video.removeEventListener('playing', onPlaying);
        this.playerError = 'Autoplay was blocked by the device policy. Press OK/Enter or click once to start playback.';
        this.playerStatus = 'Waiting for user interaction to start native playback';
        this.awaitingNativeInteraction = true;
        this.nativeRetryVideo = video;
        this.registerNativePlaybackGestureRetry(video);
        this.refreshDiagnostics();
      });
    }
  }

  startPlaybackAfterInteraction(): void {
    const video = this.nativeRetryVideo || this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }

    const retryPromise = video.play();
    if (retryPromise) {
      retryPromise
        .then(() => {
          this.awaitingNativeInteraction = false;
          this.playerError = '';
          this.playerStatus = 'Native playback started after user interaction';
          this.refreshDiagnostics();
        })
        .catch(() => {
          const nextProfile = this.nativeFallbackProfiles[this.activeNativeProfileIndex + 1];
          if (nextProfile && video) {
            this.awaitingNativeInteraction = false;
            this.playerError = `Profile ${this.nativeProfileLabel} failed after interaction. Trying ${nextProfile}...`;
            this.playerStatus = 'Native playback retry failed; switching profile';
            this.refreshDiagnostics();
            this.tryNativePlaybackWithFallback(video, this.activeNativeProfileIndex + 1);
            return;
          }

          this.awaitingNativeInteraction = true;
          this.playerError = 'Playback is still blocked. Press Start Playback again or switch transport mode.';
          this.playerStatus = 'Native playback retry failed';
          this.refreshDiagnostics();
        });
    }
  }

  private registerNativePlaybackGestureRetry(video: HTMLVideoElement): void {
    const retry = () => {
      document.removeEventListener('keydown', retry, true);
      document.removeEventListener('click', retry, true);
      document.removeEventListener('touchstart', retry, true);
      this.startPlaybackAfterInteraction();
    };

    document.addEventListener('keydown', retry, true);
    document.addEventListener('click', retry, true);
    document.addEventListener('touchstart', retry, true);
  }

  private destroyMpegtsPlayer(): void {
    if (!this.mpegtsPlayer) {
      return;
    }

    try {
      this.mpegtsPlayer.destroy();
    } catch {
      // Ignore teardown errors from the underlying player implementation.
    }

    this.mpegtsPlayer = null;
  }

  private destroyCurrentPlayback(): void {
    this.persistRecordingProgress(true);
    this.destroyMpegtsPlayer();

    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }

    video.pause();
    video.removeAttribute('src');
    video.load();
    this.activePlaybackMode = 'none';
  }

  private refreshDiagnostics(): void {
    if (!this.diagnosticsEnabled) {
      this.diagnostics = [];
      this.healthChecks = [];
      this.healthSummary = '';
      return;
    }

    const nativeSupport = this.playerVideo?.nativeElement?.canPlayType('video/mp2t') || 'no';
    this.diagnostics = [
      { label: 'Transport', value: this.getTransportLabel() },
      { label: 'Playback Mode', value: this.activePlaybackMode || 'initializing' },
      { label: 'Native Profile', value: this.nativeProfileLabel || 'n/a' },
      { label: 'Status', value: this.playerStatus },
      { label: 'Last Remote Key', value: this.getLatestRemoteKeySummary() },
      { label: 'Stream Host', value: this.getSanitizedStreamHost() },
      { label: 'Auth In URL', value: this.hasAuthInUrl(this.streamUrl) ? 'yes' : 'no' },
      { label: 'Auth Header', value: this.hasAuthHeader() ? 'yes' : 'no' },
      { label: 'Native TS Support', value: nativeSupport || 'no' },
      { label: 'Last Error', value: this.lastErrorDetail || 'none' }
    ];
  }

  private getLatestRemoteKeySummary(): string {
    const lastEvent = this.remoteKeyDebug.getSnapshot().lastEvent;
    if (!lastEvent) {
      return 'none';
    }

    const keyLabel = lastEvent.key || lastEvent.code || String(lastEvent.keyCode || 'unknown');
    return `${lastEvent.action} via ${keyLabel} on ${lastEvent.route}`;
  }

  private refreshStreamUrls(): void {
    if (this.isRecordingPlayback()) {
      this.directStreamUrl = this.tvh.getRecordingStreamUrl(this.recordingRef, {
        includeAuth: true
      });
      this.proxyStreamUrl = this.tvh.getRecordingStreamUrl(this.recordingRef, {
        proxied: true,
        includeAuth: true
      });
    } else {
      this.directStreamUrl = this.tvh.getChannelStreamUrl(this.channelId, {
        includeAuth: true
      });
      this.proxyStreamUrl = this.tvh.getChannelStreamUrl(this.channelId, {
        proxied: true,
        includeAuth: true
      });
    }
    this.proxiedStreamUrlWithAuth = this.proxyStreamUrl;
    this.rawStreamUrl = this.isRecordingPlayback()
      ? this.tvh.getRecordingStreamUrl(this.recordingRef, {
          includeAuth: true
        })
      : this.tvh.getChannelStreamUrl(this.channelId, {
          includeAuth: true
        });
    this.streamUrl = this.resolveActiveStreamUrl();
  }

  private restoreRecordingResumeState(): void {
    if (!this.isRecordingPlayback() || !this.recordingRef) {
      this.hasResumePoint = false;
      this.resumePositionLabel = '';
      this.pendingResumePositionSeconds = 0;
      return;
    }

    const progress = this.recordingProgress.get(this.recordingRef);
    if (!progress || progress.positionSeconds < this.resumeMinimumSeconds) {
      this.hasResumePoint = false;
      this.resumePositionLabel = '';
      this.pendingResumePositionSeconds = 0;
      return;
    }

    this.pendingResumePositionSeconds = progress.positionSeconds;
    this.resumePositionLabel = this.formatPlaybackClock(progress.positionSeconds);
    this.hasResumePoint = true;
  }

  private persistRecordingProgress(force = false): void {
    if (!this.isRecordingPlayback() || !this.recordingRef || this.isCapacitorNative()) {
      return;
    }

    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }

    const positionSeconds = Number(video.currentTime || 0);
    const durationSeconds = Number(video.duration || 0);

    if (!positionSeconds || positionSeconds < this.resumeMinimumSeconds) {
      return;
    }

    const remainingSeconds = durationSeconds > 0 ? durationSeconds - positionSeconds : Number.POSITIVE_INFINITY;
    if (remainingSeconds <= this.resumeCompletionThresholdSeconds) {
      this.recordingProgress.clear(this.recordingRef);
      this.hasResumePoint = false;
      this.resumePositionLabel = '';
      this.pendingResumePositionSeconds = 0;
      this.lastPersistedPositionSeconds = -1;
      return;
    }

    if (!force && this.lastPersistedPositionSeconds >= 0 && Math.abs(positionSeconds - this.lastPersistedPositionSeconds) < this.resumePersistIntervalSeconds) {
      return;
    }

    const progress: RecordingPlaybackProgress = {
      recordingRef: this.recordingRef,
      title: this.channelName,
      positionSeconds,
      durationSeconds,
      updatedAt: Date.now()
    };

    this.recordingProgress.save(progress);
    this.lastPersistedPositionSeconds = positionSeconds;
    this.hasResumePoint = true;
    this.resumePositionLabel = this.formatPlaybackClock(positionSeconds);
  }

  private formatPlaybackClock(totalSeconds: number): string {
    const normalized = Math.max(0, Math.floor(Number(totalSeconds || 0)));
    const hours = Math.floor(normalized / 3600);
    const minutes = Math.floor((normalized % 3600) / 60);
    const seconds = normalized % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  private hasAuthInUrl(url: string): boolean {
    try {
      const parsed = new URL(url, window.location.origin);
      return !!parsed.username || (parsed.searchParams.has('username') && parsed.searchParams.has('password'));
    } catch {
      return url.includes('@') || (url.includes('username=') && url.includes('password='));
    }
  }

  private hasAuthHeader(): boolean {
    return this.selectedTransport !== 'native' && !!this.tvh.getStreamRequestHeaders().Authorization;
  }

  private resolveActiveStreamUrl(): string {
    if (this.selectedTransport === 'proxy') {
      return this.proxyStreamUrl;
    }

    if (this.selectedTransport === 'native') {
      return this.rawStreamUrl;
    }

    return this.directStreamUrl;
  }

  private resolveMpegtsStreamUrl(): string {
    const baseUrl = this.selectedTransport === 'proxy' ? this.proxyStreamUrl : this.directStreamUrl;
    if (this.isRecordingPlayback()) {
      return baseUrl;
    }
    return this.withProfile(baseUrl, this.mpegtsProfile);
  }

  private async openNativeAndroidPlayer(): Promise<void> {
    if (this.isRecordingPlayback()) {
      await this.openNativeRecordingPlayer();
      return;
    }

    if (this.tvh.shouldUseKodiHtspBackend()) {
      await this.openKodiHtspPlayer();
      return;
    }

    const profile = this.nativeFallbackProfiles[0] || 'webtv-h264-vorbis-mp4';
    const useBufferedPlayback = this.tvh.shouldUseNativeBufferedPlayback();
    const allowLiveFallback = this.tvh.shouldAllowNativeLiveFallback();
    
    // For native Android playback, keep credentials in the URL as well as the
    // Authorization header because some media stacks drop headers across
    // redirects or secondary requests.
    const baseUrl = this.tvh.getChannelStreamUrl(this.channelId, {
      includeAuth: true,
      buffered: useBufferedPlayback,
      playlist: false  // CRITICAL: Don't use playlist for native player
    });
    
    const authHeader = this.tvh.getAuthHeader() || undefined;
    const url = this.withProfile(baseUrl, profile);
    const sourceLabel = useBufferedPlayback ? 'backend buffered' : 'live direct';
    const mimeType = this.resolveNativeMimeType(profile);

    console.log(`[ExoPlayer] URL: ${url} | Profile: ${profile} | MIME: ${mimeType} | Buffered: ${useBufferedPlayback}`);

    this.nativeProfileLabel = profile;
    this.activePlaybackMode = 'native android player';
    this.playerStatus = `Opening native Android player (${sourceLabel}, ${profile})`;
    this.playerError = '';
    this.refreshDiagnostics();

    try {
      await NativeVideo.open({
        url,
        title: this.channelName,
        mimeType,
        authHeader,
        allowLiveFallback,
        fallbackProfiles: this.nativeFallbackProfiles.join(',')
      });
    } catch (error: any) {
      this.playerError = `Failed to open native Android player: ${String(error?.message || error || 'unknown error')}`;
      this.playerStatus = 'Native Android player launch failed';
      this.refreshDiagnostics();
    }
  }

  private async openNativeRecordingPlayer(): Promise<void> {
    const authHeader = this.tvh.getAuthHeader() || undefined;
    const mimeType = this.inferRecordingMimeType(this.rawStreamUrl);

    this.nativeProfileLabel = mimeType;
    this.activePlaybackMode = 'native android player';
    this.playerStatus = 'Opening native Android recording playback';
    this.playerError = '';
    this.refreshDiagnostics();

    try {
      await NativeVideo.open({
        url: this.rawStreamUrl,
        title: this.channelName,
        mimeType,
        authHeader,
        allowLiveFallback: false
      });
    } catch (error: any) {
      this.playerError = `Failed to open native Android player: ${String(error?.message || error || 'unknown error')}`;
      this.playerStatus = 'Native Android player launch failed';
      this.refreshDiagnostics();
    }
  }

  private async openKodiHtspPlayer(): Promise<void> {
    const endpoint = this.tvh.getHtspEndpoint();
    const credentials = this.tvh.getStoredCredentials();

    // Build channel path directly from channelId
    const channelId = String(this.channelId || '').trim();
    const channelPath = `stream/channel/${encodeURIComponent(channelId)}`;

    console.log(`[HTSP] Channel ID: ${channelId}`);
    console.log(`[HTSP] Channel path: ${channelPath}`);

    const credentialPart = credentials
      ? `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`
      : '';
    const htspUrl = `htsp://${credentialPart}${endpoint.host}:${endpoint.port}/${channelPath}`;

    console.log(`[HTSP] Constructed HTSP URL: htsp://${credentialPart}${endpoint.host}:${endpoint.port}/${channelPath}`);
    console.log(`[HTSP] Full URL (masked): ${htspUrl.replace(/:[^@]*@/, ':***@')}`);

    this.nativeProfileLabel = 'kodi-htsp';
    this.activePlaybackMode = 'native kodi htsp';
    this.playerStatus = `Opening Kodi HTSP (${endpoint.host}:${endpoint.port})`;
    this.playerError = '';
    this.refreshDiagnostics();

    try {
      console.log(`[HTSP] Calling NativeVideo.openKodiHtsp with URL: ${htspUrl.replace(/:[^@]*@/, ':***@')}`);
      const response = await NativeVideo.openKodiHtsp({
        url: htspUrl,
        title: this.channelName
      });

      console.log(`[HTSP] Plugin response:`, response);
      this.playerStatus = 'Kodi HTSP playback started';
      this.playerError = '';
    } catch (error: any) {
      const errorMsg = String(error?.message || error || 'unknown error');
      console.error(`[HTSP] Plugin error:`, error);
      console.error(`[HTSP] Error message: ${errorMsg}`);
      this.playerError = `HTSP Error: ${errorMsg}`;
      this.playerStatus = 'Kodi HTSP failed to launch';
      this.nativeProfileLabel = 'kodi-htsp-failed';
      this.refreshDiagnostics();
    }
  }

  private extractChannelPathFromStreamUrl(url: string): string {
    if (!url) {
      return '';
    }

    try {
      const parsed = new URL(url, window.location.origin);
      const match = parsed.pathname.match(/\/(stream|play\/stream)\/(channelid\/\d+|channel\/[a-zA-Z0-9_-]+)/);
      if (!match) {
        return '';
      }
      return `stream/${match[2]}`;
    } catch {
      const match = url.match(/\/(stream|play\/stream)\/(channelid\/\d+|channel\/[a-zA-Z0-9_-]+)/);
      if (!match) {
        return '';
      }
      return `stream/${match[2]}`;
    }
  }

  private async resolveNativePlaylistUrl(playlistUrl: string, authHeader?: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    try {
      const response = await fetch(playlistUrl, {
        method: 'GET',
        headers,
        cache: 'no-store'
      });

      if (!response.ok) {
        return '';
      }

      const body = await response.text();
      const streamLine = body
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => !!line && !line.startsWith('#'));

      if (!streamLine) {
        return '';
      }

      return new URL(streamLine, playlistUrl).toString();
    } catch {
      return '';
    }
  }

  private getTransportLabel(): string {
    if (this.selectedTransport === 'proxy') {
      return 'Proxy stream';
    }

    if (this.selectedTransport === 'native') {
      return 'Native/raw stream';
    }

    return 'Direct TVHeadend';
  }

  private async probeRequest(
    url: string,
    options: { headers?: Record<string, string>; mode?: RequestMode; timeoutMs?: number }
  ): Promise<{ ok: boolean; status?: number; opaque?: boolean; error?: string }> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 7000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        mode: options.mode || 'cors',
        headers: options.headers,
        cache: 'no-store',
        signal: controller.signal
      });

      if (response.body) {
        response.body.cancel().catch(() => {
          // Ignore cancellation errors when probing stream endpoints.
        });
      }

      return {
        ok: response.ok,
        status: response.status,
        opaque: response.type === 'opaque'
      };
    } catch (error: any) {
      return {
        ok: false,
        error: String(error?.message || error || 'Unknown request failure')
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private toHealthCheck(
    label: string,
    result: { ok: boolean; status?: number; opaque?: boolean; error?: string }
  ): StreamHealthCheck {
    if (result.opaque) {
      return {
        label,
        outcome: 'warn',
        detail: 'Opaque browser response. This usually means the endpoint is reachable but blocked from inspection by CORS.'
      };
    }

    if (result.ok) {
      return {
        label,
        outcome: 'pass',
        detail: `HTTP ${result.status || 200} response received.`
      };
    }

    if (typeof result.status === 'number') {
      if (result.status === 401 || result.status === 403) {
        return {
          label,
          outcome: 'warn',
          detail: `HTTP ${result.status}. Authentication or ACL permissions are blocking playback.`
        };
      }

      if (result.status === 504) {
        return {
          label,
          outcome: 'fail',
          detail: 'HTTP 504 from the proxy path. The dev proxy timed out while relaying the live stream.'
        };
      }

      return {
        label,
        outcome: 'fail',
        detail: `HTTP ${result.status}. Endpoint responded with an error status.`
      };
    }

    if ((result.error || '').includes('Failed to fetch')) {
      return {
        label,
        outcome: 'fail',
        detail: 'Fetch failed before headers arrived. Usually CORS rejection or backend connection reset.'
      };
    }

    if ((result.error || '').includes('aborted')) {
      return {
        label,
        outcome: 'fail',
        detail: 'Probe timed out before receiving headers from the stream endpoint.'
      };
    }

    return {
      label,
      outcome: 'fail',
      detail: result.error || 'Unknown transport failure.'
    };
  }

  private buildHealthSummary(checks: StreamHealthCheck[]): string {
    const hasFail = checks.some(check => check.outcome === 'fail');
    const hasWarn = checks.some(check => check.outcome === 'warn');

    if (hasFail && hasWarn) {
      return 'Mixed failures detected: backend stream transport is unstable and browser policy restrictions are also present.';
    }

    if (hasFail) {
      return 'Hard transport failures detected. Playback will not start until backend stream delivery is fixed.';
    }

    if (hasWarn) {
      return 'Transport partially reachable, but auth or CORS policy is blocking normal browser playback.';
    }

    return 'All probes succeeded. Playback issues are likely codec or player-specific.';
  }

  private buildDebugReport(): string {
    const remoteSnapshot = this.remoteKeyDebug.getSnapshot();
    const remoteLines = remoteSnapshot.recentEvents.length
      ? remoteSnapshot.recentEvents.slice(0, 8).map(item => `- ${item.timestamp} ${item.action} | key=${item.key || 'n/a'} | code=${item.code || 'n/a'} | keyCode=${item.keyCode || 0} | source=${item.source} | route=${item.route}`)
      : ['- No tracked remote keys yet.'];

    if (!this.diagnosticsEnabled) {
      return [
        'GoTVH Debug Report',
        `Timestamp: ${new Date().toISOString()}`,
        `Last Remote Key: ${this.getLatestRemoteKeySummary()}`,
        '',
        'Recent Remote Keys:',
        ...remoteLines,
        '',
        'Diagnostics are currently disabled in the player UI.'
      ].join('\n');
    }

    const diagnosticsLines = this.diagnostics.map(item => `- ${item.label}: ${item.value}`);
    const checksLines = this.healthChecks.length
      ? this.healthChecks.map(item => `- [${item.outcome.toUpperCase()}] ${item.label}: ${item.detail}`)
      : ['- No health checks run yet.'];

    return [
      'GoTVH Debug Report',
      `Timestamp: ${new Date().toISOString()}`,
      `Channel: ${this.channelName} (${this.channelId})`,
      `Transport: ${this.getTransportLabel()}`,
      `Player Status: ${this.playerStatus}`,
      `Player Error: ${this.playerError || 'none'}`,
      `Last Remote Key: ${this.getLatestRemoteKeySummary()}`,
      '',
      'Recent Remote Keys:',
      ...remoteLines,
      '',
      'Diagnostics:',
      ...diagnosticsLines,
      '',
      `Health Summary: ${this.healthSummary || 'none'}`,
      'Health Checks:',
      ...checksLines
    ].join('\n');
  }

  private async writeTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback below.
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }

    document.body.removeChild(textarea);
    return copied;
  }

  private describePlaybackError(errorDetail: string, errorInfo?: MpegtsErrorInfo): string {
    const playbackTarget = this.isRecordingPlayback() ? 'recording' : 'live stream';

    if (this.isUnsupportedAc3Error(errorDetail, errorInfo)) {
      return `This ${playbackTarget} contains AC-3 audio which the browser cannot decode. Use the "🎬 Open in VLC" button to play it in VLC Media Player, or use the external file option for other media players.`;
    }

    if (errorInfo?.code === 504) {
      return `The dev proxy timed out while tunneling the ${playbackTarget}. Direct browser playback avoids that proxy, but then TVHeadend must allow cross-origin requests.`;
    }

    if (errorInfo?.msg?.includes('Failed to fetch')) {
      return `The browser could not fetch the ${playbackTarget}. TVHeadend is rejecting the cross-origin request, so CORS must be enabled on the backend or the stream must be served through a real reverse proxy.`;
    }

    if (errorDetail === 'HttpStatusCodeInvalid') {
      return `TVHeadend rejected the playback request with HTTP ${errorInfo?.code || 'error'}. Verify stream permissions and credentials.`;
    }

    return `mpegts.js could not start playback. Try the external file option or verify the TVHeadend ${playbackTarget} URL, credentials, and transport policy.`;
  }

  private getSanitizedStreamHost(): string {
    try {
      const parsed = new URL(this.streamUrl);
      return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
    } catch {
      return this.streamUrl.replace(/\/\/.*@/, '//');
    }
  }

  isCapacitorNative(): boolean {
    return !!(window as any)?.Capacitor?.isNativePlatform?.();
  }

  private isRecordingPlayback(): boolean {
    return this.playbackType === 'recording';
  }

  private withProfile(url: string, profile: string): string {
    try {
      const parsed = new URL(url, window.location.origin);
      parsed.searchParams.set('profile', profile);
      return parsed.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}profile=${encodeURIComponent(profile)}`;
    }
  }

  private resolveNativeMimeType(profile: string): string {
    if (profile.includes('matroska')) {
      return 'video/x-matroska';
    }
    if (profile.includes('mpegts') || profile === 'pass') {
      return 'video/mp2t';
    }
    return 'video/mp4';
  }

  private inferRecordingMimeType(url: string): string {
    const normalizedUrl = String(url || '').toLowerCase();
    if (normalizedUrl.includes('.mkv')) {
      return 'video/x-matroska';
    }
    if (normalizedUrl.includes('.mp4') || normalizedUrl.includes('.m4v')) {
      return 'video/mp4';
    }
    return 'video/mp2t';
  }

  private buildNativeFallbackProfiles(): string[] {
    const envProfiles = (environment as any).nativePreferredProfiles;
    const parsedProfiles = Array.isArray(envProfiles)
      ? envProfiles
      : String(envProfiles || '')
          .split(',')
          .map((profile: string) => profile.trim())
          .filter((profile: string) => !!profile);

    if (parsedProfiles.length) {
      return this.dedupeProfiles(parsedProfiles);
    }

    if (this.isCapacitorNative()) {
      return this.dedupeProfiles([
        'pass',
        'webtv-h264-aac-matroska',
        'webtv-h264-vorbis-mp4',
        'webtv-h264-aac-mpegts'
      ]);
    }

    return this.dedupeProfiles([
      'pass',
      'webtv-h264-vorbis-mp4',
      'webtv-h264-aac-mpegts',
      'webtv-h264-aac-matroska'
    ]);
  }

  private dedupeProfiles(profiles: string[]): string[] {
    const uniqueProfiles = new Set<string>();

    for (const profile of profiles) {
      const normalized = String(profile || '').trim();
      if (normalized) {
        uniqueProfiles.add(normalized);
      }
    }

    return Array.from(uniqueProfiles);
  }

  private isUnsupportedAc3Error(errorDetail: string, errorInfo?: MpegtsErrorInfo): boolean {
    const detail = (errorDetail || '').toLowerCase();
    const message = (errorInfo?.msg || '').toLowerCase();
    return detail.includes('mediamseerror') && (message.includes('ac-3') || message.includes('codecs=ac-3'));
  }
}