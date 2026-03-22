import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription, forkJoin, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { TvheadendService } from '../../services/tvheadend.service';

type MatchMode = 'title' | 'fulltext';

@Component({
  selector: 'app-autorec',
  standalone: true,
  imports: [CommonModule, FormsModule, TvFocusableDirective],
  templateUrl: './autorec.component.html',
  styleUrls: ['./autorec.component.scss']
})
export class AutorecComponent implements OnInit, OnDestroy {
  private readonly previewLimit = 12;
  private readonly previewDebounceMs = 400;
  private readonly previewSearchLimit = 200;
  private readonly guidePreviewQuery$ = new Subject<{ title: string; channel: string; matchMode: MatchMode }>();
  private guidePreviewSubscription: Subscription | null = null;
  loading = true;
  saving = false;
  error = '';
  rules: any[] = [];
  channels: any[] = [];
  configs: any[] = [];
  guidePreviewLoading = false;
  guidePreviewError = '';
  guidePreviewSearched = false;
  guidePreviewMatchCount = 0;
  guidePreviewResults: any[] = [];
  channelFilter = '';
  ruleFilter = '';
  editChannelFilter = '';
  ruleActionUuid = '';
  editingRuleUuid = '';
  private pendingFocusTarget: 'refresh' | 'create' | { ruleUuid: string } | null = null;
  form = {
    title: '',
    channel: '',
    matchMode: 'title' as MatchMode,
    config: '',
    comment: ''
  };
  editForm = {
    title: '',
    channel: '',
    matchMode: 'title' as MatchMode,
    config: '',
    comment: ''
  };

  constructor(private tvh: TvheadendService) {}

  ngOnInit(): void {
    this.bindGuidePreview();
    this.refresh();
  }

  ngOnDestroy(): void {
    this.guidePreviewSubscription?.unsubscribe();
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
        this.configs = this.sortConfigs(configs);
        this.rules = this.decorateRules(rules, channels, configs);
        this.loading = false;
        this.queueGuidePreview();
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
      fulltext: this.form.matchMode === 'fulltext' ? 1 : 0,
      comment: String(this.form.comment || '').trim(),
    };

    const channel = String(this.form.channel || '').trim();
    if (channel) {
      conf.channel = channel;
    }

    const config = String(this.form.config || '').trim();
    if (config) {
      conf.config_name = config;
    }

    this.tvh.createAutorec(conf).subscribe({
      next: () => {
        this.saving = false;
        this.pendingFocusTarget = 'create';
        this.form = { title: '', channel: '', matchMode: 'title', config: '', comment: '' };
        this.channelFilter = '';
        this.clearGuidePreview();
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

  toggleRuleEnabled(rule: any): void {
    const uuid = String(rule?.uuid || '').trim();
    if (!uuid || this.ruleActionUuid) {
      return;
    }

    this.error = '';
    this.ruleActionUuid = uuid;
    this.pendingFocusTarget = { ruleUuid: uuid };
    this.tvh.saveAutorec(uuid, {
      enabled: rule?.enabled ? 0 : 1
    }).subscribe({
      next: () => {
        this.ruleActionUuid = '';
        this.refresh();
      },
      error: (error: any) => {
        this.ruleActionUuid = '';
        this.pendingFocusTarget = null;
        this.error = this.describeError(error);
      }
    });
  }

  startEditRule(rule: any): void {
    const uuid = String(rule?.uuid || '').trim();
    if (!uuid || this.ruleActionUuid) {
      return;
    }

    this.editingRuleUuid = uuid;
    this.editChannelFilter = '';
    this.editForm = {
      title: String(rule?.title || rule?.name || '').trim(),
      channel: String(rule?.channel || '').trim(),
      matchMode: this.normalizeMatchMode(rule?.fulltext),
      config: this.normalizeConfigSelection(String(rule?.config_name || rule?.config || '').trim()),
      comment: String(rule?.comment || '').trim()
    };
  }

  cancelEditRule(): void {
    this.editingRuleUuid = '';
    this.editChannelFilter = '';
    this.editForm = { title: '', channel: '', matchMode: 'title', config: '', comment: '' };
  }

  saveRuleEdits(rule: any): void {
    const uuid = String(rule?.uuid || '').trim();
    const title = String(this.editForm.title || '').trim();
    if (!uuid || !title || this.ruleActionUuid) {
      if (!title) {
        this.error = 'A rule title is required.';
      }
      return;
    }

    this.error = '';
    this.ruleActionUuid = uuid;
    this.pendingFocusTarget = { ruleUuid: uuid };

    const changes: any = {
      title,
      fulltext: this.editForm.matchMode === 'fulltext' ? 1 : 0,
      comment: String(this.editForm.comment || '').trim(),
      channel: String(this.editForm.channel || '').trim(),
      config_name: String(this.editForm.config || '').trim()
    };

    this.tvh.saveAutorec(uuid, changes).subscribe({
      next: () => {
        this.ruleActionUuid = '';
        this.cancelEditRule();
        this.refresh();
      },
      error: (error: any) => {
        this.ruleActionUuid = '';
        this.error = this.describeError(error);
      }
    });
  }

  isRuleActionBusy(rule: any): boolean {
    return !!this.ruleActionUuid && this.ruleActionUuid === String(rule?.uuid || '').trim();
  }

  isEditingRule(rule: any): boolean {
    return this.editingRuleUuid === String(rule?.uuid || '').trim();
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

  getFilteredRules(): any[] {
    const query = String(this.ruleFilter || '').trim().toLowerCase();
    if (!query) {
      return this.rules;
    }

    return this.rules.filter(rule => {
      const title = String(rule?.title || rule?.name || '').trim().toLowerCase();
      const channel = String(rule?.channelname || rule?.channel || '').trim().toLowerCase();
      const comment = String(rule?.comment || '').trim().toLowerCase();
      const config = String(rule?.config_label || '').trim().toLowerCase();
      return title.includes(query)
        || channel.includes(query)
        || comment.includes(query)
        || config.includes(query);
    });
  }

  formatChannel(rule: any): string {
    return rule?.channelname || rule?.channel || 'Any channel';
  }

  formatChannelOption(channel: any): string {
    const number = String(channel?.number ?? '').trim();
    const name = String(channel?.name || channel?.channelname || channel?.uuid || '').trim();
    return number ? `${number} ${name}`.trim() : name;
  }

  formatConfigOption(config: any): string {
    return String(config?.name || config?.title || '').trim() || 'Default DVR config';
  }

  queueGuidePreview(): void {
    const title = String(this.form.title || '').trim();
    const channel = String(this.form.channel || '').trim();
    const matchMode = this.form.matchMode;

    this.guidePreviewError = '';
    this.guidePreviewSearched = !!title;
    this.guidePreviewLoading = !!title;
    this.guidePreviewQuery$.next({ title, channel, matchMode });

    if (!title) {
      this.clearGuidePreview();
      return;
    }
  }

  clearGuidePreview(): void {
    this.guidePreviewLoading = false;
    this.guidePreviewError = '';
    this.guidePreviewSearched = false;
    this.guidePreviewMatchCount = 0;
    this.guidePreviewResults = [];
  }

  getGuidePreviewSummary(): string {
    if (!this.guidePreviewSearched || this.guidePreviewLoading || this.guidePreviewError) {
      return '';
    }

    if (this.guidePreviewMatchCount === 0) {
      return 'No current or upcoming guide matches found for this rule.';
    }

    if (this.guidePreviewMatchCount > this.guidePreviewResults.length) {
      return `${this.guidePreviewMatchCount} guide matches found. Showing the first ${this.guidePreviewResults.length}.`;
    }

    return `${this.guidePreviewMatchCount} guide match${this.guidePreviewMatchCount === 1 ? '' : 'es'} found.`;
  }

  describePreviewMatchMode(): string {
    return this.form.matchMode === 'fulltext' ? 'Full-text preview' : 'Title-only preview';
  }

  getRuleFilterSummary(): string {
    const total = this.rules.length;
    const filtered = this.getFilteredRules().length;
    if (!this.ruleFilter.trim()) {
      return `${total} rule${total === 1 ? '' : 's'}`;
    }

    return `${filtered} of ${total} rules shown`;
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

  getFilteredEditChannels(): any[] {
    const query = String(this.editChannelFilter || '').trim().toLowerCase();
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

  private sortConfigs(configs: any[]): any[] {
    return [...(configs || [])]
      .filter(config => !!String(config?.name || config?.title || '').trim())
      .sort((left, right) => {
        const leftLabel = this.formatConfigOption(left).toLowerCase();
        const rightLabel = this.formatConfigOption(right).toLowerCase();
        return leftLabel.localeCompare(rightLabel);
      });
  }

  private normalizeConfigSelection(configValue: string): string {
    if (!configValue) {
      return '';
    }

    const matchingConfig = this.configs.find(config => String(config?.uuid || '').trim() === configValue);
    return matchingConfig ? configValue : '';
  }

  private normalizeMatchMode(fulltextValue: any): MatchMode {
    return !!Number(fulltextValue || 0) ? 'fulltext' : 'title';
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

  private bindGuidePreview(): void {
    this.guidePreviewSubscription = this.guidePreviewQuery$.pipe(
      debounceTime(this.previewDebounceMs),
      distinctUntilChanged((left, right) => left.title === right.title && left.channel === right.channel && left.matchMode === right.matchMode),
      switchMap(({ title, channel, matchMode }) => {
        if (!title) {
          return of({ total: 0, results: [], error: '', searched: false });
        }

        return this.tvh.searchAutorecPreview(title, channel, matchMode === 'fulltext', this.previewSearchLimit).pipe(
          map(entries => ({ ...this.decorateGuidePreview(entries, title), searched: true })),
          catchError(() => of({ total: 0, results: [], error: 'Guide preview is unavailable right now. Check TVHeadend and try again.', searched: true }))
        );
      })
    ).subscribe(result => {
      this.guidePreviewLoading = false;
      this.guidePreviewMatchCount = result.total;
      this.guidePreviewResults = result.results;
      this.guidePreviewError = result.error || '';
      this.guidePreviewSearched = !!result.searched;
    });
  }

  private decorateGuidePreview(entries: any[], title: string): { total: number; results: any[]; error?: string } {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const query = String(title || '').trim().toLowerCase();

    const filtered = (entries || []).filter(entry => Number(entry?.stop || 0) > nowSeconds);
    const results = filtered
      .map(entry => {
        const entryTitle = String(entry?.title || entry?.disp_title || 'Untitled').trim() || 'Untitled';
        const startTime = Number(entry?.start || 0) * 1000;
        const endTime = Number(entry?.stop || 0) * 1000;
        return {
          title: entryTitle,
          channelName: String(entry?.channelName || entry?.channelname || 'Unknown Channel').trim() || 'Unknown Channel',
          startTime,
          endTime,
          desc: String(entry?.summary || entry?.description || entry?.desc || '').trim(),
          category: this.formatPreviewCategory(entry?.category || entry?.genre || ''),
          isLive: Number(entry?.start || 0) <= nowSeconds && Number(entry?.stop || 0) > nowSeconds,
          exactTitle: entryTitle.toLowerCase() === query,
          titleStartsWith: entryTitle.toLowerCase().startsWith(query)
        };
      })
      .sort((left, right) => {
        if (left.exactTitle !== right.exactTitle) {
          return left.exactTitle ? -1 : 1;
        }
        if (left.titleStartsWith !== right.titleStartsWith) {
          return left.titleStartsWith ? -1 : 1;
        }
        if (left.isLive !== right.isLive) {
          return left.isLive ? -1 : 1;
        }
        if (left.startTime !== right.startTime) {
          return left.startTime - right.startTime;
        }
        return left.channelName.localeCompare(right.channelName, undefined, { numeric: true, sensitivity: 'base' });
      })
      .slice(0, this.previewLimit);

    return {
      total: filtered.length,
      results,
    };
  }

  private formatPreviewCategory(value: any): string {
    if (Array.isArray(value)) {
      return value.map(item => String(item || '').trim()).filter(Boolean).join(', ');
    }

    return String(value || '').trim();
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