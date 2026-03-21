import { Injectable } from '@angular/core';

export interface ReturnNavigationContext {
  source: 'epg' | 'channels' | 'home' | 'recordings';
  payload: Record<string, string | number | boolean | null | undefined>;
}

@Injectable({
  providedIn: 'root'
})
export class ReturnNavigationService {
  private readonly storagePrefix = 'gotvh.returnContext.';

  createToken(context: ReturnNavigationContext): string {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      sessionStorage.setItem(this.storagePrefix + token, JSON.stringify(context));
    } catch {
      // Ignore storage failures and return a token that simply won't resolve.
    }

    return token;
  }

  consumeToken(token: string): ReturnNavigationContext | null {
    const normalized = String(token || '').trim();
    if (!normalized) {
      return null;
    }

    try {
      const key = this.storagePrefix + normalized;
      const raw = sessionStorage.getItem(key);
      if (!raw) {
        return null;
      }

      sessionStorage.removeItem(key);
      const parsed = JSON.parse(raw);
      if (!parsed?.source || typeof parsed.payload !== 'object') {
        return null;
      }

      return parsed as ReturnNavigationContext;
    } catch {
      return null;
    }
  }
}