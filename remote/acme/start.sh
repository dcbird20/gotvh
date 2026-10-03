#!/bin/sh
# Get the wildcard certificate for *.<subdomain>.duckdns.org from Let's Encrypt (DNS check via
# DuckDNS, so no port 80 is needed), then keep it renewed. The front door reloads by itself
# when the files change.
set -e
: "${DUCKDNS_SUBDOMAIN:?DUCKDNS_SUBDOMAIN is not set}"
: "${DuckDNS_Token:?DUCKDNS_TOKEN is not set}"
DOMAIN="*.${DUCKDNS_SUBDOMAIN}.duckdns.org"

if [ ! -s /certs/fullchain.pem ]; then
    echo "acme: asking Let's Encrypt for $DOMAIN (takes a couple of minutes)"
    acme.sh --issue --server letsencrypt --dns dns_duckdns -d "$DOMAIN" --dnssleep 90 || [ $? -eq 2 ]
    acme.sh --install-cert -d "$DOMAIN" \
        --key-file /certs/key.pem --fullchain-file /certs/fullchain.pem \
        --reloadcmd "chown 101:101 /certs/key.pem /certs/fullchain.pem && chmod 600 /certs/key.pem"
fi
echo "acme: certificate in place; checking for renewal daily"
exec crond -n -s -m off
