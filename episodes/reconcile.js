// Reconcile overlapping episode detections from scan.js output.
//
// Pipeline:
//   1. Hydrate timestamps for every episode (from message_id lookups).
//   2. Cluster episodes by time-proximity (≤6h apart) + ≥1 shared participant
//      via union-find.
//   3. For each cluster of size ≥2, ask Haiku to decide:
//        - merge into one (same event)
//        - keep separate (distinct beats, optionally arc-tagged)
//   4. Write reconciled JSON.
//
// Usage:
//   node reconcile.js results-2026-01.json reconciled-2026-01.json

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { query: sdkQuery } = require("@anthropic-ai/claude-agent-sdk");

const MODEL = "claude-haiku-4-5-20251001";
// Two episodes cluster iff their [start_ts, end_ts] timestamp ranges intersect.
// This is strict by design — distinct beats of the same arc (e.g. Tesla saga)
// have non-overlapping ranges and should stay separate.
const RECONCILER_VERSION = "trial-2026-05-15-v2";

const SYSTEM_PROMPT = `You are reconciling a small cluster of candidate "episodes" detected from overlapping windows of a private friend group's Discord chat (jameworld — 5 friends). Each input episode has a kind, sentiment, intensity, topic, summary, representative_quote, participants, and start/end timestamps.

Adjacent scanner windows often catch the same underlying event from slightly different angles — same conversation, different framings. Other times nearby episodes are genuinely distinct beats of a shared arc (e.g. "Scott buys a Tesla" on Monday → "Tesla gets delivered" on Wednesday → "Group meme: Scott as Green Goblin" on Friday — same arc, three episodes).

Decide what each input is:

- **Same event (merge):** Same conversation, same moment. Output ONE episode that takes the widest msg_id range, the highest intensity, the union of participants, and the best summary/representative_quote.
- **Distinct beat of an arc (keep separate, tag arc):** Different moment but clearly part of the same ongoing story. Output each as its own episode and add a shared "arc" string field (a short noun phrase naming the arc, e.g. "Scott's Tesla saga").
- **Unrelated (keep separate, no arc):** Just nearby in time. Output each unchanged.

Pick the better metadata when merging — don't synthesize new claims. The "kind" can change in a merge if one framing is more accurate. Use \`high_positive\` only when truly explosive.

Output STRICT JSON, no prose, no fences:

{
  "episodes": [
    {
      "start_msg_id": "...",
      "end_msg_id": "...",
      "peak_msg_id": "...",
      "kind": "...",
      "sentiment": "...",
      "intensity": 0.0,
      "topic": "...",
      "summary": "...",
      "representative_quote": "...",
      "participants": ["..."],
      "arc": "optional arc name, omit if none"
    }
  ],
  "decision": "merge|separate|arc|mixed",
  "rationale": "one short sentence"
}

If the cluster turns out to be unrelated episodes, output all of them with decision=separate.`;

function parseArgs() {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) {
    console.error("Usage: node reconcile.js <input.json> <output.json>");
    process.exit(1);
  }
  return { inFile, outFile };
}

async function hydrateTimestamps(pool, episodes) {
  const ids = new Set();
  for (const ep of episodes) {
    for (const f of ["start_msg_id", "end_msg_id", "peak_msg_id"]) {
      if (ep[f]) ids.add(ep[f]);
    }
  }
  const arr = [...ids];
  const { rows } = await pool.query(
    "SELECT message_id, timestamp FROM messages WHERE message_id = ANY($1)",
    [arr]
  );
  const ts = new Map(rows.map((r) => [r.message_id, r.timestamp]));
  for (const ep of episodes) {
    ep.start_ts = ts.get(ep.start_msg_id);
    ep.end_ts = ts.get(ep.end_msg_id);
    ep.peak_ts = ts.get(ep.peak_msg_id);
  }
  const missing = episodes.filter((e) => !e.start_ts || !e.end_ts).length;
  if (missing) console.warn(`Warning: ${missing} episodes had unresolvable timestamps.`);
}

function buildClusters(episodes) {
  // Sort by start_ts
  const items = episodes
    .map((ep, idx) => ({ idx, ep }))
    .filter((x) => x.ep.start_ts && x.ep.end_ts)
    .sort((a, b) => new Date(a.ep.start_ts) - new Date(b.ep.start_ts));

  // Union-find
  const parent = new Map(items.map((x) => [x.idx, x.idx]));
  const find = (i) => (parent.get(i) === i ? i : (parent.set(i, find(parent.get(i))), parent.get(i)));
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Sweep: cluster iff timestamp ranges intersect.
  // [aStart, aEnd] ∩ [bStart, bEnd] ≠ ∅  ⟺  aStart ≤ bEnd AND bStart ≤ aEnd
  for (let i = 0; i < items.length; i++) {
    const aStart = new Date(items[i].ep.start_ts).getTime();
    const aEnd = new Date(items[i].ep.end_ts).getTime();
    for (let j = i + 1; j < items.length; j++) {
      const bStart = new Date(items[j].ep.start_ts).getTime();
      if (bStart > aEnd) break; // sorted by start; no future episode can overlap
      const bEnd = new Date(items[j].ep.end_ts).getTime();
      if (aStart <= bEnd && bStart <= aEnd) {
        union(items[i].idx, items[j].idx);
      }
    }
  }

  // Group by root
  const groups = new Map();
  for (const x of items) {
    const r = find(x.idx);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(x.ep);
  }
  return [...groups.values()];
}

function stripInternal(ep) {
  const { start_ts, end_ts, peak_ts, chunk_index, ...keep } = ep;
  return keep;
}

async function reconcileCluster(cluster) {
  const userMsg = `Cluster of ${cluster.length} candidate episodes (time-adjacent, share participants):

${cluster
  .map((ep, i) => `Candidate ${i + 1}:\n${JSON.stringify(stripInternal(ep), null, 2)}`)
  .join("\n\n")}

Return JSON.`;

  let resultText = "";
  let lastAssistantText = "";
  let usage = null;

  for await (const msg of sdkQuery({
    prompt: userMsg,
    options: {
      model: MODEL,
      maxTurns: 1,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      stderr: () => {},
      env: {
        ...process.env,
        CLAUDE_CODE_AUTH_TOKEN:
          process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_AUTH_TOKEN,
        IS_SANDBOX: "1",
      },
    },
  })) {
    if (msg.type === "assistant" && msg.message?.content) {
      const text = msg.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) lastAssistantText = text;
    } else if (msg.type === "result") {
      resultText = msg.result || resultText;
      usage = msg.usage || null;
    }
  }

  const raw = (resultText || lastAssistantText || "").trim();
  let parsed;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  reconcile parse failed: ${err.message}`);
    console.error(`  raw (first 400): ${raw.slice(0, 400)}`);
    return { episodes: cluster.map(stripInternal), decision: "parse_error", usage };
  }

  return {
    episodes: parsed.episodes || [],
    decision: parsed.decision || "unknown",
    rationale: parsed.rationale || "",
    usage,
  };
}

(async () => {
  const args = parseArgs();
  const data = JSON.parse(fs.readFileSync(args.inFile, "utf8"));
  console.log(`Loaded ${data.episodes.length} candidate episodes from ${args.inFile}`);

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  await hydrateTimestamps(pool, data.episodes);
  console.log("Timestamps hydrated.");

  const clusters = buildClusters(data.episodes);
  const singletons = clusters.filter((c) => c.length === 1);
  const groups = clusters.filter((c) => c.length >= 2);
  const sizes = groups.map((g) => g.length).sort((a, b) => b - a);
  console.log(
    `Built ${clusters.length} clusters (${singletons.length} singletons, ${groups.length} groups). Group sizes: ${sizes.join(", ")}`
  );

  const finalEpisodes = [];
  const decisions = [];
  let totalInput = 0;
  let totalOutput = 0;

  // Pass singletons through unchanged
  for (const c of singletons) {
    finalEpisodes.push(stripInternal(c[0]));
  }

  // Reconcile each multi-episode cluster
  for (let i = 0; i < groups.length; i++) {
    const cluster = groups[i];
    const t0 = Date.now();
    const result = await reconcileCluster(cluster);
    const ms = Date.now() - t0;
    const ui = result.usage?.input_tokens || 0;
    const uo = result.usage?.output_tokens || 0;
    totalInput += ui;
    totalOutput += uo;
    console.log(
      `  group ${i + 1}/${groups.length} (size=${cluster.length}): ${result.decision} → ${result.episodes.length} episodes, ${ms}ms`
    );
    if (result.rationale) console.log(`    "${result.rationale}"`);
    for (const ep of result.episodes) finalEpisodes.push(ep);
    decisions.push({
      cluster_size: cluster.length,
      decision: result.decision,
      rationale: result.rationale,
      input_topics: cluster.map((c) => c.topic),
      output_count: result.episodes.length,
      duration_ms: ms,
    });
  }

  // Sort final episodes by start_msg_id for stable output
  finalEpisodes.sort((a, b) => (a.start_msg_id || "").localeCompare(b.start_msg_id || ""));

  const output = {
    reconciler_version: RECONCILER_VERSION,
    source: path.basename(args.inFile),
    cluster_rule: "timestamp range overlap",
    input_count: data.episodes.length,
    output_count: finalEpisodes.length,
    clusters_total: clusters.length,
    clusters_multi: groups.length,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    decisions,
    episodes: finalEpisodes,
  };

  fs.writeFileSync(args.outFile, JSON.stringify(output, null, 2));
  console.log(
    `\nWrote ${finalEpisodes.length} reconciled episodes to ${args.outFile} (from ${data.episodes.length} candidates).`
  );
  console.log(`Total reconciler tokens: in=${totalInput} out=${totalOutput}`);

  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
