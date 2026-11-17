#!/usr/bin/env bash
# Run on prod-vm as root. No LINE recipient/message is supplied to either endpoint.
set -euo pipefail
[[ "$(hostname -s)" = prod-vm && "$(id -u)" = 0 ]]
dir=/etc/oneplace/booking-hub
file="$dir/route.json"
exec 9>/run/lock/one824-hub-route.lock; flock -n 9
mode=${1:-status}
if [[ "$mode" = status ]]; then cat "$file"; exit; fi
[[ "$mode" = zeabur || "$mode" = gcp ]]
app=$(docker ps --filter "label=oneplace.booking.hub-route=1" --format '{{.Names}}' | while read -r name; do
  port=$(docker port "$name" 3000/tcp | sed -n 's/^127\.0\.0\.1://p')
  if [[ -n "$port" ]] && grep -Fqx "        reverse_proxy 127.0.0.1:$port" /etc/caddy/sites/booking.caddy; then echo "$name"; fi
done)
[[ -n "$app" && "$app" != *$'\n'* ]]
origin=${2:-}
if [[ "$mode" = gcp ]]; then
  [[ "$origin" =~ ^https://[a-z0-9-]+\.oneplace\.com\.tw$ ]]
  docker exec "$app" node --input-type=module -e '
    import {parseRoute,probeHub,legacyHub,notifyPath,relayPath} from "./dist/booking/hubRouting.js";
    const r=parseRoute(JSON.stringify({primary:"gcp",origin:process.argv[1]}));
    const secret=process.env.BOOKING_WEBHOOK_SECRET;
    if(!secret) process.exit(1);
    for(const origin of [r.origin,legacyHub]) for(const p of [notifyPath,relayPath]) {
      if(!await probeHub(origin,p,secret)) { console.error("Not ready:",origin,p); process.exit(1); }
    }' "$origin"
  json=$(printf '{"primary":"gcp","origin":"%s"}' "$origin")
else
  [[ -z "$origin" ]]
  json='{"primary":"zeabur"}'
fi
tmp=$(mktemp "$dir/.route.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
printf '%s\n' "$json" >"$tmp"; chmod 0644 "$tmp"; mv -fT "$tmp" "$file"
docker exec "$app" node --input-type=module -e 'import {activeRoute} from "./dist/booking/hubRouting.js";console.log(activeRoute())'
