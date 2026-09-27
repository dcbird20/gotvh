import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { BulkResult, describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';
import { SplitHandleDirective } from '../../shared/split-handle.directive';

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Tvheadend weekdays (1 = Monday … 7 = Sunday) in words. */
export function describeDays(raw: unknown): string {
  const days = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(d => d >= 1 && d <= 7))].sort();
  const key = days.join(',');
  if (!days.length) return 'Never';
  if (key === '1,2,3,4,5,6,7') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '6,7') return 'Weekends';
  return days.map(d => DAY_NAMES[d]).join(', ');
}

type Editor = { uuid: string | null; creating?: boolean; bulkUuids?: string[] } | null;

/**
 * Timers: record a channel at a fixed time on chosen days, whatever the guide
 * says (Tvheadend "time-based recording", dvr/timerec).
 */
@Component({
  selector: 'admin-timers',
  standalone: true,
  imports: [SplitHandleDirective, MatButtonModule, MatIconModule, MatProgressBarModule, MatDialogModule, MatSnackBarModule,
    IdnodeGridComponent, IdnodeFormComponent],
  template: `
    <div class="admin-page wide">
      <h1>Timers</h1>
      <p class="subtitle">Record a channel at the same time on chosen days, whatever the guide says — for shows the guide lists wrongly or not at all.</p>
      @if (error()) { <div class="banner error" role="alert">{{ error() }}</div> }
      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }
      <div class="layout" adminSplit [class.with-editor]="!!editor()">
        <div class="main">
          <admin-idnode-grid #grid
            path="dvr/timerec/grid" [clientSide]="true" [data]="rows()" [columns]="columns()"
            filterField="name" [searchFields]="['name', 'channelName', 'comment']" filterLabel="Search timers"
            [defaultSort]="{ active: 'name', direction: 'asc' }" [selectedUuid]="editor()?.uuid ?? null"
            [emptyText]="loading() ? 'Loading…' : 'No timers yet.'" (rowClick)="open($event)">
            <button mat-flat-button (click)="create()"><mat-icon>add</mat-icon> New timer</button>
            <ng-container ngProjectAs="[bulkActions]">
              <button mat-button (click)="bulkEdit()"><mat-icon>edit</mat-icon> Edit…</button>
              <button mat-button (click)="bulk('enable')">Enable</button>
              <button mat-button (click)="bulk('disable')">Disable</button>
              <button mat-button class="danger-text" (click)="bulk('delete')"><mat-icon>delete</mat-icon> Delete</button>
            </ng-container>
          </admin-idnode-grid>
        </div>
        @if (editor(); as ed) {
          <admin-idnode-form #form
            [uuid]="ed.uuid" [createPath]="ed.creating ? 'dvr/timerec' : null" [bulkUuids]="ed.bulkUuids || null"
            [createDefaults]="{ enabled: true }" [title]="editorTitle()"
            (saved)="onSaved($event)" (closed)="close()">
            @if (selected(); as t) {
              <button formExtraActions mat-button type="button" class="danger-text" (click)="deleteTimers([t.uuid])">Delete</button>
            }
          </admin-idnode-form>
        }
      </div>
    </div>
  `,
  styles: [`
    .wide { max-width: none; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    .layout.with-editor { grid-template-columns: minmax(0, 1fr) var(--admin-side-width, 460px); }
    .main { min-width: 0; }
    .banner.error { padding: 10px 14px; border-radius: 8px; margin: 8px 0 12px;
                    background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
    .danger-text { color: var(--mat-sys-error); }
    @media (max-width: 1100px) { .layout.with-editor { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class TimersComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild('grid') grid?: IdnodeGridComponent;
  @ViewChild('form') form?: IdnodeFormComponent;

  readonly loading = signal(false);
  readonly error = signal('');
  readonly editor = signal<Editor>(null);
  private readonly timers = signal<any[]>([]);
  private readonly channelNames = signal(new Map<string, string>());
  private readonly profileNames = signal(new Map<string, string>());

  readonly rows = computed(() => {
    const ch = this.channelNames(), pr = this.profileNames();
    return this.timers().map(t => ({
      ...t,
      enabled: truthy(t.enabled),
      channelName: ch.get(String(t.channel)) || String(t.channel || '—'),
      daysText: describeDays(t.weekdays),
      timeText: `${t.start || '?'} – ${t.stop || '?'}`,
      profileName: t.config_name ? (pr.get(String(t.config_name)) ?? String(t.config_name)) : '',
    }));
  });
  readonly selected = computed(() => this.rows().find(r => String(r.uuid) === this.editor()?.uuid) || null);

  private readonly allColumns: GridColumn[] = [
    { id: 'name', label: 'Timer', format: v => v || '(no name)' },
    { id: 'enabled', label: 'Enabled', kind: 'bool' },
    { id: 'channelName', label: 'Channel' },
    { id: 'daysText', label: 'Days', sortValue: r => (Array.isArray(r.weekdays) ? r.weekdays.join('') : '') },
    { id: 'timeText', label: 'Time', sortValue: r => String(r.start || '') },
    { id: 'profileName', label: 'DVR profile', format: v => v || 'Default' },
    { id: 'comment', label: 'Comment' },
  ];
  readonly columns = computed(() => this.editor()
    ? this.allColumns.filter(c => ['name', 'enabled', 'daysText', 'timeText'].includes(c.id)) : this.allColumns);

  ngOnInit(): void {
    forkJoin({
      channels: this.tvh.getGrid('channel/grid', { all: 1 }).pipe(catchError(() => of([]))),
      profiles: this.tvh.getGrid('dvr/config/grid').pipe(catchError(() => of([]))),
    }).subscribe(({ channels, profiles }) => {
      this.channelNames.set(new Map(channels.map((c: any) => [String(c.uuid), String(c.name || '')])));
      this.profileNames.set(new Map(profiles.map((p: any) => [String(p.uuid), String(p.name || '').trim() || 'Default'])));
    });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.tvh.getGrid('dvr/timerec/grid').subscribe({
      next: rows => { this.timers.set(rows); this.loading.set(false); },
      error: err => {
        this.loading.set(false);
        this.error.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load timers (${err?.status || 'network error'}).`);
      },
    });
  }

  open(row: any): void {
    if (String(row.uuid) === this.editor()?.uuid) return;
    this.confirmDiscard().subscribe(ok => ok && this.editor.set({ uuid: String(row.uuid) }));
  }

  create(): void {
    this.confirmDiscard().subscribe(ok => ok && this.editor.set({ uuid: null, creating: true }));
  }

  bulkEdit(): void {
    const uuids = this.grid?.selection.keys() || [];
    if (uuids.length) this.confirmDiscard().subscribe(ok => ok && this.editor.set({ uuid: null, bulkUuids: uuids }));
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => ok && this.editor.set(null));
  }

  editorTitle(): string {
    const ed = this.editor();
    if (ed?.bulkUuids) return `Edit ${ed.bulkUuids.length} ${ed.bulkUuids.length === 1 ? 'timer' : 'timers'}`;
    if (ed?.creating) return 'New timer';
    return this.selected()?.name || 'Timer';
  }

  onSaved(event: { uuid: string | null; created: boolean; bulk?: BulkResult }): void {
    this.snack.open(event.bulk ? describeBulk('Updated', event.bulk, 'timer') : event.created ? 'Timer created' : 'Timer saved',
      undefined, { duration: 3000 });
    if (event.created) this.editor.set(event.uuid ? { uuid: event.uuid } : null);
    if (event.bulk) { this.editor.set(null); this.grid?.selection.clear(); }
    this.load();
  }

  bulk(action: 'enable' | 'disable' | 'delete'): void {
    const uuids = this.grid?.selection.keys() || [];
    if (!uuids.length) return;
    if (action === 'delete') { this.deleteTimers(uuids); return; }
    const grid = this.grid!;
    grid.bulkBusy.set(true);
    runBulk(uuids, u => this.tvh.idnodeSave(u, { enabled: action === 'enable' ? 1 : 0 })).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk(action === 'enable' ? 'Enabled' : 'Disabled', result, 'timer'), undefined, { duration: 4000 });
      grid.selection.clear();
      this.load();
    });
  }

  deleteTimers(uuids: string[]): void {
    const names = this.rows().filter(r => uuids.includes(String(r.uuid))).slice(0, 3).map(r => `“${r.name || 'unnamed'}”`).join(', ')
      + (uuids.length > 3 ? ` and ${uuids.length - 3} more` : '');
    this.confirm(`Delete ${uuids.length} ${uuids.length === 1 ? 'timer' : 'timers'}?`,
      `${names} will stop scheduling recordings. Recordings already made are kept.`, 'Delete')
      .subscribe(ok => {
        if (!ok) return;
        runBulk(uuids, u => this.tvh.idnodeDelete(u)).subscribe(result => {
          this.snack.open(describeBulk('Deleted', result, 'timer'), undefined, { duration: 4000 });
          this.grid?.selection.clear();
          if (uuids.includes(this.editor()?.uuid || '')) this.editor.set(null);
          this.load();
        });
      });
  }

  private confirm(title: string, message: string, confirm: string): Observable<boolean> {
    const data: ConfirmDialogData = { title, message, confirm, destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }

  private confirmDiscard(): Observable<boolean> {
    if (!this.form?.hasUnsavedChanges()) return of(true);
    return this.confirm('Discard changes?', 'You have unsaved changes.', 'Discard');
  }
}
