import { Injectable } from '@angular/core';

export interface FocusableItem {
  id: number;
  getRect(): DOMRect;
  focus(): void;
  blur(): void;
  triggerSelect(): void;
}

@Injectable({ providedIn: 'root' })
export class SpatialNavService {
  private items: FocusableItem[] = [];
  private currentItem: FocusableItem | null = null;
  private nextId = 1;

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
    item.focus();
  }

  handleKeydown(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'ArrowUp':
        this.move('up');
        return true;
      case 'ArrowDown':
        this.move('down');
        return true;
      case 'ArrowLeft':
        this.move('left');
        return true;
      case 'ArrowRight':
        this.move('right');
        return true;
      case 'Enter':
      case ' ':
        if (this.currentItem) {
          this.currentItem.triggerSelect();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  private move(dir: 'up' | 'down' | 'left' | 'right'): boolean {
    if (!this.currentItem) {
      if (this.items.length) {
        this.setFocus(this.items[0]);
        return true;
      }
      return false;
    }

    let fromRect: DOMRect;
    try {
      fromRect = this.currentItem.getRect();
    } catch {
      return false;
    }

    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;

    let best: FocusableItem | null = null;
    let bestScore = Infinity;

    for (const item of this.items) {
      if (item === this.currentItem) continue;

      let rect: DOMRect;
      try {
        rect = item.getRect();
      } catch {
        continue;
      }

      // Skip zero-size elements (hidden / not rendered)
      if (rect.width === 0 && rect.height === 0) continue;

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = cx - fromCx;
      const dy = cy - fromCy;

      // Directional filter: element must be generally in the given direction
      const inDirection =
        (dir === 'up'    && dy < -4) ||
        (dir === 'down'  && dy >  4) ||
        (dir === 'left'  && dx < -4) ||
        (dir === 'right' && dx >  4);

      if (!inDirection) continue;

      // Score: primary axis distance, penalise off-axis deviation
      let primary: number;
      let secondary: number;
      if (dir === 'up' || dir === 'down') {
        primary   = Math.abs(dy);
        secondary = Math.abs(dx);
      } else {
        primary   = Math.abs(dx);
        secondary = Math.abs(dy);
      }

      // Weight heavily penalises off-axis elements
      const score = primary + secondary * 3;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }

    if (best) {
      this.setFocus(best);
      return true;
    }

    return false;
  }
}
