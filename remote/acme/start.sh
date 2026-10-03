#!/bin/sh
# Get the wildcard certificate for *.$BASE_DOMAIN from Let's Encrypt, proving the domain through
# your DNS provider's API (no port 80 needed), then keep it renewed. The front door reloads by
# itself when the files change.
set -e
: "${BASE_DOMAIN:?BASE_DOMAIN is not set}"
: "${ACME_DNS:?ACME_DNS is not set (e.g. dns_cf for Cloudflare)}"
DOMAIN="*.${BASE_DOMAIN}"

if [ ! -s /certs/fullchain.pem ]; then
    echo "acme: asking Let's Encrypt for $DOMAIN via $ACME_DNS (takes a couple of minutes)"
    acme.sh --issue --server letsencrypt --dns "$ACME_DNS" -d "$DOMAIN" ${ACME_DNSSLEEP:+--dnssleep $ACME_DNSSLEEP} || [ $? -eq 2 ]
    acme.sh --install-cert -d "$DOMAIN" \
        --key-file /certs/key.pem --fullchain-file /certs/fullchain.pem \
        --reloadcmd "chown 101:101 /certs/key.pem /certs/fullchain.pem && chmod 600 /certs/key.pem"
fi
echo "acme: certificate in place; checking for renewal daily"
exec crond -n -s -m off
