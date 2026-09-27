import { Component, OnChanges, SimpleChanges, inject, input, output, signal } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { BulkBarComponent } from './bulk-bar.component';
import { RowSelection } from './row-selection';

export interface GridColumn {
  /** Field name in the grid response. */
  id: string;
  label: string;
  kind?: 'text' | 'num' | 'bool' | 'list' | 'mono';
  /** Server-side sortable (default true). */
  sortable?: boolean;
  /** Custom display, e.g. mapping tag uuids to names. Overrides `kind` formatting. */
  format?: (value: any, row: any) => string;
  /** Client-side mode: value to sort by (defaults to the field itself). */
  sortValue?: (row: any) => string | number | null | undefined;
}

/**
 * Server-paged, sortable, filterable table for any Tvheadend grid endpoint
 * (e.g. `mpegts/mux/grid`). Emits the clicked row; the page decides what to
 * open. Large lists (thousands of services) stay fast because only one page
 * is fetched at a time.
 *
 * Client-side mode (`clientSide`): loads every row once and does search,
 * filtering (`rowFilter`), sorting and paging in the browser. Use it for lists
 * of a few thousand rows at most (e.g. channels) when filters need data the
 * server can't filter on, or several fields at once.
 *
 * Multi-select: checkbox column, Ctrl/⌘-click, Shift-click range, Space on a
 * focused row. While rows are selected, content marked `bulkActions` is shown
 * in a bar above the table; the page reads `selection.rows()` to act on them.
 */
@Component({
  selector: 'admin-idnode-grid',
  standalone: true,
  imports: [MatTableModule, MatSortModule, MatPaginatorModule, MatFormFieldModule, MatInputModule, MatIconModule,
    MatProgressBarModule, MatCheckboxModule, BulkBarComponent],
  template: `
    <div class="toolbar">
      @if (filterField()) {
        <mat-form-field appearance="outline" class="filter">
          <mat-icon matPrefix>search</mat-icon>
          <mat-label>{{ filterLabel() }}</mat-label>
          <input matInput [value]="filter()" (input)="onFilter($any($event.target).value)">
        </mat-form-field>
      }
      @if (clientSide() && total() !== loadedTotal()) {
        <span class="muted num">{{ total() }} of {{ loadedTotal() }}</span>
      } @else {
        <span class="muted num">{{ total() }} total</span>
      }
      <span class="spacer"></span>
      <ng-content />
    </div>
    @if (selectable() && selection.count()) {
      <admin-bulk-bar [count]="selection.count()" [busy]="bulkBusy()" [hint]="offPageHint()" (clear)="selection.clear()"
                      [matchingTotal]="offerAllMatching() ? total() : null" [filtered]="!!filter().trim()"
                      (selectAll)="selectAllMatching()">
        <ng-content select="[bulkActions]" />
      </admin-bulk-bar>
    }
    @if (loading()) { <mat-progress-bar mode="indeterminate" /> }
    @if (error()) { <div class="banner error" role="alert">{{ error() }}</div> }

    <div class="table-wrap">
      <table mat-table [dataSource]="rows()" matSort (matSortChange)="onSort($event)"
             [matSortActive]="sort().active" [matSortDirection]="sort().direction">
        <ng-container matColumnDef="__select">
          <th mat-header-cell *matHeaderCellDef class="col-select">
            <mat-checkbox [checked]="selection.allSelected(rows())" [indeterminate]="selection.someSelected(rows())"
                          [disabled]="!rows().length" (change)="selection.toggleAll(rows())"
                          aria-label="Select all rows on this page" />
          </th>
          <!-- The cell handles the click (so Shift works); the checkbox is display-only.
               Keyboard users toggle with Space on the focused row. -->
          <td mat-cell *matCellDef="let r" class="col-select" (mousedown)="selection.preventShiftTextSelect($event)" (click)="onCheckboxCell($event, r)">
            <mat-checkbox class="display-only" [checked]="selection.isSelected(r)" [tabIndex]="-1" aria-hidden="true" />
          </td>
        </ng-container>
        @for (c of columns(); track c.id) {
          <ng-container [matColumnDef]="c.id">
            <th mat-header-cell *matHeaderCellDef mat-sort-header [disabled]="c.sortable === false"
                [class.num]="c.kind === 'num'">{{ c.label }}</th>
            <td mat-cell *matCellDef="let r" [class.num]="c.kind === 'num'" [class.mono]="c.kind === 'mono'"
                [class.muted]="isEmpty(r[c.id]) || (c.kind === 'bool' && !truthyValue(r[c.id]))">
              {{ c.format ? c.format(r[c.id], r) : format(c, r[c.id]) }}
            </td>
          </ng-container>
        }
        <tr mat-header-row *matHeaderRowDef="columnIds(); sticky: true"></tr>
        <tr mat-row *matRowDef="let r; columns: columnIds()" class="clickable"
            [class.selected]="r.uuid && r.uuid === selectedUuid()" [class.checked]="selection.isSelected(r)"
            (mousedown)="selection.preventShiftTextSelect($event)"
            (click)="onRowClick($event, r)" tabindex="0" (keydown.enter)="rowClick.emit(r)"
            (keydown.space)="$event.preventDefault(); selectable() && selection.toggle(r)"></tr>
        <tr class="mat-row" *matNoDataRow>
          <td class="mat-cell empty muted" [attr.colspan]="columnIds().length">
            {{ loading() ? 'Loading…' : filter() ? 'Nothing matches “' + filter() + '”.' : emptyText() }}
          </td>
        </tr>
      </table>
    </div>
    @if (total() > pageSize()) {
      <mat-paginator [length]="total()" [pageIndex]="pageIndex()" [pageSize]="pageSize()"
                     [pageSizeOptions]="[25, 50, 100, 250, 500]" (page)="onPage($event)" showFirstLastButtons />
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .toolbar { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
    .filter { width: 300px; }
    .spacer { flex: 1; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; }
    td { white-space: nowrap; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover td { background: var(--mat-sys-surface-container-low); }
    tr.clickable:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: -2px; }
    tr.checked td { background: color-mix(in srgb, var(--mat-sys-secondary-container) 55%, transparent); }
    tr.selected td { background: var(--mat-sys-secondary-container) !important; }
    .col-select { width: 48px; padding-right: 0 !important; }
    td.col-select { cursor: pointer; }
    .display-only { pointer-events: none; }
    .empty { padding: 24px 16px; }
    .banner.error { padding: 10px 14px; border-radius: 8px; margin: 8px 0;
                    background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
  `],
})
export class IdnodeGridComponent implements OnChanges {
  private readonly tvh = inject(TvheadendService);

  /** Grid endpoint, e.g. "mpegts/network/grid". */
  readonly path = input.required<string>();
  readonly columns = input.required<GridColumn[]>();
  /** Field the search box filters on; omit to hide the search box. */
  readonly filterField = input<string | null>(null);
  readonly filterLabel = input('Filter');
  readonly defaultSort = input<Sort>({ active: '', direction: '' });
  readonly params = input<Record<string, string | number>>({});
  readonly selectedUuid = input<string | null>(null);
  readonly emptyText = input('Nothing here yet.');
  /** Show checkboxes and allow multi-select (default on). */
  readonly selectable = input(true);
  /** Load all rows once and search/filter/sort/page in the browser. */
  readonly clientSide = input(false);
  /** Client-side: fields the search box matches (default: `filterField`). */
  readonly searchFields = input<string[] | null>(null);
  /** Client-side: extra filter from the page (e.g. tags, network). */
  readonly rowFilter = input<((row: any) => boolean) | null>(null);

  readonly rowClick = output<any>();

  readonly rows = signal<any[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly filter = signal('');
  readonly sort = signal<Sort>({ active: '', direction: '' });
  readonly pageIndex = signal(0);
  readonly pageSize = signal(50);
  /** Set by the page while a bulk action runs. */
  readonly bulkBusy = signal(false);

  readonly selection = new RowSelection<any>(r => String(r?.uuid || ''));

  /** Client-side mode: every row from the server, and those passing search + filter. */
  private allRows: any[] = [];
  private filteredRows: any[] = [];
  readonly loadedTotal = signal(0);

  private readonly filter$ = new Subject<string>();
  private request?: Subscription;

  constructor() {
    this.filter$.pipe(debounceTime(300)).subscribe(() => {
      this.pageIndex.set(0);
      if (this.clientSide()) this.applyClient(); else this.refresh();
    });
  }

  columnIds = () => (this.selectable() ? ['__select'] : []).concat(this.columns().map(c => c.id));

  /** Plain click opens the row; Ctrl/⌘/Shift-click changes the selection instead. */
  onRowClick(event: MouseEvent, row: any): void {
    if (this.selectable()) {
      if (this.selection.handleClick(event, row, this.rows())) return;
      this.selection.selectOnly(row); // also the start point for a Shift-click range
    }
    this.rowClick.emit(row);
  }

  onCheckboxCell(event: MouseEvent, row: any): void {
    this.selection.cellClick(event, row, this.rows());
  }

  /** Once the whole page is ticked, offer to extend the selection to every matching row. */
  offerAllMatching(): boolean {
    return this.selection.allSelected(this.rows()) && this.total() > this.rows().length
      && this.selection.count() < this.total();
  }

  /** Fetch every row matching the current filter (just once, all pages) and select them. */
  selectAllMatching(): void {
    if (this.clientSide()) {
      this.selection.addAll(this.filteredRows);
      return;
    }
    const sort = this.sort();
    this.bulkBusy.set(true);
    this.tvh.getGridPage(this.path(), {
      start: 0,
      limit: Math.max(this.total(), 1),
      sort: sort.direction ? sort.active : undefined,
      dir: sort.direction === 'desc' ? 'DESC' : 'ASC',
      filterField: this.filterField() || undefined,
      filter: this.filter(),
      params: this.params(),
    }).subscribe({
      next: page => {
        this.selection.addAll(page.entries);
        this.bulkBusy.set(false);
      },
      error: () => this.bulkBusy.set(false),
    });
  }

  offPageHint(): string {
    const here = this.rows().filter(r => this.selection.isSelected(r)).length;
    const elsewhere = this.selection.count() - here;
    return elsewhere > 0 ? `${elsewhere} not shown on this page` : '';
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['defaultSort'] && !this.sort().active) this.sort.set(this.defaultSort());
    // Column changes (e.g. narrower while an editor is open) don't need new data or a page reset.
    if (changes['path'] || changes['params']) {
      this.pageIndex.set(0);
      this.refresh();
    } else if (changes['rowFilter'] && this.clientSide()) {
      this.pageIndex.set(0);
      this.applyClient();
    }
  }

  refresh(): void {
    if (this.clientSide()) {
      this.refreshClient();
      return;
    }
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    const sort = this.sort();
    this.request = this.tvh.getGridPage(this.path(), {
      start: this.pageIndex() * this.pageSize(),
      limit: this.pageSize(),
      sort: sort.direction ? sort.active : undefined,
      dir: sort.direction === 'desc' ? 'DESC' : 'ASC',
      filterField: this.filterField() || undefined,
      filter: this.filter(),
      params: this.params(),
    }).subscribe({
      next: page => {
        this.rows.set(page.entries);
        this.total.set(page.total);
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.rows.set([]);
        this.total.set(0);
        this.error.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load this list (${err?.status || 'network error'}).`);
      },
    });
  }

  /** Client-side mode: fetch everything, then filter/sort/page locally. */
  private refreshClient(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.request = this.tvh.getGridPage(this.path(), { start: 0, limit: 100000, params: this.params() }).subscribe({
      next: page => {
        this.allRows = page.entries;
        this.loadedTotal.set(page.entries.length);
        this.loading.set(false);
        this.applyClient();
      },
      error: err => {
        this.loading.set(false);
        this.allRows = [];
        this.loadedTotal.set(0);
        this.applyClient();
        this.error.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load this list (${err?.status || 'network error'}).`);
      },
    });
  }

  /** Re-run search, filter, sort and paging over the loaded rows. */
  applyClient(): void {
    const q = this.filter().trim().toLowerCase();
    const fields = this.searchFields() || (this.filterField() ? [this.filterField()!] : []);
    const extra = this.rowFilter();
    let rows = this.allRows.filter(r =>
      (!q || fields.some(f => String(r?.[f] ?? '').toLowerCase().includes(q))) && (!extra || extra(r)));

    const { active, direction } = this.sort();
    if (active && direction) {
      const col = this.columns().find(c => c.id === active);
      const key = (r: any) => col?.sortValue ? col.sortValue(r) : r?.[active];
      const dir = direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const ka = key(a), kb = key(b);
        const ea = ka === null || ka === undefined || ka === '', eb = kb === null || kb === undefined || kb === '';
        if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1; // blanks last either way
        if (typeof ka === 'number' && typeof kb === 'number') return (ka - kb) * dir;
        // numeric-aware text compare: "3.2" < "3.10" < "100", "WPSU 2" < "WPSU 10"
        return String(ka).localeCompare(String(kb), undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });
    }

    this.filteredRows = rows;
    this.total.set(rows.length);
    const pages = Math.max(1, Math.ceil(rows.length / this.pageSize()));
    if (this.pageIndex() >= pages) this.pageIndex.set(pages - 1);
    const start = this.pageIndex() * this.pageSize();
    this.rows.set(rows.slice(start, start + this.pageSize()));
  }

  onFilter(value: string): void {
    this.filter.set(value);
    this.filter$.next(value);
  }

  onSort(sort: Sort): void {
    this.sort.set(sort);
    this.pageIndex.set(0);
    if (this.clientSide()) this.applyClient(); else this.refresh();
  }

  onPage(e: PageEvent): void {
    this.pageIndex.set(e.pageIndex);
    this.pageSize.set(e.pageSize);
    if (this.clientSide()) this.applyClient(); else this.refresh();
  }

  isEmpty(v: unknown): boolean {
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  }

  truthyValue(v: unknown): boolean {
    return truthy(v) || v === 'true';
  }

  format(c: GridColumn, v: unknown): string {
    if (this.isEmpty(v)) return c.kind === 'bool' ? 'No' : '—';
    switch (c.kind) {
      case 'bool': return this.truthyValue(v) ? 'Yes' : 'No';
      case 'list': return Array.isArray(v) ? v.join(', ') : String(v);
      case 'num': return typeof v === 'number' ? v.toLocaleString() : String(v);
      default: return Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
}
