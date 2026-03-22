import { Injectable } from '@angular/core';

export interface RecordingPlaybackProgress {
  recordingRef: string;
  title: string;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

@Injectable({
  providedIn: 'root'
})
export class RecordingPlaybackProgressService {
  private readonly storagePrefix = 'gotvh_recording_progress:';

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
      localStorage.removeItem(key);
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