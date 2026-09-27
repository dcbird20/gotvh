import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IdnodeEntry, TvheadendService, truthy } from '@gotvh/tvh-api';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/confirm-dialog.component';

const POLL_MS = 2000;

type Quality = 'good' | 'fair' | 'poor' | 'unknown';

interface Meter { text: string; pct: number | null; quality: Quality }

interface TunerStream {
  mux: string;
  subs: number;
  signal: Meter;
  snr: Meter;
  bitrate: string;
  cc: number;
  te: number;
  unc: number;
  ber: string;
  /** Error counters that went up since the previous refresh. */
  rising: string[];
}

interface Tuner {
  uuid: string;
  name: string;
  kind: string;
  enabled: boolean;
  streams: TunerStream[];
}

interface StreamRow {
  id: number;
  recording: boolean;
  what: string;
  channel: string;
  who: string;
  host: string;
  source: string;
  profile: string;
  state: string;
  errors: number;
  rate: string;
  since: string;
  /** Active recording this subscription belongs to, if found. */
  dvrUuid: string | null;
  /** Client connection(s) this stream arrives over, if found. */
  connectionIds: number[];
}

interface ConnectionRow {
  id: number;
  peer: string;
  user: string;
  type: string;
  since: string;
  streams: number;
}

/** 0…65535 relative, or dB × 1000 (scale 2). */
function meter(value: unknown, scale: unknown, kind: 'signal' | 'snr'): Meter {
  const v = Number(value), s = Number(scale);
  if (!Number.isFinite(v) || s === 0 || (s !== 1 && s !== 2)) return { text: '—', pct: null, quality: 'unknown' };
  if (s === 1) {
    const pct = Math.max(0, Math.min(100, Math.round(v / 655.35)));
    return { text: `${pct}%`, pct, quality: pct >= 60 ? 'good' : pct >= 35 ? 'fair' : 'poor' };
  }
  const db = v / 1000;
  if (kind === 'snr') {
    // ATSC needs roughly 15 dB; DVB-T a little less.
    return { text: `${db.toFixed(1)} dB`, pct: Math.max(0, Math.min(100, Math.round(db / 35 * 100))),
      quality: db >= 20 ? 'good' : db >= 15 ? 'fair' : 'poor' };
  }
  return { text: `${db.toFixed(1)} dBm`, pct: Math.max(0, Math.min(100, Math.round((db + 90) / 60 * 100))),
    quality: db >= -65 ? 'good' : db >= -78 ? 'fair' : 'poor' };
}

function rateText(bitsPerSecond: number): string {
  if (!bitsPerSecond) return '—';
  const mbit = bitsPerSecond / 1_000_000;
  return mbit >= 1 ? `${mbit.toFixed(1)} Mbit/s` : `${Math.round(bitsPerSecond / 1000)} kbit/s`;
}

function durationSince(epochSeconds: unknown): string {
  const start = Number(epochSeconds);
  if (!start) return '—';
  const mins = Math.max(0, Math.floor((Date.now() / 1000 - start) / 60));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

/**
 * Live view of tuners, streams and client connections, refreshed every two
 * seconds (Tvheadend's own UI uses a push channel; polling keeps this simple).
 */
@Component({
  selector: 'admin-status',
  standalone: true,
  imports: [RouterLink, MatButtonModule, MatIconModule, MatTableModule, MatTooltipModule, MatProgressBarModule,
    MatDialogModule, MatSnackBarModule],
  templateUrl: './status.component.html',
  styleUrl: './status.component.scss',
})
export class StatusComponent implements OnInit {
  private readonly tvh = inject(TvheadendService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  readonly paused = signal(false);
  readonly error = signal('');
  readonly lastUpdate = signal<Date | null>(null);
  readonly firstLoad = signal(true);

  private readonly inputs = signal<IdnodeEntry[] | null>(null);
  private readonly inputStatus = signal<any[]>([]);
  private readonly subscriptions = signal<any[]>([]);
  private readonly connections = signal<any[]>([]);
  private readonly recordings = signal<any[]>([]);
  /** Previous error counters per tuner stream, to spot ones that are climbing. */
  private previous = new Map<string, { cc: number; te: number; unc: number }>();
  private readonly rising = signal(new Map<string, string[]>());

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  readonly tuners = computed<Tuner[]>(() => {
    const status = this.inputStatus();
    const rising = this.rising();
    const byUuid = new Map<string, any[]>();
    for (const s of status) byUuid.set(String(s.uuid), [...(byUuid.get(String(s.uuid)) || []), s]);

    const known = (this.inputs() || []).map(e => {
      const values: Record<string, any> = {};
      for (const p of e.params || []) values[p.id] = p.value;
      return { uuid: String(e.uuid || e.id || ''), name: String(values['displayname'] || e.text || e.caption || 'Tuner'),
        kind: String(e.caption || ''), enabled: values['enabled'] === undefined ? true : truthy(values['enabled']) };
    });
    // Inputs Tvheadend reports as busy but we couldn't list (e.g. the class load failed).
    for (const uuid of byUuid.keys()) {
      if (!known.some(k => k.uuid === uuid)) {
        known.push({ uuid, name: String(byUuid.get(uuid)![0]?.input || 'Tuner'), kind: '', enabled: true });
      }
    }
    return known.map(k => ({
      ...k,
      streams: (byUuid.get(k.uuid) || []).map(s => ({
        mux: String(s.stream || s.input || ''),
        subs: Number(s.subs) || 0,
        signal: meter(s.signal, s.signal_scale, 'signal'),
        snr: meter(s.snr, s.snr_scale, 'snr'),
        bitrate: rateText(Number(s.bps) || 0),
        cc: Number(s.cc) || 0, te: Number(s.te) || 0, unc: Number(s.unc) || 0,
        ber: Number(s.tc_bit) > 0 ? (Number(s.ec_bit) / Number(s.tc_bit)).toExponential(1) : String(Number(s.ber) || 0),
        rising: rising.get(`${k.uuid}|${s.stream}`) || [],
      })),
    })).sort((a, b) => Number(b.streams.length > 0) - Number(a.streams.length > 0)
      || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  });

  readonly busyTuners = computed(() => this.tuners().filter(t => t.streams.length).length);
  readonly enabledTuners = computed(() => this.tuners().filter(t => t.enabled).length);

  readonly streams = computed<StreamRow[]>(() => {
    const conns = this.connections();
    const recs = this.recordings().filter(r => /record/i.test(String(r?.sched_status || '')));
    return this.subscriptions().map(s => {
      const title = String(s.title || '');
      const recording = /^DVR:/i.test(title);
      const channel = String(s.channel || '');
      const recTitle = title.replace(/^DVR:\s*/i, '');
      const rec = recording ? recs.find(r => (String(r.disp_title || r.title || '') === recTitle)
        && (!channel || String(r.channelname || '') === channel)) || recs.find(r => String(r.channelname || '') === channel) : null;
      const host = String(s.hostname || '');
      const user = String(s.username || '');
      const matches = host ? conns.filter(c => String(c.peer) === host) : [];
      const streaming = matches.filter(c => truthy(c.streaming));
      const byUser = (streaming.length ? streaming : matches).filter(c => !user || String(c.user || '').replace(/^\[|\]$/g, '') === user);
      const connectionIds = (byUser.length ? byUser : streaming.length ? streaming : matches).map(c => Number(c.id)).filter(Boolean);
      return {
        id: Number(s.id),
        recording,
        what: recording ? `Recording “${recTitle}”` : [s.client, title].filter(Boolean).join(' · ') || 'Stream',
        channel: channel || '—',
        who: recording ? 'Recorder' : [user, host].filter(Boolean).join(' @ ') || '—',
        host,
        source: String(s.service || ''),
        profile: String(s.profile || ''),
        state: String(s.state || ''),
        errors: Number(s.errors) || 0,
        rate: rateText((Number(s.out) || Number(s.in) || 0) * 8),
        since: durationSince(s.start),
        dvrUuid: rec ? String(rec.uuid) : null,
        connectionIds,
      };
    }).sort((a, b) => Number(b.recording) - Number(a.recording) || a.channel.localeCompare(b.channel));
  });

  readonly connectionRows = computed<ConnectionRow[]>(() => {
    const subs = this.subscriptions();
    return this.connections().map(c => ({
      id: Number(c.id),
      peer: `${c.peer || '?'}${c.peer_port ? ':' + c.peer_port : ''}`,
      user: String(c.user || '').replace(/^\[|\]$/g, '') || '—',
      type: String(c.type || '—'),
      since: durationSince(c.started),
      streams: subs.filter(s => String(s.hostname || '') === String(c.peer || '')).length,
    }));
  });

  readonly streamColumns = ['what', 'channel', 'who', 'source', 'state', 'rate', 'since', 'actions'];
  readonly connColumns = ['peer', 'user', 'type', 'streams', 'since', 'actions'];

  ngOnInit(): void {
    this.tvh.idnodeLoadByClass('mpegts_input').pipe(catchError(() => of(null))).subscribe(list => this.inputs.set(list || []));
    this.poll();
    this.timer = setInterval(() => { if (!this.paused() && !document.hidden) this.poll(); }, POLL_MS);
    this.destroyRef.onDestroy(() => { if (this.timer) clearInterval(this.timer); });
  }

  togglePause(): void {
    this.paused.update(p => !p);
    if (!this.paused()) this.poll();
  }

  poll(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    forkJoin({
      inputs: this.tvh.getInputStatus(),
      subs: this.tvh.getSubscriptionStatus(),
      conns: this.tvh.getConnectionStatus().pipe(catchError(() => of([]))),
      recs: this.tvh.getGrid('dvr/entry/grid_upcoming').pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ inputs, subs, conns, recs }) => {
        this.inFlight = false;
        this.trackRising(inputs);
        this.inputStatus.set(inputs);
        this.subscriptions.set(subs);
        this.connections.set(conns);
        this.recordings.set(recs);
        this.error.set('');
        this.lastUpdate.set(new Date());
        this.firstLoad.set(false);
      },
      error: err => {
        this.inFlight = false;
        this.firstLoad.set(false);
        this.error.set(Number(err?.status) === 403 ? 'Live status needs an administrator account.'
          : Number(err?.status) === 401 ? 'Sign in required — use Sign in at the top right.'
          : `Couldn’t reach Tvheadend (${err?.status || 'network error'}) — retrying.`);
      },
    });
  }

  private trackRising(inputs: any[]): void {
    const next = new Map<string, { cc: number; te: number; unc: number }>();
    const rising = new Map<string, string[]>();
    for (const s of inputs) {
      const key = `${s.uuid}|${s.stream}`;
      const now = { cc: Number(s.cc) || 0, te: Number(s.te) || 0, unc: Number(s.unc) || 0 };
      const before = this.previous.get(key);
      if (before) {
        const up = (['cc', 'te', 'unc'] as const).filter(k => now[k] > before[k]);
        if (up.length) rising.set(key, up);
      }
      next.set(key, now);
    }
    this.previous = next;
    this.rising.set(rising);
  }

  // ---------------------------------------------------------------- actions

  clearStats(t: Tuner): void {
    this.tvh.clearInputStats(t.uuid).subscribe({
      next: () => { this.snack.open(`Error counters reset for ${t.name}`, undefined, { duration: 2500 }); this.poll(); },
      error: () => this.snack.open('Couldn’t reset the counters', 'Dismiss', { duration: 5000 }),
    });
  }

  stopRecording(row: StreamRow): void {
    if (!row.dvrUuid) return;
    this.confirm('Stop this recording?', `${row.what} on ${row.channel} stops now. What’s been recorded so far is kept.`, 'Stop recording')
      .subscribe(ok => ok && this.tvh.stopRecording(row.dvrUuid!).subscribe({
        next: () => { this.snack.open('Recording stopped', undefined, { duration: 3000 }); this.poll(); },
        error: err => this.snack.open(`Couldn’t stop the recording (${err?.status || 'network error'})`, 'Dismiss', { duration: 6000 }),
      }));
  }

  disconnectStream(row: StreamRow): void {
    const conns = this.connectionRows().filter(c => row.connectionIds.includes(c.id));
    const others = conns.reduce((n, c) => n + c.streams, 0) - 1;
    this.disconnect(conns.map(c => c.id), `Disconnect ${row.host}?`,
      `This closes the client’s connection${conns.length > 1 ? 's' : ''}, ending “${row.channel}”`
      + (others > 0 ? ` and ${others} other stream${others === 1 ? '' : 's'} from the same client` : '')
      + '. Apps like Kodi may reconnect by themselves.');
  }

  disconnectConnection(c: ConnectionRow): void {
    this.disconnect([c.id], `Disconnect ${c.peer}?`,
      `${c.user !== '—' ? c.user + '’s' : 'This'} ${c.type} connection closes`
      + (c.streams ? `, ending ${c.streams} stream${c.streams === 1 ? '' : 's'}` : '') + '. Apps like Kodi may reconnect by themselves.');
  }

  private disconnect(ids: number[], title: string, message: string): void {
    if (!ids.length) return;
    this.confirm(title, message, 'Disconnect').subscribe(ok => {
      if (!ok) return;
      forkJoin(ids.map(id => this.tvh.cancelConnection(id).pipe(catchError(() => of('failed'))))).subscribe(results => {
        this.snack.open(results.includes('failed') ? 'Some connections couldn’t be closed' : 'Disconnected', undefined, { duration: 3000 });
        this.poll();
      });
    });
  }

  private confirm(title: string, message: string, confirm: string): Observable<boolean> {
    const data: ConfirmDialogData = { title, message, confirm, destructive: true };
    return this.dialog.open(ConfirmDialogComponent, { data }).afterClosed();
  }

  readonly errorLabels: Record<string, string> = { cc: 'continuity', te: 'transport', unc: 'uncorrected' };
  isIptv(t: Tuner): boolean {
    return /iptv/i.test(`${t.kind} ${t.name}`);
  }

  risingText(s: TunerStream): string {
    return s.rising.map(k => this.errorLabels[k]).join(', ');
  }
}
