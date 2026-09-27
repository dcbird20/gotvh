import { Observable, concat, forkJoin, of } from 'rxjs';
import { catchError, last, map, switchMap } from 'rxjs/operators';
import { TvheadendService } from '@gotvh/tvh-api';

/**
 * Antenna, cable and satellite channels bring their own guide in the broadcast (ATSC PSIP, DVB EIT).
 * Tvheadend links it to channels through their services, so nothing needs mapping — the grabber
 * just has to be on. This switches on the right one and starts a grab.
 *
 * Catch: an over-the-air grab only visits muxes a grabber has already "registered", and a grabber
 * registers a mux only when it sees guide tables while that mux is tuned (psip.c / eit.c). Muxes
 * scanned while the grabber was off are unknown to it, so "Run over-the-air grab" does nothing.
 * So we tune those muxes once (a rescan) with the grabber on, and start the grab after that.
 */

/** Seconds to leave for the rescans before the grab starts. */
const PRIME_DELAY = 90;
export type Broadcast = 'atsc' | 'dvb';

export interface OtaGuideResult {
  /** Grabbers switched on now, e.g. "PSIP: ATSC Grabber". */
  enabled: string[];
  /** Grabbers that were already on. */
  alreadyOn: string[];
  /** Whether an over-the-air grab was started (or scheduled). */
  started: boolean;
  /** Muxes rescanned so the grabber sees them. */
  primed: number;
}

/**
 * Rescan the given muxes (so the grabbers register them), then start an over-the-air grab once
 * the rescans have had time to run.
 */
export function primeAndGrab(tvh: TvheadendService, muxUuids: string[]): Observable<{ primed: number; started: boolean }> {
  const ids = [...new Set(muxUuids)].slice(0, 64);
  const scans = ids.map(id => tvh.idnodeSave(id, { scan_state: 1 }).pipe(map(() => 1), catchError(() => of(0))));
  return (scans.length ? forkJoin(scans) : of([] as number[])).pipe(
    switchMap(ok => {
      const primed = ok.reduce((a: number, b: number) => a + b, 0);
      return tvh.triggerOtaEpgGrab(primed ? PRIME_DELAY : 1).pipe(map(() => ({ primed, started: true })), catchError(() => of({ primed, started: false })));
    }),
  );
}

/** Enabled, non-IPTV muxes that feed at least one channel — the ones worth grabbing guide data from. */
export function broadcastMuxesWithChannels(tvh: TvheadendService): Observable<string[]> {
  return forkJoin({
    muxes: tvh.getGrid('mpegts/mux/grid', { limit: 100000 }).pipe(catchError(() => of([] as any[]))),
    networks: tvh.getGrid('mpegts/network/grid').pipe(catchError(() => of([] as any[]))),
  }).pipe(map(({ muxes, networks }) => {
    const iptv = new Set(networks.filter((n: any) => 'max_streams' in n).map((n: any) => String(n.uuid)));
    const on = (v: any) => v === true || v === 1 || v === '1' || v === 'true' || v === undefined;
    return muxes
      .filter((m: any) => !iptv.has(String(m.network_uuid || '')) && !('iptv_url' in m) && on(m.enabled) && Number(m.num_chn) > 0)
      .map((m: any) => String(m.uuid));
  }));
}

const moduleOn = (r: any) => /enabled/i.test(String(r?.status || '')) || r?.enabled === true || r?.enabled === 1;

export function enableOtaGuide(tvh: TvheadendService, kinds: Set<Broadcast>, muxUuids: string[] = []): Observable<OtaGuideResult> {
  if (!kinds.size) return of({ enabled: [], alreadyOn: [], started: false, primed: 0 });
  return tvh.getGrid('epggrab/module/list').pipe(
    catchError(() => of([] as any[])),
    switchMap(mods => {
      const wanted = mods.filter((m: any) => {
        const t = String(m?.title || m?.name || '');
        return (kinds.has('atsc') && /psip/i.test(t)) || (kinds.has('dvb') && /EIT: DVB Grabber/i.test(t));
      });
      const off = wanted.filter((m: any) => !moduleOn(m));
      const alreadyOn = wanted.filter(moduleOn).map(titleOf);
      const saves = off.map((m: any) => tvh.idnodeSave(String(m.uuid), { enabled: 1 }).pipe(map(() => titleOf(m)), catchError(() => of(null))));
      const enabled: string[] = [];
      return (saves.length ? concat(...saves).pipe(map(t => { if (t) enabled.push(t); }), last(null, null)) : of(null)).pipe(
        switchMap(() => (enabled.length || alreadyOn.length)
          ? primeAndGrab(tvh, muxUuids)
          : of({ primed: 0, started: false })),
        map(r => ({ enabled, alreadyOn, ...r })),
      );
    }),
  );
}

/** Friendly name for a grabber module ("Over-the-air: PSIP: PSIP: ATSC Grabber" → "ATSC PSIP"). */
function titleOf(m: any): string {
  const t = String(m?.title || m?.name || '');
  if (/psip/i.test(t)) return 'ATSC PSIP';
  if (/EIT: DVB/i.test(t)) return 'DVB EIT';
  return t.replace(/^Over-the-air:\s*/i, '') || 'grabber';
}
