export const environment = {
  production: true,
  appVersion: '0.1.0',
  appBuildLabel: 'tv-debug-2026-03-21-01',
  appPackageId: 'io.gotvh.app',
  apiUrl: 'http://192.168.1.72:9981/api',
  streamUrl: 'http://192.168.1.72:9981',
  streamProfile: 'pass',
  nativeBufferedPlayback: false,
  nativeAllowLiveFallback: true,
  nativePlaybackBackend: 'http',
  nativePreferredProfiles: [
    'pass',
    'webtv-h264-aac-matroska',
    'webtv-h264-vorbis-mp4',
    'webtv-h264-aac-mpegts'
  ]
};
