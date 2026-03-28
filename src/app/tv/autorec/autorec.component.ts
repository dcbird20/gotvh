import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription, forkJoin, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { TvFocusableDirective } from '../../directives/tv-focusable.directive';
import { SpatialNavService } from '../../services/spatial-nav.service';
import { GuideDataSnapshot, TvheadendService } from '../../services/tvheadend.service';

type MatchMode = 'title' | 'fulltext';
type ConfigPickerTarget = 'create' | 'edit';
type QuickPreset = 'news' | 'series' | 'sports' | 'movies';

interface GuidePreviewQuery {
  title: string;
  channel: string;
  matchMode: MatchMode;
  startsWith: boolean;
  endsWith: boolean;
}

interface ParsedTitlePattern {
  title: string;
  startsWith: boolean;
  endsWith: boolean;
  customRegex: boolean;
  rawPattern: string;
}

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
  private readonly guidePreviewQuery$ = new Subject<GuidePreviewQuery>();
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
  showAdvancedTiming = false;
  showRefineOptions = false;
  showGuidePreviewDetails = false;
  showEditAdvancedTiming = false;
  configPickerTarget: ConfigPickerTarget | null = null;
  ruleActionUuid = '';
  editingRuleUuid = '';
  confirmingDeleteRuleUuid = '';
  private pendingFocusTarget: 'refresh' | 'create' | { ruleUuid: string } | null = null;
  form = {
    title: '',
    channel: '',
    matchMode: 'title' as MatchMode,
    startsWith: false,
    endsWith: false,
    startTime: '',
    startWindow: '',
    startExtra: '',
    stopExtra: '',
    config: '',
    comment: ''
  };
  editForm = {
    title: '',
    channel: '',
    matchMode: 'title' as MatchMode,
    startsWith: false,
    endsWith: false,
    startTime: '',
    startWindow: '',
    startExtra: '',
    stopExtra: '',
    customRegex: false,
    rawPattern: '',
    config: '',
    comment: ''
  };

  constructor(
    private tvh: TvheadendService,
    private spatialNav: SpatialNavService
  ) {}

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
    const title = this.buildRuleTitlePattern(this.form.title, this.form.matchMode, this.form.startsWith, this.form.endsWith);
    const name = String(this.form.title || '').trim();
    if (!title) {
      this.error = 'A rule title is required.';
      return;
    }

    const startMinutes = this.parseTimeToMinutes(this.form.startTime);
    if (String(this.form.startTime || '').trim() && startMinutes === null) {
      this.error = 'Start time must be HH:MM.';
      return;
    }

    const startWindow = this.parseOptionalNonNegativeInteger(this.form.startWindow);
    if (Number.isNaN(startWindow as number)) {
      this.error = 'Start window must be a non-negative whole number.';
      return;
    }

    const startExtra = this.parseOptionalNonNegativeInteger(this.form.startExtra);
    if (Number.isNaN(startExtra as number)) {
      this.error = 'Pre-roll must be a non-negative whole number.';
      return;
    }

    const stopExtra = this.parseOptionalNonNegativeInteger(this.form.stopExtra);
    if (Number.isNaN(stopExtra as number)) {
      this.error = 'Post-roll must be a non-negative whole number.';
      return;
    }

    this.saving = true;
    this.error = '';
    const conf: any = {
      enabled: 1,
      title,
      name,
      fulltext: this.form.matchMode === 'fulltext' ? 1 : 0,
      mergetext: this.form.matchMode === 'fulltext' ? 1 : 0,
      comment: String(this.form.comment || '').trim(),
    };

    if (startMinutes !== null) {
      conf.start = startMinutes;
    }
    if (startWindow !== null) {
      conf.start_window = startWindow;
    }
    if (startExtra !== null) {
      conf.start_extra = startExtra;
    }
    if (stopExtra !== null) {
      conf.stop_extra = stopExtra;
    }

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
        this.form = {
          title: '',
          channel: '',
          matchMode: 'title',
          startsWith: false,
          endsWith: false,
          startTime: '',
          startWindow: '',
          startExtra: '',
          stopExtra: '',
          config: '',
          comment: ''
        };
        this.showRefineOptions = false;
        this.showAdvancedTiming = false;
        this.showGuidePreviewDetails = false;
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

  requestDeleteRuleConfirmation(rule: any): void {
    const uuid = String(rule?.uuid || '').trim();
    if (!uuid || this.ruleActionUuid) {
      return;
    }

    this.error = '';
    this.confirmingDeleteRuleUuid = uuid;

    setTimeout(() => {
      const cancelButton = document.querySelector('[data-autorec-delete-confirm-cancel]') as HTMLElement | null;
      const confirmButton = document.querySelector('[data-autorec-delete-confirm-yes]') as HTMLElement | null;
      (cancelButton || confirmButton)?.focus();
    }, 0);
  }

  confirmDeleteRule(): void {
    const uuid = String(this.confirmingDeleteRuleUuid || '').trim();
    if (!uuid || this.ruleActionUuid) {
      return;
    }

    this.error = '';
    this.confirmingDeleteRuleUuid = '';
    this.pendingFocusTarget = { ruleUuid: uuid };
    this.tvh.deleteAutorec(uuid).subscribe({
      next: () => this.refresh(),
      error: (error: any) => {
        this.pendingFocusTarget = null;
        this.error = this.describeError(error);
      }
    });
  }

  cancelDeleteRuleConfirmation(): void {
    this.confirmingDeleteRuleUuid = '';
  }

  getConfirmingDeleteRule(): any | null {
    const uuid = String(this.confirmingDeleteRuleUuid || '').trim();
    if (!uuid) {
      return null;
    }

    return this.rules.find(rule => String(rule?.uuid || '').trim() === uuid) || null;
  }

  @HostListener('document:keydown', ['$event'])
  handleConfirmDialogKeydown(event: KeyboardEvent): void {
    if (this.configPickerTarget) {
      const key = String(event.key || '');
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeConfigPicker();
        return;
      }

      const isDown = this.spatialNav.isDirectionalKey(event, 'down');
      const isUp = this.spatialNav.isDirectionalKey(event, 'up');
      if (isDown || isUp) {
        event.preventDefault();
        event.stopPropagation();
        this.moveConfigPickerFocus(isDown ? 1 : -1);
        return;
      }

      if (this.spatialNav.isSelectKey(event)) {
        const activeElement = document.activeElement as HTMLElement | null;
        if (activeElement?.hasAttribute('data-autorec-config-option')) {
          event.preventDefault();
          event.stopPropagation();
          activeElement.click();
        }
      }
      return;
    }

    if (!this.confirmingDeleteRuleUuid) {
      return;
    }

    const key = String(event.key || '');
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelDeleteRuleConfirmation();
      return;
    }

    if (key !== 'Enter' && key !== 'NumpadEnter') {
      return;
    }

    const confirmButton = document.querySelector('[data-autorec-delete-confirm-yes]') as HTMLElement | null;
    const activeElement = document.activeElement as HTMLElement | null;
    if (confirmButton && activeElement === confirmButton) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.cancelDeleteRuleConfirmation();
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
    const parsedPattern = this.parseStoredTitlePattern(String(rule?.title || rule?.name || '').trim());
    this.editForm = {
      title: parsedPattern.title,
      channel: String(rule?.channel || '').trim(),
      matchMode: this.normalizeMatchMode(rule?.fulltext),
      startsWith: parsedPattern.startsWith,
      endsWith: parsedPattern.endsWith,
      startTime: this.formatStartMinutesAsTime(rule?.start),
      startWindow: this.formatOptionalInteger(rule?.start_window),
      startExtra: this.formatOptionalInteger(rule?.start_extra),
      stopExtra: this.formatOptionalInteger(rule?.stop_extra),
      customRegex: parsedPattern.customRegex,
      rawPattern: parsedPattern.rawPattern,
      config: this.normalizeConfigSelection(String(rule?.config_name || rule?.config || '').trim()),
      comment: String(rule?.comment || '').trim()
    };
    this.showEditAdvancedTiming = !!(this.editForm.startWindow || this.editForm.startExtra || this.editForm.stopExtra);
  }

  cancelEditRule(): void {
    this.editingRuleUuid = '';
    this.editChannelFilter = '';
    this.showEditAdvancedTiming = false;
    this.editForm = {
      title: '',
      channel: '',
      matchMode: 'title',
      startsWith: false,
      endsWith: false,
      startTime: '',
      startWindow: '',
      startExtra: '',
      stopExtra: '',
      customRegex: false,
      rawPattern: '',
      config: '',
      comment: ''
    };
  }

  saveRuleEdits(rule: any): void {
    const uuid = String(rule?.uuid || '').trim();
    const title = this.editForm.customRegex
      ? String(this.editForm.rawPattern || '').trim()
      : this.buildRuleTitlePattern(this.editForm.title, this.editForm.matchMode, this.editForm.startsWith, this.editForm.endsWith);
    if (!uuid || !title || this.ruleActionUuid) {
      if (!title) {
        this.error = 'A rule title is required.';
      }
      return;
    }

    this.error = '';

    const startMinutes = this.parseTimeToMinutes(this.editForm.startTime);
    if (String(this.editForm.startTime || '').trim() && startMinutes === null) {
      this.error = 'Start time must be HH:MM.';
      return;
    }

    const startWindow = this.parseOptionalNonNegativeInteger(this.editForm.startWindow);
    if (Number.isNaN(startWindow as number)) {
      this.error = 'Start window must be a non-negative whole number.';
      return;
    }

    const startExtra = this.parseOptionalNonNegativeInteger(this.editForm.startExtra);
    if (Number.isNaN(startExtra as number)) {
      this.error = 'Pre-roll must be a non-negative whole number.';
      return;
    }

    const stopExtra = this.parseOptionalNonNegativeInteger(this.editForm.stopExtra);
    if (Number.isNaN(stopExtra as number)) {
      this.error = 'Post-roll must be a non-negative whole number.';
      return;
    }

    this.ruleActionUuid = uuid;
    this.pendingFocusTarget = { ruleUuid: uuid };

    const changes: any = {
      title,
      name: this.editForm.customRegex ? String(rule?.name || '').trim() : String(this.editForm.title || '').trim(),
      fulltext: this.editForm.matchMode === 'fulltext' ? 1 : 0,
      mergetext: this.editForm.matchMode === 'fulltext' ? 1 : 0,
      comment: String(this.editForm.comment || '').trim(),
      channel: String(this.editForm.channel || '').trim(),
      config_name: String(this.editForm.config || '').trim(),
      start: startMinutes ?? 0,
      start_window: startWindow ?? 0,
      start_extra: startExtra ?? 0,
      stop_extra: stopExtra ?? 0
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
      const title = String(rule?.display_title || rule?.name || rule?.title || '').trim().toLowerCase();
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

  getSelectedConfigLabel(configValue: string): string {
    const normalized = String(configValue || '').trim();
    if (!normalized) {
      return 'Default DVR config';
    }

    const config = this.configs.find(item => String(item?.uuid || '').trim() === normalized);
    return config ? this.formatConfigOption(config) : 'Default DVR config';
  }

  getCreateStartTimeDisplay(): string {
    return String(this.form.startTime || '').trim() || 'Any time';
  }

  getEditStartTimeDisplay(): string {
    return String(this.editForm.startTime || '').trim() || 'Any time';
  }

  applyQuickPreset(preset: QuickPreset): void {
    if (preset === 'news') {
      this.form.matchMode = 'title';
      this.form.startsWith = false;
      this.form.endsWith = false;
      this.form.startTime = '';
      this.form.startWindow = '';
      this.form.startExtra = '2';
      this.form.stopExtra = '4';
      this.showRefineOptions = true;
      this.showAdvancedTiming = true;
      this.showGuidePreviewDetails = false;
      this.queueGuidePreview();
      return;
    }

    if (preset === 'series') {
      this.form.matchMode = 'title';
      this.form.startsWith = false;
      this.form.endsWith = false;
      this.form.startTime = '';
      this.form.startWindow = '';
      this.form.startExtra = '';
      this.form.stopExtra = '';
      this.showRefineOptions = false;
      this.showAdvancedTiming = false;
      this.showGuidePreviewDetails = false;
      this.queueGuidePreview();
      return;
    }

    if (preset === 'movies') {
      this.form.matchMode = 'fulltext';
      this.form.startsWith = false;
      this.form.endsWith = false;
      this.form.startTime = '';
      this.form.startWindow = '';
      this.form.startExtra = '3';
      this.form.stopExtra = '10';
      this.showRefineOptions = true;
      this.showAdvancedTiming = true;
      this.showGuidePreviewDetails = false;
      this.queueGuidePreview();
      return;
    }

    this.form.matchMode = 'fulltext';
    this.form.startsWith = false;
    this.form.endsWith = false;
    this.form.startTime = '';
    this.form.startWindow = '30';
    this.form.startExtra = '8';
    this.form.stopExtra = '20';
    this.showRefineOptions = true;
    this.showAdvancedTiming = true;
    this.showGuidePreviewDetails = false;
    this.queueGuidePreview();
  }

  toggleRefineOptions(): void {
    this.showRefineOptions = !this.showRefineOptions;
    if (!this.showRefineOptions) {
      this.showAdvancedTiming = false;
      this.showGuidePreviewDetails = false;
    }
  }

  toggleGuidePreviewDetails(): void {
    this.showGuidePreviewDetails = !this.showGuidePreviewDetails;
  }

  showGuidePreviewPanel(): void {
    this.showGuidePreviewDetails = true;
  }

  getGuidePreviewStatusLine(): string {
    if (this.guidePreviewLoading) {
      return 'Checking TVHeadend guide matches...';
    }

    if (this.guidePreviewError) {
      return this.guidePreviewError;
    }

    return this.getGuidePreviewSummary() || 'Preview updates automatically while you edit title, channel, and mode.';
  }

  stepCreateStartTime(deltaMinutes: number): void {
    this.form.startTime = this.stepTimeString(this.form.startTime, deltaMinutes);
  }

  stepEditStartTime(deltaMinutes: number): void {
    this.editForm.startTime = this.stepTimeString(this.editForm.startTime, deltaMinutes);
  }

  clearCreateStartTime(): void {
    this.form.startTime = '';
  }

  clearEditStartTime(): void {
    this.editForm.startTime = '';
  }

  selectNextCreateConfig(): void {
    this.form.config = this.stepConfigSelection(this.form.config, 1);
  }

  selectPreviousCreateConfig(): void {
    this.form.config = this.stepConfigSelection(this.form.config, -1);
  }

  selectNextEditConfig(): void {
    this.editForm.config = this.stepConfigSelection(this.editForm.config, 1);
  }

  selectPreviousEditConfig(): void {
    this.editForm.config = this.stepConfigSelection(this.editForm.config, -1);
  }

  openConfigPicker(target: ConfigPickerTarget): void {
    this.configPickerTarget = target;
    setTimeout(() => {
      const selected = document.querySelector('[data-autorec-config-option-current="true"]') as HTMLElement | null;
      const first = document.querySelector('[data-autorec-config-option]') as HTMLElement | null;
      (selected || first)?.focus();
    }, 0);
  }

  closeConfigPicker(): void {
    this.configPickerTarget = null;
  }

  getConfigPickerOptions(): Array<{ value: string; label: string }> {
    const options = [{ value: '', label: 'Default DVR config' }];
    for (const config of this.configs) {
      const value = String(config?.uuid || '').trim();
      if (!value) {
        continue;
      }
      options.push({ value, label: this.formatConfigOption(config) });
    }
    return options;
  }

  isConfigOptionSelected(value: string): boolean {
    const selectedValue = this.configPickerTarget === 'edit' ? this.editForm.config : this.form.config;
    return String(selectedValue || '').trim() === String(value || '').trim();
  }

  selectConfigFromPicker(value: string): void {
    if (this.configPickerTarget === 'edit') {
      this.editForm.config = String(value || '').trim();
    } else if (this.configPickerTarget === 'create') {
      this.form.config = String(value || '').trim();
    }
    this.closeConfigPicker();
  }

  private moveConfigPickerFocus(direction: 1 | -1): void {
    const optionNodes = Array.from(document.querySelectorAll('[data-autorec-config-option]')) as HTMLElement[];
    if (optionNodes.length === 0) {
      return;
    }

    const activeElement = document.activeElement as HTMLElement | null;
    const currentIndex = optionNodes.findIndex(option => option === activeElement);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.min(optionNodes.length - 1, Math.max(0, baseIndex + direction));
    optionNodes[nextIndex]?.focus();
  }

  queueGuidePreview(): void {
    const title = String(this.form.title || '').trim();
    const channel = String(this.form.channel || '').trim();
    const matchMode = this.form.matchMode;
    const startsWith = matchMode === 'title' ? this.form.startsWith : false;
    const endsWith = matchMode === 'title' ? this.form.endsWith : false;

    this.guidePreviewError = '';
    this.guidePreviewSearched = !!title;
    this.guidePreviewLoading = !!title;
    this.guidePreviewQuery$.next({ title, channel, matchMode, startsWith, endsWith });

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
    const anchorParts: string[] = [];
    if (this.form.matchMode === 'title') {
      if (this.form.startsWith) {
        anchorParts.push('starts with');
      }
      if (this.form.endsWith) {
        anchorParts.push('ends with');
      }
    }

    const modeLabel = this.form.matchMode === 'fulltext' ? 'Title and details preview' : 'Title preview';
    return anchorParts.length > 0 ? `${modeLabel} with ${anchorParts.join(' and ')} matching` : modeLabel;
  }

  getGuidePreviewHelpText(): string {
    if (this.form.matchMode === 'title' && (this.form.startsWith || this.form.endsWith)) {
      return 'Preview uses the cached guide so Starts with and Ends with match the way the saved rule will behave.';
    }

    return 'Preview refreshes automatically as you type or change scope.';
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

  getChannelSearchPreviewLabels(limit = 6): string[] {
    return this.getFilteredChannels()
      .slice(0, Math.max(1, limit))
      .map(channel => this.formatChannelOption(channel));
  }

  getChannelSearchPreviewChannels(limit = 6): any[] {
    return this.getFilteredChannels().slice(0, Math.max(1, limit));
  }

  getChannelSearchHiddenCount(limit = 6): number {
    return Math.max(0, this.getFilteredChannels().length - Math.max(1, limit));
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

  getEditChannelSearchPreviewLabels(limit = 6): string[] {
    return this.getFilteredEditChannels()
      .slice(0, Math.max(1, limit))
      .map(channel => this.formatChannelOption(channel));
  }

  getEditChannelSearchPreviewChannels(limit = 6): any[] {
    return this.getFilteredEditChannels().slice(0, Math.max(1, limit));
  }

  getEditChannelSearchHiddenCount(limit = 6): number {
    return Math.max(0, this.getFilteredEditChannels().length - Math.max(1, limit));
  }

  selectChannelFromSearch(channel: any): void {
    this.form.channel = String(channel?.uuid || '').trim();
    this.queueGuidePreview();
  }

  selectEditChannelFromSearch(channel: any): void {
    this.editForm.channel = String(channel?.uuid || '').trim();
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
      const displayTitle = this.getRuleDisplayTitle(rule);
      const timeLabel = this.getRuleTimeLabel(rule);

      return {
        ...rule,
        channelname: channelName,
        config_label: configLabel,
        display_title: displayTitle,
        time_label: timeLabel
      };
    });
  }

  private getRuleDisplayTitle(rule: any): string {
    const explicitName = String(rule?.name || '').trim();
    if (explicitName) {
      return explicitName;
    }

    const rawTitlePattern = String(rule?.title || '').trim();
    if (!rawTitlePattern) {
      return 'Untitled Rule';
    }

    const parsed = this.parseStoredTitlePattern(rawTitlePattern);
    if (!parsed.customRegex && parsed.title) {
      return parsed.title;
    }

    return rawTitlePattern;
  }

  private getRuleTimeLabel(rule: any): string {
    const start = this.formatStartMinutesAsTime(rule?.start);
    const startWindow = this.formatOptionalInteger(rule?.start_window);
    const startExtra = this.formatOptionalInteger(rule?.start_extra);
    const stopExtra = this.formatOptionalInteger(rule?.stop_extra);
    const parts: string[] = [];

    if (start) {
      parts.push(`Start ${start}`);
    }
    if (startWindow) {
      parts.push(`Window ${startWindow}m`);
    }

    if (startExtra || stopExtra) {
      const pre = startExtra || '0';
      const post = stopExtra || '0';
      parts.push(`Pad -${pre}m/+${post}m`);
    }

    return parts.join(' • ');
  }

  describeMatchMode(rule: any): string {
    return rule?.fulltext ? 'Title and details match' : 'Title match';
  }

  private bindGuidePreview(): void {
    this.guidePreviewSubscription = this.guidePreviewQuery$.pipe(
      debounceTime(this.previewDebounceMs),
      distinctUntilChanged((left, right) =>
        left.title === right.title
        && left.channel === right.channel
        && left.matchMode === right.matchMode
        && left.startsWith === right.startsWith
        && left.endsWith === right.endsWith
      ),
      switchMap(({ title, channel, matchMode, startsWith, endsWith }) => {
        if (!title) {
          return of({ total: 0, results: [], error: '', searched: false });
        }

        if (matchMode === 'title' && (startsWith || endsWith)) {
          return this.tvh.getGuideData().pipe(
            map(snapshot => this.buildAnchoredGuidePreview(snapshot, title, channel, startsWith, endsWith)),
            map(result => ({ ...result, searched: true })),
            catchError(() => of({ total: 0, results: [], error: 'Guide preview is unavailable right now. Check TVHeadend and try again.', searched: true }))
          );
        }

        if (matchMode === 'fulltext') {
          return this.tvh.getGuideData().pipe(
            map(snapshot => this.buildFulltextGuidePreview(snapshot, title, channel)),
            map(result => ({ ...result, searched: true })),
            catchError(() => this.tvh.searchAutorecPreview(title, channel, true, this.previewSearchLimit).pipe(
              map(entries => ({ ...this.decorateGuidePreview(entries, title), searched: true })),
              catchError(() => of({ total: 0, results: [], error: 'Guide preview is unavailable right now. Check TVHeadend and try again.', searched: true }))
            ))
          );
        }

        return this.tvh.searchAutorecPreview(title, channel, false, this.previewSearchLimit).pipe(
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
          desc: this.extractPreviewDescription(entry),
          extraText: this.extractPreviewExtraText(entry),
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

  private buildAnchoredGuidePreview(
    snapshot: GuideDataSnapshot,
    title: string,
    channelUuid: string,
    startsWith: boolean,
    endsWith: boolean
  ): { total: number; results: any[]; error?: string } {
    const regex = this.buildAnchoredRegex(title, startsWith, endsWith);
    const channelNameById = new Map<string, string>();
    for (const channel of snapshot.channels || []) {
      const channelId = String(channel?.id || '').trim();
      const channelName = String(channel?.name || channelId || '').trim();
      if (channelId) {
        channelNameById.set(channelId, channelName);
      }
    }

    const matchingChannelIds = new Set<string>();
    const normalizedChannelUuid = String(channelUuid || '').trim();
    if (normalizedChannelUuid) {
      for (const [channelId, uuid] of snapshot.channelUuidEntries || []) {
        if (String(uuid || '').trim() === normalizedChannelUuid) {
          matchingChannelIds.add(String(channelId || '').trim());
        }
      }
    }

    const entries = (snapshot.programs || [])
      .filter(program => {
        const channelId = String(program?.channel || '').trim();
        if (matchingChannelIds.size > 0 && !matchingChannelIds.has(channelId)) {
          return false;
        }

        const programTitle = String(program?.title || '').trim();
        return !!programTitle && regex.test(programTitle);
      })
      .map(program => ({
        title: String(program?.title || 'Untitled').trim() || 'Untitled',
        channelName: channelNameById.get(String(program?.channel || '').trim()) || String(program?.channel || 'Unknown Channel').trim() || 'Unknown Channel',
        start: Math.floor(Number(program?.startTime || 0) / 1000),
        stop: Math.floor(Number(program?.endTime || 0) / 1000),
        summary: String(program?.desc || '').trim(),
        extraText: String(program?.extraText || '').trim(),
        category: program?.category || '',
      }));

    return this.decorateGuidePreview(entries, title);
  }

  private buildFulltextGuidePreview(
    snapshot: GuideDataSnapshot,
    queryText: string,
    channelUuid: string
  ): { total: number; results: any[]; error?: string } {
    const queryTokens = this.splitSearchTokens(queryText);
    if (queryTokens.length === 0) {
      return { total: 0, results: [] };
    }

    const channelNameById = new Map<string, string>();
    for (const channel of snapshot.channels || []) {
      const channelId = String(channel?.id || '').trim();
      const channelName = String(channel?.name || channelId || '').trim();
      if (channelId) {
        channelNameById.set(channelId, channelName);
      }
    }

    const matchingChannelIds = new Set<string>();
    const normalizedChannelUuid = String(channelUuid || '').trim();
    if (normalizedChannelUuid) {
      for (const [channelId, uuid] of snapshot.channelUuidEntries || []) {
        if (String(uuid || '').trim() === normalizedChannelUuid) {
          matchingChannelIds.add(String(channelId || '').trim());
        }
      }
    }

    const entries = (snapshot.programs || [])
      .filter(program => {
        const channelId = String(program?.channel || '').trim();
        if (matchingChannelIds.size > 0 && !matchingChannelIds.has(channelId)) {
          return false;
        }

        return this.matchesAllTokens(this.buildProgramSearchText(program), queryTokens);
      })
      .map(program => ({
        title: String(program?.title || 'Untitled').trim() || 'Untitled',
        channelName: channelNameById.get(String(program?.channel || '').trim()) || String(program?.channel || 'Unknown Channel').trim() || 'Unknown Channel',
        start: Math.floor(Number(program?.startTime || 0) / 1000),
        stop: Math.floor(Number(program?.endTime || 0) / 1000),
        summary: String(program?.desc || '').trim(),
        category: program?.category || '',
      }));

    return this.decorateGuidePreview(entries, queryText);
  }

  private buildProgramSearchText(program: any): string {
    return [
      String(program?.title || '').trim(),
      String(program?.desc || '').trim(),
      String(program?.extraText || program?.extra_text || '').trim(),
      String(program?.subtitle || '').trim(),
    ].join(' ').toLowerCase();
  }

  private splitSearchTokens(value: string): string[] {
    return String(value || '')
      .toLowerCase()
      .split(/\s+/)
      .map(token => token.trim())
      .filter(Boolean);
  }

  private matchesAllTokens(haystack: string, tokens: string[]): boolean {
    if (tokens.length === 0) {
      return true;
    }

    const text = String(haystack || '').toLowerCase();
    return tokens.every(token => text.includes(token));
  }

  private extractPreviewDescription(entry: any): string {
    const primary = this.tvh.getEpgPrimaryDescription(entry);
    const extra = this.tvh.getEpgExtraText(entry);
    return this.tvh.mergeGuideDescriptions(primary, extra);
  }

  private extractPreviewExtraText(entry: any): string {
    return this.tvh.getEpgExtraText({
      ...entry,
      extraText: entry?.extraText,
      extra_text: entry?.extra_text,
      subtitle: entry?.subtitle,
    });
  }

  private buildRuleTitlePattern(title: string, matchMode: MatchMode, startsWith: boolean, endsWith: boolean): string {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) {
      return '';
    }

    const escapedTitle = this.escapeRegex(normalizedTitle);
    if (matchMode !== 'title') {
      return escapedTitle;
    }

    const prefix = startsWith ? '^' : '';
    const suffix = endsWith ? '$' : '';
    return `${prefix}${escapedTitle}${suffix}`;
  }

  private parseTimeToMinutes(value: string): number | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return null;
    }

    const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (!match) {
      return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }

    return (hours * 60) + minutes;
  }

  private stepTimeString(value: string, deltaMinutes: number): string {
    const currentMinutes = this.parseTimeToMinutes(value);
    const baseMinutes = currentMinutes === null ? 0 : currentMinutes;
    const minutesPerDay = 24 * 60;
    const stepped = ((baseMinutes + Math.trunc(deltaMinutes)) % minutesPerDay + minutesPerDay) % minutesPerDay;
    const hours = Math.floor(stepped / 60);
    const minutes = stepped % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private stepConfigSelection(currentValue: string, delta: number): string {
    const options = [''].concat(this.configs.map(config => String(config?.uuid || '').trim()).filter(Boolean));
    if (options.length === 0) {
      return '';
    }

    const normalizedCurrent = String(currentValue || '').trim();
    const currentIndex = Math.max(0, options.indexOf(normalizedCurrent));
    const nextIndex = ((currentIndex + Math.trunc(delta)) % options.length + options.length) % options.length;
    return options[nextIndex];
  }

  private formatStartMinutesAsTime(value: any): string {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return '';
    }

    const asMinutes = numeric > (24 * 60) ? Math.floor(numeric / 60) : Math.floor(numeric);
    const wrappedMinutes = ((asMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = Math.floor(wrappedMinutes / 60);
    const minutes = wrappedMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private parseOptionalNonNegativeInteger(value: string): number | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return null;
    }

    if (!/^\d+$/.test(trimmed)) {
      return Number.NaN;
    }

    return Number(trimmed);
  }

  private formatOptionalInteger(value: any): string {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return '';
    }

    return String(Math.floor(numeric));
  }

  private buildAnchoredRegex(title: string, startsWith: boolean, endsWith: boolean): RegExp {
    const pattern = this.buildRuleTitlePattern(title, 'title', startsWith, endsWith);
    return new RegExp(pattern, 'i');
  }

  private parseStoredTitlePattern(pattern: string): ParsedTitlePattern {
    const rawPattern = String(pattern || '').trim();
    if (!rawPattern) {
      return {
        title: '',
        startsWith: false,
        endsWith: false,
        customRegex: false,
        rawPattern: ''
      };
    }

    let startsWith = false;
    let endsWith = false;
    let startIndex = 0;
    let endIndex = rawPattern.length;

    if (rawPattern.startsWith('^')) {
      startsWith = true;
      startIndex = 1;
    }

    if (endIndex > startIndex && rawPattern.endsWith('$') && !this.isEscaped(rawPattern, rawPattern.length - 1)) {
      endsWith = true;
      endIndex -= 1;
    }

    const corePattern = rawPattern.slice(startIndex, endIndex);
    let title = '';
    for (let index = 0; index < corePattern.length; index += 1) {
      const current = corePattern[index];
      if (current === '\\') {
        const next = corePattern[index + 1];
        if (!next || !this.isRegexMetaCharacter(next)) {
          return {
            title: rawPattern,
            startsWith: false,
            endsWith: false,
            customRegex: true,
            rawPattern,
          };
        }

        title += next;
        index += 1;
        continue;
      }

      if (this.isRegexMetaCharacter(current)) {
        return {
          title: rawPattern,
          startsWith: false,
          endsWith: false,
          customRegex: true,
          rawPattern,
        };
      }

      title += current;
    }

    return {
      title,
      startsWith,
      endsWith,
      customRegex: false,
      rawPattern,
    };
  }

  private escapeRegex(value: string): string {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private isRegexMetaCharacter(value: string): boolean {
    return /[.*+?^${}()|[\]\\]/.test(value);
  }

  private isEscaped(value: string, index: number): boolean {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
      slashCount += 1;
    }
    return slashCount % 2 === 1;
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