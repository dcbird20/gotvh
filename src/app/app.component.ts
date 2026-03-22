import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { TvFocusableDirective } from './directives/tv-focusable.directive';
import { RemoteKeyDebugService } from './services/remote-key-debug.service';
import { ReturnNavigationService } from './services/return-navigation.service';
import { SpatialNavService } from './services/spatial-nav.service';
import { TvheadendService, TvheadendAuthDialogState, TvheadendAuthState } from './services/tvheadend.service';

interface NavItem {
  icon: string;
  label: string;
  route: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterOutlet, RouterLink, RouterLinkActive, TvFocusableDirective],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('authUsernameInput') authUsernameInput?: ElementRef<HTMLInputElement>;
  @ViewChild('authPasswordInput') authPasswordInput?: ElementRef<HTMLInputElement>;
  @ViewChild('authCancelButton') authCancelButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('authContinueButton') authContinueButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('shellContent') shellContent?: ElementRef<HTMLElement>;

  sidebarExpanded = false;
  authDialogState: TvheadendAuthDialogState = { open: false, reason: '' };
  authState: TvheadendAuthState = { authenticated: false, username: '' };
  authError = '';

  readonly authForm = this.formBuilder.nonNullable.group({
    username: ['', Validators.required],
    password: ['', Validators.required]
  });

  private destroy$ = new Subject<void>();
  private readonly nativeReturnHandler = (event: Event) => {
    const detail = (event as CustomEvent<{ returnTo?: string; returnToken?: string; returnChannelId?: string }>).detail || {};
    const returnTo = String(detail.returnTo || '').trim();
    let returnToken = String(detail.returnToken || '').trim();
    const returnChannelId = String(detail.returnChannelId || '').trim();

    if (!returnTo.startsWith('/')) {
      return;
    }

    if (returnTo === '/guide' && returnChannelId) {
      returnToken = this.returnNavigation.createToken({
        source: 'epg',
        payload: {
          playableChannelUuid: returnChannelId
        }
      });
    }

    try {
      const returnTree = this.router.parseUrl(returnTo);
      if (returnToken) {
        returnTree.queryParams = {
          ...returnTree.queryParams,
          returnToken
        };
      }
      void this.router.navigateByUrl(this.router.serializeUrl(returnTree));
    } catch {
      // Ignore malformed native return targets.
    }
  };

  navItems: NavItem[] = [
    { icon: '🏠', label: 'Home',       route: '/home'       },
    { icon: '📺', label: 'Channels',   route: '/channels'   },
    { icon: '📋', label: 'Guide',      route: '/guide'      },
    { icon: '⏺',  label: 'Recordings', route: '/recordings' },
    { icon: '🔁', label: 'Auto-Rec',   route: '/autorec'    },
    { icon: '📊', label: 'Status',     route: '/status'     },
  ];

  constructor(
    public router: Router,
    private spatialNav: SpatialNavService,
    private remoteKeyDebug: RemoteKeyDebugService,
    private returnNavigation: ReturnNavigationService,
    private tvh: TvheadendService,
    private formBuilder: FormBuilder
  ) {
    this.tvh.authDialogState$
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.authDialogState = state;
        if (state.open) {
          this.authError = '';
          const hasStoredAuth = this.tvh.hasStoredAuth();
          this.authForm.reset({
            username: '',
            password: ''
          });
          if (hasStoredAuth) {
            this.authError = 'Stored credentials are available. Submit new credentials only if playback still fails.';
          }

          // Ensure TV users can type immediately when the dialog opens.
          setTimeout(() => {
            this.authUsernameInput?.nativeElement.focus();
          }, 0);
        }
      });

    this.tvh.authState$
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.authState = state;
      });
  }

  ngOnInit(): void {
    // Install a history guard so remote back events trigger in-app handling
    // instead of exiting the Android WebView activity.
    this.pushBackGuardState();
    this.tvh.preloadGuideData();
    if (typeof window !== 'undefined') {
      window.addEventListener('gotvh-native-return', this.nativeReturnHandler as EventListener);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const key = event.key;
    this.remoteKeyDebug.captureEvent(event, 'app-shell', this.router.url.split('?')[0] || '/');

    const active = document.activeElement as HTMLElement | null;
    const isTypingTarget = !!active && (
      active.tagName === 'INPUT'
      || active.tagName === 'TEXTAREA'
      || active.isContentEditable
    );
    const isTextEntryInput = !!active && active.tagName === 'INPUT' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes((active as HTMLInputElement).type || 'text');
    const isTextEntryTarget = !!active && (isTextEntryInput || active.tagName === 'TEXTAREA' || active.isContentEditable);

    if (key === 'BrowserBack' || key === 'GoBack' || (!isTypingTarget && key === 'Backspace')) {
      event.preventDefault();
      this.handleBackAction();
      return;
    }

    if (this.authDialogState.open && this.handleAuthDialogNavigation(event)) {
      event.preventDefault();
      return;
    }

    if (
      this.authDialogState.open
      && (key === 'Escape' || key === 'BrowserBack' || key === 'GoBack')
    ) {
      event.preventDefault();
      this.cancelAuth();
      return;
    }

    // Keep normal typing behavior inside form fields, but allow TV navigation keys.
    const isNavKey = key === 'ArrowUp'
      || key === 'ArrowDown'
      || key === 'ArrowLeft'
      || key === 'ArrowRight'
      || key === 'Enter'
      || key === 'BrowserSelect'
      || key === 'NumpadEnter'
      || key === 'Select'
      || key === 'OK'
      || key === ' '
      || key === 'Spacebar';

    const isSpaceKey = key === ' ' || key === 'Spacebar' || String((event as any).code || '') === 'Space';

    if (isTextEntryTarget && isSpaceKey) {
      return;
    }

    if (isTypingTarget && !isNavKey) {
      return;
    }

    if (this.handleStatusPageDirectionalBridge(event, active)) {
      event.preventDefault();
      return;
    }

    if (this.handleGuideChannelPageBridge(event, active)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.shouldDeferDirectionalNavigation(event, active)) {
      return;
    }

    const consumed = this.spatialNav.handleKeydown(event);
    if (consumed) {
      event.preventDefault();
      return;
    }

    if (this.handleTvScrollFallback(event)) {
      event.preventDefault();
    }
  }

  private handleTvScrollFallback(event: KeyboardEvent): boolean {
    const key = String(event.key || '');
    const code = String((event as any).code || '');
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);
    const direction = this.resolveScrollDirection(key, code, keyCode);
    if (!direction) {
      return false;
    }

    const activeElement = document.activeElement as HTMLElement | null;
    const container = this.resolveActiveScrollContainer(activeElement);
    if (!container) {
      return false;
    }

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScrollTop <= 0) {
      return false;
    }

    const scrollAmount = Math.max(120, Math.round(container.clientHeight * 0.45));
    const previousTop = container.scrollTop;
    const nextTop = direction === 'down'
      ? Math.min(maxScrollTop, previousTop + scrollAmount)
      : Math.max(0, previousTop - scrollAmount);

    if (nextTop === previousTop) {
      return false;
    }

    container.scrollTo({
      top: nextTop,
      behavior: 'smooth'
    });
    return true;
  }

  private resolveActiveScrollContainer(activeElement: HTMLElement | null): HTMLElement | null {
    let fallbackMarkedContainer: HTMLElement | null = null;
    let fallbackScrollableContainer: HTMLElement | null = null;
    let current: HTMLElement | null = activeElement;

    while (current) {
      const isMarkedContainer = current.getAttribute('data-tv-scroll-container') === 'true';
      const isScrollableContainer = this.isScrollableContainer(current);

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

    return fallbackScrollableContainer || fallbackMarkedContainer || this.shellContent?.nativeElement || null;
  }

  private isScrollableContainer(element: HTMLElement): boolean {
    const computedStyle = getComputedStyle(element);
    const overflowY = computedStyle.overflowY;
    const overflowX = computedStyle.overflowX;
    const canScrollY = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
      && element.scrollHeight > element.clientHeight + 1;
    const canScrollX = (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay')
      && element.scrollWidth > element.clientWidth + 1;

    return canScrollY || canScrollX;
  }

  private resolveScrollDirection(key: string, code: string, keyCode: number): 'up' | 'down' | null {
    if (key === 'ArrowDown' || code === 'ArrowDown' || keyCode === 20 || keyCode === 40) {
      return 'down';
    }

    if (key === 'ArrowUp' || code === 'ArrowUp' || keyCode === 19 || keyCode === 38) {
      return 'up';
    }

    return null;
  }

  private shouldDeferDirectionalNavigation(event: KeyboardEvent, activeElement: HTMLElement | null): boolean {
    const key = String(event.key || '');
    const isDirectional = key === 'ArrowUp'
      || key === 'ArrowDown'
      || key === 'ArrowLeft'
      || key === 'ArrowRight';

    if (!isDirectional) {
      return false;
    }

    return activeElement?.closest('[data-tv-nav-scope="epg-page"]') != null;
  }

  private handleGuideChannelPageBridge(event: KeyboardEvent, activeElement: HTMLElement | null): boolean {
    const currentPath = this.router.url.split('?')[0] || '';
    if (currentPath !== '/guide') {
      return false;
    }

    const direction = this.getChannelPageDirection(event);
    if (!direction) {
      return false;
    }

    const target = activeElement || document.body || document.documentElement;
    const pageKey = direction > 0 ? 'PageDown' : 'PageUp';
    const pageKeyCode = direction > 0 ? 34 : 33;
    const syntheticEvent = new KeyboardEvent('keydown', {
      key: pageKey,
      code: pageKey,
      bubbles: true,
      cancelable: true
    });

    Object.defineProperty(syntheticEvent, 'keyCode', { value: pageKeyCode });
    Object.defineProperty(syntheticEvent, 'which', { value: pageKeyCode });

    target.dispatchEvent(syntheticEvent);
    return true;
  }

  private getChannelPageDirection(event: KeyboardEvent): -1 | 1 | null {
    const key = String(event.key || '').trim();
    const code = String((event as any).code || '').trim();
    const keyCode = Number((event as any).keyCode || (event as any).which || 0);
    const isBareChannelUp = keyCode === 33 && !key && !code;
    const isBareChannelDown = keyCode === 34 && !key && !code;

    if (
      key === 'ChannelUp'
      || key === 'MediaChannelUp'
      || code === 'ChannelUp'
      || code === 'MediaChannelUp'
      || isBareChannelUp
      || keyCode === 92
      || keyCode === 166
      || keyCode === 427
    ) {
      return -1;
    }

    if (
      key === 'ChannelDown'
      || key === 'MediaChannelDown'
      || code === 'ChannelDown'
      || code === 'MediaChannelDown'
      || isBareChannelDown
      || keyCode === 93
      || keyCode === 167
      || keyCode === 428
    ) {
      return 1;
    }

    return null;
  }

  private handleStatusPageDirectionalBridge(event: KeyboardEvent, activeElement: HTMLElement | null): boolean {
    const currentPath = this.router.url.split('?')[0] || '';
    const statusScope = document.querySelector('[data-tv-nav-scope="status-page"]') as HTMLElement | null;
    if (currentPath !== '/status' || !statusScope) {
      return false;
    }

    const isManagedStatusTarget = !!activeElement?.closest('[data-status-refresh], [data-status-anchor]');
    const hasLostStatusFocus = !activeElement
      || activeElement === document.body
      || activeElement === document.documentElement
      || !isManagedStatusTarget;

    if (this.isDirectionalKey(event, 'down') && hasLostStatusFocus) {
      const target = document.querySelector('.tv-focused[data-status-anchor], [data-status-first-anchor="true"], [data-status-anchor], [data-status-refresh]') as HTMLElement | null;
      if (!target) {
        return false;
      }

      target.focus();
      return true;
    }

    if (this.isDirectionalKey(event, 'up') && hasLostStatusFocus) {
      const refreshButton = document.querySelector('[data-status-refresh]') as HTMLElement | null;
      if (!refreshButton) {
        return false;
      }

      refreshButton.focus();
      return true;
    }

    return false;
  }

  private isDirectionalKey(event: KeyboardEvent, direction: 'up' | 'down' | 'left' | 'right'): boolean {
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

  private handleAuthDialogNavigation(event: KeyboardEvent): boolean {
    const key = event.key;
    const active = document.activeElement as HTMLElement | null;
    if (!active) {
      return false;
    }

    const username = this.authUsernameInput?.nativeElement;
    const password = this.authPasswordInput?.nativeElement;
    const cancel = this.authCancelButton?.nativeElement;
    const submit = this.authContinueButton?.nativeElement;

    const order = [username, password, cancel, submit].filter(Boolean) as HTMLElement[];
    if (order.length === 0) {
      return false;
    }

    const index = order.indexOf(active);
    if (index < 0) {
      return false;
    }

    if (key === 'ArrowDown') {
      const next = order[Math.min(order.length - 1, index + 1)];
      next.focus();
      return true;
    }

    if (key === 'ArrowUp') {
      const prev = order[Math.max(0, index - 1)];
      prev.focus();
      return true;
    }

    if (key === 'ArrowRight' && (active === cancel || active === username)) {
      if (active === cancel && submit) {
        submit.focus();
        return true;
      }
      if (active === username && password) {
        password.focus();
        return true;
      }
    }

    if (key === 'ArrowLeft' && (active === submit || active === password)) {
      if (active === submit && cancel) {
        cancel.focus();
        return true;
      }
      if (active === password && username) {
        username.focus();
        return true;
      }
    }

    if (key === 'Enter' || key === 'NumpadEnter') {
      if (active === cancel) {
        this.cancelAuth();
        return true;
      }

      if (active === submit) {
        submit.click();
        return true;
      }

      if (active === username && password) {
        password.focus();
        return true;
      }

      if (active === password) {
        submit?.click();
        return true;
      }
    }

    return false;
  }

  navigate(route: string): void {
    this.router.navigate([route]);
    this.sidebarExpanded = false;
  }

  isActive(route: string): boolean {
    return this.router.url.startsWith(route);
  }

  openAuthDialog(): void {
    this.tvh.openAuthDialog('Enter your TVHeadend credentials for live TV and protected API requests.');
  }

  submitAuth(): void {
    if (this.authForm.invalid) {
      this.authForm.markAllAsTouched();
      this.authError = 'Username and password are required.';
      return;
    }

    const { username, password } = this.authForm.getRawValue();
    const saved = this.tvh.submitBasicAuth(username, password);
    if (!saved) {
      this.authError = 'Username and password are required.';
      return;
    }

    this.authError = '';
  }

  cancelAuth(): void {
    this.authError = '';
    this.tvh.cancelBasicAuthRequest();
  }

  resetAuth(): void {
    this.authError = '';
    this.tvh.clearAuth();
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('gotvh-native-return', this.nativeReturnHandler as EventListener);
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  @HostListener('window:popstate', ['$event'])
  onPopState(_event: PopStateEvent): void {
    this.handleBackAction();
    this.pushBackGuardState();
  }

  private pushBackGuardState(): void {
    try {
      window.history.pushState({ gotvhGuard: true }, '', window.location.href);
    } catch {
      // Ignore history API errors.
    }
  }

  private handleBackAction(): void {
    if (this.authDialogState.open) {
      this.cancelAuth();
      return;
    }

    const currentPath = this.router.url.split('?')[0] || '';
    if (currentPath.startsWith('/player/')) {
      try {
        const tree = this.router.parseUrl(this.router.url);
        const returnTo = String(tree.queryParams?.['returnTo'] || '').trim();
        const returnToken = String(tree.queryParams?.['returnToken'] || '').trim();
        if (returnTo.startsWith('/')) {
          const returnTree = this.router.parseUrl(returnTo);
          if (returnToken) {
            returnTree.queryParams = {
              ...returnTree.queryParams,
              returnToken
            };
          }
          this.router.navigateByUrl(this.router.serializeUrl(returnTree));
          return;
        }
      } catch {
        // Ignore parse issues and continue with fallback behavior.
      }
    }

    // Keep app alive: route toward Home instead of allowing platform exit.
    if (this.router.url !== '/home') {
      this.router.navigate(['/home']);
    }
  }
}
