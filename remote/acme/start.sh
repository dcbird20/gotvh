#!/bin/sh
# Get the wildcard certificate for *.$BASE_DOMAIN from Let's Encrypt, proving the domain through
# your DNS provider's API (no port 80 needed), then keep it renewed. The front door reloads by
# itself when the files change.
#
# Let's Encrypt allows only 5 failed attempts per hour, so this never retries quickly: settings
# are checked before asking, and after a failure it waits an hour.
set -e
: "${BASE_DOMAIN:?BASE_DOMAIN is not set}"
: "${ACME_DNS:?ACME_DNS is not set (e.g. dns_duckdns)}"
DOMAIN="*.${BASE_DOMAIN}"

wait_then_exit() {
    echo "acme: $1"
    echo "acme: trying again in an hour (or fix .env and: docker compose up -d --force-recreate acme)"
    sleep 3600
    exit 1
}

if [ "$ACME_DNS" = "dns_duckdns" ] && [ -z "$DuckDNS_Token" ]; then
    wait_then_exit "DuckDNS_Token is empty in .env — not asking Let's Encrypt."
fi

if [ ! -s /certs/fullchain.pem ]; then
    echo "acme: asking Let's Encrypt for $DOMAIN via $ACME_DNS (takes a few minutes)"
    set +e
    acme.sh --issue --server letsencrypt --dns "$ACME_DNS" -d "$DOMAIN" ${ACME_DNSSLEEP:+--dnssleep $ACME_DNSSLEEP}
    rc=$?
    set -e
    # 2 = already have a valid certificate (only needs installing)
    [ $rc -eq 0 ] || [ $rc -eq 2 ] || wait_then_exit "Let's Encrypt didn't issue the certificate (see above)."
    acme.sh --install-cert -d "$DOMAIN" \
        --key-file /certs/key.pem --fullchain-file /certs/fullchain.pem \
        --reloadcmd "chown 101:101 /certs/key.pem /certs/fullchain.pem && chmod 600 /certs/key.pem"
fi
echo "acme: certificate in place; checking for renewal daily"
exec crond -n -s -m off
