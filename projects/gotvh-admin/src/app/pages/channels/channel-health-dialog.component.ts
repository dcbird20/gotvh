import { Component, WritableSignal, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { ChannelIssue, describeProblem } from '../../shared/channel-health';

export interface ChannelRepair {
  uuid: string;
  name: string;
  /** New services for the channel, antenna first. Empty with `disable` set = switch the channel off. */
  services: string[];
  /** Guide to take over from a removed duplicate, when the channel has none. */
  epggrab?: string[];
  /** Disabled duplicate channels to delete. */
  remove: Array<{ uuid: string; name: string }>;
  disable?: boolean;
}

/**
 * Review the proposed repairs: which feeds each broken channel gets, and which disabled
 * duplicates go. Everything sensible is pre-ticked, so the usual case is one click.
 */
@Component({
  selector: 'admin-channel-health-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatCheckboxModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Channels with nothing to play</h2>
    <mat-dialog-content>
      <p class="muted">
        These channels are switched on but have no working feed, so they fail as soon as you tune in or a recording starts.
        @if (fixable()) { A working feed for the same station was found for {{ fixable() }} of them. }
      </p>
      @for (i of data; track i.uuid) {
        <section class="issue">
          <div class="head">
            <strong>{{ i.number ? i.number + ' · ' : '' }}{{ i.name }}</strong>
            <span class="muted small">{{ problem(i) }}</span>
          </div>
          @if (i.candidates.length) {
            <div class="label small">Play it from</div>
            @for (c of i.candidates; track c.serviceUuid) {
              <mat-checkbox [checked]="isPicked(i.uuid, c.serviceUuid)" (change)="pick(i.uuid, c.serviceUuid, $event.checked)">
                <span class="feed">
                  <mat-icon inline>{{ c.iptv ? 'public' : 'settings_input_antenna' }}</mat-icon>
                  <strong>{{ c.serviceName }}</strong>
                  <span class="muted"> · {{ c.network }}{{ c.mux && !c.iptv ? ' · ' + c.mux : '' }}</span>
                  <span class="badge">{{ c.reason }}</span>
                </span>
                @if (c.onChannels.length) {
                  <div class="muted small">Now on {{ describeOwners(c.onChannels) }}</div>
                }
              </mat-checkbox>
            }
            @if (i.duplicates.length) {
              <mat-checkbox class="dups" [checked]="removeDups().has(i.uuid)" (change)="setRemove(i.uuid, $event.checked)">
                Remove {{ i.duplicates.length }} disabled {{ i.duplicates.length === 1 ? 'duplicate' : 'duplicates' }}:
                {{ dupNames(i) }}
                @if (!i.hasGuide && guideFrom(i)) { <span class="muted small"> (its guide moves over)</span> }
              </mat-checkbox>
              @if (removeDups().has(i.uuid) && keptByDup(i).length) {
                <div class="muted small indent">Kept: {{ keptByDup(i).join(', ') }} — they carry a feed you unticked.</div>
              }
            }
          } @else {
            <p class="muted small none">
              No other feed for this station was found. Add a source that carries it (Add a source → check a source you already have for new channels),
              or switch the channel off so recordings don’t fail silently.
            </p>
            <mat-checkbox [checked]="disableSet().has(i.uuid)" (change)="setDisable(i.uuid, $event.checked)">Switch this channel off</mat-checkbox>
          }
        </section>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button (click)="apply()" [disabled]="!count()">
        Repair {{ count() }} {{ count() === 1 ? 'channel' : 'channels' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .muted { color: var(--mat-sys-on-surface-variant); }
    .small { font: var(--mat-sys-body-small); }
    .issue { border-top: 1px solid var(--mat-sys-outline-variant); padding: 10px 0; display: flex; flex-direction: column; }
    .head { display: flex; flex-direction: column; margin-bottom: 4px; }
    .label { margin: 4px 0 0; font: var(--mat-sys-label-medium); color: var(--mat-sys-on-surface-variant); }
    .feed { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .badge { margin-left: 6px; padding: 0 8px; border-radius: 10px; font: var(--mat-sys-label-small);
             background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    .dups { margin-top: 4px; }
    .indent { margin-left: 40px; }
    .none { margin: 4px 0; }
  `],
})
export class ChannelHealthDialogComponent {
  readonly data = inject<ChannelIssue[]>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ChannelHealthDialogComponent, ChannelRepair[]>);

  /** channel uuid → picked service uuids. Every candidate starts ticked. */
  readonly picked = signal(new Map(this.data.map(i => [i.uuid, new Set(i.candidates.map(c => c.serviceUuid))])));
  readonly removeDups = signal(new Set(this.data.filter(i => i.candidates.length && i.duplicates.length).map(i => i.uuid)));
  readonly disableSet = signal(new Set<string>());

  readonly fixable = computed(() => this.data.filter(i => i.candidates.length).length);
  readonly count = computed(() => this.data.filter(i => (this.picked().get(i.uuid)?.size ?? 0) > 0 || this.disableSet().has(i.uuid)).length);

  problem(i: ChannelIssue): string { return describeProblem(i.problem); }
  isPicked(ch: string, svc: string): boolean { return !!this.picked().get(ch)?.has(svc); }

  pick(ch: string, svc: string, on: boolean): void {
    const next = new Map(this.picked());
    const set = new Set(next.get(ch) || []);
    if (on) set.add(svc); else set.delete(svc);
    next.set(ch, set);
    this.picked.set(next);
  }

  setRemove(ch: string, on: boolean): void { this.toggle(this.removeDups, ch, on); }
  setDisable(ch: string, on: boolean): void { this.toggle(this.disableSet, ch, on); }
  private toggle(sig: WritableSignal<Set<string>>, id: string, on: boolean): void {
    const next = new Set(sig());
    if (on) next.add(id); else next.delete(id);
    sig.set(next);
  }

  describeOwners(o: ChannelIssue['candidates'][number]['onChannels']): string {
    return o.map(c => `${c.number ? c.number + ' ' : ''}${c.name}${c.enabled ? '' : ' (disabled)'}`).join(', ');
  }

  dupNames(i: ChannelIssue): string {
    return i.duplicates.map(d => `${d.number ? d.number + ' ' : ''}${d.name}`).join(', ');
  }

  /** Duplicates that hold a feed the user unticked stay, so the feed isn't lost. */
  private removable(i: ChannelIssue) {
    const chosen = this.picked().get(i.uuid) || new Set<string>();
    const offered = new Set(i.candidates.map(c => c.serviceUuid));
    return i.duplicates.filter(d => d.services.every(s => chosen.has(s) || !offered.has(s)));
  }
  keptByDup(i: ChannelIssue): string[] {
    const ok = new Set(this.removable(i).map(d => d.uuid));
    return i.duplicates.filter(d => !ok.has(d.uuid)).map(d => d.name);
  }
  guideFrom(i: ChannelIssue): string[] | null {
    return this.removable(i).find(d => d.epggrab.length)?.epggrab ?? null;
  }

  apply(): void {
    const out: ChannelRepair[] = [];
    for (const i of this.data) {
      const chosen = this.picked().get(i.uuid) || new Set<string>();
      if (chosen.size) {
        const remove = this.removeDups().has(i.uuid) ? this.removable(i) : [];
        const guide = !i.hasGuide ? remove.find(d => d.epggrab.length)?.epggrab : undefined;
        out.push({
          uuid: i.uuid, name: i.name,
          services: i.candidates.map(c => c.serviceUuid).filter(s => chosen.has(s)),
          epggrab: guide,
          remove: remove.map(d => ({ uuid: d.uuid, name: d.name })),
        });
      } else if (this.disableSet().has(i.uuid)) {
        out.push({ uuid: i.uuid, name: i.name, services: [], remove: [], disable: true });
      }
    }
    this.ref.close(out);
  }
}
