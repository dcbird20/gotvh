import { Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { GuideCandidate, GuideReason, MatchChannel, MatchGuide, guidesForChannel, indexGuides, pickGuide } from './epg-match';
import { EpgMapPair } from './epg-map-dialog.component';

export interface GuideFinderData {
  /** Your channels that have no guide data yet. */
  channels: MatchChannel[];
  /** Every enabled guide channel. */
  guides: MatchGuide[];
}

interface Row {
  channel: MatchChannel;
  candidates: GuideCandidate[];
  guideUuid: string;
  auto: boolean;
  include: boolean;
}

const REASON: Record<GuideReason, string> = { 'name+number': 'same name & number', name: 'same name', partial: 'similar name', number: 'same number only' };

/**
 * For each of your channels without guide data, suggest guide channels to feed it —
 * starting from your channels, not from the thousands a guide source may list.
 */
@Component({
  selector: 'admin-guide-finder-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>Find guide data for your channels</h2>
    <mat-dialog-content>
      <p class="summary">
        Looked through {{ data.guides.length.toLocaleString() }} guide channels for your {{ rows().length }} channels without guide data.
        <strong>{{ autoCount() }}</strong> matched by name and are ticked; {{ hintCount() }} have only weaker hints to choose from;
        {{ noneCount() }} have nothing.
      </p>
      <mat-button-toggle-group [value]="show()" (change)="show.set($event.value)" hideSingleSelectionIndicator class="show">
        <mat-button-toggle value="all">All ({{ rows().length }})</mat-button-toggle>
        <mat-button-toggle value="auto">Matched ({{ autoCount() }})</mat-button-toggle>
        <mat-button-toggle value="hint">To choose ({{ hintCount() }})</mat-button-toggle>
        <mat-button-toggle value="none">No match ({{ noneCount() }})</mat-button-toggle>
      </mat-button-toggle-group>
      @if (show() === 'none' || (show() === 'all' && noneCount())) {
        <p class="muted small">No match usually means the channel isn’t in your guide sources — antenna channels get
          their guide over the air, so they don’t need one here.</p>
      }
      <div class="rows">
        @for (r of visible(); track r.channel.uuid) {
          <div class="row" [class.off]="!r.include">
            <mat-checkbox [checked]="r.include" [disabled]="!r.guideUuid" (change)="patch(r, { include: $event.checked })" />
            <div class="ch"><span class="num">{{ r.channel.number }}</span> {{ r.channel.name }}</div>
            @if (r.candidates.length) {
              <select class="pick" [value]="r.guideUuid" (change)="choose(r, $any($event.target).value)" [attr.aria-label]="'Guide channel for ' + r.channel.name">
                <option value="">— None —</option>
                @for (c of r.candidates; track c.guide.uuid) {
                  <option [value]="c.guide.uuid" [selected]="c.guide.uuid === r.guideUuid">{{ c.guide.name }}{{ c.guide.number ? ' · ' + c.guide.number : '' }} ({{ reason(c) }})</option>
                }
              </select>
              <div class="why small">
                @let chosen = picked(r);
                @if (chosen) { <span class="badge" [class.strong]="chosen.reason === 'name+number' || chosen.reason === 'name'" [class.warn]="chosen.reason === 'number'">{{ reason(chosen) }}</span>
                  @if (chosen.guide.id) { <div class="muted id">{{ chosen.guide.id }}</div> } }
                @else { <span class="muted">{{ r.candidates.length }} to choose from</span> }
              </div>
            } @else {
              <span class="muted small">No guide channel with this name or number</span><span></span>
            }
          </div>
        } @empty { <p class="muted">Nothing to show.</p> }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!selectedCount()" (click)="apply()">
        Link guide data to {{ selectedCount() }} {{ selectedCount() === 1 ? 'channel' : 'channels' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .summary { margin: 0 0 12px; }
    .show { margin-bottom: 8px; }
    .rows { display: flex; flex-direction: column; min-width: min(820px, 85vw); }
    .row { display: grid; grid-template-columns: 40px minmax(0, 1fr) 340px 150px; align-items: center; gap: 8px;
           padding: 4px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .row.off .ch { opacity: .6; }
    .num { font-variant-numeric: tabular-nums; color: var(--mat-sys-on-surface-variant); margin-right: 4px; }
    .pick { width: 100%; padding: 6px 8px; border-radius: 6px; font: var(--mat-sys-body-medium);
            border: 1px solid var(--mat-sys-outline); background: var(--mat-sys-surface); color: var(--mat-sys-on-surface); }
    .small { font: var(--mat-sys-body-small); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .id { font-family: monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { padding: 1px 8px; border-radius: 10px; font: var(--mat-sys-label-small);
             background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    .badge.strong { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .badge.warn { background: var(--mat-sys-tertiary-container); color: var(--mat-sys-on-tertiary-container); }
  `],
})
export class GuideFinderDialogComponent {
  readonly data = inject<GuideFinderData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<GuideFinderDialogComponent, EpgMapPair[]>);

  private readonly index = indexGuides(this.data.guides);
  readonly rows = signal<Row[]>(this.data.channels.map(channel => {
    const candidates = guidesForChannel(channel, this.index);
    const pick = pickGuide(candidates);
    return { channel, candidates, guideUuid: pick?.guide.uuid || '', auto: !!pick, include: !!pick };
  }));
  readonly show = signal<'all' | 'auto' | 'hint' | 'none'>('all');

  readonly autoCount = computed(() => this.rows().filter(r => r.auto).length);
  readonly hintCount = computed(() => this.rows().filter(r => !r.auto && r.candidates.length).length);
  readonly noneCount = computed(() => this.rows().filter(r => !r.candidates.length).length);
  readonly selectedCount = computed(() => this.rows().filter(r => r.include && r.guideUuid).length);
  readonly visible = computed(() => {
    const s = this.show();
    return this.rows().filter(r => s === 'all' || (s === 'auto' ? r.auto : s === 'hint' ? !r.auto && r.candidates.length : !r.candidates.length));
  });

  reason(c: GuideCandidate): string { return REASON[c.reason]; }
  picked(r: Row): GuideCandidate | undefined { return r.candidates.find(c => c.guide.uuid === r.guideUuid); }

  choose(row: Row, uuid: string): void { this.patch(row, { guideUuid: uuid, include: !!uuid }); }

  patch(row: Row, change: Partial<Row>): void {
    this.rows.update(rows => rows.map(r => r.channel.uuid === row.channel.uuid ? { ...r, ...change } : r));
  }

  apply(): void {
    this.ref.close(this.rows().filter(r => r.include && r.guideUuid).map(r => ({ guideUuid: r.guideUuid, channelUuid: r.channel.uuid })));
  }
}
