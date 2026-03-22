import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BehaviorSubject, from, Observable, of, throwError } from 'rxjs';
import { catchError, map, shareReplay, switchMap, take } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export type RecordingScheduleMethod = 'event' | 'manual';

export interface RecordingScheduleResult {
  method: RecordingScheduleMethod;
  dvrUuid: string;
  response: any;
}

export interface TvheadendAuthDialogState {
  open: boolean;
  reason: string;
}

export interface TvheadendAuthState {
  authenticated: boolean;
  username: string;
}

@Injectable({
  providedIn: 'root'
})
export class TvheadendService {
  private readonly authStorageKey = 'gotvh_tvh_basic_auth';
  private apiBase = this.resolveApiBase();
  private browserStreamBase = this.resolveBrowserStreamBase();
  private streamBase = this.resolveStreamBase();
  private xmltvBase = this.resolveXmltvBase();
  private readonly streamProfile = this.resolveStreamProfile();
  private readonly nativeBufferedPlayback = this.resolveNativeBufferedPlayback();
  private readonly nativeAllowLiveFallback = this.resolveNativeAllowLiveFallback();
  private readonly nativePlaybackBackend = this.resolveNativePlaybackBackend();
  private authHeader: string | null = null;
  private authCredentials: { username: string; password: string } | null = null;
  private channelGrid$: Observable<any[]> | null = null;
  private epg$: Observable<any[]> | null = null;
  private xmltv$: Observable<any> | null = null;
  private dvrConfigUuid$: Observable<string> | null = null;
  private authRequestResolver: ((value: boolean) => void) | null = null;

  readonly authDialogState$ = new BehaviorSubject<TvheadendAuthDialogState>({
    open: false,
    reason: ''
  });

  readonly authState$ = new BehaviorSubject<TvheadendAuthState>({
    authenticated: false,
    username: ''
  });

  constructor(private http: HttpClient) {
    this.restoreStoredAuth();
  }

  private resolveApiBase(): string {
    const env: any = environment;

    if (env.apiUrl) {
      return env.apiUrl.replace(/\/+$/, '');
    }

    const protocol = env.apiProtocol || 'http';
    const host = env.apiHost || 'localhost';
    const port = env.apiPort;

    let url = `${protocol}://${host}`;
    if (port && !((protocol === 'http' && port === 80) || (protocol === 'https' && port === 443))) {
      url += `:${port}`;
    }

    return url;
  }

  private resolveStreamBase(): string {
    const env: any = environment;
    if (env.streamUrl) {
      return env.streamUrl.replace(/\/+$/, '');
    }

    // Stream endpoints live outside /api in TVHeadend.
    const base = this.apiBase.replace(/\/api\/?$/, '');

    // mpegts.js uses a Web Worker that cannot resolve relative URLs.
    // Ensure the base is always absolute so worker fetch() calls succeed.
    if (base && !base.startsWith('http')) {
      return window.location.origin + base;
    }
    if (!base) {
      return window.location.origin;
    }
    return base;
  }

  private resolveBrowserStreamBase(): string {
    const base = this.apiBase.replace(/\/api\/?$/, '');

    if (base && !base.startsWith('http')) {
      return window.location.origin + base;
    }
    if (!base) {
      return window.location.origin;
    }
    return base;
  }

  private resolveXmltvBase(): string {
    const base = this.apiBase.replace(/\/api\/?$/, '');
    const xmltvBase = `${base}/xmltv`.replace(/\/+$/, '');

    if (xmltvBase && !xmltvBase.startsWith('http')) {
      return window.location.origin + xmltvBase;
    }
    if (!xmltvBase) {
      return `${window.location.origin}/xmltv`;
    }
    return xmltvBase;
  }

  private normalizeChannelIconUrl(rawUrl: string): string {
    const normalized = String(rawUrl || '').trim();
    if (!normalized) {
      return '';
    }

    try {
      const parsed = new URL(normalized, window.location.origin);

      if (parsed.origin === window.location.origin) {
        return parsed.toString();
      }

      const backendOrigin = new URL(this.streamBase, window.location.origin).origin;
      if (parsed.origin === backendOrigin && parsed.pathname.startsWith('/api/')) {
        return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }

      return '';
    } catch {
      if (normalized.startsWith('/api/')) {
        return `${window.location.origin}${normalized}`;
      }
      return '';
    }
  }

  private resolveStreamProfile(): string {
    const env: any = environment;
    return String(env.streamProfile || 'pass').trim() || 'pass';
  }

  private resolveNativeBufferedPlayback(): boolean {
    const env: any = environment;
    if (typeof env.nativeBufferedPlayback === 'boolean') {
      return env.nativeBufferedPlayback;
    }
    return true;
  }

  private resolveNativeAllowLiveFallback(): boolean {
    const env: any = environment;
    if (typeof env.nativeAllowLiveFallback === 'boolean') {
      return env.nativeAllowLiveFallback;
    }
    return false;
  }

  private resolveNativePlaybackBackend(): 'http' | 'kodi-htsp' {
    const env: any = environment;
    const backend = String(env.nativePlaybackBackend || 'http').trim().toLowerCase();
    return backend === 'kodi-htsp' ? 'kodi-htsp' : 'http';
  }

  private buildStreamUrl(streamRoot: string, channelId: string, options?: { buffered?: boolean; playlist?: boolean }): string {
    const normalizedChannelId = String(channelId || '').trim();
    let streamPath = 'stream/channel';
    if (options?.buffered && options?.playlist) {
      streamPath = 'play/playlist/channel';
    } else if (options?.buffered) {
      streamPath = 'play/stream/channel';
    } else if (options?.playlist) {
      streamPath = 'playlist/channel';
    }
    const baseUrl = `${streamRoot}/${streamPath}/${encodeURIComponent(normalizedChannelId)}`;

    try {
      const parsed = new URL(baseUrl, window.location.origin);
      if (!parsed.searchParams.has('profile')) {
        parsed.searchParams.set('profile', this.streamProfile);
      }
      return parsed.toString();
    } catch {
      const joiner = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${joiner}profile=${encodeURIComponent(this.streamProfile)}`;
    }
  }

  setBasicAuth(username: string, password: string): void {
    const normalizedUsername = String(username || '').trim();
    const normalizedPassword = String(password || '');
    if (!normalizedUsername || !normalizedPassword) {
      return;
    }

    const token = btoa(`${normalizedUsername}:${normalizedPassword}`);
    this.authHeader = `Basic ${token}`;
    this.authCredentials = {
      username: normalizedUsername,
      password: normalizedPassword
    };
    this.resetCachedRequests();
    this.persistAuth();
    this.publishAuthState();
  }

  clearAuth(): void {
    this.authHeader = null;
    this.authCredentials = null;
    this.resetCachedRequests();
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(this.authStorageKey);
    }
    this.publishAuthState();
  }

  getAuthHeader(): string | null {
    return this.authHeader;
  }

  getStreamRequestHeaders(): Record<string, string> {
    if (!this.authHeader) {
      return {};
    }

    return {
      Authorization: this.authHeader
    };
  }

  hasStoredAuth(): boolean {
    return !!this.authCredentials?.username && !!this.authCredentials?.password;
  }

  getStoredUsername(): string {
    return this.authCredentials?.username || '';
  }

  ensureBasicAuth(reason = 'Enter your TVHeadend credentials to continue.'): Promise<boolean> {
    if (this.hasStoredAuth()) {
      return Promise.resolve(true);
    }

    if (this.authRequestResolver) {
      return Promise.resolve(false);
    }

    this.authDialogState$.next({ open: true, reason });
    return new Promise<boolean>(resolve => {
      this.authRequestResolver = resolve;
    });
  }

  submitBasicAuth(username: string, password: string): boolean {
    const normalizedUsername = String(username || '').trim();
    const normalizedPassword = String(password || '');
    if (!normalizedUsername || !normalizedPassword) {
      return false;
    }

    this.setBasicAuth(normalizedUsername, normalizedPassword);
    this.resolveAuthRequest(true);
    return true;
  }

  cancelBasicAuthRequest(): void {
    this.resolveAuthRequest(false);
  }

  openAuthDialog(reason = 'Enter your TVHeadend credentials to continue.'): void {
    if (this.authDialogState$.value.open) {
      return;
    }

    this.authDialogState$.next({ open: true, reason });
  }

  private restoreStoredAuth(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      const raw = localStorage.getItem(this.authStorageKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (parsed?.username && parsed?.password) {
        this.setBasicAuth(parsed.username, parsed.password);
      }
    } catch {
      this.clearAuth();
    }
  }

  private persistAuth(): void {
    if (typeof localStorage === 'undefined' || !this.authCredentials) {
      return;
    }

    localStorage.setItem(this.authStorageKey, JSON.stringify(this.authCredentials));
  }

  private buildAuthenticatedUrl(url: string): string {
    if (!this.authCredentials) {
      return url;
    }

    try {
      const parsed = new URL(url, window.location.origin);
      // Native Android media pipelines can ignore URL userinfo (user:pass@host).
      // TVHeadend also accepts query auth, which is more reliable for <video src>.
      parsed.searchParams.set('username', this.authCredentials.username);
      parsed.searchParams.set('password', this.authCredentials.password);
      return parsed.toString();
    } catch {
      return url;
    }
  }

  private publishAuthState(): void {
    this.authState$.next({
      authenticated: this.hasStoredAuth(),
      username: this.getStoredUsername()
    });
  }

  private resetCachedRequests(): void {
    this.channelGrid$ = null;
    this.epg$ = null;
    this.xmltv$ = null;
    this.dvrConfigUuid$ = null;
  }

  private resolveAuthRequest(value: boolean): void {
    const resolver = this.authRequestResolver;
    this.authRequestResolver = null;
    this.authDialogState$.next({ open: false, reason: '' });
    if (resolver) {
      resolver(value);
    }
  }

  private getRequestOptions() {
    let headers = new HttpHeaders();
    if (this.authHeader) {
      headers = headers.set('Authorization', this.authHeader);
    }
    return { headers, withCredentials: true };
  }

  private getAnonymousRequestOptions() {
    return {
      headers: new HttpHeaders(),
      withCredentials: false
    };
  }

  private getAnonymousRequestOptionsWithCredentials() {
    return {
      headers: new HttpHeaders(),
      withCredentials: true
    };
  }

  private parseServerInfoPayload(body: unknown): any {
    if (body && typeof body === 'object') {
      return body;
    }

    const text = String(body || '').trim();
    if (!text) {
      return null;
    }

    return JSON.parse(text);
  }

  private getFormRequestOptions() {
    let headers = new HttpHeaders({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' });
    if (this.authHeader) {
      headers = headers.set('Authorization', this.authHeader);
    }
    return { headers, withCredentials: true };
  }

  private buildFormBody(values: Record<string, any>): string {
    let params = new HttpParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') {
        return;
      }
      params = params.set(key, String(value));
    });
    return params.toString();
  }

  private buildUrl(path: string): string {
    const normalizedPath = path.replace(/^\/+/, '');
    return `${this.apiBase}/${normalizedPath}`;
  }

  private buildRecordingUrl(streamRoot: string, recordingRef: string): string {
    const normalizedRef = String(recordingRef || '').trim();
    if (!normalizedRef) {
      return '';
    }

    if (/^https?:\/\//i.test(normalizedRef)) {
      return normalizedRef;
    }

    const normalizedPath = normalizedRef.replace(/^\/+/, '');
    const dvrPath = normalizedPath.startsWith('dvrfile/')
      ? normalizedPath
      : `dvrfile/${encodeURIComponent(normalizedPath)}`;

    try {
      return new URL(dvrPath, `${streamRoot.replace(/\/+$/, '')}/`).toString();
    } catch {
      return `${streamRoot.replace(/\/+$/, '')}/${dvrPath}`;
    }
  }

  getChannels(): Observable<any[]> {
    const primary = this.buildUrl('channel/grid?start=0&limit=500');
    const fallback = this.buildUrl('channels');

    return this.http.get<any>(primary, this.getRequestOptions()).pipe(
      map(data => Array.isArray(data) ? data : data?.entries || []),
      catchError(error => {
        if (error.status === 404 || error.status === 0) {
          return this.http.get<any>(fallback, this.getRequestOptions()).pipe(
            map(data => Array.isArray(data) ? data : data?.entries || [])
          );
        }
        return throwError(error);
      })
    );
  }

  getChannelsWithResolvedTags(): Observable<any[]> {
    return this.getChannels().pipe(
      switchMap(channels => this.getChannelTags().pipe(
        map(tags => this.enrichChannelsWithResolvedTags(channels, tags)),
        catchError(() => of(this.enrichChannelsWithResolvedTags(channels, [])))
      ))
    );
  }

  getChannelTags(): Observable<any[]> {
    const primary = this.buildUrl('channeltag/grid?start=0&limit=9999');
    const fallback = this.buildUrl('channel/tag/grid?start=0&limit=9999');

    return this.http.get<any>(primary, this.getRequestOptions()).pipe(
      map(data => Array.isArray(data) ? data : data?.entries || []),
      catchError(error => {
        if (error.status === 404 || error.status === 0) {
          return this.http.get<any>(fallback, this.getRequestOptions()).pipe(
            map(data => Array.isArray(data) ? data : data?.entries || []),
            catchError(() => of([]))
          );
        }
        return of([]);
      })
    );
  }

  private enrichChannelsWithResolvedTags(channels: any[], tags: any[]): any[] {
    const tagMap = this.buildChannelTagMap(tags);
    return (channels || []).map(channel => {
      const resolvedTagNames = this.resolveChannelTagNames(channel, tagMap);
      return {
        ...channel,
        __resolvedTagNames: resolvedTagNames
      };
    });
  }

  private buildChannelTagMap(tags: any[]): Record<string, string> {
    const map: Record<string, string> = {};

    (tags || []).forEach(tag => {
      const name = String(tag?.name || tag?.title || tag?.val || tag?.tag || '').trim();
      if (!name) {
        return;
      }

      const candidateKeys = [
        tag?.uuid,
        tag?.id,
        tag?.key,
        tag?.index,
        tag?.number,
        tag?.identifier,
      ];

      candidateKeys.forEach(candidate => {
        if (candidate === null || candidate === undefined) {
          return;
        }

        const key = String(candidate).trim();
        if (!key) {
          return;
        }

        map[key] = name;
        map[key.toLowerCase()] = name;
      });
    });

    return map;
  }

  private resolveChannelTagNames(channel: any, tagMap: Record<string, string>): string[] {
    const rawValues = this.flattenTagSourceValues([
      channel?.__resolvedTagNames,
      channel?.tags,
      channel?.tag,
      channel?.channelTags,
      channel?.channeltags,
    ]);

    const names: string[] = [];
    rawValues.forEach(raw => {
      const key = String(raw || '').trim();
      if (!key) {
        return;
      }

      const resolved = tagMap[key] || tagMap[key.toLowerCase()] || '';
      if (resolved) {
        names.push(resolved);
      } else {
        names.push(key);
      }
    });

    return Array.from(new Set(names.map(name => String(name || '').trim()).filter(Boolean)));
  }

  private flattenTagSourceValues(value: any): string[] {
    if (value === null || value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return value.reduce((acc: string[], entry: any) => acc.concat(this.flattenTagSourceValues(entry)), []);
    }

    if (typeof value === 'object') {
      const preferred = [value.name, value.title, value.tag, value.uuid, value.id];
      const combined = preferred.concat(Object.values(value));
      return combined.reduce((acc: string[], entry: any) => acc.concat(this.flattenTagSourceValues(entry)), []);
    }

    const text = String(value).trim();
    if (!text) {
      return [];
    }

    if (text.includes(',') || text.includes(';')) {
      return text
        .split(/[;,]/)
        .map(item => item.trim())
        .filter(Boolean);
    }

    return [text];
  }

  getEpg(): Observable<any[]> {
    if (!this.epg$) {
      const primary = this.buildUrl('epg/events/grid?start=0&limit=2000');
      const fallback = this.buildUrl('epg/events/grid?start=0&limit=5000');

      this.epg$ = this.http.get<any>(primary, this.getRequestOptions()).pipe(
        map(data => Array.isArray(data) ? data : data?.entries || []),
        catchError(error => {
          if (error.status === 404 || error.status === 0) {
            return this.http.get<any>(fallback, this.getRequestOptions()).pipe(
              map(data => Array.isArray(data) ? data : data?.entries || []),
              catchError(fallbackError => {
                this.epg$ = null;
                return throwError(fallbackError);
              })
            );
          }

          this.epg$ = null;
          return throwError(error);
        }),
        shareReplay(1)
      );
    }

    return this.epg$;
  }

  scheduleRecordingByEvent(eventId: number): Observable<RecordingScheduleResult> {
    const normalizedEventId = Number(eventId || 0);
    if (!normalizedEventId) {
      return throwError(new Error('Missing TVHeadend event ID.'));
    }

    return this.getDefaultDvrConfigUuid().pipe(
      switchMap(configUuid => this.http.post<any>(
        this.buildUrl('dvr/entry/create_by_event'),
        this.buildFormBody({ event_id: normalizedEventId, config_uuid: configUuid }),
        this.getFormRequestOptions()
      )),
      map(response => this.toScheduleResult('event', response))
    );
  }

  getXmltv(): Observable<any> {
    if (!this.xmltv$) {
      const url = this.buildAuthenticatedUrl(`${this.xmltvBase}/channels`);
      this.xmltv$ = this.http.get(url, { ...this.getRequestOptions(), responseType: 'text' }).pipe(
        map((xmlString: string) => {
          const parser = new DOMParser();
          const xml = parser.parseFromString(xmlString, 'application/xml');

          const getByLocalName = (node: Element | Document, tagName: string): Element[] => {
            const all = Array.from(node.getElementsByTagName('*')) as Element[];
            return all.filter(el => (el.localName || '').toLowerCase() === tagName.toLowerCase());
          };

          const getFirstTagText = (node: Element, tagName: string): string => {
            const byLocalName = getByLocalName(node, tagName);
            if (byLocalName.length > 0 && byLocalName[0].textContent) {
              return byLocalName[0].textContent.trim();
            }
            const bySelector = node.querySelector(tagName);
            return (bySelector?.textContent || '').trim();
          };

          const getAllTagText = (node: Element, tagName: string): string[] => {
            const listByLocalName = getByLocalName(node, tagName);
            const list = listByLocalName.length > 0 ? listByLocalName : Array.from(node.querySelectorAll(tagName));
            return list
              .map(item => (item.textContent || '').trim())
              .filter(Boolean);
          };

          const channels: any[] = [];
          const channelNodes = getByLocalName(xml, 'channel');
          channelNodes.forEach(node => {
            const displayName = getFirstTagText(node, 'display-name');
            const iconNode = getByLocalName(node, 'icon')[0] || node.querySelector('icon');
            channels.push({
              id: node.getAttribute('id') || displayName || 'Unknown',
              name: displayName || node.getAttribute('id') || 'Unknown Channel',
              icon: this.normalizeChannelIconUrl(iconNode?.getAttribute('src') || '')
            });
          });

          const programmes: any[] = [];
          const programmeNodes = getByLocalName(xml, 'programme');
          programmeNodes.forEach(node => {
            const categories = getAllTagText(node, 'category');
            programmes.push({
              channel: node.getAttribute('channel') || '',
              start: node.getAttribute('start') || '',
              stop: node.getAttribute('stop') || '',
              title: getFirstTagText(node, 'title') || 'Untitled',
              desc: getFirstTagText(node, 'desc') || '',
              category: categories.length > 0 ? categories : ''
            });
          });

          return { channels, programmes };
        }),
        catchError(error => {
          this.xmltv$ = null;
          return throwError(error);
        }),
        shareReplay(1)
      );
    }

    return this.xmltv$;
  }

  preloadGuideData(): void {
    this.getXmltv().pipe(take(1)).subscribe({ error: () => undefined });
    this.getEpg().pipe(take(1)).subscribe({ error: () => undefined });
    this.getTvheadendChannelGrid().pipe(take(1)).subscribe({ error: () => undefined });
  }

  getChannelStreamUrl(channelId: string, options?: { proxied?: boolean; includeAuth?: boolean; buffered?: boolean; playlist?: boolean }): string {
    const streamRoot = options?.proxied ? this.browserStreamBase : this.streamBase;
    const streamUrl = this.buildStreamUrl(streamRoot, channelId, {
      buffered: !!options?.buffered,
      playlist: !!options?.playlist
    });

    if (options?.includeAuth === false) {
      return streamUrl;
    }

    return this.buildAuthenticatedUrl(streamUrl);
  }

  getRecordingStreamUrl(recordingRef: string, options?: { proxied?: boolean; includeAuth?: boolean }): string {
    const streamRoot = options?.proxied ? this.browserStreamBase : this.streamBase;
    const streamUrl = this.buildRecordingUrl(streamRoot, recordingRef);

    if (options?.includeAuth === false) {
      return streamUrl;
    }

    return this.buildAuthenticatedUrl(streamUrl);
  }

  shouldUseNativeBufferedPlayback(): boolean {
    return this.nativeBufferedPlayback;
  }

  shouldAllowNativeLiveFallback(): boolean {
    return this.nativeAllowLiveFallback;
  }

  shouldUseKodiHtspBackend(): boolean {
    return this.nativePlaybackBackend === 'kodi-htsp';
  }

  getHtspEndpoint(): { host: string; port: number } {
    try {
      const parsed = new URL(this.streamBase, window.location.origin);
      const host = parsed.hostname || '127.0.0.1';
      const port = parsed.port ? Number(parsed.port) : 9981;
      // HTSP typically runs on 9982.
      const htspPort = port === 9981 ? 9982 : port;
      return {
        host,
        port: Number.isFinite(htspPort) ? htspPort : 9982
      };
    } catch {
      return {
        host: '127.0.0.1',
        port: 9982
      };
    }
  }

  getStoredCredentials(): { username: string; password: string } | null {
    if (!this.authCredentials?.username || !this.authCredentials?.password) {
      return null;
    }

    return {
      username: this.authCredentials.username,
      password: this.authCredentials.password
    };
  }

  getTvheadendChannelGrid(): Observable<any[]> {
    if (!this.channelGrid$) {
      this.channelGrid$ = this.http
        .get<any>(this.buildUrl('channel/grid?start=0&limit=9999'), this.getRequestOptions())
        .pipe(
          map(data => Array.isArray(data) ? data : (data?.entries || [])),
          shareReplay(1),
          catchError(() => of([]))
        );
    }
    return this.channelGrid$;
  }

  resolveChannelStreamUrl(channelName: string): Observable<string> {
    return this.getTvheadendChannelGrid().pipe(
      map(channels => {
        const normalizedTarget = channelName.trim().toLowerCase();
        const match = channels.find(
          ch => (ch.name || '').trim().toLowerCase() === normalizedTarget
        );
        if (match?.uuid) {
          return this.buildAuthenticatedUrl(this.buildStreamUrl(this.streamBase, match.uuid));
        }
        // Fallback: partial name match
        const partial = channels.find(
          ch => (ch.name || '').trim().toLowerCase().includes(normalizedTarget)
            || normalizedTarget.includes((ch.name || '').trim().toLowerCase())
        );
        if (partial?.uuid) {
          return this.buildAuthenticatedUrl(this.buildStreamUrl(this.streamBase, partial.uuid));
        }
        return '';
      })
    );
  }

  scheduleRecording(channelName: string, startTimeMs: number, endTimeMs: number, title: string, description = '', preferredEventId?: number): Observable<RecordingScheduleResult> {
    const safeChannelName = String(channelName || '').trim();
    const safeTitle = String(title || 'Untitled').trim();
    const normalizedPreferredEventId = Number(preferredEventId || 0);

    if (normalizedPreferredEventId) {
      return this.scheduleRecordingByEvent(normalizedPreferredEventId).pipe(
        catchError(() => this.createManualRecording(safeChannelName, startTimeMs, endTimeMs, safeTitle, description))
      );
    }

    return this.resolveEpgEventId(safeChannelName, startTimeMs, endTimeMs, safeTitle).pipe(
      switchMap(eventId => {
        if (!eventId) {
          return this.createManualRecording(safeChannelName, startTimeMs, endTimeMs, safeTitle, description);
        }

        return this.scheduleRecordingByEvent(eventId).pipe(
          catchError(() => this.createManualRecording(safeChannelName, startTimeMs, endTimeMs, safeTitle, description))
        );
      }),
      catchError(() => this.createManualRecording(safeChannelName, startTimeMs, endTimeMs, safeTitle, description))
    );
  }

  cancelRecording(dvrUuid: string): Observable<any> {
    const normalizedUuid = String(dvrUuid || '').trim();
    if (!normalizedUuid) {
      return throwError(new Error('Missing DVR entry UUID.'));
    }

    return this.http.post<any>(
      this.buildUrl('dvr/entry/cancel'),
      this.buildFormBody({ uuid: normalizedUuid }),
      this.getFormRequestOptions()
    );
  }

  private createManualRecording(channelName: string, startTimeMs: number, endTimeMs: number, title: string, description = ''): Observable<RecordingScheduleResult> {
    return this.getTvheadendChannelGrid().pipe(
      switchMap(channels => {
        const normalizedTarget = String(channelName || '').trim().toLowerCase();
        const exact = channels.find(ch => (ch.name || '').trim().toLowerCase() === normalizedTarget);
        if (exact) {
          return of(exact);
        }

        const partial = channels.find(
          ch => (ch.name || '').trim().toLowerCase().includes(normalizedTarget)
            || normalizedTarget.includes((ch.name || '').trim().toLowerCase())
        );
        return of(partial || { name: String(channelName || '').trim(), uuid: '' });
      }),
      switchMap(channel => {
        const resolvedChannelName = String(channel?.name || channelName || '').trim();
        const resolvedChannelUuid = String(channel?.uuid || '').trim();
        if (!resolvedChannelName) {
          return throwError(new Error(`Could not resolve TVHeadend channel name for "${channelName}".`));
        }

        return this.getDefaultDvrConfigUuid().pipe(
          switchMap(configUuid => {
            const start = Math.floor(Number(startTimeMs) / 1000);
            const stop = Math.floor(Number(endTimeMs) / 1000);
            const safeTitle = String(title || 'Untitled').trim();
            const safeDescription = String(description || '').trim();
            const conf: any = {
              start,
              stop,
              config_name: configUuid,
              channelname: resolvedChannelName,
              title: { eng: safeTitle },
              comment: `Scheduled from EPG: ${safeTitle}`,
            };

            if (resolvedChannelUuid) {
              conf.channel = resolvedChannelUuid;
            }
            if (safeDescription) {
              conf.description = { eng: safeDescription };
            }

            return this.http.post<any>(
              this.buildUrl('dvr/entry/create'),
              this.buildFormBody({ conf: JSON.stringify(conf) }),
              this.getFormRequestOptions()
            ).pipe(
              map(response => this.toScheduleResult('manual', response))
            );
          })
        );
      })
    );
  }

  private resolveEpgEventId(channelName: string, startTimeMs: number, endTimeMs: number, title: string): Observable<number | null> {
    const normalizedChannel = String(channelName || '').trim();
    const normalizedTitle = String(title || '').trim();
    const expectedStart = Math.floor(Number(startTimeMs) / 1000);
    const expectedStop = Math.floor(Number(endTimeMs) / 1000);
    const url = this.buildUrl(
      `epg/events/grid?channel=${encodeURIComponent(normalizedChannel)}&title=${encodeURIComponent(normalizedTitle)}&fulltext=1&limit=200`
    );

    return this.http.get<any>(url, this.getRequestOptions()).pipe(
      map(data => Array.isArray(data) ? data : (data?.entries || [])),
      map(entries => {
        const exact = entries.find((entry: any) =>
          String(entry?.channelName || '').trim().toLowerCase() === normalizedChannel.toLowerCase()
          && String(entry?.title || '').trim().toLowerCase() === normalizedTitle.toLowerCase()
          && Number(entry?.start) === expectedStart
          && Number(entry?.stop) === expectedStop
        );
        if (exact?.eventId != null) {
          return Number(exact.eventId);
        }

        const nearMatch = entries.find((entry: any) => {
          const entryTitle = String(entry?.title || '').trim().toLowerCase();
          const entryChannel = String(entry?.channelName || '').trim().toLowerCase();
          const entryStart = Number(entry?.start || 0);
          const entryStop = Number(entry?.stop || 0);
          return entryTitle === normalizedTitle.toLowerCase()
            && entryChannel === normalizedChannel.toLowerCase()
            && Math.abs(entryStart - expectedStart) <= 300
            && Math.abs(entryStop - expectedStop) <= 300;
        });

        return nearMatch?.eventId != null ? Number(nearMatch.eventId) : null;
      }),
      catchError(() => of(null))
    );
  }

  private getDefaultDvrConfigUuid(): Observable<string> {
    if (!this.dvrConfigUuid$) {
      this.dvrConfigUuid$ = this.http.get<any>(this.buildUrl('dvr/config/grid'), this.getRequestOptions()).pipe(
        map(data => Array.isArray(data) ? data : (data?.entries || [])),
        map(entries => {
          const preferred = entries.find((entry: any) => String(entry?.name || '') === '') || entries[0];
          const uuid = String(preferred?.uuid || '').trim();
          if (!uuid) {
            throw new Error('Could not resolve DVR config UUID.');
          }
          return uuid;
        }),
        shareReplay(1)
      );
    }

    return this.dvrConfigUuid$;
  }

  getScheduledRecordings(): Observable<any[]> {
    const parseEntries = (data: any): any[] => Array.isArray(data) ? data : (data?.entries || data?.records || []);
    const request = (path: string) => this.http.get<any>(this.buildUrl(path), this.getRequestOptions()).pipe(
      map(parseEntries)
    );

    return request('dvr/entry/grid_upcoming?start=0&limit=1000').pipe(
      catchError(() => request('dvr/entry/grid?start=0&limit=1000')),
      catchError(() => of([]))
    );
  }

  getFinishedRecordings(): Observable<any[]> {
    const parseEntries = (data: any): any[] => Array.isArray(data) ? data : (data?.entries || data?.records || []);
    const request = (path: string) => this.http.get<any>(this.buildUrl(path), this.getRequestOptions()).pipe(
      map(parseEntries)
    );

    return request('dvr/entry/grid_finished?start=0&limit=500').pipe(
      catchError(() => of([]))
    );
  }

  getFailedRecordings(): Observable<any[]> {
    const parseEntries = (data: any): any[] => Array.isArray(data) ? data : (data?.entries || data?.records || []);
    return this.http.get<any>(this.buildUrl('dvr/entry/grid_failed?start=0&limit=500'), this.getRequestOptions()).pipe(
      map(parseEntries),
      catchError(() => of([]))
    );
  }

  getTimerecs(): Observable<any[]> {
    const parseEntries = (data: any): any[] => Array.isArray(data) ? data : (data?.entries || data?.records || []);
    return this.http.get<any>(this.buildUrl('dvr/timerec/grid?start=0&limit=1000'), this.getRequestOptions()).pipe(
      map(parseEntries),
      catchError(() => of([]))
    );
  }

  createTimerec(conf: any): Observable<any> {
    return this.http.post<any>(
      this.buildUrl('dvr/timerec/create'),
      this.buildFormBody({ conf: JSON.stringify(conf) }),
      this.getFormRequestOptions()
    );
  }

  saveTimerec(uuid: string, conf: any): Observable<any> {
    const node = { uuid: String(uuid || '').trim(), ...conf };
    return this.http.post<any>(
      this.buildUrl('idnode/save'),
      this.buildFormBody({ node: JSON.stringify(node) }),
      this.getFormRequestOptions()
    );
  }

  deleteTimerec(uuid: string): Observable<any> {
    const normalizedUuid = String(uuid || '').trim();
    if (!normalizedUuid) {
      return throwError(new Error('Missing timerec UUID.'));
    }
    return this.http.post<any>(
      this.buildUrl('idnode/delete'),
      this.buildFormBody({ uuid: normalizedUuid }),
      this.getFormRequestOptions()
    );
  }

  getServerInfo(): Observable<any> {
    const url = this.buildUrl('serverinfo');

    const anonymousRequest = this.http.get(url, {
      ...this.getAnonymousRequestOptions(),
      responseType: 'text'
    }).pipe(map(body => this.parseServerInfoPayload(body)));

    const anonymousWithCredentialsRequest = this.http.get(url, {
      ...this.getAnonymousRequestOptionsWithCredentials(),
      responseType: 'text'
    }).pipe(map(body => this.parseServerInfoPayload(body)));

    const authenticatedRequest = this.http.get(url, {
      ...this.getRequestOptions(),
      responseType: 'text'
    }).pipe(map(body => this.parseServerInfoPayload(body)));

    if (Capacitor.isNativePlatform()) {
      const nativeRequest = from(CapacitorHttp.get({
        url,
        headers: {},
        connectTimeout: 8000,
        readTimeout: 8000
      })).pipe(
        map(result => this.parseServerInfoPayload(result?.data))
      );

      return nativeRequest.pipe(
        catchError(() => anonymousRequest),
        catchError(() => anonymousWithCredentialsRequest),
        catchError(() => authenticatedRequest)
      );
    }

    return anonymousRequest.pipe(
      catchError(() => anonymousWithCredentialsRequest),
      catchError(() => authenticatedRequest)
    );
  }

  getSubscriptions(): Observable<any[]> {
    const parseEntries = (data: any): any[] => Array.isArray(data) ? data : (data?.entries || data?.subscriptions || []);
    return this.http.get<any>(this.buildUrl('status/subscriptions'), this.getRequestOptions()).pipe(
      map(parseEntries),
      catchError(() => of([]))
    );
  }

  getConnections(): Observable<any[]> {
    const parseEntries = (data: any): any[] => Array.isArray(data) ? data : (data?.entries || data?.connections || []);
    return this.http.get<any>(this.buildUrl('status/connections'), this.getRequestOptions()).pipe(
      map(parseEntries),
      catchError(() => of([]))
    );
  }

  removeRecording(dvrUuid: string): Observable<any> {
    const normalizedUuid = String(dvrUuid || '').trim();
    if (!normalizedUuid) {
      return throwError(new Error('Missing DVR entry UUID.'));
    }

    return this.http.post<any>(
      this.buildUrl('dvr/entry/remove'),
      this.buildFormBody({ uuid: normalizedUuid }),
      this.getFormRequestOptions()
    );
  }

  updateRecording(dvrUuid: string, changes: { disp_title?: string; start?: number; stop?: number }): Observable<any> {
    const normalizedUuid = String(dvrUuid || '').trim();
    if (!normalizedUuid) {
      return throwError(new Error('Missing DVR entry UUID.'));
    }

    const node: any = { uuid: normalizedUuid };
    if (changes.disp_title !== undefined) {
      node.disp_title = String(changes.disp_title || '').trim();
    }
    if (changes.start !== undefined) {
      node.start = Number(changes.start);
    }
    if (changes.stop !== undefined) {
      node.stop = Number(changes.stop);
    }

    return this.http.post<any>(
      this.buildUrl('idnode/save'),
      this.buildFormBody({ node: JSON.stringify(node) }),
      this.getFormRequestOptions()
    );
  }

  getDvrConfigs(): Observable<any[]> {
    return this.http.get<any>(this.buildUrl('dvr/config/grid'), this.getRequestOptions()).pipe(
      map(data => Array.isArray(data) ? data : (data?.entries || data?.records || [])),
      catchError(() => of([]))
    );
  }

  getAutorecs(): Observable<any[]> {
    const parseEntries = (data: any): any[] => Array.isArray(data)
      ? data
      : (data?.entries || []);
    const request = (path: string) => this.http.get<any>(this.buildUrl(path), this.getRequestOptions()).pipe(
      map(parseEntries)
    );

    // Mirror TVHeadend WebUI autorec editor fields and grid endpoint.
    const list = encodeURIComponent(
      'enabled,name,title,fulltext,mergetext,channel,tag,start,start_window,weekdays,'
      + 'minduration,maxduration,record,btype,content_type,cat1,cat2,cat3,star_rating,'
      + 'pri,dedup,directory,config_name,minseason,maxseason,minyear,maxyear,owner,creator,comment,'
      + 'serieslink,start_extra,stop_extra,retention,removal,maxcount,maxsched'
    );

    const gridPath = `dvr/autorec/grid?start=0&limit=1000&all=1&sort=name&dir=ASC&list=${list}`;
    const idnodePath = `idnode/load?class=dvrautorec&grid=1&list=${list}`;

    return request(gridPath).pipe(
      catchError(() => of<any[]>([])),
      switchMap(entries => {
        if (entries.length > 0) {
          return of(entries);
        }
        return request(idnodePath).pipe(catchError(() => of<any[]>([])));
      })
    );
  }

  createAutorec(conf: any): Observable<any> {
    return this.http.post<any>(
      this.buildUrl('dvr/autorec/create'),
      this.buildFormBody({ conf: JSON.stringify(conf) }),
      this.getFormRequestOptions()
    );
  }

  saveAutorec(uuid: string, conf: any): Observable<any> {
    const node = { uuid: String(uuid || '').trim(), ...conf };
    return this.http.post<any>(
      this.buildUrl('idnode/save'),
      this.buildFormBody({ node: JSON.stringify(node) }),
      this.getFormRequestOptions()
    );
  }

  deleteAutorec(uuid: string): Observable<any> {
    const normalizedUuid = String(uuid || '').trim();
    if (!normalizedUuid) {
      return throwError(new Error('Missing autorec UUID.'));
    }

    return this.http.post<any>(
      this.buildUrl('idnode/delete'),
      this.buildFormBody({ uuid: normalizedUuid }),
      this.getFormRequestOptions()
    );
  }

  private toScheduleResult(method: RecordingScheduleMethod, response: any): RecordingScheduleResult {
    return {
      method,
      dvrUuid: this.extractDvrUuid(response),
      response,
    };
  }

  private extractDvrUuid(response: any): string {
    if (!response) {
      return '';
    }

    if (typeof response === 'string') {
      return response.trim();
    }

    if (Array.isArray(response)) {
      const first = response[0];
      return typeof first === 'string' ? first.trim() : String(first?.uuid || '').trim();
    }

    const directUuid = String(response?.uuid || response?.id || '').trim();
    if (directUuid) {
      return directUuid;
    }

    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const firstEntry = entries[0];
    if (typeof firstEntry === 'string') {
      return firstEntry.trim();
    }
    if (firstEntry?.uuid) {
      return String(firstEntry.uuid).trim();
    }

    const records = Array.isArray(response?.records) ? response.records : [];
    const firstRecord = records[0];
    if (typeof firstRecord === 'string') {
      return firstRecord.trim();
    }

    return String(firstRecord?.uuid || '').trim();
  }
}