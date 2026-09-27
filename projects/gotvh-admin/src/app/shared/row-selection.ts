import { computed, signal } from '@angular/core';

/**
 * Multi-row selection for admin tables, with desktop conventions:
 *  - checkbox click or Ctrl/⌘-click toggles one row
 *  - Shift-click selects the range from the last clicked row
 *  - header checkbox selects/clears every row currently shown
 *
 * Rows are remembered by key (uuid) with a snapshot of the row, so the
 * selection survives paging, sorting and filtering in server-paged tables.
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
    if (!this.canSelect(row)) return;
    const key = this.keyOf(row);
    this.map.update(m => {
      const next = new Map(m);
      if (next.has(key)) next.delete(key); else next.set(key, row);
      return next;
    });
    this.anchorKey = key;
  }

  /** Plain click in a table with nothing to open: select just this row (file-manager style). */
  selectOnly(row: T): void {
    if (!this.canSelect(row)) return;
    const key = this.keyOf(row);
    this.map.set(new Map([[key, row]]));
    this.anchorKey = key;
  }

  /** Shift-click: select everything between the last clicked row and this one, within `visible`. */
  selectRange(row: T, visible: T[]): void {
    const keys = visible.map(r => this.keyOf(r));
    const to = keys.indexOf(this.keyOf(row));
    const from = this.anchorKey ? keys.indexOf(this.anchorKey) : -1;
    if (to < 0) return;
    if (from < 0) { this.toggle(row); return; }
    const [a, b] = from < to ? [from, to] : [to, from];
    this.map.update(m => {
      const next = new Map(m);
      for (const r of visible.slice(a, b + 1)) {
        if (this.canSelect(r)) next.set(this.keyOf(r), r);
      }
      return next;
    });
  }

  /**
   * Handle a row click. Returns true when the click was a selection gesture
   * (so the caller should NOT open the row in the editor).
   */
  handleClick(event: MouseEvent, row: T, visible: T[]): boolean {
    if (event.shiftKey) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges(); // shift-click otherwise highlights text
      this.selectRange(row, visible);
      return true;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.toggle(row);
      return true;
    }
    return false;
  }

  /**
   * Click on a row's checkbox cell: toggle, or Shift-click for a range. Call
   * from the cell's (click) and render the checkbox with pointer-events: none,
   * so the Shift key is seen (a real checkbox would toggle first).
   */
  cellClick(event: MouseEvent, row: T, visible: T[]): void {
    event.stopPropagation(); // don't open the row
    if (event.shiftKey) {
      window.getSelection()?.removeAllRanges();
      this.selectRange(row, visible);
    } else {
      this.toggle(row);
    }
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

  /** Drop rows that no longer exist (after a reload). */
  retain(keys: Set<string>): void {
    this.map.update(m => new Map([...m].filter(([k]) => keys.has(k))));
  }

  clear(): void {
    this.map.set(new Map());
    this.anchorKey = null;
  }
}
