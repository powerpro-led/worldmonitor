#!/bin/sh
set -e
# No brand default: this fork has no public backend at a fixed domain to
# silently proxy to. Derive from APP_DOMAIN (api.<domain>, matching
# shared/domain-config.js's resolveApiOrigin convention) when API_UPSTREAM
# isn't set explicitly; fail loudly instead of guessing a domain if neither
# is configured.
if [ -z "$API_UPSTREAM" ]; then
  if [ -n "$APP_DOMAIN" ]; then
    export API_UPSTREAM="https://api.${APP_DOMAIN}"
  else
    echo "docker-entrypoint.sh: set API_UPSTREAM (or APP_DOMAIN) to the API backend this image should proxy /api/ to — no default is assumed." >&2
    exit 1
  fi
fi
envsubst '${API_UPSTREAM}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
exec nginx -g "daemon off;"
