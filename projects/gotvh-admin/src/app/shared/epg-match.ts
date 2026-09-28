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

// ------------------------------------------------------------------ channel → guide

/**
 * The other way round: for one of YOUR channels, which guide channels could feed it.
 * Large guide sources list every station in the country, where the same number (6.3)
 * exists in dozens of markets — so a number alone is only a hint, never picked for you.
 *
 *   name+number — same name and same number (strongest)
 *   name        — same name after normalising
 *   partial     — one name contains the other (4+ characters)
 *   number      — same number only (a hint)
 */
export type GuideReason = 'name+number' | 'name' | 'partial' | 'number';
const GUIDE_SCORE: Record<GuideReason, number> = { 'name+number': 4, name: 3, partial: 2, number: 1 };

export interface GuideCandidate { guide: MatchGuide; reason: GuideReason }

export interface GuideIndex {
  byName: Map<string, MatchGuide[]>;
  byNumber: Map<string, MatchGuide[]>;
  all: Array<{ g: MatchGuide; names: string[] }>;
}

export function indexGuides(guides: MatchGuide[]): GuideIndex {
  const byName = new Map<string, MatchGuide[]>(), byNumber = new Map<string, MatchGuide[]>();
  const all: GuideIndex['all'] = [];
  for (const g of guides) {
    const names = [...new Set([g.name, ...(g.names || [])].map(normalizeChannelName).filter(Boolean))];
    for (const n of names) byName.set(n, [...(byName.get(n) || []), g]);
    const num = normalizeNumber(g.number);
    if (num) byNumber.set(num, [...(byNumber.get(num) || []), g]);
    all.push({ g, names });
  }
  return { byName, byNumber, all };
}

/** Candidates for a channel, best first (at most `max`). */
export function guidesForChannel(ch: MatchChannel, idx: GuideIndex, max = 6): GuideCandidate[] {
  const cName = normalizeChannelName(ch.name), cNum = normalizeNumber(ch.number);
  const found = new Map<string, GuideCandidate>();
  const add = (g: MatchGuide, reason: GuideReason) => {
    const cur = found.get(g.uuid);
    if (!cur || GUIDE_SCORE[reason] > GUIDE_SCORE[cur.reason]) found.set(g.uuid, { guide: g, reason });
  };
  for (const g of (cName && idx.byName.get(cName)) || []) {
    add(g, cNum && normalizeNumber(g.number) === cNum ? 'name+number' : 'name');
  }
  if (cName.length >= 4) {
    for (const { g, names } of idx.all) {
      if (names.some(n => n.length >= 4 && n !== cName && (n.includes(cName) || cName.includes(n)))) add(g, 'partial');
    }
  }
  for (const g of (cNum && idx.byNumber.get(cNum)) || []) add(g, 'number');
  return [...found.values()]
    .sort((a, b) => GUIDE_SCORE[b.reason] - GUIDE_SCORE[a.reason] || a.guide.name.localeCompare(b.guide.name))
    .slice(0, max);
}

/**
 * The candidate to pick for you, if any: the only one at the top, and matched by name.
 * Number-only matches and ties are left for a person.
 */
export function pickGuide(c: GuideCandidate[]): GuideCandidate | null {
  if (!c.length || GUIDE_SCORE[c[0].reason] < GUIDE_SCORE.name) return null;
  if (c.length > 1 && GUIDE_SCORE[c[1].reason] === GUIDE_SCORE[c[0].reason]) return null;
  return c[0];
}
