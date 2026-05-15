-- Data Boy: read-only role and audit log table.
--
-- Apply with:
--   PW=<password> sed "s/__PW__/$PW/" migrations/001-data-boy.sql | \
--     docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -
--
-- The password placeholder is substituted by the caller. Keep the file
-- itself secret-free so it can live in git.

\set ON_ERROR_STOP on

-- CREATE ROLE is not idempotent; tolerate "already exists" by checking first.
SELECT 'CREATE ROLE jameworld_readonly LOGIN PASSWORD ''__PW__'''
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jameworld_readonly')
\gexec

ALTER ROLE jameworld_readonly WITH LOGIN PASSWORD '__PW__';

GRANT CONNECT ON DATABASE jameworld TO jameworld_readonly;
GRANT USAGE ON SCHEMA public TO jameworld_readonly;
GRANT SELECT ON messages, user_profiles TO jameworld_readonly;

ALTER ROLE jameworld_readonly SET statement_timeout = '10s';
ALTER ROLE jameworld_readonly SET work_mem = '64MB';
ALTER ROLE jameworld_readonly SET default_transaction_read_only = on;

CREATE TABLE IF NOT EXISTS data_boy_logs (
  id            SERIAL PRIMARY KEY,
  asked_at      TIMESTAMP NOT NULL DEFAULT now(),
  discord_user  TEXT NOT NULL,
  question      TEXT NOT NULL,
  answer        TEXT,
  turns         INT,
  input_tokens  INT,
  output_tokens INT,
  error         TEXT,
  duration_ms   INT
);

CREATE INDEX IF NOT EXISTS data_boy_logs_asked_at_idx ON data_boy_logs(asked_at DESC);
CREATE INDEX IF NOT EXISTS data_boy_logs_discord_user_idx ON data_boy_logs(discord_user);
