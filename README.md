# GoTVH — Google TV Interface for TVHeadend

A modern Angular-based frontend for TVHeadend optimized for Google TV and D-pad navigation.

## Features

- **Google TV-first shell**
  - Collapsing sidebar and D-pad-first layout
  - Spatial navigation with focus restoration across routes
  - Playback return context for Home, Channels, Guide, and Recordings

- **Live TV browsing**
  - Home screen with hero banner and content shelves
  - Channels screen with grid selection, detail strip, favorites, and direct playback on select
  - Full player route with transport diagnostics and return navigation

- **Guide and DVR workflows**
  - TV-first EPG with timeline and vertical guide modes
  - Quick timeline jumps, channel paging, and remote-friendly shortcuts
  - Recordings management for upcoming, finished, and failed entries
  - Auto-record rule management
  - Status and server diagnostics views

## Development

Setup:

```bash
cd gotvh
npm install
```

or use the symlinked node_modules from the source project.

Run development server:

```bash
./node_modules/.bin/ng serve --port 4200
```

Navigate to `http://localhost:4200/`. The app will auto-reload when you change source files.

Build for production:

```bash
npm run build
```

Build a debug APK that uses the production TVHeadend backend URLs:

```bash
npm run build:debug-apk
```

Use `npm run build:dev` only for local browser builds that rely on the `/api` dev proxy.

## Android Release Signing

Android release signing is intentionally local-only.

- Copy [android/keystore.properties.example](android/keystore.properties.example) to `android/keystore.properties`
- Point `storeFile` at your local keystore path
- Keep the real `android/keystore.properties` file and any `*.keystore` file out of git

The Android build also accepts these environment variables if you prefer not to use a local properties file:

- `GOTVH_RELEASE_STORE_FILE`
- `GOTVH_RELEASE_STORE_PASSWORD`
- `GOTVH_RELEASE_KEY_ALIAS`
- `GOTVH_RELEASE_KEY_PASSWORD`

## Admin app (gotvh-admin)

The workspace holds a second Angular app for mouse/keyboard admin work. It's a plain
desktop web app (Angular Material, compact tables), not part of the Android build.

```bash
npm run start:admin   # dev server on http://localhost:4300, uses proxy.conf.json
npm run build:admin   # production build -> dist/gotvh-admin/browser
```

Serve `dist/gotvh-admin/browser` from nginx on the same host as the Tvheadend proxy
(`nginx/gotvh-tvh.conf`) so its relative `/api` calls reach Tvheadend.

Built so far:

- **Dashboard** — server info, subscriptions, connections
- **Recordings** — sortable, filterable table (read-only)
- **Auto-record rules** — table with enable toggles, side-panel editor (match, channel,
  time window, days, padding, DVR profile), live preview of upcoming guide matches, delete

- **DVR profiles** — list plus a generic editor built from Tvheadend's field metadata
  (see below); create, edit, delete

- **Tuners & networks** — tuner hardware tree, networks (add by type, scan), muxes and
  services in server-paged tables; everything opens in the generic editor

Other sections are placeholders naming the API they'll use.

### Generic config editor

Most Tvheadend config objects are "idnodes", and the API describes their fields (type,
label, choices, read-only, basic/advanced/expert level). `IdnodeFormComponent`
(`projects/gotvh-admin/src/app/shared/idnode-form/`) renders any of them from that
description — pass `uuid` to edit or `createPath` (e.g. `dvr/config`) to create. It only
saves fields you changed. New config sections should reuse it rather than hand-build forms.

`IdnodeGridComponent` (`shared/idnode-grid.component.ts`) is its list counterpart: a
server-paged, sortable, filterable table for any `…/grid` endpoint. Rule helpers shared with the
TV app live in `projects/tvh-api/src/autorec-rules.ts`.

## Workspace layout

| Path | What it is |
| --- | --- |
| `src/` | TV app (`gotvh`) — Google TV / D-pad UI, packaged by Capacitor |
| `projects/gotvh-admin/` | Admin app — desktop web UI |
| `projects/tvh-api/` | Shared Tvheadend API client, imported as `@gotvh/tvh-api` |

Each app passes its connection settings to the shared client through the
`TVH_API_CONFIG` injection token (see `src/main.ts`, `projects/gotvh-admin/src/main.ts`).

## Navigation

- **D-Pad / Arrow Keys**: Navigate between focusable elements
- **Enter / Space**: Activate button or trigger action
- **Mouse**: Click elements or hover over sidebar to expand

## Architecture

- **Services**: `TvheadendService` (API client, in `projects/tvh-api`), `SpatialNavService` (keyboard navigation)
- **Directives**: `TvFocusableDirective` (makes elements spatially navigable)
- **Components**: Shell layout, Home, Channels, Guide, Recordings, Auto-Rec, Status, Player
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
