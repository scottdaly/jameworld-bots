#!/usr/bin/env bash
# Redeploy a single jameworld-bots service cleanly.
# Usage: ./redeploy.sh discord-bot-data-boy
#
# Background: on 2026-05-17 we hit a recurring "permission denied on stop"
# paper-cut that left ghost containers behind. Root cause was two competing
# dockerd instances (snap + system). System dockerd is now disabled, so the
# bad path should no longer happen — but this helper still gives us a
# defensive, single-command path that's safer than --force-recreate.

set -euo pipefail

cd "$(dirname "$0")"

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "Usage: $0 <service-name>"
  echo "Services: $(docker compose config --services | tr '\n' ' ')"
  exit 1
fi

CONTAINER="jameworld-bots-${SERVICE}-1"

echo "==> Rebuilding image for $SERVICE"
docker compose build "$SERVICE"

echo "==> Stopping existing $CONTAINER (if running)"
STOP_OUT=$(docker compose stop -t 10 "$SERVICE" 2>&1) || true
echo "$STOP_OUT"

# Docker on this host hits a recurring "permission denied" race when stopping
# containers. Kill the containerd-shim (NOT the node child) to bypass it —
# killing the node alone races with containerd's auto-restart.
if echo "$STOP_OUT" | grep -q "permission denied"; then
  CID=$(docker inspect "$CONTAINER" --format '{{.Id}}' 2>/dev/null | head -c 12)
  if [[ -n "$CID" ]]; then
    SHIM_PID=$(pgrep -f "containerd-shim.*${CID}" | head -1)
    if [[ -n "$SHIM_PID" ]]; then
      echo "==> docker stop hit permission-denied; killing shim $SHIM_PID to unblock"
      kill -9 "$SHIM_PID" 2>/dev/null || sudo kill -9 "$SHIM_PID" 2>/dev/null || {
        echo "    ERROR: couldn't kill shim — run manually: sudo kill -9 $SHIM_PID"
        exit 3
      }
      sleep 2
    fi
  fi
fi

echo "==> Removing $CONTAINER (force)"
docker compose rm -f "$SERVICE" 2>&1 || true
docker rm -f "$CONTAINER" 2>/dev/null || true

# Belt and suspenders: catch any containerd-shim still supervising the old ID.
ORPHANS=$(ps -eo pid,cmd | awk -v svc="$SERVICE" '
  /containerd-shim-runc-v2/ {
    for (i=1; i<=NF; i++) if ($i == "-id") { id=$(i+1); break }
    print $1 "\t" id
  }
' | while read -r pid id; do
  # Print orphans: shim IDs that no running container claims.
  if [[ -n "$id" ]] && ! docker inspect "$id" >/dev/null 2>&1; then
    echo "$pid $id"
  fi
done)
if [[ -n "$ORPHANS" ]]; then
  echo "==> WARNING: orphan containerd-shims detected, killing:"
  echo "$ORPHANS"
  echo "$ORPHANS" | awk '{print $1}' | xargs -r kill -9
fi

echo "==> Starting fresh $SERVICE"
docker compose up -d --no-deps "$SERVICE"

echo "==> Tail (5s) — Ctrl-C to detach early"
timeout 5 docker compose logs -f --tail 20 "$SERVICE" || true

echo
echo "==> Done. Live container:"
docker ps --filter "name=$CONTAINER" --format "table {{.Names}}\t{{.Status}}"
