# jameworld-bots

Discord bots for the jameworld server. The one that matters most is **Data
Boy** (`data-boy.js`): it answers questions about the message archive and,
through `!feature`, runs a coding agent against the game **Toaster City**
(sibling repo `../toaster-city`, live at https://city.rsdaly.com), gates the
build, merges to `main` and publishes. Everything below is what an agent
needs to work in this repo without breaking production. Read it before
touching anything; `DATA_BOY_PLAN.md` is the original design doc and is
partly stale.

## The two machines

| alias (ssh config on this machine) | what it runs | path |
|---|---|---|
| `vultr` (45.32.214.208) | the bots, Postgres, docker compose | `/root/jameworld-bots` (also `~/jameworld-bots`) |
| `dodroplet` (159.65.226.82) | the game's build host and web root; Emscripten lives here | `/var/www/city` (releases + `current` symlink), `~/toaster-scores` |

Both are reachable with plain `ssh vultr` / `ssh dodroplet` (BatchMode works).
Secrets live only in `/root/jameworld-bots/.env` on vultr -- never commit
one, never print one. To see which keys exist: `grep -oE "^[A-Z_]+" .env`.

## Architecture of Data Boy

Two processes from the same image, chosen by argv:

- **gateway** (`node data-boy.js`, container `jameworld-bots-discord-bot-data-boy-1`)
  holds the Discord connection. It answers chat questions itself and, with
  `TOASTER_SPLIT=1` (set in compose), turns feature requests into **jobs**
  in Postgres (`data_boy_logs` rows with `job_*` columns) and posts whatever
  the worker leaves in the **outbox** (`data_boy_outbox`). It also refreshes
  the "still thinking" placeholders, dead-letters jobs nobody can finish,
  and handles `!status`, `!cancel`, `!datastats`.
- **worker** (`node data-boy.js --worker`, container
  `jameworld-bots-discord-bot-data-boy-worker-1`) has no Discord connection.
  It claims jobs (`job-queue.js`, `FOR UPDATE SKIP LOCKED`, lease +
  heartbeat, an ownership fence of `{worker, attempt}` on every write), runs
  `toaster-feature.js`, and writes replies to the outbox. It runs up to
  `TOASTER_WORKER_CONCURRENCY` (default 2) jobs at once in ONE process; the
  integration lock that serialises gate/merge/publish is an in-process
  promise chain, so **never run two worker containers**.
- `toaster-feature.js` is the pipeline for one request: clone the game repo
  into `/tmp/data-boy-work/<discord message id>`, optionally plan it into
  increments (the planner reads a clone of the repo first), run the coding
  agent with `feature-prompt.md`, then `ssh toaster-deploy` (an alias
  inside the container for dodroplet) to run the game's `deploy.sh "gate
  <ref>"` (all seven gates), merge, `deploy.sh origin/main`, and fetch the
  preview. The agent may leave its own screenshot at
  `<workDir>-scratch/preview.png`; that is what gets posted when present.
- Feature work defaults to the Codex SDK (`FEATURE_PROVIDER=codex`, model
  `gpt-5.6-sol`, high reasoning). Normal Data Boy chat is unchanged. Codex
  can write only in that job's checkout and attachment folders; commands it
  runs have no bot/database/GitHub secrets and no network. The outer pipeline
  alone pushes and publishes after the build gates pass.
  The worker alone has the Docker settings needed to start Codex's inner
  bubblewrap sandbox. Do not copy those settings to the gateway. The inner
  sandbox gives each request a private process list, blocks network, and keeps
  the container read-only outside that job's allowed folders. Its permission
  profile also hides SSH keys, Gemini login files, cached repos, and sibling
  jobs completely.
- `error-classify.js`: capacity (429/503/529) vs auth failures, and the
  jokey user-facing messages. Keep the tone; name the provider that failed.

Attachments: audio and images are fetched at request time (Discord URLs
expire) into `<workDir>.audio` / `<workDir>.images`, outside the checkout,
and reused across retries and re-claims.

## Running and deploying

- A Codex feature deployment needs `FEATURE_PROVIDER=codex` and
  `CODEX_API_KEY` in vultr's private `.env`. `bot-deploy.sh` refuses to
  restart without the key when Codex is selected.
- Deploy is done **on vultr**, never by copying files:
  ```
  git push origin main
  ssh vultr 'cd /root/jameworld-bots && ./bot-deploy.sh worker'   # the worker
  ssh vultr 'cd /root/jameworld-bots && ./bot-deploy.sh'          # the gateway
  ```
  `bot-deploy.sh` pulls, syntax-checks, verifies every required file is
  COPYed in `Dockerfile.data-boy`, **refuses if any job is queued or
  running**, restarts, and verifies the container is up. When you add a
  file that data-boy.js requires, add it to both the Dockerfile and the
  required-files list in `bot-deploy.sh`.
- Never deploy or push while a job is in flight. Check:
  ```
  ssh vultr 'cd ~/jameworld-bots && docker compose exec -T db psql -U jameworld -d jameworld -t -A -c "SELECT id, discord_user, job_status FROM data_boy_logs WHERE job_status IN ('"'"'queued'"'"','"'"'running'"'"')"'
  ```
- Logs: `docker logs jameworld-bots-discord-bot-data-boy-1 --since 1h` (gateway),
  same with `-worker-1`. The gateway logs every outbox post with the Discord
  message id; the worker logs `[worker] job N ...` and `[toaster] ...`.
- The database: `docker compose exec -T db psql -U jameworld -d jameworld`.
  Useful tables: `data_boy_logs` (every question and job; `job_payload`,
  `job_state` are JSON), `data_boy_outbox`, `data_boy_workers` (presence),
  `data_boy_placeholder_deletions`.

## Tests

Plain Node scripts, no framework:
```
node tests/error-classify-test.js      # pure
node tests/pump-test.js                # worker concurrency scheduler, pure
node tests/preview-test.js             # agent preview acceptance
node tests/image-attachment-test.js    # real local HTTP server + real curl
node tests/outage-retry-test.js        # real local git repo, mocked agent
node tests/cancel-flow-test.js         # real local git repo, mocked agent
node tests/planner-test.js             # real local git repo, mocked agent
NODE_PATH=<dir>/node_modules node tests/queue-test.js   # needs embedded-postgres + pg installed in <dir>
```
Run all of them before a deploy. They use real Postgres, real git and real
HTTP on purpose; do not replace those with mocks that would hide the bug.

## Conventions that exist for a reason

- Every write after a job claim must carry the fence; losing it aborts the
  model call and stops the job (`!cancel` works by breaking the fence).
- The planner splits big requests into increments; a revert/restore is one
  step from git history and "polish" must not re-author it.
- Discord messages are posted as new messages, never by editing a
  placeholder; placeholders are deleted when the final answer lands.
- `feature-prompt.md` is CRLF; keep it that way. The game's own rules are
  in `../toaster-city/CLAUDE.md` -- the agent reads it every job.
- Codex audits (`codex exec --skip-git-repo-check -s read-only ... < /dev/null`)
  have been the most useful review tool here; the PowerShell profile noise
  it prints is harmless.

## The game side, briefly

`../toaster-city` is pushed with `./tools/push.sh` from Git Bash on Windows:
it refuses on a dirty tree, an in-flight job or a moved `origin/main`, runs
all seven gates in WSL, pushes, and publishes on dodroplet. Its `CLAUDE.md`
carries the invariants (no new files, procedural art, keyed saves, the
world model). The scores API (`toaster-scores` container on dodroplet)
backs the in-game leaderboard.

## Reusing this for another game bot

Keep one Discord app and one deployment per game. Reuse this image and set
`GAME_NAME`, `GAME_DESCRIPTION`, `GAME_RULES_FILE`, `GAME_REPO`,
`GAME_DEPLOY_HOST`, `GAME_SITE_URL`, and `FEATURE_PROMPT_PATH`. Each game
still needs its own build/deploy rules and its own least-privilege keys; do
not give one bot a key that can change every game.
