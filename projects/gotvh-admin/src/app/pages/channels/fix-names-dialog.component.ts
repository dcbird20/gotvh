import { Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { NameFix, proposedName } from '../../shared/channel-naming';

export interface FixNamesResult { renames: Array<{ uuid: string; name: string }> }

/** Review and apply better channel names: placeholders from the playlist, long names shortened. */
@Component({
  selector: 'admin-fix-names-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>Fix channel names</h2>
    <mat-dialog-content>
      <p class="muted">
        @if (placeholders()) { {{ placeholders() }} named after the encoder (“Service01”) get the name from their playlist entry. }
        @if (longs()) { {{ longs() }} long playlist {{ longs() === 1 ? 'name' : 'names' }} can be shortened. }
      </p>
      <mat-checkbox [checked]="shortenAll()" (change)="shortenAll.set($event.checked)">
        Shorten “PA | Johnstown | ABC WATM” to “ABC WATM”
      </mat-checkbox>
      <table>
        <thead><tr><th></th><th>#</th><th>Now</th><th>New name</th></tr></thead>
        <tbody>
          @for (f of fixes; track f.uuid) {
            @let next = name(f);
            <tr [class.same]="next === f.current">
              <td><mat-checkbox [checked]="picked().has(f.uuid)" (change)="toggle(f.uuid, $event.checked)" [disabled]="next === f.current" /></td>
              <td class="num">{{ f.number }}</td>
              <td class="muted">{{ f.current || '(no name)' }}</td>
              <td><strong>{{ next }}</strong></td>
            </tr>
          }
        </tbody>
      </table>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button (click)="apply()" [disabled]="!count()">Rename {{ count() }} {{ count() === 1 ? 'channel' : 'channels' }}</button>
    </mat-dialog-actions>
  `,
  styles: [`
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { text-align: left; font: var(--mat-sys-label-medium); color: var(--mat-sys-on-surface-variant); padding: 4px 8px; }
    td { padding: 2px 8px; border-top: 1px solid var(--mat-sys-outline-variant); }
    td.num { font-variant-numeric: tabular-nums; }
    tr.same { opacity: .5; }
    .muted { color: var(--mat-sys-on-surface-variant); }
  `],
})
export class FixNamesDialogComponent {
  readonly fixes = inject<NameFix[]>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<FixNamesDialogComponent, FixNamesResult>);
  readonly shortenAll = signal(true);
  readonly picked = signal(new Set(this.fixes.map(f => f.uuid)));
  readonly placeholders = computed(() => this.fixes.filter(f => f.kind === 'placeholder').length);
  readonly longs = computed(() => this.fixes.filter(f => f.kind === 'long').length);
  readonly count = computed(() => this.fixes.filter(f => this.picked().has(f.uuid) && this.nameFor(f, this.shortenAll()) !== f.current).length);

  name(f: NameFix): string { return this.nameFor(f, this.shortenAll()); }
  private nameFor(f: NameFix, s: boolean): string { return proposedName(f, s); }

  toggle(uuid: string, on: boolean): void {
    const next = new Set(this.picked());
    if (on) next.add(uuid); else next.delete(uuid);
    this.picked.set(next);
  }

  apply(): void {
    const renames = this.fixes
      .filter(f => this.picked().has(f.uuid) && this.name(f) !== f.current)
      .map(f => ({ uuid: f.uuid, name: this.name(f) }));
    this.ref.close({ renames });
  }
}
