import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { ReactiveFormsModule } from '@angular/forms';
import { Router, RouterOutlet } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { TvFocusableDirective } from './directives/tv-focusable.directive';
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
  imports: [CommonModule, ReactiveFormsModule, RouterOutlet, TvFocusableDirective],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('authUsernameInput') authUsernameInput?: ElementRef<HTMLInputElement>;
  @ViewChild('authPasswordInput') authPasswordInput?: ElementRef<HTMLInputElement>;
  @ViewChild('authCancelButton') authCancelButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('authContinueButton') authContinueButton?: ElementRef<HTMLButtonElement>;

  sidebarExpanded = false;
  authDialogState: TvheadendAuthDialogState = { open: false, reason: '' };
  authState: TvheadendAuthState = { authenticated: false, username: '' };
  authError = '';

  readonly authForm = this.formBuilder.nonNullable.group({
    username: ['', Validators.required],
    password: ['', Validators.required]
  });

  private destroy$ = new Subject<void>();

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
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const key = event.key;

    const active = document.activeElement as HTMLElement | null;
    const isTypingTarget = !!active && (
      active.tagName === 'INPUT'
      || active.tagName === 'TEXTAREA'
      || active.isContentEditable
    );

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
      || key === 'Enter';

    if (isTypingTarget && !isNavKey) {
      return;
    }

    const consumed = this.spatialNav.handleKeydown(event);
    if (consumed) {
      event.preventDefault();
    }
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
