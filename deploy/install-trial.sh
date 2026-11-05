#!/bin/sh
set -eu
revision="$1"
case "$revision" in *[!a-f0-9]*|'') echo 'Invalid revision'; exit 1;; esac
target=/srv/oneplace-booking-trial
upload=/home/mry88/one817-booking-trial-upload
# The first install must never replace an existing service directory.
if sudo test -e "$target"; then echo 'Trial directory already exists; inspect before updating'; exit 1; fi
sudo install -d -m 750 -g "$(id -gn)" "$target"
sudo tar -xf "$upload/source.tar" -C "$target"
sudo install -m 600 "$upload/trial.env" "$target/trial.env"
cd "$target"
sudo env TRIAL_REVISION="$revision" docker compose -f compose.trial.yaml config --quiet
sudo env TRIAL_REVISION="$revision" docker compose -f compose.trial.yaml build
sudo env TRIAL_REVISION="$revision" docker compose -f compose.trial.yaml up -d --wait --wait-timeout 120
sudo env TRIAL_REVISION="$revision" docker compose -f compose.trial.yaml ps
sudo env TRIAL_REVISION="$revision" docker compose -f compose.trial.yaml port booking 3000
