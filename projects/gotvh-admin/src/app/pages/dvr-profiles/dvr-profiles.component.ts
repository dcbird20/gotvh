import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';

interface ProfileRow {
  uuid: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  storage: string;
  comment: string;
}

const BASE = 'dvr/config';

/**
 * DVR profiles (Tvheadend "DVR configuration" entries). The list is a grid
 * call; editing and creating use the generic metadata-driven idnode form.
 */
@Component({
  selector: 'admin-dvr-profiles',
  standalone: true,
  imports: [MatTableModule, MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, MatDialogModule,
    MatSnackBarModule, IdnodeFormComponent],
  template: `
    <div class="admin-page wide">
      <div class="head">
        <div>
          <h1>DVR profiles</h1>
          <p class="subtitle">Where recordings are stored, how long they're kept, and which stream profile they use.</p>
        </div>
        <button mat-flat-button (click)="openNew()"><mat-icon>add</mat-icon> New profile</button>
      </div>
      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }
      @if (error()) { <div class="banner error" role="alert">{{ error() }}</div> }

      <div class="layout" [class.with-editor]="editorOpen()">
        <table mat-table [dataSource]="rows()">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>Profile</th>
            <td mat-cell *matCellDef="let r">
              <span class="name">{{ r.isDefault ? 'Default profile' : r.name }}</span>
              @if (r.isDefault) { <span class="tag">default</span> }
              @if (r.comment) { <div class="muted small">{{ r.comment }}</div> }
            </td>
          </ng-container>
          <ng-container matColumnDef="enabled">
            <th mat-header-cell *matHeaderCellDef>Status</th>
            <td mat-cell *matCellDef="let r" [class.muted]="!r.enabled">{{ r.enabled ? 'Enabled' : 'Disabled' }}</td>
          </ng-container>
          <ng-container matColumnDef="storage">
            <th mat-header-cell *matHeaderCellDef>Storage path</th>
            <td mat-cell *matCellDef="let r"><code>{{ r.storage || '—' }}</code></td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns()"></tr>
          <tr mat-row *matRowDef="let r; columns: columns()" class="clickable"
              [class.selected]="selected() === r.uuid" (click)="select(r)"></tr>
          <tr class="mat-row" *matNoDataRow>
            <td class="mat-cell empty muted" [attr.colspan]="columns().length">{{ loading() ? 'Loading…' : 'No DVR profiles found.' }}</td>
          </tr>
        </table>

        @if (editorOpen()) {
          <admin-idnode-form
            [uuid]="selected()"
            [createPath]="creating() ? base : null"
            [title]="editorTitle()"
            (saved)="onSaved($event)"
            (closed)="close()">
            @if (selectedRow(); as r) {
              <button formExtraActions mat-button type="button" class="danger-text" (click)="confirmDelete(r)"
                      [disabled]="r.isDefault" [matTooltip]="r.isDefault ? 'The default profile can’t be deleted' : ''">
                Delete
              </button>
            }
          </admin-idnode-form>
        }
      </div>
    </div>
  `,
  styles: [`
    .wide { max-width: none; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    .layout.with-editor { grid-template-columns: minmax(0, 1fr) 460px; }
    table { width: 100%; }
    .name { font-weight: 500; }
    .small { font: var(--mat-sys-body-small); }
    .tag { margin-left: 8px; padding: 0 6px; border-radius: 4px; font: var(--mat-sys-label-small);
           background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    code { font-size: 12px; word-break: break-all; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover td { background: var(--mat-sys-surface-container-low); }
    tr.selected td { background: var(--mat-sys-secondary-container) !important; }
    .empty { padding: 24px 16px; }
    .banner.error { padding: 10px 14px; border-radius: 8px; margin: 8px 0 12px;
                    background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
    .danger-text { color: var(--mat-sys-error); }
    @media (max-width: 1100px) { .layout.with-editor { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class DvrProfilesComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild(IdnodeFormComponent) editor?: IdnodeFormComponent;

  readonly base = BASE;
  readonly loading = signal(false);
  readonly error = signal('');
  readonly rows = signal<ProfileRow[]>([]);
  readonly selected = signal<string | null>(null);
  readonly creating = signal(false);

  readonly editorOpen = computed(() => this.creating() || !!this.selected());
  readonly selectedRow = computed(() => this.rows().find(r => r.uuid === this.selected()) || null);
  readonly columns = computed(() => this.editorOpen() ? ['name', 'enabled'] : ['name', 'enabled', 'storage']);
  readonly editorTitle = computed(() => this.creating()
    ? 'New DVR profile'
    : (this.selectedRow()?.isDefault ? 'Default profile' : this.selectedRow()?.name || 'DVR profile'));

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.tvh.getGrid(`${BASE}/grid`).subscribe({
      next: entries => {
        this.rows.set(entries.map(e => ({
          uuid: String(e?.uuid || ''),
          name: String(e?.name || '').trim(),
          isDefault: !String(e?.name || '').trim(),
          enabled: e?.enabled === undefined ? true : truthy(e.enabled),
          storage: String(e?.storage || ''),
          comment: String(e?.comment || ''),
        })).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)));
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.error.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load DVR profiles (${err?.status || 'network error'}).`);
      },
    });
  }

  select(row: ProfileRow): void {
    if (row.uuid === this.selected() && !this.creating()) return;
    this.confirmDiscard().subscribe(ok => {
      if (!ok) return;
      this.creating.set(false);
      this.selected.set(row.uuid);
    });
  }

  openNew(): void {
    this.confirmDiscard().subscribe(ok => {
      if (!ok) return;
      this.selected.set(null);
      this.creating.set(true);
    });
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => {
      if (!ok) return;
      this.selected.set(null);
      this.creating.set(false);
    });
  }

  onSaved(event: { uuid: string | null; created: boolean }): void {
    this.snack.open(event.created ? 'Profile created' : 'Profile saved', undefined, { duration: 3000 });
    if (event.created) {
      this.creating.set(false);
      this.selected.set(event.uuid);
    }
    this.load();
  }

  confirmDelete(row: ProfileRow): void {
    const data: ConfirmDialogData = {
      title: 'Delete DVR profile?',
      message: `“${row.name}” will be removed. Recordings and rules that use it fall back to the default profile.`,
      confirm: 'Delete',
      destructive: true,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.tvh.idnodeDelete(row.uuid).subscribe({
        next: () => {
          this.snack.open(`Deleted “${row.name}”`, undefined, { duration: 3000 });
          this.selected.set(null);
          this.load();
        },
        error: err => this.snack.open(`Delete failed (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
      });
    });
  }

  /** Ask before throwing away unsaved edits. */
  private confirmDiscard(): Observable<boolean> {
    if (!this.editor?.hasUnsavedChanges()) return of(true);
    const data: ConfirmDialogData = {
      title: 'Discard changes?',
      message: 'You have unsaved changes to this profile.',
      confirm: 'Discard',
      destructive: true,
    };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }
}
