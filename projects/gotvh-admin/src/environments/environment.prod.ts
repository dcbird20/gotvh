// Prod: the admin app is served by nginx on the same host as the Tvheadend
// proxy (see nginx/gotvh-tvh.conf), so relative paths reach the API.
export const environment = {
  production: true,
  appVersion: '0.1.0',
  apiUrl: '/api',
  streamUrl: '/stream'
};
