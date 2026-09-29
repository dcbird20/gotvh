import { Component, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TvheadendService } from '@gotvh/tvh-api';
import { HdhrGuard } from '../../shared/hdhomerun';
import { HdhrSwitchPlan, HdhrSwitchResult, applyHdhrSwitch } from '../../shared/hdhr-playlist';

/** Shows what switching to the HDHomeRun's own streams changes, then does it. */
@Component({
  selector: 'admin-hdhr-switch-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <h2 mat-dialog-title>Let the HDHomeRun manage its tuners</h2>
    <mat-dialog-content>
      @if (!result()) {
        <p>
          Tvheadend now controls the HDHomeRun’s {{ plan.tuners.length }} tuners directly. That’s what causes locked tuners,
          channels that stay silent while other tuners are free, and UDP ports to forward through Docker or a VPN.
          Instead, Tvheadend will ask the HDHomeRun for each channel and the HDHomeRun picks a free tuner itself.
          Over-the-air guide data stops; guide data from your other sources is unaffected.
        </p>
        <h3>What changes</h3>
        <ul>
          @if (!plan.playlist) {
            <li>Add the HDHomeRun’s channel list (http://{{ plan.ip }}/lineup.m3u) as a source.</li>
          }
          @if (plan.moves.length) {
            <li>{{ plan.moves.length }} {{ plan.moves.length === 1 ? 'channel plays' : 'channels play' }} from the HDHomeRun’s stream instead of a native tuner:
              <span class="muted">{{ names(plan.moves) }}</span></li>
          }
          @if (plan.playlist && plan.playlist.priority < plan.playlistPriority) {
            <li>“{{ plan.playlist.name }}” is tried before your other IPTV sources, which stay as backups.</li>
          }
          <li>Switch off the {{ plan.tuners.length }} native HDHomeRun tuners@if (plan.nativeNets.length) { and the “{{ netNames() }}” network}.</li>
        </ul>
        @if (stranded().length) {
          <p class="warn"><mat-icon inline>warning</mat-icon>
            <span>The HDHomeRun has no stream numbered like {{ names(stranded()) }}, and {{ stranded().length === 1 ? 'it has' : 'they have' }} no other feed,
            so {{ stranded().length === 1 ? 'it' : 'they' }} will have nothing to play. The channel check on Channels will list {{ stranded().length === 1 ? 'it' : 'them' }}.</span></p>
        }
        @if (covered().length) {
          <p class="muted small">No HDHomeRun stream matches {{ names(covered()) }}; {{ covered().length === 1 ? 'it keeps its' : 'they keep their' }} other feeds.</p>
        }
        <p class="muted small">Everything can be switched back on under Tuners &amp; networks.</p>
      } @else {
        @for (l of result()!.lines; track $index) { <p>{{ l }}</p> }
      }
      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
        @for (l of progress(); track $index) { <p class="muted small">{{ l }}</p> }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (result()) {
        <button mat-flat-button [mat-dialog-close]="result()">Done</button>
      } @else {
        <button mat-button mat-dialog-close [disabled]="busy()">Cancel</button>
        <button mat-flat-button (click)="apply()" [disabled]="busy()">Switch</button>
      }
    </mat-dialog-actions>
  `,
  styles: [`
    h3 { font: var(--mat-sys-title-small); margin: 12px 0 4px; }
    ul { margin: 0 0 8px; padding-left: 20px; }
    li { margin: 4px 0; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .small { font: var(--mat-sys-body-small); }
    .warn { color: var(--mat-sys-error); display: flex; gap: 6px; align-items: flex-start; }
  `],
})
export class HdhrSwitchDialogComponent {
  readonly plan = inject<HdhrSwitchPlan>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<HdhrSwitchDialogComponent, HdhrSwitchResult>);
  private readonly tvh = inject(TvheadendService);
  private readonly guard = inject(HdhrGuard);

  readonly busy = signal(false);
  readonly progress = signal<string[]>([]);
  readonly result = signal<HdhrSwitchResult | null>(null);

  names(xs: Array<{ name: string; number: string }>): string {
    const s = xs.slice(0, 6).map(x => `${x.number ? x.number + ' ' : ''}${x.name}`).join(', ');
    return xs.length > 6 ? `${s} and ${xs.length - 6} more` : s;
  }
  stranded() { return this.plan.unmatched.filter(u => !u.otherFeeds); }
  covered() { return this.plan.unmatched.filter(u => u.otherFeeds > 0); }
  netNames(): string { return this.plan.nativeNets.map(n => n.name).join('”, “'); }

  async apply(): Promise<void> {
    this.busy.set(true);
    this.ref.disableClose = true;
    const res = await applyHdhrSwitch(this.tvh, this.guard, this.plan, l => this.progress.update(p => [...p, l]));
    this.busy.set(false);
    this.ref.disableClose = false;
    this.result.set(res);
  }
}
