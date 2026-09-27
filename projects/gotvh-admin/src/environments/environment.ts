// Dev: `npm run start:admin` serves on :4300 and proxies /api to Tvheadend
// through the shared proxy.conf.json.
export const environment = {
  production: false,
  appVersion: '0.1.0',
  apiUrl: '/api',
  streamUrl: '/stream'
};
