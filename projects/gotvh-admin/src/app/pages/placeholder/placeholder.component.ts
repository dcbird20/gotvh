import { Component, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

/** Stand-in for admin sections that aren't built yet. Inputs come from route data. */
@Component({
  selector: 'admin-placeholder',
  standalone: true,
  imports: [MatCardModule],
  template: `
    <div class="admin-page">
      <h1>{{ title() }}</h1>
      <p class="subtitle">Not built yet.</p>
      <mat-card appearance="outlined">
        <mat-card-content>
          <p><strong>Tvheadend API:</strong> <code>{{ api() }}</code></p>
          <p class="muted">{{ notes() }}</p>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`p { margin: 8px 0; } mat-card { max-width: 720px; }`],
})
export class PlaceholderComponent {
  readonly title = input('');
  readonly api = input('');
  readonly notes = input('');
}
