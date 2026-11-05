#!/bin/sh
set -eu
container=oneplace-booking-trial-booking-1
sudo docker inspect --format '{"image":"{{.Config.Image}}","imageId":"{{.Image}}","health":"{{.State.Health.Status}}","user":"{{.Config.User}}","readOnlyRoot":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}},"pids":{{.HostConfig.PidsLimit}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"ports":{{json .NetworkSettings.Ports}}}' "$container"
sudo docker exec "$container" node -e 'console.log(JSON.stringify({trial:process.env.BOOKING_MIGRATION_TRIAL,writes:process.env.BOOKING_WRITES_ENABLED,unexpectedCredentialKeys:Object.keys(process.env).filter(k=>/RAGIC|SUPABASE_DB|OUTREACH|WEBHOOK|LINE_CHANNEL|ADMIN_PASSWORD/.test(k))}))'
sudo stat -c 'trial.env permission=%a owner=%U' /srv/oneplace-booking-trial/trial.env
