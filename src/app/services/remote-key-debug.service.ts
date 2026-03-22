import { Injectable } from '@angular/core';

export interface RemoteKeyDebugEntry {
  timestamp: string;
  source: string;
  route: string;
  action: string;
  key: string;
  code: string;
  keyCode: number;
}

@Injectable({
  providedIn: 'root'
})
export class RemoteKeyDebugService {
  private readonly maxEntries = 20;
  private readonly entries: RemoteKeyDebugEntry[] = [];
  private readonly actionMap: Record<string, { key: string; code: string; keyCode: number }> = {
    'dpad-up': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'dpad-down': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'dpad-left': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'dpad-right': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'select': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'back': { key: 'BrowserBack', code: 'BrowserBack', keyCode: 4 },
    'channel-up': { key: 'ChannelUp', code: '', keyCode: 33 },
    'channel-down': { key: 'ChannelDown', code: '', keyCode: 34 }
  };

  constructor() {
    if (typeof window !== 'undefined') {
      (window as any).__gotvhRemoteKeyDebug = {
        getSnapshot: () => this.getSnapshot(),
        clear: () => this.clear(),
        dispatch: (action: string) => this.dispatchAction(action),
        dispatchSequence: async (actions: string[], delayMs = 60) => this.dispatchSequence(actions, delayMs),
        supportedActions: Object.keys(this.actionMap)
      };
    }
  }

  captureEvent(event: KeyboardEvent, source: string, route: string): void {
    const normalized = this.normalizeEvent(event);
    if (!normalized) {
      return;
    }

    const entry: RemoteKeyDebugEntry = {
      timestamp: new Date().toISOString(),
      source,
      route,
      ...normalized
    };

    this.entries.unshift(entry);

    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }

    console.info(
      '[RemoteKeyDebug]',
      JSON.stringify({
        action: entry.action,
        key: entry.key,
        code: entry.code,
        keyCode: entry.keyCode,
        source: entry.source,
        route: entry.route
      })
    );
  }

  getSnapshot(): { lastEvent: RemoteKeyDebugEntry | null; recentEvents: RemoteKeyDebugEntry[] } {
    return {
      lastEvent: this.entries[0] || null,
      recentEvents: [...this.entries]
    };
  }

  clear(): void {
    this.entries.length = 0;
  }

  dispatchAction(action: string): boolean {
    const descriptor = this.actionMap[String(action || '').trim()];
    if (!descriptor || typeof document === 'undefined') {
      return false;
    }

    const target = (document.activeElement as HTMLElement | null) || document.body || document.documentElement || document;
    const event = new KeyboardEvent('keydown', {
      key: descriptor.key,
      code: descriptor.code,
      bubbles: true,
      cancelable: true
    });

    Object.defineProperty(event, 'keyCode', { value: descriptor.keyCode });
    Object.defineProperty(event, 'which', { value: descriptor.keyCode });

    target.dispatchEvent(event);
    return true;
  }

  async dispatchSequence(actions: string[], delayMs = 60): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const action of actions || []) {
      results.push(this.dispatchAction(action));
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(delayMs || 0))));
    }
    return results;
  }

  private normalizeEvent(event: KeyboardEvent): Omit<RemoteKeyDebugEntry, 'timestamp' | 'source' | 'route'> | null {
    const key = String(event.key || '').trim();
    const code = String((event as any).code || '').trim();
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);
    const action = this.classifyAction(key, code, keyCode);
    if (!action) {
      return null;
    }

    return {
      action,
      key,
      code,
      keyCode
    };
  }

  private classifyAction(key: string, code: string, keyCode: number): string | null {
    if (key === 'ArrowUp' || code === 'ArrowUp' || keyCode === 19 || keyCode === 38) {
      return 'dpad-up';
    }

    if (key === 'ArrowDown' || code === 'ArrowDown' || keyCode === 20 || keyCode === 40) {
      return 'dpad-down';
    }

    if (key === 'ArrowLeft' || code === 'ArrowLeft' || keyCode === 21 || keyCode === 37) {
      return 'dpad-left';
    }

    if (key === 'ArrowRight' || code === 'ArrowRight' || keyCode === 22 || keyCode === 39) {
      return 'dpad-right';
    }

    if (
      key === 'Enter'
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
      || keyCode === 66
      || keyCode === 160
    ) {
      return 'select';
    }

    if (
      key === 'BrowserBack'
      || key === 'GoBack'
      || key === 'Backspace'
      || key === 'Escape'
      || code === 'BrowserBack'
      || code === 'Escape'
      || keyCode === 4
      || keyCode === 8
      || keyCode === 27
      || keyCode === 461
      || keyCode === 10009
    ) {
      return 'back';
    }

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
      return 'channel-up';
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
      return 'channel-down';
    }

    return null;
  }
}