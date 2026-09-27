import { Component, DestroyRef, OnChanges, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatChipInputEvent, MatChipsModule } from '@angular/material/chips';
import { COMMA, ENTER } from '@angular/cdk/keycodes';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  IdnodeEntry, IdnodeLevel, IdnodeOption, IdnodeProp, TvheadendService, isDeferredEnum, isNumericType,
  isVisibleAtLevel, normalizeEnum, propLevel, truthy,
} from '@gotvh/tvh-api';
import { BulkResult, describeBulk, runBulk } from '../bulk';

/** How a bulk edit changes a multi-value field on each item. */
export type ListMode = 'add' | 'remove' | 'replace';

type FieldKind = 'toggle' | 'select' | 'multiselect' | 'namelist' | 'number' | 'text' | 'password' | 'textarea' | 'readonly';

/**
 * Text fields that are really lists of channel-tag names, one per line.
 * Shown as a tag picker (existing tags suggested, new names allowed) and
 * bulk-editable with Add / Remove / Replace like other list fields.
 */
const NAME_LIST_FIELDS: Record<string, { hint: string }> = {
  iptv_tags: {
    hint: 'Given to channels when this mux’s services are mapped. Doesn’t change channels already mapped. New names create new tags.',
  },
};

/** Split newline-separated names, trimmed, empties and duplicates (any case) removed. */
export function splitNames(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const name = String(item ?? '').trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

interface Field {
  prop: IdnodeProp;
  kind: FieldKind;
  label: string;
  level: IdnodeLevel;
  editable: boolean;
  options?: IdnodeOption[];
  optionsLoading?: boolean;
  optionsError?: boolean;
}

interface Section {
  name: string;
  fields: Field[];
}

const LEVEL_KEY = 'gotvh_admin_idnode_level';

/**
 * "Split" integers, e.g. channel numbers: Tvheadend stores 5.1 as
 * 5 * intsplit + 1 (intsplit is 1000000 for channels) and shows "major.minor".
 */
export function formatIntsplit(raw: unknown, split: number): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || !split) return String(raw ?? '');
  if (typeof raw === 'string' && raw.includes('.')) return raw; // already formatted
  const major = Math.floor(n / split), minor = n % split;
  return minor ? `${major}.${minor}` : String(major);
}

export function parseIntsplit(text: string, split: number): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * split + Number(m[2] || 0);
}

/** True while a select panel, autocomplete, menu or dialog is showing. */
export function overlayIsOpen(): boolean {
  return !!document.querySelector('.cdk-overlay-container .cdk-overlay-pane:not(:empty)');
}

/**
 * Renders any Tvheadend idnode as an edit form, driven entirely by the field
 * metadata the server returns. Pass `uuid` to edit an existing object,
 * `createPath` (e.g. "dvr/config") to create a new one from class defaults, or
 * `bulkUuids` to change settings on many objects at once.
 *
 * Bulk mode shows the first object's values. Each field has an "apply"
 * checkbox that ticks itself when the field is changed (or can be ticked to
 * push the shown value as-is); only ticked fields are saved, to every object.
 * Multi-value fields (e.g. channel tags) default to "Add": the chosen values
 * are merged into each object's own list rather than replacing it.
 */
@Component({
  selector: 'admin-idnode-form',
  standalone: true,
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule,
    MatButtonModule, MatButtonToggleModule, MatIconModule, MatTooltipModule, MatProgressBarModule, MatCheckboxModule,
    MatChipsModule, MatAutocompleteModule,
  ],
  templateUrl: './idnode-form.component.html',
  styleUrl: './idnode-form.component.scss',
})
export class IdnodeFormComponent implements OnChanges {
  private readonly tvh = inject(TvheadendService);
  private readonly destroyRef = inject(DestroyRef);

  /** Existing object to edit. */
  readonly uuid = input<string | null>(null);
  /** API base for creating a new object, e.g. "dvr/config". Used when `uuid` is empty. */
  readonly createPath = input<string | null>(null);
  /**
   * For bases with several creatable types (e.g. networks: DVB-T, IPTV …), the
   * class to create. Metadata comes from idnode/class and creation posts the class.
   */
  readonly createClass = input<string | null>(null);
  /** Edit many objects at once (bulk mode). Takes precedence over `uuid`. */
  readonly bulkUuids = input<string[] | null>(null);
  /** Values to pre-fill when creating (override class defaults). */
  readonly createDefaults = input<Record<string, unknown>>({});
  readonly title = input('');

  readonly saved = output<{ uuid: string | null; created: boolean; bulk?: BulkResult }>();
  readonly closed = output<void>();

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly entry = signal<IdnodeEntry | null>(null);
  readonly fields = signal<Field[]>([]);
  readonly level = signal<IdnodeLevel>(this.readStoredLevel());
  readonly changeCount = signal(0);
  /** Bulk mode: fields that will be written to every object. */
  readonly applied = signal<Set<string>>(new Set());
  /** Bulk mode: add/remove/replace per multi-value field. */
  readonly listModes = signal<Record<string, ListMode>>({});
  /** Bulk mode: the first object's list values, used when switching to Replace. */
  private firstValues: Record<string, unknown> = {};

  /** Existing channel-tag names, suggested in tag-name pickers. */
  readonly channelTagNames = signal<string[]>([]);
  /** Text typed in a tag-name picker, for filtering suggestions. */
  readonly nameQuery = signal('');
  readonly nameSeparators = [ENTER, COMMA];

  form = new FormGroup<Record<string, FormControl>>({});
  private initial: Record<string, unknown> = {};

  readonly bulkMode = computed(() => (this.bulkUuids()?.length ?? 0) > 0);
  readonly bulkCount = computed(() => this.bulkUuids()?.length ?? 0);
  readonly creating = computed(() => !this.uuid() && !this.bulkMode());
  /** Hide read-only fields when creating or bulk-editing: they only describe one existing object. */
  private readonly editableOnly = computed(() => this.creating() || this.bulkMode());

  /** Which levels actually have fields — hides the switch when there's nothing extra. */
  readonly availableLevels = computed(() => {
    const levels = new Set(this.fields().filter(f => !truthy(f.prop.noui) && !truthy(f.prop.hidden)).map(f => f.level));
    return (['basic', 'advanced', 'expert'] as IdnodeLevel[]).filter(l => l === 'basic' || levels.has(l));
  });

  readonly sections = computed<Section[]>(() => {
    const level = this.level();
    const visible = this.fields().filter(f => isVisibleAtLevel(f.prop, level) && !(this.editableOnly() && !f.editable));
    const groups = [...(this.entry()?.meta?.groups || [])].sort((a, b) => a.number - b.number);
    if (!groups.length) {
      return visible.length ? [{ name: '', fields: visible }] : [];
    }
    const byGroup = new Map<number, Field[]>();
    for (const f of visible) {
      const g = groups.some(x => x.number === f.prop.group) ? f.prop.group! : -1;
      byGroup.set(g, [...(byGroup.get(g) || []), f]);
    }
    const sections: Section[] = groups
      .map(g => ({ name: g.name, fields: byGroup.get(g.number) || [] }))
      .filter(s => s.fields.length);
    if (byGroup.get(-1)?.length) sections.push({ name: 'Other', fields: byGroup.get(-1)! });
    return sections;
  });

  readonly hiddenCount = computed(() => {
    const level = this.level();
    return this.fields().filter(f => !truthy(f.prop.noui) && !truthy(f.prop.hidden)
      && !isVisibleAtLevel(f.prop, level) && !(this.editableOnly() && !f.editable)).length;
  });

  ngOnChanges(): void {
    this.load();
  }

  // ---------------------------------------------------------------- loading

  load(): void {
    const uuid = this.bulkUuids()?.[0] || this.uuid();
    const createPath = this.createPath();
    if (!uuid && !createPath) return;

    this.loading.set(true);
    this.error.set('');
    this.entry.set(null);
    this.fields.set([]);
    const createClass = this.createClass();
    const request: Observable<IdnodeEntry> = uuid
      ? this.tvh.idnodeLoad(uuid)
      : createClass ? this.tvh.idnodeClassByName(createClass) : this.tvh.idnodeClass(createPath!);

    request.subscribe({
      next: entry => {
        this.entry.set(entry);
        this.buildForm(entry, this.creating());
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.error.set(this.describeError(err));
      },
    });
  }

  private buildForm(entry: IdnodeEntry, creating: boolean): void {
    const controls: Record<string, FormControl> = {};
    const fields: Field[] = [];
    const overrides = this.createDefaults();
    this.initial = {};

    for (const prop of entry.params) {
      if (!prop?.id) continue;
      const kind = this.kindFor(prop);
      const editable = kind !== 'readonly' && !truthy(prop.rdonly) && !(truthy(prop.wronce) && !creating);
      const raw = creating ? (prop.id in overrides ? overrides[prop.id] : prop.default) : prop.value;
      let value = this.toControlValue(prop, kind, raw);
      if (this.bulkMode() && (kind === 'multiselect' || kind === 'namelist')) {
        this.firstValues[prop.id] = value;
        value = []; // "Add" starts empty: pick what to add
      }
      this.initial[prop.id] = value;
      controls[prop.id] = new FormControl({ value, disabled: !editable });

      const field: Field = { prop, kind, label: prop.caption || prop.id, level: propLevel(prop), editable };
      if (Array.isArray(prop.enum)) {
        field.options = normalizeEnum(prop.enum);
      } else if (isDeferredEnum(prop.enum)) {
        field.optionsLoading = true;
      }
      fields.push(field);
    }

    this.form = new FormGroup(controls);
    this.fields.set(fields);
    this.applied.set(new Set());
    this.listModes.set(this.bulkMode()
      ? Object.fromEntries(fields.filter(f => (f.kind === 'multiselect' || f.kind === 'namelist') && f.editable)
          .map(f => [f.prop.id, 'add' as ListMode]))
      : {});
    this.changeCount.set(creating ? 1 : 0); // a new object can always be saved
    if (this.bulkMode()) {
      // Editing a field ticks its "apply to all" box.
      for (const f of fields.filter(x => x.editable)) {
        controls[f.prop.id].valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => this.setApplied(f.prop.id, true));
      }
    }
    this.form.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.bulkMode()) return;
      this.changeCount.set(this.creating() ? 1 : Object.keys(this.collectChanges()).length);
    });
    this.loadDeferredEnums(fields);
    if (fields.some(f => f.kind === 'namelist')) {
      this.tvh.getChannelTags().subscribe(tags => this.channelTagNames.set(
        splitNames(tags.map((t: any) => t?.name)).sort((a, b) => a.localeCompare(b))));
    }
  }

  /** Fetch choice lists that live on other endpoints; one request per distinct URI+params. */
  private loadDeferredEnums(fields: Field[]): void {
    const pending = fields.filter(f => f.optionsLoading);
    if (!pending.length) return;
    const cache = new Map<string, Observable<IdnodeOption[] | null>>();
    const requests = pending.map(f => {
      const def = f.prop.enum as any;
      const key = JSON.stringify([def.uri, def.params]);
      if (!cache.has(key)) {
        cache.set(key, this.tvh.idnodeEnumOptions(def).pipe(catchError(() => of(null))));
      }
      return cache.get(key)!.pipe(map(options => ({ id: f.prop.id, options })));
    });
    forkJoin(requests).subscribe(results => {
      const byId = new Map(results.map(r => [r.id, r.options]));
      this.fields.update(list => list.map(f => byId.has(f.prop.id)
        ? { ...f, options: byId.get(f.prop.id) || [], optionsLoading: false, optionsError: byId.get(f.prop.id) === null }
        : f));
    });
  }

  private kindFor(prop: IdnodeProp): FieldKind {
    if (prop.id in NAME_LIST_FIELDS && prop.type === 'str' && !prop.enum) return 'namelist';
    if (prop.enum) return prop.list ? 'multiselect' : 'select';
    if (prop.type === 'bool') return 'toggle';
    if (isNumericType(prop.type)) return prop.list ? 'readonly' : 'number';
    if (prop.type === 'str' || prop.type === 'perm') {
      if (prop.list) return 'readonly';
      if (truthy(prop.password)) return 'password';
      if (truthy(prop.multiline)) return 'textarea';
      return 'text';
    }
    return 'readonly'; // time, langstr and anything unrecognized: show, don't edit
  }

  private toControlValue(prop: IdnodeProp, kind: FieldKind, raw: unknown): unknown {
    switch (kind) {
      case 'toggle': return truthy(raw) || raw === 'true';
      case 'multiselect': return Array.isArray(raw) ? [...raw] : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
      case 'namelist': return splitNames(raw);
      case 'number':
        if (raw === undefined || raw === null) return '';
        return prop.intsplit ? formatIntsplit(raw, Number(prop.intsplit)) : String(raw);
      case 'select': return raw ?? '';
      case 'readonly': return raw;
      default: return raw === undefined || raw === null ? '' : String(raw);
    }
  }

  private fromControlValue(field: Field, value: unknown): unknown {
    if (field.kind === 'number') {
      const text = String(value ?? '').trim();
      if (text === '') return 0;
      if (field.prop.intsplit) return parseIntsplit(text, Number(field.prop.intsplit));
      const n = Number(text);
      return Number.isFinite(n) ? n : Number.NaN;
    }
    if (field.kind === 'toggle') return !!value;
    if (field.kind === 'namelist') return splitNames(value).join('\n'); // Tvheadend stores one name per line
    return value;
  }

  // ---------------------------------------------------------------- saving

  /** Editable properties whose value differs from what was loaded. */
  private collectChanges(): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    const values = this.form.getRawValue();
    for (const f of this.fields()) {
      if (!f.editable || truthy(f.prop.nosave)) continue;
      if (JSON.stringify(values[f.prop.id]) !== JSON.stringify(this.initial[f.prop.id])) {
        changes[f.prop.id] = this.fromControlValue(f, values[f.prop.id]);
      }
    }
    return changes;
  }

  /** Bulk mode: the ticked fields with their current values. */
  private collectApplied(): Record<string, unknown> {
    const values = this.form.getRawValue();
    const out: Record<string, unknown> = {};
    for (const f of this.fields()) {
      if (!f.editable || !this.applied().has(f.prop.id)) continue;
      const mode = this.listModes()[f.prop.id];
      const v = values[f.prop.id];
      if ((mode === 'add' || mode === 'remove') && (!Array.isArray(v) || !v.length)) continue; // nothing picked
      out[f.prop.id] = this.fromControlValue(f, v);
    }
    return out;
  }

  listMode(id: string): ListMode | null {
    return this.listModes()[id] ?? null;
  }

  /** Switch a list field between add/remove/replace. Resets its value and tick so nothing surprising is applied. */
  setListMode(id: string, mode: ListMode): void {
    this.listModes.update(m => ({ ...m, [id]: mode }));
    const control = this.form.controls[id];
    const value = mode === 'replace' ? this.firstValues[id] ?? [] : [];
    control?.setValue(Array.isArray(value) ? [...value] : value, { emitEvent: false });
    this.initial[id] = control?.getRawValue();
    this.setApplied(id, false);
  }

  // ---------------------------------------------------------------- tag-name picker

  namesOf(field: Field): string[] {
    return (this.form.controls[field.prop.id]?.value as string[]) || [];
  }

  addName(field: Field, text: string): void {
    const control = this.form.controls[field.prop.id];
    const next = splitNames([...this.namesOf(field), ...String(text || '').split(',')]);
    if (next.length !== this.namesOf(field).length) control.setValue(next);
    this.nameQuery.set('');
  }

  onNameToken(field: Field, event: MatChipInputEvent): void {
    this.addName(field, event.value);
    event.chipInput.clear();
  }

  removeName(field: Field, name: string): void {
    this.form.controls[field.prop.id].setValue(this.namesOf(field).filter(n => n !== name));
  }

  nameHint(field: Field): string {
    return NAME_LIST_FIELDS[field.prop.id]?.hint || field.prop.description || '';
  }

  /** Existing tag names matching what's typed, minus ones already chosen. */
  tagSuggestions(field: Field): string[] {
    const chosen = new Set(this.namesOf(field).map(n => n.toLowerCase()));
    const q = this.nameQuery().trim().toLowerCase();
    return this.channelTagNames().filter(n => !chosen.has(n.toLowerCase()) && (!q || n.toLowerCase().includes(q))).slice(0, 30);
  }

  listLabel(field: Field): string {
    switch (this.listMode(field.prop.id)) {
      case 'add': return `${field.label} to add`;
      case 'remove': return `${field.label} to remove`;
      default: return field.label;
    }
  }

  setApplied(id: string, on: boolean): void {
    this.applied.update(set => {
      const next = new Set(set);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    // Count what would actually be written (an "Add" with nothing picked writes nothing).
    this.changeCount.set(Object.keys(this.collectApplied()).length);
  }

  /** On create, send every editable value so class defaults are explicit. */
  private collectAll(): Record<string, unknown> {
    const values = this.form.getRawValue();
    const conf: Record<string, unknown> = {};
    for (const f of this.fields()) {
      // Skip fields the UI never shows; the server fills in its own defaults for those.
      if (!f.editable || truthy(f.prop.nosave) || truthy(f.prop.noui) || truthy(f.prop.hidden)) continue;
      conf[f.prop.id] = this.fromControlValue(f, values[f.prop.id]);
    }
    return conf;
  }

  save(): void {
    if (this.bulkMode()) {
      this.saveBulk();
      return;
    }
    const uuid = this.uuid();
    const payload = uuid ? this.collectChanges() : this.collectAll();
    const bad = Object.entries(payload).find(([, v]) => typeof v === 'number' && Number.isNaN(v));
    if (bad) {
      const label = this.fields().find(f => f.prop.id === bad[0])?.label || bad[0];
      this.error.set(`“${label}” must be a number.`);
      return;
    }
    if (uuid && !Object.keys(payload).length) return;

    this.error.set('');
    this.saving.set(true);
    const createClass = this.createClass();
    const request = uuid
      ? this.tvh.idnodeSave(uuid, payload)
      : createClass
        ? this.tvh.idnodeCreateWithClass(this.createPath()!, createClass, payload)
        : this.tvh.idnodeCreate(this.createPath()!, payload);
    request.subscribe({
      next: res => {
        this.saving.set(false);
        if (uuid) {
          this.initial = { ...this.form.getRawValue() };
          this.changeCount.set(0);
        }
        this.saved.emit({ uuid: uuid || String(res?.uuid || '') || null, created: !uuid });
      },
      error: err => {
        this.saving.set(false);
        this.error.set(this.describeError(err));
      },
    });
  }

  private saveBulk(): void {
    const uuids = this.bulkUuids() || [];
    const payload = this.collectApplied();
    const bad = Object.entries(payload).find(([, v]) => typeof v === 'number' && Number.isNaN(v));
    if (bad) {
      const label = this.fields().find(f => f.prop.id === bad[0])?.label || bad[0];
      this.error.set(`“${label}” must be a number.`);
      return;
    }
    if (!Object.keys(payload).length || !uuids.length) return;

    // Add/remove fields depend on each item's own list, so load it first and merge.
    const modes = this.listModes();
    const merged = Object.keys(payload).filter(id => modes[id] === 'add' || modes[id] === 'remove');
    const plain = { ...payload };
    merged.forEach(id => delete plain[id]);
    const perItem = (uuid: string): Observable<unknown> => {
      if (!merged.length) return this.tvh.idnodeSave(uuid, plain);
      return this.tvh.idnodeLoad(uuid).pipe(switchMap(entry => {
        const changes: Record<string, unknown> = { ...plain };
        for (const id of merged) {
          const current = entry.params.find(p => p.id === id)?.value;
          if (this.fields().find(f => f.prop.id === id)?.kind === 'namelist') {
            // Newline-separated names: merge ignoring case, write back as text.
            const have = splitNames(current);
            const picked = splitNames(payload[id]);
            const lower = (list: string[]) => new Set(list.map(n => n.toLowerCase()));
            changes[id] = (modes[id] === 'add'
              ? [...have, ...picked.filter(n => !lower(have).has(n.toLowerCase()))]
              : have.filter(n => !lower(picked).has(n.toLowerCase()))).join('\n');
            continue;
          }
          const have = Array.isArray(current) ? current : (current === undefined || current === null || current === '' ? [] : [current]);
          const picked = (payload[id] as unknown[]) || [];
          changes[id] = modes[id] === 'add'
            ? [...have, ...picked.filter(v => !have.includes(v))]
            : have.filter(v => !picked.includes(v));
        }
        return this.tvh.idnodeSave(uuid, changes);
      }));
    };

    this.error.set('');
    this.saving.set(true);
    runBulk(uuids, perItem).subscribe(result => {
      this.saving.set(false);
      if (result.failed) {
        // Keep the form open so the change can be retried.
        this.error.set(describeBulk('Updated', result, 'item') + '. Try saving again.');
        return;
      }
      this.applied.set(new Set());
      this.changeCount.set(0);
      this.saved.emit({ uuid: null, created: false, bulk: result });
    });
  }

  reset(): void {
    this.form.reset(this.initial);
    this.applied.set(new Set()); // reset() fires valueChanges, which ticks boxes — clear after
    this.changeCount.set(this.creating() ? 1 : 0);
  }

  hasUnsavedChanges(): boolean {
    return !this.creating() && this.changeCount() > 0;
  }

  // ---------------------------------------------------------------- view helpers

  setLevel(level: IdnodeLevel): void {
    this.level.set(level);
    try { localStorage.setItem(LEVEL_KEY, level); } catch { /* storage unavailable */ }
  }

  private readStoredLevel(): IdnodeLevel {
    try {
      const v = localStorage.getItem(LEVEL_KEY);
      if (v === 'advanced' || v === 'expert') return v;
    } catch { /* storage unavailable */ }
    return 'basic';
  }

  isChanged(field: Field): boolean {
    if (this.creating()) return false;
    if (this.bulkMode()) return this.applied().has(field.prop.id);
    return JSON.stringify(this.form.controls[field.prop.id]?.getRawValue()) !== JSON.stringify(this.initial[field.prop.id]);
  }

  /** Current value in a select that isn't among the options (e.g. deleted stream profile). */
  missingOption(field: Field): IdnodeOption | null {
    const v = this.form.controls[field.prop.id]?.getRawValue();
    if (v === '' || v === null || v === undefined || field.optionsLoading) return null;
    return (field.options || []).some(o => o.value === v) ? null : { value: v as any, label: `${v} (not in list)` };
  }

  displayReadonly(field: Field): string {
    const v = this.form.controls[field.prop.id]?.getRawValue();
    if (v === null || v === undefined || v === '') return '—';
    if (field.prop.type === 'time' && Number(v) > 0) return new Date(Number(v) * 1000).toLocaleString();
    if (field.prop.type === 'bool') return truthy(v) ? 'Yes' : 'No';
    if (field.options) {
      const list = Array.isArray(v) ? v : [v];
      return list.map(x => field.options!.find(o => o.value === x)?.label ?? String(x)).join(', ');
    }
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') return Object.values(v as object).join(' / ');
    return String(v);
  }

  /** Esc closes the editor — unless it was meant for an open dropdown or dialog. */
  onEscape(event: Event): void {
    if (event.defaultPrevented || overlayIsOpen()) return;
    this.closed.emit();
  }

  levelLabel(level: IdnodeLevel): string {
    return level === 'basic' ? 'Basic' : level === 'advanced' ? 'Advanced' : 'Expert';
  }

  private describeError(error: any): string {
    if (error instanceof Error && !('status' in error)) return error.message;
    switch (Number(error?.status || 0)) {
      case 401: return 'Sign in required — use Sign in at the top right.';
      case 403: return 'This Tvheadend account doesn’t have admin access.';
      case 0: return 'Tvheadend is unreachable. Check the server and proxy.';
      default: return `Tvheadend returned an error (${error?.status || 'unknown'}).`;
    }
  }
}
