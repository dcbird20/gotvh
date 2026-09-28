import { ConnectionsComponent } from '../../shared/connections.component';
import { AfterViewInit, Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { TvheadendService } from '@gotvh/tvh-api';
import { BulkBarComponent } from '../../shared/bulk-bar.component';
import { describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { RowSelection } from '../../shared/row-selection';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { AddRecordingData, AddRecordingDialogComponent, AddRecordingResult } from './add-recording-dialog.component';
import { FailureExplanation, explainRecording } from './recording-status';
import { SplitHandleDirective } from '../../shared/split-handle.directive';

type RecordingView = 'upcoming' | 'finished' | 'failed';

/**
 * Dense, sortable, filterable DVR table — the desktop counterpart to the TV
 * app's Recordings screen. Select rows (click, Ctrl/⌘-click, Shift-click,
 * checkboxes) to cancel, delete or mark them watched in bulk.
 */
@Component({
  selector: 'admin-recordings',
  standalone: true,
  imports: [SplitHandleDirective, ConnectionsComponent, 
    MatTableModule, MatSortModule, MatPaginatorModule, MatFormFieldModule, MatInputModule,
    MatButtonModule, MatButtonToggleModule, MatIconModule, MatProgressBarModule, MatCheckboxModule,
    MatDialogModule, MatSnackBarModule, MatTooltipModule, MatTabsModule, RouterLink, BulkBarComponent, IdnodeFormComponent,
  ],
  template: `
    <div class="admin-page wide">
      <h1>Recordings</h1>
      <p class="subtitle">Upcoming, finished and failed DVR entries.</p>

      <div class="toolbar">
        <mat-button-toggle-group [value]="view()" (change)="setView($event.value)" hideSingleSelectionIndicator>
          <mat-button-toggle value="upcoming">Upcoming</mat-button-toggle>
          <mat-button-toggle value="finished">Finished</mat-button-toggle>
          <mat-button-toggle value="failed">Failed</mat-button-toggle>
        </mat-button-toggle-group>

        <mat-form-field appearance="outline" subscriptSizing="dynamic" class="filter">
          <mat-icon matPrefix>search</mat-icon>
          <mat-label>Filter</mat-label>
          <input matInput (input)="applyFilter($any($event.target).value)" placeholder="Title, channel, status…">
        </mat-form-field>

        <span class="muted num">{{ data.filteredData.length }} of {{ data.data.length }}</span>
        <span class="spacer"></span>
        <button mat-stroked-button (click)="load()" [disabled]="loading()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
        <button mat-flat-button (click)="addRecording()"><mat-icon>add</mat-icon> New recording</button>
      </div>
      @if (selection.count()) {
        <admin-bulk-bar [count]="selection.count()" [busy]="busy()" [hint]="hiddenHint()" (clear)="selection.clear()"
                        [matchingTotal]="offerAllMatching() ? data.filteredData.length : null" [filtered]="!!data.filter"
                        (selectAll)="selection.addAll(data.filteredData)">
          @if (view() === 'upcoming') {
            <button mat-button class="danger-text" (click)="bulkCancel()"><mat-icon>event_busy</mat-icon> Cancel recordings</button>
          } @else {
            @if (view() === 'finished') {
              <button mat-button (click)="bulkWatched(true)"><mat-icon>visibility</mat-icon> Mark watched</button>
              <button mat-button (click)="bulkWatched(false)">Mark unwatched</button>
            }
            <button mat-button class="danger-text" (click)="bulkDelete()"><mat-icon>delete</mat-icon> Delete</button>
          }
        </admin-bulk-bar>
      }
      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

      <div class="layout" adminSplit [class.with-editor]="!!openUuid()">
      <div class="main">
      <table mat-table [dataSource]="data" matSort matSortActive="start"
             [matSortDirection]="view() === 'upcoming' ? 'asc' : 'desc'">
        <ng-container matColumnDef="select">
          <th mat-header-cell *matHeaderCellDef class="col-select">
            <mat-checkbox [checked]="selection.allSelected(visible())" [indeterminate]="selection.someSelected(visible())"
                          [disabled]="!visible().length" (change)="selection.toggleAll(visible())"
                          aria-label="Select all recordings on this page" />
          </th>
          <td mat-cell *matCellDef="let r" class="col-select" (mousedown)="selection.preventShiftTextSelect($event)" (click)="selection.cellClick($event, r, visible())">
            <mat-checkbox class="display-only" [checked]="selection.isSelected(r)" [tabIndex]="-1" aria-hidden="true" />
          </td>
        </ng-container>
        <ng-container matColumnDef="title">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Title</th>
          <td mat-cell *matCellDef="let r">
            <div class="title">{{ r.disp_title || r.title || '(untitled)' }}</div>
            @if (r.disp_subtitle) { <div class="muted small">{{ r.disp_subtitle }}</div> }
          </td>
        </ng-container>
        <ng-container matColumnDef="channel">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Channel</th>
          <td mat-cell *matCellDef="let r">{{ r.channelname || '—' }}</td>
        </ng-container>
        <ng-container matColumnDef="start">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Start</th>
          <td mat-cell *matCellDef="let r" class="num">{{ formatEpoch(r.start) }}</td>
        </ng-container>
        <ng-container matColumnDef="duration">
          <th mat-header-cell *matHeaderCellDef mat-sort-header class="num">Length</th>
          <td mat-cell *matCellDef="let r" class="num">{{ formatDuration(r) }}</td>
        </ng-container>
        <ng-container matColumnDef="size">
          <th mat-header-cell *matHeaderCellDef mat-sort-header class="num">Size</th>
          <td mat-cell *matCellDef="let r" class="num">{{ formatBytes(r.filesize) }}</td>
        </ng-container>
        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Status</th>
          <td mat-cell *matCellDef="let r">{{ r.status || r.sched_status || '—' }}</td>
        </ng-container>
        <ng-container matColumnDef="errors">
          <th mat-header-cell *matHeaderCellDef mat-sort-header class="num">Errors</th>
          <td mat-cell *matCellDef="let r" class="num">{{ (r.errors || 0) + (r.data_errors || 0) }}</td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns; sticky: true"></tr>
        <tr mat-row *matRowDef="let r; columns: columns" class="clickable" [class.checked]="selection.isSelected(r)"
            tabindex="0" (mousedown)="selection.preventShiftTextSelect($event)" (click)="onRowClick($event, r)"
            (keydown.space)="$event.preventDefault(); selection.toggle(r)"></tr>
        <tr class="mat-row" *matNoDataRow>
          <td class="mat-cell empty muted" [attr.colspan]="columns.length">
            {{ loading() ? 'Loading…' : 'No recordings here. If you expected some, check you are signed in.' }}
          </td>
        </tr>
      </table>
      <mat-paginator [pageSizeOptions]="[25, 50, 100, 250, 500]" [pageSize]="50" showFirstLastButtons />
      </div>

      @if (openRow(); as r) {
        <div class="side">
          <div class="panel-head">
            <div>
              <h3>{{ r.disp_title || r.title || '(untitled)' }}</h3>
              @if (r.disp_subtitle) { <div class="muted">{{ r.disp_subtitle }}</div> }
            </div>
            <button mat-icon-button (click)="closeRecording()" aria-label="Close"><mat-icon>close</mat-icon></button>
          </div>
          <mat-tab-group [selectedIndex]="panelTab()" (selectedIndexChange)="panelTab.set($event)" animationDuration="0ms"
                         mat-stretch-tabs="false" mat-align-tabs="start" preserveContent class="panel-tabs">
          <mat-tab label="Details">
          <section class="card details">
            <dl>
              <dt>Channel</dt><dd>{{ r.channelname || '—' }}</dd>
              <dt>When</dt><dd>{{ formatEpoch(r.start) }} – {{ formatTime(r.stop) }}
                @if (paddingText(r)) { <span class="muted small">({{ paddingText(r) }})</span> }</dd>
              <dt>Status</dt><dd [class.bad]="!!explanation()">{{ r.status || r.sched_status || '—' }}</dd>
              @if (view() !== 'upcoming' || isRecordingNow(r)) {
                <dt>File</dt><dd class="file">{{ r.filename || '—' }}</dd>
                <dt>Size</dt><dd>{{ formatBytes(r.filesize) }}</dd>
                <dt>Errors</dt><dd [class.bad]="(r.errors || 0) + (r.data_errors || 0) > 0">
                  {{ r.errors || 0 }} stream, {{ r.data_errors || 0 }} data</dd>
              }
            </dl>

            @if (explanation(); as why) {
              <div class="why">
                <strong>{{ why.headline }}</strong>
                <p>{{ why.detail }}</p>
                @if (why.link) { <a mat-stroked-button [routerLink]="why.link.route">{{ why.link.label }}</a> }
              </div>
            }

            <div class="d-actions">
              @if (isRecordingNow(r)) {
                <button mat-stroked-button class="danger-text" (click)="stopRecording(r)">Stop recording</button>
              } @else if (view() === 'upcoming') {
                <button mat-stroked-button class="danger-text" (click)="cancelOne(r)">Cancel recording</button>
              }
              @if (view() !== 'upcoming' && r.filesize > 0) {
                <a mat-stroked-button [href]="downloadUrl(r)" target="_blank" rel="noopener"><mat-icon>download</mat-icon> Download</a>
              }
              @if (view() === 'failed') {
                <button mat-stroked-button (click)="rerecord(r)"
                        matTooltip="Record it again the next time the guide shows it">Record next airing</button>
                @if (explanation()?.maybeWatchable && r.filesize > 0) {
                  <button mat-stroked-button (click)="moveToFinished(r)"
                          matTooltip="Keep it with finished recordings despite the errors">Keep it anyway</button>
                }
              }
              @if (view() !== 'upcoming') {
                <button mat-button class="danger-text" (click)="deleteOne(r)">Delete</button>
              }
            </div>
          </section>
          <admin-connections kind="recording" [uuid]="r.uuid" />
          </mat-tab>
          <mat-tab>
            <ng-template mat-tab-label>Edit @if (recForm?.hasUnsavedChanges()) { <span class="dot" aria-label="unsaved changes"></span> }</ng-template>
            <admin-idnode-form #recForm [uuid]="r.uuid" title="Edit recording" (saved)="onSaved()" (closed)="closeRecording()" />
          </mat-tab>
          </mat-tab-group>
        </div>
      }
      </div>
    </div>
  `,
  styles: [`
    .wide { max-width: none; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    .layout.with-editor { grid-template-columns: minmax(0, 1fr) var(--admin-side-width, 460px); }
    .panel-tabs admin-connections { display: block; margin-top: 12px; }
    .main { min-width: 0; }
    .side { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 16px;
            max-height: calc(100vh - 96px); overflow-y: auto; }
    .side admin-idnode-form { position: static; max-height: none; }
    .card { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: 14px 20px;
            background: var(--mat-sys-surface-container-lowest); }
    .panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 0 4px;
                  h3 { font: var(--mat-sys-title-large); margin: 0; } }
    .panel-tabs { margin-top: -4px; }
    .panel-tabs .card, .panel-tabs admin-idnode-form { margin-top: 12px; display: block; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--mat-sys-primary); margin-left: 6px; }
    dl { display: grid; grid-template-columns: 76px 1fr; gap: 6px 12px; margin: 12px 0; }
    dt { color: var(--mat-sys-on-surface-variant); font: var(--mat-sys-body-small); padding-top: 2px; }
    dd { margin: 0; }
    dd.file { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
    dd.bad { color: var(--mat-sys-error); }
    dd a { color: var(--mat-sys-primary); }
    .why { border-radius: 8px; padding: 10px 12px; margin: 4px 0 12px;
           background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container);
           p { margin: 4px 0 8px; } }
    .d-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    @media (max-width: 1100px) { .layout.with-editor { grid-template-columns: minmax(0, 1fr); } .side { position: static; max-height: none; } }
    .toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
    .filter { width: 320px; }
    .spacer { flex: 1; }
    table { width: 100%; }
    .title { font-weight: 500; }
    .small { font: var(--mat-sys-body-small); }
    .empty { padding: 24px 16px; }
    .col-select { width: 48px; padding-right: 0 !important; }
    td.col-select { cursor: pointer; }
    .display-only { pointer-events: none; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover td { background: var(--mat-sys-surface-container-low); }
    tr.clickable:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: -2px; }
    tr.checked td { background: var(--mat-sys-secondary-container) !important; }
    .danger-text { color: var(--mat-sys-error); }
  `],
})
export class RecordingsComponent implements OnInit, AfterViewInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild(MatPaginator) paginator!: MatPaginator;

  readonly view = signal<RecordingView>('upcoming');
  readonly loading = signal(false);
  readonly data = new MatTableDataSource<any>([]);
  private readonly allColumns = ['select', 'title', 'channel', 'start', 'duration', 'size', 'status', 'errors'];
  get columns(): string[] {
    return this.openUuid() ? ['select', 'title', 'channel', 'start', 'status'] : this.allColumns;
  }
  @ViewChild('recForm') recForm?: IdnodeFormComponent;
  /** Recording shown in the side panel. */
  readonly openUuid = signal<string | null>(null);
  /** 0 = Details, 1 = Edit. */
  readonly panelTab = signal(0);
  private readonly rows = signal<any[]>([]);
  readonly openRow = computed(() => this.rows().find(r => String(r.uuid) === this.openUuid()) || null);
  readonly explanation = computed<FailureExplanation | null>(() => {
    const r = this.openRow();
    return r && this.view() !== 'upcoming' ? explainRecording(r) : null;
  });
  readonly selection = new RowSelection<any>(r => String(r?.uuid || ''));
  readonly busy = signal(false);
  /** Rows on the current page after filter + sort — what range/select-all act on. */
  readonly visible = signal<any[]>([]);

  ngOnInit(): void {
    this.data.sortingDataAccessor = (r, col) => {
      switch (col) {
        case 'title': return String(r.disp_title || r.title || '').toLowerCase();
        case 'channel': return String(r.channelname || '').toLowerCase();
        case 'duration': return this.durationSeconds(r);
        case 'size': return Number(r.filesize) || 0;
        case 'status': return String(r.status || r.sched_status || '');
        case 'errors': return (r.errors || 0) + (r.data_errors || 0);
        default: return Number(r[col]) || 0;
      }
    };
    this.data.filterPredicate = (r, filter) =>
      [r.disp_title, r.title, r.disp_subtitle, r.channelname, r.status, r.sched_status]
        .some(v => String(v || '').toLowerCase().includes(filter));
    this.load();
  }

  ngAfterViewInit(): void {
    this.data.sort = this.sort;
    this.data.paginator = this.paginator;
    this.data.connect().subscribe(rows => this.visible.set(rows));
  }

  /** Plain click selects the row and opens it; Ctrl/⌘ and Shift add to the selection. */
  onRowClick(event: MouseEvent, row: any): void {
    if (this.selection.handleClick(event, row, this.visible())) return;
    this.selection.selectOnly(row);
    this.openRecording(row);
  }

  openRecording(row: any): void {
    if (String(row.uuid) === this.openUuid()) return;
    this.confirmDiscard().subscribe(ok => {
      if (!ok) return;
      // Upcoming recordings are opened to change them; finished and failed ones to see what happened.
      this.panelTab.set(this.view() === 'upcoming' && !this.isRecordingNow(row) ? 1 : 0);
      this.openUuid.set(String(row.uuid));
    });
  }

  closeRecording(): void {
    this.confirmDiscard().subscribe(ok => ok && this.openUuid.set(null));
  }

  onSaved(): void {
    this.snack.open('Recording saved', undefined, { duration: 2500 });
    this.load();
  }

  private confirmDiscard(): Observable<boolean> {
    if (!this.recForm?.hasUnsavedChanges()) return of(true);
    return this.confirm('Discard changes?', 'You have unsaved changes to this recording.', 'Discard');
  }

  isRecordingNow(r: any): boolean {
    return /record/i.test(String(r?.sched_status || '')) || (this.view() === 'upcoming' && /running|waiting for/i.test(String(r?.status || '')));
  }

  paddingText(r: any): string {
    const pre = Number(r.start_extra) || 0, post = Number(r.stop_extra) || 0;
    if (!pre && !post) return '';
    return [pre ? `${pre} min early` : '', post ? `${post} min late` : ''].filter(Boolean).join(', ');
  }

  formatTime(seconds: number | undefined): string {
    if (!seconds) return '—';
    return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  downloadUrl(r: any): string {
    return this.tvh.getRecordingStreamUrl(String(r.uuid), { includeAuth: false });
  }

  // ---------------------------------------------------------------- single-recording actions

  cancelOne(r: any): void {
    this.confirm('Cancel this recording?', `${this.names([r])} will not be recorded. Auto-record rules may schedule it again.`, 'Cancel recording')
      .subscribe(ok => ok && this.single(this.tvh.cancelRecording(r.uuid), 'Recording cancelled', true));
  }

  stopRecording(r: any): void {
    this.confirm('Stop this recording?', `${this.names([r])} stops now. What’s been recorded so far is kept.`, 'Stop recording')
      .subscribe(ok => ok && this.single(this.tvh.stopRecording(r.uuid), 'Recording stopped', false));
  }

  deleteOne(r: any): void {
    this.confirm('Delete this recording?', `${this.names([r])} will be removed${r.filesize > 0 ? ' and its file deleted from disk' : ''}.`, 'Delete')
      .subscribe(ok => ok && this.single(this.tvh.removeRecording(r.uuid), 'Recording deleted', true));
  }

  rerecord(r: any): void {
    this.single(this.tvh.allowRerecord(r.uuid), 'It will be recorded again if the guide shows another airing', false);
  }

  moveToFinished(r: any): void {
    this.single(this.tvh.moveRecordingToFinished(r.uuid), 'Moved to finished recordings', true);
  }

  private single(request: Observable<unknown>, done: string, closes: boolean): void {
    this.busy.set(true);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.snack.open(done, undefined, { duration: 3500 });
        if (closes) this.openUuid.set(null);
        this.load();
      },
      error: err => { this.busy.set(false); this.snack.open(`That didn’t work (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }); },
    });
  }

  // ---------------------------------------------------------------- new recording

  addRecording(): void {
    forkJoin({
      channels: this.tvh.getGrid('channel/grid', { all: 1 }).pipe(catchError(() => of([]))),
      profiles: this.tvh.getGrid('dvr/config/grid').pipe(catchError(() => of([]))),
    }).subscribe(({ channels, profiles }) => {
      const data: AddRecordingData = {
        channels: channels.filter((c: any) => c?.enabled !== false)
          .map((c: any) => ({ uuid: String(c.uuid), name: String(c.name || ''), number: c.number ? String(c.number) : '' }))
          .sort((a, b) => (parseFloat(a.number) || 1e9) - (parseFloat(b.number) || 1e9)
            || a.number.localeCompare(b.number, undefined, { numeric: true }) || a.name.localeCompare(b.name)),
        profiles: profiles.filter((p: any) => p?.enabled !== false)
          .map((p: any) => ({ uuid: String(p.uuid), name: String(p.name || '').trim() || 'Default profile' }))
          .sort((a, b) => Number(b.name === 'Default profile') - Number(a.name === 'Default profile') || a.name.localeCompare(b.name)),
      };
      if (!data.channels.length) {
        this.snack.open('Couldn’t load the channel list', 'Dismiss', { duration: 5000 });
        return;
      }
      this.dialog.open<AddRecordingDialogComponent, AddRecordingData, AddRecordingResult>(AddRecordingDialogComponent, { data })
        .afterClosed().subscribe(conf => {
          if (!conf) return;
          this.tvh.createRecordingEntry(conf).subscribe({
            next: res => {
              this.snack.open(`Scheduled “${conf['disp_title']}”`, undefined, { duration: 3500 });
              if (this.view() !== 'upcoming') this.view.set('upcoming');
              this.load();
              if (res?.uuid) this.openUuid.set(String(res.uuid));
            },
            error: err => this.snack.open(`Couldn’t schedule it (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
          });
        });
    });
  }

  offerAllMatching(): boolean {
    return this.selection.allSelected(this.visible()) && this.data.filteredData.length > this.visible().length
      && this.selection.count() < this.data.filteredData.length;
  }

  hiddenHint(): string {
    const shown = this.visible().filter(r => this.selection.isSelected(r)).length;
    const hidden = this.selection.count() - shown;
    return hidden > 0 ? `${hidden} not shown (other page or filtered out)` : '';
  }

  // ---------------------------------------------------------------- bulk actions

  bulkCancel(): void {
    const rows = this.selection.rows();
    this.confirm(`Cancel ${rows.length} scheduled ${rows.length === 1 ? 'recording' : 'recordings'}?`,
      `${this.names(rows)} will not be recorded. Auto-record rules may schedule them again.`, 'Cancel recordings')
      .subscribe(ok => ok && this.runBulk(rows, r => this.tvh.cancelRecording(r.uuid), 'Cancelled'));
  }

  bulkDelete(): void {
    const rows = this.selection.rows();
    const files = this.view() === 'finished' ? ' Their files are deleted from disk.' : '';
    this.confirm(`Delete ${rows.length} ${rows.length === 1 ? 'recording' : 'recordings'}?`,
      `${this.names(rows)} will be removed.${files}`, 'Delete')
      .subscribe(ok => ok && this.runBulk(rows, r => this.tvh.removeRecording(r.uuid), 'Deleted'));
  }

  bulkWatched(watched: boolean): void {
    this.runBulk(this.selection.rows(), r => this.tvh.markRecordingWatched(r.uuid, watched),
      watched ? 'Marked watched:' : 'Marked unwatched:');
  }

  private runBulk(rows: any[], action: (r: any) => Observable<unknown>, verb: string): void {
    this.busy.set(true);
    runBulk(rows, action).subscribe(result => {
      this.busy.set(false);
      this.snack.open(describeBulk(verb, result, 'recording'), undefined, { duration: 4000 });
      this.selection.clear();
      this.load();
    });
  }

  private names(rows: any[]): string {
    const list = rows.slice(0, 3).map(r => `“${r.disp_title || r.title || 'untitled'}”`).join(', ');
    return rows.length > 3 ? `${list} and ${rows.length - 3} more` : list;
  }

  private confirm(title: string, message: string, confirm: string): Observable<boolean> {
    const data: ConfirmDialogData = { title, message, confirm, destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }

  setView(view: RecordingView): void {
    this.selection.clear(); // actions differ per view
    this.openUuid.set(null);
    this.view.set(view);
    this.load();
  }

  load(): void {
    const source: Record<RecordingView, () => Observable<any[]>> = {
      upcoming: () => this.tvh.getScheduledRecordings(),
      finished: () => this.tvh.getFinishedRecordings(),
      failed: () => this.tvh.getFailedRecordings(),
    };
    this.loading.set(true);
    source[this.view()]().subscribe({
      next: rows => { this.data.data = rows; this.rows.set(rows); this.loading.set(false); },
      error: () => { this.data.data = []; this.rows.set([]); this.loading.set(false); },
    });
  }

  applyFilter(value: string): void {
    this.data.filter = value.trim().toLowerCase();
    this.paginator?.firstPage();
  }

  formatEpoch(seconds: number | undefined): string {
    if (!seconds) return '—';
    return new Date(seconds * 1000).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  private durationSeconds(r: any): number {
    return Number(r.duration) || Math.max(0, (Number(r.stop) || 0) - (Number(r.start) || 0));
  }

  formatDuration(r: any): string {
    const s = this.durationSeconds(r);
    if (!s) return '—';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
  }

  formatBytes(bytes: number | undefined): string {
    const b = Number(bytes) || 0;
    if (!b) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return `${(b / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
  }
}
