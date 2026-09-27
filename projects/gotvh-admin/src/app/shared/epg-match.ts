/*
 * Suggest which Tvheadend channel a guide (EPG) channel belongs to.
 *
 * Scoring, strongest first:
 *   number  — guide channel number equals the channel number ("3.1" = "3.1")
 *   name    — names equal after normalising (case, punctuation, "HD"/"DT" suffixes)
 *   partial — one normalised name contains the other (4+ characters)
 * A guide channel with no match, or a tie at the top score, gets no proposal
 * so a person picks — a wrong mapping is worse than a missing one.
 */

export interface MatchChannel {
  uuid: string;
  name: string;
  number: string;
}

export interface MatchGuide {
  uuid: string;
  name: string;
  names?: string[];
  number: string;
  id?: string;
}

export type MatchReason = 'number' | 'name' | 'partial';

export interface MatchResult {
  channel: MatchChannel | null;
  reason: MatchReason | null;
  /** Other channels that scored the same (why no proposal was made). */
  tiedWith: MatchChannel[];
}

/** "WPSU-HD", "wpsu hd", "WPSU" → "wpsu". */
export function normalizeChannelName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(hd|sd|dt|dt\d|fhd|uhd|4k|east|feed)\b/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

/** "3.1" → "3.1", 3 → "3", 0 / "" / null → "". */
export function normalizeNumber(n: unknown): string {
  const s = String(n ?? '').trim();
  if (!s || s === '0') return '';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return '';
  return m[2] && Number(m[2]) > 0 ? `${Number(m[1])}.${Number(m[2])}` : String(Number(m[1]));
}

const SCORE: Record<MatchReason, number> = { number: 3, name: 2, partial: 1 };

export function matchGuideChannel(guide: MatchGuide, channels: MatchChannel[]): MatchResult {
  const gNum = normalizeNumber(guide.number);
  const gNames = [guide.name, ...(guide.names || [])].map(normalizeChannelName).filter(Boolean);

  let best = 0;
  let winners: Array<{ ch: MatchChannel; reason: MatchReason }> = [];
  for (const ch of channels) {
    const cNum = normalizeNumber(ch.number);
    const cName = normalizeChannelName(ch.name);
    let reason: MatchReason | null = null;
    if (gNum && cNum && gNum === cNum) reason = 'number';
    else if (cName && gNames.includes(cName)) reason = 'name';
    else if (cName.length >= 4 && gNames.some(g => g.length >= 4 && (g.includes(cName) || cName.includes(g)))) reason = 'partial';
    if (!reason) continue;
    const score = SCORE[reason];
    if (score > best) { best = score; winners = [{ ch, reason }]; }
    else if (score === best) winners.push({ ch, reason });
  }

  if (winners.length === 1) return { channel: winners[0].ch, reason: winners[0].reason, tiedWith: [] };
  return { channel: null, reason: null, tiedWith: winners.map(w => w.ch) };
}
