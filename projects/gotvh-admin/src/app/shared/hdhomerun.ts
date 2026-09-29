import { Injectable, inject } from '@angular/core';
import { Observable, concat, forkJoin, from, of } from 'rxjs';
import { catchError, last, map, switchMap } from 'rxjs/operators';
import { TvheadendService } from '@gotvh/tvh-api';

/**
 * Sharing an HDHomeRun with other servers and apps.
 *
 * Tvheadend asks an HDHomeRun for a *specific* tuner. If another client (a second Tvheadend,
 * the HDHomeRun app, Plex…) holds that tuner, the request fails ("failed to acquire lockkey"),
 * Tvheadend reports "tuning failed", and a scan marks the frequency FAIL at once and hands the
 * same busy tuner the next frequency. One busy tuner can empty most of a scan.
 *
 * The HDHomeRun reports which of its tuners are in use (status.json), so before scanning we switch
 * off, in Tvheadend, the tuners someone else is using, and switch them back on afterwards.
 */

/** Tvheadend names its HDHomeRun tuners "HDHomeRun ATSC-T Tuner #0 (192.168.1.54)". */
export function parseHdhrTuner(name: string): { ip: string; index: number } | null {
  const m = /HDHomeRun.*#(\d+)\s*\((\d{1,3}(?:\.\d{1,3}){3})\)/i.exec(name || '');
  return m ? { ip: m[2], index: Number(m[1]) } : null;
}

export interface HdhrTunerUse {
  index: number;
  busy: boolean;
  /** Who the tuner is streaming to, e.g. "192.168.1.72". */
  target?: string;
  /** What it is tuned to, e.g. "10.1 WTAJ-HD" or a frequency. */
  what?: string;
}

export interface HdhrDevice {
  ip: string;
  model?: string;
  tunerCount?: number;
  tuners: HdhrTunerUse[];
}

export interface TunerRef { uuid: string; name: string }

export interface GuardReport {
  /** Devices we could read; empty when the HDHomeRun couldn't be reached from the browser. */
  devices: HdhrDevice[];
  /** HDHomeRun tuners Tvheadend has, that we couldn't read the status of. */
  unreachable: string[];
  /** Tvheadend tuners currently switched off because someone else is using them. */
  held: Array<TunerRef & { by: string }>;
  /** Tuners left for this scan. */
  free: TunerRef[];
}

/**
 * Tuners we switched off are remembered in the browser, so if the page is closed mid-scan the next
 * visit to Add a source switches them back on (see restore()).
 */
const HELD_KEY = 'gotvh_admin_hdhr_held';
function loadHeld(): Array<[string, string]> {
  try { return Object.entries(JSON.parse(localStorage.getItem(HELD_KEY) || '{}')); } catch { return []; }
}
function saveHeld(m: Map<string, string>): void {
  try { m.size ? localStorage.setItem(HELD_KEY, JSON.stringify(Object.fromEntries(m))) : localStorage.removeItem(HELD_KEY); } catch { /* ignore */ }
}

@Injectable({ providedIn: 'root' })
export class HdhrGuard {
  private readonly tvh = inject(TvheadendService);
  /** uuid → name of tuners this app switched off, so they can be switched back on. */
  private readonly disabled = new Map<string, string>(loadHeld());

  /** GET a JSON file from the device: directly (HDHomeRuns allow it), else via the /hdhr/<ip>/ proxy. */
  private getJson(ip: string, file: string): Observable<any> {
    const tryUrl = (url: string) => from(fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then(r => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }));
    return tryUrl(`http://${ip}/${file}`).pipe(catchError(() => tryUrl(`/hdhr/${ip}/${file}`)));
  }

  device(ip: string): Observable<HdhrDevice | null> {
    return forkJoin({
      discover: this.getJson(ip, 'discover.json').pipe(catchError(() => of(null))),
      status: this.getJson(ip, 'status.json'),
    }).pipe(
      map(({ discover, status }) => {
        const rows: any[] = Array.isArray(status) ? status : [];
        const tuners = rows.map(r => {
          const index = Number(/(\d+)$/.exec(String(r?.Resource || ''))?.[1] ?? -1);
          // An idle tuner is just { Resource: "tuner1" }.
          const busy = !!(r?.TargetIP || r?.Frequency || r?.VctNumber || r?.ChannelNumber);
          const what = [r?.VctNumber, r?.VctName].filter(Boolean).join(' ')
            || (r?.Frequency ? `${(Number(r.Frequency) / 1e6).toFixed(3)} MHz` : '');
          return { index, busy, target: r?.TargetIP ? String(r.TargetIP) : undefined, what: what || undefined };
        }).filter(t => t.index >= 0);
        return {
          ip,
          model: discover?.FriendlyName || discover?.ModelNumber || undefined,
          tunerCount: Number(discover?.TunerCount) || tuners.length || undefined,
          tuners,
        } as HdhrDevice;
      }),
      catchError(() => of(null)),
    );
  }

  /**
   * Look at the HDHomeRun tuners among `tuners`: switch off (in Tvheadend) the ones someone else is
   * using, switch back on the ones we switched off earlier that are free again. Tuners Tvheadend is
   * using itself (live TV, a recording) are never touched.
   */
  prepare(tuners: TunerRef[]): Observable<GuardReport> {
    const hd = tuners.map(t => ({ ...t, hw: parseHdhrTuner(t.name) })).filter(t => !!t.hw);
    const ips = [...new Set(hd.map(t => t.hw!.ip))];
    const empty: GuardReport = { devices: [], unreachable: [], held: [], free: tuners };
    if (!ips.length) return of(empty);

    return forkJoin({
      devices: forkJoin(ips.map(ip => this.device(ip))),
      ours: this.tvh.getInputStatus().pipe(catchError(() => of([]))),
    }).pipe(switchMap(({ devices, ours }) => {
      const byIp = new Map(devices.filter((d): d is HdhrDevice => !!d).map(d => [d.ip, d]));
      // A busy tuner's status entry has the tuning's uuid, not the tuner's — so match names too.
      // status/inputs lists idle tuners too (subs 0, no stream): only busy ones count as ours.
      const tvhUsing = new Set(ours.filter((s: any) => Number(s?.subs) > 0 || !!s?.stream)
        .flatMap((s: any) => [String(s?.uuid || ''), String(s?.input || '')]));
      const toDisable: Array<TunerRef & { by: string }> = [];
      const toEnable: TunerRef[] = [];
      for (const t of hd) {
        const use = byIp.get(t.hw!.ip)?.tuners.find(u => u.index === t.hw!.index);
        if (!use) continue;
        const external = use.busy && !tvhUsing.has(t.uuid) && !tvhUsing.has(t.name);
        if (external && !this.disabled.has(t.uuid)) toDisable.push({ uuid: t.uuid, name: t.name, by: use.target || 'another app' });
        if (!use.busy && this.disabled.has(t.uuid)) toEnable.push(t);
      }
      const saves = [
        ...toDisable.map(t => this.tvh.idnodeSave(t.uuid, { enabled: false }).pipe(map(() => { this.disabled.set(t.uuid, t.name); saveHeld(this.disabled); }))),
        ...toEnable.map(t => this.tvh.idnodeSave(t.uuid, { enabled: true }).pipe(map(() => { this.disabled.delete(t.uuid); saveHeld(this.disabled); }))),
      ].map(o => o.pipe(catchError(() => of(null))));
      return (saves.length ? concat(...saves).pipe(last(null, null)) : of(null)).pipe(map(() => {
        const held = hd.filter(t => this.disabled.has(t.uuid)).map(t => {
          const use = byIp.get(t.hw!.ip)?.tuners.find(u => u.index === t.hw!.index);
          return { uuid: t.uuid, name: t.name, by: use?.target || 'another app' };
        });
        return {
          devices: [...byIp.values()],
          unreachable: ips.filter(ip => !byIp.has(ip)),
          held,
          free: tuners.filter(t => !this.disabled.has(t.uuid)),
        } as GuardReport;
      }));
    }));
  }

  /**
   * All of Tvheadend's HDHomeRun tuners: switch off the ones another app or server holds, and back on
   * the ones that are free again. Tvheadend keeps retrying a locked tuner ("resource locked by …")
   * instead of moving on to a free tuner or an IPTV fallback, so a held tuner silences whole channels.
   */
  holdBusyTuners(): Observable<GuardReport> {
    return this.tvh.idnodeLoadByClass('mpegts_input').pipe(
      map(list => list.map(e => {
        const name = String((e.params || []).find(p => p.id === 'displayname')?.value || e.text || '');
        return { uuid: String(e.uuid || e.id || ''), name };
      }).filter(t => !!parseHdhrTuner(t.name))),
      switchMap(tuners => this.prepare(tuners)),
      catchError(() => of({ devices: [], unreachable: [], held: [], free: [] } as GuardReport)),
    );
  }

  /** Switch back on every tuner this app switched off. */
  restore(): Observable<void> {
    const ids = [...this.disabled.keys()];
    if (!ids.length) return of(undefined);
    return concat(...ids.map(uuid => this.tvh.idnodeSave(uuid, { enabled: true }).pipe(
      map(() => { this.disabled.delete(uuid); saveHeld(this.disabled); }), catchError(() => of(null))))).pipe(last(null, null), map(() => undefined));
  }

  get holding(): number { return this.disabled.size; }

  /** Stop tracking held tuners (they were switched off on purpose, so don't switch them back on). */
  forgetAll(): void {
    this.disabled.clear();
    saveHeld(this.disabled);
  }
}
