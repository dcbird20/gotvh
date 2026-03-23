import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';


@Component({
  selector: 'app-tv-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './tv-card.component.html',
  styleUrls: ['./tv-card.component.scss']
})
export class TvCardComponent implements OnChanges {
  @Input() title = '';
  @Input() subtitle = '';
  @Input() meta = '';
  @Input() badge = '';
  @Input() channelNumber: number | string = '';
  @Input() icon = '';

  brokenIcon = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['icon']) {
      this.brokenIcon = false;
    }
  }

  hasRenderableIcon(): boolean {
    return !!String(this.icon || '').trim() && !this.brokenIcon;
  }

  handleIconError(): void {
    this.brokenIcon = true;
  }
}
