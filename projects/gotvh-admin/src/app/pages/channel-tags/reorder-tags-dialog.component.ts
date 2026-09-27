import { Component, inject } from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface ReorderTag { uuid: string; name: string; hidden: boolean }

/** Drag tags into the order clients should show them; returns the uuids in the new order. */
@Component({
  selector: 'admin-reorder-tags-dialog',
  standalone: true,
  imports: [DragDropModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Tag order</h2>
    <mat-dialog-content>
      <p class="muted small">Drag tags, or focus one and use the arrow buttons. Clients such as Kodi and the TV app list tags in this order.</p>
      <div cdkDropList class="list" (cdkDropListDropped)="drop($event)">
        @for (t of tags; track t.uuid; let i = $index) {
          <div class="item" cdkDrag cdkDragLockAxis="y">
            <mat-icon class="handle" cdkDragHandle>drag_indicator</mat-icon>
            <span class="pos">{{ i + 1 }}</span>
            <span class="name">{{ t.name }}</span>
            @if (t.hidden) { <span class="muted small">hidden from clients</span> }
            <span class="spacer"></span>
            <button mat-icon-button (click)="move(i, -1)" [disabled]="i === 0" [attr.aria-label]="'Move ' + t.name + ' up'">
              <mat-icon>arrow_upward</mat-icon>
            </button>
            <button mat-icon-button (click)="move(i, 1)" [disabled]="i === tags.length - 1" [attr.aria-label]="'Move ' + t.name + ' down'">
              <mat-icon>arrow_downward</mat-icon>
            </button>
          </div>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button (click)="save()">Save order</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { min-width: min(480px, 85vw); }
    .small { font: var(--mat-sys-body-small); }
    .list { border: 1px solid var(--mat-sys-outline-variant); border-radius: 8px; overflow: hidden; }
    .item { display: flex; align-items: center; gap: 10px; padding: 2px 8px; min-height: 44px;
            background: var(--mat-sys-surface); border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .item:last-child { border-bottom: 0; }
    .handle { cursor: grab; color: var(--mat-sys-on-surface-variant); }
    .pos { width: 24px; text-align: right; color: var(--mat-sys-on-surface-variant); font-variant-numeric: tabular-nums; }
    .name { font-weight: 500; }
    .spacer { flex: 1; }
    .cdk-drag-preview { box-shadow: var(--mat-sys-level3); display: flex; align-items: center; gap: 10px; padding: 2px 8px;
                        background: var(--mat-sys-surface); border-radius: 8px; }
    .cdk-drag-placeholder { opacity: 0.3; }
    .cdk-drag-animating, .list.cdk-drop-list-dragging .item:not(.cdk-drag-placeholder) { transition: transform 200ms ease; }
  `],
})
export class ReorderTagsDialogComponent {
  private readonly ref = inject(MatDialogRef<ReorderTagsDialogComponent, string[]>);
  readonly tags: ReorderTag[] = [...inject<ReorderTag[]>(MAT_DIALOG_DATA)];

  drop(event: CdkDragDrop<ReorderTag[]>): void {
    moveItemInArray(this.tags, event.previousIndex, event.currentIndex);
  }

  move(i: number, delta: number): void {
    moveItemInArray(this.tags, i, i + delta);
  }

  save(): void {
    this.ref.close(this.tags.map(t => t.uuid));
  }
}
