// Run me:
//
//   mkdir -p /tmp/qt && cd /tmp/qt && npm init -y && npm i embedded-postgres pg
//   cd <repo> && NODE_PATH=/tmp/qt/node_modules node tests/queue-test.js
//
// NODE_PATH, not a cd: node resolves `require("embedded-postgres")` from this
// file's directory upward, never from the working directory.
//
// embedded-postgres downloads a real Postgres and runs it as the current user,
// so this needs no root and no running database. It is deliberately not a
// dependency of the bot -- nothing here ships in the image, which is why the
// packages live outside the repo.
//
// Concurrency tests for job-queue.js against a real Postgres.
//
// Everything here was previously unverified: the SQL parsed, and that was all
// anyone knew. These exercise the parts that only misbehave under contention --
// two workers racing for one job, a lease expiring under a worker still
// running, an outbox handler that throws.
process.env.TOASTER_LEASE_MS = "1500";
process.env.TOASTER_UNCLAIMED_MS = "1000";
process.env.TOASTER_MAX_ATTEMPTS = "3";

const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
const { Pool } = require("pg");
const os = require("os");
const path = require("path");
const fs = require("fs");
const jobs = require("../job-queue.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

const BASE_TABLE = `
CREATE TABLE IF NOT EXISTS data_boy_logs (
  id BIGSERIAL PRIMARY KEY,
  discord_message_id TEXT UNIQUE,
  discord_channel_id TEXT,
  discord_user TEXT,
  question TEXT,
  answer TEXT,
  turns INT,
  input_tokens INT,
  output_tokens INT,
  error TEXT,
  duration_ms INT,
  status TEXT,
  asked_at TIMESTAMPTZ DEFAULT NOW()
)`;

let n = 0;
async function newJob(pool, opts = {}) {
  n++;
  const { rows } = await pool.query(
    `INSERT INTO data_boy_logs (discord_message_id, discord_channel_id, discord_user, question, asked_at)
     VALUES ($1,$2,$3,$4, NOW() - ($5 || ' milliseconds')::interval) RETURNING id`,
    [`m${n}`, `c${n}`, opts.user || "scott", `q${n}`, String(opts.ageMs || 0)]
  );
  const id = rows[0].id;
  await jobs.enqueue(pool, id, { request: `q${n}` });
  return id;
}

(async () => {
  // initdb refuses a non-empty directory, and an interrupted run leaves one
  // behind -- so clear it first rather than making the test single-use.
  const dataDir = path.join(os.tmpdir(), "toaster-queue-test-pg");
  fs.rmSync(dataDir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: "t", password: "t", port: 55433, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("t");

  // Whatever happens below, stop the server. An earlier version left a
  // postgres.exe running on every failure, which locked the data directory
  // and made the *next* run fail on initdb -- a test that breaks itself.
  // Declared out here so the finally below can still close them.
  let pool, poolB;
  try {

    const cfg = { host: "localhost", port: 55433, user: "t", password: "t", database: "t" };
    pool = new Pool(cfg);
    poolB = new Pool(cfg);          // a genuinely separate connection pool

    await pool.query(BASE_TABLE);

    // -- 1. schema bootstrap, including two containers racing it ---------------
    const both = await Promise.allSettled([jobs.ensureSchema(pool), jobs.ensureSchema(poolB)]);
    check("concurrent ensureSchema does not throw",
      both.every((r) => r.status === "fulfilled"),
      both.filter(r => r.status === "rejected").map(r => r.reason.message).join("; "));
    await jobs.ensureSchema(pool);   // and is idempotent on a second run
    check("ensureSchema is idempotent", true);

    // -- 2. a claim is exclusive while its lease holds -------------------------
    const a = await newJob(pool);
    const c1 = await jobs.claimNext(pool);
    check("a queued job is claimed", c1 && String(c1.id) === String(a));
    check("claiming stamps attempt 1", c1 && c1.job_attempts === 1);
    const c2 = await jobs.claimNext(pool);
    check("a running job with a live lease is not re-claimed", c2 === null);

    // -- 3. two workers racing for the same single job ------------------------
    await pool.query("UPDATE data_boy_logs SET job_status='done' WHERE id=$1", [a]);
    const solo = await newJob(pool);
    const [r1, r2] = await Promise.all([jobs.claimNext(pool), jobs.claimNext(poolB)]);
    const winners = [r1, r2].filter(Boolean);
    check("two racing claims yield exactly one winner", winners.length === 1,
      `got ${winners.length}`);

    // -- 4. two workers, two jobs: both work, no duplication ------------------
    await pool.query("UPDATE data_boy_logs SET job_status='done' WHERE id=$1", [solo]);
    const j1 = await newJob(pool), j2 = await newJob(pool);
    const [x, y] = await Promise.all([jobs.claimNext(pool), jobs.claimNext(poolB)]);
    check("two racing claims take different jobs",
      x && y && String(x.id) !== String(y.id), `${x && x.id} vs ${y && y.id}`);
    const ids = [String(x.id), String(y.id)].sort();
    check("and they are the two queued jobs",
      ids.join() === [String(j1), String(j2)].sort().join());

    // -- 5. an expired lease is reclaimed, and fences the old holder ----------
    await pool.query("UPDATE data_boy_logs SET job_status='done' WHERE id IN ($1,$2)", [j1, j2]);
    const z = await newJob(pool);
    const first = await jobs.claimNext(pool);
    const oldFence = { worker: jobs.WORKER_ID, attempt: first.job_attempts };
    check("heartbeat works while the claim is current",
      (await jobs.heartbeat(pool, z, { activity: "editing main.c" }, oldFence)) === true);

    await pool.query("UPDATE data_boy_logs SET job_lease = NOW() - INTERVAL '1 second' WHERE id=$1", [z]);
    const second = await jobs.claimNext(pool);
    check("an expired lease is reclaimed", second && String(second.id) === String(z));
    check("the reclaim increments the attempt", second.job_attempts === first.job_attempts + 1);

    const newFence = { worker: jobs.WORKER_ID, attempt: second.job_attempts };
    check("the OLD holder's heartbeat is refused",
      (await jobs.heartbeat(pool, z, { activity: "stale" }, oldFence)) === false);
    check("the new holder's heartbeat is accepted",
      (await jobs.heartbeat(pool, z, { activity: "fresh" }, newFence)) === true);
    const st = (await pool.query("SELECT job_state FROM data_boy_logs WHERE id=$1", [z])).rows[0].job_state;
    check("the stale worker did not overwrite live state", st.activity === "fresh",
      JSON.stringify(st));
    check("the old holder cannot complete the new holder's job",
      (await jobs.complete(pool, z, oldFence)) === false);

    // -- 6. finishing is atomic and fenced ------------------------------------
    const bad = await jobs.finishJob(pool, z, oldFence,
      { answer: "stale answer", status: "success" },
      { channelId: "c", replyTo: "r", kind: "final", text: "stale" });
    check("a fenced finishJob refuses", bad === false);
    const afterBad = (await pool.query(
      "SELECT answer, (SELECT count(*)::int FROM data_boy_outbox) AS ob FROM data_boy_logs WHERE id=$1", [z])).rows[0];
    check("and writes nothing at all", afterBad.answer === null && afterBad.ob === 0,
      JSON.stringify(afterBad));

    const good = await jobs.finishJob(pool, z, newFence,
      { answer: "real answer", status: "success", turns: 7 },
      { channelId: "c9", replyTo: "r9", kind: "final", text: "done" });
    check("the owner's finishJob succeeds", good === true);
    const afterGood = (await pool.query(
      `SELECT answer, status, turns, job_status, job_worker,
              (SELECT count(*)::int FROM data_boy_outbox) AS ob
         FROM data_boy_logs WHERE id=$1`, [z])).rows[0];
    check("answer, completion and reply land together",
      afterGood.answer === "real answer" && afterGood.job_status === "done" &&
      afterGood.job_worker === null && afterGood.turns === 7 && afterGood.ob === 1,
      JSON.stringify(afterGood));

    // -- 7. the outbox only marks what it actually posted ---------------------
    await pool.query("DELETE FROM data_boy_outbox");
    for (const k of ["increment", "increment", "final"]) {
      await jobs.pushOutbox(pool, { logId: z, channelId: "c", replyTo: "r", kind: k, text: k });
    }
    const seen = [];
    await jobs.drainOutbox(pool, async (r) => { seen.push(r.kind); });
    check("the outbox posts in insertion order",
      seen.join(",") === "increment,increment,final", seen.join(","));
    const pending = (await pool.query(
      "SELECT count(*)::int AS n FROM data_boy_outbox WHERE posted_at IS NULL")).rows[0].n;
    check("posted rows are marked posted", pending === 0);

    // a handler that throws must not lose the message
    await pool.query("DELETE FROM data_boy_outbox");
    await jobs.pushOutbox(pool, { logId: z, channelId: "c", kind: "final", text: "boom" });
    await jobs.pushOutbox(pool, { logId: z, channelId: "c", kind: "note", text: "after" });
    let tries = 0;
    await jobs.drainOutbox(pool, async () => { tries++; throw new Error("discord is down"); });
    const row = (await pool.query(
      "SELECT posted_at, attempts FROM data_boy_outbox ORDER BY id LIMIT 1")).rows[0];
    check("a failed post is not marked posted", row.posted_at === null);
    check("and its attempt is counted", row.attempts === 1);
    check("a later row for the SAME job is not reordered ahead of the failure",
      tries === 1, `tries=${tries}`);

    // it comes back once the claim ages out, and eventually gives up
    await pool.query("UPDATE data_boy_outbox SET claimed_at = NOW() - INTERVAL '3 minutes'");
    let redelivered = 0;
    await jobs.drainOutbox(pool, async () => { redelivered++; throw new Error("still down"); });
    check("an aged-out claim is retried", redelivered === 1);

    await pool.query("UPDATE data_boy_outbox SET attempts = 5, claimed_at = NOW() - INTERVAL '3 minutes'");
    let afterGiveUp = 0;
    await jobs.drainOutbox(pool, async () => { afterGiveUp++; });
    check("a message is not retried forever", afterGiveUp === 0);

    // one job's persistently failing row must not starve every OTHER job's
    // rows of ever being attempted at all -- the original bug: the whole
    // batch broke on the first failure, so unrelated jobs' rows sat claimed
    // (their attempts already incremented) but never once actually posted,
    // marching toward the attempt limit having never really been tried.
    await pool.query("DELETE FROM data_boy_outbox");
    await jobs.pushOutbox(pool, { logId: 9001, channelId: "c", kind: "final", text: "job A, will fail" });
    await jobs.pushOutbox(pool, { logId: 9002, channelId: "c", kind: "final", text: "job B, should still run" });
    await jobs.pushOutbox(pool, { logId: 9003, channelId: "c", kind: "final", text: "job C, should still run" });
    const attemptedFor = [];
    const posted = await jobs.drainOutbox(pool, async (r) => {
      attemptedFor.push(r.log_id);
      if (String(r.log_id) === "9001") throw new Error("job A is stuck");
    });
    check("job A's failure did not stop job B and C from being attempted",
      attemptedFor.map(String).includes("9002") && attemptedFor.map(String).includes("9003"),
      JSON.stringify(attemptedFor));
    check("the two unrelated jobs' rows actually posted despite job A failing",
      posted === 2, `posted=${posted}`);
    const remaining = (await pool.query(
      "SELECT log_id, posted_at IS NOT NULL AS posted FROM data_boy_outbox ORDER BY log_id"
    )).rows;
    check("only job A's row is left unposted; B and C are done",
      remaining.length === 3 &&
      String(remaining[0].log_id) === "9001" && remaining[0].posted === false &&
      remaining.slice(1).every((r) => r.posted === true),
      JSON.stringify(remaining));

    // -- 8. jobs nothing can finish get a dead letter -------------------------
    await pool.query("UPDATE data_boy_logs SET job_status = NULL");
    const never = await newJob(pool, { ageMs: 60_000 });   // queued, older than UNCLAIMED_MS
    const reaped = await jobs.reapExhausted(pool);
    check("a job nobody ever claimed is dead-lettered",
      reaped.some((r) => String(r.id) === String(never)), JSON.stringify(reaped.map(r => r.id)));
    check("and is reported as never having run",
      reaped.find((r) => String(r.id) === String(never)).attempts === 0);

    const fresh = await newJob(pool);                      // queued just now
    const reaped2 = await jobs.reapExhausted(pool);
    check("a freshly queued job is left alone",
      !reaped2.some((r) => String(r.id) === String(fresh)));

    // a job that burned its attempts is not handed out again
    await pool.query(
      "UPDATE data_boy_logs SET job_status='queued', job_attempts=3, job_lease=NULL WHERE id=$1", [fresh]);
    const nope = await jobs.claimNext(pool);
    check("a job at the attempt limit is not claimed",
      !nope || String(nope.id) !== String(fresh));

      console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (poolB) await poolB.end().catch(() => {});
    await pg.stop().catch(() => {});
  }
  // exitCode, not exit(): process.exit() here killed node while postgres was
  // still shutting down, leaking a server per run that then held the data
  // directory against the next one. Let the loop drain instead.
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  // Print the whole thing: embedded-postgres can reject with a bare undefined,
  // and "HARNESS ERROR: undefined" says nothing about what went wrong.
  console.error("HARNESS ERROR:", (e && e.stack) || e || "(rejected with no value)");
  process.exit(1);
});
