-- Episodes: derived table of windowed exchanges with metadata.
-- Populated offline by episodes/scan.js (Haiku batch enrichment).

CREATE TABLE IF NOT EXISTS episodes (
  id                    SERIAL PRIMARY KEY,
  channel_id            TEXT NOT NULL,
  start_ts              TIMESTAMP NOT NULL,
  end_ts                TIMESTAMP NOT NULL,
  start_msg_id          TEXT NOT NULL,
  end_msg_id            TEXT NOT NULL,
  peak_msg_id           TEXT,
  message_count         INTEGER NOT NULL,
  participants          TEXT[] NOT NULL,
  kind                  TEXT NOT NULL,
  sentiment             TEXT NOT NULL,
  intensity             REAL NOT NULL,
  topic                 TEXT,
  summary               TEXT NOT NULL,
  representative_quote  TEXT,
  arc                   TEXT,
  generated_at          TIMESTAMP NOT NULL DEFAULT now(),
  generator_version     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS episodes_channel_ts_idx ON episodes (channel_id, start_ts);
CREATE INDEX IF NOT EXISTS episodes_participants_idx ON episodes USING GIN (participants);
CREATE INDEX IF NOT EXISTS episodes_kind_sentiment_idx ON episodes (kind, sentiment);

-- Grant SELECT to the readonly role used by Data Boy.
GRANT SELECT ON episodes TO jameworld_readonly;
