import { ChangeDetectorRef } from '@angular/core';

/**
 * Render a view now, then act on the new DOM (usually: move focus).
 *
 * TV screens used setTimeout(…, 0) to wait for Angular to redraw before focusing, which works
 * until the device is slow or the redraw is bigger than usual. detectChanges() redraws
 * synchronously, so the element is there when `action` runs.
 */
export function renderThen(cdr: ChangeDetectorRef, isDestroyed: () => boolean, action: () => unknown): void {
  if (isDestroyed()) {
    return;
  }
  cdr.detectChanges();
  action();
}
