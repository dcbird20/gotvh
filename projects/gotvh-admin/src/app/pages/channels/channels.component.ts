import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { BulkResult, describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent, formatIntsplit } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';

type YesNo = 'all' | 'yes' | 'no';
type ServiceCount = 'all' | 'none' | 'one' | 'many';

/** Special filter values. */
const NO_TAGS = '__none';
const NO_NETWORK = '__none';

interface EditorState {
  uuid: string | null;
  creating?: boolean;
  bulkUuids?: string[];
  title: string;
}

/**
 * Channels: list, edit, create, delete — and change settings on many channels
 * at once (select rows → Edit…). Mapping services to channels is a separate job
 * (not built yet); new channels can be linked to services in the editor.
 */
@Component({
  selector: 'admin-channels',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatDialogModule, MatSnackBarModule, MatFormFieldModule, MatSelectModule,
    MatTooltipModule, IdnodeGridComponent, IdnodeFormComponent],
  template: `
    <div class="admin-page wide">
      <h1>Channels</h1>
      <p class="subtitle">Channel numbers, names, tags and which services feed them. Select several to change a setting on all of them.</p>

      <div class="filters" role="group" aria-label="Filter channels">
        <mat-form-field appearance="outline" class="f-small">
          <mat-label>Enabled</mat-label>
          <mat-select [value]="fEnabled()" (valueChange)="fEnabled.set($event)">
            <mat-option value="all">Any</mat-option>
            <mat-option value="yes">Enabled</mat-option>
            <mat-option value="no">Disabled</mat-option>
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline" class="f-wide">
          <mat-label>Tags (any of)</mat-label>
          <mat-select multiple [value]="fTags()" (valueChange)="fTags.set($event)">
            <mat-option [value]="NO_TAGS"><em>No tags</em></mat-option>
            @for (t of tagOptions(); track t.uuid) { <mat-option [value]="t.uuid">{{ t.name }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline" class="f-wide"
                        [matTooltip]="networksError() ? 'Couldn’t load services, so channels can’t be matched to networks' : ''">
          <mat-label>Network</mat-label>
          <mat-select [value]="fNetwork()" (valueChange)="fNetwork.set($event)" [disabled]="!servicesLoaded()">
            <mat-option value="">Any</mat-option>
            <mat-option [value]="NO_NETWORK"><em>No services</em></mat-option>
            @for (n of networkOptions(); track n) { <mat-option [value]="n">{{ n }}</mat-option> }
          </mat-select>
          @if (!servicesLoaded() && !networksError()) { <mat-hint>Loading…</mat-hint> }
        </mat-form-field>
        <mat-form-field appearance="outline" class="f-small"
                        matTooltip="Over-the-air channels can get guide data from their service even with no EPG source set">
          <mat-label>EPG source</mat-label>
          <mat-select [value]="fEpg()" (valueChange)="fEpg.set($event)">
            <mat-option value="all">Any</mat-option>
            <mat-option value="yes">Set</mat-option>
            <mat-option value="no">Not set</mat-option>
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline" class="f-small">
          <mat-label>Services</mat-label>
          <mat-select [value]="fServices()" (valueChange)="fServices.set($event)">
            <mat-option value="all">Any</mat-option>
            <mat-option value="none">None</mat-option>
            <mat-option value="one">Exactly one</mat-option>
            <mat-option value="many">More than one</mat-option>
          </mat-select>
        </mat-form-field>
        @if (activeFilters()) {
          <button mat-button (click)="clearFilters()"><mat-icon>filter_alt_off</mat-icon> Clear {{ activeFilters() }} {{ activeFilters() === 1 ? 'filter' : 'filters' }}</button>
        }
      </div>

      <div class="layout" [class.with-editor]="!!editor()">
        <admin-idnode-grid
          path="channel/grid" [columns]="columns()" filterField="name" filterLabel="Search name or number"
          [clientSide]="true" [searchFields]="['name', 'number']" [rowFilter]="rowFilter()"
          [defaultSort]="{ active: 'number', direction: 'asc' }" [selectedUuid]="editor()?.uuid ?? null"
          emptyText="No channels yet. Map services from a scanned network, or add one."
          (rowClick)="open({ uuid: $event.uuid, title: $event.name || 'Channel' })">
          <button mat-flat-button (click)="openNew()"><mat-icon>add</mat-icon> New channel</button>

          <ng-container ngProjectAs="[bulkActions]">
            <button mat-button (click)="bulkEdit()"><mat-icon>edit</mat-icon> Edit…</button>
            <button mat-button (click)="bulkSetEnabled(true)">Enable</button>
            <button mat-button (click)="bulkSetEnabled(false)">Disable</button>
            <button mat-button class="danger-text" (click)="bulkDelete()"><mat-icon>delete</mat-icon> Delete</button>
          </ng-container>
        </admin-idnode-grid>

        @if (editor(); as e) {
          <admin-idnode-form
            [uuid]="e.uuid" [bulkUuids]="e.bulkUuids || null"
            [createPath]="e.creating ? 'channel' : null" [title]="e.title"
            (saved)="onSaved($event)" (closed)="close()">
            @if (e.uuid) {
              <button formExtraActions mat-button type="button" class="danger-text" (click)="deleteOne(e)">Delete</button>
            }
          </admin-idnode-form>
        }
      </div>
    </div>
  `,
  styles: [`
    .wide { max-width: none; }
    .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 8px; }
    .f-small { width: 150px; }
    .f-wide { width: 240px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    .layout.with-editor { grid-template-columns: minmax(0, 1fr) 460px; }
    .danger-text { color: var(--mat-sys-error); }
    @media (max-width: 1100px) { .layout.with-editor { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class ChannelsComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild(IdnodeGridComponent) grid?: IdnodeGridComponent;
  @ViewChild(IdnodeFormComponent) form?: IdnodeFormComponent;

  readonly editor = signal<EditorState | null>(null);
  private readonly tagNames = signal(new Map<string, string>());

  readonly NO_TAGS = NO_TAGS;
  readonly NO_NETWORK = NO_NETWORK;

  // ---- filters
  readonly fEnabled = signal<YesNo>('all');
  readonly fTags = signal<string[]>([]);
  readonly fNetwork = signal('');
  readonly fServices = signal<ServiceCount>('all');
  readonly fEpg = signal<YesNo>('all');

  /** Guide channel uuid → short name, for the EPG source column. */
  private readonly epgNames = signal(new Map<string, string>());

  /** Service uuid → network name, for the Network column and filter. */
  private readonly serviceNetwork = signal(new Map<string, string>());
  readonly servicesLoaded = signal(false);
  readonly networksError = signal(false);
  private readonly networkNames = signal<string[]>([]);

  readonly tagOptions = computed(() => [...this.tagNames()]
    .map(([uuid, name]) => ({ uuid, name }))
    .sort((a, b) => a.name.localeCompare(b.name)));

  readonly networkOptions = computed(() => {
    const names = new Set([...this.networkNames(), ...this.serviceNetwork().values()]);
    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
  });

  readonly activeFilters = computed(() =>
    Number(this.fEnabled() !== 'all') + Number(this.fTags().length > 0)
    + Number(!!this.fNetwork()) + Number(this.fServices() !== 'all') + Number(this.fEpg() !== 'all'));

  /** Handed to the grid; a new function whenever a filter changes, so the grid re-filters. */
  readonly rowFilter = computed(() => {
    const enabled = this.fEnabled(), tags = this.fTags(), network = this.fNetwork(), count = this.fServices(), epg = this.fEpg();
    const svcNet = this.serviceNetwork();
    if (enabled === 'all' && !tags.length && !network && count === 'all' && epg === 'all') return null;
    const wantNoTags = tags.includes(NO_TAGS);
    const wantTags = new Set(tags.filter(t => t !== NO_TAGS));
    return (r: any): boolean => {
      if (enabled !== 'all' && (truthy(r?.enabled) || r?.enabled === 'true') !== (enabled === 'yes')) return false;
      const rowTags: string[] = Array.isArray(r?.tags) ? r.tags.map(String) : [];
      if (tags.length && !((wantNoTags && !rowTags.length) || rowTags.some(t => wantTags.has(t)))) return false;
      const services: string[] = Array.isArray(r?.services) ? r.services.map(String) : [];
      if (count === 'none' && services.length) return false;
      if (count === 'one' && services.length !== 1) return false;
      if (count === 'many' && services.length < 2) return false;
      if (network === NO_NETWORK && services.length) return false;
      if (network && network !== NO_NETWORK && !services.some(s => svcNet.get(s) === network)) return false;
      if (epg !== 'all' && (Array.isArray(r?.epggrab) && r.epggrab.length > 0) !== (epg === 'yes')) return false;
      return true;
    };
  });

  clearFilters(): void {
    this.fEnabled.set('all');
    this.fTags.set([]);
    this.fNetwork.set('');
    this.fServices.set('all');
    this.fEpg.set('all');
  }

  private epgLabel(row: any): string {
    const names = this.epgNames();
    return (Array.isArray(row?.epggrab) ? row.epggrab : []).map((u: unknown) => names.get(String(u)) || '?').join(', ');
  }

  /** Network names of a channel's services (usually one). */
  networksOf(row: any): string[] {
    const svcNet = this.serviceNetwork();
    const services: string[] = Array.isArray(row?.services) ? row.services.map(String) : [];
    return [...new Set(services.map(s => svcNet.get(s)).filter((n): n is string => !!n))].sort();
  }

  private tagLabel(row: any): string {
    const tags = this.tagNames();
    return (Array.isArray(row?.tags) ? row.tags : []).map((u: unknown) => tags.get(String(u)) || '?').join(', ');
  }

  readonly columns = computed<GridColumn[]>(() => {
    this.tagNames(); this.serviceNetwork(); this.servicesLoaded(); this.epgNames(); // re-render when lookups arrive
    const base: GridColumn[] = [
      // Tvheadend sends channel numbers ready to show: 100, or "3.1" for major.minor.
      { id: 'number', label: '#', kind: 'num', format: (v: unknown) => (v === 0 || v === '0' || v === '' || v == null) ? '—' : formatIntsplit(v),
        sortValue: r => (r?.number === 0 || r?.number === '0' || r?.number == null) ? null : String(r.number) }, // "3.2" < "3.10" < 100; no number last
      { id: 'name', label: 'Channel' },
      { id: 'enabled', label: 'Enabled', kind: 'bool' },
    ];
    if (this.editor()) return base; // narrower while editing
    return base.concat([
      {
        id: 'tags', label: 'Tags',
        format: (_v: unknown, r: any) => this.tagLabel(r) || '—',
        sortValue: r => this.tagLabel(r),
      },
      {
        id: 'network', label: 'Network',
        format: (_v: unknown, r: any) => this.networksOf(r).join(', ') || (this.servicesLoaded() ? '—' : '…'),
        sortValue: r => this.networksOf(r).join(', '),
      },
      {
        id: 'epggrab', label: 'EPG source',
        format: (_v: unknown, r: any) => this.epgLabel(r) || '—',
        sortValue: r => this.epgLabel(r),
      },
      {
        id: 'services', label: 'Services', kind: 'num',
        format: (v: unknown) => String(Array.isArray(v) ? v.length : 0),
        sortValue: r => (Array.isArray(r?.services) ? r.services.length : 0),
      },
    ]);
  });

  ngOnInit(): void {
    this.tvh.getChannelTags().subscribe(tags =>
      this.tagNames.set(new Map(tags.map((t: any) => [String(t?.uuid || ''), String(t?.name || '')]))));
    // Channels only list service uuids; the services list says which network each is on.
    this.tvh.getGrid('mpegts/service/grid', { limit: 100000 }).subscribe({
      next: services => {
        this.serviceNetwork.set(new Map(services.map((s: any) => [String(s?.uuid || ''), String(s?.network || '')])));
        this.servicesLoaded.set(true);
      },
      error: () => this.networksError.set(true),
    });
    // Guide channel titles look like "WPSU: I10123.json.schedulesdirect.org (Schedules Direct)".
    this.tvh.idnodeEnumOptions({ type: 'api', uri: 'epggrab/channel/list', params: { enum: 1 } }).subscribe({
      next: opts => this.epgNames.set(new Map(opts.map(o => {
        const m = /^(.*?):\s.*\(([^)]+)\)\s*$/.exec(o.label);
        return [String(o.value), m ? `${m[1]} (${m[2]})` : o.label] as [string, string];
      }))),
      error: () => { /* column shows "?" */ },
    });
    this.tvh.getGrid('mpegts/network/grid').subscribe({
      next: nets => this.networkNames.set(nets.map((n: any) => String(n?.networkname || '')).filter(Boolean)),
      error: () => { /* names still come from services */ },
    });
  }

  // ---------------------------------------------------------------- editor

  open(state: EditorState): void {
    const cur = this.editor();
    if (cur && !cur.bulkUuids && !state.bulkUuids && cur.uuid === state.uuid && !!cur.creating === !!state.creating) return;
    this.confirmDiscard().subscribe(ok => { if (ok) this.editor.set(state); });
  }

  openNew(): void {
    this.open({ uuid: null, creating: true, title: 'New channel' });
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => { if (ok) this.editor.set(null); });
  }

  onSaved(event: { uuid: string | null; created: boolean; bulk?: BulkResult }): void {
    if (event.bulk) {
      this.snack.open(describeBulk('Updated', event.bulk, 'channel'), undefined, { duration: 4000 });
      this.editor.set(null);
    } else if (event.created) {
      this.snack.open('Channel created', undefined, { duration: 3000 });
      this.editor.set(event.uuid ? { uuid: event.uuid, title: '' } : null);
    } else {
      this.snack.open('Channel saved', undefined, { duration: 3000 });
    }
    this.grid?.refresh();
  }

  // ---------------------------------------------------------------- bulk

  bulkEdit(): void {
    const uuids = this.grid?.selection.keys() || [];
    if (!uuids.length) return;
    this.open({ uuid: null, bulkUuids: uuids, title: `Edit ${uuids.length} ${uuids.length === 1 ? 'channel' : 'channels'}` });
  }

  bulkSetEnabled(enabled: boolean): void {
    const grid = this.grid;
    if (!grid) return;
    grid.bulkBusy.set(true);
    runBulk(grid.selection.keys(), uuid => this.tvh.idnodeSave(uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, 'channel'), undefined, { duration: 4000 });
      if (!result.failed) grid.selection.clear();
      grid.refresh();
    });
  }

  bulkDelete(): void {
    const grid = this.grid;
    if (!grid) return;
    const rows = grid.selection.rows();
    this.confirmDelete(rows.map(r => ({ uuid: String(r.uuid), name: String(r.name || r.uuid) })));
  }

  deleteOne(e: EditorState): void {
    if (e.uuid) this.confirmDelete([{ uuid: e.uuid, name: e.title || 'this channel' }]);
  }

  private confirmDelete(items: Array<{ uuid: string; name: string }>): void {
    const names = items.slice(0, 3).map(i => `“${i.name}”`).join(', ') + (items.length > 3 ? ` and ${items.length - 3} more` : '');
    const data: ConfirmDialogData = {
      title: `Delete ${items.length} ${items.length === 1 ? 'channel' : 'channels'}?`,
      message: `${names} will be removed. Scheduled recordings and auto-record rules on them stop working.`,
      confirm: 'Delete',
      destructive: true,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.grid?.bulkBusy.set(true);
      const uuids = items.map(i => i.uuid);
      runBulk(uuids, uuid => this.tvh.idnodeDelete(uuid)).subscribe(result => {
        this.grid?.bulkBusy.set(false);
        this.snack.open(describeBulk('Deleted', result, 'channel'), undefined, { duration: 4000 });
        this.grid?.selection.clear();
        const open = this.editor();
        if (open && (uuids.includes(open.uuid || '') || open.bulkUuids)) this.editor.set(null);
        this.grid?.refresh();
      });
    });
  }

  private confirmDiscard(): Observable<boolean> {
    if (!this.form?.hasUnsavedChanges()) return of(true);
    const data: ConfirmDialogData = { title: 'Discard changes?', message: 'You have unsaved changes.', confirm: 'Discard', destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }
}
