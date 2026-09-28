import { inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * Read ?open=<uuid> (and ?tab=) once — e.g. from a "Connected to" link — and remove them from the
 * address so a reload doesn't reopen the panel. Call from a field initializer (needs injection).
 */
export function consumeOpenParam(): { open: string | null; tab: string | null } {
  const route = inject(ActivatedRoute), router = inject(Router);
  const q = route.snapshot.queryParamMap;
  const open = q.get('open'), tab = q.get('tab');
  if (open || tab) {
    queueMicrotask(() => router.navigate([], { relativeTo: route, queryParams: { open: null, tab: null }, queryParamsHandling: 'merge', replaceUrl: true }));
  }
  return { open, tab };
}
