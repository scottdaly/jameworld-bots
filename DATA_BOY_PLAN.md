# Data Boy

A Discord bot that answers ad-hoc questions about the jameworld message history by running Claude (via the Agent SDK) with full agentic tools over a read-only Postgres connection.

## Goal

Ask Data Boy any question about what's been said in jameworld — `who said "lol" the most?`, `compare scott and matthan's posting style`, `what topics blew up in October?`, `summarize jake's personality` — and get a real answer backed by the actual data.

## Why agentic

130k+ messages is too big to fit in context, so a plain "messages.create with the data in the prompt" approach can't work without pre-aggregating away the interesting questions. The Agent SDK lets Claude iteratively query the DB, run Python over the results, refine its approach, and synthesize — which matches how a real analyst would attack these questions.

## Architecture

```
Discord user → @Data Boy <question>
                 │
                 ▼
        data-boy.js  (Node, in container, alongside the existing bots)
                 │
                 ▼
        Claude Agent SDK  query()  ← authenticated via Claude.ai Max OAuth
                 │
                 ▼
        Claude reasons + uses tools:
          - Bash       (psql, python3, jq pre-installed)
          - Read/Write (scratch files in /tmp/data-boy-work/)
          - Edit
          - Grep, Glob
          - query_db   (MCP convenience tool — typed SELECT with caps)
                 │
                 ▼
        Final answer (chunked to ≤2000 chars) → posted in Discord
```

One bot, one container, same shape as the existing two bots.

## Components

### 1. Discord bot wrapper — `data-boy.js`

- Same skeleton as `index.js` / `josh-hansen.js`.
- Triggers on **@-mention only**.
- On mention:
  1. Post placeholder *"Data Boy is thinking…"*
  2. Invoke `query()` from the Agent SDK with the user's question
  3. Stream progress events back as edits to the placeholder (or as new messages for substantive steps — TBD during impl)
  4. Final answer replaces placeholder. If >2000 chars, split across multiple messages.
- In-memory rate limit:
  - One in-flight query per user
  - Hard cap of N queries/hour across all users (configurable)
- Logs every question + final answer + token usage to `data_boy_logs` for audit.

### 2. Agent SDK integration

- Package: `@anthropic-ai/claude-agent-sdk` (Node).
- Authentication: **Claude Code OAuth token** so usage draws from the Claude.ai Max subscription instead of pay-as-you-go API billing.
  - Generate with `claude setup-token` on the Mac.
  - Injected into the container as `CLAUDE_CODE_OAUTH_TOKEN`.
- Default model: `claude-sonnet-4-6` (right cost/quality balance for this workload).
- Constraints passed to `query()`:
  - `maxTurns: 30` — generous, because some questions need many iterative queries.
  - `allowedTools`: Bash, Read, Write, Edit, Grep, Glob, plus the MCP DB tool.
  - `permissionMode: 'bypassPermissions'` since the container itself is the sandbox.
  - `cwd: '/tmp/data-boy-work'` — fresh scratch dir per query.

### 3. Tools available to Claude

Standard SDK tools (Bash, Read, Write, Edit, Grep, Glob) work inside the container. The container ships with:

- `psql` (postgresql-client)
- `python3` with `pandas`, `matplotlib` (for analysis; charts can be saved as files and uploaded back to Discord later if we want)
- `jq` for JSON wrangling
- A pre-set `PGCONN` env var pointing at the read-only Postgres role, so Claude can do `psql "$PGCONN" -c "SELECT …"` without managing credentials.

Plus one custom MCP tool for ergonomics:

- **`query_db(sql: string)`** — runs a `SELECT`/`WITH` query against the read-only role, enforces `statement_timeout = 10s`, caps results at 1000 rows, returns JSON. Faster than `psql` for trivial questions; Claude will fall back to Bash + `psql` for streaming large results into a file when the row cap matters.

No tool gives write access to Postgres. The DB role can't `UPDATE`, `INSERT`, `DELETE`, or DDL.

### 4. Postgres read-only role

```sql
CREATE ROLE jameworld_readonly LOGIN PASSWORD :'pw';
GRANT CONNECT ON DATABASE jameworld TO jameworld_readonly;
GRANT USAGE ON SCHEMA public TO jameworld_readonly;
GRANT SELECT ON messages, user_profiles TO jameworld_readonly;
ALTER ROLE jameworld_readonly SET statement_timeout = '10s';
ALTER ROLE jameworld_readonly SET work_mem = '64MB';
```

### 5. Logging table

```sql
CREATE TABLE data_boy_logs (
  id SERIAL PRIMARY KEY,
  asked_at TIMESTAMP DEFAULT now(),
  discord_user TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  turns INT,
  input_tokens INT,
  output_tokens INT,
  error TEXT,
  duration_ms INT
);
```

Useful for: debugging "why did Data Boy say X," capping users who abuse it, deciding whether to upgrade to Opus for hard questions.

### 6. System prompt — `data-boy-prompt.md`

Lives next to the code so it can be edited without rebuilding the image (mounted as a file).

Tells Claude:
- It's "Data Boy," a Discord bot that answers questions about a friend group's chat history.
- The DB schema, current row counts, and date range (computed at startup, injected into the prompt).
- Tools available, how to use `psql` and `query_db`.
- Discord-friendly formatting: tight prose, Markdown tables OK, ≤1800 chars where possible (the wrapper splits if needed).
- Don't quote raw embarrassing/private content verbatim — paraphrase.
- For "personality" questions, sample messages and synthesize; don't just dump examples.
- For trend/topic questions, use `psql` to write a Python script that does the heavy lifting rather than asking Claude to do clustering in its head.
- Hard limit reminder: keep total tool calls reasonable; this draws from a real usage budget.

## Schema reminder

```sql
messages (
  id SERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT UNIQUE NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TIMESTAMP NOT NULL
)

user_profiles (
  username TEXT PRIMARY KEY,
  profile TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

131k+ rows in `messages`, 28 channels, earliest 2023-09-01, latest live.

`channel_id` is the raw Discord snowflake — Claude won't know the human-readable names. We'll either:
- Inject a channel-name map into the system prompt at startup (cheap, ~20 lines), or
- Add a `channels` lookup table populated from the bot's Discord cache on boot.

Decision: inject as map in the prompt. Simpler, no schema change.

## Authentication

- **Anthropic side**: `CLAUDE_CODE_OAUTH_TOKEN` minted with `claude setup-token` on your Mac. Long-lived. Bills to Max sub.
- **Discord side**: New bot account in Discord Developer Portal. Token goes in `.env` as `DISCORD_TOKEN_DATA_BOY`. Invite to server with `Send Messages` + `Read Message History` (+ `Attach Files` if/when we ship charts).
- **Postgres side**: `POSTGRES_READONLY_USER` / `POSTGRES_READONLY_PASSWORD` in `.env`. Container env composes them into `PGCONN`.

## File layout

```
jameworld-bots/
├── data-boy.js                ← new
├── data-boy-prompt.md         ← new (mounted at runtime, not baked in)
├── Dockerfile.data-boy        ← new
├── migrations/
│   └── 001-data-boy.sql       ← new (readonly role + logs table)
├── docker-compose.yml         ← add service `discord-bot-data-boy`
├── package.json               ← add @anthropic-ai/claude-agent-sdk
└── .env                       ← add 3 new keys
```

## Manual steps (you do these)

1. Discord Developer Portal → create new application "Data Boy" → Bot tab → reveal token → paste into `.env` as `DISCORD_TOKEN_DATA_BOY`.
2. OAuth2 → URL Generator → scopes `bot`, perms `Send Messages` + `Read Message History` → use generated URL to invite Data Boy to the server.
3. On Mac, run `claude setup-token` → paste resulting token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
4. Choose a Postgres read-only password and add to `.env` as `POSTGRES_READONLY_PASSWORD` (user is hard-coded to `jameworld_readonly`).

## Implementation order

1. **Migration**: read-only pg role + `data_boy_logs` table. Apply by hand to confirm.
2. **Dockerfile.data-boy**: based on `node:20-bullseye`, add `postgresql-client`, `python3`, `python3-pip`, `pandas`, `matplotlib`, `jq`.
3. **Bare bot**: `data-boy.js` logs in to Discord, echoes mentions back. Smoke test end-to-end with placeholder Anthropic call.
4. **Agent SDK wiring**: replace echo with `query()`, no tools yet — just confirm OAuth auth and Claude responds.
5. **Tools enabled**: turn on Bash + filesystem tools, set up `/tmp/data-boy-work/`, expose `PGCONN`. Hand-test with three real questions.
6. **`query_db` MCP tool**: implement, register in SDK options.
7. **System prompt**: write `data-boy-prompt.md`, iterate against a battery of test questions.
8. **UX polish**: chunked replies, edit-in-place placeholder, rate limit per user.
9. **Logging**: write to `data_boy_logs` after every query.
10. **docker-compose.yml**: add service; `docker compose up -d --build discord-bot-data-boy`.
11. **Commit + push**.

## Cost & safety

- **Cost**: Sonnet 4.6 + ~5-15 tool turns per question = each question is a meaningful slice of the 5-hour Max window. The per-user/hour rate limit is the main lever; we can also gate by Discord role.
- **SQL injection**: not possible — DB role can only `SELECT` on two tables.
- **Runaway query**: `statement_timeout = 10s` enforced at the role level.
- **Token runaway**: `maxTurns: 30`.
- **Container blast radius**: same as the other bots — isolated container, no host mounts beyond what's declared in compose. Worst case Claude trashes its own `/tmp` scratch dir.
- **Privacy**: messages live in jameworld already. Bot can't post outside of jameworld. Logged queries stay in the same DB.

## Decisions made silently

- **Node, not Python** — matches the rest of the repo.
- **Max OAuth, not API key** — cost.
- **Sonnet 4.6, not Opus** — start cheap, escalate later if answers are weak.
- **@-mention only** — consistent with the other bots, avoids noise.
- **Full agentic tools, not narrow custom tools** — quality of answers > tighter sandboxing, given the DB role is already locked down.
