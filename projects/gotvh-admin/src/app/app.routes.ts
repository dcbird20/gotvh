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
    title: 'Auto-record rules · GoTVH Admin',
    loadComponent: () => import('./pages/autorec/autorec.component').then(m => m.AutorecComponent),
  },
  {
    path: 'dvr-profiles',
    title: 'DVR profiles · GoTVH Admin',
    loadComponent: () => import('./pages/dvr-profiles/dvr-profiles.component').then(m => m.DvrProfilesComponent),
  },
  {
    path: 'inputs',
    title: 'Tuners & networks · GoTVH Admin',
    loadComponent: () => import('./pages/inputs/inputs.component').then(m => m.InputsComponent),
  },
  {
    path: 'channels',
    title: 'Channels · GoTVH Admin',
    loadComponent: () => import('./pages/channels/channels.component').then(m => m.ChannelsComponent),
  },
  {
    path: 'epg',
    title: 'EPG sources · GoTVH Admin',
    loadComponent: () => import('./pages/epg/epg.component').then(m => m.EpgComponent),
  },
  {
    path: 'users',
    title: 'Users & access · GoTVH Admin',
    loadComponent: () => import('./pages/users/users.component').then(m => m.UsersComponent),
  },
  {
    path: 'streaming',
    title: 'Stream profiles · GoTVH Admin',
    loadComponent: () => import('./pages/stream-profiles/stream-profiles.component').then(m => m.StreamProfilesComponent),
  },
  { path: '**', redirectTo: 'dashboard' },
];
