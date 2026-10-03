# Watching away from home — server plan (raven1 with SWAG)

Status: **plan, nothing installed yet.** Each step says what it changes and how to undo it.
SWAG keeps serving Jellyfin exactly as now; its certificate and settings are not changed.

## What it looks like

```
 phone / TV / laptop (anywhere), with a device certificate
        │
 Xfinity router ── TCP 443  → raven1 SWAG (as today)
                │             ├─ magnumpi.duckdns.org/jellyfin … unchanged
                │             └─ tv-<random>.magnumpi.duckdns.org → GoTVH site (new file in proxy-confs)
                │                   device certificate + live check with the pairing service
                │                   → raven1 nginx :8090 (admin app, Tvheadend API and streams)
                └─ TCP 8443 → raven1 GoTVH frontdoor (new container)
                              htsp-<random>.magnumpi.duckdns.org → Tvheadend :9982 (live TV with pause)
                              any other name → hung up before a handshake

 at home only: pair (container, 192.168.1.72:8095) — makes and removes device certificates
               acme (container) — GoTVH's own certificate *.magnumpi.duckdns.org (DuckDNS check)
```

Why its own certificate: SWAG's certificate covers `magnumpi.duckdns.org` (Jellyfin). Because of a
DuckDNS limitation, a wildcard certificate can't also cover the base name, so switching SWAG to a
wildcard would break Jellyfin's address. GoTVH gets `*.magnumpi.duckdns.org` separately, through the
same DuckDNS check, and SWAG uses it only for the GoTVH name.

Not reachable from outside: Tvheadend's ports (9981/9982), raven1's nginx (8080/8090/8091), Portainer,
SSH, the pairing service, omv-dell.

## Who gets in

- A device needs a **certificate made by the pairing service**. Without one, the connection is
  closed before any login page or Tvheadend code is reached. The Tvheadend sign-in is still needed on top.
- Certificates are only handed out **at home**: the pairing service listens on raven1's home address
  only, and the GoTVH site refuses `/pair/` from outside.
- Pairing needs a **one-time code** from the admin app (Devices). Codes last 10 minutes and work once;
  after 10 wrong guesses all open codes stop working.
- **Removing a device** in the admin app locks it out of the web side at once (SWAG asks the pairing
  service on every request) and out of live TV within 30 seconds (revocation list).

Visible on the internet: ports 443 (as today) and 8443. The public certificate log shows
`*.magnumpi.duckdns.org`; the two GoTVH names appear nowhere.

## Steps

### 0. New DuckDNS token (do this first)
duckdns.org → regenerate the token, put it in SWAG's stack (`DUCKDNSTOKEN`) and redeploy SWAG.
The old one was shared in a chat.

### 1. Settings (no change to anything)
```
cd ~/Code/gotvh && git pull && cd remote
cp .env.example .env && nano .env        # DuckDNS_Token = the new token; TV_HOST / HTSP_HOST:
echo tv-$(openssl rand -hex 4); echo htsp-$(openssl rand -hex 4)
mkdir -p /opt/swag/gotvh/certs /opt/swag/gotvh/pki   # SWAG's folder; owned by you (PUID 1000)
```
Undo: delete `remote/.env` and `/opt/swag/gotvh`.

### 2. Start the stack (still unreachable from outside)
```
docker compose up -d --build
docker compose logs -f acme        # wait for "certificate in place" (a few minutes; DuckDNS is slow)
docker compose logs frontdoor      # "front door: live TV open for htsp-…"
```
Shows up in Portainer as **gotvh-remote**. Changes: three containers, two Docker volumes, port 8443
on raven1, port 8095 on raven1's home address, files in `/opt/swag/gotvh/`.
Undo: `docker compose down` (`down -v` also forgets paired devices).

### 3. Add the GoTVH site to SWAG
```
./install-swag-site.sh             # writes proxy-confs/gotvh.subdomain.conf, checks, reloads SWAG
```
If SWAG doesn't accept it, the script takes it out again and SWAG carries on unchanged.
Also, so SWAG picks up GoTVH's renewed certificate: `crontab -e` and add
`17 4 * * 1 docker exec swag nginx -s reload` (weekly; renewal happens a month before expiry).
Undo: `./install-swag-site.sh --remove`.

### 4. raven1's nginx: `/pair/` for the admin app's Devices page
```
cd ~/Code/gotvh && scripts/deploy-admin.sh --install
```
Undo: revert `nginx/gotvh-admin.conf` and run it again.

### 5. Pair a device at home
Admin app → **Devices** → *Pair a device* → in the TV/phone app: Settings → Away from home → code.

### 6. Router: Xfinity app → WiFi → Advanced settings → Port forwarding
Add **TCP 8443 → raven1 (192.168.1.72) 8443**. 443 already goes to raven1 for SWAG.
Test on the phone **with Wi-Fi off**: Settings should say "Connected away from home", and live TV
plays and pauses.
Undo: delete the 8443 forward (web side: `./install-swag-site.sh --remove`).

### 7. Away quality (Tvheadend change — only after a yes)
Tvheadend → Configuration → Stream → Stream profiles: check that a converting profile exists
(`webtv-h264-aac-mpegts` comes with Tvheadend builds that include transcoding). The apps use it away
from home (Settings → Away from home → Away quality). If it's missing, we look at the container image.

## Keeping it safe

- Updates: `docker compose pull && docker compose up -d --build` monthly; SWAG as you do now.
- Watch: `docker compose logs frontdoor` (live TV, with device names); SWAG's access log for the web.
- Lost a phone: admin app → Devices → Remove.
- Close everything: remove the 8443 forward and `./install-swag-site.sh --remove`, or `docker compose stop`.

## Known limits (first version)

- Recordings play at full quality away from home (~10–19 Mbps for antenna recordings).
- A laptop browser needs its own certificate (admin app → Devices → *Certificate for a computer*).
