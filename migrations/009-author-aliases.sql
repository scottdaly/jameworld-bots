-- Map old author names to a canonical one so the leaderboard counts them as a
-- single person. Non-destructive: the messages table keeps the original author
-- string; the leaderboard resolves aliases at query time.
--
-- Apply with:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < migrations/009-author-aliases.sql

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS author_aliases (
  alias     TEXT PRIMARY KEY,
  canonical TEXT NOT NULL
);

-- "Almighty Zuck" is just Zuckerbuns' old name.
INSERT INTO author_aliases (alias, canonical) VALUES ('Almighty Zuck', 'Zuckerbuns')
  ON CONFLICT (alias) DO UPDATE SET canonical = EXCLUDED.canonical;

GRANT SELECT ON author_aliases TO jameworld_readonly;
