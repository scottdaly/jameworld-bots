-- Bot prompt observability: capture the exact assembled system prompt
-- each bot sends to its model, for debugging behavior like cross-bot
-- topic bleed (see incident 2026-05-17 where Zuck answered Data Boy's
-- glaze-rankings question because Data Boy's recent reply was in Zuck's
-- last-100-messages context window).
--
-- Apply with:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < migrations/003-bot-prompt-logs.sql

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS bot_prompt_logs (
  id                  SERIAL PRIMARY KEY,
  ts                  TIMESTAMP NOT NULL DEFAULT now(),
  bot_name            TEXT NOT NULL,
  channel_id          TEXT,
  triggering_author   TEXT,
  triggering_content  TEXT,
  system_prompt       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bot_prompt_logs_ts_idx ON bot_prompt_logs (ts DESC);
CREATE INDEX IF NOT EXISTS bot_prompt_logs_bot_idx ON bot_prompt_logs (bot_name, ts DESC);

-- Read access for the readonly role so Data Boy can also query its own logs.
GRANT SELECT ON bot_prompt_logs TO jameworld_readonly;
