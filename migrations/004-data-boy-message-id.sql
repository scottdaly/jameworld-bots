-- Add a unique constraint keyed on the originating Discord message_id so that
-- two handler invocations for the same Discord message cannot both produce a
-- response. The in-memory dedup (Map keyed on message.id + content fingerprint)
-- has failed in prod: on 2026-05-18 a single process produced two answer runs
-- (one shallow, one deep) for the same Discord message, which is impossible from
-- a pure deterministic classifier. The cause is unknown; DB-level uniqueness is
-- the only bulletproof defense.

ALTER TABLE data_boy_logs
  ADD COLUMN IF NOT EXISTS discord_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS data_boy_logs_discord_message_id_uniq
  ON data_boy_logs (discord_message_id)
  WHERE discord_message_id IS NOT NULL;
