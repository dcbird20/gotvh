import { Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatchChannel, MatchGuide, MatchReason, matchGuideChannel } from './epg-match';

export interface EpgMapDialogData {
  guides: MatchGuide[];
  channels: MatchChannel[];
}

export interface EpgMapPair {
  guideUuid: string;
  channelUuid: string;
}

interface Row {
  guide: MatchGuide;
  channelUuid: string;
  reason: MatchReason | null;
  tied: number;
  include: boolean;
}

const REASON_LABEL: Record<MatchReason, string> = { number: 'same number', name: 'same name', partial: 'similar name' };

/**
 * Review proposed guide-channel → channel links before applying them.
 * Matches are pre-filled and ticked; anything unmatched or ambiguous is left
 * for a choice. Closes with the ticked pairs, or undefined on cancel.
 */
@Component({
  selector: 'admin-epg-map-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule, MatFormFieldModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>Map guide channels to channels</h2>
    <mat-dialog-content>
      <p class="summary">
        <strong>{{ matchedCount() }}</strong> of {{ rows().length }} matched automatically{{ needsChoice() ? ' — ' : '.' }}@if (needsChoice()) {<strong>{{ needsChoice() }}</strong> need a choice.}
        Check the pairs, change any that are wrong, then map.
      </p>
      <mat-button-toggle-group [value]="show()" (change)="show.set($event.value)" hideSingleSelectionIndicator class="show">
        <mat-button-toggle value="all">All ({{ rows().length }})</mat-button-toggle>
        <mat-button-toggle value="matched">Matched ({{ matchedCount() }})</mat-button-toggle>
        <mat-button-toggle value="choose">Need a choice ({{ needsChoice() }})</mat-button-toggle>
      </mat-button-toggle-group>

      <div class="rows">
        @for (r of visible(); track r.guide.uuid) {
          <div class="row" [class.off]="!r.include">
            <mat-checkbox [checked]="r.include" [disabled]="!r.channelUuid" (change)="setInclude(r, $event.checked)"
                          [attr.aria-label]="'Map ' + r.guide.name" />
            <div class="guide">
              <div class="g-name">{{ r.guide.name || r.guide.id }}</div>
              <div class="muted small">
                @if (r.guide.number) { #{{ r.guide.number }} · }{{ r.guide.id }}
              </div>
            </div>
            <mat-form-field appearance="outline" class="pick">
              <mat-select [value]="r.channelUuid" (valueChange)="choose(r, $event)" placeholder="Choose a channel…">
                <mat-option value="">— Don’t map —</mat-option>
                @for (c of data.channels; track c.uuid) {
                  <mat-option [value]="c.uuid">{{ c.number ? c.number + ' ' : '' }}{{ c.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <div class="why small">
              @if (r.reason) { <span class="badge" [class.strong]="r.reason !== 'partial'">{{ label(r.reason) }}</span> }
              @else if (r.tied > 1) { <span class="badge warn">{{ r.tied }} possible</span> }
              @else if (!r.channelUuid) { <span class="muted">no match</span> }
              @else { <span class="muted">your choice</span> }
            </div>
          </div>
        } @empty {
          <p class="muted">Nothing to show.</p>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!selectedCount()" (click)="apply()">
        Map {{ selectedCount() }} {{ selectedCount() === 1 ? 'channel' : 'channels' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .summary { margin: 0 0 12px; }
    .show { margin-bottom: 12px; }
    .rows { display: flex; flex-direction: column; min-width: min(760px, 80vw); }
    .row { display: grid; grid-template-columns: 40px minmax(0, 1fr) 280px 110px; align-items: center; gap: 8px;
           padding: 4px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .row.off .guide { opacity: .6; }
    .g-name { font-weight: 500; }
    .small { font: var(--mat-sys-body-small); }
    .pick { width: 100%; }
    .badge { padding: 1px 8px; border-radius: 10px; font: var(--mat-sys-label-small);
             background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    .badge.strong { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .badge.warn { background: var(--mat-sys-tertiary-container); color: var(--mat-sys-on-tertiary-container); }
  `],
})
export class EpgMapDialogComponent {
  readonly data = inject<EpgMapDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<EpgMapDialogComponent, EpgMapPair[]>);

  readonly rows = signal<Row[]>(this.data.guides.map(g => {
    const m = matchGuideChannel(g, this.data.channels);
    return { guide: g, channelUuid: m.channel?.uuid || '', reason: m.reason, tied: m.tiedWith.length, include: !!m.channel };
  }));
  readonly show = signal<'all' | 'matched' | 'choose'>('all');

  readonly matchedCount = computed(() => this.rows().filter(r => r.reason).length);
  readonly needsChoice = computed(() => this.rows().filter(r => !r.reason).length);
  readonly selectedCount = computed(() => this.rows().filter(r => r.include && r.channelUuid).length);
  readonly visible = computed(() => {
    const s = this.show();
    return this.rows().filter(r => s === 'all' || (s === 'matched' ? !!r.reason : !r.reason));
  });

  label(reason: MatchReason): string {
    return REASON_LABEL[reason];
  }

  choose(row: Row, uuid: string): void {
    this.patch(row, { channelUuid: uuid, include: !!uuid, reason: uuid === row.channelUuid ? row.reason : null });
  }

  setInclude(row: Row, include: boolean): void {
    this.patch(row, { include });
  }

  private patch(row: Row, change: Partial<Row>): void {
    this.rows.update(rows => rows.map(r => r.guide.uuid === row.guide.uuid ? { ...r, ...change } : r));
  }

  apply(): void {
    this.ref.close(this.rows()
      .filter(r => r.include && r.channelUuid)
      .map(r => ({ guideUuid: r.guide.uuid, channelUuid: r.channelUuid })));
  }
}
