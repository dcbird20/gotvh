import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TvheadendService } from '@gotvh/tvh-api';
import { AdminNavItem, NAV_ITEMS } from './app.routes';

@Component({
  selector: 'admin-root',
  standalone: true,
  imports: [
    FormsModule, RouterOutlet, RouterLink, RouterLinkActive,
    MatSidenavModule, MatToolbarModule, MatListModule, MatIconModule,
    MatButtonModule, MatFormFieldModule, MatInputModule, MatTooltipModule,
  ],
  template: `
    <mat-sidenav-container class="shell">
      <mat-sidenav mode="side" opened class="nav">
        <div class="brand">
          <mat-icon>settings_remote</mat-icon>
          <span>GoTVH Admin</span>
        </div>
        @for (section of sections; track section) {
          <div class="section-label">{{ section }}</div>
          <mat-nav-list>
            @for (item of itemsIn(section); track item.path) {
              <a mat-list-item [routerLink]="item.path" routerLinkActive #rla="routerLinkActive" [activated]="rla.isActive">
                <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
                <span matListItemTitle>{{ item.label }}</span>
              </a>
            }
          </mat-nav-list>
        }
      </mat-sidenav>

      <mat-sidenav-content>
        <mat-toolbar class="topbar">
          <span class="spacer"></span>
          @if (auth().authenticated) {
            <span class="muted user"><mat-icon inline>person</mat-icon> {{ auth().username }}</span>
            <button mat-button (click)="signOut()">Sign out</button>
          } @else {
            <button mat-flat-button (click)="openSignIn()">Sign in</button>
          }
        </mat-toolbar>

        @if (signIn().open) {
          <form class="signin" (ngSubmit)="submitSignIn()" #f="ngForm">
            <h2>Sign in to Tvheadend</h2>
            <p class="muted">{{ signIn().reason }}</p>
            <mat-form-field appearance="outline">
              <mat-label>Username</mat-label>
              <input matInput name="username" [(ngModel)]="username" autocomplete="username" required cdkFocusInitial autofocus>
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Password</mat-label>
              <input matInput name="password" type="password" [(ngModel)]="password" autocomplete="current-password" required>
            </mat-form-field>
            <div class="actions">
              <button mat-button type="button" (click)="cancelSignIn()">Cancel</button>
              <button mat-flat-button type="submit" [disabled]="f.invalid">Sign in</button>
            </div>
          </form>
        } @else {
          <main><router-outlet /></main>
        }
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [`
    .shell { height: 100vh; }
    .nav { width: 248px; border-right: 1px solid var(--mat-sys-outline-variant); }
    .brand { display: flex; align-items: center; gap: 10px; padding: 18px 20px 8px; font: var(--mat-sys-title-medium); }
    .section-label { padding: 16px 20px 4px; font: var(--mat-sys-label-small); text-transform: uppercase;
                     letter-spacing: .06em; color: var(--mat-sys-on-surface-variant); }
    .topbar { background: transparent; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .spacer { flex: 1; }
    .user { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; font: var(--mat-sys-body-medium); }
    .signin { max-width: 360px; margin: 64px auto; display: flex; flex-direction: column; }
    .signin h2 { font: var(--mat-sys-title-large); margin: 0 0 4px; }
    .signin p { margin: 0 0 20px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class AdminAppComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sections: AdminNavItem['section'][] = ['Overview', 'DVR', 'Configuration'];
  readonly auth = signal(this.tvh.authState$.value);
  readonly signIn = signal(this.tvh.authDialogState$.value);

  username = '';
  password = '';

  ngOnInit(): void {
    this.tvh.authState$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(s => this.auth.set(s));
    this.tvh.authDialogState$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(s => this.signIn.set(s));
    if (!this.tvh.hasStoredAuth()) {
      this.tvh.openAuthDialog('Admin screens need a Tvheadend account.');
    }
  }

  itemsIn(section: AdminNavItem['section']): AdminNavItem[] {
    return NAV_ITEMS.filter(i => i.section === section);
  }

  openSignIn(): void {
    this.username = this.tvh.getStoredUsername();
    this.tvh.openAuthDialog('Admin screens need a Tvheadend account.');
  }

  submitSignIn(): void {
    if (this.tvh.submitBasicAuth(this.username, this.password)) {
      this.password = ''; // submitBasicAuth also closes the sign-in form
    }
  }

  cancelSignIn(): void {
    this.tvh.cancelBasicAuthRequest(); // also closes the sign-in form
  }

  signOut(): void {
    this.tvh.clearAuth();
  }
}
