// Load a reconciled-*.json output into the `episodes` table.
//
// For each episode:
//   - Look up start_ts, end_ts from start_msg_id / end_msg_id.
//   - Count messages in [start_ts, end_ts] for the channel → message_count.
//   - INSERT row.
//
// Usage:
//   node load.js reconciled-2026-01.json --channel 1147252653986943119
//
// The channel id must be passed because the reconciled JSON doesn't carry it.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const { Pool } = require("pg");

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    console.error("Usage: node load.js <reconciled.json> --channel <id>");
    process.exit(1);
  }
  const file = argv[0];
  let channel = "1147252653986943119";
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--channel") channel = argv[++i];
  }
  return { file, channel };
}

(async () => {
  const args = parseArgs();
  const data = JSON.parse(fs.readFileSync(args.file, "utf8"));
  console.log(`Loading ${data.episodes.length} episodes from ${args.file} (channel=${args.channel}).`);

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  // Hydrate timestamps for every msg_id mentioned.
  const ids = new Set();
  for (const ep of data.episodes) {
    for (const f of ["start_msg_id", "end_msg_id", "peak_msg_id"]) {
      if (ep[f]) ids.add(ep[f]);
    }
  }
  const { rows } = await pool.query(
    "SELECT message_id, timestamp FROM messages WHERE message_id = ANY($1)",
    [[...ids]]
  );
  const ts = new Map(rows.map((r) => [r.message_id, r.timestamp]));

  const generatorVersion = data.reconciler_version || "unknown";
  const sourceTag = require("path").basename(args.file);
  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query("BEGIN");
    // Idempotent: wipe any prior rows from this source before inserting.
    const { rowCount: deleted } = await client.query(
      "DELETE FROM episodes WHERE source = $1",
      [sourceTag]
    );
    if (deleted) console.log(`  cleared ${deleted} prior rows from source=${sourceTag}`);
    for (const ep of data.episodes) {
      const startTs = ts.get(ep.start_msg_id);
      const endTs = ts.get(ep.end_msg_id);
      if (!startTs || !endTs) {
        console.warn(`  skip: ep with bad start/end msg_id ${ep.start_msg_id} → ${ep.end_msg_id} (${ep.topic})`);
        skipped++;
        continue;
      }
      const { rows: cnt } = await client.query(
        "SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND timestamp >= $2 AND timestamp <= $3",
        [args.channel, startTs, endTs]
      );
      const messageCount = cnt[0].n;

      await client.query(
        `INSERT INTO episodes (
          channel_id, start_ts, end_ts, start_msg_id, end_msg_id, peak_msg_id,
          message_count, participants, kind, sentiment, intensity,
          topic, summary, representative_quote, arc, generator_version, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          args.channel,
          startTs,
          endTs,
          ep.start_msg_id,
          ep.end_msg_id,
          ep.peak_msg_id || null,
          messageCount,
          ep.participants || [],
          ep.kind,
          ep.sentiment,
          ep.intensity,
          ep.topic || null,
          ep.summary,
          ep.representative_quote || null,
          ep.arc || null,
          generatorVersion,
          sourceTag,
        ]
      );
      inserted++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`Inserted ${inserted} rows. Skipped ${skipped}.`);

  const { rows: totals } = await pool.query("SELECT count(*)::int AS n FROM episodes");
  console.log(`Total rows now in episodes: ${totals[0].n}`);

  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
