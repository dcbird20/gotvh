import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IdnodeEntry, IdnodeOption, TvheadendService, normalizeEnum, truthy } from '@gotvh/tvh-api';
import { BulkResult, describeBulk, runBulk } from '../../shared/bulk';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';
import { IdnodeFormComponent } from '../../shared/idnode-form/idnode-form.component';
import { GridColumn, IdnodeGridComponent } from '../../shared/idnode-grid.component';
import { AddUserData, AddUserDialogComponent, AddUserResult, ROLE_INFO, UserRole } from './add-user-dialog.component';

/**
 * One row per user. Tvheadend keeps a user's rights (access entry) and
 * password (password entry) as separate records matched only by username;
 * this joins them and points out the gaps that stop someone logging in.
 */
interface UserRow {
  /** Access entry uuid, or the password entry uuid for a password with no access entry. */
  uuid: string;
  kind: 'access' | 'orphan';
  username: string;
  label: string;
  anyone: boolean;
  enabled: boolean;
  admin: boolean;
  webui: boolean;
  streaming: string;
  dvr: string;
  prefix: string;
  comment: string;
  passwd: any | null;
  passwordState: string;
  problem: string;
  access: any | null;
}

type Tab = 'users' | 'blocked';

/** Access entries with this username (or none) apply to anyone connecting from their allowed networks. */
const isAnyone = (username: unknown) => { const u = String(username ?? '').trim(); return u === '' || u === '*'; };

@Component({
  selector: 'admin-users',
  standalone: true,
  imports: [
    FormsModule, MatTabsModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatSlideToggleModule, MatTooltipModule, MatProgressBarModule, MatDialogModule, MatSnackBarModule,
    IdnodeGridComponent, IdnodeFormComponent,
  ],
  templateUrl: './users.component.html',
  styleUrl: './users.component.scss',
})
export class UsersComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  @ViewChild('userGrid') userGrid?: IdnodeGridComponent;
  @ViewChild('blockGrid') blockGrid?: IdnodeGridComponent;
  @ViewChild('accessForm') accessForm?: IdnodeFormComponent;
  @ViewChild('blockForm') blockForm?: IdnodeFormComponent;

  readonly tabIndex = signal(0);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly me = signal('');

  private readonly accessRows = signal<any[]>([]);
  private readonly passwdRows = signal<any[]>([]);
  private readonly streamingLabels = signal(new Map<string, string>());
  private readonly dvrLabels = signal(new Map<string, string>());
  private accessClass: IdnodeEntry | null = null;

  // ---- users tab state
  readonly selectedUuid = signal<string | null>(null);
  readonly fShow = signal<'all' | 'problems' | 'admins' | 'disabled'>('all');
  readonly busy = signal(false);
  newPassword = '';
  confirmPassword = '';

  // ---- blocked networks tab state
  readonly blockEditor = signal<{ uuid: string | null; creating?: boolean } | null>(null);

  readonly rows = computed<UserRow[]>(() => {
    const passwds = this.passwdRows();
    const byName = new Map<string, any>();
    for (const p of passwds) byName.set(String(p?.username || '').toLowerCase(), p);
    const accessNames = new Set<string>();
    const sLabels = this.streamingLabels(), dLabels = this.dvrLabels();
    const label = (m: Map<string, string>, v: unknown) =>
      (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(x => m.get(String(x)) || String(x)).join(', ');

    const rows: UserRow[] = this.accessRows().map(a => {
      const username = String(a?.username ?? '').trim();
      const anyone = isAnyone(username);
      accessNames.add(username.toLowerCase());
      const passwd = anyone ? null : byName.get(username.toLowerCase()) || null;
      const enabled = truthy(a?.enabled) || a?.enabled === 'true';
      let problem = '';
      if (!anyone && enabled && !passwd) problem = 'No password — can’t log in';
      else if (!anyone && enabled && passwd && !(truthy(passwd.enabled) || passwd.enabled === 'true')) problem = 'Password is disabled';
      return {
        uuid: String(a.uuid), kind: 'access', username, anyone,
        label: anyone ? 'Anyone' : username,
        enabled, admin: truthy(a?.admin), webui: truthy(a?.webui),
        streaming: label(sLabels, a?.streaming), dvr: label(dLabels, a?.dvr),
        prefix: String(a?.prefix || ''), comment: String(a?.comment || ''),
        passwd,
        passwordState: anyone ? 'Not needed' : passwd ? ((truthy(passwd.enabled) || passwd.enabled === 'true') ? 'Set' : 'Disabled') : 'None',
        problem, access: a,
      };
    });

    for (const p of passwds) {
      const username = String(p?.username || '').trim();
      if (accessNames.has(username.toLowerCase())) continue;
      rows.push({
        uuid: String(p.uuid), kind: 'orphan', username, anyone: false, label: username || '(no username)',
        enabled: truthy(p?.enabled), admin: false, webui: false, streaming: '', dvr: '', prefix: '',
        comment: String(p?.comment || ''), passwd: p, passwordState: 'Set',
        problem: 'Password but no access rights — can’t log in', access: null,
      });
    }
    return rows;
  });

  readonly rowFilter = computed(() => {
    const show = this.fShow();
    if (show === 'all') return null;
    return (r: UserRow) => show === 'problems' ? !!r.problem : show === 'admins' ? r.admin : !r.enabled;
  });

  readonly problemCount = computed(() => this.rows().filter(r => r.problem).length);
  readonly selected = computed(() => this.rows().find(r => r.uuid === this.selectedUuid()) || null);
  readonly isMe = computed(() => {
    const s = this.selected();
    return !!s && !!this.me() && s.username.toLowerCase() === this.me().toLowerCase();
  });

  readonly userColumns: GridColumn[] = [
    { id: 'label', label: 'User', sortValue: r => (r.anyone ? '' : r.label.toLowerCase()) },
    { id: 'enabled', label: 'Enabled', kind: 'bool' },
    // Problems are shown here, where they arise, rather than in a wide extra column.
    {
      id: 'passwordState', label: 'Password',
      format: (v, r: UserRow) => r.kind === 'orphan' ? 'Set — but no access rights ⚠'
        : r.problem ? `${v} — can’t log in ⚠` : v,
    },
    { id: 'admin', label: 'Admin', kind: 'bool' },
    { id: 'streaming', label: 'Streaming' },
    { id: 'dvr', label: 'Recordings' },
    { id: 'prefix', label: 'Allowed networks', kind: 'mono' },
  ];

  readonly blockColumns: GridColumn[] = [
    { id: 'prefix', label: 'Blocked network', kind: 'mono' },
    { id: 'enabled', label: 'Enabled', kind: 'bool' },
    { id: 'comment', label: 'Comment' },
  ];

  ngOnInit(): void {
    this.tvh.whoami().pipe(catchError(() => of(null))).subscribe(w =>
      this.me.set(String(w?.username || this.tvh.getStoredUsername() || '')));
    this.tvh.idnodeClass('access/entry').pipe(catchError(() => of(null))).subscribe(cls => {
      this.accessClass = cls;
      const labels = (id: string) => new Map((normalizeEnum(cls?.params.find(p => p.id === id)?.enum as any) || [])
        .map((o: IdnodeOption) => [String(o.value), o.label] as [string, string]));
      this.streamingLabels.set(labels('streaming'));
      this.dvrLabels.set(labels('dvr'));
    });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    forkJoin({
      access: this.tvh.getGrid('access/entry/grid'),
      passwd: this.tvh.getGrid('passwd/entry/grid').pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ access, passwd }) => {
        this.accessRows.set(access);
        this.passwdRows.set(passwd);
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.error.set(Number(err?.status) === 403
          ? 'Managing users needs an administrator account.'
          : Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t load users (${err?.status || 'network error'}).`);
      },
    });
  }

  // ---------------------------------------------------------------- selection & editor

  openUser(row: UserRow): void {
    if (row.uuid === this.selectedUuid()) return;
    this.confirmDiscard(this.accessForm).subscribe(ok => {
      if (!ok) return;
      this.selectedUuid.set(row.uuid);
      this.newPassword = '';
      this.confirmPassword = '';
    });
  }

  closeUser(): void {
    this.confirmDiscard(this.accessForm).subscribe(ok => { if (ok) this.selectedUuid.set(null); });
  }

  /** After the access entry is saved: if its username changed, rename the password entry too so they stay linked. */
  onAccessSaved(): void {
    const before = this.selected();
    this.tvh.getGrid('access/entry/grid').subscribe(access => {
      const after = access.find((a: any) => String(a.uuid) === before?.uuid);
      const oldName = before?.username || '', newName = String(after?.username ?? '').trim();
      this.accessRows.set(access);
      if (before?.passwd && after && oldName.toLowerCase() !== newName.toLowerCase() && !isAnyone(newName)) {
        this.tvh.idnodeSave(before.passwd.uuid, { username: newName }).subscribe({
          next: () => { this.snack.open(`Saved — password entry renamed to “${newName}” too`, undefined, { duration: 4000 }); this.load(); },
          error: () => this.snack.open('Saved, but the password entry still has the old username', 'Dismiss', { duration: 6000 }),
        });
      } else {
        this.snack.open('Saved', undefined, { duration: 2500 });
      }
    });
  }

  /**
   * Editing your own access: confirm changes that could lock you out of this
   * app (Admin off, disabled, web interface off, new username or networks).
   */
  readonly accessSaveGuard = (changes: Record<string, unknown>): Observable<boolean> => {
    if (!this.isMe()) return of(true);
    const off = (k: string) => k in changes && !(truthy(changes[k]) || changes[k] === 'true');
    const risks: string[] = [];
    if (off('admin')) risks.push('remove your Admin rights');
    if (off('enabled')) risks.push('disable your account');
    if (off('webui')) risks.push('turn off your web interface access');
    if ('username' in changes) risks.push('change your username');
    if ('prefix' in changes) risks.push('change the networks you can connect from');
    if (!risks.length) return of(true);
    return this.confirm('Change your own access?',
      `This would ${risks.join(', ')}. If it goes wrong you could be locked out of this admin app.`, 'Save anyway');
  };

  // ---------------------------------------------------------------- password section

  passwordError(): string {
    if (!this.newPassword && !this.confirmPassword) return '';
    if (this.newPassword !== this.confirmPassword) return 'Passwords don’t match.';
    return '';
  }

  savePassword(row: UserRow): void {
    if (!this.newPassword || this.passwordError()) return;
    const request = row.passwd
      ? this.tvh.idnodeSave(row.passwd.uuid, { password: this.newPassword })
      : this.tvh.idnodeCreate('passwd/entry', { enabled: 1, username: row.username, password: this.newPassword });
    this.busy.set(true);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.newPassword = this.confirmPassword = '';
        this.snack.open(row.passwd ? 'Password changed' : 'Password set', undefined, { duration: 3000 });
        if (this.isMe() && row.passwd) {
          this.snack.open('Password changed — sign in again with the new one', 'OK', { duration: 8000 });
        }
        this.load();
      },
      error: err => { this.busy.set(false); this.snack.open(`Couldn’t save the password (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }); },
    });
  }

  setPasswordEnabled(row: UserRow, enabled: boolean): void {
    if (!row.passwd) return;
    if (!enabled && this.isMe()) {
      this.snack.open('That’s your own password — disabling it would lock you out', 'OK', { duration: 6000 });
      this.load(); // reset the toggle
      return;
    }
    this.tvh.idnodeSave(row.passwd.uuid, { enabled: enabled ? 1 : 0 }).subscribe({
      next: () => this.load(),
      error: () => { this.snack.open('Couldn’t change the password', 'Dismiss', { duration: 5000 }); this.load(); },
    });
  }

  removePassword(row: UserRow): void {
    if (!row.passwd) return;
    if (this.isMe()) { this.snack.open('That’s your own password — removing it would lock you out', 'OK', { duration: 6000 }); return; }
    this.confirm(`Remove ${row.username}’s password?`,
      `${row.username} won’t be able to log in with a password until a new one is set.`, 'Remove')
      .subscribe(ok => ok && this.tvh.idnodeDelete(row.passwd.uuid).subscribe({
        next: () => { this.snack.open('Password removed', undefined, { duration: 3000 }); this.load(); },
        error: () => this.snack.open('Couldn’t remove the password', 'Dismiss', { duration: 5000 }),
      }));
  }

  /** A password entry with no access entry: give that username rights. */
  grantAccess(row: UserRow, role: UserRole): void {
    const conf = this.accessConf({ username: row.username, password: '', role, prefix: '0.0.0.0/0,::/0', comment: row.comment });
    this.tvh.idnodeCreate('access/entry', conf).subscribe({
      next: res => {
        this.snack.open(`${row.username} can now log in as ${ROLE_INFO[role].label.toLowerCase()}`, undefined, { duration: 4000 });
        this.selectedUuid.set(res?.uuid ? String(res.uuid) : null);
        this.load();
      },
      error: err => this.snack.open(`Couldn’t add access (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
    });
  }

  // ---------------------------------------------------------------- add / delete users

  addUser(): void {
    const taken = this.rows().map(r => r.username.toLowerCase()).filter(Boolean);
    this.dialog.open<AddUserDialogComponent, AddUserData, AddUserResult>(AddUserDialogComponent, { data: { taken } })
      .afterClosed().subscribe(result => {
        if (!result) return;
        this.busy.set(true);
        this.tvh.idnodeCreate('access/entry', this.accessConf(result)).pipe(
          switchMap(res => this.tvh.idnodeCreate('passwd/entry', { enabled: 1, username: result.username, password: result.password })
            .pipe(map(() => res), catchError(() => of({ ...res, passwordFailed: true })))),
        ).subscribe({
          next: (res: any) => {
            this.busy.set(false);
            this.snack.open(res?.passwordFailed
              ? `Added ${result.username}, but setting the password failed — set it in their settings`
              : `Added ${result.username}`, undefined, { duration: 5000 });
            if (res?.uuid) this.selectedUuid.set(String(res.uuid));
            this.load();
          },
          error: err => { this.busy.set(false); this.snack.open(`Couldn’t add the user (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }); },
        });
      });
  }

  /**
   * Rights for a role, using the choices Tvheadend offers for streaming and
   * recordings (read from its access-entry metadata, so labels, not numbers).
   */
  private accessConf(r: AddUserResult): Record<string, unknown> {
    const opts = (id: string) => normalizeEnum(this.accessClass?.params.find(p => p.id === id)?.enum as any);
    const streaming = opts('streaming').map(o => o.value);
    const dvrAll = opts('dvr').map(o => o.value);
    const dvrBasic = opts('dvr').filter(o => /^basic/i.test(o.label)).map(o => o.value);
    return {
      enabled: 1,
      username: r.username,
      prefix: r.prefix,
      comment: r.comment,
      webui: 1,
      admin: r.role === 'admin' ? 1 : 0,
      streaming,
      dvr: r.role === 'viewer' ? (dvrBasic.length ? dvrBasic : dvrAll.slice(0, 1)) : dvrAll,
    };
  }

  deleteUsers(rows: UserRow[]): void {
    if (!rows.length) return;
    if (rows.some(r => this.me() && r.username.toLowerCase() === this.me().toLowerCase())) {
      this.snack.open('You can’t delete the account you’re signed in with', 'OK', { duration: 6000 });
      return;
    }
    const names = rows.slice(0, 3).map(r => `“${r.label}”`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');
    this.confirm(`Delete ${rows.length} ${rows.length === 1 ? 'user' : 'users'}?`,
      `${names} will lose access. Their password ${rows.length === 1 ? 'entry is' : 'entries are'} removed too.`, 'Delete')
      .subscribe(ok => {
        if (!ok) return;
        const uuids = new Set<string>();
        for (const r of rows) {
          if (r.access) uuids.add(String(r.access.uuid));
          if (r.passwd) uuids.add(String(r.passwd.uuid));
        }
        this.busy.set(true);
        runBulk([...uuids], u => this.tvh.idnodeDelete(u)).subscribe(result => {
          this.busy.set(false);
          this.snack.open(result.failed ? describeBulk('Deleted', result, 'record') : `Deleted ${rows.length} ${rows.length === 1 ? 'user' : 'users'}`,
            undefined, { duration: 4000 });
          this.userGrid?.selection.clear();
          if (rows.some(r => r.uuid === this.selectedUuid())) this.selectedUuid.set(null);
          this.load();
        });
      });
  }

  bulkSetEnabled(enabled: boolean): void {
    const rows: UserRow[] = (this.userGrid?.selection.rows() || []).filter((r: UserRow) => r.kind === 'access');
    if (!enabled && rows.some(r => this.me() && r.username.toLowerCase() === this.me().toLowerCase())) {
      this.snack.open('Your own account is in the selection — disabling it would lock you out', 'OK', { duration: 6000 });
      return;
    }
    this.busy.set(true);
    runBulk(rows, r => this.tvh.idnodeSave(r.uuid, { enabled: enabled ? 1 : 0 })).subscribe(result => {
      this.busy.set(false);
      this.snack.open(describeBulk(enabled ? 'Enabled' : 'Disabled', result, 'user'), undefined, { duration: 4000 });
      this.userGrid?.selection.clear();
      this.load();
    });
  }

  selectedUserRows(): UserRow[] {
    return this.userGrid?.selection.rows() || [];
  }

  // ---------------------------------------------------------------- blocked networks

  openBlock(uuid: string | null, creating = false): void {
    this.confirmDiscard(this.blockForm).subscribe(ok => { if (ok) this.blockEditor.set({ uuid, creating }); });
  }

  onBlockSaved(event: { uuid: string | null; created: boolean; bulk?: BulkResult }): void {
    this.snack.open(event.created ? 'Network blocked' : 'Saved', undefined, { duration: 3000 });
    if (event.created) this.blockEditor.set(event.uuid ? { uuid: event.uuid } : null);
    this.blockGrid?.refresh();
  }

  bulkBlock(action: 'enable' | 'disable' | 'delete'): void {
    const grid = this.blockGrid;
    if (!grid) return;
    const uuids = grid.selection.keys();
    const run = () => {
      grid.bulkBusy.set(true);
      runBulk(uuids, u => action === 'delete' ? this.tvh.idnodeDelete(u) : this.tvh.idnodeSave(u, { enabled: action === 'enable' ? 1 : 0 }))
        .subscribe(result => {
          grid.bulkBusy.set(false);
          this.snack.open(describeBulk(action === 'delete' ? 'Removed' : action === 'enable' ? 'Enabled' : 'Disabled', result, 'block'),
            undefined, { duration: 4000 });
          grid.selection.clear();
          if (action === 'delete' && uuids.includes(this.blockEditor()?.uuid || '')) this.blockEditor.set(null);
          grid.refresh();
        });
    };
    if (action !== 'delete') { run(); return; }
    this.confirm(`Remove ${uuids.length} ${uuids.length === 1 ? 'block' : 'blocks'}?`,
      'Clients from these networks will be able to connect again (subject to user access rules).', 'Remove')
      .subscribe(ok => ok && run());
  }

  // ---------------------------------------------------------------- helpers

  private confirm(title: string, message: string, confirm: string): Observable<boolean> {
    const data: ConfirmDialogData = { title, message, confirm, destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }

  private confirmDiscard(form?: IdnodeFormComponent): Observable<boolean> {
    if (!form?.hasUnsavedChanges()) return of(true);
    return this.confirm('Discard changes?', 'You have unsaved changes.', 'Discard');
  }
}
