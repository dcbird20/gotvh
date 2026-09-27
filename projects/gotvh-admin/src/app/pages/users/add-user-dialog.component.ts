import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';

export type UserRole = 'viewer' | 'recorder' | 'admin';

export interface AddUserResult {
  username: string;
  password: string;
  role: UserRole;
  prefix: string;
  comment: string;
}

export interface AddUserData {
  /** Usernames already in use (access or password entries), lower-cased. */
  taken: string[];
}

export const ROLE_INFO: Record<UserRole, { label: string; detail: string }> = {
  viewer: { label: 'Viewer', detail: 'Watch live TV and the guide, schedule and play their own recordings.' },
  recorder: { label: 'Recorder', detail: 'Everything a viewer can do, plus see and manage everyone’s recordings.' },
  admin: { label: 'Administrator', detail: 'Full access, including all settings in this admin app.' },
};

/** Collect what's needed to create a user: both the access entry and the password entry. */
@Component({
  selector: 'admin-add-user-dialog',
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatRadioModule],
  template: `
    <h2 mat-dialog-title>Add user</h2>
    <form (ngSubmit)="submit()" #f="ngForm">
      <mat-dialog-content>
        <mat-form-field appearance="outline">
          <mat-label>Username</mat-label>
          <input matInput name="username" [(ngModel)]="username" required autocomplete="off" cdkFocusInitial
                 (ngModelChange)="touched.set(true)">
          @if (usernameError()) { <mat-hint class="err-hint">{{ usernameError() }}</mat-hint> }
        </mat-form-field>
        <div class="row2">
          <mat-form-field appearance="outline">
            <mat-label>Password</mat-label>
            <input matInput type="password" name="password" [(ngModel)]="password" required autocomplete="new-password">
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Confirm password</mat-label>
            <input matInput type="password" name="confirm" [(ngModel)]="confirm" required autocomplete="new-password">
          </mat-form-field>
        </div>
        @if (confirm && password !== confirm) { <p class="err">Passwords don’t match.</p> }

        <p class="label">Role</p>
        <mat-radio-group name="role" [(ngModel)]="role" class="roles">
          @for (r of roles; track r) {
            <mat-radio-button [value]="r">
              <strong>{{ info[r].label }}</strong>
              <span class="muted small"> — {{ info[r].detail }}</span>
            </mat-radio-button>
          }
        </mat-radio-group>

        <mat-form-field appearance="outline" class="prefix">
          <mat-label>Allowed networks</mat-label>
          <input matInput name="prefix" [(ngModel)]="prefix" autocomplete="off" spellcheck="false">
          <mat-hint>Where this user may connect from. “0.0.0.0/0,::/0” is anywhere; e.g. “192.168.1.0/24” is your home network only.</mat-hint>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Comment (optional)</mat-label>
          <input matInput name="comment" [(ngModel)]="comment" autocomplete="off">
        </mat-form-field>
        <p class="muted small">You can fine-tune rights afterwards in the user’s settings.</p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancel</button>
        <button mat-flat-button type="submit" [disabled]="!canSubmit()">Add user</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [`
    mat-dialog-content { display: flex; flex-direction: column; min-width: min(560px, 85vw); }
    mat-form-field { width: 100%; }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .label { font: var(--mat-sys-title-small); margin: 8px 0 4px; }
    .roles { display: flex; flex-direction: column; gap: 2px; margin-bottom: 16px; }
    .small { font: var(--mat-sys-body-small); }
    .err-hint { color: var(--mat-sys-error); }
    .err { color: var(--mat-sys-error); margin: -8px 0 8px; font: var(--mat-sys-body-small); }
    .prefix { margin-top: 4px; }
  `],
})
export class AddUserDialogComponent {
  private readonly data = inject<AddUserData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<AddUserDialogComponent, AddUserResult>);

  readonly roles: UserRole[] = ['viewer', 'recorder', 'admin'];
  readonly info = ROLE_INFO;
  readonly touched = signal(false);

  username = '';
  password = '';
  confirm = '';
  role: UserRole = 'viewer';
  prefix = '0.0.0.0/0,::/0';
  comment = '';

  usernameError(): string {
    const u = this.username.trim();
    if (!u) return this.touched() ? 'Enter a username.' : '';
    if (u === '*') return '“*” means anyone — use a real username.';
    if (/\s/.test(u)) return 'No spaces.';
    if (this.data.taken.includes(u.toLowerCase())) return 'That username is already in use.';
    return '';
  }

  canSubmit(): boolean {
    return !!this.username.trim() && !this.usernameError() && !!this.password && this.password === this.confirm;
  }

  submit(): void {
    if (!this.canSubmit()) return;
    this.ref.close({
      username: this.username.trim(),
      password: this.password,
      role: this.role,
      prefix: this.prefix.trim() || '0.0.0.0/0,::/0',
      comment: this.comment.trim(),
    });
  }
}
