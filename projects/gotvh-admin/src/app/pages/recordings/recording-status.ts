/**
 * Plain-English explanations for why a recording failed, from Tvheadend's
 * error code (SM_CODE_* in streaming.h) and status text (dvr_entry_status).
 */
export interface FailureExplanation {
  headline: string;
  detail: string;
  /** Where to look next in this app. */
  link?: { label: string; route: string };
  /** The file probably exists and may be watchable. */
  maybeWatchable?: boolean;
}

const LIVE = { label: 'Live status', route: '/status' };
const INPUTS = { label: 'Tuners & networks', route: '/inputs' };
const CHANNELS = { label: 'Channels', route: '/channels' };
const DVR_PROFILES = { label: 'DVR profiles', route: '/dvr-profiles' };
const USERS = { label: 'Users & access', route: '/users' };

const BY_CODE: Record<number, FailureExplanation> = {
  200: { headline: 'All tuners were busy', link: LIVE,
    detail: 'Every tuner that can receive this channel was in use by other recordings or viewers. Recording priorities decide who wins; more tuners avoid it.' },
  202: { headline: 'The tuner was in use', link: LIVE,
    detail: 'Another recording or viewer with the same or higher priority had the tuner this channel needs.' },
  203: { headline: 'The tuner couldn’t tune in', link: LIVE,
    detail: 'The tuner didn’t lock onto the frequency. Check the antenna and signal for this mux.' },
  205: { headline: 'The signal was too weak', link: LIVE,
    detail: 'Reception was too poor to record. Check the antenna, weather, or whether the station changed frequency.' },
  101: { headline: 'The signal was bad', link: LIVE, maybeWatchable: true,
    detail: 'Reception quality dropped during the recording.' },
  107: { headline: 'The stream was weak', link: LIVE, maybeWatchable: true,
    detail: 'The stream had too many errors to record cleanly.' },
  212: { headline: 'No picture or sound arrived', link: CHANNELS,
    detail: 'The tuner locked, but the channel sent no audio or video. The station may have been off air, or the channel points at the wrong service.' },
  201: { headline: 'The channel’s mux is disabled', link: INPUTS,
    detail: 'The frequency (mux) this channel is on is turned off in Tuners & networks.' },
  204: { headline: 'The channel’s service is disabled', link: INPUTS,
    detail: 'The service that feeds this channel is turned off.' },
  211: { headline: 'The channel is disabled', link: CHANNELS, detail: 'The channel is turned off.' },
  207: { headline: 'The channel has no service', link: CHANNELS,
    detail: 'No broadcast service is mapped to this channel, so there was nothing to record.' },
  206: { headline: 'No source was available', link: INPUTS,
    detail: 'None of the channel’s services could be received by any tuner.' },
  208: { headline: 'No tuner can receive this channel', link: INPUTS,
    detail: 'No enabled tuner is connected to the network this channel is on.' },
  209: { headline: 'No tuners are assigned', link: INPUTS,
    detail: 'The channel’s network isn’t linked to any tuner.' },
  210: { headline: 'The service is invalid', link: CHANNELS, detail: 'The channel points at a service that no longer works. Try rescanning its mux.' },
  403: { headline: 'The disk was full', link: DVR_PROFILES,
    detail: 'There wasn’t enough free space where recordings are stored. Free some space or change the DVR profile’s storage settings.' },
  104: { headline: 'The file couldn’t be created', link: DVR_PROFILES,
    detail: 'Tvheadend couldn’t write the file. Check the DVR profile’s storage path exists and is writable.' },
  105: { headline: 'The user wasn’t allowed', link: USERS, detail: 'The owner’s access rules don’t allow recording this.' },
  106: { headline: 'A user limit was reached', link: USERS, detail: 'The owner’s access rules limit how many recordings or streams they can have at once.' },
  300: { headline: 'Stopped by a user', detail: 'Someone stopped or cancelled this recording.' },
  108: { headline: 'Stopped by a user', detail: 'Someone stopped or cancelled this recording.' },
  109: { headline: 'Already recorded before', detail: 'Duplicate detection skipped it because this episode was recorded earlier.' },
  400: { headline: 'The channel is encrypted', detail: 'No descrambler was available for this channel.' },
  401: { headline: 'The channel is encrypted', detail: 'The descrambler refused access to this channel.' },
  402: { headline: 'No input was detected', link: INPUTS, detail: 'The tuner produced no data.' },
};

/** Why a finished-with-problems or failed recording went wrong, or null when it looks fine. */
export function explainRecording(row: any): FailureExplanation | null {
  const status = String(row?.status || '');
  const code = Number(row?.errorcode) || 0;
  if (/too many data errors/i.test(status)) {
    return { headline: 'Too many reception errors', link: LIVE, maybeWatchable: true,
      detail: `The file was recorded but had ${Number(row?.data_errors) || 'many'} data errors, above the limit set in the DVR profile. It may still be watchable.` };
  }
  if (/file missing/i.test(status)) {
    return { headline: 'The file is missing',
      detail: 'The recording finished, but its file is no longer where Tvheadend saved it — it was deleted or moved outside Tvheadend.' };
  }
  if (/time missed/i.test(status) && !BY_CODE[code]) {
    return { headline: 'The start time was missed',
      detail: 'Tvheadend wasn’t running at the start time, or the recording was added after it started.' };
  }
  if (code && code !== 10 && BY_CODE[code]) return BY_CODE[code];
  if (code && code !== 10) return { headline: status || `Error ${code}`, detail: 'Tvheadend reported this error for the recording.' };
  if (status && !/completed ok|scheduled|running|waiting|finished/i.test(status)) {
    return { headline: status, detail: 'Tvheadend reported this status for the recording.' };
  }
  return null;
}
