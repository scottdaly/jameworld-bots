// Salvage corrupt msg_ids in a scan.js output JSON.
//
// The model can produce two flavors of bad msg_ids:
//   (a) Truncated — 10-digit prefix instead of 19-digit snowflake.
//   (b) Partially hallucinated — 19 digits but middle/suffix invented;
//       only the leading ~10 digits are real.
//
// Strategy: collect every msg_id, query the DB, find missing ones, and
// resolve them by 10-char prefix match. Rewrite the JSON in place.
//
// Usage: node salvage_ids.js <results.json>

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const { Pool } = require("pg");

const FIELDS = ["start_msg_id", "end_msg_id", "peak_msg_id"];

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node salvage_ids.js <results.json>");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  const allIds = new Set();
  for (const ep of data.episodes) {
    for (const f of FIELDS) {
      if (typeof ep[f] === "string" && ep[f]) allIds.add(ep[f]);
    }
  }
  console.log(`Found ${allIds.size} distinct msg_ids in JSON.`);

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  const { rows: existing } = await pool.query(
    "SELECT message_id FROM messages WHERE message_id = ANY($1)",
    [[...allIds]]
  );
  const valid = new Set(existing.map((r) => r.message_id));
  console.log(`Of those, ${valid.size} exist in DB; ${allIds.size - valid.size} are corrupt.`);

  const corrupt = [...allIds].filter((id) => !valid.has(id));

  // Resolve each corrupt ID:
  //   - try its own value (sometimes truncated <19 chars still has unique prefix match)
  //   - try first 10 chars
  //   - try first 8 chars
  async function resolve(prefix) {
    const tries = new Set([prefix, prefix.slice(0, 10), prefix.slice(0, 8)].filter(Boolean));
    for (const p of tries) {
      const { rows } = await pool.query(
        "SELECT message_id FROM messages WHERE message_id LIKE $1 LIMIT 2",
        [p + "%"]
      );
      if (rows.length === 1) return { id: rows[0].message_id, via: p };
    }
    // Loose fallback — see if any prefix length yields a unique hit
    const { rows } = await pool.query(
      "SELECT message_id FROM messages WHERE message_id LIKE $1 LIMIT 2",
      [prefix.slice(0, 10) + "%"]
    );
    if (rows.length > 1) return { ambiguous: true };
    return { unmatched: true };
  }

  const map = new Map();
  const ambiguous = [];
  const unmatched = [];
  for (const id of corrupt) {
    const r = await resolve(id);
    if (r.ambiguous) ambiguous.push(id);
    else if (r.unmatched) unmatched.push(id);
    else map.set(id, r.id);
  }

  console.log(`Resolved: ${map.size}, ambiguous: ${ambiguous.length}, unmatched: ${unmatched.length}`);
  if (ambiguous.length) console.log("Ambiguous:", ambiguous);
  if (unmatched.length) console.log("Unmatched:", unmatched);

  let rewrites = 0;
  for (const ep of data.episodes) {
    for (const f of FIELDS) {
      if (typeof ep[f] === "string" && map.has(ep[f])) {
        ep[f] = map.get(ep[f]);
        rewrites++;
      }
    }
  }

  // Drop episodes whose start_msg_id or end_msg_id is still unresolved —
  // we can't time-anchor them. Keep ones where only peak_msg_id is bad
  // (we just null it out).
  const unresolvedSet = new Set([...ambiguous, ...unmatched]);
  const before = data.episodes.length;
  const dropped = [];
  data.episodes = data.episodes.filter((ep) => {
    if (unresolvedSet.has(ep.start_msg_id) || unresolvedSet.has(ep.end_msg_id)) {
      dropped.push({ topic: ep.topic, kind: ep.kind, chunk_index: ep.chunk_index });
      return false;
    }
    if (unresolvedSet.has(ep.peak_msg_id)) {
      ep.peak_msg_id = null;
    }
    return true;
  });
  if (dropped.length) {
    console.log(`Dropped ${dropped.length}/${before} episodes with unresolved start/end ids:`);
    for (const d of dropped) console.log(`  - chunk ${d.chunk_index}: ${d.kind} / ${d.topic}`);
  }

  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Rewrote ${rewrites} fields in ${file}. Final episode count: ${data.episodes.length}.`);

  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
