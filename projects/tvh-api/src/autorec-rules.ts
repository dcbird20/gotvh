/*
 * Auto-record rule helpers shared by the TV and admin apps.
 *
 * Copied from the TV app's AutorecComponent so both apps read and write rules
 * the same way:
 *  - the rule's `title` is a regex; plain titles are escaped, with optional
 *    ^/$ anchors for "starts with" / "ends with"
 *  - an episode filter is stored in `comment` as a `[epmatch:...]` line
 *  - `start` is minutes after midnight, with 0 meaning "any time"
 */

export type AutorecMatchMode = 'title' | 'fulltext';

export interface ParsedTitlePattern {
  title: string;
  startsWith: boolean;
  endsWith: boolean;
  customRegex: boolean;
  rawPattern: string;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/;

export function escapeRegex(value: string): string {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

export function buildRuleTitlePattern(title: string, matchMode: AutorecMatchMode, startsWith: boolean, endsWith: boolean): string {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) {
    return '';
  }
  const escapedTitle = escapeRegex(normalizedTitle);
  if (matchMode !== 'title') {
    return escapedTitle;
  }
  return `${startsWith ? '^' : ''}${escapedTitle}${endsWith ? '$' : ''}`;
}

/** Reverses buildRuleTitlePattern; anything it didn't produce is reported as a custom regex. */
export function parseStoredTitlePattern(pattern: string): ParsedTitlePattern {
  const rawPattern = String(pattern || '').trim();
  const custom: ParsedTitlePattern = { title: rawPattern, startsWith: false, endsWith: false, customRegex: true, rawPattern };
  if (!rawPattern) {
    return { title: '', startsWith: false, endsWith: false, customRegex: false, rawPattern: '' };
  }

  let startsWith = false;
  let endsWith = false;
  let startIndex = 0;
  let endIndex = rawPattern.length;

  if (rawPattern.startsWith('^')) {
    startsWith = true;
    startIndex = 1;
  }
  if (endIndex > startIndex && rawPattern.endsWith('$') && !isEscaped(rawPattern, rawPattern.length - 1)) {
    endsWith = true;
    endIndex -= 1;
  }

  const core = rawPattern.slice(startIndex, endIndex);
  let title = '';
  for (let index = 0; index < core.length; index += 1) {
    const current = core[index];
    if (current === '\\') {
      const next = core[index + 1];
      if (!next || !REGEX_META.test(next)) {
        return custom;
      }
      title += next;
      index += 1;
      continue;
    }
    if (REGEX_META.test(current)) {
      return custom;
    }
    title += current;
  }

  return { title, startsWith, endsWith, customRegex: false, rawPattern };
}

export function extractCommentMetadata(rawComment: string): { comment: string; episodeMatch: string } {
  const cleanedLines: string[] = [];
  let episodeMatch = '';
  for (const line of String(rawComment || '').split(/\r?\n/)) {
    const match = /^\[epmatch:(.+)\]$/i.exec(String(line || '').trim());
    if (match && !episodeMatch) {
      episodeMatch = String(match[1] || '').trim();
      continue;
    }
    cleanedLines.push(line);
  }
  return { comment: cleanedLines.join('\n').trim(), episodeMatch };
}

export function composeCommentWithEpisodeMatch(comment: string, episodeMatch: string): string {
  const cleanComment = extractCommentMetadata(String(comment || '').trim()).comment;
  const cleanEpisodeMatch = String(episodeMatch || '').trim();
  if (!cleanEpisodeMatch) {
    return cleanComment;
  }
  return [`[epmatch:${cleanEpisodeMatch}]`, cleanComment].filter(Boolean).join('\n').trim();
}

/** "HH:MM" → minutes after midnight; empty → null; invalid → NaN. */
export function parseTimeToMinutes(value: string): number | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    return Number.NaN;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return Number.NaN;
  }
  return hours * 60 + minutes;
}

/** Minutes after midnight → "HH:MM"; 0 or missing → "" (any time). */
export function formatStartMinutesAsTime(value: unknown): string {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  const asMinutes = numeric > 24 * 60 ? Math.floor(numeric / 60) : Math.floor(numeric);
  const wrapped = ((asMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** "" → null; digits → number; anything else → NaN. */
export function parseOptionalNonNegativeInteger(value: string | number | null | undefined): number | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

export function formatOptionalInteger(value: unknown): string {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? String(Math.floor(numeric)) : '';
}

/** Tvheadend weekday numbering: 1 = Monday … 7 = Sunday. */
export const AUTOREC_WEEKDAYS: ReadonlyArray<{ value: number; short: string }> = [
  { value: 1, short: 'Mon' }, { value: 2, short: 'Tue' }, { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' }, { value: 5, short: 'Fri' }, { value: 6, short: 'Sat' }, { value: 7, short: 'Sun' },
];

export function normalizeWeekdays(value: unknown): number[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const days = list.map(v => Number(v)).filter(v => Number.isInteger(v) && v >= 1 && v <= 7);
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

/** "Every day", "Weekdays", "Weekends", or e.g. "Mon, Wed, Fri". */
export function describeWeekdays(value: unknown): string {
  const days = normalizeWeekdays(value);
  if (days.length === 0 || days.length === 7) return 'Every day';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '6,7') return 'Weekends';
  return days.map(d => AUTOREC_WEEKDAYS[d - 1].short).join(', ');
}
