import { Component, OnInit, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableModule } from '@angular/material/table';
import { TvheadendService } from '@gotvh/tvh-api';

/**
 * Read-only server overview: everything here uses calls the shared client
 * already had for the TV app's Status screen.
 */
@Component({
  selector: 'admin-dashboard',
  standalone: true,
  imports: [MatCardModule, MatTableModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <div class="admin-page">
      <div class="head">
        <div>
          <h1>Dashboard</h1>
          <p class="subtitle">Server status, active streams and client connections.</p>
        </div>
        <button mat-stroked-button (click)="load()" [disabled]="loading()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </div>
      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

      <div class="stats">
        <mat-card appearance="outlined">
          <mat-card-content>
            <div class="label">Server</div>
            <div class="value">{{ server()?.name || 'Tvheadend' }}</div>
            <div class="muted">{{ server()?.sw_version || server()?.version || 'version unknown' }}</div>
          </mat-card-content>
        </mat-card>
        <mat-card appearance="outlined">
          <mat-card-content>
            <div class="label">API version</div>
            <div class="value num">{{ server()?.api_version ?? '—' }}</div>
          </mat-card-content>
        </mat-card>
        <mat-card appearance="outlined">
          <mat-card-content>
            <div class="label">Active subscriptions</div>
            <div class="value num">{{ subscriptions().length }}</div>
          </mat-card-content>
        </mat-card>
        <mat-card appearance="outlined">
          <mat-card-content>
            <div class="label">Connections</div>
            <div class="value num">{{ connections().length }}</div>
          </mat-card-content>
        </mat-card>
      </div>

      <h2>Subscriptions</h2>
      @if (subscriptions().length) {
        <table mat-table [dataSource]="subscriptions()" class="mat-elevation-z0">
          <ng-container matColumnDef="channel">
            <th mat-header-cell *matHeaderCellDef>Channel</th>
            <td mat-cell *matCellDef="let s">{{ s.channel || s.service || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="client">
            <th mat-header-cell *matHeaderCellDef>Client</th>
            <td mat-cell *matCellDef="let s">{{ s.username || '' }} {{ s.hostname ? '@ ' + s.hostname : '' }}</td>
          </ng-container>
          <ng-container matColumnDef="title">
            <th mat-header-cell *matHeaderCellDef>Type</th>
            <td mat-cell *matCellDef="let s">{{ s.title || s.client || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="state">
            <th mat-header-cell *matHeaderCellDef>State</th>
            <td mat-cell *matCellDef="let s">{{ s.state || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="errors">
            <th mat-header-cell *matHeaderCellDef class="num">Errors</th>
            <td mat-cell *matCellDef="let s" class="num">{{ s.errors ?? 0 }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="subColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: subColumns"></tr>
        </table>
      } @else {
        <p class="muted">No active subscriptions.</p>
      }

      <h2>Connections</h2>
      @if (connections().length) {
        <table mat-table [dataSource]="connections()">
          <ng-container matColumnDef="peer">
            <th mat-header-cell *matHeaderCellDef>Peer</th>
            <td mat-cell *matCellDef="let c">{{ c.peer }}{{ c.peer_port ? ':' + c.peer_port : '' }}</td>
          </ng-container>
          <ng-container matColumnDef="user">
            <th mat-header-cell *matHeaderCellDef>User</th>
            <td mat-cell *matCellDef="let c">{{ c.user || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="type">
            <th mat-header-cell *matHeaderCellDef>Type</th>
            <td mat-cell *matCellDef="let c">{{ c.type || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="started">
            <th mat-header-cell *matHeaderCellDef>Started</th>
            <td mat-cell *matCellDef="let c">{{ formatEpoch(c.started) }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="connColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: connColumns"></tr>
        </table>
      } @else {
        <p class="muted">No client connections reported.</p>
      }
    </div>
  `,
  styles: [`
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 8px 0 28px; }
    .label { font: var(--mat-sys-label-medium); color: var(--mat-sys-on-surface-variant); }
    .value { font: var(--mat-sys-headline-small); margin: 4px 0 2px; }
    h2 { font: var(--mat-sys-title-medium); margin: 24px 0 8px; }
    table { width: 100%; }
  `],
})
export class DashboardComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);

  readonly loading = signal(false);
  readonly server = signal<any>(null);
  readonly subscriptions = signal<any[]>([]);
  readonly connections = signal<any[]>([]);

  readonly subColumns = ['channel', 'client', 'title', 'state', 'errors'];
  readonly connColumns = ['peer', 'user', 'type', 'started'];

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    forkJoin({
      server: this.tvh.getServerInfo().pipe(catchError(() => of(null))),
      subscriptions: this.tvh.getSubscriptions(),
      connections: this.tvh.getConnections(),
    }).subscribe({
      next: r => {
        this.server.set(r.server);
        this.subscriptions.set(r.subscriptions);
        this.connections.set(r.connections);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  formatEpoch(seconds: number | undefined): string {
    return seconds ? new Date(seconds * 1000).toLocaleString() : '—';
  }
}
