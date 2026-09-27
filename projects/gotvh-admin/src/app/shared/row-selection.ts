import { computed, signal } from '@angular/core';

/**
 * Multi-row selection for admin tables, following file-manager conventions
 * (and the stock Tvheadend grids):
 *
 *  - click a row             → select just that row (and open it, if the table has an editor)
 *  - Shift-click another row → select every row from the first click to this one
 *  - Ctrl/⌘-click            → add or remove one row
 *  - Ctrl/⌘+Shift-click      → add a range to what's already selected
 *  - checkbox                → add or remove one row; Shift on a checkbox adds a range
 *  - header checkbox         → every row on the page; "Select all N matching" goes further
 *
 * The range always starts at the last row clicked without Shift (the anchor).
 * Rows are remembered by key (uuid) with a snapshot, so the selection survives
 * paging, sorting and filtering in server-paged tables.
 */
export class RowSelection<T> {
  private readonly map = signal(new Map<string, T>());
  private anchorKey: string | null = null;

  readonly count = computed(() => this.map().size);
  readonly rows = computed(() => [...this.map().values()]);
  readonly keys = computed(() => [...this.map().keys()]);

  constructor(
    private readonly keyOf: (row: T) => string,
    /** Rows that can't be selected (e.g. the default DVR profile). */
    private readonly canSelect: (row: T) => boolean = () => true,
  ) {}

  isSelected(row: T): boolean {
    return this.map().has(this.keyOf(row));
  }

  selectable(row: T): boolean {
    return this.canSelect(row);
  }

  toggle(row: T): void {
    const key = this.keyOf(row);
    this.anchorKey = key;
    if (!this.canSelect(row)) return;
    this.map.update(m => {
      const next = new Map(m);
      if (next.has(key)) next.delete(key); else next.set(key, row);
      return next;
    });
  }

  /** Plain click: select just this row and make it the start of any Shift-click range. */
  selectOnly(row: T): void {
    this.anchorKey = this.keyOf(row);
    this.map.set(this.canSelect(row) ? new Map([[this.keyOf(row), row]]) : new Map());
  }

  /**
   * Rows from the anchor to `row` (inclusive) within `visible`, or null if the
   * anchor isn't on screen (e.g. it was on another page).
   */
  private rangeTo(row: T, visible: T[]): T[] | null {
    const keys = visible.map(r => this.keyOf(r));
    const to = keys.indexOf(this.keyOf(row));
    const from = this.anchorKey ? keys.indexOf(this.anchorKey) : -1;
    if (to < 0 || from < 0) return null;
    const [a, b] = from < to ? [from, to] : [to, from];
    return visible.slice(a, b + 1).filter(r => this.canSelect(r));
  }

  /** Shift-click: the selection becomes exactly anchor…row. With `add`, the range is added instead. */
  selectRange(row: T, visible: T[], add = false): void {
    const range = this.rangeTo(row, visible);
    if (!range) {
      // No usable starting point: treat it as the first click of a new range.
      if (add) this.toggle(row); else this.selectOnly(row);
      return;
    }
    this.map.update(m => {
      const next = add ? new Map(m) : new Map<string, T>();
      for (const r of range) next.set(this.keyOf(r), r);
      return next;
    });
    // The anchor stays put, so Shift-clicking again adjusts the same range.
  }

  /**
   * Handle a click on a row. Returns true when it was a selection gesture
   * (Shift or Ctrl/⌘) — the caller should then NOT open the row. For a plain
   * click it returns false; call selectOnly() and open the row as usual.
   */
  handleClick(event: MouseEvent, row: T, visible: T[]): boolean {
    const multi = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.selectRange(row, visible, multi);
      return true;
    }
    if (multi) {
      event.preventDefault();
      this.toggle(row);
      return true;
    }
    return false;
  }

  /**
   * Click on a row's checkbox cell: add/remove one row, or Shift for a range
   * (always added). Render the checkbox with pointer-events: none and call this
   * from the cell's (click), so the Shift key is seen.
   */
  cellClick(event: MouseEvent, row: T, visible: T[]): void {
    event.stopPropagation(); // don't open the row
    if (event.shiftKey) {
      window.getSelection()?.removeAllRanges();
      this.selectRange(row, visible, true);
    } else {
      this.toggle(row);
    }
  }

  /** Shift-mousedown starts a text highlight across rows; stop it before it paints. */
  preventShiftTextSelect(event: MouseEvent): void {
    if (event.shiftKey) event.preventDefault();
  }

  allSelected(visible: T[]): boolean {
    const eligible = visible.filter(r => this.canSelect(r));
    return eligible.length > 0 && eligible.every(r => this.isSelected(r));
  }

  someSelected(visible: T[]): boolean {
    return visible.some(r => this.isSelected(r)) && !this.allSelected(visible);
  }

  /** Header checkbox: select every visible row, or clear them if all are already selected. */
  toggleAll(visible: T[]): void {
    const all = this.allSelected(visible);
    this.map.update(m => {
      const next = new Map(m);
      for (const r of visible) {
        if (!this.canSelect(r)) continue;
        if (all) next.delete(this.keyOf(r)); else next.set(this.keyOf(r), r);
      }
      return next;
    });
  }

  /** Add many rows at once ("Select all N matching"). */
  addAll(rows: T[]): void {
    this.map.update(m => {
      const next = new Map(m);
      for (const r of rows) if (this.canSelect(r)) next.set(this.keyOf(r), r);
      return next;
    });
  }

  /** Drop rows that no longer exist (after a reload). */
  retain(keys: Set<string>): void {
    this.map.update(m => new Map([...m].filter(([k]) => keys.has(k))));
  }

  clear(): void {
    this.map.set(new Map());
    this.anchorKey = null;
  }
}
