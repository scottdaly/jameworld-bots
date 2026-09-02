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

  # Pull first: the repo is edited from a local clone and pushed, so the
  # server's job is to fetch what was reviewed -- not to be a place files
  # are copied to by hand, which is how three commits ended up existing
  # only on this box.
  git pull --ff-only --quiet origin main || fail "could not fast-forward from origin"
  echo "  pulled $(git rev-parse --short HEAD)"

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
  # Deliberately dumb. The previous version grepped the logs for the Discord
  # login line and reported a healthy bot as broken three separate times --
  # once because login was slower than a fixed sleep, once because the line had
  # scrolled out of the tail on a long-running container, once because of
  # --since parsing. A check that cries wolf gets ignored, which is worse than
  # no check. These four signals cannot be wrong about whether it is running.
  local name=jameworld-bots-discord-bot-data-boy-1
  sleep 6

  local state restarts
  state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)
  [ "$state" = "running" ] || fail "container state is '$state'"

  # The real symptom of a broken build is a crash loop, not a missing log line.
  sleep 6
  restarts=$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null)
  sleep 6
  local restarts2
  restarts2=$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null)
  [ "$restarts" = "$restarts2" ] || fail "crash looping (restart count $restarts -> $restarts2)"

  docker compose logs --tail=60 "$SVC" 2>&1 | grep -q "MODULE_NOT_FOUND"     && fail "module load failure"

  echo "  running, not crash looping, module loaded"

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
    # Remember the start time so verify can tell a real restart from a
    # no-op, instead of demanding a fresh login line either way.
    WAS_STARTED=$(docker inspect -f '{{.State.StartedAt}}' \n      jameworld-bots-discord-bot-data-boy-1 2>/dev/null)
    echo "== restarting =="
    docker compose up -d --build "$SVC" 2>&1 | tail -1
    verify ;;
  *) echo "usage: $0 [check|deploy]" >&2; exit 2 ;;
esac
