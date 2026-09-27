import { Directive, ElementRef, OnDestroy, OnInit, Renderer2, inject } from '@angular/core';

const STORAGE_KEY = 'gotvh_admin_side_width';
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 360;
/** Space the table keeps when the panel is dragged wide. */
const MIN_MAIN = 380;
/** Sidebar + page padding, roughly — only used to cap the width. */
const CHROME = 300;

function readStored(): number | null {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v >= MIN_WIDTH ? v : null;
  } catch { return null; }
}

function store(width: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(Math.round(width))); } catch { /* storage unavailable */ }
}

function maxWidth(): number {
  return Math.max(MIN_WIDTH, window.innerWidth - CHROME - MIN_MAIN);
}

function clamp(width: number): number {
  return Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, width)));
}

/** Panel width shared by every screen, as a CSS variable the layouts use. */
function apply(width: number): void {
  document.documentElement.style.setProperty('--admin-side-width', `${clamp(width)}px`);
}

// Apply the remembered width once, before any page renders.
apply(readStored() ?? DEFAULT_WIDTH);

/**
 * Put on a `.layout` grid whose second column is a side panel (shown while the
 * host has `with-editor`). Adds a handle on the boundary: drag to resize,
 * click the button (or double-click the handle) to switch between the normal
 * width and a wide one. The width is remembered and shared by all screens.
 */
@Directive({
  selector: '[adminSplit]',
  standalone: true,
})
export class SplitHandleDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);
  private handle?: HTMLElement;
  private button?: HTMLButtonElement;
  private unlisten: Array<() => void> = [];
  /** Width before widening, to restore on the next toggle. */
  private static normalWidth = readStored() ?? DEFAULT_WIDTH;

  ngOnInit(): void {
    const host = this.host.nativeElement;
    if (getComputedStyle(host).position === 'static') this.renderer.setStyle(host, 'position', 'relative');

    const handle = this.renderer.createElement('div') as HTMLElement;
    handle.className = 'admin-split-handle';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize the side panel');
    handle.title = 'Drag to resize · double-click to widen or narrow';
    handle.tabIndex = 0;

    const grip = this.renderer.createElement('div') as HTMLElement;
    grip.className = 'admin-split-grip';
    const button = this.renderer.createElement('button') as HTMLButtonElement;
    button.type = 'button';
    button.className = 'admin-split-toggle';
    grip.appendChild(button);
    handle.appendChild(grip);
    host.appendChild(handle);
    this.handle = handle;
    this.button = button;
    this.updateButton();

    this.unlisten.push(
      this.renderer.listen(handle, 'pointerdown', (e: PointerEvent) => this.startDrag(e)),
      this.renderer.listen(handle, 'dblclick', () => this.toggleWide()),
      this.renderer.listen(button, 'click', (e: MouseEvent) => { e.stopPropagation(); this.toggleWide(); }),
      this.renderer.listen(button, 'pointerdown', (e: PointerEvent) => e.stopPropagation()),
      this.renderer.listen(handle, 'keydown', (e: KeyboardEvent) => this.onKey(e)),
      this.renderer.listen('window', 'resize', () => { apply(this.current()); this.updateButton(); }),
    );
  }

  ngOnDestroy(): void {
    this.unlisten.forEach(fn => fn());
    this.handle?.remove();
  }

  private current(): number {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--admin-side-width')) || DEFAULT_WIDTH;
  }

  private isWide(): boolean {
    return this.current() > SplitHandleDirective.normalWidth + 40 || this.current() >= maxWidth() - 4;
  }

  private setWidth(width: number, remember = true): void {
    apply(width);
    if (remember) store(clamp(width));
    this.updateButton();
  }

  private toggleWide(): void {
    if (this.isWide()) {
      this.setWidth(Math.min(SplitHandleDirective.normalWidth, DEFAULT_WIDTH + 120));
    } else {
      SplitHandleDirective.normalWidth = this.current();
      this.setWidth(Math.max(this.current() + 200, (window.innerWidth - CHROME) * 0.62));
    }
  }

  private startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = this.handle!;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('admin-resizing');
    const startX = event.clientX;
    const startWidth = this.current();
    const move = (e: PointerEvent) => this.setWidth(startWidth + (startX - e.clientX), false);
    const up = (e: PointerEvent) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      document.body.classList.remove('admin-resizing');
      store(this.current());
      if (!this.isWide()) SplitHandleDirective.normalWidth = this.current();
      this.updateButton();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  private onKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 80 : 20;
    if (event.key === 'ArrowLeft') { event.preventDefault(); this.setWidth(this.current() + step); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); this.setWidth(this.current() - step); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.toggleWide(); }
  }

  private updateButton(): void {
    if (!this.button) return;
    const wide = this.isWide();
    this.button.textContent = wide ? 'chevron_right' : 'chevron_left';
    this.button.title = wide ? 'Narrow the panel' : 'Widen the panel';
    this.button.setAttribute('aria-label', this.button.title);
  }
}
