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
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';

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
  imports: [
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

  readonly editorTitle = computed(() => {
    const s = this.selection();
    if (!s) return '';
    if (!s.createClass) return s.label; // '' → the editor shows the object's own name
    return /network$/i.test(s.label) ? `New ${s.label}` : `New ${s.label} network`;
  });

  ngOnInit(): void {
    this.loadTreeRoot();
    this.tvh.getBuilders('mpegts/network').subscribe({
      next: b => this.builders.set([...b].sort((x, y) => x.caption.localeCompare(y.caption))),
      error: () => this.builders.set([]),
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
    if (current && current.uuid === sel.uuid && current.createClass === sel.createClass) return;
    this.confirmDiscard().subscribe(ok => { if (ok) this.selection.set(sel); });
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => { if (ok) this.selection.set(null); });
  }

  onSaved(event: { uuid: string | null; created: boolean }): void {
    const sel = this.selection();
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

  private confirmDiscard(): Observable<boolean> {
    if (!this.editor?.hasUnsavedChanges()) return of(true);
    const data: ConfirmDialogData = {
      title: 'Discard changes?', message: 'You have unsaved changes.', confirm: 'Discard', destructive: true,
    };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }
}
