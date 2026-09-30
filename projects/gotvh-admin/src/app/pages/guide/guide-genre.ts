/**
 * Genre colour coding for the guide.
 *
 * Tvheadend stores genres as DVB content codes (EN 300 468): the high nibble is the group
 * (0x1_ movie, 0x2_ news, 0x4_ sports, …). XMLTV sources only get a code when their <category>
 * matches Tvheadend's genre names, so many programmes have none; for those a few unambiguous
 * title patterns fill in (and the details panel says it was guessed).
 *
 * Seven groups, colours from a palette validated for colour-blind separation and contrast in
 * both themes. Red is left out: in the guide it means "recording".
 * Keep the hex values in sync with the --g-* variables in guide.component.ts.
 */

export type GenreKey = 'movie' | 'news' | 'docs' | 'kids' | 'shows' | 'sports' | 'lifestyle';

export interface GenreInfo { key: GenreKey; label: string; light: string; dark: string }

export const GENRES: GenreInfo[] = [
  { key: 'movie', label: 'Movies & drama', light: '#2a78d6', dark: '#3987e5' },
  { key: 'news', label: 'News & current affairs', light: '#eb6834', dark: '#d95926' },
  { key: 'docs', label: 'Documentary & learning', light: '#1baf7a', dark: '#199e70' },
  { key: 'kids', label: 'Kids', light: '#eda100', dark: '#c98500' },
  { key: 'shows', label: 'Entertainment', light: '#e87ba4', dark: '#d55181' },
  { key: 'sports', label: 'Sports', light: '#008300', dark: '#008300' },
  { key: 'lifestyle', label: 'Lifestyle & hobbies', light: '#4a3aa7', dark: '#9085e9' },
];

/** DVB content group (high nibble) → colour group. */
const BY_GROUP: Record<number, GenreKey> = {
  0x1: 'movie', 0x2: 'news', 0x3: 'shows', 0x4: 'sports', 0x5: 'kids', 0x6: 'shows',
  0x7: 'docs', 0x8: 'news', 0x9: 'docs', 0xa: 'lifestyle',
};

/** Only patterns that are hard to get wrong. */
const GUESSES: Array<[RegExp, GenreKey]> = [
  [/\b(NFL|NBA|WNBA|MLB|NHL|MLS|NCAA|PGA|LPGA|NASCAR|IndyCar|UFC|WWE|Formula 1|F1|Premier League)\b|\b(Football|Baseball|Basketball|Hockey|Soccer|Golf|Tennis|Boxing|Wrestling|Racing|Olympics?)\b|SportsCenter/i, 'sports'],
  [/\bNews(?:room|hour|night|cast)?\b|\bEyewitness\b|Good Morning America|\bToday\b(?! Show)|Meet the Press|Face the Nation|60 Minutes|\bDateline\b|\bNightline\b|\bWeather\b/i, 'news'],
  [/^(Movie|Film)\s*[:|-]/i, 'movie'],
  [/PAW Patrol|Sesame Street|Peppa Pig|Bluey|SpongeBob|Paw Patrol|Daniel Tiger|Curious George|Arthur\b|Cartoon/i, 'kids'],
];

export function genreOf(e: { genre: number[]; title: string; subtitle?: string }): { key: GenreKey; guessed: boolean } | null {
  for (const g of e.genre || []) {
    const key = BY_GROUP[(g >> 4) & 0xf];
    if (key) return { key, guessed: false };
  }
  const text = `${e.title} ${e.subtitle || ''}`;
  for (const [re, key] of GUESSES) if (re.test(text)) return { key, guessed: true };
  return null;
}

export const genreInfo = (key: GenreKey) => GENRES.find(g => g.key === key)!;
