import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { TvheadendService } from '@gotvh/tvh-api';

/**
 * Channel names from services — shared by Map services and the Channels "fix names" helper.
 *
 * Streams re-muxed by FFmpeg all call themselves "Service01" (provider "FFmpeg"); IPTV playlists
 * often use long names like "PA | Johnstown | ABC WATM", and their mux names can share a playlist id
 * prefix ("vYSe42W83QyE - Fox Sports 2").
 */

/** Names compare without case, spaces or punctuation: "WPSU-HD" ~ "wpsu hd". */
export const nameKey = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Names that say nothing: "Service01", "Service 1", "Program 3" (FFmpeg and some encoders' defaults). */
export const isPlaceholder = (n: string) => /^(service|program|programme|channel)\s*0*\d+$/i.test(n.trim());

/** Drop a trailing "HD", "SD", "UHD", "4K". */
export const tidy = (n: string) => n.replace(/[\s-]*(hd|sd|uhd|4k)$/i, '').trim() || n;

/** "PA | Johnstown | ABC WATM" → "ABC WATM": keep the last part of a " | "-separated name. */
export function shorten(n: string): string {
  const parts = n.split(/\s+\|\s+/).map(p => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : n.trim();
}
export const canShorten = (n: string) => /\s\|\s/.test(n);

/** Shared leading text of all names, cut back to a " - " / " | " / ": " separator (e.g. a playlist id "vYSe42W83QyE - "). */
export function commonPrefix(names: string[]): string {
  if (names.length < 2) return '';
  let p = names[0];
  for (const n of names) { while (p && !n.startsWith(p)) p = p.slice(0, -1); }
  let cut = 0;
  for (const sep of [' - ', ' | ', ': ']) {
    const at = p.lastIndexOf(sep);
    if (at >= 0) cut = Math.max(cut, at + sep.length);
  }
  return p.slice(0, cut);
}

/**
 * Best name for a service: the playlist's service name, else the broadcast name unless it's a
 * placeholder, else the mux name minus the prefix every mux on its network shares.
 */
export function bestName(opts: { playlistName?: string; serviceName?: string; muxName?: string; muxPrefix?: string }): string {
  const mux = String(opts.muxName || '');
  const fromMux = mux.slice((opts.muxPrefix || '').length).trim() || mux;
  return [opts.playlistName?.trim(), opts.serviceName?.trim(), fromMux].find(n => n && !isPlaceholder(n)) || '';
}

// ------------------------------------------------------------------ fixing existing channels


export interface NameFix {
  uuid: string;
  number: string;
  current: string;
  /** Name from the playlist / broadcast, for placeholder names. */
  fromSource: string;
  kind: 'placeholder' | 'long';
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);

/**
 * Channels whose names say nothing ("Service01") or are long playlist names ("PA | Johnstown | …"),
 * with a better name taken from their services' playlist entries.
 */
export function findNameFixes(tvh: TvheadendService): Observable<NameFix[]> {
  return forkJoin({
    channels: tvh.getGrid('channel/grid', { all: 1, limit: 100000 }).pipe(catchError(() => of([] as any[]))),
    services: tvh.getGrid('mpegts/service/grid', { limit: 100000 }).pipe(catchError(() => of([] as any[]))),
    muxes: tvh.getGrid('mpegts/mux/grid', { limit: 100000 }).pipe(catchError(() => of([] as any[]))),
  }).pipe(map(({ channels, services, muxes }) => {
    const svc = new Map(services.map((s: any) => [String(s.uuid), s]));
    const mux = new Map(muxes.map((m: any) => [String(m.uuid), m]));
    const prefix = new Map<string, string>();
    const byNet = new Map<string, string[]>();
    for (const m of muxes) {
      const k = String(m.network_uuid || m.network || '');
      byNet.set(k, [...(byNet.get(k) || []), String(m.name || '')]);
    }
    for (const [k, names] of byNet) prefix.set(k, commonPrefix(names));
    const out: NameFix[] = [];
    for (const c of channels) {
      const current = String(c.name || '').trim();
      const placeholder = !current || isPlaceholder(current);
      if (!placeholder && !canShorten(current)) continue;
      let fromSource = '';
      if (placeholder) {
        for (const id of list(c.services)) {
          const s: any = svc.get(id);
          if (!s) continue;
          const m: any = mux.get(String(s.multiplex_uuid || ''));
          fromSource = bestName({
            playlistName: String(m?.iptv_sname || ''), serviceName: String(s.svcname || ''),
            muxName: String(m?.name || s.multiplex || ''), muxPrefix: prefix.get(String(m?.network_uuid || m?.network || '')) || '',
          });
          if (fromSource) break;
        }
        if (!fromSource) continue; // nothing better to offer
      }
      out.push({ uuid: String(c.uuid), number: c.number ? String(c.number) : '', current, fromSource, kind: placeholder ? 'placeholder' : 'long' });
    }
    return out.sort((a, b) => (parseFloat(a.number) || 1e9) - (parseFloat(b.number) || 1e9) || a.current.localeCompare(b.current));
  }));
}

/** The name a fix proposes, with or without shortening. */
export function proposedName(f: NameFix, shortenLong: boolean): string {
  const base = f.kind === 'placeholder' ? f.fromSource : f.current;
  return shortenLong ? shorten(base) : base;
}
