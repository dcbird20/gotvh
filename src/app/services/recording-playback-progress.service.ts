import { Injectable } from '@angular/core';
import { TvheadendService } from '@gotvh/tvh-api';
import { Observable } from 'rxjs';
import { take } from 'rxjs/operators';

/** rxjs 6 has no firstValueFrom. */
function firstValueFrom<T>(source: Observable<T>): Promise<T> {
  return source.pipe(take(1)).toPromise() as Promise<T>;
}

export interface RecordingPlaybackProgress {
  recordingRef: string;
  title: string;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

/** What Tvheadend has on the recording: times played to the end, and where to resume (seconds). */
export interface RecordingPlayState {
  playcount: number;
  playposition: number;
}

/**
 * Where you stopped in a recording, and whether you've watched it.
 *
 * Tvheadend is the source of truth: the recording's `playcount` and `playposition` fields, which
 * Kodi and the GoTVH TV app use as well — so you can start something in the browser and finish it
 * on the TV. This browser also keeps its own copy (localStorage), used only when the server has
 * nothing for the recording or won't store it.
 */
@Injectable({
  providedIn: 'root'
})
export class RecordingPlaybackProgressService {
  private readonly storagePrefix = 'gotvh_recording_progress:';
  /** Server state by DVR uuid, from the recordings list (or loaded for the player). */
  private readonly server = new Map<string, RecordingPlayState>();
  private lastPushed = new Map<string, number>();
  private saveFailed = false;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private tvh: TvheadendService) {}

  /** Remember the server's state for these recordings (call after loading a recordings list). */
  seed(entries: any[]): void {
    for (const entry of entries || []) {
      const uuid = String(entry?.uuid || '').trim();
      if (!uuid) {
        continue;
      }
      this.server.set(uuid, {
        playcount: Number(entry?.playcount || 0) || 0,
        playposition: Number(entry?.playposition || 0) || 0,
      });
    }
  }

  /**
   * Load one recording's state from Tvheadend ([fresh]: even if known, since another device may
   * have moved on). Waits for this browser's own pending save first, so it never reads back stale.
   */
  async load(uuid: string, fresh = false): Promise<RecordingPlayState | null> {
    const key = String(uuid || '').trim();
    if (!key) {
      return null;
    }
    await this.pending.get(key)?.catch(() => undefined);
    if (!fresh && this.server.has(key)) {
      return this.server.get(key)!;
    }
    try {
      const state = await firstValueFrom(this.tvh.getRecordingPlayState(key));
      this.server.set(key, state);
      return state;
    } catch {
      return null;
    }
  }

  state(uuid: string): RecordingPlayState | null {
    return this.server.get(String(uuid || '').trim()) ?? null;
  }

  isInProgress(uuid: string, recordingRef = ''): boolean {
    return this.resumeSeconds(uuid, recordingRef) > 0;
  }

  /** Played to the end (on any device) and not restarted since. */
  isWatched(uuid: string, recordingRef = ''): boolean {
    const s = this.state(uuid);
    return !!s && s.playcount > 0 && !this.isInProgress(uuid, recordingRef);
  }

  /** Where to resume, in seconds (0 = from the start). The server's position wins. */
  resumeSeconds(uuid: string, recordingRef = ''): number {
    const s = this.state(uuid);
    if (s && s.playposition > 0) {
      return s.playposition;
    }
    if (s && s.playcount > 0 && !this.saveFailed) {
      return 0;
    }
    return Number(this.get(recordingRef || uuid)?.positionSeconds || 0);
  }

  /** Save where playback is: in this browser now, in Tvheadend every [minGapSeconds] of change (or when forced). */
  savePosition(uuid: string, progress: RecordingPlaybackProgress, force = false, minGapSeconds = 30): void {
    this.save(progress);
    const key = String(uuid || '').trim();
    if (!key) {
      return;
    }
    const seconds = Math.round(progress.positionSeconds);
    const last = this.lastPushed.get(key);
    if (!force && last !== undefined && Math.abs(seconds - last) < minGapSeconds) {
      return;
    }
    const current = this.server.get(key) ?? { playcount: 0, playposition: 0 };
    this.push(key, current.playcount, seconds);
  }

  /** Played to the end: count it once and clear the resume point. */
  finished(uuid: string, recordingRef = '', alreadyCounted = false): void {
    this.clear(recordingRef || uuid);
    const key = String(uuid || '').trim();
    if (!key) {
      return;
    }
    const current = this.server.get(key) ?? { playcount: 0, playposition: 0 };
    if (alreadyCounted && current.playposition === 0) {
      return;
    }
    this.push(key, alreadyCounted ? Math.max(1, current.playcount) : current.playcount + 1, 0);
  }

  /** "Start over": the next play begins at 0, and the TV won't offer to resume either. */
  restart(uuid: string, recordingRef = ''): void {
    this.clear(recordingRef || uuid);
    const key = String(uuid || '').trim();
    const current = key ? this.server.get(key) : null;
    if (key && current && current.playposition > 0) {
      this.push(key, current.playcount, 0);
    }
  }

  /** Mark watched / unwatched from the list. Resolves once Tvheadend has it. */
  async markWatched(uuid: string, watched: boolean, recordingRef = ''): Promise<void> {
    const key = String(uuid || '').trim();
    const current = this.server.get(key) ?? { playcount: 0, playposition: 0 };
    this.clear(recordingRef || key);
    await firstValueFrom(this.tvh.markRecordingWatched(key, watched, current.playcount));
    this.server.set(key, { playcount: watched ? Math.max(1, current.playcount) : 0, playposition: 0 });
  }

  private push(uuid: string, playcount: number, playposition: number): void {
    this.server.set(uuid, { playcount, playposition });
    this.lastPushed.set(uuid, playposition);
    const done = firstValueFrom(this.tvh.setRecordingPlayState(uuid, playcount, playposition)).then(
      () => { this.saveFailed = false; },
      () => { this.saveFailed = true; }, // this browser's copy still has it
    );
    this.pending.set(uuid, done);
  }

  // ------------------------------------------------------------------ this browser's copy

  get(recordingRef: string): RecordingPlaybackProgress | null {
    const key = this.getStorageKey(recordingRef);
    if (!key || typeof localStorage === 'undefined') {
      return null;
    }

    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<RecordingPlaybackProgress>;
      const positionSeconds = Number(parsed.positionSeconds || 0);
      const durationSeconds = Number(parsed.durationSeconds || 0);
      if (!positionSeconds || positionSeconds < 1) {
        return null;
      }

      return {
        recordingRef: String(parsed.recordingRef || recordingRef).trim(),
        title: String(parsed.title || '').trim(),
        positionSeconds,
        durationSeconds,
        updatedAt: Number(parsed.updatedAt || Date.now())
      };
    } catch {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return null;
    }
  }

  save(progress: RecordingPlaybackProgress): void {
    const key = this.getStorageKey(progress.recordingRef);
    if (!key || typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.setItem(key, JSON.stringify({
        recordingRef: progress.recordingRef,
        title: progress.title,
        positionSeconds: Math.max(0, Math.round(progress.positionSeconds)),
        durationSeconds: Math.max(0, Math.round(progress.durationSeconds)),
        updatedAt: progress.updatedAt || Date.now()
      }));
    } catch {
      // Ignore quota and serialization failures for non-critical resume state.
    }
  }

  clear(recordingRef: string): void {
    const key = this.getStorageKey(recordingRef);
    if (!key || typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage failures for non-critical resume state.
    }
  }

  private getStorageKey(recordingRef: string): string {
    const normalizedRef = String(recordingRef || '').trim();
    if (!normalizedRef) {
      return '';
    }

    return this.storagePrefix + normalizedRef;
  }
}
