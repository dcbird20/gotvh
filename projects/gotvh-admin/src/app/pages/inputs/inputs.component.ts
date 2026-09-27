import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TvheadendService } from '@gotvh/tvh-api';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { CreateVia, IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { MapServicesData, MapServicesDialogComponent } from './map-services-dialog.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';
import { BulkResult, describeBulk, runBulk } from '../../shared/bulk';
import { SplitHandleDirective } from '../../shared/split-handle.directive';

type TabId = 'tuners' | 'networks' | 'muxes' | 'services';

interface TreeRow {
  uuid: string;
  text: string;
  leaf: boolean;
  depth: number;
  expanded: boolean;
  loading: boolean;
}

interface Selection {
  tab: TabId;
  uuid: string | null;
  label: string;
  /** Set when creating: the class to create and its display name. */
  createClass?: string;
  /** Set when bulk-editing several rows. */
  bulkUuids?: string[];
  /** Set when adding a mux to a network by hand. */
  createVia?: CreateVia;
  networkName?: string;
}

interface GridTab {
  id: Exclude<TabId, 'tuners'>;
  label: string;
  path: string;
  filterField: string;
  filterLabel: string;
  nameField: string;
  columns: GridColumn[];
  deleteWarning: string;
  emptyText: string;
  /** Singular/plural nouns for bulk messages. */
  noun: [string, string];
  /** Has an `enabled` field that bulk enable/disable can set. */
  canEnable: boolean;
}

const GRID_TABS: GridTab[] = [
  {
    id: 'networks', label: 'Networks', path: 'mpegts/network/grid',
    filterField: 'networkname', filterLabel: 'Filter by name', nameField: 'networkname',
    columns: [
      { id: 'networkname', label: 'Network' },
      { id: 'num_mux', label: 'Muxes', kind: 'num' },
      { id: 'num_svc', label: 'Services', kind: 'num' },
      { id: 'num_chn', label: 'Mapped', kind: 'num' },
      { id: 'scanq_length', label: 'Scan queue', kind: 'num' },
    ],
    deleteWarning: 'Its muxes and services are removed too. Channels mapped from them lose their source.',
    emptyText: 'No networks yet. Use Add network, then assign it to a tuner.',
    noun: ['network', 'networks'], canEnable: false,
  },
  {
    id: 'muxes', label: 'Muxes', path: 'mpegts/mux/grid',
    filterField: 'name', filterLabel: 'Filter by name or frequency', nameField: 'name',
    columns: [
      { id: 'name', label: 'Mux' },
      { id: 'network', label: 'Network' },
      { id: 'enabled', label: 'Enabled', kind: 'bool' },
      { id: 'num_svc', label: 'Services', kind: 'num' },
      { id: 'num_chn', label: 'Mapped', kind: 'num' },
    ],
    deleteWarning: 'Services on this mux are removed too.',
    emptyText: 'No muxes. Scanning a network finds them.',
    noun: ['mux', 'muxes'], canEnable: true,
  },
  {
    id: 'services', label: 'Services', path: 'mpegts/service/grid',
    filterField: 'svcname', filterLabel: 'Filter by service name', nameField: 'svcname',
    columns: [
      { id: 'svcname', label: 'Service' },
      { id: 'provider', label: 'Provider' },
      { id: 'multiplex', label: 'Mux' },
      { id: 'network', label: 'Network' },
      { id: 'sid', label: 'SID', kind: 'num' },
      { id: 'enabled', label: 'Enabled', kind: 'bool' },
    ],
    deleteWarning: 'It may reappear the next time the mux is scanned.',
    emptyText: 'No services. They appear after a mux is scanned.',
    noun: ['service', 'services'], canEnable: true,
  },
];

/**
 * DVB inputs, as in the stock UI's Configuration → DVB Inputs tabs:
 * tuner hardware, networks, muxes and services. Every object opens in the
 * shared metadata-driven editor.
 */
@Component({
  selector: 'admin-inputs',
  standalone: true,
  imports: [SplitHandleDirective, 
    MatTabsModule, MatButtonModule, MatIconModule, MatMenuModule, MatProgressBarModule, MatTooltipModule,
    MatDialogModule, MatSnackBarModule, IdnodeFormComponent, IdnodeGridComponent,
  ],
  templateUrl: './inputs.component.html',
  styleUrl: './inputs.component.scss',
})
export class InputsComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild(IdnodeFormComponent) editor?: IdnodeFormComponent;
  @ViewChild(IdnodeGridComponent) grid?: IdnodeGridComponent;

  readonly gridTabs = GRID_TABS;
  readonly tabIndex = signal(0);
  readonly activeTab = computed<TabId>(() => this.tabIndex() === 0 ? 'tuners' : GRID_TABS[this.tabIndex() - 1].id);

  readonly selection = signal<Selection | null>(null);
  readonly selectedUuid = computed(() => this.selection()?.uuid ?? null);

  // Tuners tree, flattened for display.
  readonly tree = signal<TreeRow[]>([]);
  readonly treeLoading = signal(false);
  readonly treeError = signal('');

  // Network types that can be created (DVB-T, DVB-C, IPTV, …).
  readonly builders = signal<Array<{ class: string; caption: string }>>([]);
  /** Networks, for "Add mux". */
  readonly networks = signal<Array<{ uuid: string; name: string }>>([]);

  readonly editorTitle = computed(() => {
    const s = this.selection();
    if (!s) return '';
    if (s.bulkUuids) return s.label;
    if (s.createVia) return `New mux on ${s.networkName || 'network'}`;
    if (!s.createClass) return s.label; // '' → the editor shows the object's own name
    return /network$/i.test(s.label) ? `New ${s.label}` : `New ${s.label} network`;
  });

  ngOnInit(): void {
    this.loadTreeRoot();
    this.tvh.getBuilders('mpegts/network').subscribe({
      next: b => this.builders.set([...b].sort((x, y) => x.caption.localeCompare(y.caption))),
      error: () => this.builders.set([]),
    });
    this.loadNetworks();
  }

  private loadNetworks(): void {
    this.tvh.getGrid('mpegts/network/grid').subscribe({
      next: rows => this.networks.set(rows
        .map((n: any) => ({ uuid: String(n.uuid), name: String(n.networkname || n.uuid) }))
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))),
      error: () => this.networks.set([]),
    });
  }

  /** Open the editor to add a mux to a network; the fields depend on the network type (DVB-T, IPTV …). */
  newMux(network: { uuid: string; name: string }): void {
    const createVia: CreateVia = {
      meta: () => this.tvh.getMuxClass(network.uuid),
      create: conf => this.tvh.createMux(network.uuid, conf),
    };
    this.open({ tab: 'muxes', uuid: null, label: '', createVia, networkName: network.name });
  }

  /** "Add mux" from an open network. */
  newMuxOnSelected(): void {
    const sel = this.selection();
    if (!sel?.uuid) return;
    this.newMux({ uuid: sel.uuid, name: sel.label || this.networks().find(n => n.uuid === sel.uuid)?.name || 'network' });
  }

  // ---------------------------------------------------------------- map services

  /** Map the selected services, or (with no selection) every service not yet on a channel. */
  mapServices(selected: boolean): void {
    const grid = this.grid;
    const open = (services: any[]) => {
      const data: MapServicesData = { services };
      this.dialog.open(MapServicesDialogComponent, { data, maxWidth: '640px' }).afterClosed().subscribe(done => {
        if (!done) return;
        grid?.selection.clear();
        grid?.refresh();
        this.loadNetworks();
      });
    };
    if (selected && grid) { open(grid.selection.rows()); return; }
    grid?.bulkBusy.set(true);
    this.tvh.getGrid('mpegts/service/grid').subscribe({
      next: rows => {
        grid?.bulkBusy.set(false);
        const unmapped = rows.filter((s: any) => !(Array.isArray(s?.channel) ? s.channel.length : s?.channel));
        if (!unmapped.length) { this.snack.open('Every service is already on a channel', undefined, { duration: 4000 }); return; }
        open(unmapped);
      },
      error: err => { grid?.bulkBusy.set(false); this.snack.open(`Couldn’t load services (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }); },
    });
  }

  // ---------------------------------------------------------------- tabs

  /** Switching tabs keeps the editor open, so unsaved edits aren't lost. */
  onTabChange(index: number): void {
    this.tabIndex.set(index);
  }

  tabFor(id: TabId): GridTab | undefined {
    return GRID_TABS.find(t => t.id === id);
  }

  // ---------------------------------------------------------------- tuners tree

  loadTreeRoot(): void {
    this.treeLoading.set(true);
    this.treeError.set('');
    this.tvh.getTree('hardware/tree').subscribe({
      next: nodes => {
        this.tree.set(nodes.map(n => this.toTreeRow(n, 0)));
        this.treeLoading.set(false);
        // Adapters usually have one or two frontends: open the first level so tuners are visible at once.
        for (const row of this.tree()) {
          if (!row.leaf) this.toggle(row);
        }
      },
      error: err => {
        this.treeLoading.set(false);
        this.treeError.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load tuner hardware (${err?.status || 'network error'}).`);
      },
    });
  }

  private toTreeRow(n: { uuid: string; text: string; leaf: boolean }, depth: number): TreeRow {
    return { uuid: n.uuid, text: n.text, leaf: n.leaf, depth, expanded: false, loading: false };
  }

  toggle(row: TreeRow, event?: Event): void {
    event?.stopPropagation();
    if (row.leaf) return;
    if (row.expanded) {
      // Collapse: drop every descendant that follows it.
      this.tree.update(rows => {
        const i = rows.findIndex(r => r.uuid === row.uuid);
        let end = i + 1;
        while (end < rows.length && rows[end].depth > row.depth) end++;
        const next = [...rows];
        next.splice(i + 1, end - i - 1);
        next[i] = { ...next[i], expanded: false };
        return next;
      });
      return;
    }
    this.patchTreeRow(row.uuid, { loading: true });
    this.tvh.getTree('hardware/tree', row.uuid).subscribe({
      next: children => this.tree.update(rows => {
        const i = rows.findIndex(r => r.uuid === row.uuid);
        if (i < 0) return rows;
        const next = [...rows];
        next[i] = { ...next[i], expanded: true, loading: false };
        next.splice(i + 1, 0, ...children.map(c => this.toTreeRow(c, row.depth + 1)));
        return next;
      }),
      error: () => this.patchTreeRow(row.uuid, { loading: false }),
    });
  }

  private patchTreeRow(uuid: string, patch: Partial<TreeRow>): void {
    this.tree.update(rows => rows.map(r => r.uuid === uuid ? { ...r, ...patch } : r));
  }

  // ---------------------------------------------------------------- selection

  selectTreeRow(row: TreeRow): void {
    this.open({ tab: 'tuners', uuid: row.uuid, label: row.text });
  }

  selectGridRow(tab: GridTab, row: any): void {
    this.open({ tab: tab.id, uuid: String(row?.uuid || ''), label: String(row?.[tab.nameField] || row?.uuid || '') });
  }

  newNetwork(builder: { class: string; caption: string }): void {
    this.open({ tab: 'networks', uuid: null, label: builder.caption, createClass: builder.class });
  }

  private open(sel: Selection): void {
    const current = this.selection();
    if (current && !sel.bulkUuids && !current.bulkUuids && !sel.createVia && !current.createVia
        && current.uuid === sel.uuid && current.createClass === sel.createClass) return;
    this.confirmDiscard().subscribe(ok => { if (ok) this.selection.set(sel); });
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => { if (ok) this.selection.set(null); });
  }

  onSaved(event: { uuid: string | null; created: boolean; bulk?: BulkResult }): void {
    const sel = this.selection();
    if (event.bulk && sel) {
      const tab = this.tabFor(sel.tab);
      this.snack.open(describeBulk('Updated', event.bulk, ...(tab?.noun || ['item', 'items'] as [string, string])),
        undefined, { duration: 4000 });
      this.selection.set(null); // rows stay selected for another round
      this.grid?.refresh();
      return;
    }
    if (event.created && sel?.createVia) {
      this.snack.open(`Mux added to ${sel.networkName} — Tvheadend will scan it for services`, undefined, { duration: 5000 });
      this.selection.set(event.uuid ? { tab: 'muxes', uuid: event.uuid, label: '' } : null);
      this.refreshActive();
      return;
    }
    this.snack.open(event.created ? 'Network created' : 'Saved', undefined, { duration: 3000 });
    if (event.created && sel) {
      this.selection.set(event.uuid ? { tab: sel.tab, uuid: event.uuid, label: '' } : null);
    }
    this.refreshActive();
  }

  private refreshActive(): void {
    if (this.activeTab() === 'tuners') {
      this.loadTreeRoot();
    } else {
      this.grid?.refresh();
    }
  }

  // ---------------------------------------------------------------- actions

  scan(): void {
    const sel = this.selection();
    if (!sel?.uuid) return;
    this.tvh.scanNetwork(sel.uuid).subscribe({
      next: () => {
        this.snack.open(`Scan queued for “${sel.label}”`, undefined, { duration: 4000 });
        this.grid?.refresh();
      },
      error: err => this.snack.open(`Couldn’t start scan (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
    });
  }

  confirmDelete(): void {
    const sel = this.selection();
    const tab = sel ? this.tabFor(sel.tab) : undefined;
    if (!sel?.uuid || !tab) return;
    const noun = tab.label.slice(0, -1).toLowerCase();
    const data: ConfirmDialogData = {
      title: `Delete ${noun}?`,
      message: `“${sel.label}” will be deleted. ${tab.deleteWarning}`,
      confirm: 'Delete',
      destructive: true,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.tvh.idnodeDelete(sel.uuid!).subscribe({
        next: () => {
          this.snack.open(`Deleted “${sel.label}”`, undefined, { duration: 3000 });
          this.selection.set(null);
          this.grid?.refresh();
        },
        error: err => this.snack.open(`Delete failed (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
      });
    });
  }

  // ---------------------------------------------------------------- bulk actions

  /** Open the editor in bulk mode for every selected row. */
  bulkEdit(tab: GridTab): void {
    const grid = this.grid;
    if (!grid) return;
    const uuids = grid.selection.keys();
    if (!uuids.length) return;
    const [one, many] = tab.noun;
    this.open({ tab: tab.id, uuid: null, label: `Edit ${uuids.length} ${uuids.length === 1 ? one : many}`, bulkUuids: uuids });
  }

  /** Enable or disable every selected mux/service. 1/0 works for both bool and the mux enable enum. */
  bulkSetEnabled(tab: GridTab, enabled: boolean): void {
    const grid = this.grid;
    if (!grid) return;
    const uuids = grid.selection.keys();
    grid.bulkBusy.set(true);
    runBulk(uuids, uuid => this.tvh.idnodeSave(uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, ...tab.noun), undefined, { duration: 4000 });
      if (!result.failed) grid.selection.clear();
      grid.refresh();
      this.reloadEditorIfSelected(uuids);
    });
  }

  bulkScan(tab: GridTab): void {
    const grid = this.grid;
    if (!grid) return;
    grid.bulkBusy.set(true);
    runBulk(grid.selection.keys(), uuid => this.tvh.scanNetwork(uuid)).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk('Queued scans for', result, ...tab.noun), undefined, { duration: 4000 });
      grid.refresh();
    });
  }

  bulkDelete(tab: GridTab): void {
    const grid = this.grid;
    if (!grid) return;
    const rows = grid.selection.rows();
    const [one, many] = tab.noun;
    const names = rows.slice(0, 3).map(r => `“${r?.[tab.nameField] || r?.uuid}”`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');
    const data: ConfirmDialogData = {
      title: `Delete ${rows.length} ${rows.length === 1 ? one : many}?`,
      message: `${names} will be deleted. ${tab.deleteWarning}`,
      confirm: 'Delete',
      destructive: true,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      grid.bulkBusy.set(true);
      const uuids = rows.map(r => String(r.uuid));
      runBulk(uuids, uuid => this.tvh.idnodeDelete(uuid)).subscribe(result => {
        grid.bulkBusy.set(false);
        this.snack.open(describeBulk('Deleted', result, one, many), undefined, { duration: 4000 });
        grid.selection.clear();
        if (this.selection()?.uuid && uuids.includes(this.selection()!.uuid!)) this.selection.set(null);
        grid.refresh();
      });
    });
  }

  /** If the open editor shows one of the changed rows, reload it so it isn't stale. */
  private reloadEditorIfSelected(uuids: string[]): void {
    const open = this.selection()?.uuid;
    if (open && uuids.includes(open)) this.editor?.load();
  }

  private confirmDiscard(): Observable<boolean> {
    if (!this.editor?.hasUnsavedChanges()) return of(true);
    const data: ConfirmDialogData = {
      title: 'Discard changes?', message: 'You have unsaved changes.', confirm: 'Discard', destructive: true,
    };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }
}
