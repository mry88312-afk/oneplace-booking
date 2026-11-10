set -euo pipefail
# Run as root against the reviewed release and a dedicated, registered pilot LIFF.
test "$(hostname -s)" = prod-vm && test "$(id -u)" = 0
tag="$1"; liff="$2"
[[ "$tag" =~ ^[0-9a-f]{12}$ && "$liff" =~ ^2006833424-[a-zA-Z0-9]+$ ]]
r="/srv/one824-booking-20261110/releases/$tag"
src=/srv/oneplace-release-820-823-824
gate="one824-renewal-$tag"
app="one824-pilot-$tag"
site=/etc/caddy/sites/booking.caddy
exec 9>/run/lock/one824-pilot.lock
flock -n 9
# Never switch public traffic using a production or deposit test LIFF.
python3 - "$liff" <<'PY'
import re,sys,urllib.request,secrets
app=sys.argv[1]
assert app not in ('2006833424-znZYKjip','2006833424-haBzHbwp','2006833424-jX3tixwY','2006833424-LQBg2Lcg')
req=urllib.request.Request('https://liff.line.me/'+app+'?probe='+secrets.token_hex(6),headers={'User-Agent':'Mozilla/5.0'})
s=urllib.request.urlopen(req,timeout=10).read().decode()
m=re.search(r'const liffEndpointUrl\s*=\s*"([^"]+)"',s)
assert m and m[1].rstrip('/')=='https://booking.oneplace.com.tw', 'incorrect pilot LIFF endpoint'
PY
test "$(docker exec "$gate" printenv PILOT_SUBJECT_FILE)" = /run/pilot
test -s "$r/tests.log"; grep -q '^# fail 0$' "$r/tests.log"
test -f "$r/qa.ok"
test -f "$r/src/deploy/gcp/owner-preview.caddy"
if ! docker inspect "$app" >/dev/null 2>&1; then
  docker run -d --name "$app" --restart unless-stopped --network one824-booking \
    --read-only --tmpfs /tmp:size=32m --cap-drop ALL --security-opt no-new-privileges \
    --memory 768m --cpus 1.5 --log-opt max-size=4m --log-opt max-file=2 -p 127.0.0.1::3000 \
    --env-file "$src/config/20261107-env-01/booking/docker.env" -e BOOKING_WRITES_ENABLED=true \
    -e "BOOKING_PREVIEW_LIFF_ID=$liff" -e "BOOKING_REMITTANCE_BRIDGE=http://$gate:3000" "one824-booking:$tag" >/dev/null
fi
test "$(docker exec "$app" printenv BOOKING_PREVIEW_LIFF_ID)" = "$liff"
port(){ docker port "$1" 3000/tcp | sed -n 's/^127\.0\.0\.1://p'; }
ap=$(port "$app"); gp=$(port "$gate"); [[ "$ap" =~ ^[0-9]+$ && "$gp" =~ ^[0-9]+$ ]]
for i in $(seq 1 25); do if curl -fsS -o /dev/null "http://127.0.0.1:$ap/healthz"; then break; fi; sleep 1; done
curl -fsS "http://127.0.0.1:$ap/healthz" | grep -q 'oneplace-booking'
public="/var/www/one824-$tag"; install -d -m755 "$public"
install -m644 "$src/deposit-public-956f2f0-02/gate/liff-sdk.js" "$public/liff-sdk.js"
install -m644 "$r/src/deploy/gcp/pilot.html" "$public/index.html"
docker run --rm --network none --read-only "one824-booking-qa:$tag" node_modules/.bin/esbuild deploy/gcp/pilot.js --bundle --platform=browser > "$r/pilot.bundle.js"
sed "s/PILOT_LIFF/$liff/g" "$r/pilot.bundle.js" > "$public/pilot.js"; chmod 644 "$public/pilot.js"
sed -e "s/BOOKING_PORT/$ap/g;s/GATE_PORT/$gp/g;s|PILOT_FILES|$public|g" "$r/src/deploy/gcp/owner-preview.caddy" > "$r/pilot.caddy"
if ! cmp -s "$site" "$r/pilot.caddy"; then
  previous=/srv/oneplace-trials-820-823-824/private-https/booking.caddy
  if [[ -n "${3:-}" ]]; then
    [[ "$3" =~ ^[0-9a-f]{12}$ ]]
    previous="/srv/one824-booking-20261110/releases/$3/pilot.caddy"
  fi
  cmp "$site" "$previous" || { echo 'Booking ingress changed; check before replacing'; exit 1; }
  cp -p "$site" "$r/before-pilot.caddy"
  restore(){ install -m644 "$r/before-pilot.caddy" "$site"; systemctl reload caddy; }
  trap restore ERR
  install -m644 "$r/pilot.caddy" "$site"
  sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$r/validate.log" 2>&1
  systemctl reload caddy
fi
url=https://booking.oneplace.com.tw
check(){ curl -sS --retry 2 --retry-all-errors --max-time 5 --resolve booking.oneplace.com.tw:443:127.0.0.1 -o /dev/null -w '%{http_code}' "$@"; }
test "$(check "$url/")" = 200
test "$(check -H 'Origin: https://booking.oneplace.com.tw' -X POST "$url/api/trpc/booking.confirmBooking")" = 403
for endpoint in send-otp verify-otp; do
  response=$(curl -sS --max-time 5 --resolve booking.oneplace.com.tw:443:127.0.0.1 -H 'Origin: https://booking.oneplace.com.tw' -H 'Content-Type: application/json' --data '{}' -o "$r/otp-denial.json" -w '%{http_code}' "$url/booking-link/$endpoint")
  test "$response" = 403
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["success"] is False' "$r/otp-denial.json"
done
test "$(check -H 'Origin: https://other.example' -X POST "$url/booking-link/line-session")" = 403
test "$(check "$url/api/outreach/run")" = 404
trap - ERR
echo OWNER_PREVIEW_ACTIVE
