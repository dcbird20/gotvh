import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Observable, concat, forkJoin, of } from 'rxjs';
import { catchError, last, map, switchMap, tap } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { IdnodeOption, TvheadendService, isDeferredEnum, normalizeEnum, truthy } from '@gotvh/tvh-api';
import { GuardReport, HdhrGuard } from '../../shared/hdhomerun';
import { PriorityChange, broadcastFirst, describeChanges } from '../../shared/source-priority';

type Step = 'kind' | 'tuner' | 'iptv' | 'hdhr' | 'scan' | 'done';
type Kind = 'tuner' | 'iptv';

interface TunerChoice {
  uuid: string;
  name: string;
  caption: string;
  enabled: boolean;
  networks: string[];
  /** Delivery system from the tuner's type, e.g. "ATSC-T". */
  system: string;
  selected: boolean;
}

interface ScanState {
  muxes: number;
  scanned: number;
  ok: number;
  failed: number;
  pending: number;
  services: number;
  mapped: number;
  /** Muxes whose last scan failed (nothing received). */
  failedUuids: string[];
}

const SYSTEMS = ['ATSC-T', 'ATSC-C', 'DVB-T', 'DVB-C', 'DVB-S', 'ISDB-T', 'ISDB-C', 'ISDB-S', 'DAB', 'DTMB'];
/** "Linux DVB ATSC-T Frontend" / "ATSC-T Network" → "ATSC-T". */
const systemOf = (text: string) => SYSTEMS.find(s => text.toUpperCase().replace(/DVB-S2/, 'DVB-S').includes(s)) || '';
const on = (v: unknown) => v === undefined || truthy(v) || v === 'true';
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Guided "Add a source": the whole chain in one flow — tuner (or IPTV
 * playlist) → network → scan with progress → map services → guide data —
 * instead of five screens that assume you know how they fit together.
 */
@Component({
  selector: 'admin-add-source',
  standalone: true,
  imports: [
    FormsModule, RouterLink, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatIconModule, MatInputModule,
    MatProgressBarModule, MatRadioModule, MatSelectModule,
  ],
  templateUrl: './add-source.component.html',
  styleUrl: './add-source.component.scss',
})
export class AddSourceComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly guard = inject(HdhrGuard);

  readonly step = signal<Step>('kind');
  readonly kind = signal<Kind | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly plural = plural;

  // ---- data
  readonly tuners = signal<TunerChoice[]>([]);
  readonly builders = signal<Array<{ class: string; caption: string; system: string }>>([]);
  readonly networks = signal<Array<{ uuid: string; name: string }>>([]);
  readonly loaded = signal(false);

  // ---- tuner path
  readonly version = signal(0);
  networkMode: 'new' | 'existing' = 'new';
  networkClass = '';
  networkName = '';
  existingNetwork = '';
  readonly regions = signal<IdnodeOption[] | null>(null);
  readonly regionsLoading = signal(false);
  region = '';

  // ---- HDHomeRun
  hdhrIp = '';
  hdhrTunerCount = 2;
  /** null = unknown; false = this Tvheadend has no HDHomeRun support built in. */
  readonly hdhrSupported = signal<boolean | null>(null);
  readonly hdhrSearch = signal<'searching' | 'found' | 'notfound' | null>(null);

  // ---- IPTV path
  iptvName = 'IPTV';
  iptvUrl = '';
  iptvMaxStreams = 0;

  // ---- scan
  readonly networkUuid = signal<string | null>(null);
  readonly networkLabel = signal('');
  readonly scan = signal<ScanState | null>(null);
  readonly scanStarted = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly selectedTuners = computed(() => { this.version(); return this.tuners().filter(t => t.selected); });
  readonly tunerSystem = computed(() => {
    const systems = [...new Set(this.selectedTuners().map(t => t.system).filter(Boolean))];
    return systems.length === 1 ? systems[0] : '';
  });
  readonly hardwareTuners = computed(() => this.tuners().filter(t => !/iptv/i.test(`${t.caption} ${t.name}`)));

  readonly scanProgress = computed(() => {
    const s = this.scan();
    if (!s || !s.muxes) return null;
    return Math.round(s.scanned / s.muxes * 100);
  });
  readonly scanDone = computed(() => {
    const s = this.scan();
    return !!s && s.muxes > 0 && s.pending === 0 && Date.now() - this.scanStarted() > 4000;
  });

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => { this.stopPolling(); this.stopWaiting(); this.guard.restore().subscribe(); });
    // Tuners switched off for an earlier scan that didn't finish (page closed) go back on first.
    this.guard.restore().pipe(switchMap(() => forkJoin({
      inputs: this.tvh.idnodeLoadByClass('mpegts_input').pipe(catchError(() => of([]))),
      builders: this.tvh.getBuilders('mpegts/network').pipe(catchError(() => of([]))),
      networks: this.tvh.getGrid('mpegts/network/grid').pipe(catchError(() => of([]))),
    }))).subscribe(({ inputs, builders, networks }) => {
      this.applyInputs(inputs);
      this.builders.set(builders.map(b => ({ ...b, system: systemOf(b.caption) })));
      this.networks.set(networks.map((n: any) => ({ uuid: String(n.uuid), name: String(n.networkname || n.uuid) }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)));
      this.loaded.set(true);
    });
  }

  private applyInputs(inputs: any[]): void {
    this.tuners.set(inputs.map(e => {
      const v: Record<string, any> = {};
      for (const p of e.params || []) v[p.id] = p.value;
      const caption = String(e.caption || '');
      const name = String(v['displayname'] || e.text || 'Tuner');
      const nets = list(v['networks']);
      return { uuid: String(e.uuid || e.id), name, caption, enabled: on(v['enabled']), networks: nets,
        system: systemOf(`${caption} ${name}`), selected: false };
    }).sort((a, b) => a.name.localeCompare(b.name)));
    this.version.update(v => v + 1);
  }

  networkName$(uuid: string): string {
    return this.networks().find(n => n.uuid === uuid)?.name || 'a network';
  }

  // ---------------------------------------------------------------- step 1

  /** HDHomeRun tuners Tvheadend already knows. */
  readonly hdhrTuners = computed(() => { this.version(); return this.tuners().filter(t => /hdhomerun/i.test(`${t.caption} ${t.name}`)); });

  chooseHdhr(): void {
    this.kind.set('tuner');
    this.error.set('');
    this.step.set('hdhr');
    // Is this Tvheadend built with HDHomeRun support? Its settings then have "hdhomerun_ip".
    this.tvh.idnodeLoadSimple('config').pipe(catchError(() => of(null))).subscribe(cfg => {
      const ip = cfg?.params.find(p => p.id === 'hdhomerun_ip');
      this.hdhrSupported.set(cfg ? !!ip : null);
      if (ip?.value) this.hdhrIp = String(ip.value);
    });
  }

  /** Use the HDHomeRun tuners already found: continue with the tuner flow, only them ticked. */
  useHdhrTuners(): void {
    for (const t of this.tuners()) t.selected = this.hdhrTuners().includes(t);
    this.version.update(v => v + 1);
    this.onTunersChanged();
    this.step.set('tuner');
  }

  hdhrIpError(): string {
    const ip = this.hdhrIp.trim();
    if (!ip) return '';
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ? '' : 'Enter an IP address like 192.168.1.40.';
  }

  /**
   * Tell Tvheadend where the HDHomeRun is (needed when it runs in Docker without
   * host networking, or the device is on another subnet), then watch for its tuners.
   */
  searchHdhr(): void {
    if (!this.hdhrIp.trim() || this.hdhrIpError()) return;
    this.busy.set(true);
    this.error.set('');
    this.hdhrSearch.set('searching');
    this.tvh.idnodeSaveSimple('config', { hdhomerun_ip: this.hdhrIp.trim() }).subscribe({
      next: () => {
        const started = Date.now();
        const tick = () => this.tvh.idnodeLoadByClass('mpegts_input').pipe(catchError(() => of([]))).subscribe(inputs => {
          this.applyInputs(inputs);
          if (this.hdhrTuners().length) { this.busy.set(false); this.hdhrSearch.set('found'); return; }
          if (Date.now() - started > 45000) { this.busy.set(false); this.hdhrSearch.set('notfound'); return; }
          setTimeout(tick, 3000);
        });
        tick();
      },
      error: err => { this.busy.set(false); this.hdhrSearch.set(null); this.error.set(`Couldn’t save the address (${err?.status || 'network error'}).`); },
    });
  }

  /** Works with any HDHomeRun, even without Tvheadend's HDHomeRun support: its channel list as a playlist. */
  addHdhrAsIptv(): void {
    const ip = this.hdhrIp.trim();
    if (!ip || this.hdhrIpError()) return;
    this.kind.set('iptv');
    this.iptvName = 'HDHomeRun';
    this.iptvUrl = `http://${ip}/lineup.m3u`;
    this.iptvMaxStreams = Math.max(1, Number(this.hdhrTunerCount) || 2);
    this.startIptv();
  }

  chooseKind(kind: Kind): void {
    this.kind.set(kind);
    this.error.set('');
    if (kind === 'tuner') {
      // Preselect tuners that aren't used yet.
      for (const t of this.hardwareTuners()) t.selected = !t.networks.length;
      this.version.update(v => v + 1);
      this.onTunersChanged();
      this.step.set('tuner');
    } else {
      this.step.set('iptv');
    }
  }

  // ---------------------------------------------------------------- tuner path

  toggleTuner(t: TunerChoice, value: boolean): void {
    t.selected = value;
    this.version.update(v => v + 1);
    this.onTunersChanged();
  }

  /** Pick the network type matching the tuners, and a default name. */
  private onTunersChanged(): void {
    const system = this.tunerSystem();
    const match = this.builders().find(b => b.system && b.system === system);
    if (match && match.class !== this.networkClass) {
      this.networkClass = match.class;
      this.networkName = `${system} network`;
      this.loadRegions();
    }
  }

  onNetworkClassChange(): void {
    const b = this.builders().find(x => x.class === this.networkClass);
    if (b && (!this.networkName || / network$/.test(this.networkName))) this.networkName = `${b.system || b.caption.replace(/ network$/i, '')} network`;
    this.loadRegions();
  }

  /** Pre-defined mux lists ("United States: ATSC 8VSB") for the chosen network type. */
  private loadRegions(): void {
    this.region = '';
    this.regions.set(null);
    if (!this.networkClass) return;
    this.regionsLoading.set(true);
    this.tvh.idnodeClassByName(this.networkClass).pipe(
      switchMap(cls => {
        const prop = cls.params.find(p => p.id === 'scanfile');
        if (!prop?.enum) return of(null);
        return isDeferredEnum(prop.enum) ? this.tvh.idnodeEnumOptions(prop.enum) : of(normalizeEnum(prop.enum as any));
      }),
      catchError(() => of(null)),
    ).subscribe(options => {
      this.regionsLoading.set(false);
      this.regions.set(options);
      // Only one list (e.g. "United States: ATSC 8VSB")? Pick it.
      if (options?.length === 1) this.region = String(options[0].value);
      // US over-the-air: the ATSC channel-centre list is the right one (the NTSC-centre
      // list is for old analogue-offset tuning), so pre-pick it.
      const atsc = options?.find(o => /us-ATSC-center-frequencies-8VSB/i.test(String(o.value)));
      if (!this.region && atsc) this.region = String(atsc.value);
    });
  }

  canStartTuner(): boolean {
    if (!this.selectedTuners().length) return false;
    if (this.networkMode === 'existing') return !!this.existingNetwork;
    return !!this.networkClass && !!this.networkName.trim();
  }

  startTuner(): void {
    if (!this.canStartTuner()) return;
    this.busy.set(true);
    this.error.set('');
    const network$: Observable<string> = this.networkMode === 'existing'
      ? of(this.existingNetwork)
      : this.tvh.idnodeCreateWithClass('mpegts/network', this.networkClass, {
          networkname: this.networkName.trim(), ...(this.region ? { scanfile: this.region } : {}),
        }).pipe(map(res => {
          if (!res?.uuid) throw new Error('no uuid');
          return String(res.uuid);
        }));
    network$.pipe(
      // Enable each chosen tuner and add the network to it (keeping networks it already has).
      switchMap(net => concat(...this.selectedTuners().map(t =>
        this.tvh.idnodeSave(t.uuid, { enabled: true, networks: [...new Set([...t.networks, net])] }))).pipe(last(null, null), map(() => net))),
      // Antenna first: keep broadcast tuners above any IPTV network.
      switchMap(net => broadcastFirst(this.tvh).pipe(tap(ch => this.priority.set(ch)), map(() => net))),
      // Shared HDHomeRun: switch off the tuners someone else is using before scanning.
      switchMap(net => this.guard.prepare(this.selectedTuners()).pipe(tap(r => this.sharing.set(r)), map(() => net))),
    ).subscribe({
      next: net => {
        this.busy.set(false);
        const label = this.networkMode === 'existing' ? this.networkName$(net) : this.networkName.trim();
        this.pass.set(1);
        this.scanWhenFree(net, label);
      },
      error: err => {
        this.busy.set(false);
        this.error.set(`Couldn’t set it up (${err?.status || err?.message || 'network error'}). Nothing after the failed step was changed.`);
      },
    });
  }

  // ---------------------------------------------------------------- IPTV path

  iptvUrlError(): string {
    const u = this.iptvUrl.trim();
    if (!u) return '';
    return /^(https?|file|pipe):\/\//i.test(u) ? '' : 'Use an http://, https://, file:// or pipe:// address.';
  }

  /** The automatic IPTV network reads a playlist; the plain one needs muxes added by hand. */
  private iptvClass(): string {
    const b = this.builders();
    return b.find(x => x.class === 'iptv_auto_network')?.class || b.find(x => /iptv/i.test(x.class))?.class || 'iptv_auto_network';
  }

  startIptv(): void {
    if (!this.iptvUrl.trim() || this.iptvUrlError()) return;
    this.busy.set(true);
    this.error.set('');
    this.tvh.idnodeCreateWithClass('mpegts/network', this.iptvClass(), {
      networkname: this.iptvName.trim() || 'IPTV',
      url: this.iptvUrl.trim(),
      max_streams: Math.max(0, Number(this.iptvMaxStreams) || 0),
    }).subscribe({
      next: res => {
        this.busy.set(false);
        if (!res?.uuid) { this.error.set('Tvheadend didn’t create the network.'); return; }
        const net = String(res.uuid);
        this.tvh.scanNetwork(net).pipe(catchError(() => of(null))).subscribe();
        broadcastFirst(this.tvh).subscribe(ch => this.priority.set(ch));
        this.beginScan(net, this.iptvName.trim() || 'IPTV');
      },
      error: err => { this.busy.set(false); this.error.set(`Couldn’t create the IPTV network (${err?.status || 'network error'}).`); },
    });
  }

  // ---------------------------------------------------------------- scan

  private beginScan(network: string, label: string): void {
    this.networkUuid.set(network);
    this.networkLabel.set(label);
    this.scan.set(null);
    this.passDoneHandled = false;
    this.scanStarted.set(Date.now());
    this.step.set('scan');
    this.poll();
    this.timer = setInterval(() => this.poll(), 2000);
  }

  private poll(): void {
    const net = this.networkUuid();
    if (!net) return;
    const filter = JSON.stringify([{ type: 'string', field: 'network_uuid', value: net }]);
    forkJoin({
      net: this.tvh.idnodeValues([net], ['num_mux', 'num_svc', 'num_chn', 'scanq_length']).pipe(catchError(() => of([]))),
      muxes: this.tvh.getGrid('mpegts/mux/grid', { filter }).pipe(catchError(() => of([]))),
    }).subscribe(({ net: n, muxes }) => {
      const v: any = n[0] || {};
      const mine = muxes.filter((m: any) => !m.network_uuid || String(m.network_uuid) === net);
      // scan_state: 0 idle, 1 pending, 2 idle-pending, 3 active; scan_result: 0 none, 1 ok, 2 fail, 3 partial, 4 ignore
      const state = (m: any) => Number(m.scan_state) || 0, result = (m: any) => Number(m.scan_result) || 0;
      const pending = mine.filter((m: any) => state(m) !== 0).length;
      const scanned = mine.filter((m: any) => state(m) === 0 && result(m) !== 0).length;
      this.scan.set({
        muxes: Math.max(mine.length, Number(v.num_mux) || 0),
        scanned,
        ok: mine.filter((m: any) => result(m) === 1 || result(m) === 3).length,
        failed: mine.filter((m: any) => result(m) === 2).length,
        pending: Math.max(pending, Number(v.scanq_length) || 0),
        services: Number(v.num_svc) || mine.reduce((sum: number, m: any) => sum + (Number(m.num_svc) || 0), 0),
        mapped: Number(v.num_chn) || 0,
        failedUuids: mine.filter((m: any) => result(m) === 2).map((m: any) => String(m.uuid)),
      });
      if (this.scanDone() && !this.passDoneHandled) { this.passDoneHandled = true; this.afterPass(); }
    });
  }

  /** What the HDHomeRun said about its tuners before the latest pass. */
  readonly sharing = signal<GuardReport | null>(null);
  /** Waiting for another app to free a tuner (all of ours were busy). */
  readonly waitingForTuner = signal(false);
  /** Scan passes so far; empty frequencies are retried automatically up to MAX_PASSES. */
  readonly pass = signal(0);
  readonly MAX_PASSES = 3;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private finishing = false;

  /** Start the scan once at least one tuner is free (checking every 5 s). */
  private scanWhenFree(net: string, label: string): void {
    const go = () => {
      this.stopWaiting();
      this.tvh.scanNetwork(net).pipe(catchError(() => of(null))).subscribe();
      this.beginScan(net, label);
    };
    if (this.sharing()?.free.length !== 0) { go(); return; }
    this.networkUuid.set(net);
    this.networkLabel.set(label);
    this.step.set('scan');
    this.waitingForTuner.set(true);
    this.waitTimer = setInterval(() => {
      this.guard.prepare(this.selectedTuners()).subscribe(r => {
        this.sharing.set(r);
        if (r.free.length) go();
      });
    }, 5000);
  }

  private stopWaiting(): void {
    this.waitingForTuner.set(false);
    if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
  }

  /**
   * Called when a pass finishes. With HDHomeRun tuners involved, empty frequencies may just mean a
   * tuner was busy elsewhere, so check the tuners again and rescan the empty ones (up to MAX_PASSES);
   * then switch any held tuners back on.
   */
  private afterPass(): void {
    const s = this.scan();
    if (this.finishing || !s || this.kind() !== 'tuner') return;
    const hdhr = !!this.sharing()?.devices.length || !!this.sharing()?.unreachable.length;
    if (hdhr && s.ok > 0 && s.failed > 0 && this.pass() < this.MAX_PASSES) {
      this.finishing = true;
      this.guard.prepare(this.selectedTuners()).subscribe(r => {
        this.sharing.set(r);
        this.finishing = false;
        if (!r.free.length) { this.releaseTuners(); return; }
        this.pass.update(n => n + 1);
        this.retryFailed(true);
      });
      return;
    }
    this.releaseTuners();
  }

  private releaseTuners(): void {
    if (this.finishing) return;
    this.finishing = true;
    this.guard.restore().subscribe(() => {
      this.finishing = false;
      if (this.sharing()) this.sharing.update(r => r && { ...r, held: [] });
    });
  }

  heldNames(r: GuardReport): string {
    return r.held.map(t => `#${/#(\d+)/.exec(t.name)?.[1] ?? '?'} (used by ${t.by})`).join(', ');
  }

  /** Broadcast tuners raised above IPTV (antenna first, IPTV as backup). */
  readonly priority = signal<PriorityChange[]>([]);
  readonly describeChanges = describeChanges;

  readonly retrying = signal(false);
  readonly retries = signal(0);

  /**
   * Scan again only the frequencies that came back empty. Tvheadend marks a frequency as failed
   * straight away when its tuner is busy elsewhere (an HDHomeRun tuner in use by another server or
   * app), instead of waiting for a free one — so a retry often finds stations the first pass missed.
   */
  retryFailed(auto = false): void {
    const ids = this.scan()?.failedUuids ?? [];
    if (!ids.length) return;
    if (!auto) {
      // A manual retry: take another look at who is using the tuners first.
      this.retrying.set(true);
      this.guard.prepare(this.selectedTuners()).subscribe(r => { this.sharing.set(r); this.retrying.set(false); this.retryFailed(true); });
      return;
    }
    this.retrying.set(true);
    forkJoin(ids.map(id => this.tvh.idnodeSave(id, { scan_state: 1 }).pipe(catchError(() => of(null))))).subscribe(() => {
      this.retrying.set(false);
      this.retries.update(n => n + 1);
      this.passDoneHandled = false;
      this.scanStarted.set(Date.now());
      if (!this.timer) this.timer = setInterval(() => this.poll(), 2000);
      this.poll();
    });
  }

  private passDoneHandled = false;

  private stopPolling(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  finish(): void {
    this.stopPolling();
    this.poll();
    this.step.set('done');
  }

  restart(): void {
    this.stopPolling();
    this.hdhrSearch.set(null);
    this.step.set('kind');
    this.kind.set(null);
    this.networkUuid.set(null);
    this.scan.set(null);
    this.error.set('');
    this.networkMode = 'new';
    this.iptvUrl = '';
    this.ngOnInit();
  }
}
