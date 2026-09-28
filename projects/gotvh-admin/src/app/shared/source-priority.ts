import { Observable, concat, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap, toArray } from 'rxjs/operators';
import { TvheadendService } from '@gotvh/tvh-api';

/**
 * Antenna first, IPTV as the fallback.
 *
 * When a channel has several services, Tvheadend ranks them by
 *   source priority (the tuner's Priority / Streaming priority, or for IPTV the network's)
 *   + the service's own Priority (−10..10)
 * and tries the next one if the first fails (service.c: service_instance_add / si_cmp).
 * Tuners and IPTV networks both default to 1, so an antenna+IPTV channel is a coin toss.
 * This raises broadcast tuners above every IPTV network — never lowering anything the
 * user set higher.
 */
export const BROADCAST_PRIORITY = 10;

export interface PriorityChange { uuid: string; name: string; from: number; to: number }

const num = (v: unknown, dflt: number) => (v === undefined || v === null || v === '' ? dflt : Number(v) || 0);

export function broadcastFirst(tvh: TvheadendService): Observable<PriorityChange[]> {
  return forkJoin({
    inputs: tvh.idnodeLoadByClass('mpegts_input').pipe(catchError(() => of([] as any[]))),
    networks: tvh.getGrid('mpegts/network/grid').pipe(catchError(() => of([] as any[]))),
  }).pipe(switchMap(({ inputs, networks }) => {
    const iptv = networks.filter((n: any) => 'max_streams' in n);
    if (!iptv.length) return of([] as PriorityChange[]);
    // Highest IPTV priority, for both normal and streaming use (streaming 0 = "use Priority").
    const iptvTop = Math.max(...iptv.map((n: any) => {
      const p = num(n.priority, 1), sp = num(n.spriority, 1);
      return Math.max(p, sp > 0 ? sp : p);
    }));
    const target = Math.max(BROADCAST_PRIORITY, iptvTop + 1);
    const changes: Array<PriorityChange & { conf: Record<string, number> }> = [];
    for (const e of inputs) {
      const v: Record<string, any> = {};
      for (const p of e.params || []) v[p.id] = p.value;
      const name = String(v['displayname'] || e.text || 'Tuner');
      if (/iptv/i.test(String(e.class || e.caption || '')) || /^iptv/i.test(name)) continue;
      if (!('priority' in v)) continue; // not a tuner with priorities
      const p = num(v['priority'], 1), sp = num(v['spriority'], 1);
      const conf: Record<string, number> = {};
      if (p <= iptvTop) conf['priority'] = target;
      // Streaming priority 0 means "same as Priority", which is covered above.
      if (sp > 0 && sp <= iptvTop) conf['spriority'] = target;
      if (Object.keys(conf).length) changes.push({ uuid: String(e.uuid || e.id), name, from: Math.min(p, sp > 0 ? sp : p), to: target, conf });
    }
    if (!changes.length) return of([] as PriorityChange[]);
    return concat(...changes.map(c => tvh.idnodeSave(c.uuid, c.conf).pipe(
      map((): PriorityChange | null => ({ uuid: c.uuid, name: c.name, from: c.from, to: c.to })),
      catchError(() => of(null))))).pipe(
      toArray(),
      map(saved => saved.filter((c): c is PriorityChange => !!c)),
    );
  }));
}

/** "HDHomeRun ATSC-T Tuner #0 (192.168.1.54)", … → "4 HDHomeRun tuners" style summary. */
export function describeChanges(ch: PriorityChange[]): string {
  if (!ch.length) return '';
  const names = ch.map(c => c.name);
  return ch.length <= 2 ? names.join(' and ') : `${ch.length} tuners`;
}
