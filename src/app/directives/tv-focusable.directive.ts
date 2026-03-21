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
  }

  ngOnDestroy(): void {
    this.nav.unregister(this);
    this.el.nativeElement.removeEventListener('mouseenter', this.onMouseEnter);
    this.el.nativeElement.removeEventListener('focus', this.onNativeFocus);
  }

  private onMouseEnter = (): void => {
    this.nav.setFocus(this);
  };

  private onNativeFocus = (): void => {
    this.nav.setFocus(this);
  };

  getRect(): DOMRect {
    return this.el.nativeElement.getBoundingClientRect();
  }

  focus(): void {
    this.el.nativeElement.classList.add('tv-focused');
    this.el.nativeElement.focus({ preventScroll: true });
    this.el.nativeElement.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  }

  blur(): void {
    this.el.nativeElement.classList.remove('tv-focused');
  }

  triggerSelect(): void {
    this.el.nativeElement.click();
  }
}
