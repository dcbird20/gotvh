#!/usr/bin/env bash
# Build GoTVH Admin and publish it to nginx on this machine (raven1).
#   First time:  scripts/deploy-admin.sh --install   (also installs the nginx site)
#   Afterwards:  scripts/deploy-admin.sh             (pull, build, publish)
set -euo pipefail
cd "$(dirname "$0")/.."

WEBROOT=/var/www/gotvh-admin

# Pull first, so --install copies the current nginx settings (not the ones from before the pull).
echo "Updating the code…"
git pull --ff-only

if [[ "${1:-}" == "--install" ]]; then
  command -v nginx >/dev/null || { echo "Installing nginx…"; sudo apt-get update -q && sudo apt-get install -y nginx; }
  sudo mkdir -p /etc/nginx/snippets "$WEBROOT"
  sudo cp nginx/snippets/gotvh-admin-common.conf nginx/snippets/gotvh-admin-proxy.conf /etc/nginx/snippets/
  sudo cp nginx/gotvh-admin.conf /etc/nginx/sites-available/gotvh-admin
  sudo ln -sf /etc/nginx/sites-available/gotvh-admin /etc/nginx/sites-enabled/gotvh-admin
fi

echo "Installing packages (only if package-lock.json changed)…"
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then npm ci; fi

echo "Building…"
npm run build:admin

echo "Publishing to $WEBROOT…"
sudo rsync -a --delete dist/gotvh-admin/browser/ "$WEBROOT/"

sudo nginx -t
sudo systemctl reload nginx

host=$(hostname -I | awk '{print $1}')
echo
echo "Done: http://$host:8090 (raven1's Tvheadend)  ·  http://$host:8091 (omv-dell)"
