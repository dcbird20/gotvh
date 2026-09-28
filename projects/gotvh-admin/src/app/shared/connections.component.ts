import { Component, OnChanges, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, shareReplay, switchMap } from 'rxjs/operators';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TvheadendService, truthy } from '@gotvh/tvh-api';

export type ConnectionKind = 'channel' | 'service' | 'mux' | 'network' | 'tuner' | 'recording' | 'epgchannel' | 'tag';

/** A clickable item in the chain. */
interface Link {
  label: string;
  route: string;
  query?: Record<string, string>;
  note?: string;
  off?: boolean;
}

interface Row {
  heading: string;
  links: Link[];
  /** Shown when there are no links — usually a problem. */
  empty?: string;
  warn?: boolean;
  /** A next step, e.g. where to fix it. */
  action?: Link;
  /** Sub-rows, e.g. each service's mux and network. */
  children?: Row[];
}

const on = (v: unknown) => v === undefined || truthy(v) || v === 'true';
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

interface Tuner { uuid: string; name: string; enabled: boolean; networks: string[]; iptv: boolean; priority: number }

export const openLink = {
  channel: (uuid: string, label: string, extra: Partial<Link> = {}): Link => ({ label, route: '/channels', query: { open: uuid }, ...extra }),
  service: (uuid: string, label: string, extra: Partial<Link> = {}): Link => ({ label, route: '/inputs', query: { tab: 'services', open: uuid }, ...extra }),
  mux: (uuid: string, label: string, extra: Partial<Link> = {}): Link => ({ label, route: '/inputs', query: { tab: 'muxes', open: uuid }, ...extra }),
  network: (uuid: string, label: string, extra: Partial<Link> = {}): Link => ({ label, route: '/inputs', query: { tab: 'networks', open: uuid }, ...extra }),
  tuner: (uuid: string, label: string, extra: Partial<Link> = {}): Link => ({ label, route: '/inputs', query: { tab: 'tuners', open: uuid }, ...extra }),
  tag: (uuid: string, label: string): Link => ({ label, route: '/channel-tags', query: { open: uuid } }),
  epgChannel: (uuid: string, label: string, extra: Partial<Link> = {}): Link => ({ label, route: '/epg', query: { tab: 'channels', open: uuid }, ...extra }),
  autorec: (uuid: string, label: string): Link => ({ label, route: '/autorec', query: { open: uuid } }),
  timer: (uuid: string, label: string): Link => ({ label, route: '/timers', query: { open: uuid } }),
  dvrProfile: (uuid: string, label: string): Link => ({ label, route: '/dvr-profiles', query: { open: uuid } }),
};

/**
 * "Connected to" panel: where an object sits in Tvheadend's chain
 * tuner → network → mux → service → channel → guide data, with every item
 * clickable, and a warning where the chain is broken.
 */
@Component({
  selector: 'admin-connections',
  standalone: true,
  imports: [NgTemplateOutlet, RouterLink, MatIconModule, MatProgressBarModule],
  template: `
    <section class="card" aria-label="Connected to">
      <h3><mat-icon>account_tree</mat-icon> Connected to</h3>
      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }
      @if (error()) { <p class="muted small">{{ error() }}</p> }
      @for (row of rows(); track row.heading) {
        <ng-container *ngTemplateOutlet="rowTpl; context: { $implicit: row, depth: 0 }" />
      }
      <ng-template #rowTpl let-row let-depth="depth">
        <div class="row" [class.child]="depth > 0">
          <span class="heading">{{ row.heading }}</span>
          <span class="links">
            @for (l of row.links; track $index) {
              <a [routerLink]="l.route" [queryParams]="l.query" [class.off]="l.off">{{ l.label }}</a>@if (l.note) {<span class="muted note"> {{ l.note }}</span>}@if (!$last) {<span class="sep">, </span>}
            }
            @if (!row.links.length && row.empty) {
              <span [class.warn]="row.warn">@if (row.warn) {<mat-icon class="wi">warning</mat-icon>}{{ row.empty }}</span>
            }
            @if (row.action) {
              <a class="action" [routerLink]="row.action.route" [queryParams]="row.action.query">{{ row.action.label }}</a>
            }
          </span>
        </div>
        @for (c of row.children || []; track $index) {
          <div class="children">
            <ng-container *ngTemplateOutlet="rowTpl; context: { $implicit: c, depth: depth + 1 }" />
          </div>
        }
      </ng-template>
    </section>
  `,
  styles: [`
    .card { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: 12px 20px 14px;
            background: var(--mat-sys-surface-container-lowest); }
    h3 { display: flex; align-items: center; gap: 6px; font: var(--mat-sys-title-small); margin: 0 0 8px;
         color: var(--mat-sys-on-surface-variant);
         mat-icon { font-size: 18px; width: 18px; height: 18px; } }
    .row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 3px 0; font: var(--mat-sys-body-medium); }
    .row.child { grid-template-columns: 80px 1fr; font: var(--mat-sys-body-small); }
    .children { margin-left: 12px; padding-left: 10px; border-left: 2px solid var(--mat-sys-outline-variant); }
    .heading { color: var(--mat-sys-on-surface-variant); font: var(--mat-sys-body-small); padding-top: 2px; }
    a { color: var(--mat-sys-primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    a.off { color: var(--mat-sys-on-surface-variant); text-decoration: line-through; }
    .note { font: var(--mat-sys-body-small); }
    .warn { color: var(--mat-sys-error); display: inline-flex; align-items: center; gap: 4px; }
    .wi { font-size: 16px; width: 16px; height: 16px; }
    .action { margin-left: 10px; font: var(--mat-sys-label-large); }
    .small { font: var(--mat-sys-body-small); }
  `],
})
export class ConnectionsComponent implements OnChanges {
  private readonly tvh = inject(TvheadendService);

  readonly kind = input.required<ConnectionKind>();
  readonly uuid = input.required<string>();

  readonly loading = signal(false);
  readonly error = signal('');
  readonly rows = signal<Row[]>([]);

  /** Tuners and the networks they use; the same for every panel on the page. */
  private static tuners$: Observable<Tuner[]> | null = null;
  private static tunersAt = 0;

  ngOnChanges(): void {
    const uuid = this.uuid(), kind = this.kind();
    if (!uuid) { this.rows.set([]); return; }
    this.loading.set(true);
    this.error.set('');
    const build: Record<ConnectionKind, (u: string) => Observable<Row[]>> = {
      channel: u => this.forChannel(u),
      service: u => this.forService(u),
      mux: u => this.forMux(u),
      network: u => this.forNetwork(u),
      tuner: u => this.forTuner(u),
      recording: u => this.forRecording(u),
      epgchannel: u => this.forEpgChannel(u),
      tag: u => this.forTag(u),
    };
    build[kind](uuid).subscribe({
      next: rows => { this.rows.set(rows); this.loading.set(false); },
      error: () => { this.rows.set([]); this.loading.set(false); this.error.set('Couldn’t work out what this is connected to.'); },
    });
  }

  // ---------------------------------------------------------------- lookups

  private tuners() {
    if (!ConnectionsComponent.tuners$ || Date.now() - ConnectionsComponent.tunersAt > 30000) {
      ConnectionsComponent.tunersAt = Date.now();
      ConnectionsComponent.tuners$ = this.tvh.idnodeLoadByClass('mpegts_input').pipe(
        map(entries => entries.map(e => {
          const v: Record<string, any> = {};
          for (const p of e.params || []) v[p.id] = p.value;
          const name = String(v['displayname'] || e.text || 'Tuner');
          return { uuid: String(e.uuid || e.id), name, enabled: on(v['enabled']), networks: list(v['networks']),
            iptv: /iptv/i.test(String(e.class || '')) || /^iptv/i.test(name),
            priority: v['priority'] === undefined ? 1 : Number(v['priority']) || 0 };
        })),
        catchError(() => of([])),
        shareReplay(1),
      );
    }
    return ConnectionsComponent.tuners$;
  }

  /** Which of these networks are IPTV (only IPTV networks have max_streams). */
  private iptvNetworks(ids: string[]): Observable<Set<string>> {
    return this.tvh.idnodeValues(ids, ['networkname', 'max_streams']).pipe(
      map(rows => new Set(rows.filter((r: any) => 'max_streams' in r).map((r: any) => String(r.uuid)))),
      catchError(() => of(new Set<string>())),
    );
  }

  /** Tuner links for a network, or a warning row when none uses it. IPTV networks are served by the IPTV threads. */
  private tunerRow(networkUuid: string, tuners: Tuner[], iptv = false): Row {
    const using = tuners.filter(t => t.networks.includes(networkUuid));
    if (iptv) {
      const threads = using.length ? using : tuners.filter(t => t.iptv);
      return {
        heading: 'Tuners',
        links: threads.slice(0, 3).map(t => openLink.tuner(t.uuid, t.name)),
        empty: 'The IPTV input (automatic)',
        children: threads.length > 3 ? [{ heading: '', links: [], empty: `and ${threads.length - 3} more IPTV threads — Tvheadend spreads streams over them automatically` }] : undefined,
      };
    }
    return {
      heading: 'Tuners',
      links: using.map(t => openLink.tuner(t.uuid, t.name, { off: !t.enabled, note: t.enabled ? '' : '(disabled)' })),
      empty: 'No tuner uses this network, so nothing on it can be received', warn: true,
      action: using.length ? undefined : { label: 'Assign on Tuners', route: '/inputs', query: { tab: 'tuners' } },
    };
  }

  // ---------------------------------------------------------------- recording, guide channel, tag

  /** A recording: its channel (and what feeds it), what created it, and its DVR profile. */
  private forRecording(uuid: string): Observable<Row[]> {
    return this.tvh.idnodeValues([uuid], ['channel', 'channelname', 'autorec', 'autorec_caption', 'timerec', 'timerec_caption', 'config_name']).pipe(
      switchMap(([r]) => {
        const chUuid = String(r?.channel || '');
        return forkJoin({
          r: of(r),
          chain: chUuid ? this.forChannel(chUuid).pipe(catchError(() => of([] as Row[]))) : of([] as Row[]),
          ch: chUuid ? this.tvh.idnodeValues([chUuid], ['name', 'number', 'enabled']).pipe(catchError(() => of([]))) : of([] as any[]),
          profiles: this.tvh.getGrid('dvr/config/grid').pipe(catchError(() => of([]))),
        });
      }),
      map(({ r, chain, ch, profiles }) => {
        const c: any = ch[0];
        const cfg = String(r?.config_name || '');
        const prof: any = profiles.find((p: any) => String(p.uuid) === cfg);
        const fedBy = chain.find(x => x.heading === 'Fed by' || x.heading === 'Service');
        const rows: Row[] = [
          {
            heading: 'Channel',
            links: c ? [openLink.channel(String(c.uuid), `${c.number ? c.number + ' ' : ''}${c.name}`, { off: !on(c.enabled) })] : [],
            empty: r?.channelname ? `${r.channelname} (channel no longer exists)` : 'No channel', warn: !c,
            children: fedBy ? [fedBy] : undefined,
          },
        ];
        if (r?.autorec) rows.push({ heading: 'Made by', links: [openLink.autorec(String(r.autorec), `Auto-record rule${r.autorec_caption ? ': ' + r.autorec_caption : ''}`)] });
        else if (r?.timerec) rows.push({ heading: 'Made by', links: [openLink.timer(String(r.timerec), `Timer${r.timerec_caption ? ': ' + r.timerec_caption : ''}`)] });
        else rows.push({ heading: 'Made by', links: [], empty: 'Scheduled by hand' });
        rows.push({ heading: 'DVR profile', links: cfg ? [openLink.dvrProfile(cfg, String(prof?.name || '').trim() || 'Default profile')] : [], empty: 'Default profile' });
        return rows;
      }),
    );
  }

  /** A guide (EPG) channel: which of your channels it feeds, and where its data comes from. */
  private forEpgChannel(uuid: string): Observable<Row[]> {
    return this.tvh.idnodeValues([uuid], ['name', 'id', 'channels', 'module', 'enabled']).pipe(
      switchMap(([g]) => {
        const ids = list(g?.channels);
        return (ids.length ? this.tvh.idnodeValues(ids, ['name', 'number', 'enabled']).pipe(catchError(() => of([]))) : of([] as any[]))
          .pipe(map(chans => ({ g, chans })));
      }),
      map(({ g, chans }) => [
        {
          heading: 'Feeds',
          links: chans.map((c: any) => openLink.channel(String(c.uuid), `${c.number ? c.number + ' ' : ''}${c.name}`, { off: !on(c.enabled) })),
          empty: 'None of your channels — its guide data isn’t shown anywhere', warn: true,
          action: chans.length ? undefined : { label: 'Match by name', route: '/epg', query: { tab: 'channels' } },
        },
        { heading: 'From', links: [{ label: String(g?.module || 'grabber').replace(/^.*?:\s*/, ''), route: '/epg', query: { tab: 'grabbers' } }] },
      ] as Row[]),
    );
  }

  /** A channel tag: its channels, and the rules and users it limits. */
  private forTag(uuid: string): Observable<Row[]> {
    return forkJoin({
      channels: this.tvh.getGrid('channel/grid', { all: 1, limit: 100000 }).pipe(catchError(() => of([]))),
      rules: this.tvh.getGrid('dvr/autorec/grid', { limit: 100000 }).pipe(catchError(() => of([]))),
      access: this.tvh.getGrid('access/entry/grid', { limit: 100000 }).pipe(catchError(() => of([]))),
    }).pipe(map(({ channels, rules, access }) => {
      const mine = channels.filter((c: any) => list(c.tags).includes(uuid))
        .sort((a: any, b: any) => (parseFloat(a.number) || 1e9) - (parseFloat(b.number) || 1e9));
      const shown = mine.slice(0, 12);
      const byRule = rules.filter((r: any) => String(r.tag || '') === uuid);
      const byUser = access.filter((a: any) => list(a.channel_tag).includes(uuid));
      return [
        {
          heading: 'Channels',
          links: shown.map((c: any) => openLink.channel(String(c.uuid), `${c.number ? c.number + ' ' : ''}${c.name}`, { off: !on(c.enabled) })),
          empty: 'No channels have this tag',
          action: mine.length > shown.length ? { label: `All ${mine.length}`, route: '/channels', query: { tag: uuid } } : undefined,
        },
        {
          heading: 'Auto-record',
          links: byRule.map((r: any) => openLink.autorec(String(r.uuid), String(r.name || r.title || 'rule'))),
          empty: 'No rules limited to this tag',
        },
        {
          heading: 'Users',
          links: byUser.map((a: any) => ({ label: String(a.username || a.prefix || 'entry'), route: '/users' })),
          empty: 'Doesn’t limit anyone',
        },
      ] as Row[];
    }));
  }

  /**
   * Which service Tvheadend tries first: source priority (best enabled tuner on the network, or the
   * IPTV network's own) + the service's Priority (−10..10); the next one is the fallback.
   */
  private orderRow(svcs: any[], muxById: Map<string, any>, iptv: Set<string>, netPrio: Map<string, number>, tuners: Tuner[]): Row {
    const ranked = svcs.filter((s: any) => on(s.enabled)).map((s: any) => {
      const netId = String(muxById.get(String(s.multiplex_uuid))?.network_uuid || '');
      const isIptv = iptv.has(netId);
      const source = isIptv
        ? (netPrio.get(netId) ?? 1)
        : Math.max(0, ...tuners.filter(t => t.enabled && t.networks.includes(netId)).map(t => t.priority));
      return { s, isIptv, score: source + Math.max(-10, Math.min(10, Number(s.priority) || 0)) };
    }).sort((a, b) => b.score - a.score);
    const tie = ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].isIptv !== ranked[1].isIptv;
    return {
      heading: 'Used first',
      links: ranked.map((r, i) => openLink.service(String(r.s.uuid), `${i + 1}. ${r.s.svcname || 'service'}`,
        { note: `(${r.isIptv ? 'IPTV' : 'antenna/cable'}, priority ${r.score})` })),
      empty: 'No enabled service',
      warn: tie,
      children: tie ? [{ heading: '', links: [], warn: true,
        empty: 'Antenna and IPTV are tied, so Tvheadend may pick either. Raise the tuners’ Priority (e.g. 10) to use the antenna first.',
        action: { label: 'Use the antenna first', route: '/inputs', query: { tab: 'tuners', prefer: 'antenna' } } }] : undefined,
    };
  }

  private forChannel(uuid: string): Observable<Row[]> {
    return this.tvh.idnodeValues([uuid], ['name', 'services', 'tags', 'epggrab']).pipe(
      switchMap(([ch]) => {
        const svcIds = list(ch?.services);
        return forkJoin({
          ch: of(ch),
          svcs: this.tvh.idnodeValues(svcIds, ['svcname', 'multiplex', 'multiplex_uuid', 'network', 'enabled', 'priority']).pipe(catchError(() => of([]))),
          tags: this.tvh.getGrid('channeltag/grid', { all: 1 }).pipe(catchError(() => of([]))),
          tuners: this.tuners(),
          guides: list(ch?.epggrab).length
            ? this.tvh.idnodeValues(list(ch?.epggrab), ['name', 'id', 'module', 'enabled']).pipe(catchError(() => of([])))
            : of([] as any[]),
        });
      }),
      switchMap(({ ch, svcs, tags, tuners, guides }) => {
        const muxIds = [...new Set(svcs.map((s: any) => String(s.multiplex_uuid || '')).filter(Boolean))];
        return this.tvh.idnodeValues(muxIds, ['name', 'network', 'network_uuid', 'enabled']).pipe(
          catchError(() => of([])),
          switchMap(muxes => {
            const netIds = [...new Set(muxes.map((m: any) => String(m.network_uuid || '')).filter(Boolean))];
            return forkJoin({
              iptv: this.iptvNetworks(netIds),
              nets: this.tvh.idnodeValues(netIds, ['networkname', 'priority']).pipe(catchError(() => of([]))),
            }).pipe(map(({ iptv, nets }) => ({ muxes, iptv, nets })));
          }),
          map(({ muxes, iptv, nets }) => {
            const netPrio = new Map(nets.map((n: any) => [String(n.uuid), n.priority === undefined ? 1 : Number(n.priority) || 0]));
            const muxById = new Map(muxes.map((m: any) => [String(m.uuid), m]));
            const tagName = new Map(tags.map((t: any) => [String(t.uuid), String(t.name)]));
            const serviceRows: Row[] = svcs.map((s: any) => {
              const mux: any = muxById.get(String(s.multiplex_uuid));
              const netId = String(mux?.network_uuid || '');
              return {
                heading: 'Service',
                links: [openLink.service(String(s.uuid), String(s.svcname || 'service'), { off: !on(s.enabled), note: on(s.enabled) ? '' : '(disabled)' })],
                children: [
                  { heading: 'Mux', links: mux ? [openLink.mux(String(mux.uuid), String(mux.name || s.multiplex), { off: !on(mux.enabled) })] : [], empty: String(s.multiplex || '—') },
                  { heading: 'Network', links: netId ? [openLink.network(netId, String(mux?.network || s.network))] : [], empty: String(s.network || '—') },
                  ...(netId ? [this.tunerRow(netId, tuners, iptv.has(netId))] : []),
                ],
              } as Row;
            });
            const order = svcs.length > 1 ? this.orderRow(svcs, muxById, iptv, netPrio, tuners) : null;
            const services: Row = svcs.length
              ? { heading: 'Fed by', links: [], children: order ? [order, ...serviceRows] : serviceRows }
              : { heading: 'Service', links: [], empty: 'No service — this channel has nothing to play', warn: true,
                  action: { label: 'Map a service', route: '/inputs', query: { tab: 'services' } } };
            const epg = list(ch?.epggrab);
            return [
              services,
              {
                heading: 'Guide data',
                links: guides.length
                  ? guides.map((g: any) => openLink.epgChannel(String(g.uuid), String(g.name || g.id || 'guide channel'),
                      { note: g.module ? `(${String(g.module).replace(/^.*?:\s*/, '')})` : '', off: !on(g.enabled) }))
                  : epg.map(id => openLink.epgChannel(id, 'guide channel')),
                empty: 'None from a grabber (over-the-air guide data may still arrive)', warn: false,
                action: epg.length ? undefined : { label: 'Match on EPG sources', route: '/epg', query: { tab: 'channels' } },
              },
              { heading: 'Tags', links: list(ch?.tags).map(t => openLink.tag(t, tagName.get(t) || '?')), empty: 'None' },
            ] as Row[];
          }),
        );
      }),
    );
  }

  private forService(uuid: string): Observable<Row[]> {
    return this.tvh.idnodeValues([uuid], ['svcname', 'channel', 'multiplex', 'multiplex_uuid', 'network']).pipe(
      switchMap(([s]) => forkJoin({
        s: of(s),
        chans: this.tvh.idnodeValues(list(s?.channel), ['name', 'number', 'enabled']).pipe(catchError(() => of([]))),
        mux: this.tvh.idnodeValues([String(s?.multiplex_uuid || '')], ['name', 'network', 'network_uuid', 'enabled']).pipe(catchError(() => of([]))),
        tuners: this.tuners(),
      })),
      switchMap(x => this.iptvNetworks([String((x.mux[0] as any)?.network_uuid || '')]).pipe(map(iptv => ({ ...x, iptv })))),
      map(({ s, chans, mux, tuners, iptv }) => {
        const m: any = mux[0];
        const netId = String(m?.network_uuid || '');
        return [
          {
            heading: chans.length > 1 ? 'Channels' : 'Channel',
            links: chans.map((c: any) => openLink.channel(String(c.uuid), `${c.number ? c.number + ' ' : ''}${c.name}`, { off: !on(c.enabled) })),
            empty: 'Not on a channel yet — select it and use Map to channels', warn: true,
          },
          { heading: 'Mux', links: m ? [openLink.mux(String(m.uuid), String(m.name || s?.multiplex), { off: !on(m.enabled), note: on(m.enabled) ? '' : '(disabled)' })] : [], empty: String(s?.multiplex || '—') },
          { heading: 'Network', links: netId ? [openLink.network(netId, String(m?.network || s?.network))] : [], empty: String(s?.network || '—') },
          ...(netId ? [this.tunerRow(netId, tuners, iptv.has(netId))] : []),
        ] as Row[];
      }),
    );
  }

  private forMux(uuid: string): Observable<Row[]> {
    const filter = JSON.stringify([{ type: 'string', field: 'multiplex_uuid', value: uuid }]);
    return forkJoin({
      mux: this.tvh.idnodeValues([uuid], ['name', 'network', 'network_uuid', 'num_svc', 'num_chn']),
      svcs: this.tvh.getGrid('mpegts/service/grid', { filter }).pipe(catchError(() => of([]))),
      tuners: this.tuners(),
    }).pipe(
      switchMap(x => this.iptvNetworks([String((x.mux[0] as any)?.network_uuid || '')]).pipe(map(iptv => ({ ...x, iptv })))),
      map(({ mux, svcs, tuners, iptv }) => {
      const m: any = mux[0];
      const netId = String(m?.network_uuid || '');
      const mine = svcs.filter((s: any) => !s.multiplex_uuid || String(s.multiplex_uuid) === uuid);
      const unmapped = mine.filter((s: any) => !list(s.channel).length);
      return [
        { heading: 'Network', links: netId ? [openLink.network(netId, String(m?.network))] : [], empty: String(m?.network || '—') },
        ...(netId ? [this.tunerRow(netId, tuners, iptv.has(netId))] : []),
        {
          heading: 'Services',
          links: mine.slice(0, 12).map((s: any) => openLink.service(String(s.uuid), String(s.svcname || 'service'),
            { note: list(s.channel).length ? '' : '(not on a channel)' })),
          empty: 'None found yet — scan this mux', warn: true,
        },
        ...(mine.length > 12 ? [{ heading: '', links: [], empty: `and ${mine.length - 12} more` }] : []),
        ...(unmapped.length ? [{ heading: '', links: [], empty: `${plural(unmapped.length, 'service')} not on a channel`, warn: true,
          action: { label: 'Map them', route: '/inputs', query: { tab: 'services' } } }] : []),
      ] as Row[];
    }));
  }

  private forNetwork(uuid: string): Observable<Row[]> {
    return forkJoin({
      net: this.tvh.idnodeValues([uuid], ['networkname', 'num_mux', 'num_svc', 'num_chn', 'max_streams']),
      tuners: this.tuners(),
    }).pipe(map(({ net, tuners }) => {
      const n: any = net[0] || {};
      const iptv = 'max_streams' in n;
      const svc = Number(n.num_svc) || 0, chn = Number(n.num_chn) || 0, mux = Number(n.num_mux) || 0;
      return [
        this.tunerRow(uuid, tuners, iptv),
        { heading: 'Muxes', links: mux ? [{ label: plural(mux, 'mux', 'muxes'), route: '/inputs', query: { tab: 'muxes' } }] : [],
          empty: 'None yet — scan the network, or Add mux', warn: true },
        { heading: 'Services', links: svc ? [{ label: `${plural(svc, 'service')}, ${chn} mapped`, route: '/inputs', query: { tab: 'services' } }] : [],
          empty: 'None yet — scanning finds them' },
        ...(svc > chn ? [{ heading: '', links: [], empty: `Up to ${plural(svc - chn, 'service')} not on a channel`, warn: true,
          action: { label: 'Map them', route: '/inputs', query: { tab: 'services' } } }] : []),
      ] as Row[];
    }));
  }

  private forTuner(uuid: string): Observable<Row[]> {
    return forkJoin({
      self: this.tvh.idnodeValues([uuid], ['displayname', 'enabled', 'networks']).pipe(catchError(() => of([]))),
      tuners: this.tuners(),
    }).pipe(
      switchMap(({ self, tuners }) => {
        const known = tuners.find(x => x.uuid === uuid);
        const v: any = self[0];
        if (!known && !v) return of([] as Row[]); // an adapter, not a tuner
        const networks = list(v?.networks ?? known?.networks);
        const iptv = !!known?.iptv || /^iptv/i.test(String(v?.displayname || ''));
        const enabled = v ? on(v.enabled) : !!known?.enabled;
        return this.tvh.idnodeValues(networks, ['networkname']).pipe(
          catchError(() => of([])),
          map(nets => [
            {
              heading: networks.length === 1 ? 'Network' : 'Networks',
              links: nets.map((n: any) => openLink.network(String(n.uuid), String(n.networkname || 'network'))),
              empty: iptv ? 'Every IPTV network — Tvheadend spreads IPTV streams over its IPTV threads automatically'
                : 'No network assigned — this tuner won’t be used',
              warn: !iptv,
            },
            ...(enabled ? [] : [{ heading: '', links: [], empty: 'This tuner is disabled', warn: true }]),
          ] as Row[]),
        );
      }),
    );
  }
}
