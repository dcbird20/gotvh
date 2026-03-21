# GoTVH — Google TV Interface for TVHeadend

A modern Angular-based frontend for TVHeadend optimized for Google TV and D-pad navigation.

## Features

- **Phase 1-3 Implemented** ✅
  - TV Shell Layout with collapsing sidebar
  - Spatial navigation (D-pad/arrow keys)
  - Material Design Dark Theme
  - Home screen with hero banner & content shelves
  - Channels screen with grid & detail panel

- **Planned (Phase 4+)**
  - EPG/Guide view with timeline navigation
  - Recordings management (upcoming, finished, failed)
  - Auto-recording & timer recording rules
  - Server status monitoring
  - Full playback with media controls
  - On-screen keyboard for search

## Development

Setup:

```bash
cd /home/dcrow/Code/gotvh
npm install
```

or use the symlinked node_modules from the source project.

Run development server:

```bash
ng serve
```

Navigate to `http://localhost:4200/`. The app will auto-reload when you change source files.

Build for production:

```bash
ng build --prod
```

## Navigation

- **D-Pad / Arrow Keys**: Navigate between focusable elements
- **Enter / Space**: Activate button or trigger action
- **Mouse**: Click elements or hover over sidebar to expand

## Architecture

- **Services**: `TvheadendService` (API client), `SpatialNavService` (keyboard navigation)
- **Directives**: `TvFocusableDirective` (makes elements spatially navigable)
- **Components**: Shell layout, Home screen, Channels screen
- **Styling**: SCSS with CSS custom properties for theming

## Proxy Configuration

Configure `proxy.conf.json` to point to your TVHeadend instance:

```json
{
  "/api": {
    "target": "http://localhost:9981",
    "changeOrigin": true
  }
}
```

## License

Based on tvheadend-frontend. See LICENSE file for details.
