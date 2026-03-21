import { Routes } from '@angular/router';
import { HomeComponent } from './tv/home/home.component';
import { ChannelsComponent } from './components/channels/channels.component';
import { PlayerComponent } from './tv/player/player.component';
import { EpgComponent } from './tv/epg/epg.component';
import { RecordingsComponent } from './tv/recordings/recordings.component';
import { AutorecComponent } from './tv/autorec/autorec.component';
import { StatusComponent } from './tv/status/status.component';

export const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  { path: 'home',       component: HomeComponent       },
  { path: 'channels',   component: ChannelsComponent   },
  { path: 'player/:channelId', component: PlayerComponent },
  { path: 'epg',        redirectTo: 'guide', pathMatch: 'full' },
  { path: 'guide',      component: EpgComponent        },
  { path: 'recordings', component: RecordingsComponent },
  { path: 'autorec',    component: AutorecComponent    },
  { path: 'status',     component: StatusComponent     },
  { path: '**',         redirectTo: 'home'             },
];
