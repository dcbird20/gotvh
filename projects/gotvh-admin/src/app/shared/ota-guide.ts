import { Observable, concat, of } from 'rxjs';
import { catchError, last, map, switchMap } from 'rxjs/operators';
import { TvheadendService } from '@gotvh/tvh-api';

/**
 * Antenna, cable and satellite channels bring their own guide in the broadcast (ATSC PSIP, DVB EIT).
 * Tvheadend links it to channels through their services, so nothing needs mapping — the grabber
 * just has to be on. This switches on the right one and starts a grab.
 */
export type Broadcast = 'atsc' | 'dvb';

export interface OtaGuideResult {
  /** Grabbers switched on now, e.g. "PSIP: ATSC Grabber". */
  enabled: string[];
  /** Grabbers that were already on. */
  alreadyOn: string[];
  /** Whether an over-the-air grab was started. */
  started: boolean;
}

const moduleOn = (r: any) => /enabled/i.test(String(r?.status || '')) || r?.enabled === true || r?.enabled === 1;

export function enableOtaGuide(tvh: TvheadendService, kinds: Set<Broadcast>): Observable<OtaGuideResult> {
  if (!kinds.size) return of({ enabled: [], alreadyOn: [], started: false });
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
          ? tvh.triggerOtaEpgGrab(1).pipe(map(() => true), catchError(() => of(false)))
          : of(false)),
        map(started => ({ enabled, alreadyOn, started })),
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
