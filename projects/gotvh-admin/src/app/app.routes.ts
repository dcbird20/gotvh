import { Routes } from '@angular/router';

export interface AdminNavItem {
  path: string;
  label: string;
  icon: string;
  section: 'Overview' | 'DVR' | 'Configuration';
}

/**
 * Single source for the sidebar and the router. Sections that aren't built
 * yet route to a placeholder describing which Tvheadend API they'll use.
 */
export const NAV_ITEMS: AdminNavItem[] = [
  { path: 'dashboard', label: 'Dashboard', icon: 'monitoring', section: 'Overview' },
  { path: 'recordings', label: 'Recordings', icon: 'fiber_manual_record', section: 'DVR' },
  { path: 'autorec', label: 'Auto-record rules', icon: 'event_repeat', section: 'DVR' },
  { path: 'dvr-profiles', label: 'DVR profiles', icon: 'tune', section: 'DVR' },
  { path: 'inputs', label: 'Tuners & networks', icon: 'settings_input_antenna', section: 'Configuration' },
  { path: 'channels', label: 'Channels', icon: 'live_tv', section: 'Configuration' },
  { path: 'epg', label: 'EPG sources', icon: 'calendar_view_week', section: 'Configuration' },
  { path: 'users', label: 'Users & access', icon: 'group', section: 'Configuration' },
  { path: 'streaming', label: 'Stream profiles', icon: 'movie', section: 'Configuration' },
];

const placeholder = (title: string, api: string, notes: string) => ({
  loadComponent: () => import('./pages/placeholder/placeholder.component').then(m => m.PlaceholderComponent),
  data: { title, api, notes },
  title: `${title} · GoTVH Admin`,
});

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard · GoTVH Admin',
    loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'recordings',
    title: 'Recordings · GoTVH Admin',
    loadComponent: () => import('./pages/recordings/recordings.component').then(m => m.RecordingsComponent),
  },
  {
    path: 'autorec',
    ...placeholder('Auto-record rules', 'dvr/autorec/*',
      'The API calls already exist in the shared client (getAutorecs, createAutorec, saveAutorec, deleteAutorec). Needs a table plus an edit form.'),
  },
  {
    path: 'dvr-profiles',
    ...placeholder('DVR profiles', 'dvr/config/* (idnode class "dvrconfig")',
      'Read-only listing exists (getDvrConfigs). Editing is a good first test of a metadata-driven idnode form.'),
  },
  {
    path: 'inputs',
    ...placeholder('Tuners & networks', 'hardware/tree, mpegts/network/*, mpegts/mux/*, mpegts/service/*',
      'Not in the shared client yet. Covers adapters, networks, muxes and services — the stock UI\'s "DVB Inputs" tabs.'),
  },
  {
    path: 'channels',
    ...placeholder('Channels', 'channel/*, channeltag/*',
      'The client reads channels and tags today. Needs create/edit/delete and service-to-channel mapping.'),
  },
  {
    path: 'epg',
    ...placeholder('EPG sources', 'epggrab/config, epggrab/module/*',
      'Not in the shared client yet. Grabber modules, cron schedule, OTA settings.'),
  },
  {
    path: 'users',
    ...placeholder('Users & access', 'access/entry/*, passwd/entry/*',
      'Not in the shared client yet. Access entries and passwords — needs an admin account.'),
  },
  {
    path: 'streaming',
    ...placeholder('Stream profiles', 'profile/*',
      'Not in the shared client yet. Pass-through and transcoding profiles.'),
  },
  { path: '**', redirectTo: 'dashboard' },
];
