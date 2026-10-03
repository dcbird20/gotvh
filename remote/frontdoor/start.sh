#!/bin/sh
# Start the front door once the certificates exist, and reload it whenever the web certificate
# is renewed or a device is removed (new revocation list).
set -e

for f in /certs/fullchain.pem /certs/key.pem /pki/ca.pem /pki/crl.pem; do
    until [ -s "$f" ]; do echo "front door: waiting for $f"; sleep 10; done
done

sed -e "s#__TV_HOST__#${TV_HOST:?TV_HOST is not set}#g" \
    -e "s#__HTSP_HOST__#${HTSP_HOST:?HTSP_HOST is not set}#g" \
    -e "s#__HOME_WEB__#${HOME_WEB:-http://host.docker.internal:8090}#g" \
    -e "s#__TVH_HTSP__#${TVH_HTSP:-host.docker.internal:9982}#g" \
    /etc/gotvh/nginx.conf.in > /tmp/nginx.conf

nginx -c /tmp/nginx.conf -t
nginx -c /tmp/nginx.conf
echo "front door: open for $TV_HOST and $HTSP_HOST"

stamp() { cat /certs/fullchain.pem /pki/crl.pem | md5sum; }
last=$(stamp)
while sleep 30; do
    [ -f /tmp/nginx.pid ] || { echo "front door: nginx stopped"; exit 1; }
    now=$(stamp)
    if [ "$now" != "$last" ]; then
        last=$now
        echo "front door: certificates changed, reloading"
        nginx -c /tmp/nginx.conf -s reload
    fi
done
