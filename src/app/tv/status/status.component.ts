import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { TvheadendService } from '../../services/tvheadend.service';

@Component({
  selector: 'app-status',
  standalone: true,
  imports: [CommonModule, TvFocusableDirective],
  templateUrl: './status.component.html',
  styleUrls: ['./status.component.scss']
})
export class StatusComponent implements OnInit {
  loading = true;
  error = '';
  serverInfo: any = null;
  subscriptions: any[] = [];
  connections: any[] = [];
  private shouldRestoreRefreshFocus = false;

  constructor(private tvh: TvheadendService) {}

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading = true;
    this.error = '';

    forkJoin({
      serverInfo: this.tvh.getServerInfo().pipe(catchError(() => of(null))),
      subscriptions: this.tvh.getSubscriptions().pipe(catchError(() => of([]))),
      connections: this.tvh.getConnections().pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ serverInfo, subscriptions, connections }) => {
        this.serverInfo = serverInfo;
        this.subscriptions = subscriptions;
        this.connections = connections;
        this.loading = false;
        this.restoreRefreshFocusIfNeeded();
      },
      error: (error: any) => {
        this.loading = false;
        this.error = this.describeError(error);
      }
    });
  }

  rememberRefreshFocus(): void {
    this.shouldRestoreRefreshFocus = true;
  }

  entriesOf(value: any): Array<{ key: string; value: string }> {
    return Object.entries(value || {})
      .slice(0, 12)
      .map(([key, entryValue]) => ({ key, value: String(entryValue) }));
  }

  trackByIndex(index: number): number {
    return index;
  }

  private restoreRefreshFocusIfNeeded(): void {
    if (!this.shouldRestoreRefreshFocus) {
      return;
    }

    this.shouldRestoreRefreshFocus = false;
    setTimeout(() => {
      (document.querySelector('[data-status-refresh]') as HTMLElement | null)?.focus();
    }, 0);
  }

  private describeError(error: any): string {
    const status = Number(error?.status || 0);
    if (status === 401) {
      return 'Authentication required. Use TVH Login in the sidebar and reload this view.';
    }
    if (status === 403) {
      return 'The current TVHeadend account does not have access to status endpoints.';
    }
    if (status === 0) {
      return 'TVHeadend is unreachable. Check backend and proxy settings.';
    }
    return 'TVHeadend returned an unexpected server status response.';
  }
}