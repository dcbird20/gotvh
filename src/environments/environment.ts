export const environment = {
  production: false,
  appVersion: '0.1.0',
  appBuildLabel: 'tv-debug-2026-03-21-01',
  appPackageId: 'io.gotvh.app',
  apiUrl: '/api',
  streamUrl: '/stream',
  streamProfile: 'pass',
  nativeBufferedPlayback: false,
  nativeAllowLiveFallback: false,
  nativePlaybackBackend: 'http',
  nativePreferredProfiles: [
    'pass',
    'webtv-h264-aac-matroska',
    'webtv-h264-vorbis-mp4',
    'webtv-h264-aac-mpegts'
  ]
};
