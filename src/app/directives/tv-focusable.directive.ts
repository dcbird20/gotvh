import { Directive, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { FocusableItem, SpatialNavService } from '../services/spatial-nav.service';


@Directive({
  selector: '[tvFocusable]',
  standalone: true,
})
export class TvFocusableDirective implements FocusableItem, OnInit, OnDestroy {
  readonly id: number;
  private readonly longPressDurationMs = 650;
  private selectKeyActive = false;
  private longPressTriggered = false;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private el: ElementRef<HTMLElement>,
    private nav: SpatialNavService
  ) {
    this.id = this.nav.allocateId();
  }

  ngOnInit(): void {
    this.nav.register(this);
    const el = this.el.nativeElement;
    if (!el.getAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
    }
    el.addEventListener('focus', this.onNativeFocus);
    el.addEventListener('blur', this.onNativeBlur);
    el.addEventListener('keydown', this.onKeydown);
    el.addEventListener('keyup', this.onKeyup);
  }

  ngOnDestroy(): void {
    this.nav.unregister(this);
    this.el.nativeElement.removeEventListener('focus', this.onNativeFocus);
    this.el.nativeElement.removeEventListener('blur', this.onNativeBlur);
    this.el.nativeElement.removeEventListener('keydown', this.onKeydown);
    this.el.nativeElement.removeEventListener('keyup', this.onKeyup);
    this.resetSelectPressState();
  }

  private onNativeFocus = (): void => {
    this.nav.setFocus(this);
  };

  private onNativeBlur = (): void => {
    this.resetSelectPressState();
  };

  private onKeydown = (event: KeyboardEvent): void => {
    if (this.isEditableElement()) {
      return;
    }

    if (!this.nav.isSelectKey(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (this.selectKeyActive) {
      return;
    }

    this.selectKeyActive = true;
    this.longPressTriggered = false;
    this.clearLongPressTimer();
    this.longPressTimer = setTimeout(() => {
      if (!this.selectKeyActive) {
        return;
      }

      this.longPressTriggered = true;
      this.triggerLongPress();
    }, this.longPressDurationMs);
  };

  private onKeyup = (event: KeyboardEvent): void => {
    if (this.isEditableElement()) {
      return;
    }

    if (!this.nav.isSelectKey(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!this.selectKeyActive) {
      return;
    }

    const shouldTriggerSelect = !this.longPressTriggered;
    this.resetSelectPressState();

    if (shouldTriggerSelect) {
      this.triggerSelect();
    }
  };

  getElement(): HTMLElement {
    return this.el.nativeElement;
  }

  getRect(): DOMRect {
    return this.el.nativeElement.getBoundingClientRect();
  }

  focus(): void {
    const element = this.el.nativeElement;
    element.classList.add('tv-focused');
    const activeElement = document.activeElement as HTMLElement | null;
    const alreadyFocused = activeElement === element || !!activeElement && element.contains(activeElement);
    if (!alreadyFocused) {
      element.focus({ preventScroll: true });
    }
    this.scrollNearestContainerIntoView(element);
  }

  blur(): void {
    this.el.nativeElement.classList.remove('tv-focused');
  }

  triggerSelect(): void {
    this.el.nativeElement.click();
  }

  private triggerLongPress(): void {
    const event = new CustomEvent('tv-long-press', {
      bubbles: true,
      cancelable: true,
      detail: {
        source: 'ok',
        durationMs: this.longPressDurationMs,
      },
    });
    this.el.nativeElement.dispatchEvent(event);
  }

  private resetSelectPressState(): void {
    this.selectKeyActive = false;
    this.longPressTriggered = false;
    this.clearLongPressTimer();
  }

  private clearLongPressTimer(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private isEditableElement(): boolean {
    const element = this.el.nativeElement;
    const tagName = element.tagName;

    if (tagName === 'TEXTAREA' || element.isContentEditable) {
      return true;
    }

    if (tagName !== 'INPUT') {
      return false;
    }

    const input = element as HTMLInputElement;
    const inputType = String(input.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType);
  }

  private scrollNearestContainerIntoView(element: HTMLElement): void {
    const container = this.resolveScrollContainer(element);
    if (!container) {
      element.scrollIntoView({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest'
      });
      return;
    }

    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const computedStyle = getComputedStyle(element);
    const scrollMarginTop = parseFloat(computedStyle.scrollMarginTop || '0') || 0;
    const scrollMarginBottom = parseFloat(computedStyle.scrollMarginBottom || '0') || 0;
    const scrollMarginLeft = parseFloat(computedStyle.scrollMarginLeft || '0') || 0;
    const scrollMarginRight = parseFloat(computedStyle.scrollMarginRight || '0') || 0;

    let nextTop = container.scrollTop;
    let nextLeft = container.scrollLeft;

    const visibleTop = containerRect.top + scrollMarginTop;
    const visibleBottom = containerRect.bottom - scrollMarginBottom;
    const visibleLeft = containerRect.left + scrollMarginLeft;
    const visibleRight = containerRect.right - scrollMarginRight;

    if (elementRect.top < visibleTop) {
      nextTop -= visibleTop - elementRect.top;
    } else if (elementRect.bottom > visibleBottom) {
      nextTop += elementRect.bottom - visibleBottom;
    }

    if (elementRect.left < visibleLeft) {
      nextLeft -= visibleLeft - elementRect.left;
    } else if (elementRect.right > visibleRight) {
      nextLeft += elementRect.right - visibleRight;
    }

    const clampedTop = Math.max(0, Math.min(nextTop, container.scrollHeight - container.clientHeight));
    const clampedLeft = Math.max(0, Math.min(nextLeft, container.scrollWidth - container.clientWidth));

    if (clampedTop !== container.scrollTop || clampedLeft !== container.scrollLeft) {
      container.scrollTo({
        top: clampedTop,
        left: clampedLeft,
        behavior: 'auto'
      });
    }
  }

  private resolveScrollContainer(element: HTMLElement): HTMLElement | null {
    let fallbackMarkedContainer: HTMLElement | null = null;
    let fallbackScrollableContainer: HTMLElement | null = null;
    let current: HTMLElement | null = element;

    while (current) {
      const isMarkedContainer = current.getAttribute('data-tv-scroll-container') === 'true';
      const isScrollableContainer = this.isScrollable(current);

      if (isMarkedContainer && isScrollableContainer) {
        return current;
      }

      if (!fallbackScrollableContainer && isScrollableContainer) {
        fallbackScrollableContainer = current;
      }

      if (!fallbackMarkedContainer && isMarkedContainer) {
        fallbackMarkedContainer = current;
      }

      current = current.parentElement;
    }

    return fallbackScrollableContainer || fallbackMarkedContainer;
  }

  private isScrollable(element: HTMLElement): boolean {
    const computedStyle = getComputedStyle(element);
    const overflowY = computedStyle.overflowY;
    const overflowX = computedStyle.overflowX;
    const canScrollY = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
      && element.scrollHeight > element.clientHeight + 1;
    const canScrollX = (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay')
      && element.scrollWidth > element.clientWidth + 1;

    return canScrollY || canScrollX;
  }
}
