import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
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
    this.tvh.getAutorecs().subscribe({
      next: (rules) => {
        this.rules = rules;
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
      const sameRule = document.querySelector(`[data-autorec-delete-uuid="${escapedUuid}"]`) as HTMLElement | null;
      const fallback = document.querySelector('[data-autorec-delete-uuid], [data-autorec-refresh]') as HTMLElement | null;
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