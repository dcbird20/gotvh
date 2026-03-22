import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { environment } from '../../../environments/environment';
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
  serverInfoNotice = '';
  subscriptions: any[] = [];
  connections: any[] = [];
  readonly appInfo = {
    version: environment.appVersion,
    build: environment.appBuildLabel,
    packageId: environment.appPackageId,
    mode: environment.production ? 'production' : 'development'
  };
  private shouldRestoreRefreshFocus = false;

  constructor(private tvh: TvheadendService) {}

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading = true;
    this.error = '';
    this.serverInfoNotice = '';

    forkJoin({
      serverInfo: this.tvh.getServerInfo().pipe(
        catchError((error: any) => {
          this.serverInfoNotice = this.describeServerInfoError(error);
          return of(null);
        })
      ),
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

  appEntries(): Array<{ key: string; value: string }> {
    return [
      { key: 'version', value: this.appInfo.version },
      { key: 'build', value: this.appInfo.build },
      { key: 'package', value: this.appInfo.packageId },
      { key: 'mode', value: this.appInfo.mode }
    ];
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

  private describeServerInfoError(error: any): string {
    const status = Number(error?.status || 0);

    if (status === 401) {
      return 'Server metadata requires authentication. Use TVH Login and refresh this page.';
    }

    if (status === 403) {
      return 'This TVHeadend account cannot read server metadata.';
    }

    if (status === 404) {
      return 'This TVHeadend build does not expose the server metadata endpoint used by GoTVH.';
    }

    if (status === 0) {
      return 'Server metadata could not be reached. Check backend and proxy settings.';
    }

    return 'Server metadata is unavailable because TVHeadend returned an unexpected response.';
  }
}