-- Username → avatar URL cache, so the leaderboard can show real Discord
-- avatars instead of letter placeholders — without holding a token. The main
-- bot (already in the server, with the GuildMembers intent) upserts this on
-- startup and every few hours; the leaderboard reads it via its read-only role
-- and joins on messages.author = discord_users.username.
--
-- Apply with:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < migrations/008-discord-users.sql

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS discord_users (
  username   TEXT PRIMARY KEY,
  avatar_url TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

GRANT SELECT ON discord_users TO jameworld_readonly;
