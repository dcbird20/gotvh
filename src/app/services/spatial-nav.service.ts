import { Injectable } from '@angular/core';

export interface FocusableItem {
  id: number;
  getElement(): HTMLElement;
  getRect(): DOMRect;
  focus(): void;
  blur(): void;
  triggerSelect(): void;
}

@Injectable({ providedIn: 'root' })
export class SpatialNavService {
  private items: FocusableItem[] = [];
  private currentItem: FocusableItem | null = null;
  private lastScopeElement: HTMLElement | null = null;
  private nextId = 1;
  private readonly directionDeadZonePx = 4;

  allocateId(): number {
    return this.nextId++;
  }

  register(item: FocusableItem): void {
    this.items.push(item);
  }

  unregister(item: FocusableItem): void {
    const idx = this.items.indexOf(item);
    if (idx >= 0) {
      this.items.splice(idx, 1);
    }
    if (this.currentItem === item) {
      this.currentItem = null;
    }
  }

  setFocus(item: FocusableItem): void {
    if (this.currentItem && this.currentItem !== item) {
      this.currentItem.blur();
    }
    this.currentItem = item;
    this.lastScopeElement = this.getNavigationScopeElement(item.getElement());
    item.focus();
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (this.isDirectionalKey(event, 'up')) {
      return this.move('up');
    }

    if (this.isDirectionalKey(event, 'down')) {
      return this.move('down');
    }

    if (this.isDirectionalKey(event, 'left')) {
      return this.move('left');
    }

    if (this.isDirectionalKey(event, 'right')) {
      return this.move('right');
    }

    if (this.isSelectKey(event)) {
      if (this.currentItem) {
        this.currentItem.triggerSelect();
        return true;
      }
      return false;
    }

    return false;
  }

  isSelectKey(event: KeyboardEvent): boolean {
    const key = String(event.key || '');
    const code = String((event as any).code || '');
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);
    const looksLikePrintableKeyboardInput = (key.length === 1 && key !== ' ')
      || code.startsWith('Key')
      || code.startsWith('Digit');

    return key === 'Enter'
      || key === 'BrowserSelect'
      || key === 'NumpadEnter'
      || key === 'Select'
      || key === 'OK'
      || key === ' '
      || key === 'Spacebar'
      || code === 'BrowserSelect'
      || code === 'Enter'
      || code === 'NumpadEnter'
      || code === 'Space'
      || keyCode === 13
      || keyCode === 23
      || keyCode === 32
        || (keyCode === 66 && !looksLikePrintableKeyboardInput)
      || keyCode === 160;
  }

  isDirectionalKey(event: KeyboardEvent, direction: 'up' | 'down' | 'left' | 'right'): boolean {
    const key = String(event.key || '');
    const code = String((event as any).code || '');
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);

    if (direction === 'up') {
      return key === 'ArrowUp' || code === 'ArrowUp' || keyCode === 19 || keyCode === 38;
    }

    if (direction === 'down') {
      return key === 'ArrowDown' || code === 'ArrowDown' || keyCode === 20 || keyCode === 40;
    }

    if (direction === 'left') {
      return key === 'ArrowLeft' || code === 'ArrowLeft' || keyCode === 21 || keyCode === 37;
    }

    return key === 'ArrowRight' || code === 'ArrowRight' || keyCode === 22 || keyCode === 39;
  }

  private move(dir: 'up' | 'down' | 'left' | 'right'): boolean {
    const currentItem = this.resolveCurrentItem();

    if (!currentItem) {
      const activeElement = document.activeElement as HTMLElement | null;
      const preferredScopeElement = this.getNavigationScopeElement(activeElement) || this.lastScopeElement;
      const firstVisibleItem = this.findInitialCandidate(dir, preferredScopeElement) || this.items.find(item => this.isItemVisible(item));
      if (firstVisibleItem) {
        this.setFocus(firstVisibleItem);
        return true;
      }
      return false;
    }

    let fromRect: DOMRect;
    try {
      fromRect = currentItem.getRect();
    } catch {
      return false;
    }

    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;
    const currentElement = currentItem.getElement();
    const currentScopeElement = this.getNavigationScopeElement(currentElement);
    const navigationMode = currentScopeElement?.getAttribute('data-tv-nav-mode') || '';

    if ((dir === 'up' || dir === 'down') && navigationMode === 'linear-vertical') {
      const linearTarget = this.findLinearVerticalCandidate(currentScopeElement, dir);
      if (linearTarget) {
        this.setFocus(linearTarget);
        return true;
      }
      return false;
    }

    const currentScope = this.getNavigationScope(currentElement);
    const scopeLocked = dir === 'up' || dir === 'down';
    const bestInScope = this.findBestCandidate(dir, fromRect, fromCx, fromCy, currentScope, currentItem);
    const best = bestInScope || (scopeLocked ? null : this.findBestCandidate(dir, fromRect, fromCx, fromCy, null, currentItem));

    if (best) {
      this.setFocus(best);
      return true;
    }

    return false;
  }

  private isCandidateInDirection(dir: 'up' | 'down' | 'left' | 'right', dx: number, dy: number): boolean {
    if (dir === 'up') {
      return dy < -this.directionDeadZonePx;
    }

    if (dir === 'down') {
      return dy > this.directionDeadZonePx;
    }

    if (dir === 'left') {
      return dx < -this.directionDeadZonePx;
    }

    return dx > this.directionDeadZonePx;
  }

  private scoreCandidate(
    dir: 'up' | 'down' | 'left' | 'right',
    fromRect: DOMRect,
    rect: DOMRect,
    dx: number,
    dy: number
  ): number {
    const isVertical = dir === 'up' || dir === 'down';
    const primary = isVertical ? Math.abs(dy) : Math.abs(dx);
    const secondary = isVertical ? Math.abs(dx) : Math.abs(dy);
    const overlap = isVertical
      ? this.getAxisOverlap(fromRect.left, fromRect.right, rect.left, rect.right)
      : this.getAxisOverlap(fromRect.top, fromRect.bottom, rect.top, rect.bottom);
    const overlapRatio = isVertical
      ? overlap / Math.max(1, Math.min(fromRect.width, rect.width))
      : overlap / Math.max(1, Math.min(fromRect.height, rect.height));

    // Strongly prefer staying in the same vertical or horizontal lane.
    let score = primary;

    if (overlapRatio >= 0.6) {
      score += secondary * 0.35;
    } else if (overlapRatio >= 0.2) {
      score += secondary * 1.5;
    } else {
      score += secondary * 5;
    }

    // Penalize diagonal jumps harder for vertical navigation, which is the main TV pain point.
    if (isVertical && secondary > Math.max(fromRect.width, rect.width) * 0.9) {
      score += 400;
    }

    if (!isVertical && secondary > Math.max(fromRect.height, rect.height) * 0.9) {
      score += 250;
    }

    return score;
  }

  private getAxisOverlap(startA: number, endA: number, startB: number, endB: number): number {
    return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
  }

  private findBestCandidate(
    dir: 'up' | 'down' | 'left' | 'right',
    fromRect: DOMRect,
    fromCx: number,
    fromCy: number,
    requiredScope: string | null,
    currentItem: FocusableItem
  ): FocusableItem | null {
    let best: FocusableItem | null = null;
    let bestScore = Infinity;

    for (const item of this.items) {
      if (item === currentItem) {
        continue;
      }

      if (requiredScope !== null && this.getNavigationScope(item.getElement()) !== requiredScope) {
        continue;
      }

      let rect: DOMRect;
      try {
        rect = item.getRect();
      } catch {
        continue;
      }

      if (rect.width === 0 && rect.height === 0) {
        continue;
      }

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = cx - fromCx;
      const dy = cy - fromCy;

      if (!this.isCandidateInDirection(dir, dx, dy)) {
        continue;
      }

      const score = this.scoreCandidate(dir, fromRect, rect, dx, dy);
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return best;
  }

  private getNavigationScope(element: HTMLElement | null): string | null {
    return element?.closest('[data-tv-nav-scope]')?.getAttribute('data-tv-nav-scope') || null;
  }

  private getNavigationScopeElement(element: HTMLElement | null): HTMLElement | null {
    return element?.closest('[data-tv-nav-scope]') as HTMLElement | null;
  }

  private findInitialCandidate(
    dir: 'up' | 'down' | 'left' | 'right',
    scopeElement: HTMLElement | null
  ): FocusableItem | null {
    if (!scopeElement) {
      return null;
    }

    const scopedItems = this.getOrderedScopedItems(scopeElement);
    if (!scopedItems.length) {
      return null;
    }

    if (dir === 'up' || dir === 'left') {
      return scopedItems[scopedItems.length - 1] || null;
    }

    return scopedItems[0] || null;
  }

  private getOrderedScopedItems(scopeElement: HTMLElement): FocusableItem[] {
    const scopedItems = this.items
      .filter(item => this.getNavigationScopeElement(item.getElement()) === scopeElement)
      .filter(item => {
        try {
          const rect = item.getRect();
          return rect.width > 0 || rect.height > 0;
        } catch {
          return false;
        }
      })
      .sort((left, right) => {
        const position = left.getElement().compareDocumentPosition(right.getElement());
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
          return -1;
        }
        if (position & Node.DOCUMENT_POSITION_PRECEDING) {
          return 1;
        }
        return 0;
      });

    const navigationMode = scopeElement.getAttribute('data-tv-nav-mode') || '';
    if (navigationMode !== 'linear-vertical') {
      return scopedItems;
    }

    const anchorItems = scopedItems.filter(item => item.getElement().getAttribute('data-tv-linear-anchor') === 'true');
    return anchorItems.length > 0 ? anchorItems : scopedItems;
  }

  private findLinearVerticalCandidate(scopeElement: HTMLElement | null, dir: 'up' | 'down'): FocusableItem | null {
    const currentItem = this.resolveCurrentItem();
    if (!scopeElement || !currentItem) {
      return null;
    }

    const orderedItems = this.getOrderedScopedItems(scopeElement);

    const currentIndex = orderedItems.indexOf(currentItem);
    if (currentIndex >= 0) {
      const nextIndex = dir === 'down' ? currentIndex + 1 : currentIndex - 1;
      if (nextIndex < 0 || nextIndex >= orderedItems.length) {
        return null;
      }

      return orderedItems[nextIndex];
    }

    let currentRect: DOMRect;
    try {
      currentRect = currentItem.getRect();
    } catch {
      return null;
    }

    const currentCenterY = currentRect.top + currentRect.height / 2;
    const directionalCandidates = orderedItems
      .map(item => {
        try {
          const rect = item.getRect();
          return {
            item,
            centerY: rect.top + rect.height / 2,
          };
        } catch {
          return null;
        }
      })
      .filter((candidate): candidate is { item: FocusableItem; centerY: number } => candidate !== null)
      .filter(candidate => dir === 'down'
        ? candidate.centerY > currentCenterY + this.directionDeadZonePx
        : candidate.centerY < currentCenterY - this.directionDeadZonePx)
      .sort((left, right) => dir === 'down' ? left.centerY - right.centerY : right.centerY - left.centerY);

    return directionalCandidates[0]?.item || null;
  }

  private resolveCurrentItem(): FocusableItem | null {
    const activeElement = document.activeElement as HTMLElement | null;

    if (this.currentItem && this.isFocusableItemCurrent(this.currentItem, activeElement)) {
      return this.currentItem;
    }

    const matchedItem = this.items.find(item => this.matchesActiveElement(item, activeElement) && this.isItemVisible(item)) || null;
    if (matchedItem) {
      if (this.currentItem && this.currentItem !== matchedItem) {
        this.currentItem.blur();
      }
      this.currentItem = matchedItem;
      return matchedItem;
    }

    if (this.currentItem) {
      this.currentItem.blur();
      if (!this.isItemVisible(this.currentItem)) {
        this.currentItem = null;
      } else {
        this.currentItem = null;
      }
    }

    return null;
  }

  private isFocusableItemCurrent(item: FocusableItem, activeElement: HTMLElement | null): boolean {
    return this.matchesActiveElement(item, activeElement) && this.isItemVisible(item);
  }

  private matchesActiveElement(item: FocusableItem, activeElement: HTMLElement | null): boolean {
    const element = item.getElement();
    return !!activeElement && (activeElement === element || element.contains(activeElement));
  }

  private isItemVisible(item: FocusableItem): boolean {
    try {
      const element = item.getElement();
      const rect = item.getRect();
      return document.contains(element) && (rect.width > 0 || rect.height > 0);
    } catch {
      return false;
    }
  }
}
