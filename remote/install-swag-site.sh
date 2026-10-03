#!/bin/sh
# Put GoTVH's site into SWAG (or take it out with --remove), check SWAG's config, reload SWAG.
# Run on raven1 from the remote/ folder, after `docker compose up -d` has made the certificate.
set -e
cd "$(dirname "$0")"
. ./.env
SITE="${SWAG_DIR:?SWAG_DIR is not set in .env}/nginx/proxy-confs/gotvh.subdomain.conf"

if [ "$1" = "--remove" ]; then
    rm -f "$SITE"
    docker exec swag nginx -s reload
    echo "GoTVH site removed from SWAG."
    exit 0
fi

[ -s "$SWAG_DIR/gotvh/certs/fullchain.pem" ] || { echo "No GoTVH certificate yet: docker compose logs acme"; exit 1; }
sed -e "s#__TV_HOST__#${TV_HOST:?}#g" \
    -e "s#__BASE_DOMAIN__#${BASE_DOMAIN:?}#g" \
    -e "s#__PAIR__#${PAIR_LAN_IP:?}:8095#g" \
    -e "s#__HOME_WEB__#${HOME_WEB:-$PAIR_LAN_IP:8090}#g" \
    swag/gotvh.subdomain.conf.in > "$SITE.new"
mv "$SITE.new" "$SITE"
if docker exec swag nginx -t; then
    docker exec swag nginx -s reload
    echo "GoTVH site is live in SWAG for $TV_HOST."
else
    rm -f "$SITE"
    echo "SWAG didn't accept the GoTVH site; removed it again (SWAG unchanged)."
    exit 1
fi
