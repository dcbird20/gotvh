import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';


@Component({
  selector: 'app-tv-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './tv-card.component.html',
  styleUrls: ['./tv-card.component.scss']
})
export class TvCardComponent {
  @Input() title = '';
  @Input() subtitle = '';
  @Input() meta = '';
  @Input() badge = '';
  @Input() channelNumber: number | string = '';
}
