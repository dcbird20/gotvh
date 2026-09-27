import { Observable, from, of } from 'rxjs';
import { catchError, map, mergeMap, toArray } from 'rxjs/operators';

export interface BulkResult {
  ok: number;
  failed: number;
  total: number;
}

/**
 * Run one request per item, a few at a time, and report how many worked.
 * Failures don't stop the batch — the summary says how many went wrong.
 */
export function runBulk<T>(items: T[], action: (item: T) => Observable<unknown>, concurrency = 4): Observable<BulkResult> {
  if (!items.length) return of({ ok: 0, failed: 0, total: 0 });
  return from(items).pipe(
    mergeMap(item => action(item).pipe(map(() => true), catchError(() => of(false))), concurrency),
    toArray(),
    map(results => ({
      ok: results.filter(Boolean).length,
      failed: results.filter(r => !r).length,
      total: results.length,
    })),
  );
}

/** "Disabled 12 services" / "Deleted 3 of 4 muxes — 1 failed". */
export function describeBulk(verb: string, result: BulkResult, singular: string, plural = `${singular}s`): string {
  const noun = (n: number) => (n === 1 ? singular : plural);
  if (!result.failed) return `${verb} ${result.ok} ${noun(result.ok)}`;
  if (!result.ok) return `Couldn’t ${verb.toLowerCase()} ${result.total} ${noun(result.total)}`;
  return `${verb} ${result.ok} of ${result.total} ${noun(result.total)} — ${result.failed} failed`;
}
