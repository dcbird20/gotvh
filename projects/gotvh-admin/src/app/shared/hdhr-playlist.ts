import { TvheadendService, truthy } from '@gotvh/tvh-api';
import { firstValueFrom } from './channel-health';
import { HdhrGuard, parseHdhrTuner } from './hdhomerun';

/**
 * Let the HDHomeRun manage its own tuners.
 *
 * Tvheadend can drive an HDHomeRun two ways:
 *  - native: it claims a specific tuner, tunes it, and has the device send UDP to it. It keeps retrying a
 *    tuner another app holds (never moving on), needs UDP ports forwarded through Docker/VPNs, needs scans,
 *    and a restart can leave tuners locked on the device.
 *  - playlist: an IPTV network on the device's own http://<ip>/lineup.m3u. Each channel is an HTTP stream
 *    (http://<ip>:5004/auto/v23.1) and the device picks any free tuner itself, or answers "busy" so
 *    Tvheadend moves on to a fallback feed.
 * The second has none of those problems, so this moves channels from native feeds to playlist feeds
 * (matched by virtual channel number) and switches the native tuners off.
 */

const on = (v: unknown) => truthy(v) || v === 'true';
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const PLAYLIST_PRIORITY = 5;

export interface HdhrSwitchPlan {
  ip: string;
  /** Native HDHomeRun tuners Tvheadend has switched on. */
  tuners: Array<{ uuid: string; name: string }>;
  /** The device's playlist network, or null when it has to be created. */
  playlist: { uuid: string; name: string; priority: number } | null;
  /** Networks the native tuners scan (switched off afterwards). */
  nativeNets: Array<{ uuid: string; name: string }>;
  /** Channels moving to the playlist feed. */
  moves: Array<{ uuid: string; name: string; number: string; vnum: string; addService: string | null; removeServices: string[]; keep: string[] }>;
  /** Channels with a native feed but no playlist entry for their number: they keep only their other feeds. */
  unmatched: Array<{ uuid: string; name: string; number: string; otherFeeds: number }>;
  /** Priority the playlist network needs to come before other IPTV sources. */
  playlistPriority: number;
}

export async function planHdhrSwitch(tvh: TvheadendService): Promise<HdhrSwitchPlan | null> {
  const [inputs, nets, services, channels] = await Promise.all([
    firstValueFrom(tvh.idnodeLoadByClass('mpegts_input')),
    firstValueFrom(tvh.getGrid('mpegts/network/grid', { hidemode: 'none' })),
    firstValueFrom(tvh.getGrid('mpegts/service/grid', { limit: 100000, hidemode: 'none' })),
    firstValueFrom(tvh.getGrid('channel/grid', { all: 1, limit: 100000 })),
  ]);
  const tuners = inputs.map(e => {
    const v: Record<string, any> = {};
    for (const p of e.params || []) v[p.id] = p.value;
    return { uuid: String(e.uuid || e.id || ''), name: String(v['displayname'] || e.text || ''), enabled: on(v['enabled']), networks: list(v['networks']) };
  }).filter(t => !!parseHdhrTuner(t.name));
  const active = tuners.filter(t => t.enabled);
  if (!active.length) return null;
  const ip = parseHdhrTuner(active[0].name)!.ip;

  const nativeNetIds = new Set(tuners.flatMap(t => t.networks));
  const nativeNets = nets.filter((n: any) => nativeNetIds.has(String(n.uuid)))
    .map((n: any) => ({ uuid: String(n.uuid), name: String(n.networkname || '') }));
  const nativeNames = new Set(nativeNets.map(n => n.name));

  const iptv = nets.filter((n: any) => 'max_streams' in n);
  const pl = iptv.find((n: any) => String(n.url || '').includes(`//${ip}/`) || String(n.url || '').includes(`//${ip}:`));
  const otherTop = Math.max(1, ...iptv.filter((n: any) => n !== pl).map((n: any) => Number(n.priority) || 1));
  const playlistPriority = Math.max(PLAYLIST_PRIORITY, otherTop + 1);

  // Playlist entries by virtual number: mux channel_number "23.1" → its service.
  const plByNum = new Map<string, string>();
  if (pl) {
    const muxes = await firstValueFrom(tvh.getGrid('mpegts/mux/grid', { limit: 100000, hidemode: 'none' }));
    const svcByMux = new Map(services.filter((s: any) => String(s.network) === String(pl.networkname))
      .map((s: any) => [String(s.multiplex_uuid || ''), String(s.uuid)]));
    for (const m of muxes) {
      if (String(m.network_uuid || '') !== String(pl.uuid) && String(m.network || '') !== String(pl.networkname)) continue;
      const num = String(m.channel_number ?? '').trim() || /\/v(\d+\.\d+)/.exec(String(m.iptv_url || ''))?.[1] || '';
      const svc = svcByMux.get(String(m.uuid));
      if (num && svc) plByNum.set(num, svc);
    }
  }
  const svc = new Map(services.map((s: any) => [String(s.uuid), s]));
  const isNative = (u: string) => nativeNames.has(String(svc.get(u)?.network || ''));
  // An antenna service's virtual number: from any channel it's on numbered "x.y", else its LCN.
  const vnumOf = (u: string, ch: any): string => {
    if (/^\d+\.\d+$/.test(String(ch.number))) return String(ch.number);
    const other = channels.find((c: any) => list(c.services).includes(u) && /^\d+\.\d+$/.test(String(c.number)));
    if (other) return String(other.number);
    const s = svc.get(u);
    return s?.lcn ? `${s.lcn}.${s.lcn_minor || 1}` : '';
  };

  const moves: HdhrSwitchPlan['moves'] = [], unmatched: HdhrSwitchPlan['unmatched'] = [];
  for (const ch of channels) {
    if (!on(ch.enabled)) continue;
    const services = list(ch.services);
    const native = services.filter(isNative);
    if (!native.length) continue;
    const rest = services.filter(s => !isNative(s));
    const vnum = native.map(u => vnumOf(u, ch)).find(Boolean) || '';
    const target = plByNum.get(vnum) || null;
    const number = ch.number === 0 || ch.number === '0' || ch.number == null ? '' : String(ch.number);
    if (target || !pl) {
      moves.push({ uuid: String(ch.uuid), name: String(ch.name || ''), number, vnum,
        addService: target && !rest.includes(target) ? target : null, removeServices: native,
        keep: target ? [target, ...rest.filter(s => s !== target)] : rest });
    } else {
      unmatched.push({ uuid: String(ch.uuid), name: String(ch.name || ''), number, otherFeeds: rest.length });
    }
  }
  return {
    ip, tuners: active.map(t => ({ uuid: t.uuid, name: t.name })),
    playlist: pl ? { uuid: String(pl.uuid), name: String(pl.networkname || ''), priority: Number(pl.priority) || 1 } : null,
    nativeNets, moves, unmatched, playlistPriority,
  };
}

export interface HdhrSwitchResult { lines: string[]; failed: boolean }

/** Apply a plan. Channels first, so nothing is left without a feed while tuners go off. */
export async function applyHdhrSwitch(tvh: TvheadendService, guard: HdhrGuard, plan: HdhrSwitchPlan,
                                      progress: (line: string) => void = () => {}): Promise<HdhrSwitchResult> {
  const lines: string[] = [];
  let failed = false;
  const note = (l: string, bad = false) => { lines.push(l); if (bad) failed = true; progress(l); };
  const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
  const save = (uuid: string, conf: Record<string, unknown>) => ok(firstValueFrom(tvh.idnodeSave(uuid, conf)));

  let playlist = plan.playlist;
  if (!playlist) {
    // No playlist network yet: create one and wait for its channels.
    const name = `HDHomeRun ${plan.ip}`;
    const created = await firstValueFrom(tvh.idnodeCreateWithClass('mpegts/network', 'iptv_auto_network', {
      networkname: name, url: `http://${plan.ip}/lineup.m3u`, max_streams: plan.tuners.length,
      priority: plan.playlistPriority, spriority: plan.playlistPriority, refetch_period: 60 * 24,
    })).catch(() => null);
    if (!created) { note('Couldn’t create the HDHomeRun playlist source. Nothing else was changed.', true); return { lines, failed }; }
    note(`Created “${name}” from the HDHomeRun’s channel list; waiting for its channels…`);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const again = await planHdhrSwitch(tvh).catch(() => null);
      if (again?.playlist && again.moves.some(m => m.keep.length)) { plan = again; playlist = again.playlist; break; }
    }
    if (!playlist) { note('The playlist source didn’t list any channels within 90 seconds. Tuners were left on.', true); return { lines, failed }; }
  }

  let moved = 0;
  for (const m of plan.moves) {
    if (await save(m.uuid, { services: m.keep })) moved++;
    else note(`${m.number ? m.number + ' ' : ''}${m.name}: couldn’t change its feeds.`, true);
  }
  if (plan.moves.length) note(`Moved ${moved} ${moved === 1 ? 'channel' : 'channels'} to the HDHomeRun’s own streams.`);
  if (playlist.priority < plan.playlistPriority) {
    if (await save(playlist.uuid, { priority: plan.playlistPriority, spriority: plan.playlistPriority }))
      note(`“${playlist.name}” now comes before your other IPTV sources.`);
  }
  for (const n of plan.nativeNets) if (!(await save(n.uuid, { enabled: false }))) note(`Couldn’t switch off “${n.name}”.`, true);
  let off = 0;
  for (const t of plan.tuners) if (await save(t.uuid, { enabled: false })) off++;
  guard.forgetAll();
  note(`Switched off ${off} native tuner${off === 1 ? '' : 's'}${plan.nativeNets.length ? ' and the ' + plan.nativeNets.map(n => n.name).join(', ') + ' network' : ''}. The HDHomeRun now hands out its tuners itself.`);
  return { lines, failed };
}
