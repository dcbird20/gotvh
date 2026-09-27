import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { TvheadendService } from '@gotvh/tvh-api';
import { BulkResult, describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent, formatIntsplit } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';

interface EditorState {
  uuid: string | null;
  creating?: boolean;
  bulkUuids?: string[];
  title: string;
}

/**
 * Channels: list, edit, create, delete — and change settings on many channels
 * at once (select rows → Edit…). Mapping services to channels is a separate job
 * (not built yet); new channels can be linked to services in the editor.
 */
@Component({
  selector: 'admin-channels',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatDialogModule, MatSnackBarModule, IdnodeGridComponent, IdnodeFormComponent],
  template: `
    <div class="admin-page wide">
      <h1>Channels</h1>
      <p class="subtitle">Channel numbers, names, tags and which services feed them. Select several to change a setting on all of them.</p>

      <div class="layout" [class.with-editor]="!!editor()">
        <admin-idnode-grid
          path="channel/grid" [columns]="columns()" filterField="name" filterLabel="Filter by name"
          [defaultSort]="{ active: 'number', direction: 'asc' }" [selectedUuid]="editor()?.uuid ?? null"
          emptyText="No channels yet. Map services from a scanned network, or add one."
          (rowClick)="open({ uuid: $event.uuid, title: $event.name || 'Channel' })">
          <button mat-flat-button (click)="openNew()"><mat-icon>add</mat-icon> New channel</button>

          <ng-container ngProjectAs="[bulkActions]">
            <button mat-button (click)="bulkEdit()"><mat-icon>edit</mat-icon> Edit…</button>
            <button mat-button (click)="bulkSetEnabled(true)">Enable</button>
            <button mat-button (click)="bulkSetEnabled(false)">Disable</button>
            <button mat-button class="danger-text" (click)="bulkDelete()"><mat-icon>delete</mat-icon> Delete</button>
          </ng-container>
        </admin-idnode-grid>

        @if (editor(); as e) {
          <admin-idnode-form
            [uuid]="e.uuid" [bulkUuids]="e.bulkUuids || null"
            [createPath]="e.creating ? 'channel' : null" [title]="e.title"
            (saved)="onSaved($event)" (closed)="close()">
            @if (e.uuid) {
              <button formExtraActions mat-button type="button" class="danger-text" (click)="deleteOne(e)">Delete</button>
            }
          </admin-idnode-form>
        }
      </div>
    </div>
  `,
  styles: [`
    .wide { max-width: none; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    .layout.with-editor { grid-template-columns: minmax(0, 1fr) 460px; }
    .danger-text { color: var(--mat-sys-error); }
    @media (max-width: 1100px) { .layout.with-editor { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class ChannelsComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild(IdnodeGridComponent) grid?: IdnodeGridComponent;
  @ViewChild(IdnodeFormComponent) form?: IdnodeFormComponent;

  readonly editor = signal<EditorState | null>(null);
  private readonly tagNames = signal(new Map<string, string>());

  readonly columns = computed<GridColumn[]>(() => {
    const tags = this.tagNames();
    const base: GridColumn[] = [
      // Tvheadend sends channel numbers ready to show: 100, or "3.1" for major.minor.
      { id: 'number', label: '#', kind: 'num', format: (v: unknown) => (v === 0 || v === '0' || v === '' || v == null) ? '—' : formatIntsplit(v) },
      { id: 'name', label: 'Channel' },
      { id: 'enabled', label: 'Enabled', kind: 'bool' },
    ];
    if (this.editor()) return base; // narrower while editing
    return base.concat([
      {
        id: 'tags', label: 'Tags', sortable: false,
        format: (v: unknown) => (Array.isArray(v) ? v : []).map(u => tags.get(String(u)) || '?').join(', ') || '—',
      },
      {
        id: 'services', label: 'Services', sortable: false,
        format: (v: unknown) => String(Array.isArray(v) ? v.length : 0),
      },
    ]);
  });

  ngOnInit(): void {
    this.tvh.getChannelTags().subscribe(tags =>
      this.tagNames.set(new Map(tags.map((t: any) => [String(t?.uuid || ''), String(t?.name || '')]))));
  }

  // ---------------------------------------------------------------- editor

  open(state: EditorState): void {
    const cur = this.editor();
    if (cur && !cur.bulkUuids && !state.bulkUuids && cur.uuid === state.uuid && !!cur.creating === !!state.creating) return;
    this.confirmDiscard().subscribe(ok => { if (ok) this.editor.set(state); });
  }

  openNew(): void {
    this.open({ uuid: null, creating: true, title: 'New channel' });
  }

  close(): void {
    this.confirmDiscard().subscribe(ok => { if (ok) this.editor.set(null); });
  }

  onSaved(event: { uuid: string | null; created: boolean; bulk?: BulkResult }): void {
    if (event.bulk) {
      this.snack.open(describeBulk('Updated', event.bulk, 'channel'), undefined, { duration: 4000 });
      this.editor.set(null);
    } else if (event.created) {
      this.snack.open('Channel created', undefined, { duration: 3000 });
      this.editor.set(event.uuid ? { uuid: event.uuid, title: '' } : null);
    } else {
      this.snack.open('Channel saved', undefined, { duration: 3000 });
    }
    this.grid?.refresh();
  }

  // ---------------------------------------------------------------- bulk

  bulkEdit(): void {
    const uuids = this.grid?.selection.keys() || [];
    if (!uuids.length) return;
    this.open({ uuid: null, bulkUuids: uuids, title: `Edit ${uuids.length} ${uuids.length === 1 ? 'channel' : 'channels'}` });
  }

  bulkSetEnabled(enabled: boolean): void {
    const grid = this.grid;
    if (!grid) return;
    grid.bulkBusy.set(true);
    runBulk(grid.selection.keys(), uuid => this.tvh.idnodeSave(uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, 'channel'), undefined, { duration: 4000 });
      if (!result.failed) grid.selection.clear();
      grid.refresh();
    });
  }

  bulkDelete(): void {
    const grid = this.grid;
    if (!grid) return;
    const rows = grid.selection.rows();
    this.confirmDelete(rows.map(r => ({ uuid: String(r.uuid), name: String(r.name || r.uuid) })));
  }

  deleteOne(e: EditorState): void {
    if (e.uuid) this.confirmDelete([{ uuid: e.uuid, name: e.title || 'this channel' }]);
  }

  private confirmDelete(items: Array<{ uuid: string; name: string }>): void {
    const names = items.slice(0, 3).map(i => `“${i.name}”`).join(', ') + (items.length > 3 ? ` and ${items.length - 3} more` : '');
    const data: ConfirmDialogData = {
      title: `Delete ${items.length} ${items.length === 1 ? 'channel' : 'channels'}?`,
      message: `${names} will be removed. Scheduled recordings and auto-record rules on them stop working.`,
      confirm: 'Delete',
      destructive: true,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.grid?.bulkBusy.set(true);
      const uuids = items.map(i => i.uuid);
      runBulk(uuids, uuid => this.tvh.idnodeDelete(uuid)).subscribe(result => {
        this.grid?.bulkBusy.set(false);
        this.snack.open(describeBulk('Deleted', result, 'channel'), undefined, { duration: 4000 });
        this.grid?.selection.clear();
        const open = this.editor();
        if (open && (uuids.includes(open.uuid || '') || open.bulkUuids)) this.editor.set(null);
        this.grid?.refresh();
      });
    });
  }

  private confirmDiscard(): Observable<boolean> {
    if (!this.form?.hasUnsavedChanges()) return of(true);
    const data: ConfirmDialogData = { title: 'Discard changes?', message: 'You have unsaved changes.', confirm: 'Discard', destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }
}
