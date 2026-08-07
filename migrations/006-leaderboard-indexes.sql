-- Indexes to support the leaderboard's range- and channel-filtered aggregations.
--
-- Apply with:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < migrations/006-leaderboard-indexes.sql
--
-- The leaderboard (web/leaderboard.js) filters messages by `timestamp`
-- (24h/7d/30d ranges) and `channel_id`, grouping by author. Without these the
-- public endpoints seq-scan the whole messages table (~148k rows) on every
-- request. Cheap headroom for a publicly-reachable page.

\set ON_ERROR_STOP on

CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (timestamp);
CREATE INDEX IF NOT EXISTS messages_channel_id_idx ON messages (channel_id);
