#!/usr/bin/env bash
# Restart the data-boy container safely.
#
# Written after an evening where the damage came almost entirely from careless
# restarts rather than bad code: a file the Dockerfile did not COPY took the
# bot fully offline, and three in-flight jobs were destroyed because nothing
# checked whether anyone was mid-request. Each check below is one of those.
#
#   ./bot-deploy.sh          preflight, restart, verify  (the gateway)
#   ./bot-deploy.sh check    preflight only
#   ./bot-deploy.sh worker   the same, for the job worker
#
# Two services now. The gateway holds the Discord connection and answers
# everything short; the worker runs feature jobs. Deploying the gateway is the
# common case and, once the split is live, cannot disturb a running job --
# which is the entire reason the worker exists.
set -uo pipefail
cd "$(dirname "$0")"
SVC=discord-bot-data-boy
WSVC=discord-bot-data-boy-worker
TARGET="$SVC"
CONTAINER=jameworld-bots-discord-bot-data-boy-1

# Is feature work actually running somewhere this deploy will not touch? Both
# halves have to be true: a worker container up, and the gateway told to use
# it. Either one alone means jobs are still in this container.
split_live() {
  docker ps -q -f "name=jameworld-bots-${WSVC}-1" -f status=running | grep -q . || return 1
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \
    jameworld-bots-discord-bot-data-boy-1 2>/dev/null | grep -qx 'TOASTER_SPLIT=1'
}
fail() { echo "FAILED: $*" >&2; exit 1; }

psql_q() {
  docker compose exec -T db sh -c \
    "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -t -A -c \"$1\"" 2>/dev/null | tr -d '\r'
}

preflight() {
  echo "== preflight =="

  local feature_provider
  feature_provider=$(sed -n 's/^FEATURE_PROVIDER=//p' .env 2>/dev/null | tail -1)
  feature_provider=${feature_provider:-codex}
  if [ "$feature_provider" = "codex" ]; then
    grep -q '^CODEX_API_KEY=.' .env 2>/dev/null || fail "Codex is selected but its API key is missing"
  fi

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
  for f in data-boy.js toaster-feature.js job-queue.js error-classify.js feature-prompt.md data-boy-prompt.md code-prompt.md; do
    grep -q "$f" Dockerfile.data-boy || fail "$f is not COPYed in Dockerfile.data-boy"
  done
  echo "  all required files are in the image"

  # Never restart on top of someone's request -- unless the request is not in
  # the container being restarted. Once the split is live a feature job runs in
  # the worker, so blocking a routing change behind somebody's hour-long job is
  # pure cost with nothing bought.
  local n
  n=$(psql_q "SELECT count(*) FROM data_boy_logs WHERE answer IS NULL AND error IS NULL AND asked_at > NOW() - INTERVAL '2 hours';")
  if [ "${n:-0}" = "0" ]; then
    echo "  no jobs in flight"
  elif [ "$TARGET" = "$SVC" ] && split_live; then
    echo "  $n job(s) in flight, but they run in the worker -- the gateway is safe to restart"
  else
    fail "$n job(s) in flight -- wait for them"
  fi

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
  local name="$CONTAINER"
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

  docker compose logs --tail=60 "$TARGET" 2>&1 | grep -q "MODULE_NOT_FOUND"  && fail "module load failure"

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
    echo "== restarting the gateway =="
    docker compose up -d --build "$SVC" 2>&1 | tail -1
    verify ;;
  worker)
    # The worker is the container jobs actually live in, so this one does wait
    # for them -- there is no third process to hand them to.
    TARGET="$WSVC"
    CONTAINER="jameworld-bots-${WSVC}-1"
    preflight
    echo "== restarting the worker =="
    docker compose up -d --build "$WSVC" 2>&1 | tail -1
    verify ;;
  *) echo "usage: $0 [check|deploy|worker]" >&2; exit 2 ;;
esac
