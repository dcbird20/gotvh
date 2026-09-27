import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

/**
 * Bar shown above a table while rows are selected. Put the action buttons
 * inside it; it supplies the count, "Select all N matching", a busy spinner
 * and "Clear".
 */
@Component({
  selector: 'admin-bulk-bar',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  template: `
    <div class="bar" role="toolbar" [attr.aria-label]="count() + ' selected'">
      <button mat-icon-button (click)="clear.emit()" aria-label="Clear selection" [disabled]="busy()">
        <mat-icon>close</mat-icon>
      </button>
      <strong class="num">{{ count() }} selected</strong>
      @if (offerAll()) {
        <button mat-button class="select-all" (click)="selectAll.emit()" [disabled]="busy()">
          Select all {{ matchingTotal() }}{{ filtered() ? ' matching' : '' }}
        </button>
      } @else if (hint()) {
        <span class="hint">{{ hint() }}</span>
      } @else if (count() === 1) {
        <span class="hint">Shift-click another row to select everything in between</span>
      }
      <span class="spacer"></span>
      @if (busy()) { <mat-spinner diameter="20" /> }
      <ng-content />
    </div>
  `,
  styles: [`
    .bar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      min-height: 48px; padding: 4px 8px 4px 4px; margin-bottom: 8px; border-radius: 10px;
      background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container);
    }
    .spacer { flex: 1; }
    .hint { font: var(--mat-sys-body-small); opacity: .8; }
    .select-all { text-decoration: underline; text-underline-offset: 3px; }
  `],
})
export class BulkBarComponent {
  readonly count = input.required<number>();
  readonly busy = input(false);
  /** Short note, e.g. "12 not shown on this page". */
  readonly hint = input('');
  /** Set when the whole page is selected but more rows match: offers "Select all N". */
  readonly matchingTotal = input<number | null>(null);
  /** Whether a filter is active (wording only). */
  readonly filtered = input(false);
  readonly clear = output<void>();
  readonly selectAll = output<void>();

  offerAll(): boolean {
    const total = this.matchingTotal();
    return total !== null && total > this.count();
  }
}
