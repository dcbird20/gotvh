import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

export interface ChannelChoice { uuid: string; name: string; number: string }
export interface ProfileChoice { uuid: string; name: string }

export interface AddRecordingData {
  channels: ChannelChoice[];
  profiles: ProfileChoice[];
}

/** Payload for dvr/entry/create. */
export type AddRecordingResult = Record<string, unknown>;

const pad = (n: number) => String(n).padStart(2, '0');

/** A one-off recording by channel and time — for things the guide doesn't list. */
@Component({
  selector: 'admin-add-recording-dialog',
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatAutocompleteModule],
  template: `
    <h2 mat-dialog-title>New recording</h2>
    <form (ngSubmit)="submit()">
      <mat-dialog-content>
        <mat-form-field appearance="outline">
          <mat-label>Channel</mat-label>
          <input matInput name="channel" [ngModel]="channelQuery()" (ngModelChange)="onChannelInput($event)"
                 [matAutocomplete]="auto" autocomplete="off" cdkFocusInitial required>
          <mat-autocomplete #auto="matAutocomplete" (optionSelected)="pickChannel($event.option.value)">
            @for (c of channelMatches(); track c.uuid) {
              <mat-option [value]="c"><span class="num muted">{{ c.number }}</span> {{ c.name }}</mat-option>
            }
          </mat-autocomplete>
          @if (channelQuery() && !channel()) { <mat-hint class="err-hint">Pick a channel from the list.</mat-hint> }
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Title</mat-label>
          <input matInput name="title" [(ngModel)]="title" autocomplete="off" required>
        </mat-form-field>

        <div class="row3">
          <mat-form-field appearance="outline">
            <mat-label>Date</mat-label>
            <input matInput type="date" name="date" [ngModel]="date()" (ngModelChange)="date.set($event)" required>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Start</mat-label>
            <input matInput type="time" name="start" [ngModel]="startTime()" (ngModelChange)="startTime.set($event)" required>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>End</mat-label>
            <input matInput type="time" name="end" [ngModel]="endTime()" (ngModelChange)="endTime.set($event)" required>
          </mat-form-field>
        </div>
        <p class="summary" [class.err]="!!timeError()">{{ timeError() || summary() }}</p>

        <mat-form-field appearance="outline">
          <mat-label>DVR profile</mat-label>
          <mat-select name="profile" [(ngModel)]="profile">
            @for (p of data.profiles; track p.uuid) { <mat-option [value]="p.uuid">{{ p.name }}</mat-option> }
          </mat-select>
          <mat-hint>Where it’s saved and how much padding is added before and after.</mat-hint>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Comment (optional)</mat-label>
          <input matInput name="comment" [(ngModel)]="comment" autocomplete="off">
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancel</button>
        <button mat-flat-button type="submit" [disabled]="!canSubmit()">Schedule recording</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [`
    mat-dialog-content { display: flex; flex-direction: column; gap: 10px; min-width: min(560px, 85vw); padding-top: 8px !important; }
    mat-form-field { width: 100%; }
    .row3 { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 12px; }
    .summary { margin: -4px 0 6px; font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); }
    .summary.err, .err-hint { color: var(--mat-sys-error); }
    .num { display: inline-block; min-width: 44px; font-variant-numeric: tabular-nums; }
  `],
})
export class AddRecordingDialogComponent {
  readonly data = inject<AddRecordingData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<AddRecordingDialogComponent, AddRecordingResult>);

  readonly channel = signal<ChannelChoice | null>(null);
  readonly channelQuery = signal('');
  readonly date = signal('');
  readonly startTime = signal('');
  readonly endTime = signal('');
  title = '';
  comment = '';
  profile = this.data.profiles[0]?.uuid ?? '';

  constructor() {
    // Default: the next half hour, for one hour.
    const d = new Date(Math.ceil(Date.now() / 1800000) * 1800000);
    const e = new Date(d.getTime() + 3600000);
    this.date.set(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    this.startTime.set(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    this.endTime.set(`${pad(e.getHours())}:${pad(e.getMinutes())}`);
  }

  readonly channelMatches = computed(() => {
    const q = this.channelQuery().trim().toLowerCase();
    const list = this.data.channels;
    if (!q) return list.slice(0, 50);
    return list.filter(c => c.name.toLowerCase().includes(q) || c.number === q || c.number.startsWith(q + '.')).slice(0, 50);
  });

  onChannelInput(value: unknown): void {
    if (value && typeof value === 'object') return; // an option was picked; handled by pickChannel
    this.channelQuery.set(String(value ?? ''));
    this.channel.set(null);
  }

  pickChannel(c: ChannelChoice): void {
    this.channel.set(c);
    this.channelQuery.set(c.number ? `${c.number} ${c.name}` : c.name);
  }

  /** Start and stop as epoch seconds; the end rolls to the next day when it's earlier than the start. */
  readonly times = computed(() => {
    if (!this.date() || !this.startTime() || !this.endTime()) return null;
    const start = new Date(`${this.date()}T${this.startTime()}`);
    let stop = new Date(`${this.date()}T${this.endTime()}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) return null;
    const nextDay = stop <= start;
    if (nextDay) stop = new Date(stop.getTime() + 86400000);
    return { start: Math.round(start.getTime() / 1000), stop: Math.round(stop.getTime() / 1000), nextDay };
  });

  readonly timeError = computed(() => {
    const t = this.times();
    if (!t) return 'Enter a date, start and end.';
    if (t.stop * 1000 < Date.now()) return 'That time has already passed.';
    if (t.stop - t.start > 12 * 3600) return 'That’s longer than 12 hours — check the times.';
    return '';
  });

  readonly summary = computed(() => {
    const t = this.times();
    if (!t) return '';
    const mins = Math.round((t.stop - t.start) / 60);
    const len = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60 ? (mins % 60) + ' min' : ''}`.trim() : `${mins} min`;
    const when = new Date(t.start * 1000).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const started = t.start * 1000 < Date.now() ? ' — already started, so it begins right away' : '';
    return `${when}, ${len}${t.nextDay ? ' (ends the next day)' : ''}${started}.`;
  });

  canSubmit(): boolean {
    return !!this.channel() && !!this.title.trim() && !this.timeError();
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const t = this.times()!;
    const conf: Record<string, unknown> = {
      enabled: 1,
      channel: this.channel()!.uuid,
      start: t.start,
      stop: t.stop,
      disp_title: this.title.trim(),
      comment: this.comment.trim(),
    };
    if (this.profile) conf['config_name'] = this.profile;
    this.ref.close(conf);
  }
}
