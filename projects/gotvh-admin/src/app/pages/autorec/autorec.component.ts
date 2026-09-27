import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap, tap } from 'rxjs/operators';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  AUTOREC_WEEKDAYS, AutorecMatchMode, TvheadendService, buildRuleTitlePattern, composeCommentWithEpisodeMatch,
  describeWeekdays, extractCommentMetadata, formatOptionalInteger, formatStartMinutesAsTime, normalizeWeekdays,
  parseOptionalNonNegativeInteger, parseStoredTitlePattern, parseTimeToMinutes,
} from '@gotvh/tvh-api';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { BulkBarComponent } from '../../shared/bulk-bar.component';
import { describeBulk, runBulk } from '../../shared/bulk';
import { RowSelection } from '../../shared/row-selection';
import { overlayIsOpen } from '../../shared/idnode-form/idnode-form.component';
import { SplitHandleDirective } from '../../shared/split-handle.directive';

interface RuleRow {
  raw: any;
  uuid: string;
  enabled: boolean;
  label: string;
  pattern: string;
  customRegex: boolean;
  fulltext: boolean;
  episodeMatch: string;
  channelUuid: string;
  channelName: string;
  when: string;
  days: string;
  padding: string;
  profile: string;
  comment: string;
}

interface Option { value: string; label: string; }

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

@Component({
  selector: 'admin-autorec',
  standalone: true,
  imports: [SplitHandleDirective, 
    ReactiveFormsModule, MatTableModule, MatSortModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatAutocompleteModule, MatSlideToggleModule, MatIconModule,
    MatTooltipModule, MatProgressBarModule, MatDialogModule, MatSnackBarModule, BulkBarComponent,
  ],
  templateUrl: './autorec.component.html',
  styleUrl: './autorec.component.scss',
})
export class AutorecComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly fb = inject(FormBuilder);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly weekdays = AUTOREC_WEEKDAYS;

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly busyUuid = signal('');
  readonly error = signal('');
  readonly rows = signal<RuleRow[]>([]);
  readonly filter = signal('');
  readonly sort = signal<Sort>({ active: 'label', direction: 'asc' });
  readonly channels = signal<Option[]>([]);
  readonly profiles = signal<Option[]>([]);

  /** null = editor closed, '' = creating, uuid = editing. */
  readonly editing = signal<string | null>(null);
  readonly preview = signal<{ loading: boolean; total: number; items: any[] }>({ loading: false, total: 0, items: [] });

  readonly visibleRows = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const { active, direction } = this.sort();
    const rows = this.rows().filter(r => !q ||
      [r.label, r.pattern, r.channelName, r.profile, r.comment, r.episodeMatch].some(v => v.toLowerCase().includes(q)));
    if (!direction) return rows;
    const key = (r: RuleRow): string | number => {
      switch (active) {
        case 'enabled': return r.enabled ? 0 : 1;
        case 'channel': return r.channelName.toLowerCase() || '￿';
        case 'when': return Number(r.raw?.start) || 0;
        case 'profile': return r.profile.toLowerCase();
        default: return r.label.toLowerCase();
      }
    };
    const dir = direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
  });

  /** Narrower table while the editor panel is open. */
  readonly columns = computed(() => this.editing() === null
    ? ['select', 'enabled', 'label', 'channel', 'when', 'padding', 'profile', 'actions']
    : ['select', 'enabled', 'label', 'channel', 'when', 'actions']);

  readonly selection = new RowSelection<RuleRow>(r => r.uuid);
  readonly bulkBusy = signal(false);

  readonly enabledCount = computed(() => this.rows().filter(r => r.enabled).length);

  readonly form = this.fb.nonNullable.group({
    name: '',
    title: '',
    matchMode: 'title' as AutorecMatchMode,
    startsWith: false,
    endsWith: false,
    customRegex: false,
    rawPattern: '',
    episodeMatch: '',
    channelText: '',
    channel: '',
    startTime: '',
    startWindow: '',
    weekdays: this.fb.nonNullable.control<number[]>([...ALL_DAYS]),
    startExtra: '',
    stopExtra: '',
    config: '',
    comment: '',
    enabled: true,
  });

  readonly channelMatches = signal<Option[]>([]);

  constructor() {
    const f = this.form.controls;

    // Channel autocomplete: typing filters, picking an option stores its uuid.
    f.channelText.valueChanges.pipe(takeUntilDestroyed()).subscribe(text => {
      const q = String(text || '').trim().toLowerCase();
      const exact = this.channels().find(c => c.label.toLowerCase() === q);
      if (exact) f.channel.setValue(exact.value);
      else if (!q || this.channels().length) f.channel.setValue(''); // typed text that isn't a channel
      this.channelMatches.set(this.channels().filter(c => !q || c.label.toLowerCase().includes(q)).slice(0, 50));
    });

    // Live preview of upcoming guide entries the rule would match.
    this.form.valueChanges.pipe(
      map(() => this.previewQuery()),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      tap(q => this.preview.set({ loading: !!q, total: 0, items: [] })),
      debounceTime(400),
      switchMap(q => q
        ? this.tvh.searchAutorecPreview(q.title, q.channel, q.fulltext, 200).pipe(catchError(() => of([])))
        : of(null)),
      takeUntilDestroyed(),
    ).subscribe(entries => {
      if (!entries) { this.preview.set({ loading: false, total: 0, items: [] }); return; }
      const rule = this.previewRegex();
      const upcoming = entries
        .filter(e => !rule || rule.test(this.form.controls.matchMode.value === 'fulltext'
          ? [e.title, e.subtitle, e.summary, e.description, e.desc].filter(Boolean).join(' ')
          : String(e.title || '')))
        .filter(e => this.matchesEpisodeFilter(e))
        .sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
      this.preview.set({ loading: false, total: upcoming.length, items: upcoming.slice(0, 8) });
    });
  }

  ngOnInit(): void {
    this.load();
  }

  // ---------------------------------------------------------------- data

  load(): void {
    this.loading.set(true);
    this.error.set('');
    forkJoin({
      rules: this.tvh.getAutorecs(),
      channels: this.tvh.getChannels().pipe(catchError(() => of([]))),
      configs: this.tvh.getDvrConfigs(),
    }).subscribe({
      next: ({ rules, channels, configs }) => {
        const channelOptions: Option[] = channels
          .map((c: any) => ({ value: String(c?.uuid || '').trim(), label: String(c?.name || '').trim() }))
          .filter(c => c.value && c.label)
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        const profileOptions: Option[] = configs
          .map((c: any) => ({ value: String(c?.uuid || '').trim(), label: String(c?.name || '').trim() || 'Default profile' }))
          .filter(c => c.value)
          .sort((a, b) => a.label.localeCompare(b.label));
        this.channels.set(channelOptions);
        this.channelMatches.set(channelOptions.slice(0, 50));
        this.profiles.set(profileOptions);
        this.rows.set(rules.map(r => this.toRow(r, channelOptions, profileOptions)));
        this.loading.set(false);
      },
      error: err => {
        this.error.set(this.describeError(err));
        this.loading.set(false);
      },
    });
  }

  private toRow(rule: any, channels: Option[], profiles: Option[]): RuleRow {
    const parsed = parseStoredTitlePattern(String(rule?.title || '').trim());
    const meta = extractCommentMetadata(String(rule?.comment || ''));
    const channelUuid = String(rule?.channel || '').trim();
    const configUuid = String(rule?.config_name || rule?.config || '').trim();
    const start = formatStartMinutesAsTime(rule?.start);
    const window = formatOptionalInteger(rule?.start_window);
    const pre = formatOptionalInteger(rule?.start_extra);
    const post = formatOptionalInteger(rule?.stop_extra);
    return {
      raw: rule,
      uuid: String(rule?.uuid || '').trim(),
      enabled: !!Number(rule?.enabled ?? 1),
      label: String(rule?.name || '').trim() || (parsed.customRegex ? parsed.rawPattern : parsed.title) || 'Untitled rule',
      pattern: parsed.rawPattern,
      customRegex: parsed.customRegex,
      fulltext: !!Number(rule?.fulltext || 0),
      episodeMatch: meta.episodeMatch,
      channelUuid,
      channelName: String(rule?.channelname || channels.find(c => c.value === channelUuid)?.label || channelUuid || '').trim(),
      when: start ? `${start}${window ? ` ±${window}m` : ''}` : 'Any time',
      days: describeWeekdays(rule?.weekdays),
      padding: pre || post ? `−${pre || 0} / +${post || 0} min` : '',
      profile: profiles.find(p => p.value === configUuid)?.label || (configUuid ? configUuid : ''),
      comment: meta.comment,
    };
  }

  // ---------------------------------------------------------------- table

  onSort(sort: Sort): void {
    this.sort.set(sort);
  }

  toggleEnabled(row: RuleRow): void {
    this.busyUuid.set(row.uuid);
    this.tvh.saveAutorec(row.uuid, { enabled: row.enabled ? 0 : 1 }).subscribe({
      next: () => {
        this.rows.update(rows => rows.map(r => r.uuid === row.uuid ? { ...r, enabled: !row.enabled } : r));
        this.busyUuid.set('');
      },
      error: err => {
        this.busyUuid.set('');
        this.snack.open(this.describeError(err), 'Dismiss', { duration: 6000 });
      },
    });
  }

  confirmDelete(row: RuleRow, event?: Event): void {
    event?.stopPropagation();
    const data: ConfirmDialogData = {
      title: 'Delete rule?',
      message: `“${row.label}” will stop scheduling new recordings. Recordings it already scheduled are not affected.`,
      confirm: 'Delete',
      destructive: true,
    };
    this.dialog.open(ConfirmDialogComponent, { data, autoFocus: 'dialog' }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.busyUuid.set(row.uuid);
      this.tvh.deleteAutorec(row.uuid).subscribe({
        next: () => {
          this.busyUuid.set('');
          if (this.editing() === row.uuid) this.closeEditor();
          this.rows.update(rows => rows.filter(r => r.uuid !== row.uuid));
          this.snack.open(`Deleted “${row.label}”`, undefined, { duration: 3000 });
        },
        error: err => {
          this.busyUuid.set('');
          this.snack.open(this.describeError(err), 'Dismiss', { duration: 6000 });
        },
      });
    });
  }

  // ---------------------------------------------------------------- selection & bulk

  /** Plain click selects and opens the rule; Ctrl/⌘-click and Shift-click only change the selection. */
  onRowClick(event: MouseEvent, row: RuleRow): void {
    if (this.selection.handleClick(event, row, this.visibleRows())) return;
    this.selection.selectOnly(row); // also the start point for a Shift-click range
    this.openEdit(row);
  }

  hiddenHint(): string {
    const shown = this.visibleRows().filter(r => this.selection.isSelected(r)).length;
    const hidden = this.selection.count() - shown;
    return hidden > 0 ? `${hidden} hidden by the filter` : '';
  }

  bulkSetEnabled(enabled: boolean): void {
    const rows = this.selection.rows();
    this.bulkBusy.set(true);
    runBulk(rows, r => this.tvh.saveAutorec(r.uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      this.bulkBusy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, 'rule'), undefined, { duration: 4000 });
      if (!result.failed) this.selection.clear();
      this.load();
    });
  }

  bulkDelete(): void {
    const rows = this.selection.rows();
    const names = rows.slice(0, 3).map(r => `“${r.label}”`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');
    const data: ConfirmDialogData = {
      title: `Delete ${rows.length} ${rows.length === 1 ? 'rule' : 'rules'}?`,
      message: `${names} will stop scheduling new recordings. Recordings they already scheduled are not affected.`,
      confirm: 'Delete',
      destructive: true,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.bulkBusy.set(true);
      runBulk(rows, r => this.tvh.deleteAutorec(r.uuid)).subscribe(result => {
        this.bulkBusy.set(false);
        this.snack.open(describeBulk('Deleted', result, 'rule'), undefined, { duration: 4000 });
        if (rows.some(r => r.uuid === this.editing())) this.closeEditor();
        this.selection.clear();
        this.load();
      });
    });
  }

  // ---------------------------------------------------------------- editor

  openNew(): void {
    this.error.set('');
    this.editing.set('');
    this.form.reset({ weekdays: [...ALL_DAYS], matchMode: 'title', enabled: true });
  }

  openEdit(row: RuleRow): void {
    const rule = row.raw;
    const parsed = parseStoredTitlePattern(String(rule?.title || '').trim());
    const days = normalizeWeekdays(rule?.weekdays);
    this.error.set('');
    this.editing.set(row.uuid);
    this.form.reset({
      name: String(rule?.name || '').trim(),
      title: parsed.customRegex ? '' : parsed.title,
      matchMode: row.fulltext ? 'fulltext' : 'title',
      startsWith: parsed.startsWith,
      endsWith: parsed.endsWith,
      customRegex: parsed.customRegex,
      rawPattern: parsed.rawPattern,
      episodeMatch: row.episodeMatch,
      channelText: row.channelUuid ? row.channelName : '',
      channel: row.channelUuid,
      startTime: formatStartMinutesAsTime(rule?.start),
      startWindow: formatOptionalInteger(rule?.start_window),
      weekdays: days.length ? days : [...ALL_DAYS],
      startExtra: formatOptionalInteger(rule?.start_extra),
      stopExtra: formatOptionalInteger(rule?.stop_extra),
      config: this.profiles().some(p => p.value === String(rule?.config_name || '').trim()) ? String(rule?.config_name).trim() : '',
      comment: row.comment,
      enabled: row.enabled,
    });
  }

  /** Esc closes the editor — unless it was meant for an open dropdown or dialog. */
  onEscape(event: Event): void {
    if (event.defaultPrevented || overlayIsOpen()) return;
    this.closeEditor();
  }

  closeEditor(): void {
    this.editing.set(null);
  }

  editingLabel(): string {
    const uuid = this.editing();
    return uuid ? this.rows().find(r => r.uuid === uuid)?.label || 'Edit rule' : 'New rule';
  }

  rowFor(uuid: string): RuleRow | undefined {
    return this.rows().find(r => r.uuid === uuid);
  }

  clearChannel(): void {
    this.form.patchValue({ channel: '', channelText: '' });
  }

  save(): void {
    const v = this.form.getRawValue();
    const title = v.customRegex
      ? v.rawPattern.trim()
      : buildRuleTitlePattern(v.title, v.matchMode, v.startsWith, v.endsWith);
    if (!title) { this.error.set('Enter a title to match.'); return; }

    if (v.channelText.trim() && !v.channel) {
      this.error.set('Pick a channel from the list, or clear the field for any channel.');
      return;
    }
    const start = parseTimeToMinutes(v.startTime);
    const numbers = {
      start_window: parseOptionalNonNegativeInteger(v.startWindow),
      start_extra: parseOptionalNonNegativeInteger(v.startExtra),
      stop_extra: parseOptionalNonNegativeInteger(v.stopExtra),
    };
    if (Number.isNaN(start as number)) { this.error.set('Start time must be HH:MM.'); return; }
    if (Object.values(numbers).some(n => Number.isNaN(n as number))) {
      this.error.set('Window and padding must be whole minutes.');
      return;
    }
    const weekdays = normalizeWeekdays(v.weekdays);
    if (!weekdays.length) { this.error.set('Pick at least one day.'); return; }

    const conf: any = {
      enabled: v.enabled ? 1 : 0,
      title,
      name: v.name.trim() || (v.customRegex ? '' : v.title.trim()),
      fulltext: v.matchMode === 'fulltext' ? 1 : 0,
      mergetext: v.matchMode === 'fulltext' ? 1 : 0,
      comment: composeCommentWithEpisodeMatch(v.comment, v.episodeMatch),
      channel: v.channel,
      config_name: v.config,
      start: start ?? 0,
      start_window: numbers.start_window ?? 0,
      start_extra: numbers.start_extra ?? 0,
      stop_extra: numbers.stop_extra ?? 0,
      weekdays,
    };

    const uuid = this.editing();
    this.error.set('');
    this.saving.set(true);
    const request = uuid ? this.tvh.saveAutorec(uuid, conf) : this.tvh.createAutorec(conf);
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.snack.open(uuid ? 'Rule saved' : 'Rule created', undefined, { duration: 3000 });
        this.closeEditor();
        this.load();
      },
      error: err => {
        this.saving.set(false);
        this.error.set(this.describeError(err));
      },
    });
  }

  // ---------------------------------------------------------------- preview

  private previewQuery(): { title: string; channel: string; fulltext: boolean } | null {
    if (this.editing() === null) return null;
    const v = this.form.getRawValue();
    const title = (v.customRegex ? v.rawPattern : v.title).trim();
    if (title.length < 2) return null;
    return { title, channel: v.channel, fulltext: v.matchMode === 'fulltext' };
  }

  /**
   * The guide search is a loose title search, so re-check each result against
   * the exact pattern the rule will save (anchors, custom regex).
   */
  private previewRegex(): RegExp | null {
    const v = this.form.getRawValue();
    const pattern = v.customRegex ? v.rawPattern.trim() : buildRuleTitlePattern(v.title, v.matchMode, v.startsWith, v.endsWith);
    try {
      return pattern ? new RegExp(pattern, 'i') : null;
    } catch {
      return null; // half-typed regex: fall back to the server's results
    }
  }

  private matchesEpisodeFilter(entry: any): boolean {
    const tokens = this.form.controls.episodeMatch.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const code = String(this.tvh.getEpgEpisodeCode(entry) || '');
    const text = [code, code.replace(/\bS0+(\d+)/gi, 'S$1').replace(/\bE0+(\d+)/gi, 'E$1'),
      entry?.subtitle, entry?.desc, entry?.title].join(' ').toLowerCase();
    return tokens.every(t => text.includes(t) || text.includes(t.replace(/^s0+(\d+)/, 's$1').replace(/^e0+(\d+)/, 'e$1')));
  }

  formatEpoch(seconds: number | undefined): string {
    if (!seconds) return '';
    return new Date(seconds * 1000).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  // ---------------------------------------------------------------- misc

  private describeError(error: any): string {
    switch (Number(error?.status || 0)) {
      case 401: return 'Sign in required — use Sign in at the top right.';
      case 403: return 'This Tvheadend account doesn’t have DVR access.';
      case 0: return 'Tvheadend is unreachable. Check the server and proxy.';
      default: return `Tvheadend returned an error (${error?.status || 'unknown'}).`;
    }
  }
}
