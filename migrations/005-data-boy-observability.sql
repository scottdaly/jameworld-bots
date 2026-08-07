-- Data Boy observability: explain empty answers, and record self-inflicted
-- placeholder deletions.
--
-- Apply with:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < migrations/005-data-boy-observability.sql
--
-- Motivation (verified against prod on 2026-08-07):
--   1. "(Data Boy returned no answer.)" is dominated by the model burning all
--      MAX_TURNS (30) without emitting final text — but the logs couldn't tell
--      that apart from a genuine empty reply. `status` captures the SDK's
--      terminal reason (Anthropic result.subtype / Vercel AI finishReason).
--   2. Queries whose duration_ms exceeds the janitor's 90s window (p95 was
--      169s, max 306s) were having their live "still working…" placeholder
--      deleted by cleanupStalePlaceholders, which then surfaced as an
--      `error = 'Unknown Message'` and threw the finished answer away. The
--      audit table below records every janitor deletion so this is never
--      silent again.

\set ON_ERROR_STOP on

-- 1. Terminal status of each run: 'success', 'error_max_turns',
--    'error_during_execution' (Anthropic), or a Vercel AI finishReason like
--    'stop' / 'length' / 'tool-calls' (Gemini paths). NULL for rows that
--    errored before producing a result, or predate this migration.
ALTER TABLE data_boy_logs
  ADD COLUMN IF NOT EXISTS status TEXT;

-- 2. Audit trail for placeholder messages the janitor deletes. A row here that
--    coincides with a still-running query is the fingerprint of the cleanup
--    race; once the live-placeholder guard is in place this table should only
--    ever record genuinely orphaned placeholders (e.g. post-redeploy).
CREATE TABLE IF NOT EXISTS data_boy_placeholder_deletions (
  id              SERIAL PRIMARY KEY,
  deleted_at      TIMESTAMP NOT NULL DEFAULT now(),
  channel_id      TEXT,
  message_id      TEXT,
  message_age_ms  BIGINT,
  content         TEXT
);

CREATE INDEX IF NOT EXISTS data_boy_placeholder_deletions_deleted_at_idx
  ON data_boy_placeholder_deletions(deleted_at DESC);
