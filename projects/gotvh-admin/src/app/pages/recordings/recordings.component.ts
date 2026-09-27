import { AfterViewInit, Component, OnInit, ViewChild, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { TvheadendService } from '@gotvh/tvh-api';

type RecordingView = 'upcoming' | 'finished' | 'failed';

/**
 * Dense, sortable, filterable DVR table — the desktop counterpart to the TV
 * app's Recordings screen. Read-only for now; row actions come next.
 */
@Component({
  selector: 'admin-recordings',
  standalone: true,
  imports: [
    MatTableModule, MatSortModule, MatPaginatorModule, MatFormFieldModule, MatInputModule,
    MatButtonModule, MatButtonToggleModule, MatIconModule, MatProgressBarModule,
  ],
  template: `
    <div class="admin-page">
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
      </div>
      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

      <table mat-table [dataSource]="data" matSort matSortActive="start"
             [matSortDirection]="view() === 'upcoming' ? 'asc' : 'desc'">
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
        <tr mat-row *matRowDef="let row; columns: columns"></tr>
        <tr class="mat-row" *matNoDataRow>
          <td class="mat-cell empty muted" [attr.colspan]="columns.length">
            {{ loading() ? 'Loading…' : 'No recordings here. If you expected some, check you are signed in.' }}
          </td>
        </tr>
      </table>
      <mat-paginator [pageSizeOptions]="[25, 50, 100, 250]" [pageSize]="50" showFirstLastButtons />
    </div>
  `,
  styles: [`
    .toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
    .filter { width: 320px; }
    .spacer { flex: 1; }
    table { width: 100%; }
    .title { font-weight: 500; }
    .small { font: var(--mat-sys-body-small); }
    .empty { padding: 24px 16px; }
  `],
})
export class RecordingsComponent implements OnInit, AfterViewInit {
  private readonly tvh = inject(TvheadendService);

  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild(MatPaginator) paginator!: MatPaginator;

  readonly view = signal<RecordingView>('upcoming');
  readonly loading = signal(false);
  readonly data = new MatTableDataSource<any>([]);
  readonly columns = ['title', 'channel', 'start', 'duration', 'size', 'status', 'errors'];

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
  }

  setView(view: RecordingView): void {
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
      next: rows => { this.data.data = rows; this.loading.set(false); },
      error: () => { this.data.data = []; this.loading.set(false); },
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
