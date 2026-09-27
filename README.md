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
npm run start:admin   # dev server on http://localhost:4400, uses proxy.conf.json
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
  services in server-paged tables; everything opens in the generic editor.
  **Add mux** (Muxes tab, or from an open network) adds a frequency or IPTV stream by hand
  with the fields for that network's type. **Map unmapped services…** (Services tab) or
  **Map to channels…** on selected services runs Tvheadend's service mapper: it says what
  will be left out (already mapped, disabled, radio, encrypted), explains each option
  (merge same name, tidy names, tags, check availability) and shows progress

- **Live status** — refreshes every 2 s (pause button). Every tuner, busy or idle, with
  signal and SNR (percent or dB, coloured good/fair/poor), bitrate and error counters; a
  warning when errors are climbing between refreshes; reset counters. Streams and
  recordings with channel, client, tuner/service, profile, state and rate: **Stop
  recording** (keeps what's recorded) or **Disconnect** the client. Connected clients with
  disconnect. Tuners come from `idnode/load` class `mpegts_input`; streams can only be
  ended by closing their connection (`connections/cancel`), as in the stock UI.

- **Recordings (details)** — click a recording to open it: channel, times and padding,
  status, file, size and errors; for failed ones **why it failed** in plain English (all
  tuners busy, weak signal, disk full, channel not set up …) with a link to where to fix
  it. Actions: stop (in progress), cancel, download, delete, **Record next airing**, and
  **Keep it anyway** for recordings with too many errors that are still watchable. The
  generic editor below edits title, start/stop (date-time pickers), padding, channel,
  priority and DVR profile. **New recording** schedules a one-off by channel, date and time.
- **Timers** — record a channel at a fixed time on chosen days (`dvr/timerec`), with
  days shown as Weekdays / Weekends / Mon, Wed …; create, edit, bulk edit/enable/delete.

- **Map services** — every service not on a channel yet, grouped by network, with the
  channel each will become: name and number (from the broadcast's LCN / ATSC major.minor)
  editable in place; TV ticked, radio/data/encrypted not; one channel per name so the same
  station on antenna and IPTV is fed by both; names matching an existing channel are added
  to it; numbers already in use or repeated are flagged. Creates the channels directly
  (`channel/create`, or adds services to existing ones), then points to guide matching.

- **Channels** — all channels loaded once and filtered in the browser: search name or
  number, filter by Enabled, Tags (any of / no tags), Network (via the channel's services)
  and service count; Network column; every column sortable (numbers sort 3.2 < 3.10 < 100).
  Create, edit, delete, bulk edit.

- **Channel tags** — each tag with its channel count, order, visibility (shown / private /
  hidden from clients) and the auto-record rules and users limited to it. **Change order…**
  drags tags into the order clients list them. **Show these channels** opens Channels
  filtered to the tag (`/channels?tag=<uuid>`, or `?tag=none` for untagged channels).
  Deleting warns when rules would then match every channel or users' access would change.

- **EPG sources** — grabber modules (enable/disable, per-grabber settings, run internal
  grabbers or an over-the-air grab now), global grabber settings incl. cron schedules
  (`epggrab/config`), and the grabbers' channel list with mapped/unmapped and grabber filters.
  **Map unmapped by name…** proposes a channel for each unmapped guide channel (same number,
  then same name ignoring HD/punctuation, then similar name; ties left for you) and applies
  the reviewed pairs, keeping existing links. Channels show an EPG source column/filter, and
  the channel editor shows EPG source on the Basic view.

- **Users & access** — one row per user, joining Tvheadend's separate access entries and
  password entries by username; flags users who can't log in (no password, password
  disabled, password without access rights). **Add user** picks a role (viewer / recorder /
  administrator) and creates both records; the side panel edits rights and sets, changes,
  disables or removes the password; renaming a user renames its password entry too.
  Changes that could lock out the signed-in account ask first, and it can't be deleted or
  disabled. **Blocked networks** tab manages `ipblock/entry`.

- **Stream profiles** — every profile with its type in plain English (pass-through,
  HTSP, Matroska, transcode …), whether it's built in, the default, and which DVR
  profiles and users pick it. **Add profile** explains each type; **Make default**;
  deleting says what falls back to pass-through. Built-in and default profiles can't be
  deleted. The **Codec profiles** tab (only when Tvheadend has transcoding built in)
  manages the encoder settings Transcode profiles use, and shows which profiles use each.

Other sections are placeholders naming the API they'll use.

### Testing against the spare server (omv-dell)

`npm run start:admin:omv` serves the admin app on port 4401 with `/api` proxied to the
Tvheadend on omv-dell (`192.168.1.222:9983`, see `proxy.omv-dell.conf.json`). It listens on
all interfaces, so another machine on the LAN can open `http://raven1:4401`. Use it for
anything risky (stream profiles, users, deleting built-ins) before trying it on the main
server.

### Connected to

Channels and everything on Tuners & networks show a **Connected to** card under the editor:
where the object sits in the chain tuner → network → mux → service → channel → guide data.
Every item is a link (e.g. a channel's service → its mux → its network → the tuners that
use it), and a broken link is flagged: a channel with no service, a service not on a
channel, a network no tuner uses, a tuner with no network, services not yet mapped.
Links are plain URLs (`/inputs?tab=muxes&open=<uuid>`, `/channels?open=<uuid>`,
`/channel-tags?open=<uuid>`), so they can be bookmarked or shared.

### Side panel

Every screen with an editor beside the table shares one panel width: drag the line between
table and panel to resize (or focus it and use ←/→), and click the arrow on it — or
double-click the line — to switch between normal and wide. The width is remembered. A wide
editor lays its fields out in two columns. Recordings splits its panel into **Details**
(opens first for finished/failed) and **Edit** (opens first for upcoming).

### Selecting several rows

Works the same in every table (and like the stock Tvheadend grids):

- **Click** a row — selects just that row (and opens it, where there's an editor).
- **Shift-click** another row — selects everything from the first click to that row.
  Shift-click again to grow or shrink the range.
- **Ctrl/⌘-click** — add or remove one row. **Ctrl/⌘+Shift-click** adds another range.
- **Checkboxes** add or remove one row; Shift on a checkbox adds a range.
- **Header checkbox** — the whole page; then **Select all N (matching)** in the bar grabs
  every row matching the current filter across all pages.

A bar with bulk actions appears while rows are selected. Shared pieces: `RowSelection`
(`shared/row-selection.ts`), `runBulk` (`shared/bulk.ts`) and `admin-bulk-bar`.

### Changing a setting on many items

Select rows, then **Edit…** in the selection bar (networks, muxes, services, channels).
The editor opens in bulk mode showing the first item's values. Changing a field ticks
its checkbox; you can also tick a field to push the shown value as-is. Only ticked
fields are written, to every selected item. List fields such as channel tags have an
**Add / Remove / Replace** switch (default Add): Add and Remove merge into each item's own
list, so other tags are kept; Replace sets the same list on all.

IPTV muxes' **Channel tags** (`iptv_tags`, one tag name per line — applied to channels
when the mux's services are mapped) is shown as a tag picker suggesting existing channel
tags, with the same Add / Remove / Replace in bulk edit. Other name-list fields can be
added to `NAME_LIST_FIELDS` in the editor.

### Generic config editor

Most Tvheadend config objects are "idnodes", and the API describes their fields (type,
label, choices, read-only, basic/advanced/expert level). `IdnodeFormComponent`
(`projects/gotvh-admin/src/app/shared/idnode-form/`) renders any of them from that
description — pass `uuid` to edit or `createPath` (e.g. `dvr/config`) to create. It only
saves fields you changed. New config sections should reuse it rather than hand-build forms.

`IdnodeGridComponent` (`shared/idnode-grid.component.ts`) is its list counterpart: a
server-paged, sortable, filterable table for any `…/grid` endpoint. With `clientSide` it
loads every row once and searches (`searchFields`), filters (`rowFilter`), sorts
(`GridColumn.sortValue`) and pages in the browser — for lists up to a few thousand rows
whose filters the server can't do. Rule helpers shared with the
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
