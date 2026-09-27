import { InjectionToken } from '@angular/core';

/**
 * Connection and playback settings for the Tvheadend API client.
 *
 * Each app provides its own value (usually its `environment` object), so the
 * shared client never imports an app's environment file directly.
 */
export interface TvhApiConfig {
  /** Full API base, e.g. `/api` (dev proxy) or `http://192.168.1.72:9981/api`. */
  apiUrl?: string;
  /** Used only when `apiUrl` is not set. */
  apiProtocol?: string;
  apiHost?: string;
  apiPort?: number | string;

  /** Stream base, e.g. `/stream` or `http://192.168.1.72:9981`. */
  streamUrl?: string;
  streamProfile?: string;

  /** Native (Capacitor) playback tuning — ignored by browser-only apps. */
  nativeBufferedPlayback?: boolean;
  nativeAllowLiveFallback?: boolean;
  nativePlaybackBackend?: string;
  nativePreferredProfiles?: string[];

  [key: string]: unknown;
}

export const TVH_API_CONFIG = new InjectionToken<TvhApiConfig>('TVH_API_CONFIG');
