import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TvheadendService } from '@gotvh/tvh-api';

export interface RecordingPlayerData {
  uuid: string;
  title: string;
  subtitle?: string;
  /** Times played to the end (Tvheadend's playcount). */
  playcount: number;
  /** Where to start, seconds (0 = the beginning). */
  startSeconds: number;
}

// Same rules as the TV app: the first 15 s don't count; the last minute counts as watched.
const MIN_SECONDS = 15;
const END_SECONDS = 60;
const SAVE_EVERY = 30;

/**
 * Plays a recording in the browser (mpegts.js: Tvheadend records MPEG-TS, which browsers can't
 * play natively). Where you stop is saved on the recording in Tvheadend — the same fields the TV app
 * and Kodi use — so you can start here and finish on the TV, or the other way round.
 *
 * Browsers decode H.264/AAC; Dolby AC-3 sound and MPEG-2 video (common on antenna channels) don't
 * play, so the dialog offers VLC for those.
 */
@Component({
  selector: 'admin-recording-player-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}@if (data.subtitle) { <span class="muted"> · {{ data.subtitle }}</span> }</h2>
    <mat-dialog-content>
      <video #video class="video" controls playsinline (loadedmetadata)="onMetadata()" (timeupdate)="save(false)"
             (pause)="save(true)" (ended)="onEnded()"></video>
      @if (error(); as e) {
        <p class="error">{{ e }}</p>
      } @else {
        <p class="muted small">{{ note() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions>
      <button mat-button (click)="openInVlc()"><mat-icon>open_in_new</mat-icon> Open in VLC</button>
      <span class="spacer"></span>
      <button mat-flat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .video { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; display: block; }
    .error { color: var(--mat-sys-error); margin: 12px 0 0; }
    .small { font-size: 12px; margin: 8px 0 0; }
    .spacer { flex: 1; }
  `],
})
export class RecordingPlayerDialogComponent implements AfterViewInit, OnDestroy {
  readonly data = inject<RecordingPlayerData>(MAT_DIALOG_DATA);
  private readonly tvh = inject(TvheadendService);
  private readonly snack = inject(MatSnackBar);
  @ViewChild('video', { static: true }) private videoRef!: ElementRef<HTMLVideoElement>;

  readonly error = signal('');
  readonly note = signal('Where you stop is remembered, here and on the TV.');
  private player: any = null;
  private playcount = this.data.playcount;
  private lastSaved = -1;
  private counted = false;
  private started = false;

  async ngAfterViewInit(): Promise<void> {
    const video = this.videoRef.nativeElement;
    try {
      const imported: any = await import('mpegts.js');
      const mpegts = imported.default || imported;
      if (!mpegts?.isSupported?.()) {
        this.error.set('This browser can’t play recordings (no Media Source support). Open it in VLC instead.');
        return;
      }
      this.player = mpegts.createPlayer(
        { type: 'mpegts', isLive: false, url: this.tvh.getRecordingStreamUrl(this.data.uuid, { includeAuth: false }) },
        { enableWorker: true, headers: this.tvh.getStreamRequestHeaders() },
      );
      this.player.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number; msg?: string }) => {
        const text = `${type} ${detail} ${info?.msg ?? ''}`.toLowerCase();
        if (text.includes('ac-3') || text.includes('ac3')) {
          this.error.set('This recording’s sound is Dolby AC-3, which browsers can’t play. Open it in VLC, or watch it on the TV app.');
        } else if (text.includes('codec') || text.includes('unsupported')) {
          this.error.set('This recording uses a format browsers can’t play (often MPEG-2 video from antenna channels). Open it in VLC, or watch it on the TV app.');
        } else if (info?.code === 401 || info?.code === 403) {
          this.error.set('Tvheadend won’t let this account play recordings (Users & access → streaming / video recorder).');
        } else {
          this.error.set(`The browser couldn’t play this recording (${detail || type}). Open it in VLC instead.`);
        }
      });
      this.player.attachMediaElement(video);
      this.player.load();
      video.play()?.catch(() => this.note.set('Press play to start.'));
    } catch {
      this.error.set('The browser player didn’t load. Open the recording in VLC instead.');
    }
  }

  onMetadata(): void {
    if (this.started) return;
    this.started = true;
    const video = this.videoRef.nativeElement;
    const start = this.data.startSeconds;
    if (start >= MIN_SECONDS && (!isFinite(video.duration) || start < video.duration - END_SECONDS)) {
      try { video.currentTime = start; } catch { /* not seekable yet: plays from the start */ }
      this.note.set(`Resumed at ${clock(start)}. Where you stop is remembered, here and on the TV.`);
    }
  }

  onEnded(): void {
    this.finish();
  }

  /** Save the position in Tvheadend: every 30 s of change, and always on pause / close. */
  save(force: boolean): void {
    const video = this.videoRef?.nativeElement;
    if (!video || !this.started) return;
    const pos = video.currentTime || 0;
    const dur = isFinite(video.duration) ? video.duration : 0;
    if (video.ended || (dur > 0 && pos > dur - END_SECONDS)) return this.finish();
    if (pos < MIN_SECONDS) return;
    if (!force && this.lastSaved >= 0 && Math.abs(pos - this.lastSaved) < SAVE_EVERY) return;
    this.lastSaved = pos;
    this.tvh.setRecordingPlayState(this.data.uuid, this.playcount, Math.round(pos)).subscribe({ error: () => {} });
  }

  /** Played to the end: count it once and clear the resume point. */
  private finish(): void {
    if (this.counted) return;
    this.counted = true;
    this.playcount += 1;
    this.lastSaved = 0;
    this.tvh.setRecordingPlayState(this.data.uuid, this.playcount, 0).subscribe({ error: () => {} });
  }

  openInVlc(): void {
    this.tvh.fetchRecordingPlaylist(this.data.uuid, this.data.title).subscribe({
      next: text => {
        const url = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(this.data.title || 'recording').replace(/[^\w .-]+/g, '_')}.m3u`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      },
      error: err => this.snack.open(`Couldn’t get the recording’s playlist (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
    });
  }

  ngOnDestroy(): void {
    this.save(true);
    try {
      this.player?.pause?.();
      this.player?.unload?.();
      this.player?.detachMediaElement?.();
      this.player?.destroy?.();
    } catch { /* already gone */ }
    this.player = null;
  }
}

function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
