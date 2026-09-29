import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, take } from 'rxjs/operators';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { isPlaceholder } from './channel-naming';

/**
 * Channel health: find enabled channels that have nothing to play, and the feeds that should be
 * behind them.
 *
 * A channel plays one of its services. When those services are deleted (a rescan, a playlist that
 * renamed its entries, a network that was removed and re-added) or all switched off, the channel
 * stays in the list, keeps its number, guide and recordings — and Tvheadend answers every attempt to
 * watch it with "No service assigned to channel" (HTTP 502). Meanwhile the same station usually sits
 * on another channel, often a disabled duplicate made by a later scan or playlist import.
 *
 * Stations are recognised by call sign (WATM), or by major number plus network (23 + ABC).
 */

export type HealthProblem = 'no-services' | 'deleted' | 'switched-off';

export interface FeedCandidate {
  serviceUuid: string;
  /** "ABC" / "ABC WATM". */
  serviceName: string;
  network: string;
  iptv: boolean;
  /** Frequency or playlist entry, for telling feeds apart. */
  mux: string;
  /** Other channels using this service now. */
  onChannels: Array<{ uuid: string; name: string; number: string; enabled: boolean }>;
  /** Why we think this is the same station. */
  reason: 'call sign' | 'number and network';
}

export interface ChannelIssue {
  uuid: string;
  name: string;
  number: string;
  problem: HealthProblem;
  candidates: FeedCandidate[];
  /** Disabled channels for the same station with nothing else on them: safe to remove once repaired. */
  duplicates: Array<{ uuid: string; name: string; number: string; services: string[]; epggrab: string[] }>;
  hasGuide: boolean;
}

export interface HealthReport {
  issues: ChannelIssue[];
  channelCount: number;
}

const BRANDS = ['ABC', 'CBS', 'NBC', 'FOX', 'PBS', 'CW', 'MNT', 'MYTV', 'ION', 'UNIVISION', 'TELEMUNDO', 'UNIMAS'];
const NOT_CALLSIGNS = new Set(['WEST', 'WORLD', 'WILD', 'KIDS', 'KIDZ', 'WXYZ']);

export interface StationId { callsigns: Set<string>; major: string | null; minor: string | null; brands: Set<string> }

/** "PA | Johnstown | ABC WATM", number 23 → { WATM }, 23, { ABC }. "23.1 ABC" → {}, 23, { ABC }. */
export function stationId(name: string, number?: unknown, minorHint?: unknown): StationId {
  const up = String(name || '').toUpperCase();
  const words = up.split(/[^A-Z0-9.]+/).filter(Boolean);
  const callsigns = new Set<string>();
  for (const w of words) {
    const m = /^([KW][A-Z]{2,3})(?:DT|LD|LP|CD|CA|TV|HD)?\d*$/.exec(w);
    if (m && !NOT_CALLSIGNS.has(m[1]) && !BRANDS.includes(m[1])) callsigns.add(m[1]);
  }
  const brands = new Set(words.filter(w => BRANDS.includes(w)));
  const numMatch = /^(\d{1,3})(?:[.\-](\d{1,3}))?$/.exec(String(number ?? '').trim());
  let major = numMatch && numMatch[1] !== '0' ? numMatch[1] : null;
  let minor = major ? numMatch?.[2] ?? null : null;
  // A number in the name only counts when it looks like a channel ("23.1 ABC").
  if (!major) {
    const m = /(?:^|\s)(\d{1,2})[.\-](\d{1,2})(?:\s|$)/.exec(up);
    if (m) { major = m[1]; minor = m[2]; }
  }
  if (!minor && minorHint != null && String(minorHint) !== '' && String(minorHint) !== '0') minor = String(minorHint);
  return { callsigns, major, minor, brands };
}

/** Same station? Call sign beats everything; otherwise the major number and network must both agree. */
export function sameStation(a: StationId, b: StationId): FeedCandidate['reason'] | null {
  // One call sign covers a station's sub-channels (23.1 ABC, 23.2 MeTV): those must line up.
  // A channel without a sub-channel number ("23") means the main one (.1).
  if (a.major && b.major && a.major === b.major && (a.minor ?? '1') !== (b.minor ?? '1')) return null;
  if (a.brands.size && b.brands.size && ![...a.brands].some(x => b.brands.has(x))) return null;
  for (const c of a.callsigns) if (b.callsigns.has(c)) return 'call sign';
  if (a.callsigns.size && b.callsigns.size) return null; // both named, different stations
  if (a.major && a.major === b.major && [...a.brands].some(x => b.brands.has(x))) return 'number and network';
  return null;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const on = (v: unknown) => truthy(v) || v === 'true';

export function checkChannelHealth(tvh: TvheadendService): Observable<HealthReport> {
  return forkJoin({
    channels: tvh.getGrid('channel/grid', { all: 1, limit: 100000 }),
    // Default view: only services Tvheadend would use (verified, on enabled muxes and networks).
    usable: tvh.getGrid('mpegts/service/grid', { limit: 100000 }),
    // Everything, to tell "deleted" from "switched off".
    every: tvh.getGrid('mpegts/service/grid', { limit: 100000, hidemode: 'none' }).pipe(catchError(() => of([] as any[]))),
    networks: tvh.getGrid('mpegts/network/grid').pipe(catchError(() => of([] as any[]))),
  }).pipe(map(({ channels, usable, every, networks }) => {
    const iptvNets = new Set(networks.filter((n: any) => 'max_streams' in n).map((n: any) => String(n.networkname || '')));
    const usableIds = new Set(usable.filter((s: any) => on(s.enabled)).map((s: any) => String(s.uuid)));
    const exists = new Set([...every, ...usable].map((s: any) => String(s.uuid)));

    const byService = new Map<string, any[]>();
    for (const ch of channels) for (const s of list(ch.services)) {
      if (!byService.has(s)) byService.set(s, []);
      byService.get(s)!.push(ch);
    }
    const num = (ch: any) => (ch?.number === 0 || ch?.number === '0' || ch?.number == null) ? '' : String(ch.number);

    // What each usable service is: its own name, and the names/numbers of channels it was mapped to.
    const feeds = usable.filter((s: any) => usableIds.has(String(s.uuid))).map((s: any) => {
      const uuid = String(s.uuid);
      const owners = byService.get(uuid) || [];
      const ids = [stationId(String(s.svcname || ''), s.lcn, s.lcn_minor), ...owners.map(o => stationId(String(o.name || ''), o.number))];
      return { s, uuid, owners, ids };
    });

    const issues: ChannelIssue[] = [];
    for (const ch of channels) {
      if (!on(ch.enabled)) continue;
      const services = list(ch.services);
      if (services.some(s => usableIds.has(s))) continue;
      const problem: HealthProblem = !services.length ? 'no-services'
        : services.every(s => !exists.has(s)) ? 'deleted' : 'switched-off';
      const me = stationId(String(ch.name || ''), ch.number);
      const candidates: FeedCandidate[] = [];
      for (const f of feeds) {
        let reason: FeedCandidate['reason'] | null = null;
        for (const id of f.ids) {
          const r = sameStation(me, id);
          if (r === 'call sign') { reason = r; break; }
          reason = reason || r;
        }
        if (!reason) continue;
        candidates.push({
          serviceUuid: f.uuid,
          // "Service01" says nothing; show the channel it's on, or its playlist entry.
          serviceName: !isPlaceholder(String(f.s.svcname || '')) && f.s.svcname ? String(f.s.svcname)
            : String(f.owners.find(o => on(o.enabled))?.name || f.s.multiplex || f.s.svcname || f.uuid),
          network: String(f.s.network || ''),
          iptv: iptvNets.has(String(f.s.network || '')),
          mux: String(f.s.multiplex || ''),
          onChannels: f.owners.filter(o => String(o.uuid) !== String(ch.uuid))
            .map(o => ({ uuid: String(o.uuid), name: String(o.name || ''), number: num(o), enabled: on(o.enabled) })),
          reason,
        });
      }
      // Antenna first, then call-sign matches, then by name.
      const rank = (a: FeedCandidate, b: FeedCandidate) => Number(a.iptv) - Number(b.iptv)
        || Number(b.reason === 'call sign') - Number(a.reason === 'call sign')
        || Number(b.onChannels.some(o => !o.enabled)) - Number(a.onChannels.some(o => !o.enabled));
      // One feed per source is enough; keep the best match from each network.
      candidates.sort(rank);
      const seenNet = new Set<string>();
      const best = candidates.filter(c => !seenNet.has(c.network) && !!seenNet.add(c.network));
      candidates.length = 0; candidates.push(...best);
      candidates.sort((a, b) => Number(a.iptv) - Number(b.iptv)
        || Number(b.reason === 'call sign') - Number(a.reason === 'call sign')
        || a.serviceName.localeCompare(b.serviceName));

      // Disabled channels for this station whose feeds are all among the candidates (or that have none).
      const candIds = new Set(candidates.map(c => c.serviceUuid));
      const duplicates = channels.filter((o: any) => String(o.uuid) !== String(ch.uuid) && !on(o.enabled)
        // An orphan's number may be junk ("23.1 ABC" numbered 16), so its name alone also counts.
        && (!!sameStation(me, stationId(String(o.name || ''), o.number))
          || (!list(o.services).length && !!sameStation(me, stationId(String(o.name || '')))))
        && list(o.services).every(s => candIds.has(s) || !usableIds.has(s)))
        .map((o: any) => ({ uuid: String(o.uuid), name: String(o.name || ''), number: num(o), services: list(o.services), epggrab: list(o.epggrab) }));

      issues.push({ uuid: String(ch.uuid), name: String(ch.name || ''), number: num(ch), problem, candidates, duplicates,
        hasGuide: list(ch.epggrab).length > 0 });
    }
    issues.sort((a, b) => Number(b.candidates.length > 0) - Number(a.candidates.length > 0) || a.name.localeCompare(b.name));
    return { issues, channelCount: channels.length };
  }));
}

export function describeProblem(p: HealthProblem): string {
  switch (p) {
    case 'no-services': return 'No feed is linked to it';
    case 'deleted': return 'Its feed was removed (rescan or playlist change)';
    case 'switched-off': return 'Its feed is switched off or no longer found';
  }
}

// ---------------------------------------------------------------- playback test

export type PlaybackVerdict = 'plays' | 'silent' | 'source-silent' | 'disabled' | 'no-service' | 'busy' | 'auth' | 'unreachable';

export interface PlaybackResult {
  verdict: PlaybackVerdict;
  bytes: number;
  seconds: number;
  /** Plain explanation. */
  message: string;
  /** The channel on the same source we compared with. */
  sibling?: { name: string; bytes: number };
}

/**
 * Play a channel for a few seconds and say what happened. When nothing arrives, play another
 * channel from the same source to tell "this stream is dead" from "the whole source is down".
 */
export async function testPlayback(tvh: TvheadendService, channel: { uuid: string; services?: string[] }, seconds = 7): Promise<PlaybackResult> {
  const r = await tvh.probeChannel(channel.uuid, seconds * 1000);
  const base = { bytes: r.bytes, seconds };
  if (r.bytes > 0) {
    const rate = r.bytes / seconds / 1e6;
    return { ...base, verdict: 'plays', message: `Plays — ${rate >= 0.1 ? rate.toFixed(1) + ' MB/s' : Math.round(r.bytes / 1024) + ' KB in ' + seconds + ' s'} received.` };
  }
  switch (r.status) {
    case 401: return { ...base, verdict: 'auth', message: 'Tvheadend refused the sign-in for streaming. Sign in again, or give this account streaming rights.' };
    case 403: return { ...base, verdict: 'disabled', message: 'Tvheadend won’t stream it: the channel is disabled, or this account isn’t allowed to watch it.' };
    case 502: return { ...base, verdict: 'no-service', message: 'Nothing is linked to this channel that Tvheadend can use. Run the channel check to relink it.' };
    case 503: return { ...base, verdict: 'busy', message: 'No free tuner or stream slot: everything is in use (recordings, other viewers, or the IPTV stream limit).' };
    case 0: return { ...base, verdict: 'unreachable', message: 'Couldn’t reach Tvheadend’s stream.' };
  }
  // Connected but silent: compare with another channel on the same source.
  const sibling = await findSibling(tvh, channel).catch(() => null);
  if (sibling) {
    const s = await tvh.probeChannel(sibling.uuid, seconds * 1000);
    if (s.bytes > 0) {
      return { ...base, verdict: 'silent', sibling: { name: sibling.name, bytes: s.bytes },
        message: `Nothing arrived in ${seconds} s, but ${sibling.name} on the same source plays. The provider isn’t sending this stream — the entry is dead or moved. Link another feed for this station, or refresh the playlist.` };
    }
    return { ...base, verdict: 'source-silent', sibling: { name: sibling.name, bytes: 0 },
      message: `Nothing arrived in ${seconds} s, and ${sibling.name} on the same source is silent too. The source itself isn’t delivering (provider down, account expired, or out of connections).` };
  }
  return { ...base, verdict: 'silent', message: `Tvheadend accepted the request, but nothing arrived in ${seconds} s.` };
}

async function findSibling(tvh: TvheadendService, channel: { uuid: string; services?: string[] }): Promise<{ uuid: string; name: string } | null> {
  const [channels, services] = await Promise.all([
    firstValueFrom(tvh.getGrid('channel/grid', { limit: 100000 })),
    firstValueFrom(tvh.getGrid('mpegts/service/grid', { limit: 100000 })),
  ]);
  const me = channels.find((c: any) => String(c.uuid) === channel.uuid);
  const mine = list(channel.services?.length ? channel.services : me?.services);
  const netOf = new Map(services.map((s: any) => [String(s.uuid), String(s.network || '')]));
  const muxOf = new Map(services.map((s: any) => [String(s.uuid), String(s.multiplex_uuid || s.multiplex || '')]));
  const myNets = new Set(mine.map(s => netOf.get(s)).filter(Boolean));
  const myMuxes = new Set(mine.map(s => muxOf.get(s)).filter(Boolean));
  if (!myNets.size) return null;
  // Same network, different stream (another mux) — a different playlist entry for IPTV.
  const other = channels.find((c: any) => String(c.uuid) !== channel.uuid && on(c.enabled)
    && list(c.services).some(s => myNets.has(netOf.get(s) || '') && !myMuxes.has(muxOf.get(s) || '')));
  return other ? { uuid: String(other.uuid), name: String(other.name || 'another channel') } : null;
}

/** First value as a promise (this rxjs predates firstValueFrom). Rejects if it completes empty. */
export function firstValueFrom<T>(o: Observable<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let got = false;
    o.pipe(take(1)).subscribe({ next: v => { got = true; resolve(v); }, error: reject, complete: () => { if (!got) reject(new Error('no value')); } });
  });
}
