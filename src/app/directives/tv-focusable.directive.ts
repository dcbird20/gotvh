import { Directive, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { FocusableItem, SpatialNavService } from '../services/spatial-nav.service';


@Directive({
  selector: '[tvFocusable]',
  standalone: true,
})
export class TvFocusableDirective implements FocusableItem, OnInit, OnDestroy {
  readonly id: number;

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
    el.addEventListener('mouseenter', this.onMouseEnter);
    el.addEventListener('focus', this.onNativeFocus);
    el.addEventListener('keydown', this.onKeydown);
  }

  ngOnDestroy(): void {
    this.nav.unregister(this);
    this.el.nativeElement.removeEventListener('mouseenter', this.onMouseEnter);
    this.el.nativeElement.removeEventListener('focus', this.onNativeFocus);
    this.el.nativeElement.removeEventListener('keydown', this.onKeydown);
  }

  private onMouseEnter = (): void => {
    this.nav.setFocus(this);
  };

  private onNativeFocus = (): void => {
    this.nav.setFocus(this);
  };

  private onKeydown = (event: KeyboardEvent): void => {
    if (!this.nav.isSelectKey(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.triggerSelect();
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
    element.focus({ preventScroll: true });
    this.scrollNearestContainerIntoView(element);
  }

  blur(): void {
    this.el.nativeElement.classList.remove('tv-focused');
  }

  triggerSelect(): void {
    this.el.nativeElement.click();
  }

  private scrollNearestContainerIntoView(element: HTMLElement): void {
    const container = element.closest('[data-tv-scroll-container="true"]') as HTMLElement | null;
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
}
