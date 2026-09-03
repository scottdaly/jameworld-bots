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

// How long a job may sit queued with nobody claiming it before we admit there
// is no worker and say so.
const UNCLAIMED_MS = Number(process.env.TOASTER_UNCLAIMED_MS || 15 * 60 * 1000);

// Any constant; it only has to be the same in both containers.
const SCHEMA_LOCK = 8577301;

async function ensureSchema(pool) {
  // Gateway and worker boot together and both run this. `IF NOT EXISTS` is not
  // actually race-proof in Postgres -- concurrent CREATE can still raise a
  // duplicate-object error, which would put one container into a restart loop
  // on the very first deploy. One at a time.
  await pool.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
  try {
    await ensureSchemaLocked(pool);
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
  }
}

async function ensureSchemaLocked(pool) {
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
       claimed_at  TIMESTAMPTZ,          -- leased, so a crash releases it
       attempts    INT DEFAULT 0,
       posted_at   TIMESTAMPTZ
     )`
  );
  // Existing deployments predate these two, and the CREATE TABLE above will
  // not add them to a table that already exists.
  await pool.query("ALTER TABLE data_boy_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE data_boy_outbox ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0");
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
async function heartbeat(pool, logId, patch, fence) {
  // The fence is what stops a worker whose lease quietly expired from
  // stamping on the worker that took over: every write after the claim has to
  // prove it still owns the row. `job_attempts` is the token -- a re-claim
  // increments it, so the old worker's predicate stops matching.
  const r = await pool.query(
    `UPDATE data_boy_logs
        SET job_lease = NOW() + ($2 || ' milliseconds')::interval,
            job_state = COALESCE(job_state, '{}'::jsonb) || $3::jsonb
      WHERE id = $1 AND job_worker = $4 AND job_attempts = $5`,
    [logId, String(LEASE_MS), JSON.stringify(patch || {}), fence.worker, fence.attempt]
  );
  return r.rowCount > 0;      // false: somebody else owns this job now
}

/** Worker side: done, one way or the other. Releases the lease. */
async function complete(pool, logId, fence) {
  const r = await pool.query(
    `UPDATE data_boy_logs
        SET job_status = 'done', job_worker = NULL, job_lease = NULL
      WHERE id = $1 AND job_worker = $2 AND job_attempts = $3`,
    [logId, fence.worker, fence.attempt]
  );
  return r.rowCount > 0;
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
        AND (job_lease IS NULL OR job_lease < NOW())
        AND (
          COALESCE(job_attempts, 0) >= $1
          -- ...or nobody ever picked it up. Without this a job enqueued while
          -- no worker is running sits queued forever and the asker watches a
          -- placeholder that never changes.
          OR (COALESCE(job_attempts, 0) = 0 AND asked_at < NOW() - ($2 || ' milliseconds')::interval)
        )
      RETURNING id, discord_channel_id, discord_message_id, question,
                COALESCE(job_attempts, 0) AS attempts`,
    [MAX_ATTEMPTS, String(UNCLAIMED_MS)]
  );
  return rows;
}

/* Posted rows are history, not state. Keep a week for debugging. */
async function pruneOutbox(pool) {
  await pool.query(
    "DELETE FROM data_boy_outbox WHERE posted_at IS NOT NULL AND posted_at < NOW() - INTERVAL '7 days'"
  );
}

/**
 * Finish a job: record the answer, release the claim, and queue the reply --
 * all or nothing.
 *
 * These used to be three separate writes. A crash between the outbox insert
 * and the completion left the lease to expire and the whole job to run again,
 * posting a second answer; and because finalizeQuery swallowed its errors, a
 * job could be marked done with answer, error and status all still null.
 * One transaction, guarded by the same fence as every other write.
 *
 * Returns false if this worker no longer owns the job, in which case nothing
 * is written and the reply is not queued.
 */
async function finishJob(pool, logId, fence, result, entry) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const done = await client.query(
      `UPDATE data_boy_logs
          SET job_status = 'done', job_worker = NULL, job_lease = NULL,
              answer = $4, turns = $5, input_tokens = $6, output_tokens = $7,
              error = $8, duration_ms = $9, status = $10
        WHERE id = $1 AND job_worker = $2 AND job_attempts = $3`,
      [logId, fence.worker, fence.attempt,
       result.answer ?? null, result.turns ?? null,
       result.input_tokens ?? null, result.output_tokens ?? null,
       result.error ?? null, result.duration_ms ?? null, result.status ?? null]
    );
    if (done.rowCount === 0) {      // fenced: somebody else owns this now
      await client.query('ROLLBACK');
      return false;
    }
    if (entry) {
      await client.query(
        `INSERT INTO data_boy_outbox (log_id, channel_id, reply_to, kind, text, file_path)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [logId, entry.channelId, entry.replyTo || null,
         entry.kind || 'final', entry.text || null, entry.filePath || null]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
const OUTBOX_MAX_ATTEMPTS = 5;

async function drainOutbox(pool, handler, limit = 5) {
  // Lease, don't consume. The first version stamped posted_at on five rows
  // before attempting the first, so a crash in the first handler silently
  // dropped all five, and a transient Discord error dropped one for good --
  // considerably worse than the "lose one on a crash mid-post" it was meant
  // to be. Now a row is only marked posted once it actually posted, and an
  // uncompleted claim ages out and is retried.
  const { rows } = await pool.query(
    `UPDATE data_boy_outbox
        SET claimed_at = NOW(), attempts = COALESCE(attempts, 0) + 1
      WHERE id IN (
        SELECT id FROM data_boy_outbox
         WHERE posted_at IS NULL
           AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '2 minutes')
           AND COALESCE(attempts, 0) < $2
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id, log_id, channel_id, reply_to, kind, text, file_path,
                COALESCE(attempts, 0) AS attempts`,
    [limit, OUTBOX_MAX_ATTEMPTS]
  );
  // UPDATE ... RETURNING has no defined row order -- the ORDER BY above only
  // chooses which rows, not the order they come back in. Without this a step
  // and the final answer claimed together could post final-first.
  rows.sort((a, b) => Number(a.id) - Number(b.id));

  let posted = 0;
  for (const r of rows) {
    try {
      await handler(r);
      await pool.query("UPDATE data_boy_outbox SET posted_at = NOW() WHERE id = $1", [r.id]);
      posted++;
    } catch (err) {
      const left = OUTBOX_MAX_ATTEMPTS - r.attempts;
      console.error(
        `outbox ${r.id} (${r.kind}) failed to post: ${err.message}` +
        (left > 0 ? ` -- ${left} attempt(s) left` : " -- giving up")
      );
      // Stop the batch: the next rows are probably for the same channel, and
      // posting them now would reorder them ahead of this one.
      break;
    }
  }
  return posted;
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
  WORKER_ID, LEASE_MS, HEARTBEAT_MS, MAX_ATTEMPTS, UNCLAIMED_MS,
  ensureSchema, enqueue, claimNext, heartbeat, complete, finishJob,
  reapExhausted, pruneOutbox, pushOutbox, drainOutbox, liveRows,
};
