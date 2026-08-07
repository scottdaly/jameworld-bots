-- A drop-in view over `messages` with the author already resolved through
-- author_aliases, so anything grouping/counting by author treats renamed users
-- (e.g. 'Almighty Zuck' → 'Zuckerbuns') as one person. Same columns as
-- `messages`. Used by Data Boy so its analysis matches the leaderboard.
--
-- Apply with:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < migrations/010-messages-canonical-view.sql

\set ON_ERROR_STOP on

CREATE OR REPLACE VIEW messages_canonical AS
  SELECT m.id,
         m.channel_id,
         m.message_id,
         COALESCE(a.canonical, m.author) AS author,
         m.content,
         m.timestamp
  FROM messages m
  LEFT JOIN author_aliases a ON a.alias = m.author;

GRANT SELECT ON messages_canonical TO jameworld_readonly;
