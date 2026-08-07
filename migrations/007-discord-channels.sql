-- Channel id → name cache, so the public leaderboard can show "#channel"
-- names WITHOUT holding a Discord token. The main Jameworld bot (which is
-- already in the server and already has the token) upserts this table on
-- startup and every few hours; the leaderboard reads it via its read-only
-- role. This keeps the bot token entirely out of the public-facing container.
--
-- Apply with:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < migrations/007-discord-channels.sql

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS discord_channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- The leaderboard connects as the read-only role; let it read the names.
GRANT SELECT ON discord_channels TO jameworld_readonly;
