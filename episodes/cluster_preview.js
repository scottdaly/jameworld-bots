// Run only the clustering step to preview how many groups the reconciler will tackle.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const { Pool } = require("pg");

(async () => {
  const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  const ids = new Set();
  for (const ep of data.episodes) {
    for (const f of ["start_msg_id", "end_msg_id", "peak_msg_id"]) if (ep[f]) ids.add(ep[f]);
  }
  const { rows } = await pool.query(
    "SELECT message_id, timestamp FROM messages WHERE message_id = ANY($1)",
    [[...ids]]
  );
  const ts = new Map(rows.map((r) => [r.message_id, r.timestamp]));
  for (const ep of data.episodes) {
    ep.start_ts = ts.get(ep.start_msg_id);
    ep.end_ts = ts.get(ep.end_msg_id);
  }

  const items = data.episodes
    .filter((e) => e.start_ts && e.end_ts)
    .sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));

  const parent = new Map(items.map((_, i) => [i, i]));
  const find = (i) => (parent.get(i) === i ? i : (parent.set(i, find(parent.get(i))), parent.get(i)));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (let i = 0; i < items.length; i++) {
    const aStart = new Date(items[i].start_ts).getTime();
    const aEnd = new Date(items[i].end_ts).getTime();
    for (let j = i + 1; j < items.length; j++) {
      const bStart = new Date(items[j].start_ts).getTime();
      if (bStart > aEnd) break;
      const bEnd = new Date(items[j].end_ts).getTime();
      if (aStart <= bEnd && bStart <= aEnd) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(items[i]);
  }

  const sizes = [...groups.values()].map((g) => g.length).sort((a, b) => b - a);
  const singletons = sizes.filter((s) => s === 1).length;
  const multi = sizes.filter((s) => s >= 2);
  console.log(`Total clusters: ${sizes.length}`);
  console.log(`Singletons: ${singletons}`);
  console.log(`Multi-episode groups: ${multi.length} — sizes: ${multi.join(", ")}`);
  console.log(`LLM calls expected: ${multi.length}`);

  await pool.end();
})();
