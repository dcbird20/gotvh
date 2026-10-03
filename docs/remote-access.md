# Watching away from home — server plan

Status: **plan, nothing installed yet.** Each step says what it changes and how to undo it.
Nothing here touches Tvheadend's own settings except step 6, and nothing is forwarded until step 5.

## What it looks like

```
 phone / TV / laptop (anywhere)
        │  HTTPS or TLS on port 443, with a device certificate
        ▼
 Xfinity router ── forwards TCP 443 only ──▶ raven1
                                              │
                                   ┌──────────▼───────────┐
                                   │ frontdoor (container) │  read-only, no root, no capabilities
                                   │  tv-…   → nginx :8090 │  (admin app + Tvheadend API/streams)
                                   │  htsp-… → Tvheadend :9982 (live TV with pause)
                                   │  anything else → hung up before a handshake
                                   └──────────────────────┘
   at home only:  pair (container, :8095 on the LAN address) — makes and removes device certificates
                  acme (container) — the web certificate, renewed via your DNS provider's API
                  ddns (container, optional) — moves the DNS record if your Xfinity address changes
```

Not reachable from outside, ever: Tvheadend's ports (9981/9982), raven1's nginx (8080/8090/8091),
Portainer (9000/9443), SSH, the pairing service, omv-dell.

## Who gets in

- A device needs a **certificate made by the pairing service**. Without one, nginx refuses the
  connection before any login page or Tvheadend code is reached. The Tvheadend username and password
  are still required on top.
- Certificates are only handed out **at home**: the pairing service listens on raven1's home address
  only, and the front door refuses `/pair/` from outside.
- Pairing needs a **one-time code** that an administrator makes in the admin app (Devices). Codes last
  10 minutes and work once; after 10 wrong guesses all open codes stop working.
- **Removing a device** in the admin app locks it out within 30 seconds (revocation list; the front
  door reloads by itself).

What's visible on the internet: port 443 on your address. The certificate log (public for every
Let's Encrypt certificate) shows `*.<BASE_DOMAIN>` (e.g. `*.tv.example.com`), so that name and your
address can be found. The two names the apps use (`tv-<random>…`, `htsp-<random>…`) appear nowhere; a connection
for any other name, or for the bare IP, is closed before any handshake.

## Before you start

- Your domain, and an API key from its DNS provider that can edit DNS records (the provider's
  acme.sh name is in the list linked from `remote/.env.example`).
- A name used only for this, e.g. `tv.example.com`, so it stays apart from the rest of your domain.
- Tvheadend container: its ports 9981 and 9982 published on raven1 (they are today: the TV uses them).

## Steps

### 1. Fill in the settings (no change to anything)
```
cd ~/gotvh && git pull
cd remote && cp .env.example .env && nano .env
echo tv-$(openssl rand -hex 4); echo htsp-$(openssl rand -hex 4)   # for TV_HOST / HTSP_HOST
```
Undo: delete `remote/.env`.

### 1b. DNS record (at your DNS provider)
`*.<BASE_DOMAIN>  A  <your Xfinity address>` (whatismyip.com shows the address). Optional: the
`ddns` updater keeps it current; Xfinity addresses rarely change.
Undo: delete the record.

### 2. Start the stack (still unreachable from outside)
```
docker compose up -d --build
docker compose logs -f acme        # wait for "certificate in place" (2–3 minutes)
docker compose logs frontdoor      # "front door: open for tv-… and htsp-…"
```
Shows up in Portainer as **gotvh-remote** (logs, restart, stop from there).
Changes: three containers (four with the optional address updater), four Docker volumes, port 443 on raven1 (LAN), port 8095 on raven1's LAN address.
Undo: `docker compose down` (keeps the volumes; `down -v` also deletes certificates and paired devices).

### 3. Update raven1's nginx (adds `/pair/` for the admin app's Devices page)
```
scripts/deploy-admin.sh --install
```
Undo: `git checkout HEAD~1 -- nginx/gotvh-admin.conf && scripts/deploy-admin.sh --install`.

### 4. Pair a device and test at home
Admin app → Devices → *Pair a device* → enter the code in the app (Settings → Away from home).
Test from raven1 itself (nothing forwarded yet), pretending to be outside:
```
curl -sk --resolve <TV_HOST>:443:127.0.0.1 https://<TV_HOST>/ -o /dev/null -w "%{http_code}\n"   # 000: refused, good
```

### 5. Open the door: Xfinity app → WiFi → Advanced settings → Port forwarding
Add: device raven1, TCP, port 443 → 443. Then, on the phone **with Wi-Fi off**, the app should
say "Away" and play.
Undo: delete the forward. Everything else can stay; nothing is reachable without it.

### 6. Away quality (Tvheadend change — only after a yes)
Tvheadend → Configuration → Stream → Stream profiles: check that a converting profile exists
(`webtv-h264-aac-mpegts` ships with Tvheadend builds that include transcoding). The apps use it
away from home (Settings → Away from home → Away quality). If it's missing, the container image
may not include transcoding; we'd look at that separately.
Undo: nothing to undo; the apps go back to the original stream if the profile is removed.

## Keeping it safe

- Updates: `docker compose pull && docker compose up -d` monthly (nginx, acme.sh), or let
  Watchtower do it. raven1 itself: `unattended-upgrades` for security fixes.
- Watch: `docker compose logs frontdoor` shows every connection with the device name.
- Lost a phone: admin app → Devices → Remove.
- Close everything: remove the router forward, or `docker compose stop frontdoor`.

## Known limits (first version)

- Recordings play at full quality away from home (Tvheadend serves the recording file as-is), which
  needs ~10–19 Mbps for antenna recordings.
- Browsers: a laptop needs its own certificate (admin app → Devices → *Certificate for a computer*,
  then open the downloaded file and enter the password shown).
