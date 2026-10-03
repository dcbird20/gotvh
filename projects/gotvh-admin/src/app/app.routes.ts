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
  { path: 'guide', label: 'Guide', icon: 'view_timeline', section: 'Overview' },
  { path: 'status', label: 'Live status', icon: 'sensors', section: 'Overview' },
  { path: 'recordings', label: 'Recordings', icon: 'fiber_manual_record', section: 'DVR' },
  { path: 'autorec', label: 'Auto-record rules', icon: 'event_repeat', section: 'DVR' },
  { path: 'timers', label: 'Timers', icon: 'schedule', section: 'DVR' },
  { path: 'dvr-profiles', label: 'DVR profiles', icon: 'tune', section: 'DVR' },
  { path: 'add-source', label: 'Add a source', icon: 'add_circle', section: 'Configuration' },
  { path: 'inputs', label: 'Tuners & networks', icon: 'settings_input_antenna', section: 'Configuration' },
  { path: 'map-services', label: 'Map services', icon: 'playlist_add', section: 'Configuration' },
  { path: 'channels', label: 'Channels', icon: 'live_tv', section: 'Configuration' },
  { path: 'channel-tags', label: 'Channel tags', icon: 'label', section: 'Configuration' },
  { path: 'epg', label: 'EPG sources', icon: 'calendar_view_week', section: 'Configuration' },
  { path: 'users', label: 'Users & access', icon: 'group', section: 'Configuration' },
  { path: 'devices', label: 'Devices', icon: 'devices', section: 'Configuration' },
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
    path: 'guide',
    title: 'Guide · GoTVH Admin',
    loadComponent: () => import('./pages/guide/guide.component').then(m => m.GuideComponent),
  },
  {
    path: 'status',
    title: 'Live status · GoTVH Admin',
    loadComponent: () => import('./pages/status/status.component').then(m => m.StatusComponent),
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
    path: 'timers',
    title: 'Timers · GoTVH Admin',
    loadComponent: () => import('./pages/timers/timers.component').then(m => m.TimersComponent),
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
    path: 'devices',
    title: 'Devices · GoTVH Admin',
    loadComponent: () => import('./pages/devices/devices.component').then(m => m.DevicesComponent),
  },
  {
    path: 'add-source',
    title: 'Add a source · GoTVH Admin',
    loadComponent: () => import('./pages/add-source/add-source.component').then(m => m.AddSourceComponent),
  },
  {
    path: 'map-services',
    title: 'Map services · GoTVH Admin',
    loadComponent: () => import('./pages/map-services/map-services.component').then(m => m.MapServicesComponent),
  },
  {
    path: 'channel-tags',
    title: 'Channel tags · GoTVH Admin',
    loadComponent: () => import('./pages/channel-tags/channel-tags.component').then(m => m.ChannelTagsComponent),
  },
  {
    path: 'streaming',
    title: 'Stream profiles · GoTVH Admin',
    loadComponent: () => import('./pages/stream-profiles/stream-profiles.component').then(m => m.StreamProfilesComponent),
  },
  { path: '**', redirectTo: 'dashboard' },
];
