#!/usr/bin/env python3
"""
GoTVH pairing service — hands out device certificates for watching away from home.

Runs on the home network only (its port is never forwarded). The front door (nginx) lets a
connection in only if it shows a certificate signed by this service's own CA and not revoked.

  POST   /pair/api/codes            admin: a one-time pairing code (10 minutes)
  POST   /pair/api/redeem           {code, name[, format: "pem"|"p12"]}: a device certificate
  GET    /pair/api/devices          admin: paired devices
  DELETE /pair/api/devices/<serial> admin: remove a device (it's refused from then on)
  GET    /pair/api/info             whether away access is set up, and its addresses
  GET    /pair/api/check?serial=X   200 if that device certificate is still allowed (SWAG asks on every request)

"admin" = HTTP Basic sign-in that Tvheadend accepts as an administrator (checked against
Tvheadend itself, so there's no second password to keep).

Standard library + the openssl command only. State lives in DATA_DIR; the CA certificate and
the revocation list are copied to PKI_DIR for nginx.
"""
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DATA = os.environ.get("DATA_DIR", "/data")
PKI = os.environ.get("PKI_DIR", "/pki")
TVH = os.environ.get("TVH_URL", "http://host.docker.internal:9981").rstrip("/")
TV_HOST = os.environ.get("TV_HOST", "")
HTSP_HOST = os.environ.get("HTSP_HOST", "")
PUBLIC_PORT = int(os.environ.get("PUBLIC_PORT", "443"))       # web (SWAG)
HTSP_PORT = int(os.environ.get("HTSP_PORT", "8443"))          # live TV (the GoTVH front door)
PORT = int(os.environ.get("PORT", "8095"))
CODE_TTL = 600
DEVICE_DAYS = 1825

lock = threading.RLock()
codes = {}          # code -> expiry
failures = []       # times of wrong codes
admin_cache = {}    # sha256(auth header) -> expiry


def path(*p):
    return os.path.join(DATA, *p)


def run(*args, input=None):
    r = subprocess.run(args, input=input, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''}: {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


# ------------------------------------------------------------------ the CA

CA_CNF = """
[ ca ]
default_ca = gotvh
[ gotvh ]
database = {db}
crlnumber = {crlnumber}
default_md = sha256
default_crl_days = 3650
"""


def ensure_ca():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(PKI, exist_ok=True)
    if not os.path.exists(path("ca.key")):
        run("openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
            "-keyout", path("ca.key"), "-out", path("ca.pem"), "-days", "7300",
            "-subj", "/CN=GoTVH devices",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        os.chmod(path("ca.key"), 0o600)
    for f, content in (("index.txt", ""), ("crlnumber", "1000\n"), ("devices.json", "[]")):
        if not os.path.exists(path(f)):
            with open(path(f), "w") as fh:
                fh.write(content)
    with open(path("ca.cnf"), "w") as fh:
        fh.write(CA_CNF.format(db=path("index.txt"), crlnumber=path("crlnumber")))
    publish()


def publish():
    """Write the CA certificate and a fresh revocation list where nginx reads them."""
    run("openssl", "ca", "-gencrl", "-config", path("ca.cnf"), "-keyfile", path("ca.key"),
        "-cert", path("ca.pem"), "-out", path("crl.pem"))
    for f in ("ca.pem", "crl.pem"):
        tmp = os.path.join(PKI, f + ".tmp")
        shutil.copyfile(path(f), tmp)
        os.chmod(tmp, 0o644)
        os.replace(tmp, os.path.join(PKI, f))


def devices():
    with open(path("devices.json")) as fh:
        return json.load(fh)


def save_devices(items):
    tmp = path("devices.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(items, fh, indent=1)
    os.replace(tmp, path("devices.json"))


def issue(name, fmt):
    """A new device key and certificate."""
    # 24 hex digits, first digit 1–3: positive and an even length, as openssl's CA database expects.
    serial = format(secrets.randbits(93) | (1 << 92), "024X")
    safe = re.sub(r"[^A-Za-z0-9 ._'-]", "", name)[:60] or "Device"
    with tempfile.TemporaryDirectory() as t:
        key, csr, crt, ext = (os.path.join(t, n) for n in ("d.key", "d.csr", "d.pem", "ext.cnf"))
        with open(ext, "w") as fh:
            fh.write("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n")
        run("openssl", "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
            "-keyout", key, "-out", csr, "-subj", "/CN=" + safe)
        run("openssl", "x509", "-req", "-in", csr, "-CA", path("ca.pem"), "-CAkey", path("ca.key"),
            "-set_serial", "0x" + serial, "-days", str(DEVICE_DAYS), "-out", crt, "-extfile", ext)
        key_pem = run("openssl", "pkcs8", "-topk8", "-nocrypt", "-in", key).decode()
        cert_pem = open(crt).read()
        expires = run("openssl", "x509", "-in", crt, "-noout", "-enddate").decode().strip().split("=", 1)[1]
        p12 = password = None
        if fmt == "p12":
            password = secrets.token_urlsafe(9)
            out = os.path.join(t, "d.p12")
            base = ["openssl", "pkcs12", "-export", "-inkey", key, "-in", crt, "-certfile", path("ca.pem"),
                    "-name", "GoTVH " + safe, "-passout", "pass:" + password, "-out", out]
            try:  # older macOS and Windows only read the legacy format
                run(*base, "-legacy")
            except RuntimeError:
                run(*base)
            p12 = base64.b64encode(open(out, "rb").read()).decode()
    with lock:
        items = devices()
        items.append({"serial": serial, "name": safe, "kind": "computer" if fmt == "p12" else "app",
                      "paired": datetime.now(timezone.utc).isoformat(timespec="seconds"), "expires": expires})
        save_devices(items)
    return serial, key_pem, cert_pem, p12, password


def revoke(serial):
    with lock:
        items = devices()
        match = [d for d in items if d["serial"].upper() == serial.upper()]
        if not match:
            return False
        stamp = datetime.now(timezone.utc).strftime("%y%m%d%H%M%SZ")
        with open(path("index.txt"), "a") as fh:
            # status, expiry, revoked, serial, file, subject — openssl's CA database format
            fh.write(f"R\t491231235959Z\t{stamp}\t{serial.upper()}\tunknown\t/CN={match[0]['name']}\n")
        save_devices([d for d in items if d not in match])
        publish()
    return True


# ------------------------------------------------------------------ sign-in

def is_admin(header):
    """Basic sign-in that Tvheadend accepts as an administrator (Basic or Digest towards Tvheadend)."""
    if not header or not header.startswith("Basic "):
        return False
    h = hashlib.sha256(header.encode()).hexdigest()
    with lock:
        if admin_cache.get(h, 0) > time.time():
            return True
    try:
        user, pw = base64.b64decode(header[6:]).decode().split(":", 1)
    except Exception:
        return False
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, TVH, user, pw)
    opener = urllib.request.build_opener(urllib.request.HTTPBasicAuthHandler(mgr), urllib.request.HTTPDigestAuthHandler(mgr))
    try:
        # Only administrators may list access entries.
        with opener.open(TVH + "/api/access/entry/grid?limit=1", timeout=8) as r:
            ok = r.status == 200
    except (urllib.error.URLError, OSError):
        ok = False
    if ok:
        with lock:
            admin_cache[h] = time.time() + 300
    return ok


def new_code():
    with lock:
        now = time.time()
        for c in [c for c, e in codes.items() if e < now]:
            del codes[c]
        code = f"{secrets.randbelow(10**8):08d}"
        codes[code] = now + CODE_TTL
        return code


def take_code(code):
    code = re.sub(r"\D", "", code or "")
    with lock:
        now = time.time()
        failures[:] = [t for t in failures if t > now - 600]
        if len(failures) >= 10:
            codes.clear()  # someone is guessing: every open code stops working
            return False
        if codes.get(code, 0) > now:
            del codes[code]
            return True
        failures.append(now)
        return False


# ------------------------------------------------------------------ HTTP

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "gotvh-pair"

    def send(self, status, body=None):
        data = json.dumps(body if body is not None else {}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 10_000:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    def admin(self):
        if is_admin(self.headers.get("Authorization")):
            return True
        self.send(401, {"error": "Sign in with a Tvheadend administrator account."})
        return False

    def do_GET(self):
        if self.path == "/pair/api/info":
            return self.send(200, {"ready": bool(TV_HOST and HTSP_HOST), "tvHost": TV_HOST, "htspHost": HTSP_HOST,
                                   "port": PUBLIC_PORT, "htspPort": HTSP_PORT})
        m = re.fullmatch(r"/pair/api/check\?serial=([0-9A-Fa-f]{1,64})", self.path)
        if m:
            # The web front (SWAG) has already checked the certificate is ours; this says whether
            # it has been removed since. Answering from the list means no nginx reload is needed.
            serial = m.group(1).upper().lstrip("0")
            ok = any(d["serial"].upper().lstrip("0") == serial for d in devices())
            return self.send(200 if ok else 403)
        if self.path == "/pair/api/devices":
            if self.admin():
                self.send(200, devices())
            return
        self.send(404)

    def do_POST(self):
        if self.path == "/pair/api/codes":
            if self.admin():
                self.send(200, {"code": new_code(), "expiresIn": CODE_TTL})
            return
        if self.path == "/pair/api/redeem":
            b = self.body()
            if not take_code(str(b.get("code", ""))):
                return self.send(403, {"error": "That code didn't work. Codes last 10 minutes and work once; make a new one in the admin app."})
            fmt = "p12" if b.get("format") == "p12" else "pem"
            serial, key_pem, cert_pem, p12, password = issue(str(b.get("name", "")), fmt)
            ca = open(path("ca.pem")).read()
            out = {"serial": serial, "tvHost": TV_HOST, "htspHost": HTSP_HOST, "port": PUBLIC_PORT, "htspPort": HTSP_PORT}
            out.update({"p12": p12, "password": password} if fmt == "p12" else {"key": key_pem, "cert": cert_pem, "ca": ca})
            return self.send(200, out)
        self.send(404)

    def do_DELETE(self):
        m = re.fullmatch(r"/pair/api/devices/([0-9A-Fa-f]+)", self.path)
        if not m:
            return self.send(404)
        if self.admin():
            self.send(200 if revoke(m.group(1)) else 404)

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    ensure_ca()
    print(f"gotvh-pair on :{PORT}; away addresses {TV_HOST or '(not set)'} / {HTSP_HOST or '(not set)'}", flush=True)
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
