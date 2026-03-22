import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { TvheadendService } from '../../services/tvheadend.service';

@Component({
  selector: 'app-autorec',
  standalone: true,
  imports: [CommonModule, FormsModule, TvFocusableDirective],
  templateUrl: './autorec.component.html',
  styleUrls: ['./autorec.component.scss']
})
export class AutorecComponent implements OnInit {
  loading = true;
  saving = false;
  error = '';
  rules: any[] = [];
  channels: any[] = [];
  channelFilter = '';
  private pendingFocusTarget: 'refresh' | 'create' | { ruleUuid: string } | null = null;
  form = {
    title: '',
    channel: '',
    comment: ''
  };

  constructor(private tvh: TvheadendService) {}

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading = true;
    this.error = '';
    forkJoin({
      rules: this.tvh.getAutorecs(),
      channels: this.tvh.getChannels().pipe(catchError(() => of([]))),
      configs: this.tvh.getDvrConfigs().pipe(catchError(() => of([])))
    }).subscribe({
      next: ({ rules, channels, configs }) => {
        this.channels = this.sortChannels(channels);
        this.rules = this.decorateRules(rules, channels, configs);
        this.loading = false;
        this.restoreFocusIfNeeded();
      },
      error: (error: any) => {
        this.loading = false;
        this.error = this.describeError(error);
      }
    });
  }

  createRule(): void {
    const title = String(this.form.title || '').trim();
    if (!title) {
      this.error = 'A rule title is required.';
      return;
    }

    this.saving = true;
    this.error = '';
    const conf: any = {
      enabled: 1,
      title,
      fulltext: 1,
      comment: String(this.form.comment || '').trim(),
    };

    const channel = String(this.form.channel || '').trim();
    if (channel) {
      conf.channel = channel;
    }

    this.tvh.createAutorec(conf).subscribe({
      next: () => {
        this.saving = false;
        this.pendingFocusTarget = 'create';
        this.form = { title: '', channel: '', comment: '' };
        this.channelFilter = '';
        this.refresh();
      },
      error: (error: any) => {
        this.saving = false;
        this.error = this.describeError(error);
      }
    });
  }

  deleteRule(rule: any): void {
    const uuid = String(rule?.uuid || '').trim();
    if (!uuid) {
      return;
    }

    this.error = '';
    this.pendingFocusTarget = { ruleUuid: uuid };
    this.tvh.deleteAutorec(uuid).subscribe({
      next: () => this.refresh(),
      error: (error: any) => {
        this.pendingFocusTarget = null;
        this.error = this.describeError(error);
      }
    });
  }

  rememberRefreshFocus(): void {
    this.pendingFocusTarget = 'refresh';
  }

  private restoreFocusIfNeeded(): void {
    const target = this.pendingFocusTarget;
    if (!target) {
      return;
    }

    this.pendingFocusTarget = null;
    setTimeout(() => {
      if (target === 'refresh') {
        (document.querySelector('[data-autorec-refresh]') as HTMLElement | null)?.focus();
        return;
      }

      if (target === 'create') {
        (document.querySelector('[data-autorec-create]') as HTMLElement | null)?.focus();
        return;
      }

      const escapedUuid = target.ruleUuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const sameRule = document.querySelector(`[data-autorec-row-uuid="${escapedUuid}"]`) as HTMLElement | null;
      const fallback = document.querySelector('[data-autorec-row-uuid], [data-autorec-refresh]') as HTMLElement | null;
      (sameRule || fallback)?.focus();
    }, 0);
  }

  trackByUuid(_: number, rule: any): string {
    return String(rule?.uuid || rule?.title || _);
  }

  getEnabledCount(): number {
    return this.rules.filter(rule => !!rule?.enabled).length;
  }

  getScopedCount(): number {
    return this.rules.filter(rule => !!String(rule?.channel || rule?.channelname || '').trim()).length;
  }

  formatChannel(rule: any): string {
    return rule?.channelname || rule?.channel || 'Any channel';
  }

  formatChannelOption(channel: any): string {
    const number = String(channel?.number ?? '').trim();
    const name = String(channel?.name || channel?.channelname || channel?.uuid || '').trim();
    return number ? `${number} ${name}`.trim() : name;
  }

  getFilteredChannels(): any[] {
    const query = String(this.channelFilter || '').trim().toLowerCase();
    if (!query) {
      return this.channels;
    }

    return this.channels.filter(channel => {
      const label = this.formatChannelOption(channel).toLowerCase();
      const uuid = String(channel?.uuid || '').trim().toLowerCase();
      return label.includes(query) || uuid.includes(query);
    });
  }

  private sortChannels(channels: any[]): any[] {
    return [...(channels || [])].sort((left, right) => {
      const leftNumber = Number(left?.number ?? Number.MAX_SAFE_INTEGER);
      const rightNumber = Number(right?.number ?? Number.MAX_SAFE_INTEGER);
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }

      const leftName = String(left?.name || '').trim().toLowerCase();
      const rightName = String(right?.name || '').trim().toLowerCase();
      return leftName.localeCompare(rightName);
    });
  }

  private decorateRules(rules: any[], channels: any[], configs: any[]): any[] {
    const channelNameByUuid = new Map<string, string>();
    for (const channel of channels || []) {
      const uuid = String(channel?.uuid || channel?.key || channel?.id || '').trim();
      const name = String(channel?.name || '').trim();
      if (uuid && name) {
        channelNameByUuid.set(uuid, name);
      }
    }

    const configNameByUuid = new Map<string, string>();
    for (const config of configs || []) {
      const uuid = String(config?.uuid || config?.key || '').trim();
      const name = String(config?.name || config?.title || '').trim() || 'Default DVR config';
      if (uuid && name) {
        configNameByUuid.set(uuid, name);
      }
    }

    return (rules || []).map(rule => {
      const channelUuid = String(rule?.channel || '').trim();
      const configValue = String(rule?.config_name || rule?.config || '').trim();
      const channelName = String(rule?.channelname || channelNameByUuid.get(channelUuid) || channelUuid || '').trim();
      const configLabel = String(configNameByUuid.get(configValue) || configValue || '').trim();

      return {
        ...rule,
        channelname: channelName,
        config_label: configLabel
      };
    });
  }

  describeMatchMode(rule: any): string {
    return rule?.fulltext ? 'Full-text match' : 'Title match';
  }

  private describeError(error: any): string {
    const status = Number(error?.status || 0);
    if (status === 401) {
      return 'Authentication required. Use TVH Login in the sidebar and reload this view.';
    }
    if (status === 403) {
      return 'The current TVHeadend account does not have AutoRec access.';
    }
    if (status === 0) {
      return 'TVHeadend is unreachable. Check backend and proxy settings.';
    }
    return 'TVHeadend returned an unexpected AutoRec response.';
  }
}