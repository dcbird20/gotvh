import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TvheadendService } from '@gotvh/tvh-api';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { toDataURL } from 'qrcode';

interface Device { serial: string; name: string; kind: 'app' | 'computer'; paired: string; expires: string; }
interface Info { ready: boolean; tvHost: string; htspHost: string; port: number; }

/**
 * Devices allowed to watch away from home (docs/remote-access.md). Talks to the pairing service
 * (raven1, home network only) through this site's /pair/ path. Making codes, listing and removing
 * devices need a Tvheadend administrator sign-in.
 */
@Component({
  selector: 'admin-devices',
  standalone: true,
  imports: [DatePipe, FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressBarModule],
  template: `
    <div class="page">
      <h1>Devices</h1>
      <p class="subtitle">Phones, TVs and computers that may watch away from home. Each one is paired once, at home.</p>

      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

      @if (state() === 'missing') {
        <div class="card warn">
          <h2><mat-icon>cloud_off</mat-icon> Away-from-home access isn't set up</h2>
          <p>The pairing service on raven1 didn't answer. It's part of the <code>remote/</code> stack — see
             <code>docs/remote-access.md</code> in the GoTVH repository for the steps.</p>
          <p class="muted">Away from home this page can't pair either: pairing only works on the home network.</p>
        </div>
      }

      @if (state() === 'signin') {
        <div class="card">
          <h2><mat-icon>lock</mat-icon> Sign in as a Tvheadend administrator</h2>
          <form class="row" (ngSubmit)="signIn()">
            <mat-form-field appearance="outline"><mat-label>Username</mat-label><input matInput name="u" [(ngModel)]="user" autocomplete="username"></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Password</mat-label><input matInput name="p" type="password" [(ngModel)]="pass" autocomplete="current-password"></mat-form-field>
            <button mat-flat-button type="submit">Sign in</button>
          </form>
          @if (error()) { <p class="err">{{ error() }}</p> }
        </div>
      }

      @if (state() === 'ready') {
        @if (info(); as i) {
          @if (!i.ready) {
            <p class="err">The pairing service is running but doesn't know its away-from-home addresses (TV_HOST / HTSP_HOST in remote/.env).</p>
          } @else {
            <p class="muted">Away from home, devices connect to <strong>{{ i.tvHost }}</strong>.</p>
          }
        }

        <div class="card">
          <h2><mat-icon>add_link</mat-icon> Pair a device</h2>
          @if (code(); as c) {
            <div class="pairing">
              @if (qr(); as q) {
                <div class="qr-side">
                  <img [src]="q" alt="Pairing QR code" width="184" height="184">
                  <span class="muted small">Phone: Scan QR code</span>
                </div>
              }
              <div>
                <p>On the TV or phone: <strong>Settings → Away from home</strong>, then enter</p>
                <p class="code">{{ c.slice(0, 4) }} {{ c.slice(4) }}</p>
              </div>
            </div>
            <p class="muted">Works once, for {{ minutesLeft() }} more {{ minutesLeft() === 1 ? 'minute' : 'minutes' }}. The device must be on your home Wi-Fi.</p>
            <button mat-button (click)="code.set(null)">Done</button>
          } @else {
            <p>Make a one-time code, then type it into the GoTVH app on the device.</p>
            <button mat-flat-button (click)="makeCode()" [disabled]="busy()"><mat-icon>pin</mat-icon> Make a pairing code</button>
          }
        </div>

        <div class="card">
          <h2><mat-icon>computer</mat-icon> Certificate for a computer</h2>
          <p>To use this admin app in a browser away from home: download a certificate for that computer, open the file
             there and enter the password shown here. The browser offers it when you visit the away address.</p>
          <div class="row">
            <mat-form-field appearance="outline"><mat-label>Computer name</mat-label><input matInput [(ngModel)]="computerName" placeholder="e.g. Work laptop"></mat-form-field>
            <button mat-stroked-button (click)="computerCertificate()" [disabled]="busy() || !computerName.trim()"><mat-icon>download</mat-icon> Download</button>
          </div>
          @if (p12Password(); as pw) {
            <p>Password for the downloaded file: <strong class="mono">{{ pw }}</strong> <span class="muted">(shown once)</span></p>
          }
        </div>

        <h2>Paired devices</h2>
        @for (d of devices(); track d.serial) {
          <div class="device">
            <mat-icon>{{ d.kind === 'computer' ? 'computer' : 'devices' }}</mat-icon>
            <div class="grow">
              <strong>{{ d.name }}</strong>
              <div class="muted small">Paired {{ d.paired | date:'MMM d, y' }} · good until {{ expiry(d.expires) | date:'MMM y' }}</div>
            </div>
            <button mat-button color="warn" (click)="remove(d)"><mat-icon>block</mat-icon> Remove</button>
          </div>
        } @empty {
          <p class="muted">None yet.</p>
        }
        @if (error()) { <p class="err">{{ error() }}</p> }
      }
    </div>
  `,
  styles: [`
    .page { padding: 16px 24px; max-width: 860px; }
    h1 { font: var(--mat-sys-headline-small); margin: 0; }
    h2 { font: var(--mat-sys-title-medium); display: flex; align-items: center; gap: 8px; margin: 18px 0 8px; }
    .subtitle, .muted { color: var(--mat-sys-on-surface-variant); }
    .small { font: var(--mat-sys-body-small); }
    .card { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: 4px 18px 14px; margin: 14px 0;
            background: var(--mat-sys-surface-container-lowest); }
    .card.warn { border-color: var(--mat-sys-error); }
    .row { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
    .pairing { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
    .qr-side { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .qr-side img { background: #fff; padding: 8px; border-radius: 8px; image-rendering: pixelated; }
    .code { font-size: 44px; font-weight: 700; letter-spacing: 6px; margin: 6px 0; font-variant-numeric: tabular-nums; }
    .mono { font-family: monospace; font-size: 16px; }
    .device { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .grow { flex: 1; }
    .err { color: var(--mat-sys-error); }
  `],
})
export class DevicesComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private tvh = inject(TvheadendService);
  private dialog = inject(MatDialog);

  readonly state = signal<'loading' | 'missing' | 'signin' | 'ready'>('loading');
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly info = signal<Info | null>(null);
  readonly devices = signal<Device[]>([]);
  readonly code = signal<string | null>(null);
  /** The code as a QR image (the phone app's Scan QR code reads "GOTVH-PAIR:<code>"). */
  readonly qr = signal<string | null>(null);
  readonly minutesLeft = signal(10);
  readonly p12Password = signal<string | null>(null);

  user = '';
  pass = '';
  computerName = '';
  private auth: string | null = null;
  private codeExpires = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.auth = this.tvh.getAuthHeader();
    this.timer = setInterval(() => {
      if (!this.code()) return;
      const left = Math.ceil((this.codeExpires - Date.now()) / 60000);
      if (left <= 0) this.code.set(null); else this.minutesLeft.set(left);
    }, 5000);
    this.loading.set(true);
    this.http.get<Info>('/pair/api/info').subscribe({
      next: i => { this.info.set(i); this.load(); },
      error: () => { this.loading.set(false); this.state.set('missing'); },
    });
  }

  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private headers(): HttpHeaders {
    return this.auth ? new HttpHeaders({ Authorization: this.auth }) : new HttpHeaders();
  }

  private load(): void {
    this.loading.set(true);
    this.http.get<Device[]>('/pair/api/devices', { headers: this.headers() }).subscribe({
      next: d => { this.devices.set(d); this.loading.set(false); this.state.set('ready'); },
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        if (e.status === 401) { this.state.set('signin'); if (this.auth) this.error.set('That account isn’t a Tvheadend administrator.'); }
        else this.state.set('missing');
      },
    });
  }

  signIn(): void {
    if (!this.user.trim() || !this.pass) return;
    this.auth = 'Basic ' + btoa(`${this.user.trim()}:${this.pass}`);
    this.error.set(null);
    this.load();
  }

  makeCode(): void {
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ code: string; expiresIn: number }>('/pair/api/codes', {}, { headers: this.headers() }).subscribe({
      next: r => {
        this.busy.set(false);
        this.codeExpires = Date.now() + r.expiresIn * 1000;
        this.minutesLeft.set(Math.ceil(r.expiresIn / 60));
        this.code.set(r.code);
        this.qr.set(null);
        toDataURL('GOTVH-PAIR:' + r.code, { margin: 0, width: 168, errorCorrectionLevel: 'M' })
          .then(url => { if (this.code() === r.code) this.qr.set(url); })
          .catch(() => this.qr.set(null));
        // Show the new device once it has paired.
        setTimeout(() => this.refreshWhilePairing(), 5000);
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.error.set(this.message(e)); },
    });
  }

  private refreshWhilePairing(): void {
    if (!this.code()) return;
    const before = this.devices().length;
    this.http.get<Device[]>('/pair/api/devices', { headers: this.headers() }).subscribe(d => {
      this.devices.set(d);
      if (d.length > before) this.code.set(null);
      else setTimeout(() => this.refreshWhilePairing(), 5000);
    });
  }

  computerCertificate(): void {
    const name = this.computerName.trim();
    this.busy.set(true);
    this.error.set(null);
    this.p12Password.set(null);
    this.http.post<{ code: string }>('/pair/api/codes', {}, { headers: this.headers() }).subscribe({
      next: c => this.http.post<{ p12: string; password: string }>('/pair/api/redeem', { code: c.code, name, format: 'p12' }).subscribe({
        next: r => {
          const bytes = Uint8Array.from(atob(r.p12), ch => ch.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-pkcs12' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `GoTVH ${name}.p12`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          this.p12Password.set(r.password);
          this.computerName = '';
          this.busy.set(false);
          this.load();
        },
        error: (e: HttpErrorResponse) => { this.busy.set(false); this.error.set(this.message(e)); },
      }),
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.error.set(this.message(e)); },
    });
  }

  remove(d: Device): void {
    const data: ConfirmDialogData = {
      title: `Remove ${d.name}?`,
      message: 'It will no longer be able to connect away from home (at home it keeps working). To use it away again, pair it again.',
      confirm: 'Remove',
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.http.delete(`/pair/api/devices/${d.serial}`, { headers: this.headers() }).subscribe({
        next: () => this.devices.set(this.devices().filter(x => x.serial !== d.serial)),
        error: (e: HttpErrorResponse) => this.error.set(this.message(e)),
      });
    });
  }

  /** openssl's "Oct  2 10:14:57 2031 GMT" → a Date. */
  expiry(s: string): Date | null {
    const t = Date.parse(s.replace(/\s+/g, ' '));
    return isNaN(t) ? null : new Date(t);
  }

  private message(e: HttpErrorResponse): string {
    return e.error?.error || (e.status === 0 ? 'The pairing service didn’t answer.' : `Failed (${e.status}).`);
  }
}
