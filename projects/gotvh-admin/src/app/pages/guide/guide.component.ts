import { Component, DestroyRef, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
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
import { TvheadendService, isDeferredEnum, normalizeEnum, truthy } from '@gotvh/tvh-api';
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
/** An hour (or the part of one) with nothing in the guide: drawn with the channel's name, never saved anywhere. */
interface Filler { start: number; stop: number; left: number; width: number }
interface Row { ch: GuideChannel; cells: Cell[]; fill: Filler[] }

interface Opt { value: string; label: string }
// Earlier versions remembered choices in the browser, which made one-off choices stick; forget them.
try { ['start', 'stop', 'removal'].forEach(k => localStorage.removeItem(`gotvh_guide_rec_${k}`)); } catch { /* ignore */ }

const HALF_HOUR = 1800;
const now = () => Math.floor(Date.now() / 1000);
const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

/**
 * One-hour blocks (on the hour, trimmed around programmes) for the time in [s, e) that the guide leaves
 * empty, so every channel has something to click. Real listings take their place as soon as they exist.
 */
function fillGaps(evs: Array<{ start: number; stop: number }>, s: number, e: number): Filler[] {
  const out: Filler[] = [], win = e - s;
  const fill = (from: number, to: number) => {
    if (to - from < 120) return;
    for (let a = from; a < to;) {
      const b = Math.min(floorTo(a, 3600) + 3600, to);
      out.push({ start: a, stop: b, left: (a - s) / win * 100, width: Math.max(0.4, (b - a) / win * 100) });
      a = b;
    }
  };
  let t = s;
  for (const ev of evs) {
    if (ev.stop <= s || ev.start >= e) continue;
    if (ev.start > t) fill(t, ev.start);
    t = Math.max(t, ev.stop);
  }
  fill(t, e);
  return out;
}

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
import { GENRES, GenreKey, genreInfo, genreOf } from './guide-genre';

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
        <mat-slide-toggle [checked]="onlyWithGuide()" (change)="setOnlyWithGuide($event.checked)">Hide channels without guide</mat-slide-toggle>
        <span class="spacer"></span>
        <mat-form-field appearance="outline" class="f-search">
          <mat-icon matPrefix>search</mat-icon>
          <mat-label>Find a program</mat-label>
          <input matInput [ngModel]="query()" (ngModelChange)="onQuery($event)" (keydown.escape)="onQuery('')">
        </mat-form-field>
        <mat-slide-toggle [checked]="searchDescriptions()" (change)="setSearchDescriptions($event.checked)"
                          matTooltip="Also look in episode titles and descriptions (e.g. a team that's only named in the description)">Include descriptions</mat-slide-toggle>
      </div>

      <div class="legend" role="group" aria-label="Genres">
        <mat-slide-toggle [checked]="showGenres()" (change)="setShowGenres($event.checked)">Colour by genre</mat-slide-toggle>
        @if (showGenres()) {
          @for (g of legend(); track g.key) {
            <button type="button" class="chip-g" [class.on]="focusGenre() === g.key" [attr.aria-pressed]="focusGenre() === g.key"
                    (click)="focusGenre.set(focusGenre() === g.key ? null : g.key)"
                    [matTooltip]="focusGenre() === g.key ? 'Show all genres' : 'Highlight ' + g.label.toLowerCase()">
              <span class="swatch" [attr.data-genre]="g.key"></span>{{ g.label }} <span class="muted">{{ g.count }}</span>
            </button>
          }
          @if (unlabelled()) { <span class="muted small">{{ unlabelled() }} without a genre</span> }
        }
      </div>

      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }
      @if (error()) { <p class="err">{{ error() }}</p> }

      <div class="layout" adminSplit [class.with-editor]="!!selected() || !!channelOnly()">
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
                  @if (snippet(e); as sn) { <span class="r-snip">{{ sn }}</span> }
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
                  <div class="g-ch" role="rowheader" [title]="r.ch.name + ' — click to watch'" tabindex="0"
                       [class.sel]="channelOnly()?.uuid === r.ch.uuid"
                       (click)="selectChannel(r.ch)" (keydown.enter)="selectChannel(r.ch)">
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
                              [attr.data-genre]="showGenres() ? genreKey(c.ev) : null"
                              [class.dim]="!!focusGenre() && genreKey(c.ev) !== focusGenre()"
                              [attr.aria-label]="c.ev.title + ', ' + (c.ev.start * 1000 | date:'h:mm a')"
                              (click)="select(c.ev)">
                        <span class="p-title">@if (c.clippedStart) {‹ }{{ c.ev.title }}</span>
                        <span class="p-time">{{ c.ev.start * 1000 | date:'h:mm' }}–{{ c.ev.stop * 1000 | date:'h:mm a' }}@if (c.ev.subtitle) { · {{ c.ev.subtitle }} }</span>
                      </button>
                    }
                    @for (f of r.fill; track f.start) {
                      <button class="prog nodata" type="button" role="gridcell"
                              [style.left.%]="f.left" [style.width.%]="f.width" [class.past]="f.stop <= nowSec()"
                              [class.sel]="channelOnly()?.uuid === r.ch.uuid"
                              [attr.aria-label]="r.ch.name + ', no guide information'" (click)="selectChannel(r.ch)">
                        <span class="p-title">{{ r.ch.name }}</span>
                        <span class="p-time">{{ f.start * 1000 | date:'h:mm' }}–{{ f.stop * 1000 | date:'h:mm a' }} · No guide information</span>
                      </button>
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

        <!-- ===================== channel without a programme selected (e.g. no guide data) -->
        @if (channelOnly(); as ch) {
          <aside class="admin-side">
            <section class="card detail">
              <div class="d-head">
                <div>
                  <h2>{{ ch.number ? ch.number + ' · ' : '' }}{{ ch.name }}</h2>
                  <div class="muted">{{ !nextFor(ch.uuid) ? 'No guide data for this channel' : isAiring(nextFor(ch.uuid)!) ? 'On now' : 'Nothing on now in the guide' }}</div>
                </div>
                <button mat-icon-button (click)="channelOnly.set(null)" aria-label="Close"><mat-icon>close</mat-icon></button>
              </div>
              @if (nextFor(ch.uuid); as n) {
                <p class="muted small">{{ isAiring(n) ? 'Now' : 'Next' }}: {{ n.start * 1000 | date:'EEE h:mm a' }} — {{ n.title }}</p>
              } @else {
                <p class="muted small">The channel plays normally; it just has nothing in the guide. Map a guide to it, or give
                  it a dummy guide in your guide source, to see programmes here.</p>
              }
              <div class="actions">
                <button mat-stroked-button (click)="watchChannelInVlc(ch.uuid, ch.name)" [disabled]="busy()" matTooltip="Downloads a playlist (.m3u) — open it with VLC">
                  <mat-icon>open_in_new</mat-icon> Watch in VLC
                </button>
                <a mat-button routerLink="/epg"><mat-icon>search</mat-icon> Find a guide</a>
              </div>
            </section>
          </aside>
        }

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
              @if (genre(e); as g) {
                <p class="genre small"><span class="swatch" [attr.data-genre]="g.key"></span>{{ g.label }}@if (g.guessed) { <span class="muted"> (from the title)</span> }</p>
              }
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
              @if (!rec(e) && e.stop > nowSec()) {
                @if (recOptions()) {
                <div class="rec-opts">
                  <div class="opts-title small">Record with</div>
                  <div class="opts-grid">
                    <label>Start early
                      <select (change)="setOpt('start', $any($event.target).value)">
                        @for (o of recOptions()!.start; track o.value) { <option [value]="o.value" [selected]="o.value === startExtra()">{{ o.label }}</option> }
                      </select>
                    </label>
                    <label>Keep going after
                      <select (change)="setOpt('stop', $any($event.target).value)">
                        @for (o of recOptions()!.stop; track o.value) { <option [value]="o.value" [selected]="o.value === stopExtra()">{{ o.label }}</option> }
                      </select>
                    </label>
                    <label>Keep the recording
                      <select (change)="setOpt('removal', $any($event.target).value)">
                        @for (o of recOptions()!.removal; track o.value) { <option [value]="o.value" [selected]="o.value === removal()">{{ o.label }}</option> }
                      </select>
                    </label>
                  </div>
                  <p class="muted small">For this recording only. Profile defaults come from your DVR profile.</p>
                </div>
                } @else if (recOptionsError()) {
                  <p class="muted small">Padding and keep-for options aren’t available: {{ recOptionsError() }}</p>
                }
              }
              @if ((rec(e) === 'scheduled' || rec(e) === 'recording') && recOptions() && entryOpts(); as eo) {
                <div class="rec-opts">
                  <div class="opts-title small">{{ rec(e) === 'recording' ? 'This recording — change it while it runs' : 'This recording' }}</div>
                  <div class="opts-grid">
                    @if (rec(e) === 'scheduled') {
                      <label>Start early
                        <select (change)="saveEntryOpt('start_extra', $any($event.target).value)" [disabled]="busy()">
                          @for (o of withValue(recOptions()!.start, eo.start); track o.value) { <option [value]="o.value" [selected]="o.value === eo.start">{{ o.label }}</option> }
                        </select>
                      </label>
                    }
                    <label>Keep going after
                      <select (change)="saveEntryOpt('stop_extra', $any($event.target).value)" [disabled]="busy()">
                        @for (o of withValue(recOptions()!.stop, eo.stop); track o.value) { <option [value]="o.value" [selected]="o.value === eo.stop">{{ o.label }}</option> }
                      </select>
                    </label>
                    <label>Keep the recording
                      <select (change)="saveEntryOpt('removal', $any($event.target).value)" [disabled]="busy()">
                        @for (o of withValue(recOptions()!.removal, eo.removal); track o.value) { <option [value]="o.value" [selected]="o.value === eo.removal">{{ o.label }}</option> }
                      </select>
                    </label>
                  </div>
                  <p class="muted small">
                    @if (eo.autorec) {
                      These came from the auto-record rule
                      <a [routerLink]="'/autorec'" [queryParams]="{ open: eo.autorec }">{{ eo.autorecName || 'that made it' }}</a>
                      — change them there for future episodes.
                    }
                    Changes here apply to this recording only, and are saved straight away.
                  </p>
                </div>
              }
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
    .prog.nodata { border-style: dashed; background: transparent; }
    .prog.nodata .p-title { color: var(--mat-sys-on-surface-variant); }
    .g-ch { cursor: pointer; }
    .g-ch:hover, .g-ch.sel { background: var(--mat-sys-secondary-container); }
    .g-ch:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: -2px; }
    .prog[data-genre] { background: color-mix(in srgb, var(--g) 16%, var(--mat-sys-surface)); box-shadow: inset 0 3px 0 var(--g); }
    .prog.airing[data-genre] { background: color-mix(in srgb, var(--g) 28%, var(--mat-sys-surface)); }
    .prog.dim { opacity: .3; }
    .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 0 0 8px; }
    .legend mat-slide-toggle { margin-right: 8px; }
    .chip-g { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 14px; cursor: pointer;
      border: 1px solid var(--mat-sys-outline-variant); background: transparent; color: var(--mat-sys-on-surface); font: var(--mat-sys-label-medium); }
    .chip-g.on { border-color: var(--mat-sys-primary); background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    .swatch { width: 10px; height: 10px; border-radius: 3px; background: var(--g); flex: none; display: inline-block; }
    .genre { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
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
    .r-snip { grid-column: 3 / -1; font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant);
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
    .rec-opts { margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; background: var(--mat-sys-surface-container-low); }
    .opts-title { color: var(--mat-sys-on-surface-variant); }
    .opts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 8px 0 4px; }
    .opts-grid label { display: flex; flex-direction: column; gap: 3px; font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); }
    .opts-grid select { padding: 5px 6px; border-radius: 6px; border: 1px solid var(--mat-sys-outline); background: var(--mat-sys-surface);
                        color: var(--mat-sys-on-surface); font: var(--mat-sys-body-medium); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .small { font: var(--mat-sys-body-small); }
  
    /* Genre colours (guide-genre.ts; validated for colour-blind separation and contrast in both themes). */
    :host { --g-movie: #2a78d6; --g-news: #eb6834; --g-docs: #1baf7a; --g-kids: #eda100; --g-shows: #e87ba4; --g-sports: #008300; --g-lifestyle: #4a3aa7; }
    @media (prefers-color-scheme: dark) { :host { --g-movie: #3987e5; --g-news: #d95926; --g-docs: #199e70; --g-kids: #c98500; --g-shows: #d55181; --g-sports: #008300; --g-lifestyle: #9085e9; } }
    .prog[data-genre=movie], .swatch[data-genre=movie] { --g: var(--g-movie); }
    .prog[data-genre=news], .swatch[data-genre=news] { --g: var(--g-news); }
    .prog[data-genre=docs], .swatch[data-genre=docs] { --g: var(--g-docs); }
    .prog[data-genre=kids], .swatch[data-genre=kids] { --g: var(--g-kids); }
    .prog[data-genre=shows], .swatch[data-genre=shows] { --g: var(--g-shows); }
    .prog[data-genre=sports], .swatch[data-genre=sports] { --g: var(--g-sports); }
    .prog[data-genre=lifestyle], .swatch[data-genre=lifestyle] { --g: var(--g-lifestyle); }
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
  /** Remembered in this browser; off by default, since some channels never have guide data. */
  readonly onlyWithGuide = signal((() => { try { return localStorage.getItem('gotvh_admin_guide_only_with') === '1'; } catch { return false; } })());
  setOnlyWithGuide(on: boolean): void {
    this.onlyWithGuide.set(on);
    try { localStorage.setItem('gotvh_admin_guide_only_with', on ? '1' : '0'); } catch { /* ignore */ }
  }

  /** A channel opened without a programme (clicked its name, or a row with nothing listed). */
  readonly channelOnly = signal<GuideChannel | null>(null);
  selectChannel(ch: GuideChannel): void {
    this.selected.set(null);
    this.autorecFor.set(null);
    this.channelOnly.set(this.channelOnly()?.uuid === ch.uuid ? null : ch);
  }
  /** The next programme the loaded guide has for a channel, if any. */
  nextFor(uuid: string): GuideEvent | null {
    const now = this.nowSec();
    return this.events().filter(e => e.channelUuid === uuid && e.stop > now).sort((a, b) => a.start - b.start)[0] ?? null;
  }

  // ---- genre colours
  readonly showGenres = signal((() => { try { return localStorage.getItem('gotvh_admin_guide_genres') !== '0'; } catch { return true; } })());
  readonly focusGenre = signal<GenreKey | null>(null);
  private readonly genreCache = new Map<number, ReturnType<typeof genreOf>>();
  setShowGenres(on: boolean): void {
    this.showGenres.set(on);
    if (!on) this.focusGenre.set(null);
    try { localStorage.setItem('gotvh_admin_guide_genres', on ? '1' : '0'); } catch { /* ignore */ }
  }
  private genreFor(e: GuideEvent): ReturnType<typeof genreOf> {
    if (!this.genreCache.has(e.eventId)) this.genreCache.set(e.eventId, genreOf(e));
    return this.genreCache.get(e.eventId)!;
  }
  genreKey(e: GuideEvent): GenreKey | null { return this.genreFor(e)?.key ?? null; }
  genre(e: GuideEvent): { key: GenreKey; label: string; guessed: boolean } | null {
    const g = this.genreFor(e);
    return g ? { key: g.key, label: genreInfo(g.key).label, guessed: g.guessed } : null;
  }
  /** Genres in view, in palette order, with counts. */
  readonly legend = computed(() => {
    const counts = new Map<GenreKey, number>();
    for (const r of this.rows()) for (const c of r.cells) {
      const k = this.genreKey(c.ev);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return GENRES.filter(g => counts.has(g.key)).map(g => ({ key: g.key, label: g.label, count: counts.get(g.key)! }));
  });
  readonly unlabelled = computed(() => this.rows().reduce((n, r) => n + r.cells.filter(c => !this.genreKey(c.ev)).length, 0));
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
      .map(ch => {
        const evs = (byCh.get(ch.uuid) || []).sort((a, b) => a.start - b.start);
        return {
          ch,
          cells: evs.map(ev => {
            const a = Math.max(ev.start, s), b = Math.min(ev.stop, e);
            return { ev, left: (a - s) / win * 100, width: Math.max(0.4, (b - a) / win * 100), clippedStart: ev.start < s, clippedEnd: ev.stop > e };
          }),
          fill: fillGaps(evs, s, e),
        };
      })
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
    this.loadRecOptions();
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

  /** Search descriptions too (Tvheadend's fulltext): on by default, remembered. */
  readonly searchDescriptions = signal((() => { try { return localStorage.getItem('gotvh_admin_guide_search_desc') !== '0'; } catch { return true; } })());
  setSearchDescriptions(on: boolean): void {
    this.searchDescriptions.set(on);
    try { localStorage.setItem('gotvh_admin_guide_search_desc', on ? '1' : '0'); } catch { /* ignore */ }
    this.onQuery(this.query());
  }

  /** When the match isn't in the title: the bit of the subtitle/description that matched. */
  snippet(e: GuideEvent): string | null {
    const q = this.query().trim().toLowerCase();
    if (!q || !this.searchDescriptions() || e.title.toLowerCase().includes(q)) return null;
    for (const text of [e.subtitle, e.description, e.summary]) {
      const t = String(text || '');
      const i = t.toLowerCase().indexOf(q);
      if (i < 0) continue;
      const from = Math.max(0, i - 50), to = Math.min(t.length, i + q.length + 70);
      return (from > 0 ? '…' : '') + t.slice(from, to).replace(/\s+/g, ' ') + (to < t.length ? '…' : '');
    }
    return null;
  }

  onQuery(q: string): void {
    this.query.set(q);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const text = q.trim();
    if (text.length < 2) { this.results.set([]); return; }
    this.searching.set(true);
    this.searchTimer = setTimeout(() => {
      // Tvheadend matches titles as a regular expression; search for the text as typed.
      // With descriptions on, Tvheadend's fulltext also searches subtitles and descriptions;
      // title matches still come first.
      const full = this.searchDescriptions();
      this.tvh.searchAutorecPreview(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), undefined, full, full ? 400 : 200).subscribe(rows => {
        const n = now(), lower = text.toLowerCase();
        const inTitle = (e: GuideEvent) => e.title.toLowerCase().includes(lower) ? 0 : 1;
        this.results.set(rows.map(toEvent).filter(e => e.stop > n).sort((a, b) => inTitle(a) - inTitle(b) || a.start - b.start));
        this.searching.set(false);
      });
    }, 300);
  }

  // ---------------------------------------------------------------- details & actions

  select(e: GuideEvent): void {
    this.channelOnly.set(null);
    // Clicking the open programme again closes the panel, and the guide takes the full width back.
    if (this.selected()?.eventId === e.eventId) { this.selected.set(null); this.autorecFor.set(null); return; }
    // Each programme starts from the DVR profile's settings; choices are for that one recording.
    if (this.selected()?.eventId !== e.eventId) { this.startExtra.set('0'); this.stopExtra.set('0'); this.removal.set('0'); }
    this.selected.set(e); this.autorecFor.set(null);
  }
  isAiring(e: GuideEvent): boolean { const n = this.nowSec(); return e.start <= n && e.stop > n; }
  rec(e: GuideEvent) { return recState(e.dvrState); }
  minutes(e: GuideEvent): number { return Math.round((e.stop - e.start) / 60); }
  /** Fetch the channel's ticketed playlist (needs our sign-in) and hand it to the browser as a file. */
  watchInVlc(e: GuideEvent): void {
    this.watchChannelInVlc(e.channelUuid, e.channelName);
  }

  watchChannelInVlc(channelUuid: string, channelName: string): void {
    const e = { channelUuid, channelName };
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

  // ---- one-off recording options (padding and how long to keep it)

  /** Choices from Tvheadend's own DVR entry class, so the values are exactly what it accepts. */
  readonly recOptions = signal<{ start: Opt[]; stop: Opt[]; removal: Opt[] } | null>(null);
  readonly startExtra = signal('0');
  readonly stopExtra = signal('0');
  readonly removal = signal('0');
  readonly optionsChanged = computed(() => !!(Number(this.startExtra()) || Number(this.stopExtra()) || Number(this.removal())));
  readonly optionsSummary = computed(() => {
    const o = this.recOptions(); if (!o) return '';
    const label = (list: Opt[], v: string) => list.find(x => x.value === v)?.label || v;
    return [
      Number(this.startExtra()) ? `start ${label(o.start, this.startExtra())} early` : '',
      Number(this.stopExtra()) ? `end ${label(o.stop, this.stopExtra())} late` : '',
      Number(this.removal()) ? `keep ${label(o.removal, this.removal()).toLowerCase()}` : '',
    ].filter(Boolean).join(', ');
  });

  readonly recOptionsError = signal('');

  /** Padding / keep-for of the selected programme's scheduled or running recording. */
  readonly entryOpts = signal<{ uuid: string; start: string; stop: string; removal: string; autorec: string; autorecName: string } | null>(null);
  private readonly loadEntryOpts = effect(() => {
    const e = this.selected(), uuid = e?.dvrUuid || '';
    if (!uuid) { this.entryOpts.set(null); return; }
    if (this.entryOpts()?.uuid === uuid) return;
    this.tvh.idnodeValues([uuid], ['start_extra', 'stop_extra', 'removal', 'autorec', 'autorec_caption']).pipe(catchError(() => of([]))).subscribe(([v]) => {
      if (this.selected()?.dvrUuid !== uuid || !v) return;
      this.entryOpts.set({ uuid, start: String(v.start_extra ?? 0), stop: String(v.stop_extra ?? 0), removal: String(v.removal ?? 0),
        autorec: String(v.autorec || ''), autorecName: String(v.autorec_caption || '') });
    });
  }, { allowSignalWrites: true });

  /** The option list, plus the saved value if it isn't one of the trimmed steps. */
  withValue(list: Opt[], v: string): Opt[] {
    return list.some(o => o.value === v) ? list : [...list, { value: v, label: `${v} min` }];
  }

  saveEntryOpt(field: 'start_extra' | 'stop_extra' | 'removal', value: string): void {
    const eo = this.entryOpts(); if (!eo) return;
    this.busy.set(true);
    this.tvh.idnodeSave(eo.uuid, { [field]: Number(value) }).subscribe({
      next: () => {
        this.busy.set(false);
        const key = field === 'start_extra' ? 'start' : field === 'stop_extra' ? 'stop' : 'removal';
        this.entryOpts.set({ ...eo, [key]: value });
        this.snack.open('Recording updated', undefined, { duration: 2500 });
      },
      error: err => { this.busy.set(false); this.snack.open(`Couldn’t change it (${err?.status || 'error'})`, 'Dismiss', { duration: 6000 }); },
    });
  }

  private loadRecOptions(): void {
    this.tvh.idnodeClass('dvr/entry').pipe(catchError(err => { this.recOptionsError.set(`Tvheadend said ${err?.status || err?.message || 'no'}`); return of(null); })).subscribe(cls => {
      if (!cls) return;
      const pick = (id: string) => {
        const p = cls.params.find(x => x.id === id);
        return p?.enum && !isDeferredEnum(p.enum) ? normalizeEnum(p.enum as any).map(o => ({ value: String(o.value), label: String(o.label) })) : [];
      };
      // Tvheadend lists every minute up to 2 hours; keep the useful steps (and whatever is saved).
      const STEPS = new Set(['0', '1', '2', '3', '5', '10', '15', '20', '30', '45', '60', '90', '120', '150', '180', '240']);
      const trim = (l: Opt[], keep: string) => l.filter(o => STEPS.has(o.value) || o.value === keep);
      const start = trim(pick('start_extra'), this.startExtra()), stop = trim(pick('stop_extra'), this.stopExtra()), removal = pick('removal');
      // Say what "not set" means: the default DVR profile's values.
      this.tvh.getGrid('dvr/config/grid').pipe(catchError(() => of([]))).subscribe(cfgs => {
        const def: any = cfgs.find((c: any) => !String(c?.name || '').trim()) || cfgs[0];
        if (!def) return;
        const mins = (v: unknown) => { const n = Number(v) || 0; return n ? `${n} min` : 'none'; };
        const days = removal.find(o => o.value === String(def['removal-days']))?.label
          || (Number(def['removal-days']) ? `${def['removal-days']} days` : 'forever');
        const relabel = (l: Opt[], text: string) => l.map(o => o.value === '0' ? { ...o, label: `Profile default (${text})` } : o);
        this.recOptions.set({ start: relabel(start, mins(def['pre-extra-time'])), stop: relabel(stop, mins(def['post-extra-time'])),
          removal: relabel(removal, String(days).toLowerCase()) });
      });
      if (start.length || stop.length || removal.length) this.recOptions.set({ start, stop, removal });
      else this.recOptionsError.set('the DVR entry settings came without choices');
    });
  }

  setOpt(which: 'start' | 'stop' | 'removal', value: string): void {
    ({ start: this.startExtra, stop: this.stopExtra, removal: this.removal })[which].set(value);
  }

  record(e: GuideEvent): void {
    this.busy.set(true);
    const conf: Record<string, number> = {};
    if (Number(this.startExtra())) conf['start_extra'] = Number(this.startExtra());
    if (Number(this.stopExtra())) conf['stop_extra'] = Number(this.stopExtra());
    if (Number(this.removal())) conf['removal'] = Number(this.removal());
    this.tvh.scheduleRecordingByEvent(e.eventId).pipe(
      // Apply the chosen padding / keep-for to the new entry.
      switchMap(r => r.dvrUuid && Object.keys(conf).length ? this.tvh.idnodeSave(r.dvrUuid, conf).pipe(map(() => r)) : of(r)),
    ).subscribe({
      next: () => {
        this.busy.set(false);
        const extra = this.optionsChanged() ? ` (${this.optionsSummary()})` : '';
        this.snack.open(`“${e.title}” will be recorded${extra}`, undefined, { duration: 4000 });
        this.refreshAfterChange();
      },
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
