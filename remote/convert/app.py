#!/usr/bin/env python3
"""
GoTVH recording converter — recordings at a smaller size for watching away from home.

Tvheadend serves recordings only as the original broadcast file (its stream profiles don't apply
to /dvrfile), so this turns a recording into an HLS video of 6-second pieces, each converted with
ffmpeg when it's asked for: H.264 picture and AAC-LC sound, like the gotvh-away live profile.
Seeking just asks for another piece; nothing is converted ahead or kept.

  GET /convert/<uuid>/index.m3u8   the list of pieces (length read from the recording)
  GET /convert/<uuid>/<n>.ts       piece n, converted now

Reached only through SWAG's GoTVH site (paired devices) or the home network. The app's Tvheadend
sign-in (Authorization header) is passed on to Tvheadend to read the recording.
"""
import base64
import http.server
import json
import urllib.request
import os
import re
import subprocess
import threading
import time
import urllib.parse

TVH = os.environ.get("TVH_URL", "http://host.docker.internal:9981").rstrip("/")
PORT = int(os.environ.get("PORT", "8097"))
SEG = int(os.environ.get("SEGMENT_SECONDS", "6"))
VIDEO_KBPS = int(os.environ.get("VIDEO_KBPS", "2500"))
AUDIO_KBPS = int(os.environ.get("AUDIO_KBPS", "128"))
MAX_HEIGHT = int(os.environ.get("MAX_HEIGHT", "720"))
PRESET = os.environ.get("X264_PRESET", "veryfast")

lock = threading.Lock()
durations = {}  # uuid -> (seconds, checked at)


def source(uuid, auth):
    """The recording's address at Tvheadend, with the viewer's sign-in (ffmpeg does Basic and Digest)."""
    url = f"{TVH}/dvrfile/{uuid}"
    if auth and auth.startswith("Basic "):
        try:
            user, pw = base64.b64decode(auth[6:]).decode().split(":", 1)
            p = urllib.parse.urlsplit(url)
            netloc = f"{urllib.parse.quote(user, safe='')}:{urllib.parse.quote(pw, safe='')}@{p.netloc}"
            url = urllib.parse.urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment))
        except ValueError:
            pass
    return url


def duration(uuid, auth):
    """How long the recording is now (a recording in progress grows; checked again after a minute)."""
    with lock:
        d = durations.get(uuid)
        if d and time.time() - d[1] < 60:
            return d[0]
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", source(uuid, auth)],
        capture_output=True, text=True, timeout=60,
    )
    try:
        secs = float(r.stdout.strip())
    except ValueError:
        secs = from_tvheadend(uuid, auth)
    if not secs:
        return None
    with lock:
        durations[uuid] = (secs, time.time())
    return secs


def from_tvheadend(uuid, auth):
    """The recording's length from Tvheadend's own record: start to stop (or to now, if still recording)."""
    try:
        user, pw = base64.b64decode(auth[6:]).decode().split(":", 1)
    except Exception:
        return None
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, TVH, user, pw)
    opener = urllib.request.build_opener(urllib.request.HTTPBasicAuthHandler(mgr), urllib.request.HTTPDigestAuthHandler(mgr))
    try:
        with opener.open(f"{TVH}/api/idnode/load?uuid={uuid}", timeout=10) as r:
            e = json.load(r)["entries"][0]
    except Exception:
        return None
    v = {p["id"]: p.get("value") for p in e.get("params", [])}
    start = v.get("start_real") or v.get("start")
    stop = v.get("stop_real") or v.get("stop")
    if not start:
        return None
    end = min(stop or time.time(), time.time() - 5)
    return max(0.0, float(end - start))


def playlist(total):
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", f"#EXT-X-TARGETDURATION:{SEG}", "#EXT-X-MEDIA-SEQUENCE:0",
             "#EXT-X-PLAYLIST-TYPE:VOD"]
    n = int(total // SEG) + (1 if total % SEG > 0.05 else 0)
    for i in range(n):
        lines.append(f"#EXTINF:{min(SEG, total - i * SEG):.3f},")
        lines.append(f"{i}.ts")
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def segment_command(src, i):
    start = i * SEG
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-i", src, "-t", str(SEG),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", f"yadif=mode=0:deint=interlaced,scale=-2:'min({MAX_HEIGHT},ih)'",
        "-c:v", "libx264", "-preset", PRESET, "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
        "-b:v", f"{VIDEO_KBPS}k", "-maxrate", f"{int(VIDEO_KBPS * 1.2)}k", "-bufsize", f"{VIDEO_KBPS * 2}k",
        "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        "-c:a", "aac", "-b:a", f"{AUDIO_KBPS}k", "-ac", "2", "-ar", "48000",
        # Pieces line up on one timeline, so the player sees one continuous video.
        "-output_ts_offset", str(start), "-muxdelay", "0", "-muxpreload", "0",
        "-f", "mpegts", "pipe:1",
    ]


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "gotvh-convert"

    def fail(self, status, text):
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        auth = self.headers.get("Authorization")
        m = re.fullmatch(r"/convert/([0-9a-f]{32})/index\.m3u8", self.path.split("?")[0])
        if m:
            total = duration(m.group(1), auth)
            if not total:
                return self.fail(502, "Couldn't read that recording from Tvheadend.")
            body = playlist(total).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        m = re.fullmatch(r"/convert/([0-9a-f]{32})/(\d+)\.ts", self.path.split("?")[0])
        if not m:
            return self.fail(404, "Not found")
        proc = subprocess.Popen(segment_command(source(m.group(1), auth), int(m.group(2))),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        first = proc.stdout.read(188 * 64)
        if not first:
            err = proc.stderr.read().decode(errors="replace")[-300:]
            proc.wait()
            return self.fail(502, "Conversion failed: " + err)
        self.send_response(200)
        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()  # no length: the piece ends when the connection closes
        try:
            self.wfile.write(first)
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the player moved on (seek, stop)
        finally:
            proc.kill()
            proc.wait()

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    print(f"gotvh-convert on :{PORT} ({MAX_HEIGHT}p, {VIDEO_KBPS}+{AUDIO_KBPS} kbps, {SEG}s pieces)", flush=True)
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
