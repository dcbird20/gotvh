import { ConnectionsComponent } from '../../shared/connections.component';
import { Component, DestroyRef, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { BulkResult, describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';
import { ReorderTag, ReorderTagsDialogComponent } from './reorder-tags-dialog.component';
import { SplitHandleDirective } from '../../shared/split-handle.directive';

interface TagRow {
  uuid: string;
  name: string;
  index: number;
  enabled: boolean;
  internal: boolean;
  private: boolean;
  visibility: string;
  channels: number;
  enabledChannels: number;
  rules: string[];
  users: string[];
  usedIn: string;
  comment: string;
}

type Editor = { uuid: string | null; creating?: boolean; bulkUuids?: string[] } | null;

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const on = (v: unknown) => truthy(v) || v === 'true';
const userLabel = (a: any) => { const u = String(a?.username ?? '').trim(); return u && u !== '*' ? u : 'Anyone'; };

/**
 * Channel tags: groups of channels shown to clients (Kodi, the TV app),
 * used by auto-record rules and user access to limit which channels apply.
 */
@Component({
  selector: 'admin-channel-tags',
  standalone: true,
  imports: [SplitHandleDirective, ConnectionsComponent, 
    RouterLink, MatButtonModule, MatIconModule, MatTooltipModule, MatProgressBarModule, MatDialogModule, MatSnackBarModule,
    MatFormFieldModule, MatSelectModule, IdnodeGridComponent, IdnodeFormComponent,
  ],
  templateUrl: './channel-tags.component.html',
  styleUrl: './channel-tags.component.scss',
})
export class ChannelTagsComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('tagGrid') grid?: IdnodeGridComponent;
  @ViewChild('tagForm') form?: IdnodeFormComponent;

  readonly loading = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly editor = signal<Editor>(null);
  readonly fShow = signal<'all' | 'empty' | 'hidden' | 'private' | 'disabled'>('all');

  private readonly tags = signal<any[]>([]);
  private readonly channels = signal<any[]>([]);
  private readonly rules = signal<any[]>([]);
  private readonly access = signal<any[]>([]);

  readonly rows = computed<TagRow[]>(() => {
    const channels = this.channels(), rules = this.rules(), access = this.access();
    return this.tags().map(t => {
      const uuid = String(t.uuid);
      const tagged = channels.filter(c => (Array.isArray(c?.tags) ? c.tags : []).map(String).includes(uuid));
      const ruleNames = rules.filter(r => String(r?.tag || '') === uuid)
        .map(r => String(r?.name || r?.title || '').trim() || '(unnamed rule)');
      const userNames = access.filter(a => (Array.isArray(a?.channel_tag) ? a.channel_tag : []).map(String).includes(uuid))
        .map(userLabel);
      const internal = on(t.internal), priv = on(t.private);
      return {
        uuid, name: String(t.name || '').trim() || '(no name)',
        index: Number(t.index) || 0,
        enabled: on(t.enabled), internal, private: priv,
        visibility: internal ? 'Hidden from clients' : priv ? 'Private' : 'Shown',
        channels: tagged.length,
        enabledChannels: tagged.filter(c => on(c?.enabled)).length,
        rules: ruleNames, users: userNames,
        usedIn: [ruleNames.length ? plural(ruleNames.length, 'rule') : '', userNames.length ? plural(userNames.length, 'user') : '']
          .filter(Boolean).join(', '),
        comment: String(t.comment || ''),
      };
    });
  });

  readonly untaggedChannels = computed(() =>
    this.channels().filter(c => !(Array.isArray(c?.tags) && c.tags.length)).length);

  readonly rowFilter = computed(() => {
    const show = this.fShow();
    if (show === 'all') return null;
    return (r: TagRow) => show === 'empty' ? r.channels === 0 : show === 'hidden' ? r.internal
      : show === 'private' ? r.private : !r.enabled;
  });

  readonly selected = computed(() => this.rows().find(r => r.uuid === this.editor()?.uuid) || null);

  private readonly allColumns: GridColumn[] = [
    { id: 'index', label: 'Order', kind: 'num', format: v => v ? String(v) : '—',
      sortValue: r => `${String(r.index > 0 ? r.index : 999999).padStart(6, '0')} ${String(r.name).toLowerCase()}` },
    { id: 'name', label: 'Tag' },
    { id: 'enabled', label: 'Enabled', kind: 'bool' },
    { id: 'channels', label: 'Channels', kind: 'num',
      format: (v, r: TagRow) => v === r.enabledChannels ? String(v) : `${v} (${r.enabledChannels} enabled)` },
    { id: 'visibility', label: 'Visibility' },
    { id: 'usedIn', label: 'Limits', format: v => v || '—' },
    { id: 'comment', label: 'Comment' },
  ];
  readonly columns = computed(() => this.editor()
    ? this.allColumns.filter(c => ['index', 'name', 'enabled', 'channels'].includes(c.id)) : this.allColumns);

  ngOnInit(): void {
    this.load();
    // /channel-tags?open=<uuid> (from a Connected to link)
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(q => {
      const open = q.get('open');
      if (open) this.clearDeepLink();
      if (open && open !== this.editor()?.uuid) this.confirmDiscard().subscribe(ok => ok && this.editor.set({ uuid: open }));
    });
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    forkJoin({
      tags: this.tvh.getGrid('channeltag/grid', { all: 1 }),
      channels: this.tvh.getGrid('channel/grid', { all: 1 }).pipe(catchError(() => of([]))),
      rules: this.tvh.getGrid('dvr/autorec/grid').pipe(catchError(() => of([]))),
      access: this.tvh.getGrid('access/entry/grid').pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ tags, channels, rules, access }) => {
        this.tags.set(tags);
        this.channels.set(channels);
        this.rules.set(rules);
        this.access.set(access);
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.error.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load channel tags (${err?.status || 'network error'}).`);
      },
    });
  }

  // ---------------------------------------------------------------- editor

  open(row: TagRow): void {
    if (row.uuid === this.editor()?.uuid) return;
    this.confirmDiscard().subscribe(ok => ok && this.editor.set({ uuid: row.uuid }));
  }

  create(): void {
    this.confirmDiscard().subscribe(ok => ok && this.editor.set({ uuid: null, creating: true }));
  }

  bulkEdit(): void {
    const uuids = this.grid?.selection.keys() || [];
    if (!uuids.length) return;
    this.confirmDiscard().subscribe(ok => ok && this.editor.set({ uuid: null, bulkUuids: uuids }));
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => ok && this.editor.set(null));
  }

  onSaved(event: { uuid: string | null; created: boolean; bulk?: BulkResult }): void {
    this.snack.open(event.bulk ? describeBulk('Updated', event.bulk, 'tag') : event.created ? 'Tag created' : 'Tag saved',
      undefined, { duration: 3000 });
    if (event.created) this.editor.set(event.uuid ? { uuid: event.uuid } : null);
    if (event.bulk) { this.editor.set(null); this.grid?.selection.clear(); }
    this.load();
  }

  channelSummary(t: TagRow): string {
    const base = `${t.channels} ${t.channels === 1 ? 'channel has' : 'channels have'} this tag`;
    return t.enabledChannels === t.channels ? `${base}.` : `${base} (${t.enabledChannels} enabled).`;
  }

  editorTitle(): string {
    const ed = this.editor();
    if (ed?.bulkUuids) return `Edit ${plural(ed.bulkUuids.length, 'tag')}`;
    if (ed?.creating) return 'New channel tag';
    return this.selected()?.name || 'Channel tag';
  }

  // ---------------------------------------------------------------- order

  reorder(): void {
    const ordered = [...this.rows()].sort((a, b) =>
      (a.index > 0 ? a.index : 1e9) - (b.index > 0 ? b.index : 1e9) || a.name.localeCompare(b.name));
    const data: ReorderTag[] = ordered.map(r => ({ uuid: r.uuid, name: r.name, hidden: r.internal }));
    this.dialog.open<ReorderTagsDialogComponent, ReorderTag[], string[]>(ReorderTagsDialogComponent, { data, maxHeight: '90vh' })
      .afterClosed().subscribe(uuids => {
        if (!uuids) return;
        const current = new Map(this.rows().map(r => [r.uuid, r.index]));
        const changes = uuids.map((uuid, i) => ({ uuid, index: i + 1 })).filter(c => current.get(c.uuid) !== c.index);
        if (!changes.length) return;
        this.busy.set(true);
        runBulk(changes, c => this.tvh.idnodeSave(c.uuid, { index: c.index })).subscribe(result => {
          this.busy.set(false);
          this.snack.open(result.failed ? describeBulk('Reordered', result, 'tag') : 'Tag order saved', undefined, { duration: 3000 });
          this.load();
          this.form?.load();
        });
      });
  }

  // ---------------------------------------------------------------- bulk enable / delete

  bulkSetEnabled(enabled: boolean): void {
    const grid = this.grid;
    if (!grid) return;
    const rows: TagRow[] = grid.selection.rows();
    grid.bulkBusy.set(true);
    runBulk(rows, r => this.tvh.idnodeSave(r.uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, 'tag'), undefined, { duration: 4000 });
      grid.selection.clear();
      this.load();
    });
  }

  deleteTags(rows: TagRow[]): void {
    if (!rows.length) return;
    const names = rows.slice(0, 3).map(r => `“${r.name}”`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');
    const channels = rows.reduce((n, r) => n + r.channels, 0);
    const rules = [...new Set(rows.flatMap(r => r.rules))];
    const users = [...new Set(rows.flatMap(r => r.users))];
    const lines = [
      channels ? `${plural(channels, 'channel')} will lose the tag (the channels themselves stay).` : 'No channels have this tag.',
      rules.length ? `⚠ ${plural(rules.length, 'auto-record rule')} limited to ${rows.length === 1 ? 'this tag' : 'these tags'} `
        + `(${rules.slice(0, 4).join(', ')}${rules.length > 4 ? ' …' : ''}) will match every channel instead — edit or delete those rules first.` : '',
      users.length ? `⚠ ${plural(users.length, 'user')} (${users.slice(0, 4).join(', ')}${users.length > 4 ? ' …' : ''}) ${users.length === 1 ? 'has' : 'have'} `
        + `${rows.length === 1 ? 'this tag' : 'these tags'} in their access rules, so what they can watch may change.` : '',
    ].filter(Boolean);
    this.confirm(`Delete ${plural(rows.length, 'tag')}?`, `${names} will be removed. ${lines.join(' ')}`, 'Delete')
      .subscribe(ok => {
        if (!ok) return;
        this.busy.set(true);
        runBulk(rows, r => this.tvh.idnodeDelete(r.uuid)).subscribe(result => {
          this.busy.set(false);
          this.snack.open(describeBulk('Deleted', result, 'tag'), undefined, { duration: 4000 });
          this.grid?.selection.clear();
          if (rows.some(r => r.uuid === this.editor()?.uuid)) this.editor.set(null);
          this.load();
        });
      });
  }

  selectedRows(): TagRow[] {
    return this.grid?.selection.rows() || [];
  }

  // ---------------------------------------------------------------- helpers

  private confirm(title: string, message: string, confirm: string): Observable<boolean> {
    const data: ConfirmDialogData = { title, message, confirm, destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }

  private confirmDiscard(): Observable<boolean> {
    if (!this.form?.hasUnsavedChanges()) return of(true);
    return this.confirm('Discard changes?', 'You have unsaved changes.', 'Discard');
  }

  /** Drop ?open= once handled, so following the same link again still works. */
  private clearDeepLink(): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { open: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
