import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IdnodeEntry, TvheadendService, normalizeEnum, truthy } from '@gotvh/tvh-api';
import { describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';

/** Plain-English names for Tvheadend's stream profile types, in the order offered. */
export const PROFILE_TYPES: Record<string, { label: string; detail: string; order: number }> = {
  'profile-mpegts': { order: 1, label: 'Pass-through (MPEG-TS)',
    detail: 'Sends the broadcast unchanged. Best quality, almost no CPU — the usual choice.' },
  'profile-htsp': { order: 2, label: 'HTSP',
    detail: 'Tvheadend’s own protocol, used by Kodi and other HTSP clients.' },
  'profile-matroska': { order: 3, label: 'Matroska (MKV)',
    detail: 'Repackaged as MKV without re-encoding. Plays in more desktop players.' },
  'profile-transcode': { order: 4, label: 'Transcode',
    detail: 'Re-encodes video and audio with codec profiles — smaller streams for phones or slow links. Uses CPU/GPU.' },
  'profile-audio': { order: 5, label: 'Audio only',
    detail: 'Just one audio track, for radio or listening.' },
  'profile-libav-mpegts': { order: 6, label: 'MPEG-TS (libav)',
    detail: 'Repackaged by libav without re-encoding.' },
  'profile-libav-matroska': { order: 7, label: 'Matroska (libav)',
    detail: 'Repackaged as MKV/WebM by libav without re-encoding.' },
  'profile-libav-mp4': { order: 8, label: 'MP4 (libav)',
    detail: 'Repackaged as MP4 by libav without re-encoding.' },
  'profile-mpegts-spawn': { order: 9, label: 'External command',
    detail: 'Pipes the stream through a command you supply (e.g. ffmpeg).' },
};

const typeLabel = (cls: string, fallback = '') => PROFILE_TYPES[cls]?.label || fallback || cls;

interface StreamProfileRow {
  uuid: string;
  name: string;
  cls: string;
  type: string;
  enabled: boolean;
  isDefault: boolean;
  /** Shipped with Tvheadend: can be edited but not renamed or deleted. */
  builtin: boolean;
  comment: string;
  codecs: string;
  dvrNames: string[];
  userNames: string[];
  usedBy: string;
  values: Record<string, any>;
}

interface CodecProfileRow {
  uuid: string;
  name: string;
  codec: string;
  type: string;
  status: string;
  available: boolean;
  description: string;
  usedBy: string[];
  usedByText: string;
}

interface Builder { class: string; caption: string; label: string; detail: string; order: number }
interface Codec { name: string; title: string; class: string; caption: string }

type StreamEditor = { uuid: string | null; createClass?: string; label?: string } | null;
type CodecEditor = { uuid: string | null; codec?: Codec } | null;

/** Flatten an idnode entry's params to { id: value } plus the ids that are read-only for this object. */
function flatten(e: IdnodeEntry): { values: Record<string, any>; rdonly: Set<string>; enums: Record<string, any> } {
  const values: Record<string, any> = {}, enums: Record<string, any> = {};
  const rdonly = new Set<string>();
  for (const p of e.params || []) {
    values[p.id] = p.value;
    if (truthy(p.rdonly)) rdonly.add(p.id);
    if (p.enum) enums[p.id] = p.enum;
  }
  return { values, rdonly, enums };
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Stream profiles (how a stream is packaged or transcoded for a client or a
 * recording) and, when Tvheadend has transcoding built in, the codec profiles
 * that transcoding profiles use. Tvheadend has no grid for these, so each
 * list is loaded by class and filtered in the browser.
 */
@Component({
  selector: 'admin-stream-profiles',
  standalone: true,
  imports: [
    RouterLink, MatTabsModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, MatProgressBarModule,
    MatDialogModule, MatSnackBarModule, IdnodeGridComponent, IdnodeFormComponent,
  ],
  templateUrl: './stream-profiles.component.html',
  styleUrl: './stream-profiles.component.scss',
})
export class StreamProfilesComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild('profileGrid') profileGrid?: IdnodeGridComponent;
  @ViewChild('profileForm') profileForm?: IdnodeFormComponent;
  @ViewChild('codecGrid') codecGrid?: IdnodeGridComponent;
  @ViewChild('codecForm') codecForm?: IdnodeFormComponent;

  readonly tabIndex = signal(0);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);

  private readonly entries = signal<IdnodeEntry[]>([]);
  private readonly dvrConfigs = signal<any[]>([]);
  private readonly accessEntries = signal<any[]>([]);
  readonly builders = signal<Builder[]>([]);

  // ---- codec profiles (only when transcoding is built in)
  /** null = not known yet; false = this Tvheadend has no transcoding support. */
  readonly transcoding = signal<boolean | null>(null);
  readonly codecs = signal<Codec[]>([]);
  private readonly codecList = signal<Array<{ uuid: string; title: string; status: string }>>([]);
  private readonly codecEntries = signal<IdnodeEntry[]>([]);
  readonly codecLoading = signal(false);

  readonly editor = signal<StreamEditor>(null);
  readonly codecEditor = signal<CodecEditor>(null);

  readonly rows = computed<StreamProfileRow[]>(() => {
    const builderCaption = new Map(this.builders().map(b => [b.class, b.caption]));
    const dvr = this.dvrConfigs(), access = this.accessEntries();
    return this.entries().map(e => {
      const { values, rdonly } = flatten(e);
      const uuid = String(e.uuid || e.id || '');
      const cls = String(values['class'] || e.class || '');
      const dvrNames = dvr.filter(d => String(d?.profile || '') === uuid)
        .map(d => String(d?.name || '').trim() || 'Default DVR profile');
      const userNames = access.filter(a => (Array.isArray(a?.profile) ? a.profile : a?.profile ? [a.profile] : [])
        .map(String).includes(uuid))
        .map(a => { const u = String(a?.username ?? '').trim(); return u && u !== '*' ? u : 'Anyone'; });
      const used = [dvrNames.length ? plural(dvrNames.length, 'DVR profile') : '', userNames.length ? plural(userNames.length, 'user') : '']
        .filter(Boolean).join(', ');
      const codec = (v: unknown) => { const s = String(v ?? ''); return !s ? 'off' : s === 'copy' ? 'copy' : s; };
      const isDefault = truthy(values['default']);
      return {
        uuid, cls, values,
        name: String(values['name'] || '').trim() || e.text || typeLabel(cls, builderCaption.get(cls)),
        type: typeLabel(cls, builderCaption.get(cls) || e.caption),
        enabled: truthy(values['enabled']) || isDefault,
        isDefault,
        builtin: rdonly.has('name'),
        comment: String(values['comment'] || ''),
        codecs: cls === 'profile-transcode'
          ? `video ${codec(values['pro_vcodec'])} · audio ${codec(values['pro_acodec'])}` : '',
        dvrNames, userNames,
        usedBy: isDefault ? (used ? `Default · ${used}` : 'Default') : used,
      };
    });
  });

  readonly selected = computed(() => this.rows().find(r => r.uuid === this.editor()?.uuid) || null);
  readonly transcodeWithoutCodecs = computed(() =>
    this.selected()?.cls === 'profile-transcode' && this.transcoding() !== null && !this.codecRows().length);

  private readonly allColumns: GridColumn[] = [
    { id: 'name', label: 'Profile', format: (v, r: StreamProfileRow) => v + (r.builtin ? '  · built-in' : ''),
      sortValue: r => `${r.isDefault ? 0 : 1}${String(r.name).toLowerCase()}` },
    { id: 'type', label: 'Type' },
    { id: 'enabled', label: 'Enabled', kind: 'bool' },
    { id: 'usedBy', label: 'Used by', format: v => v || '—' },
    { id: 'codecs', label: 'Transcoding', format: v => v || '—' },
    { id: 'comment', label: 'Comment' },
  ];
  /** Fewer columns while the editor takes half the width. */
  readonly columns = computed(() => this.editor()
    ? this.allColumns.filter(c => ['name', 'type', 'enabled', 'usedBy'].includes(c.id)) : this.allColumns);

  readonly codecRows = computed<CodecProfileRow[]>(() => {
    const full = new Map(this.codecEntries().map(e => [String(e.uuid || e.id || ''), e]));
    const users = this.entries().map(e => ({ e, v: flatten(e).values }));
    const list = this.codecList().length ? this.codecList()
      : this.codecEntries().map(e => ({ uuid: String(e.uuid || e.id || ''), title: String(e.text || ''), status: '' }));
    return list.map(c => {
      const detail = full.get(c.uuid);
      const { values, enums } = detail ? flatten(detail) : { values: {} as Record<string, any>, enums: {} as Record<string, any> };
      const name = String(values['name'] || c.title || '');
      const typeOpts = normalizeEnum(Array.isArray(enums['type']) ? enums['type'] : []);
      const typeValue = values['type'];
      const usedBy = users.filter(u => ['pro_vcodec', 'pro_acodec', 'pro_scodec'].some(k => String(u.v[k] ?? '') === name))
        .map(u => String(u.v['name'] || u.e.text || ''));
      return {
        uuid: c.uuid, name,
        codec: String(values['codec_title'] || values['codec_name'] || ''),
        type: typeOpts.find(o => String(o.value) === String(typeValue))?.label || (typeValue !== undefined ? String(typeValue) : ''),
        status: c.status,
        available: c.status ? c.status === 'codecEnabled' : true,
        description: String(values['description'] || ''),
        usedBy, usedByText: usedBy.join(', '),
      };
    });
  });

  readonly selectedCodec = computed(() => this.codecRows().find(r => r.uuid === this.codecEditor()?.uuid) || null);

  private readonly allCodecColumns: GridColumn[] = [
    { id: 'name', label: 'Codec profile' },
    { id: 'codec', label: 'Encoder' },
    { id: 'type', label: 'Type' },
    { id: 'available', label: 'Encoder available', kind: 'bool' },
    { id: 'usedByText', label: 'Used by', format: v => v || '—' },
    { id: 'description', label: 'Description' },
  ];
  readonly codecColumns = computed(() => this.codecEditor()
    ? this.allCodecColumns.filter(c => ['name', 'codec', 'usedByText'].includes(c.id)) : this.allCodecColumns);

  ngOnInit(): void {
    this.tvh.getBuilders('profile').pipe(catchError(() => of([]))).subscribe(b => this.builders.set(
      b.map(x => ({ ...x, label: typeLabel(x.class, x.caption), detail: PROFILE_TYPES[x.class]?.detail || x.caption,
        order: PROFILE_TYPES[x.class]?.order ?? 99 }))
        .sort((x, y) => x.order - y.order || x.label.localeCompare(y.label))));
    this.load();
    this.loadCodecs();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    forkJoin({
      profiles: this.tvh.idnodeLoadByClass('profile'),
      dvr: this.tvh.getGrid('dvr/config/grid').pipe(catchError(() => of([]))),
      access: this.tvh.getGrid('access/entry/grid').pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ profiles, dvr, access }) => {
        this.entries.set(profiles);
        this.dvrConfigs.set(dvr);
        this.accessEntries.set(access);
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.error.set(Number(err?.status) === 403 ? 'Stream profiles need an administrator account.'
          : Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load stream profiles (${err?.status || 'network error'}).`);
      },
    });
  }

  // ---------------------------------------------------------------- stream profiles

  open(row: StreamProfileRow): void {
    if (row.uuid === this.editor()?.uuid) return;
    this.confirmDiscard(this.profileForm).subscribe(ok => ok && this.editor.set({ uuid: row.uuid }));
  }

  create(b: Builder): void {
    this.confirmDiscard(this.profileForm).subscribe(ok => ok && this.editor.set({ uuid: null, createClass: b.class, label: b.label }));
  }

  close(): void {
    this.confirmDiscard(this.profileForm).subscribe(ok => ok && this.editor.set(null));
  }

  onSaved(event: { uuid: string | null; created: boolean }): void {
    this.snack.open(event.created ? 'Profile created' : 'Profile saved', undefined, { duration: 3000 });
    if (event.created) this.editor.set(event.uuid ? { uuid: event.uuid } : null);
    this.load();
  }

  makeDefault(row: StreamProfileRow): void {
    this.tvh.idnodeSave(row.uuid, { default: 1, enabled: 1 }).subscribe({
      next: () => { this.snack.open(`“${row.name}” is now the default profile`, undefined, { duration: 3500 }); this.load(); },
      error: err => this.snack.open(`Couldn’t change the default (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
    });
  }

  bulkSetEnabled(enabled: boolean): void {
    const grid = this.profileGrid;
    if (!grid) return;
    const all: StreamProfileRow[] = grid.selection.rows();
    const rows = enabled ? all : all.filter(r => !r.isDefault);
    const skipped = all.length - rows.length;
    grid.bulkBusy.set(true);
    runBulk(rows, r => this.tvh.idnodeSave(r.uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      grid.bulkBusy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, 'profile')
        + (skipped ? ' — the default profile stays enabled' : ''), undefined, { duration: 4500 });
      grid.selection.clear();
      this.load();
    });
  }

  deleteProfiles(all: StreamProfileRow[]): void {
    const rows = all.filter(r => !r.builtin && !r.isDefault);
    const kept = all.length - rows.length;
    if (!rows.length) {
      this.snack.open('Built-in profiles and the default profile can’t be deleted', 'OK', { duration: 5000 });
      return;
    }
    const names = rows.slice(0, 3).map(r => `“${r.name}”`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');
    const dvr = rows.reduce((n, r) => n + r.dvrNames.length, 0);
    const users = rows.reduce((n, r) => n + r.userNames.length, 0);
    const effects = [
      dvr ? `${plural(dvr, 'DVR profile')} using ${rows.length === 1 ? 'it' : 'them'} will switch to the built-in pass-through profile.` : '',
      users ? `${plural(users, 'user')} will no longer be offered ${rows.length === 1 ? 'it' : 'them'}.` : '',
      kept ? `${plural(kept, 'built-in or default profile')} in the selection will be kept.` : '',
    ].filter(Boolean).join(' ');
    this.confirm(`Delete ${plural(rows.length, 'stream profile')}?`, `${names} will be removed. ${effects}`.trim(), 'Delete')
      .subscribe(ok => {
        if (!ok) return;
        this.busy.set(true);
        runBulk(rows, r => this.tvh.idnodeDelete(r.uuid)).subscribe(result => {
          this.busy.set(false);
          this.snack.open(describeBulk('Deleted', result, 'profile'), undefined, { duration: 4000 });
          this.profileGrid?.selection.clear();
          if (rows.some(r => r.uuid === this.editor()?.uuid)) this.editor.set(null);
          this.load();
        });
      });
  }

  selectedProfileRows(): StreamProfileRow[] {
    return this.profileGrid?.selection.rows() || [];
  }

  // ---------------------------------------------------------------- codec profiles

  loadCodecs(): void {
    this.codecLoading.set(true);
    forkJoin({
      codecs: this.tvh.getCodecs(),
      list: this.tvh.getCodecProfiles().pipe(catchError(() => of([]))),
      full: this.tvh.idnodeLoadByClass('codec_profile').pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ codecs, list, full }) => {
        this.codecs.set([...codecs].sort((a, b) => a.title.localeCompare(b.title)));
        this.codecList.set(list);
        this.codecEntries.set(full);
        this.transcoding.set(true);
        this.codecLoading.set(false);
      },
      // No codec API: this Tvheadend was built without transcoding (libav).
      error: () => { this.transcoding.set(false); this.codecLoading.set(false); },
    });
  }

  openCodec(row: CodecProfileRow): void {
    if (row.uuid === this.codecEditor()?.uuid) return;
    this.confirmDiscard(this.codecForm).subscribe(ok => ok && this.codecEditor.set({ uuid: row.uuid }));
  }

  createCodec(codec: Codec): void {
    this.confirmDiscard(this.codecForm).subscribe(ok => ok && this.codecEditor.set({ uuid: null, codec }));
  }

  closeCodec(): void {
    this.confirmDiscard(this.codecForm).subscribe(ok => ok && this.codecEditor.set(null));
  }

  onCodecSaved(event: { uuid: string | null; created: boolean }): void {
    this.snack.open(event.created ? 'Codec profile created' : 'Codec profile saved', undefined, { duration: 3000 });
    // codec_profile/create doesn't return the new uuid, so close the editor after creating.
    if (event.created) this.codecEditor.set(event.uuid ? { uuid: event.uuid } : null);
    this.loadCodecs();
    this.load();
  }

  deleteCodecs(rows: CodecProfileRow[]): void {
    if (!rows.length) return;
    const used = rows.filter(r => r.usedBy.length);
    const names = rows.slice(0, 3).map(r => `“${r.name}”`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');
    const warn = used.length
      ? ` Still used by: ${[...new Set(used.flatMap(r => r.usedBy))].join(', ')} — those profiles will need a new codec choice.` : '';
    this.confirm(`Delete ${plural(rows.length, 'codec profile')}?`, `${names} will be removed.${warn}`, 'Delete')
      .subscribe(ok => {
        if (!ok) return;
        this.busy.set(true);
        runBulk(rows, r => this.tvh.idnodeDelete(r.uuid)).subscribe(result => {
          this.busy.set(false);
          this.snack.open(describeBulk('Deleted', result, 'codec profile'), undefined, { duration: 4000 });
          this.codecGrid?.selection.clear();
          if (rows.some(r => r.uuid === this.codecEditor()?.uuid)) this.codecEditor.set(null);
          this.loadCodecs();
        });
      });
  }

  selectedCodecRows(): CodecProfileRow[] {
    return this.codecGrid?.selection.rows() || [];
  }

  goToCodecs(): void {
    this.tabIndex.set(1);
  }

  // ---------------------------------------------------------------- helpers

  private confirm(title: string, message: string, confirm: string): Observable<boolean> {
    const data: ConfirmDialogData = { title, message, confirm, destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }

  private confirmDiscard(form?: IdnodeFormComponent): Observable<boolean> {
    if (!form?.hasUnsavedChanges()) return of(true);
    return this.confirm('Discard changes?', 'You have unsaved changes.', 'Discard');
  }
}
