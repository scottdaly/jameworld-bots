'use strict';
/**
 * The job queue that lets a feature job outlive a bot deploy.
 *
 * Until now a job ran as a child process of the Discord bot, inside the bot's
 * container. `docker compose up -d` recreates that container, so every deploy
 * raced the drain timer, and a job that ran longer than the grace period was
 * SIGKILLed halfway through. When jobs took five minutes the 900s drain
 * covered it. They now take fifty.
 *
 * So the work moves out. The gateway (data-boy.js) owns the Discord
 * connection and does everything short: it enqueues a feature request and
 * goes back to listening. A separate worker container claims the job and runs
 * it. Restarting the gateway -- which is what almost every deploy actually
 * changes -- no longer touches anything that is running.
 *
 * Postgres is the queue because it is already here, already backed up, and
 * already the thing recovery reads. There is no second source of truth: a job
 * is a row in data_boy_logs, the same row the answer eventually lands in.
 *
 * The worker cannot talk to Discord -- only the gateway holds the connection --
 * so anything it wants said goes through two channels:
 *
 *   - `job_state`, overwritten in place, carries live progress (what the agent
 *     is doing, which turn, the step it is on). The gateway reads it on a
 *     timer and edits the placeholder. Overwriting rather than appending is
 *     the point: a tool fires every few seconds and none of it is worth
 *     keeping.
 *   - `data_boy_outbox`, appended to, carries the things that must actually be
 *     posted: an increment landing, the final answer. These are rare and each
 *     one matters, so they queue rather than overwrite.
 *
 * Nothing here assumes a single worker. Claims are atomic and leased, so a
 * second worker is a config change rather than a rewrite -- and a worker that
 * dies mid-job has its lease expire and the job returned to the queue.
 */

const os = require('os');

const WORKER_ID = `${os.hostname()}:${process.pid}`;

// How long a claim is good for without a heartbeat. Long enough that a slow
// database or a busy event loop cannot make a healthy worker look dead; short
// enough that a killed one is noticed within a couple of minutes.
const LEASE_MS = Number(process.env.TOASTER_LEASE_MS || 120_000);
const HEARTBEAT_MS = Math.max(10_000, Math.floor(LEASE_MS / 4));

// A job that has been handed out this many times without finishing is not
// unlucky, it is poison. Stop feeding it to workers and let somebody look.
const MAX_ATTEMPTS = Number(process.env.TOASTER_MAX_ATTEMPTS || 3);

async function ensureSchema(pool) {
  // Columns rather than a new table: the job and its eventual answer are the
  // same thing, and splitting them would mean keeping two rows in step.
  const cols = [
    ['job_status', 'TEXT'],        // null | queued | running | done
    ['job_worker', 'TEXT'],
    ['job_lease', 'TIMESTAMPTZ'],
    ['job_attempts', 'INT DEFAULT 0'],
    ['job_payload', 'JSONB'],      // what the worker needs that the row lacks
    ['job_state', 'JSONB'],        // plan, shipped, and live progress
  ];
  for (const [name, type] of cols) {
    await pool.query(`ALTER TABLE data_boy_logs ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
  // Claiming scans for queued rows on every poll; without this it is a table
  // scan over every question the bot has ever been asked.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS data_boy_logs_job_status_idx
       ON data_boy_logs (job_status, id) WHERE job_status IS NOT NULL`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS data_boy_outbox (
       id          BIGSERIAL PRIMARY KEY,
       log_id      BIGINT,
       channel_id  TEXT NOT NULL,
       reply_to    TEXT,
       kind        TEXT NOT NULL,        -- increment | final | note
       text        TEXT,
       file_path   TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       posted_at   TIMESTAMPTZ
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS data_boy_outbox_pending_idx
       ON data_boy_outbox (id) WHERE posted_at IS NULL`
  );
}

/** Gateway side: hand a feature request over and go back to listening. */
async function enqueue(pool, logId, payload) {
  await pool.query(
    `UPDATE data_boy_logs
        SET job_status = 'queued', job_payload = $2, job_attempts = 0
      WHERE id = $1`,
    [logId, JSON.stringify(payload || {})]
  );
}

/**
 * Worker side: take the oldest job nobody is working on.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe with more than one worker --
 * two claims racing pick different rows instead of both winning the same one.
 * An expired lease is treated as available, which is how a killed worker's job
 * gets picked back up rather than sitting queued forever.
 */
async function claimNext(pool) {
  const { rows } = await pool.query(
    `UPDATE data_boy_logs
        SET job_status = 'running',
            job_worker = $1,
            job_lease  = NOW() + ($2 || ' milliseconds')::interval,
            job_attempts = job_attempts + 1
      WHERE id = (
        SELECT id FROM data_boy_logs
         WHERE (job_status = 'queued'
                OR (job_status = 'running' AND job_lease < NOW()))
           AND COALESCE(job_attempts, 0) < $3
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, discord_message_id, discord_channel_id, discord_user,
                question, job_payload, job_state, job_attempts`,
    [WORKER_ID, String(LEASE_MS), MAX_ATTEMPTS]
  );
  return rows[0] || null;
}

/**
 * Still alive, and here is what I am doing. Extends the lease and overwrites
 * the live progress in one statement, because they are the same fact.
 * job_state is merged rather than replaced so a heartbeat carrying only an
 * activity string cannot wipe the plan.
 */
async function heartbeat(pool, logId, patch) {
  await pool.query(
    `UPDATE data_boy_logs
        SET job_lease = NOW() + ($2 || ' milliseconds')::interval,
            job_state = COALESCE(job_state, '{}'::jsonb) || $3::jsonb
      WHERE id = $1`,
    [logId, String(LEASE_MS), JSON.stringify(patch || {})]
  );
}

/** Worker side: done, one way or the other. Releases the lease. */
async function complete(pool, logId) {
  await pool.query(
    `UPDATE data_boy_logs
        SET job_status = 'done', job_worker = NULL, job_lease = NULL
      WHERE id = $1`,
    [logId]
  );
}

/**
 * A job that burned through its attempts is stuck in a loop that will not fix
 * itself. Take it out of circulation and hand back enough to tell the asker.
 */
async function reapExhausted(pool) {
  const { rows } = await pool.query(
    `UPDATE data_boy_logs
        SET job_status = 'done', job_worker = NULL, job_lease = NULL
      WHERE job_status IN ('queued', 'running')
        AND COALESCE(job_attempts, 0) >= $1
        AND (job_lease IS NULL OR job_lease < NOW())
      RETURNING id, discord_channel_id, discord_message_id, question`,
    [MAX_ATTEMPTS]
  );
  return rows;
}

/** Anything the worker needs actually posted rather than merely displayed. */
async function pushOutbox(pool, entry) {
  await pool.query(
    `INSERT INTO data_boy_outbox (log_id, channel_id, reply_to, kind, text, file_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.logId || null, entry.channelId, entry.replyTo || null,
     entry.kind || 'note', entry.text || null, entry.filePath || null]
  );
}

/**
 * Gateway side: post what the worker could not.
 *
 * Rows are claimed by stamping posted_at before the handler runs, so a
 * gateway restart mid-post cannot repost the same message -- a duplicate
 * answer in the channel is worse than a missing one, and the worker's row
 * still holds the text if anyone needs it back.
 */
async function drainOutbox(pool, handler, limit = 5) {
  const { rows } = await pool.query(
    `UPDATE data_boy_outbox
        SET posted_at = NOW()
      WHERE id IN (
        SELECT id FROM data_boy_outbox
         WHERE posted_at IS NULL
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id, log_id, channel_id, reply_to, kind, text, file_path`,
    [limit]
  );
  for (const r of rows) {
    try {
      await handler(r);
    } catch (err) {
      console.error(`outbox ${r.id} (${r.kind}) failed to post: ${err.message}`);
    }
  }
  return rows.length;
}

/** Rows a gateway should be showing live progress for. */
async function liveRows(pool) {
  const { rows } = await pool.query(
    `SELECT id, discord_channel_id, discord_message_id, discord_user, question,
            job_state, job_payload, job_status
       FROM data_boy_logs
      WHERE job_status = 'running'
      ORDER BY id`
  );
  return rows;
}

module.exports = {
  WORKER_ID, LEASE_MS, HEARTBEAT_MS, MAX_ATTEMPTS,
  ensureSchema, enqueue, claimNext, heartbeat, complete,
  reapExhausted, pushOutbox, drainOutbox, liveRows,
};
