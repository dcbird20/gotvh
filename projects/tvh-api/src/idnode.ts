/*
 * Tvheadend "idnode" metadata.
 *
 * Almost every configurable object in Tvheadend (DVR profiles, networks,
 * muxes, channels, users, …) is an idnode. The API can describe each object's
 * fields — type, caption, choices, read-only, UI level — and the stock web UI
 * builds its edit forms from that description. These types model it so the
 * admin app can do the same.
 *
 * Shapes are written defensively: fields the server omits are optional, and
 * unknown types fall back to read-only text in the form.
 */

/** Value types Tvheadend reports for a property. */
export type IdnodePropType =
  | 'str' | 'langstr' | 'perm'
  | 'bool'
  | 'int' | 'u16' | 'u32' | 's64' | 's64_atomic' | 'dbl'
  | 'time'
  | string;

/** A fixed choice: either a bare value or a key/label pair. */
export type IdnodeEnumEntry = string | number | { key: string | number; val: string };

/** A choice list fetched from another API endpoint (e.g. stream profiles). */
export interface IdnodeDeferredEnum {
  type: 'api';
  uri: string;
  params?: Record<string, unknown>;
  event?: string;
  stype?: string;
}

export interface IdnodeProp {
  id: string;
  type: IdnodePropType;
  caption?: string;
  description?: string;
  /** Current value (on a loaded node). */
  value?: unknown;
  /** Default value (on class metadata, used when creating). */
  default?: unknown;
  /** Group number; matches an entry in IdnodeMeta.groups. */
  group?: number;
  /** Multi-value property (array of values). */
  list?: boolean | number;
  enum?: IdnodeEnumEntry[] | IdnodeDeferredEnum;

  rdonly?: boolean | number;
  wronce?: boolean | number;
  nosave?: boolean | number;
  noui?: boolean | number;
  hidden?: boolean | number;
  advanced?: boolean | number;
  expert?: boolean | number;
  password?: boolean | number;
  multiline?: boolean | number;
  duration?: boolean | number;
  intsplit?: number;
  hexa?: boolean | number;
  lorder?: boolean | number;
}

export interface IdnodeGroup {
  number: number;
  name: string;
  parent?: number;
  column?: number;
}

export interface IdnodeMeta {
  groups?: IdnodeGroup[];
}

/** One object as returned by idnode/load (with values) or <class>/class (defaults only). */
export interface IdnodeEntry {
  uuid?: string;
  id?: string;
  text?: string;
  caption?: string;
  class?: string;
  event?: string;
  params: IdnodeProp[];
  meta?: IdnodeMeta;
}

/** Normalized choice for dropdowns. */
export interface IdnodeOption {
  value: string | number;
  label: string;
}

/** UI levels, as in the stock UI's "View level" switch. */
export type IdnodeLevel = 'basic' | 'advanced' | 'expert';

export const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1';

export function propLevel(prop: IdnodeProp): IdnodeLevel {
  if (truthy(prop.expert)) return 'expert';
  if (truthy(prop.advanced)) return 'advanced';
  return 'basic';
}

export function isVisibleAtLevel(prop: IdnodeProp, level: IdnodeLevel): boolean {
  if (truthy(prop.noui) || truthy(prop.hidden)) return false;
  const order: IdnodeLevel[] = ['basic', 'advanced', 'expert'];
  return order.indexOf(propLevel(prop)) <= order.indexOf(level);
}

export function isDeferredEnum(e: IdnodeProp['enum']): e is IdnodeDeferredEnum {
  return !!e && !Array.isArray(e) && typeof e === 'object' && (e as IdnodeDeferredEnum).type === 'api';
}

export function normalizeEnum(entries: IdnodeEnumEntry[] | undefined | null): IdnodeOption[] {
  return (entries || []).map(e =>
    typeof e === 'object' && e !== null
      ? { value: e.key, label: String(e.val ?? e.key) }
      : { value: e as string | number, label: String(e) });
}

export function isNumericType(type: IdnodePropType): boolean {
  return ['int', 'u16', 'u32', 's64', 's64_atomic', 'dbl'].includes(type);
}
