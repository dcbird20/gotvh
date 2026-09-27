import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TvheadendService, truthy } from '@gotvh/tvh-api';

export interface MapServicesData {
  /** Service grid rows (svcname, network, channel, enabled, encrypted, dvb_servicetype, uuid). */
  services: any[];
}

/** DVB service types that are radio (digital radio, FM-coded, advanced codec radio). */
const RADIO_TYPES = new Set([0x02, 0x07, 0x0a]);

const on = (v: unknown) => truthy(v) || v === 'true';
const isMapped = (s: any) => Array.isArray(s?.channel) ? s.channel.length > 0 : !!s?.channel;
const isRadio = (s: any) => RADIO_TYPES.has(Number(s?.dvb_servicetype));
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Turn services into channels with Tvheadend's service mapper — the stock
 * "Map services" button with its options explained, and progress shown.
 */
@Component({
  selector: 'admin-map-services-dialog',
  standalone: true,
  imports: [FormsModule, RouterLink, MatDialogModule, MatButtonModule, MatCheckboxModule, MatProgressBarModule],
  template: `
    <h2 mat-dialog-title>{{ phase() === 'options' ? 'Map services to channels' : phase() === 'running' ? 'Mapping…' : 'Done' }}</h2>
    <mat-dialog-content>
      @if (phase() === 'options') {
        <p>
          <strong>{{ plural(toMap().length, 'service') }}</strong> will become channels.
          @if (skippedText()) { <span class="muted">Left out: {{ skippedText() }}.</span> }
        </p>
        @if (sample().length) {
          <p class="sample muted small">{{ sample().join(', ') }}{{ candidates().length > sample().length ? ' …' : '' }}</p>
        }

        <div class="opts">
          @if (radioCount()) {
            <mat-checkbox [(ngModel)]="includeRadio">Include {{ plural(radioCount(), 'radio station') }}</mat-checkbox>
          }
          @if (encryptedCount()) {
            <mat-checkbox [(ngModel)]="encrypted">Include {{ plural(encryptedCount(), 'encrypted service') }}
              <span class="hint">Only useful with a descrambler.</span></mat-checkbox>
          }
          <mat-checkbox [(ngModel)]="mergeSameName">Merge services with the same name into one channel
            <span class="hint">The same station on antenna and IPTV becomes one channel fed by both.</span></mat-checkbox>
          <mat-checkbox [(ngModel)]="tidyName">Tidy names <span class="hint">Drop a trailing “HD” and similar from channel names.</span></mat-checkbox>
          <mat-checkbox [(ngModel)]="typeTags">Tag channels as HD, SD or Radio</mat-checkbox>
          <mat-checkbox [(ngModel)]="providerTags">Tag channels with the provider name</mat-checkbox>
          <mat-checkbox [(ngModel)]="networkTags">Tag channels with the network name</mat-checkbox>
          <mat-checkbox [(ngModel)]="checkAvailability">Check each service can be received first
            <span class="hint">Tunes every service in turn — slow, but skips dead ones.</span></mat-checkbox>
        </div>
        @if (error()) { <p class="err">{{ error() }}</p> }
      } @else {
        @if (phase() === 'running') { <mat-progress-bar [mode]="progress() === null ? 'indeterminate' : 'determinate'" [value]="progress() ?? 0" /> }
        <p class="status">{{ statusText() }}</p>
        @if (phase() === 'done') {
          <p class="muted small">Next: check the new channels’ numbers and guide data. Channels without guide data can be matched on EPG sources → EPG channels.</p>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (phase() === 'options') {
        <button mat-button mat-dialog-close>Cancel</button>
        <button mat-flat-button (click)="start()" [disabled]="!toMap().length">
          Map {{ plural(toMap().length, 'service') }}
        </button>
      } @else if (phase() === 'running') {
        <button mat-button (click)="stop()">Stop</button>
      } @else {
        <button mat-button [mat-dialog-close]="true">Close</button>
        <a mat-flat-button routerLink="/channels" [mat-dialog-close]="true">Open Channels</a>
      }
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { min-width: min(560px, 85vw); }
    .opts { display: flex; flex-direction: column; gap: 2px; margin: 8px 0 0 -8px; }
    .hint { display: block; font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); }
    .small { font: var(--mat-sys-body-small); }
    .sample { margin-top: -6px; }
    .status { margin-top: 12px; }
    .err { color: var(--mat-sys-error); }
  `],
})
export class MapServicesDialogComponent {
  private readonly data = inject<MapServicesData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<MapServicesDialogComponent, boolean>);
  private readonly tvh = inject(TvheadendService);
  private readonly destroyRef = inject(DestroyRef);

  readonly plural = plural;
  readonly phase = signal<'options' | 'running' | 'done'>('options');
  readonly error = signal('');
  readonly status = signal<{ total: number; ok: number; fail: number; ignore: number; active?: string } | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;

  includeRadio = false;
  encrypted = false;
  mergeSameName = true;
  tidyName = false;
  typeTags = true;
  providerTags = false;
  networkTags = false;
  checkAvailability = false;

  private readonly all = this.data.services;
  readonly mapped = this.all.filter(isMapped);
  readonly disabled = this.all.filter(s => !isMapped(s) && s?.enabled !== undefined && !on(s.enabled));
  readonly candidates = signal(this.all.filter(s => !isMapped(s) && (s?.enabled === undefined || on(s.enabled))));
  readonly radioCount = computed(() => this.candidates().filter(isRadio).length);
  readonly encryptedCount = computed(() => this.candidates().filter(s => on(s?.encrypted)).length);

  constructor() {
    // Mapping only radio stations? Then include them.
    this.includeRadio = this.radioCount() > 0 && this.radioCount() === this.candidates().length;
    this.destroyRef.onDestroy(() => this.clearTimer());
  }

  toMap(): any[] {
    return this.candidates().filter(s => (this.includeRadio || !isRadio(s)) && (this.encrypted || !on(s?.encrypted)));
  }

  readonly sample = computed(() => this.candidates().slice(0, 8).map(s => String(s?.svcname || '?')));

  skippedText(): string {
    const radio = this.includeRadio ? 0 : this.radioCount();
    const enc = this.encrypted ? 0 : this.candidates().filter(x => on(x?.encrypted) && (this.includeRadio || !isRadio(x))).length;
    return [
      this.mapped.length ? `${this.mapped.length} already on a channel` : '',
      this.disabled.length ? `${this.disabled.length} disabled` : '',
      radio ? plural(radio, 'radio station') : '',
      enc ? `${enc} encrypted` : '',
    ].filter(Boolean).join(', ');
  }

  /** Mapper counters before we asked, to tell our run apart from an earlier one. */
  private baseline: string | null = null;
  private started = false;
  private startedAt = 0;
  private requested: string[] = [];
  /** Checked against the services themselves once the mapper is done. */
  readonly verified = signal<{ mapped: number; of: number } | null>(null);

  start(): void {
    const services = this.toMap().map(s => String(s.uuid));
    this.requested = services;
    this.error.set('');
    const key = (x: { total: number; ok: number; fail: number; ignore: number; active?: string }) =>
      `${x.total}/${x.ok}/${x.fail}/${x.ignore}/${x.active || ''}`;
    this.tvh.getMapperStatus().subscribe({
      next: before => this.send(services, key(before)),
      error: () => this.send(services, null),
    });
  }

  private send(services: string[], baseline: string | null): void {
    this.baseline = baseline;
    this.tvh.mapServices(services, {
      encrypted: this.encrypted, merge_same_name: this.mergeSameName, tidy_channel_name: this.tidyName,
      check_availability: this.checkAvailability, type_tags: this.typeTags,
      provider_tags: this.providerTags, network_tags: this.networkTags,
    }).subscribe({
      next: () => {
        this.phase.set('running');
        this.ref.disableClose = true;
        this.started = false;
        this.startedAt = Date.now();
        this.timer = setInterval(() => this.poll(), 1000);
      },
      error: err => this.error.set(`Tvheadend didn’t accept the request (${err?.status || 'network error'}).`),
    });
  }

  /**
   * Tvheadend starts mapping when it next saves settings (about 3 seconds
   * later), so wait until the counters move before reading them as ours.
   */
  private poll(): void {
    this.tvh.getMapperStatus().subscribe({
      next: s => {
        const key = `${s.total}/${s.ok}/${s.fail}/${s.ignore}/${s.active || ''}`;
        if (!this.started && (s.active || (this.baseline !== null && key !== this.baseline))) this.started = true;
        if (!this.started) {
          if (Date.now() - this.startedAt > 12000) this.finish(); // never saw it start: check the services directly
          return;
        }
        this.status.set(s);
        if (!s.active && s.ok + s.fail + s.ignore >= s.total) this.finish();
      },
      error: () => this.finish(),
    });
  }

  stop(): void {
    this.tvh.stopMapper().subscribe({ next: () => this.finish(), error: () => this.finish() });
  }

  private finish(): void {
    this.clearTimer();
    // The services themselves are the final word on what got mapped.
    this.tvh.getGrid('mpegts/service/grid').subscribe({
      next: rows => {
        const wanted = new Set(this.requested);
        const mapped = rows.filter((r: any) => wanted.has(String(r.uuid)) && isMapped(r)).length;
        this.verified.set({ mapped, of: this.requested.length });
        this.done();
      },
      error: () => this.done(),
    });
  }

  private done(): void {
    this.phase.set('done');
    this.ref.disableClose = false;
  }

  private clearTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  progress(): number | null {
    const s = this.status();
    if (!s || !s.total) return null;
    return Math.round((s.ok + s.fail + s.ignore) / s.total * 100);
  }

  statusText(): string {
    const s = this.status(), v = this.verified();
    if (this.phase() === 'running') {
      if (!s) return 'Waiting for Tvheadend to start (a few seconds)…';
      return `Working — ${s.ok + s.fail + s.ignore} of ${s.total} checked, ${plural(s.ok, 'service')} mapped so far.`;
    }
    const parts: string[] = [];
    if (v) parts.push(`${v.mapped} of ${plural(v.of, 'service')} ${v.mapped === 1 ? 'is' : 'are'} now on a channel`);
    else if (s) parts.push(`${plural(s.ok, 'service')} mapped to channels`);
    if (s?.fail) parts.push(`${s.fail} couldn’t be received`);
    if (v && v.mapped < v.of) {
      parts.push(`the rest were skipped by Tvheadend — usually because it hasn’t seen video or audio on them yet (scan the mux, or tune to it once), or they’re data-only`);
    }
    return parts.join('; ') + '.';
  }
}
