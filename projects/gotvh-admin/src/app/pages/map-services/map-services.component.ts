import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, finalize, tap } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';

type Kind = 'tv' | 'radio' | 'data' | 'unknown';

/** DVB service_type codes (EN 300 468): TV, radio, and everything else is data. */
const TV_TYPES = new Set([0x01, 0x11, 0x16, 0x19, 0x1f, 0x20]);
const RADIO_TYPES = new Set([0x02, 0x07, 0x0a]);

function kindOf(s: any): Kind {
  const t = Number(s?.dvb_servicetype);
  if (!t) return 'unknown';
  if (TV_TYPES.has(t)) return 'tv';
  if (RADIO_TYPES.has(t)) return 'radio';
  return 'data';
}

const on = (v: unknown) => v === undefined || truthy(v) || v === 'true';
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** Names compare without case, spaces or punctuation: "WPSU-HD" ~ "wpsu hd". */
const nameKey = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Shared leading text of all names, cut back to a " - " / " | " / ": " separator (e.g. a playlist id "vYSe42W83QyE - "). */
function commonPrefix(names: string[]): string {
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
const tidy = (n: string) => n.replace(/[\s-]*(hd|sd|uhd|4k)$/i, '').trim() || n;

interface Candidate {
  uuid: string;
  service: string;
  provider: string;
  network: string;
  mux: string;
  kind: Kind;
  encrypted: boolean;
  /** From the broadcast (logical channel number, ATSC major.minor). */
  broadcastNumber: string;
  selected: boolean;
  name: string;
  number: string;
}

interface NetworkGroup { network: string; items: Candidate[]; open: boolean }

/** What pressing Create will do, per channel. */
interface Plan {
  key: string;
  name: string;
  number: string;
  services: Candidate[];
  /** Existing channel the services are added to, when merging by name. */
  existing: { uuid: string; name: string; services: string[] } | null;
}

/**
 * Map services screen: every service not yet on a channel, grouped by
 * network, with a preview of the channels that will be made — names and
 * numbers from the broadcast, editable; radio and data services left out
 * unless ticked; the same station on two networks becomes one channel fed by
 * both; names matching an existing channel are added to it.
 */
@Component({
  selector: 'admin-map-services',
  standalone: true,
  imports: [
    FormsModule, RouterLink, MatButtonModule, MatCheckboxModule, MatDialogModule, MatFormFieldModule, MatIconModule,
    MatInputModule, MatProgressBarModule, MatSelectModule, MatSnackBarModule, MatTooltipModule,
  ],
  templateUrl: './map-services.component.html',
  styleUrl: './map-services.component.scss',
})
export class MapServicesComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly loading = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly progress = signal<{ done: number; total: number } | null>(null);
  readonly result = signal<{ created: number; merged: number; failed: number } | null>(null);

  readonly groups = signal<NetworkGroup[]>([]);
  private readonly channels = signal<any[]>([]);
  readonly tags = signal<Array<{ uuid: string; name: string }>>([]);
  readonly mappedCount = signal(0);

  // options
  readonly mergeSameName = signal(true);
  readonly addToExisting = signal(true);
  readonly tidyNames = signal(false);
  tagUuids: string[] = [];
  readonly query = signal('');
  /** Bumped whenever a row changes, so the plan recomputes. */
  readonly version = signal(0);

  readonly all = computed(() => { this.version(); return this.groups().flatMap(g => g.items); });
  readonly selected = computed(() => this.all().filter(c => c.selected));

  private readonly existingByName = computed(() => {
    const m = new Map<string, any>();
    for (const c of this.channels()) m.set(nameKey(String(c.name || '')), c);
    return m;
  });
  private readonly existingByNumber = computed(() => {
    const m = new Map<string, any>();
    for (const c of this.channels()) {
      const n = String(c.number ?? '');
      if (n && n !== '0') m.set(n, c);
    }
    return m;
  });

  readonly plan = computed<Plan[]>(() => {
    this.version();
    const merge = this.mergeSameName(), existing = this.addToExisting(), byName = this.existingByName();
    const plans = new Map<string, Plan>();
    for (const c of this.selected()) {
      const name = this.finalName(c);
      // The same name on *different* networks is one station received two ways; on the same
      // network it's two different services (IPTV playlists often repeat or lack names).
      let key = merge ? nameKey(name) : c.uuid;
      if (merge && plans.get(key)?.services.some(x => x.network === c.network)) key = c.uuid;
      let p = plans.get(key);
      if (!p) {
        const ex = existing ? byName.get(nameKey(name)) : null;
        p = { key, name, number: c.number, services: [], existing: ex ? { uuid: String(ex.uuid), name: String(ex.name), services: list(ex.services) } : null };
        plans.set(key, p);
      }
      p.services.push(c);
      if (!p.number && c.number) p.number = c.number;
    }
    return [...plans.values()];
  });

  readonly newCount = computed(() => this.plan().filter(p => !p.existing).length);
  /** How many new channels would get each number — more than one is a clash within this batch. */
  private readonly planNumbers = computed(() => {
    const m = new Map<string, number>();
    for (const p of this.plan()) if (!p.existing && p.number) m.set(p.number, (m.get(p.number) || 0) + 1);
    return m;
  });
  readonly mergeCount = computed(() => this.plan().filter(p => p.existing).length);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.result.set(null);
    forkJoin({
      services: this.tvh.getGrid('mpegts/service/grid'),
      channels: this.tvh.getGrid('channel/grid', { all: 1 }).pipe(catchError(() => of([]))),
      tags: this.tvh.getGrid('channeltag/grid', { all: 1 }).pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ services, channels, tags }) => {
        this.channels.set(channels);
        this.tags.set(tags.map((t: any) => ({ uuid: String(t.uuid), name: String(t.name || '') })).sort((a, b) => a.name.localeCompare(b.name)));
        const unmapped = services.filter((s: any) => !list(s.channel).length && on(s.enabled));
        this.mappedCount.set(services.length - unmapped.length);
        const byNet = new Map<string, Candidate[]>();
        for (const s of unmapped) {
          const kind = kindOf(s);
          const encrypted = truthy(s.encrypted);
          const lcn = Number(s.lcn) || 0, minor = Number(s.lcn_minor) || 0;
          const broadcastNumber = lcn ? (minor ? `${lcn}.${minor}` : String(lcn)) : '';
          const c: Candidate = {
            uuid: String(s.uuid), service: String(s.svcname || '').trim(),
            provider: String(s.provider || ''), network: String(s.network || 'Unknown network'), mux: String(s.multiplex || ''),
            kind, encrypted, broadcastNumber,
            selected: (kind === 'tv' || kind === 'unknown') && !encrypted,
            name: '', number: broadcastNumber,
          };
          byNet.set(c.network, [...(byNet.get(c.network) || []), c]);
        }
        // Services without a name yet (common for IPTV until a stream has been played) are named
        // after their mux, minus any prefix every mux on that network shares (a playlist id).
        for (const items of byNet.values()) {
          const prefix = commonPrefix(items.map(c => c.mux));
          for (const c of items) {
            if (!c.service) c.service = c.mux.slice(prefix.length).trim() || c.mux || 'Unnamed service';
            c.name = c.service;
          }
        }
        this.groups.set([...byNet.entries()]
          .map(([network, items]) => ({
            network,
            items: items.sort((a, b) => (parseFloat(a.number) || 1e9) - (parseFloat(b.number) || 1e9)
              || a.number.localeCompare(b.number, undefined, { numeric: true }) || a.service.localeCompare(b.service)),
            open: items.length <= 150,
          }))
          .sort((a, b) => a.network.localeCompare(b.network)));
        this.version.update(v => v + 1);
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.error.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load services (${err?.status || 'network error'}).`);
      },
    });
  }

  // ---------------------------------------------------------------- rows

  finalName(c: Candidate): string {
    const n = c.name.trim() || c.service;
    return this.tidyNames() ? tidy(n) : n;
  }

  visible(g: NetworkGroup): Candidate[] {
    const q = this.query().trim().toLowerCase();
    if (!q) return g.items;
    return g.items.filter(c => c.service.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
      || c.number.startsWith(q) || c.mux.toLowerCase().includes(q) || c.provider.toLowerCase().includes(q));
  }

  touch(): void {
    this.version.update(v => v + 1);
  }

  toggle(c: Candidate, value: boolean): void {
    c.selected = value;
    this.touch();
  }

  groupState(g: NetworkGroup): 'all' | 'some' | 'none' {
    const n = g.items.filter(c => c.selected).length;
    return n === 0 ? 'none' : n === g.items.length ? 'all' : 'some';
  }

  toggleGroup(g: NetworkGroup, value: boolean): void {
    for (const c of this.visible(g)) c.selected = value;
    this.touch();
  }

  /** Quick picks across every network. */
  selectKinds(kinds: Kind[]): void {
    for (const c of this.all()) c.selected = kinds.includes(c.kind) && !c.encrypted;
    this.touch();
  }

  selectNone(): void {
    for (const c of this.all()) c.selected = false;
    this.touch();
  }

  kindLabel(k: Kind): string {
    return { tv: 'TV', radio: 'Radio', data: 'Data', unknown: '—' }[k];
  }

  /** Notes shown on a row: merges and clashes worth knowing before creating. */
  notes(c: Candidate): Array<{ text: string; warn?: boolean; link?: { route: string; query: Record<string, string> } }> {
    if (!c.selected) return [];
    const out: Array<{ text: string; warn?: boolean; link?: { route: string; query: Record<string, string> } }> = [];
    const plan = this.plan().find(p => p.services.includes(c));
    if (plan?.existing) {
      out.push({ text: `adds to existing channel “${plan.existing.name}”`, link: { route: '/channels', query: { open: plan.existing.uuid } } });
    } else if (plan && plan.services.length > 1 && plan.services[0] === c) {
      const others = [...new Set(plan.services.slice(1).map(s => s.network))];
      out.push({ text: `one channel, also received on ${others.slice(0, 2).join(' and ')}${others.length > 2 ? ` and ${others.length - 2} more` : ''}` });
    } else if (plan && plan.services.length > 1) {
      out.push({ text: `joins “${plan.name}” above` });
    }
    const clash = c.number ? this.existingByNumber().get(c.number) : null;
    if (clash && !(plan?.existing && String(clash.uuid) === plan.existing.uuid)) {
      out.push({ text: `number ${c.number} is already ${clash.name}`, warn: true, link: { route: '/channels', query: { open: String(clash.uuid) } } });
    }
    if (!plan?.existing && c.number && (this.planNumbers().get(c.number) || 0) > 1) {
      out.push({ text: `number ${c.number} is used more than once in this list`, warn: true });
    }
    if (c.encrypted) out.push({ text: 'encrypted — needs a descrambler', warn: true });
    return out;
  }

  // ---------------------------------------------------------------- create

  create(): void {
    const plans = this.plan();
    if (!plans.length) return;
    const parts = [
      this.newCount() ? `${plural(this.newCount(), 'new channel')}` : '',
      this.mergeCount() ? `${plural(this.mergeCount(), 'existing channel')} get more services` : '',
    ].filter(Boolean).join(', and ');
    const data: ConfirmDialogData = {
      title: `Map ${plural(this.selected().length, 'service')}?`,
      message: `${parts}.${this.tagUuids.length ? ' New channels get the chosen tags.' : ''} You can rename, renumber or delete channels afterwards on the Channels screen.`,
      confirm: 'Create channels',
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.busy.set(true);
      this.progress.set({ done: 0, total: plans.length });
      let done = 0, created = 0, merged = 0;
      runBulk(plans, p => this.apply(p).pipe(
        tap(() => { if (p.existing) merged++; else created++; }),
        finalize(() => this.progress.set({ done: ++done, total: plans.length })),
      )).subscribe(result => {
        this.busy.set(false);
        this.progress.set(null);
        this.result.set({ created, merged, failed: result.failed });
        this.snack.open(result.failed ? `${result.failed} couldn’t be created` : 'Channels created', undefined, { duration: 4000 });
        this.load();
      });
    });
  }

  private apply(p: Plan): Observable<unknown> {
    const uuids = p.services.map(s => s.uuid);
    if (p.existing) {
      return this.tvh.idnodeSave(p.existing.uuid, { services: [...new Set([...p.existing.services, ...uuids])] });
    }
    const conf: Record<string, unknown> = { enabled: true, name: p.name, services: uuids };
    if (p.number) conf['number'] = p.number; // split numbers go as text ("3.1")
    if (this.tagUuids.length) conf['tags'] = this.tagUuids;
    return this.tvh.idnodeCreate('channel', conf);
  }

  readonly plural = plural;
}
