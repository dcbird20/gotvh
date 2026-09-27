import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

/**
 * Bar shown above a table while rows are selected. Put the action buttons
 * inside it; it supplies the count, a busy spinner and "Clear".
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
      @if (hint()) { <span class="hint">{{ hint() }}</span> }
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
  `],
})
export class BulkBarComponent {
  readonly count = input.required<number>();
  readonly busy = input(false);
  /** Short note, e.g. "includes rows on other pages". */
  readonly hint = input('');
  readonly clear = output<void>();
}
