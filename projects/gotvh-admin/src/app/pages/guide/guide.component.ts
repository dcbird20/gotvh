import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { SplitHandleDirective } from '../../shared/split-handle.directive';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';

interface GuideChannel { uuid: string; name: string; number: string; icon: string; tags: string[] }

interface GuideEvent {
  eventId: number;
  channelUuid: string;
  channelName: string;
  channelNumber: string;
  start: number;
  stop: number;
  title: string;
  subtitle: string;
  summary: string;
  description: string;
  episode: string;
  genre: number[];
  dvrUuid: string;
  dvrState: string;
  serieslink: string;
  isNew: boolean;
  isRepeat: boolean;
  hd: boolean;
}

interface Cell { ev: GuideEvent; left: number; width: number; clippedStart: boolean; clippedEnd: boolean }
interface Row { ch: GuideChannel; cells: Cell[] }

const HALF_HOUR = 1800;
const now = () => Math.floor(Date.now() / 1000);
const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

function toEvent(e: any): GuideEvent {
  return {
    eventId: Number(e?.eventId) || 0,
    channelUuid: String(e?.channelUuid || ''),
    channelName: String(e?.channelName || ''),
    channelNumber: e?.channelNumber ? String(e.channelNumber) : '',
    start: Number(e?.start) || 0,
    stop: Number(e?.stop) || 0,
    title: String(e?.title || '').trim() || '(no title)',
    subtitle: String(e?.subtitle || '').trim(),
    summary: String(e?.summary || '').trim(),
    description: String(e?.description || '').trim(),
    episode: String(e?.episodeOnscreen || '').trim(),
    genre: Array.isArray(e?.genre) ? e.genre.map(Number) : [],
    dvrUuid: String(e?.dvrUuid || ''),
    dvrState: String(e?.dvrState || ''),
    serieslink: String(e?.serieslinkUri || ''),
    isNew: truthy(e?.new),
    isRepeat: truthy(e?.repeat),
    hd: truthy(e?.hd),
  };
}

/** Plain-language recording state from Tvheadend's dvrState. */
function recState(s: string): '' | 'scheduled' | 'recording' | 'recorded' | 'failed' {
  if (!s) return '';
  if (/recording/i.test(s)) return 'recording';
  if (/scheduled/i.test(s)) return 'scheduled';
  if (/completed(?!Error)|completed$/i.test(s) && !/error|failed|missed/i.test(s)) return 'recorded';
  if (/error|failed|missed|rerecord/i.test(s)) return 'failed';
  return 'scheduled';
}

/**
 * Programme guide: channels down the side, time across the top, like Tvheadend's classic EPG
 * grid — click a programme to record it, its series, or open the channel in VLC.
 */
@Component({
  selector: 'admin-guide',
  standalone: true,
  imports: [
    DatePipe, FormsModule, RouterLink, SplitHandleDirective, IdnodeFormComponent, MatButtonModule, MatButtonToggleModule, MatFormFieldModule,
    MatIconModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatSlideToggleModule, MatSnackBarModule, MatTooltipModule,
  ],
  template: `
    <div class="admin-page wide">
      <h1>Guide</h1>
      <p class="subtitle">What’s on, and what’s coming up. Click a programme to record it or its series.</p>

      <div class="bar">
        <div class="nav">
          <button mat-icon-button (click)="shift(-2)" matTooltip="2 hours earlier" aria-label="Earlier"><mat-icon>chevron_left</mat-icon></button>
          <button mat-stroked-button (click)="goNow()">Now</button>
          <button mat-icon-button (click)="shift(2)" matTooltip="2 hours later" aria-label="Later"><mat-icon>chevron_right</mat-icon></button>
        </div>
        <mat-button-toggle-group [value]="dayIndex()" (change)="goDay($event.value)" hideSingleSelectionIndicator class="days" aria-label="Day">
          @for (d of days(); track d.index) {
            <mat-button-toggle [value]="d.index">{{ d.label }}</mat-button-toggle>
          }
        </mat-button-toggle-group>
        <mat-form-field appearance="outline" class="f-time">
          <mat-label>From</mat-label>
          <mat-select [value]="hourOfDay()" (valueChange)="goHour($event)">
            @for (h of hours; track h) { <mat-option [value]="h">{{ hourLabel(h) }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline" class="f-tag">
          <mat-label>Channels</mat-label>
          <mat-select [value]="tag()" (valueChange)="tag.set($event); load()">
            <mat-option value="">All channels</mat-option>
            @for (t of tags(); track t.uuid) { <mat-option [value]="t.uuid">{{ t.name }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-slide-toggle [checked]="onlyWithGuide()" (change)="onlyWithGuide.set($event.checked)">Hide channels without guide</mat-slide-toggle>
        <span class="spacer"></span>
        <mat-form-field appearance="outline" class="f-search">
          <mat-icon matPrefix>search</mat-icon>
          <mat-label>Find a programme</mat-label>
          <input matInput [ngModel]="query()" (ngModelChange)="onQuery($event)" (keydown.escape)="onQuery('')">
        </mat-form-field>
      </div>

      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }
      @if (error()) { <p class="err">{{ error() }}</p> }

      <div class="layout" adminSplit [class.with-editor]="!!selected()">
        <div class="main">
          @if (query().trim().length >= 2) {
            <!-- ===================== search results -->
            <section class="results">
              <p class="muted small">{{ results().length }} upcoming {{ results().length === 1 ? 'showing' : 'showings' }} of “{{ query().trim() }}”</p>
              @for (e of results(); track e.eventId) {
                <button class="result" type="button" (click)="select(e)" [class.sel]="selected()?.eventId === e.eventId">
                  <span class="r-when">{{ e.start * 1000 | date:'EEE d MMM, h:mm a' }}</span>
                  <span class="r-ch">{{ e.channelNumber }} {{ e.channelName }}</span>
                  <span class="r-title"><strong>{{ e.title }}</strong>@if (e.subtitle) { · {{ e.subtitle }} }</span>
                  @if (rec(e); as r) { <span class="pill" [class]="r">{{ r }}</span> }
                </button>
              } @empty { @if (!searching()) { <p class="muted">Nothing found in the guide.</p> } }
            </section>
          } @else {
            <!-- ===================== grid -->
            <div class="grid" role="grid" aria-label="Programme guide">
              <div class="g-head" role="row">
                <div class="g-corner">{{ winStart() * 1000 | date:'EEE d MMM' }}</div>
                <div class="g-times">
                  @for (t of ticks(); track t.at) {
                    <span class="tick" [style.left.%]="t.left">{{ t.at * 1000 | date:'h:mm a' }}</span>
                  }
                  @if (nowLeft() !== null) { <span class="now-flag" [style.left.%]="nowLeft()"></span> }
                </div>
              </div>
              @for (r of rows(); track r.ch.uuid) {
                <div class="g-row" role="row">
                  <div class="g-ch" role="rowheader" [title]="r.ch.name">
                    <span class="num">{{ r.ch.number }}</span>
                    @if (r.ch.icon) { <img [src]="r.ch.icon" alt="" loading="lazy" (error)="$any($event.target).style.display='none'"> }
                    <span class="name">{{ r.ch.name }}</span>
                  </div>
                  <div class="g-line">
                    @for (c of r.cells; track c.ev.eventId) {
                      <button class="prog" type="button" role="gridcell"
                              [style.left.%]="c.left" [style.width.%]="c.width"
                              [class.airing]="isAiring(c.ev)" [class.past]="c.ev.stop <= nowSec()"
                              [class.sel]="selected()?.eventId === c.ev.eventId"
                              [attr.data-rec]="rec(c.ev) || null"
                              [attr.aria-label]="c.ev.title + ', ' + (c.ev.start * 1000 | date:'h:mm a')"
                              (click)="select(c.ev)">
                        <span class="p-title">@if (c.clippedStart) {‹ }{{ c.ev.title }}</span>
                        <span class="p-time">{{ c.ev.start * 1000 | date:'h:mm' }}–{{ c.ev.stop * 1000 | date:'h:mm a' }}@if (c.ev.subtitle) { · {{ c.ev.subtitle }} }</span>
                      </button>
                    } @empty {
                      <span class="empty muted small">No guide data</span>
                    }
                    @if (nowLeft() !== null) { <span class="now-line" [style.left.%]="nowLeft()"></span> }
                  </div>
                </div>
              } @empty {
                @if (!loading()) { <p class="muted pad">No channels to show.</p> }
              }
            </div>
          }
        </div>

        <!-- ===================== details -->
        @if (selected(); as e) {
          <aside class="admin-side">
            @if (autorecFor(); as a) {
              <!-- Auto-record rule, prefilled from the programme; every option Tvheadend has. -->
              <admin-idnode-form createPath="dvr/autorec" [createDefaults]="autorecDefaults()"
                                 [title]="(a.serieslink ? 'Record series: ' : 'Auto-record: ') + a.title"
                                 (saved)="onAutorecSaved(a)" (closed)="autorecFor.set(null)" />
              <p class="muted small hint">
                @if (a.serieslink) { Matches this programme’s series link from the guide, so every episode is recorded
                  whatever its title. }
                @else { Matches the title “{{ a.title }}” on {{ a.channelName }}. Clear the channel to record it anywhere. }
                Padding, retention and the DVR profile are under the form’s sections.
              </p>
            } @else {
            <section class="card detail">
              <div class="d-head">
                <div>
                  <h2>{{ e.title }}</h2>
                  @if (e.subtitle) { <div class="muted">{{ e.subtitle }}</div> }
                </div>
                <button mat-icon-button (click)="selected.set(null)" aria-label="Close"><mat-icon>close</mat-icon></button>
              </div>
              <p class="when">
                {{ e.start * 1000 | date:'EEEE d MMMM, h:mm a' }} – {{ e.stop * 1000 | date:'h:mm a' }}
                <span class="muted">({{ minutes(e) }} min)</span>
              </p>
              <p class="muted small">
                {{ e.channelNumber }} {{ e.channelName }}
                @if (e.episode) { · {{ e.episode }} }
                @if (e.isNew) { · New } @if (e.isRepeat) { · Repeat } @if (e.hd) { · HD }
              </p>
              @if (rec(e); as r) {
                <p class="state" [class]="r">
                  <mat-icon inline>{{ r === 'recording' ? 'fiber_manual_record' : r === 'failed' ? 'error' : r === 'recorded' ? 'check_circle' : 'schedule' }}</mat-icon>
                  {{ r === 'scheduled' ? 'Will be recorded' : r === 'recording' ? 'Recording now' : r === 'recorded' ? 'Recorded' : 'Recording failed' }}
                </p>
              }
              @if (e.summary || e.description) {
                <p class="desc">{{ e.description || e.summary }}</p>
                @if (e.summary && e.description && e.summary !== e.description) { <p class="desc muted">{{ e.summary }}</p> }
              }
              <div class="actions">
                @switch (rec(e)) {
                  @case ('scheduled') { <button mat-stroked-button class="danger-text" (click)="cancel(e)" [disabled]="busy()">Don’t record</button> }
                  @case ('recording') { <button mat-stroked-button class="danger-text" (click)="cancel(e)" [disabled]="busy()">Stop recording</button> }
                  @default {
                    @if (e.stop > nowSec()) {
                      <button mat-flat-button (click)="record(e)" [disabled]="busy()"><mat-icon>fiber_manual_record</mat-icon> Record</button>
                    }
                  }
                }
                @if (e.stop > nowSec()) {
                  <button mat-stroked-button (click)="openAutorec(e)" [disabled]="busy()"
                          [matTooltip]="e.serieslink ? 'An auto-record rule for every episode — check its options, then save' : 'An auto-record rule for this title — check its options, then save'">
                    <mat-icon>event_repeat</mat-icon> {{ e.serieslink ? 'Record series…' : 'Auto-record…' }}
                  </button>
                }
                @if (isAiring(e)) {
                  <button mat-stroked-button (click)="watchInVlc(e)" [disabled]="busy()" matTooltip="Downloads a playlist (.m3u) — open it with VLC">
                    <mat-icon>play_circle</mat-icon> Watch in VLC
                  </button>
                }
              </div>
              <div class="links small">
                <a routerLink="/channels" [queryParams]="{ open: e.channelUuid }">Channel settings</a>
                <a routerLink="/recordings">Recordings</a>
                <a routerLink="/autorec">Auto-record rules</a>
              </div>
            </section>
            }
          </aside>
        }
      </div>
    </div>
  `,
  styles: [`
    .wide { max-width: none; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 8px; }
    .nav { display: flex; align-items: center; gap: 2px; }
    .days { font-size: 13px; }
    .f-time { width: 120px; } .f-tag { width: 200px; } .f-search { width: 260px; }
    .f-time, .f-tag, .f-search { margin-bottom: -18px; }
    .spacer { flex: 1; }
    .err { color: var(--mat-sys-error); }
    .pad { padding: 16px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
    .layout.with-editor { grid-template-columns: minmax(0, 1fr) var(--admin-side-width, 400px); }

    /* ---- grid */
    .grid { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; overflow: hidden;
            background: var(--mat-sys-surface-container-lowest); }
    .g-head, .g-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); }
    .g-head { position: sticky; top: 0; z-index: 3; background: var(--mat-sys-surface-container); border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .g-corner { padding: 8px 12px; font: var(--mat-sys-label-large); border-right: 1px solid var(--mat-sys-outline-variant); }
    .g-times { position: relative; height: 36px; }
    .tick { position: absolute; top: 9px; padding-left: 6px; border-left: 1px solid var(--mat-sys-outline-variant);
            font: var(--mat-sys-label-medium); color: var(--mat-sys-on-surface-variant); white-space: nowrap; }
    .now-flag { position: absolute; bottom: 0; width: 0; height: 0; margin-left: -6px;
                border: 6px solid transparent; border-bottom-color: var(--mat-sys-error); }
    .g-row { border-bottom: 1px solid var(--mat-sys-outline-variant); min-height: 54px; }
    .g-row:last-child { border-bottom: none; }
    .g-ch { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-right: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface-container-low); overflow: hidden; }
    .g-ch .num { font: var(--mat-sys-label-large); font-variant-numeric: tabular-nums; min-width: 34px; color: var(--mat-sys-on-surface-variant); }
    .g-ch img { width: 32px; height: 24px; object-fit: contain; }
    .g-ch .name { font: var(--mat-sys-body-medium); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .g-line { position: relative; }
    .prog { position: absolute; top: 3px; bottom: 3px; display: flex; flex-direction: column; justify-content: center; gap: 1px;
            padding: 2px 8px; text-align: left; font: inherit; color: inherit; cursor: pointer; overflow: hidden;
            border: 1px solid var(--mat-sys-outline-variant); border-radius: 6px; background: var(--mat-sys-surface); box-sizing: border-box; }
    .prog:hover { border-color: var(--mat-sys-primary); z-index: 1; }
    .prog:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: 1px; z-index: 2; }
    .prog.airing { background: var(--mat-sys-surface-container-high); }
    .prog.past { opacity: .6; }
    .prog.sel { border-color: var(--mat-sys-primary); box-shadow: inset 0 0 0 1px var(--mat-sys-primary); }
    .prog[data-rec=scheduled], .prog[data-rec=recording] { border-left: 4px solid var(--mat-sys-error); }
    .prog[data-rec=recording] { background: color-mix(in srgb, var(--mat-sys-error) 12%, var(--mat-sys-surface)); }
    .prog[data-rec=recorded] { border-left: 4px solid #2e9d57; }
    .p-title { font: var(--mat-sys-label-large); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .p-time { font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .now-line { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--mat-sys-error); z-index: 2; pointer-events: none; }
    .empty { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); }

    /* ---- search */
    .results { display: flex; flex-direction: column; }
    .result { display: grid; grid-template-columns: 170px 170px minmax(0, 1fr) auto; gap: 10px; align-items: center; text-align: left;
              font: inherit; color: inherit; cursor: pointer; padding: 8px 10px; border: none; border-bottom: 1px solid var(--mat-sys-outline-variant);
              background: transparent; }
    .result:hover, .result.sel { background: var(--mat-sys-surface-container-low); }
    .r-when, .r-ch { font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); }
    .pill { font: var(--mat-sys-label-small); padding: 2px 8px; border-radius: 10px; background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
    .pill.recorded { background: #d7f2df; color: #145c2e; }

    /* ---- details */
    .card { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: 14px 18px; background: var(--mat-sys-surface-container-lowest); }
    .d-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .d-head h2 { font: var(--mat-sys-title-large); margin: 0; }
    .when { margin: 10px 0 2px; }
    .state { display: flex; align-items: center; gap: 6px; font: var(--mat-sys-label-large); color: var(--mat-sys-error); }
    .state.recorded { color: #2e9d57; }
    .desc { white-space: pre-line; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 8px; }
    .links { display: flex; gap: 14px; a { color: var(--mat-sys-primary); } }
    .hint { margin: 0 4px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .small { font: var(--mat-sys-body-small); }
  `],
})
export class GuideComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  /** Hours shown at once. */
  readonly span = 4;
  readonly hours = Array.from({ length: 24 }, (_, i) => i);

  readonly winStart = signal(floorTo(now(), HALF_HOUR));
  readonly winEnd = computed(() => this.winStart() + this.span * 3600);
  readonly nowSec = signal(now());

  readonly channels = signal<GuideChannel[]>([]);
  readonly tags = signal<Array<{ uuid: string; name: string }>>([]);
  readonly tag = signal('');
  readonly onlyWithGuide = signal(true);
  readonly events = signal<GuideEvent[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly selected = signal<GuideEvent | null>(null);
  readonly busy = signal(false);

  readonly query = signal('');
  readonly results = signal<GuideEvent[]>([]);
  readonly searching = signal(false);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly days = computed(() => {
    const base = new Date(); base.setHours(0, 0, 0, 0);
    return Array.from({ length: 8 }, (_, i) => {
      const d = new Date(base); d.setDate(base.getDate() + i);
      return { index: i, start: d.getTime() / 1000,
        label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) };
    });
  });
  readonly dayIndex = computed(() => {
    const d = this.days(); const s = this.winStart();
    const i = d.findIndex((x, k) => s >= x.start && (k === d.length - 1 || s < d[k + 1].start));
    return i;
  });
  readonly hourOfDay = computed(() => new Date(this.winStart() * 1000).getHours());

  readonly ticks = computed(() => {
    const s = this.winStart(), e = this.winEnd(), out: Array<{ at: number; left: number }> = [];
    for (let t = floorTo(s, HALF_HOUR); t < e; t += HALF_HOUR) if (t >= s) out.push({ at: t, left: (t - s) / (e - s) * 100 });
    return out;
  });
  readonly nowLeft = computed(() => {
    const n = this.nowSec(), s = this.winStart(), e = this.winEnd();
    return n >= s && n < e ? (n - s) / (e - s) * 100 : null;
  });

  readonly rows = computed<Row[]>(() => {
    const s = this.winStart(), e = this.winEnd(), win = e - s;
    const byCh = new Map<string, GuideEvent[]>();
    for (const ev of this.events()) byCh.set(ev.channelUuid, [...(byCh.get(ev.channelUuid) || []), ev]);
    const tag = this.tag();
    return this.channels()
      .filter(ch => !tag || ch.tags.includes(tag))
      .map(ch => ({
        ch,
        cells: (byCh.get(ch.uuid) || []).map(ev => {
          const a = Math.max(ev.start, s), b = Math.min(ev.stop, e);
          return { ev, left: (a - s) / win * 100, width: Math.max(0.4, (b - a) / win * 100), clippedStart: ev.start < s, clippedEnd: ev.stop > e };
        }),
      }))
      .filter(r => !this.onlyWithGuide() || r.cells.length);
  });

  ngOnInit(): void {
    forkJoin({
      channels: this.tvh.getGrid('channel/grid', { limit: 100000 }).pipe(catchError(() => of([]))),
      tags: this.tvh.getGrid('channeltag/grid').pipe(catchError(() => of([]))),
    }).subscribe(({ channels, tags }) => {
      this.channels.set(channels
        .filter((c: any) => c?.enabled === undefined || truthy(c.enabled))
        .map((c: any) => ({ uuid: String(c.uuid), name: String(c.name || ''), number: c.number ? String(c.number) : '',
          icon: String(c.icon_public_url || '').replace(/^\/?/, '/'), tags: Array.isArray(c.tags) ? c.tags.map(String) : [] }))
        .map(c => ({ ...c, icon: c.icon === '/' ? '' : c.icon }))
        .sort((a, b) => (parseFloat(a.number) || 1e9) - (parseFloat(b.number) || 1e9) || a.name.localeCompare(b.name)));
      this.tags.set(tags.filter((t: any) => t?.enabled === undefined || truthy(t.enabled))
        .map((t: any) => ({ uuid: String(t.uuid), name: String(t.name || '') })).sort((a, b) => a.name.localeCompare(b.name)));
    });
    this.load();
    // Keep the "now" line moving and recording states fresh.
    const tick = setInterval(() => {
      this.nowSec.set(now());
      if (Math.floor(Date.now() / 1000) % 120 < 30) this.load(true);
    }, 30000);
    this.destroyRef.onDestroy(() => { clearInterval(tick); if (this.searchTimer) clearTimeout(this.searchTimer); });
  }

  load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set('');
    this.tvh.getEpgWindow(this.winStart(), this.winEnd(), { channelTag: this.tag() || undefined }).subscribe({
      next: rows => {
        const evs = rows.map(toEvent);
        this.events.set(evs);
        const sel = this.selected();
        if (sel) this.selected.set(evs.find(x => x.eventId === sel.eventId) || sel);
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.error.set(Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.' : `Couldn’t load the guide (${err?.status || 'network error'}).`);
      },
    });
  }

  // ---------------------------------------------------------------- navigation

  shift(hours: number): void { this.winStart.update(s => s + hours * 3600); this.load(); }
  goNow(): void { this.winStart.set(floorTo(now(), HALF_HOUR)); this.nowSec.set(now()); this.load(); }
  goDay(i: number): void {
    const d = this.days()[i]; if (!d) return;
    // Today → now; other days → the same time of day as now (evening if it's late).
    const h = i === 0 ? null : Math.min(this.hourOfDay(), 20);
    this.winStart.set(h === null ? floorTo(now(), HALF_HOUR) : d.start + h * 3600);
    this.load();
  }
  goHour(h: number): void {
    const d = new Date(this.winStart() * 1000); d.setHours(h, 0, 0, 0);
    this.winStart.set(d.getTime() / 1000);
    this.load();
  }
  hourLabel(h: number): string {
    const d = new Date(); d.setHours(h, 0, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric' });
  }

  // ---------------------------------------------------------------- search

  onQuery(q: string): void {
    this.query.set(q);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const text = q.trim();
    if (text.length < 2) { this.results.set([]); return; }
    this.searching.set(true);
    this.searchTimer = setTimeout(() => {
      // Tvheadend matches titles as a regular expression; search for the text as typed.
      this.tvh.searchAutorecPreview(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), undefined, false, 200).subscribe(rows => {
        const n = now();
        this.results.set(rows.map(toEvent).filter(e => e.stop > n).sort((a, b) => a.start - b.start));
        this.searching.set(false);
      });
    }, 300);
  }

  // ---------------------------------------------------------------- details & actions

  select(e: GuideEvent): void { this.selected.set(e); this.autorecFor.set(null); }
  isAiring(e: GuideEvent): boolean { const n = this.nowSec(); return e.start <= n && e.stop > n; }
  rec(e: GuideEvent) { return recState(e.dvrState); }
  minutes(e: GuideEvent): number { return Math.round((e.stop - e.start) / 60); }
  /** Fetch the channel's ticketed playlist (needs our sign-in) and hand it to the browser as a file. */
  watchInVlc(e: GuideEvent): void {
    this.busy.set(true);
    this.tvh.fetchChannelPlaylist(e.channelUuid, e.channelName).subscribe({
      next: text => {
        this.busy.set(false);
        const url = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(e.channelName || 'channel').replace(/[^\w .-]+/g, '_')}.m3u`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      },
      error: err => {
        this.busy.set(false);
        this.snack.open(Number(err?.status) === 403 || Number(err?.status) === 401
          ? 'Your Tvheadend account isn’t allowed to stream (Users & access → streaming).'
          : `Couldn’t get the stream (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 });
      },
    });
  }

  record(e: GuideEvent): void {
    this.busy.set(true);
    this.tvh.scheduleRecordingByEvent(e.eventId).subscribe({
      next: () => { this.busy.set(false); this.snack.open(`“${e.title}” will be recorded`, undefined, { duration: 3000 }); this.refreshAfterChange(); },
      error: err => { this.busy.set(false); this.snack.open(`Couldn’t schedule it (${err?.status || err?.message || 'error'})`, 'Dismiss', { duration: 6000 }); },
    });
  }

  /** Programme whose auto-record rule is being set up in the side panel. */
  readonly autorecFor = signal<GuideEvent | null>(null);

  /** Prefill for the open form — computed once, so the form isn't rebuilt on every change check. */
  readonly autorecDefaults = signal<Record<string, unknown>>({});

  openAutorec(e: GuideEvent): void {
    this.autorecDefaults.set(this.defaultsFor(e));
    this.autorecFor.set(e);
  }

  /** A new rule prefilled from the programme: series link if the guide has one, else the exact title. */
  private defaultsFor(e: GuideEvent): Record<string, unknown> {
    const exact = `^${e.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    return {
      enabled: true,
      name: e.title,
      ...(e.serieslink ? { serieslink: e.serieslink } : { title: exact, fulltext: false }),
      channel: e.channelUuid,
      comment: 'Added from the Guide',
    };
  }

  onAutorecSaved(e: GuideEvent): void {
    this.autorecFor.set(null);
    this.snack.open(`Auto-record rule for “${e.title}” saved`, undefined, { duration: 4000 });
    this.refreshAfterChange();
  }

  cancel(e: GuideEvent): void {
    if (!e.dvrUuid) return;
    this.busy.set(true);
    this.tvh.cancelRecording(e.dvrUuid).subscribe({
      next: () => { this.busy.set(false); this.snack.open(`“${e.title}” won’t be recorded`, undefined, { duration: 3000 }); this.refreshAfterChange(); },
      error: err => { this.busy.set(false); this.snack.open(`Couldn’t cancel it (${err?.status || 'error'})`, 'Dismiss', { duration: 6000 }); },
    });
  }

  /** Tvheadend updates dvrState a moment after the change; reload shortly after. */
  private refreshAfterChange(): void {
    setTimeout(() => this.load(true), 700);
    if (this.query().trim().length >= 2) setTimeout(() => this.onQuery(this.query()), 700);
  }
}
