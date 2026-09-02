#!/usr/bin/env bash
# Restart the data-boy container safely.
#
# Written after an evening where the damage came almost entirely from careless
# restarts rather than bad code: a file the Dockerfile did not COPY took the
# bot fully offline, and three in-flight jobs were destroyed because nothing
# checked whether anyone was mid-request. Each check below is one of those.
#
#   ./bot-deploy.sh          preflight, restart, verify
#   ./bot-deploy.sh check    preflight only
set -uo pipefail
cd "$(dirname "$0")"
SVC=discord-bot-data-boy
fail() { echo "FAILED: $*" >&2; exit 1; }

psql_q() {
  docker compose exec -T db sh -c \
    "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -t -A -c \"$1\"" 2>/dev/null | tr -d '\r'
}

preflight() {
  echo "== preflight =="

  node --check data-boy.js || fail "data-boy.js does not parse"
  node -e 'require("./toaster-feature.js")' || fail "toaster-feature.js does not load"
  echo "  syntax ok"

  docker compose config >/dev/null || fail "docker-compose.yml is invalid"
  echo "  compose ok"

  # The container only gets files the Dockerfile explicitly copies. Forgetting
  # one is invisible on the host and fatal inside the image.
  for f in data-boy.js toaster-feature.js feature-prompt.md data-boy-prompt.md code-prompt.md; do
    grep -q "$f" Dockerfile.data-boy || fail "$f is not COPYed in Dockerfile.data-boy"
  done
  echo "  all required files are in the image"

  # Never restart on top of someone's request.
  local n
  n=$(psql_q "SELECT count(*) FROM data_boy_logs WHERE answer IS NULL AND error IS NULL AND asked_at > NOW() - INTERVAL '2 hours';")
  [ "${n:-0}" = "0" ] || fail "$n job(s) in flight -- wait for them"
  echo "  no jobs in flight"

  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "  WARNING: uncommitted changes -- no rollback point if this goes wrong"
  else
    echo "  working tree clean ($(git rev-parse --short HEAD))"
  fi
}

verify() {
  echo "== verify =="
  sleep 8
  docker compose ps "$SVC" --format '{{.Status}}' | grep -q '^Up' || fail "container is not Up"
  docker compose logs --tail=40 "$SVC" 2>&1 | grep -q "MODULE_NOT_FOUND" && fail "module load failure"
  docker compose logs --tail=40 "$SVC" 2>&1 | grep -q "Logged in as" || fail "never connected to Discord"
  echo "  container up and connected"

  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' https://city.rsdaly.com/)
  [ "$code" = "200" ] || echo "  WARNING: site returned $code"
  echo "  site $code"
  echo "OK"
}

case "${1:-deploy}" in
  check) preflight ;;
  deploy)
    preflight
    echo "== restarting =="
    docker compose up -d --build "$SVC" 2>&1 | tail -1
    verify ;;
  *) echo "usage: $0 [check|deploy]" >&2; exit 2 ;;
esac
