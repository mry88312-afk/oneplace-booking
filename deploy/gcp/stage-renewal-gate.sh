set -euo pipefail
test "$(hostname -s)" = prod-vm
test "$(id -u)" = 0
r="$1"
[[ "$r" =~ ^/srv/one824-booking-20261110/releases/[a-f0-9]{12}$ ]]
base=/srv/oneplace-release-820-823-824
core=one823-combined-956f2f0fce13-app
gate=one824-renewal-${r##*/}
depimage=$(docker inspect --format '{{.Image}}' one823-public-line-01)
oldgate="$base/deposit-public-956f2f0-02/gate"
pilot="$base/deposit-occupation-01/files/gate/line-subject.sha256"
coreport=$(docker port "$core" 3000/tcp | sed -n 's/^127\.0\.0\.1://p')
grep -Fq "reverse_proxy 127.0.0.1:$coreport" /etc/caddy/sites/deposit.caddy
test -s "$pilot"
install -d -m755 "$r/gate"
install -m644 "$r/src/deploy/gcp/"*.cjs "$r/gate/"
python3 - "$oldgate/line-session.cjs" "$r/gate/line-session.cjs" <<'PY'
import sys
from pathlib import Path
s=Path(sys.argv[1]).read_text()
for a,b in [("const APP_ORIGIN = 'https://deposit.oneplace.com.tw';","const APP_ORIGIN = 'https://booking.oneplace.com.tw';"),("const sessionCookie = tenants ? '__Host-deposit_line_v3' : COOKIE;","const sessionCookie = '__Host-booking_line';")]:
 assert s.count(a)==1
 s=s.replace(a,b)
Path(sys.argv[2]).write_text(s)
PY
chmod 644 "$r/gate/line-session.cjs"
opts=(--read-only --cap-drop ALL --security-opt no-new-privileges --memory 160m --cpus 0.5 --pids-limit 100 --mount "type=bind,src=$r/gate,dst=/gate,readonly")
docker run --rm --network none "${opts[@]}" "$depimage" node /gate/renewal-gateway.test.cjs
for net in one824-booking one824-deposit; do docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null; done
if ! docker inspect "$core" --format '{{json .NetworkSettings.Networks}}' | grep -q '"one824-deposit"'; then docker network connect --alias deposit-core one824-deposit "$core"; fi
if ! docker inspect "$gate" >/dev/null 2>&1; then
  docker create --name "$gate" --restart unless-stopped --network one824-booking "${opts[@]}" --log-driver none \
    -p 127.0.0.1::3000 --mount "type=bind,src=$base/deposit-occupation-01/proof,dst=/run/occupation-proof,readonly" \
    --mount "type=bind,src=$pilot,dst=/run/pilot,readonly" -e PILOT_SUBJECT_FILE=/run/pilot "$depimage" node /gate/renewal-gateway.cjs >/dev/null
  docker network connect one824-deposit "$gate"
fi
docker start "$gate" >/dev/null
port=$(docker port "$gate" 3000/tcp | sed -n 's/^127\.0\.0\.1://p')
for i in $(seq 1 15); do if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/principal")" = 403 ]; then echo "OWNER_GATE_READY $port"; exit 0; fi; sleep 1; done
exit 1
