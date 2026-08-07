// Full backfill driver: iterate (channel × month), run scan → reconcile → load.
//
// Resumable: each (channel, month) writes a flag file when complete, and is
// skipped on subsequent runs. The intermediate JSONs (results-*.json,
// reconciled-*.json) are also checkpoints — if scan completed but reconcile
// didn't, we resume from reconcile.
//
// Usage:
//   node backfill.js                    # full run (all channels >= MIN_MSGS)
//   node backfill.js --channel <id>     # limit to one channel
//   node backfill.js --dry              # print plan, don't run
//
// Tunables: MIN_MSGS_PER_CHANNEL, MIN_MSGS_PER_MONTH.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Pool } = require("pg");

const MIN_MSGS_PER_CHANNEL = 50;
const MIN_MSGS_PER_MONTH = 10;
const DIR = __dirname;

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { dry: false, channel: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry") out.dry = true;
    else if (argv[i] === "--channel") out.channel = argv[++i];
  }
  return out;
}

function* monthsInRange(startDate, endDate) {
  const cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const stop = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 1));
  while (cur < stop) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const ym = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`;
    yield {
      ym,
      startISO: cur.toISOString().slice(0, 10),
      endISO: next.toISOString().slice(0, 10),
    };
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(DIR, script), ...args], {
      cwd: DIR,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const args = parseArgs();
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  let chSql = `
    SELECT channel_id, count(*)::int AS msgs, min(timestamp) AS first, max(timestamp) AS last
    FROM messages
    GROUP BY channel_id
    HAVING count(*) >= $1
    ORDER BY count(*) DESC
  `;
  const chParams = [MIN_MSGS_PER_CHANNEL];
  if (args.channel) {
    chSql = chSql.replace("HAVING", "AND channel_id = $2 HAVING").replace("GROUP BY", "GROUP BY");
    // simpler: query then filter
  }
  const { rows: channels } = await pool.query(chSql, chParams);
  const filtered = args.channel ? channels.filter((c) => c.channel_id === args.channel) : channels;

  console.log(`${filtered.length} channels selected (min ${MIN_MSGS_PER_CHANNEL} msgs).`);

  const units = [];
  for (const ch of filtered) {
    for (const m of monthsInRange(new Date(ch.first), new Date(ch.last))) {
      units.push({ channel: ch.channel_id, ...m });
    }
  }
  console.log(`Total (channel × month) units: ${units.length}`);

  if (args.dry) {
    for (const u of units) console.log(`  ${u.channel}  ${u.ym}`);
    await pool.end();
    return;
  }

  let completed = 0;
  let skipped = 0;
  const startTime = Date.now();

  for (const u of units) {
    const tag = `${u.channel}-${u.ym}`;
    const resultsFile = path.join(DIR, `results-${tag}.json`);
    const reconciledFile = path.join(DIR, `reconciled-${tag}.json`);
    const doneFlag = path.join(DIR, `done-${tag}.flag`);

    if (fs.existsSync(doneFlag)) {
      skipped++;
      continue;
    }

    const idx = completed + skipped + 1;
    const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`\n[${idx}/${units.length}] ${tag}  (elapsed ${elapsedMin}m, done=${completed}, skipped=${skipped})`);

    // Probe message count for this slice — skip if too sparse to be worth a scan.
    const { rows: cnt } = await pool.query(
      "SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND timestamp >= $2 AND timestamp < $3",
      [u.channel, u.startISO, u.endISO]
    );
    if (cnt[0].n < MIN_MSGS_PER_MONTH) {
      console.log(`  skip: only ${cnt[0].n} msgs in window`);
      fs.writeFileSync(doneFlag, `skipped: ${cnt[0].n} msgs\n`);
      skipped++;
      continue;
    }
    console.log(`  ${cnt[0].n} messages → scan/reconcile/load`);

    try {
      if (!fs.existsSync(resultsFile)) {
        await runNode("scan.js", [
          "--channel", u.channel,
          "--start", u.startISO,
          "--end", u.endISO,
          "--out", resultsFile,
        ]);
      } else {
        console.log(`  results exists — skipping scan`);
      }
      if (!fs.existsSync(reconciledFile)) {
        await runNode("reconcile.js", [resultsFile, reconciledFile]);
      } else {
        console.log(`  reconciled exists — skipping reconcile`);
      }
      await runNode("load.js", [reconciledFile, "--channel", u.channel]);
      fs.writeFileSync(doneFlag, `loaded at ${new Date().toISOString()}\n`);
      completed++;
    } catch (err) {
      console.error(`  ERROR on ${tag}: ${err.message}`);
      console.error(`  (continuing to next unit; rerun backfill to retry)`);
    }
  }

  const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\nDone. completed=${completed}, skipped=${skipped}, total time=${totalMin}m`);

  const { rows: stats } = await pool.query("SELECT count(*)::int AS n FROM episodes");
  console.log(`Total episodes now in DB: ${stats[0].n}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
