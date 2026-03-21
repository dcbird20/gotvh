import { Injectable } from '@angular/core';

interface CachedEnvelope<T> {
  value: T;
  expiresAt: number;
}

@Injectable({
  providedIn: 'root'
})
export class ViewStateCacheService {
  private readonly storagePrefix = 'gotvh.viewCache.';
  private readonly ttlMs = 10 * 60 * 1000;
  private cache = new Map<string, unknown>();

  set<T>(key: string, value: T): void {
    const normalized = String(key || '').trim();
    if (!normalized) {
      return;
    }

    const envelope: CachedEnvelope<T> = {
      value,
      expiresAt: Date.now() + this.ttlMs
    };

    this.cache.set(normalized, value);

    try {
      sessionStorage.setItem(this.storagePrefix + normalized, JSON.stringify(envelope));
    } catch {
      // Ignore storage quota and availability failures.
    }
  }

  get<T>(key: string): T | null {
    const normalized = String(key || '').trim();
    if (!normalized) {
      return null;
    }

    if (this.cache.has(normalized)) {
      return this.cache.get(normalized) as T;
    }

    try {
      const raw = sessionStorage.getItem(this.storagePrefix + normalized);
      if (!raw) {
        return null;
      }

      const envelope = JSON.parse(raw) as CachedEnvelope<T>;
      if (!envelope || typeof envelope !== 'object' || envelope.expiresAt <= Date.now()) {
        sessionStorage.removeItem(this.storagePrefix + normalized);
        return null;
      }

      this.cache.set(normalized, envelope.value);
      return envelope.value;
    } catch {
      return null;
    }
  }
}