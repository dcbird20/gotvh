import { broadcastMuxesWithChannels, primeAndGrab } from '../../shared/ota-guide';
import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Observable, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { BulkResult, describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';
import { MatchChannel, MatchGuide } from '../../shared/epg-match';
import { EpgMapDialogComponent, EpgMapDialogData, EpgMapPair } from '../../shared/epg-map-dialog.component';
import { SplitHandleDirective } from '../../shared/split-handle.directive';

type Tab = 'grabbers' | 'settings' | 'channels';
const TABS: Tab[] = ['grabbers', 'settings', 'channels'];

interface EditorState {
  tab: Tab;
  uuid: string | null;
  bulkUuids?: string[];
  title: string;
}

/** Module titles look like "Internal: XMLTV: …", "External: …", "Over-the-air: EIT: …". */
function splitModuleTitle(title: string): { type: string; name: string } {
  const m = /^(Internal|External|Over-the-air)\s*:\s*(.*)$/i.exec(String(title || '').trim());
  return m ? { type: m[1][0].toUpperCase() + m[1].slice(1), name: m[2] } : { type: 'Other', name: String(title || '') };
}

/** The module list reports status as e.g. "epggrabmodEnabled" / "epggrabmodNone". */
function moduleEnabled(row: any): boolean {
  return /enabled/i.test(String(row?.status || ''));
}

/**
 * EPG sources: grabber modules (enable, configure, run now), the global
 * grabber settings (cron schedules, OTA options) and the grabbers' channel
 * list with its mapping to Tvheadend channels.
 */
@Component({
  selector: 'admin-epg',
  standalone: true,
  imports: [SplitHandleDirective, 
    MatTabsModule, MatButtonModule, MatButtonToggleModule, MatIconModule, MatFormFieldModule, MatSelectModule,
    MatTooltipModule, MatDialogModule, MatSnackBarModule, NgTemplateOutlet, IdnodeGridComponent, IdnodeFormComponent,
  ],
  template: `
    <div class="admin-page wide">
      <h1>EPG sources</h1>
      <p class="subtitle">Where the programme guide comes from: grabber modules, when they run, and which guide channels feed which of your channels.</p>

      <!-- preserveContent: switching tabs keeps each tab (and any half-finished edit) as it was -->
      <mat-tab-group [selectedIndex]="tabIndex()" (selectedIndexChange)="tabIndex.set($event)" animationDuration="0ms"
                     mat-stretch-tabs="false" mat-align-tabs="start" preserveContent>
        <!-- ============================== grabbers -->
        <mat-tab label="Grabbers">
          <ng-template matTabContent>
            <div class="tab-body layout" adminSplit [class.with-editor]="editor()?.tab === 'grabbers'">
              <div class="main">
                <div class="filters">
                  <mat-button-toggle-group [value]="modShow()" (change)="modShow.set($event.value)" hideSingleSelectionIndicator
                                           aria-label="Which grabbers to show">
                    <mat-button-toggle value="all">All</mat-button-toggle>
                    <mat-button-toggle value="enabled">Enabled</mat-button-toggle>
                    <mat-button-toggle value="disabled">Disabled</mat-button-toggle>
                  </mat-button-toggle-group>
                  <mat-form-field appearance="outline" class="f-small">
                    <mat-label>Type</mat-label>
                    <mat-select [value]="modType()" (valueChange)="modType.set($event)">
                      <mat-option value="">Any</mat-option>
                      @for (t of moduleTypes(); track t) { <mat-option [value]="t">{{ t }}</mat-option> }
                    </mat-select>
                  </mat-form-field>
                </div>
                <admin-idnode-grid #modGrid
                  path="epggrab/module/list" [clientSide]="true" [columns]="moduleColumns"
                  filterField="title" filterLabel="Search grabbers" [rowFilter]="moduleFilter()"
                  [defaultSort]="{ active: 'status', direction: 'asc' }"
                  [selectedUuid]="editor()?.tab === 'grabbers' ? editor()?.uuid ?? null : null"
                  emptyText="Tvheadend reported no EPG grabber modules."
                  (rowsLoaded)="onModulesLoaded($event)"
                  (rowClick)="open({ tab: 'grabbers', uuid: $event.uuid, title: splitTitle($event.title).name })">
                  <button mat-stroked-button (click)="rerunInternal()" [disabled]="running()"
                          matTooltip="Run the enabled internal (XMLTV) grabbers now">
                    <mat-icon>play_arrow</mat-icon> Run internal grabbers
                  </button>
                  <button mat-stroked-button (click)="triggerOta()" [disabled]="running()"
                          matTooltip="Tune the tuners to collect over-the-air guide data now">
                    <mat-icon>settings_input_antenna</mat-icon> Grab over-the-air now
                  </button>
                  <ng-container ngProjectAs="[bulkActions]">
                    <button mat-button (click)="bulkEnable('grabbers', true)">Enable</button>
                    <button mat-button (click)="bulkEnable('grabbers', false)">Disable</button>
                  </ng-container>
                </admin-idnode-grid>
              </div>
              @if (editor()?.tab === 'grabbers') { <ng-container [ngTemplateOutlet]="editorTpl" /> }
            </div>
          </ng-template>
        </mat-tab>

        <!-- ============================== settings -->
        <mat-tab label="Settings">
          <ng-template matTabContent>
            <div class="tab-body settings">
              <admin-idnode-form configPath="epggrab/config" [closable]="false" title="EPG grabber settings"
                                 (saved)="snack.open('EPG settings saved', undefined, { duration: 3000 })" />
            </div>
          </ng-template>
        </mat-tab>

        <!-- ============================== EPG channels -->
        <mat-tab label="EPG channels">
          <ng-template matTabContent>
            <div class="tab-body layout" adminSplit [class.with-editor]="editor()?.tab === 'channels'">
              <div class="main">
                <div class="filters">
                  <mat-form-field appearance="outline" class="f-small">
                    <mat-label>Mapped</mat-label>
                    <mat-select [value]="chMapped()" (valueChange)="chMapped.set($event)">
                      <mat-option value="all">Any</mat-option>
                      <mat-option value="yes">Mapped to a channel</mat-option>
                      <mat-option value="no">Not mapped</mat-option>
                    </mat-select>
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="f-wide">
                    <mat-label>Grabber</mat-label>
                    <mat-select [value]="chModule()" (valueChange)="chModule.set($event)">
                      <mat-option value="">Any</mat-option>
                      @for (m of epgModules(); track m) { <mat-option [value]="m">{{ m }}</mat-option> }
                    </mat-select>
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="f-small">
                    <mat-label>Enabled</mat-label>
                    <mat-select [value]="chEnabled()" (valueChange)="chEnabled.set($event)">
                      <mat-option value="all">Any</mat-option>
                      <mat-option value="yes">Enabled</mat-option>
                      <mat-option value="no">Disabled</mat-option>
                    </mat-select>
                  </mat-form-field>
                </div>
                <admin-idnode-grid #chGrid
                  path="epggrab/channel/grid" [clientSide]="true" [columns]="channelColumns()"
                  filterField="name" [searchFields]="['name', 'id', 'number']" filterLabel="Search name, id or number"
                  [rowFilter]="channelFilter()" [defaultSort]="{ active: 'name', direction: 'asc' }"
                  [selectedUuid]="editor()?.tab === 'channels' ? editor()?.uuid ?? null : null"
                  emptyText="No guide channels yet. They appear after a grabber has run."
                  (rowsLoaded)="onEpgChannelsLoaded($event)"
                  (rowClick)="open({ tab: 'channels', uuid: $event.uuid, title: $event.name || $event.id || 'EPG channel' })">
                  <button mat-flat-button (click)="mapUnmapped()" [disabled]="!unmappedCount() || !allChannels().length"
                          [matTooltip]="unmappedCount() ? 'Propose a channel for each unmapped guide channel, then review' : 'Every guide channel is mapped'">
                    <mat-icon>link</mat-icon> Map {{ unmappedCount() }} unmapped by name…
                  </button>
                  <ng-container ngProjectAs="[bulkActions]">
                    <button mat-button (click)="mapSelected()"><mat-icon>link</mat-icon> Map by name…</button>
                    <button mat-button (click)="bulkEdit('channels')"><mat-icon>edit</mat-icon> Edit…</button>
                    <button mat-button (click)="bulkEnable('channels', true)">Enable</button>
                    <button mat-button (click)="bulkEnable('channels', false)">Disable</button>
                  </ng-container>
                </admin-idnode-grid>
              </div>
              @if (editor()?.tab === 'channels') { <ng-container [ngTemplateOutlet]="editorTpl" /> }
            </div>
          </ng-template>
        </mat-tab>
      </mat-tab-group>
    </div>

    <ng-template #editorTpl>
      @if (editor(); as e) {
        <admin-idnode-form #editorForm [uuid]="e.uuid" [bulkUuids]="e.bulkUuids || null" [title]="e.title"
                           (saved)="onSaved($event)" (closed)="close()" />
      }
    </ng-template>
  `,
  styles: [`
    .wide { max-width: none; }
    .tab-body { padding-top: 16px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    .layout.with-editor { grid-template-columns: minmax(0, 1fr) var(--admin-side-width, 460px); }
    .main { min-width: 0; }
    .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 8px; }
    .f-small { width: 190px; }
    .f-wide { width: 260px; }
    .settings admin-idnode-form { position: static; max-height: none; max-width: 760px; }
    @media (max-width: 1100px) { .layout.with-editor { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class EpgComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  readonly snack = inject(MatSnackBar);

  @ViewChild('modGrid') modGrid?: IdnodeGridComponent;
  @ViewChild('chGrid') chGrid?: IdnodeGridComponent;
  @ViewChild('editorForm') form?: IdnodeFormComponent;

  readonly tabIndex = signal(0);
  readonly editor = signal<EditorState | null>(null);
  readonly running = signal(false);
  readonly splitTitle = splitModuleTitle;

  // ---- grabbers tab
  readonly modShow = signal<'all' | 'enabled' | 'disabled'>('all');
  readonly modType = signal('');
  readonly moduleTypes = signal<string[]>([]);

  readonly moduleColumns: GridColumn[] = [
    {
      id: 'status', label: 'Enabled', kind: 'bool',
      format: (_v, r) => moduleEnabled(r) ? 'Yes' : 'No',
      sortValue: r => moduleEnabled(r) ? 0 : 1, // enabled first
    },
    { id: 'title', label: 'Grabber', format: (v) => splitModuleTitle(v).name, sortValue: r => splitModuleTitle(r?.title).name },
    { id: 'type', label: 'Type', format: (_v, r) => splitModuleTitle(r?.title).type, sortValue: r => splitModuleTitle(r?.title).type },
  ];

  readonly moduleFilter = computed(() => {
    const show = this.modShow(), type = this.modType();
    if (show === 'all' && !type) return null;
    return (r: any) => (show === 'all' || moduleEnabled(r) === (show === 'enabled'))
      && (!type || splitModuleTitle(r?.title).type === type);
  });

  // ---- EPG channels tab
  readonly chMapped = signal<'all' | 'yes' | 'no'>('all');
  readonly chModule = signal('');
  readonly chEnabled = signal<'all' | 'yes' | 'no'>('all');
  readonly epgModules = signal<string[]>([]);
  private readonly channelNames = signal(new Map<string, string>());
  /** Your channels, for proposing matches. */
  readonly allChannels = signal<MatchChannel[]>([]);
  /** Every guide channel from the last load of the EPG channels tab. */
  private readonly epgRows = signal<any[]>([]);
  readonly unmappedCount = computed(() => this.unmappedGuides().length);

  readonly channelColumns = computed<GridColumn[]>(() => {
    const names = this.channelNames();
    const mapped = (r: any) => (Array.isArray(r?.channels) ? r.channels : []).map((u: unknown) => names.get(String(u)) || '?');
    const cols: GridColumn[] = [
      { id: 'name', label: 'Guide channel' },
      { id: 'channels', label: 'Mapped to', format: (_v, r) => mapped(r).join(', ') || '—', sortValue: r => mapped(r).join(', ') },
      { id: 'enabled', label: 'Enabled', kind: 'bool' },
    ];
    if (this.editor()?.tab === 'channels') return cols;
    return [cols[0], { id: 'id', label: 'Guide id', kind: 'mono' }, { id: 'module', label: 'Grabber' }, cols[1], cols[2]];
  });

  readonly channelFilter = computed(() => {
    const mappedSel = this.chMapped(), mod = this.chModule(), en = this.chEnabled();
    if (mappedSel === 'all' && !mod && en === 'all') return null;
    return (r: any) => {
      const isMapped = Array.isArray(r?.channels) && r.channels.length > 0;
      if (mappedSel !== 'all' && isMapped !== (mappedSel === 'yes')) return false;
      if (mod && String(r?.module || '') !== mod) return false;
      if (en !== 'all' && (truthy(r?.enabled) || r?.enabled === 'true') !== (en === 'yes')) return false;
      return true;
    };
  });

  ngOnInit(): void {
    // For showing which of your channels each guide channel feeds.
    this.tvh.getGrid('channel/grid', { limit: 100000, all: 1 }).subscribe({
      next: chans => {
        this.channelNames.set(new Map(chans.map((c: any) =>
          [String(c?.uuid || ''), [c?.number && c.number !== 0 ? String(c.number) : '', String(c?.name || '')].filter(Boolean).join(' ')])));
        this.allChannels.set(chans
          .map((c: any) => ({ uuid: String(c?.uuid || ''), name: String(c?.name || ''), number: c?.number && c.number !== 0 ? String(c.number) : '' }))
          .filter((c: MatchChannel) => c.uuid)
          .sort((a: MatchChannel, b: MatchChannel) => (a.number || '\uffff').localeCompare(b.number || '\uffff', undefined, { numeric: true })
            || a.name.localeCompare(b.name)));
      },
      error: () => { /* mapped column shows "?" */ },
    });
  }

  onModulesLoaded(rows: any[]): void {
    this.moduleTypes.set([...new Set(rows.map(r => splitModuleTitle(r?.title).type))].sort());
  }

  onEpgChannelsLoaded(rows: any[]): void {
    this.epgRows.set(rows);
    this.epgModules.set([...new Set(rows.map(r => String(r?.module || '')).filter(Boolean))].sort());
  }

  // ---------------------------------------------------------------- editor

  open(state: EditorState): void {
    const cur = this.editor();
    if (cur && !cur.bulkUuids && !state.bulkUuids && cur.uuid === state.uuid) return;
    this.confirmDiscard().subscribe(ok => { if (ok) this.editor.set(state); });
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => { if (ok) this.editor.set(null); });
  }

  onSaved(event: { uuid: string | null; created: boolean; bulk?: BulkResult }): void {
    const tab = this.editor()?.tab;
    const noun: [string, string] = tab === 'grabbers' ? ['grabber', 'grabbers'] : ['guide channel', 'guide channels'];
    this.snack.open(event.bulk ? describeBulk('Updated', event.bulk, ...noun) : 'Saved', undefined, { duration: 3000 });
    if (event.bulk) this.editor.set(null);
    this.gridFor(tab)?.refresh();
  }

  private gridFor(tab: Tab | undefined): IdnodeGridComponent | undefined {
    return tab === 'grabbers' ? this.modGrid : tab === 'channels' ? this.chGrid : undefined;
  }

  // ---------------------------------------------------------------- bulk & actions

  bulkEnable(tab: Tab, enabled: boolean): void {
    const grid = this.gridFor(tab);
    if (!grid) return;
    const noun: [string, string] = tab === 'grabbers' ? ['grabber', 'grabbers'] : ['guide channel', 'guide channels'];
    grid.bulkBusy.set(true);
    runBulk(grid.selection.keys(), uuid => this.tvh.idnodeSave(uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, ...noun), undefined, { duration: 4000 });
      if (!result.failed) grid.selection.clear();
      grid.refresh();
      const open = this.editor();
      if (open?.tab === tab && open.uuid && result.total) this.form?.load();
    });
  }

  bulkEdit(tab: Tab): void {
    const uuids = this.gridFor(tab)?.selection.keys() || [];
    if (!uuids.length) return;
    this.open({ tab, uuid: null, bulkUuids: uuids, title: `Edit ${uuids.length} guide ${uuids.length === 1 ? 'channel' : 'channels'}` });
  }

  // ---------------------------------------------------------------- EPG mapping

  /** Enabled guide channels feeding nothing — limited to the chosen grabber, if any. */
  private unmappedGuides(): any[] {
    const mod = this.chModule();
    return this.epgRows().filter(r => !(Array.isArray(r?.channels) && r.channels.length)
      && (r?.enabled === undefined || truthy(r.enabled) || r.enabled === 'true')
      && (!mod || String(r?.module || '') === mod));
  }

  mapUnmapped(): void {
    this.openMapDialog(this.unmappedGuides());
  }

  mapSelected(): void {
    this.openMapDialog(this.chGrid?.selection.rows() || []);
  }

  private openMapDialog(rows: any[]): void {
    if (!rows.length) return;
    const guides: MatchGuide[] = rows.map(r => ({
      uuid: String(r.uuid),
      name: String(r?.name || ''),
      names: Array.isArray(r?.names) ? r.names.map(String) : String(r?.names || '').split(/[,\n]/).map(n => n.trim()).filter(Boolean),
      number: r?.number && r.number !== 0 ? String(r.number) : '',
      id: String(r?.id || ''),
    }));
    const data: EpgMapDialogData = { guides, channels: this.allChannels() };
    this.dialog.open(EpgMapDialogComponent, { data, maxWidth: '95vw', autoFocus: 'dialog' })
      .afterClosed().subscribe((pairs?: EpgMapPair[]) => pairs?.length && this.applyMapping(pairs, rows));
  }

  /** Link each guide channel to its chosen channel, keeping any links it already had. */
  private applyMapping(pairs: EpgMapPair[], rows: any[]): void {
    const byUuid = new Map(rows.map(r => [String(r.uuid), r]));
    const grid = this.chGrid;
    grid?.bulkBusy.set(true);
    runBulk(pairs, p => {
      const existing: string[] = (byUuid.get(p.guideUuid)?.channels || []).map(String);
      return this.tvh.idnodeSave(p.guideUuid, { channels: [...new Set([...existing, p.channelUuid])] });
    }).subscribe(result => {
      grid?.bulkBusy.set(false);
      this.snack.open(describeBulk('Mapped', result, 'guide channel'), undefined, { duration: 5000 });
      if (!result.failed) grid?.selection.clear();
      grid?.refresh();
    });
  }

  rerunInternal(): void {
    this.run(this.tvh.rerunInternalEpgGrabbers(), 'Internal grabbers started. New guide data appears as they finish.');
  }

  /**
   * A grab only visits muxes the grabber has seen while tuned, so first rescan the broadcast muxes
   * that feed channels (grabbers switched on after the scan otherwise find nothing), then grab.
   */
  triggerOta(): void {
    this.running.set(true);
    broadcastMuxesWithChannels(this.tvh).pipe(switchMap(ids => primeAndGrab(this.tvh, ids))).subscribe({
      next: r => {
        this.running.set(false);
        this.snack.open(r.primed
          ? `Tuning ${r.primed} ${r.primed === 1 ? 'frequency' : 'frequencies'} so the guide grabbers see them; the over-the-air grab starts in about 1½ minutes.`
          : 'Over-the-air grab started. It can take several minutes per frequency.', undefined, { duration: 7000 });
      },
      error: err => { this.running.set(false); this.snack.open(`Tvheadend refused (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }); },
    });
  }

  private run(request: Observable<unknown>, message: string): void {
    this.running.set(true);
    request.subscribe({
      next: () => { this.running.set(false); this.snack.open(message, undefined, { duration: 5000 }); },
      error: err => {
        this.running.set(false);
        this.snack.open(`Tvheadend refused (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 });
      },
    });
  }

  private confirmDiscard(): Observable<boolean> {
    if (!this.form?.hasUnsavedChanges()) return of(true);
    const data: ConfirmDialogData = { title: 'Discard changes?', message: 'You have unsaved changes.', confirm: 'Discard', destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }
}
