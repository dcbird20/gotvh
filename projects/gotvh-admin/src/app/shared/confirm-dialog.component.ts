import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirm?: string;
  destructive?: boolean;
}

/** Small yes/no dialog. Esc or Cancel → false; confirm button → true. */
@Component({
  selector: 'admin-confirm-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content><p>{{ data.message }}</p></mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button [class.danger]="data.destructive" [mat-dialog-close]="true" cdkFocusInitial>
        {{ data.confirm || 'OK' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    p { margin: 0; max-width: 420px; }
    .danger { --mdc-filled-button-container-color: var(--mat-sys-error);
              --mdc-filled-button-label-text-color: var(--mat-sys-on-error); }
  `],
})
export class ConfirmDialogComponent {
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}
