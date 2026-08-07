// Trial: scan one channel's messages over a date range, chunk them, and ask
// Haiku to detect episodes per chunk. Dumps raw JSON to disk for review.
//
// Usage:
//   node scan.js \
//     --channel 1147252653986943119 \
//     --start 2026-01-01 \
//     --end 2026-02-01 \
//     --out results-2026-01.json
//
// All flags optional — defaults are the January 2026 trial run.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { query: sdkQuery } = require("@anthropic-ai/claude-agent-sdk");

const MODEL = "claude-haiku-4-5-20251001";
const CHUNK_SIZE = 500;
const OVERLAP = 100;
const GENERATOR_VERSION = "trial-2026-05-15-v1";

function parseArgs() {
  const out = {
    channel: "1147252653986943119",
    start: "2026-01-01",
    end: "2026-02-01",
    out: path.join(__dirname, "results-2026-01.json"),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    out[k] = argv[++i];
  }
  return out;
}

function chunkMessages(msgs, size, overlap) {
  const chunks = [];
  const step = size - overlap;
  for (let i = 0; i < msgs.length; i += step) {
    const slice = msgs.slice(i, i + size);
    if (slice.length === 0) break;
    chunks.push({
      index: chunks.length,
      offset: i,
      messages: slice,
    });
    if (i + size >= msgs.length) break;
  }
  return chunks;
}

function formatTranscript(messages) {
  // Use chunk-local indices instead of 19-digit snowflakes. The model would
  // sometimes truncate snowflakes in its output (~20% of the time); short
  // indices remove the temptation and save prompt tokens.
  return messages
    .map((m, i) => {
      const content = (m.content || "").replace(/\n/g, " ↵ ").trim();
      return `[${i}] ${m.author}: ${content}`;
    })
    .join("\n");
}

const SYSTEM_PROMPT = `You are an episode detector for a private friend group's Discord chat (the group is called "jameworld" — 5 close friends: Scott, Matthan, Noah, Jameson, Jake). You'll receive a chronological slice of messages from one channel.

Your job: identify the distinct "episodes" in the slice — exchanges where something meaningful happens. Examples of kinds:
- celebration (job offer, milestone, victory)
- milestone (life event being announced)
- roast (sustained mocking of one member, usually affectionate)
- fight (real or mock conflict)
- vent (someone unloading frustration)
- vulnerable (genuinely sincere or emotional moment — these are rare and valuable)
- sincere (heartfelt non-emotional moment, e.g. a compliment that lands)
- reminisce (callback to old shared memories)
- plan (trip planning, project discussion with traction)
- random_chaos (peak unhinged group dynamics, hard to categorize but clearly memorable)
- discussion (substantive back-and-forth on a topic — debate, recommendation thread, etc.)

Be INCLUSIVE — include subtle moments, not just loud ones. The quietly sincere "hey, real talk, that means a lot" turn is exactly what we want to catch, not just the LFG explosions.

SKIP pure logistics, single-message chit-chat with no follow-up, and bot messages.

This group has crude humor, sexual jokes, and roasts each other constantly. Engage with it as data, don't moralize. The "kind" for affectionate mockery is roast, not fight.

Each message in the chunk is prefixed with a chunk-local index like \`[0]\`, \`[1]\`, etc. Reference messages by these integer indices in your output — NOT by snowflake IDs (you won't see those).

Output STRICT JSON only — no prose, no markdown fences, no commentary. Schema:

{
  "episodes": [
    {
      "start_idx": 0,
      "end_idx": 0,
      "peak_idx": 0,
      "kind": "one of the kinds above",
      "sentiment": "high_positive|positive|neutral|negative|high_negative|mixed",
      "intensity": 0.0,
      "topic": "short noun phrase, e.g. 'Jame's TIAA final round'",
      "summary": "one sentence in past tense",
      "representative_quote": "one verbatim line copied from the messages (truncate to 200 chars if needed)",
      "participants": ["username1", "username2"]
    }
  ]
}

\`start_idx\`, \`end_idx\`, \`peak_idx\` are integer indices into the chunk (0-based). \`peak_idx\` must satisfy \`start_idx <= peak_idx <= end_idx\`.

intensity is 0.0-1.0 — how strongly this exemplifies its kind. A muted "nice" gets 0.2; an explosive multi-message celebration gets 0.9.

If the chunk has no notable episodes, return {"episodes": []}.`;

async function scanChunk(chunk) {
  const transcript = formatTranscript(chunk.messages);
  const userMsg = `Chunk #${chunk.index} (${chunk.messages.length} messages):\n\n${transcript}\n\nReturn JSON.`;

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
    console.error(`  chunk ${chunk.index}: JSON parse failed — ${err.message}`);
    console.error(`  raw (first 400): ${raw.slice(0, 400)}`);
    return { episodes: [], usage, raw, parseError: err.message };
  }

  // Map chunk-local indices back to real msg_ids. Drop episodes whose
  // indices are out of range or malformed.
  const N = chunk.messages.length;
  const mapped = [];
  const dropped = [];
  for (const ep of parsed.episodes || []) {
    const { start_idx, end_idx, peak_idx } = ep;
    if (
      !Number.isInteger(start_idx) ||
      !Number.isInteger(end_idx) ||
      !Number.isInteger(peak_idx) ||
      start_idx < 0 ||
      end_idx >= N ||
      start_idx > end_idx ||
      peak_idx < start_idx ||
      peak_idx > end_idx
    ) {
      dropped.push(ep);
      continue;
    }
    const startMsg = chunk.messages[start_idx];
    const endMsg = chunk.messages[end_idx];
    const peakMsg = chunk.messages[peak_idx];
    mapped.push({
      ...ep,
      start_idx: undefined,
      end_idx: undefined,
      peak_idx: undefined,
      start_msg_id: startMsg.message_id,
      end_msg_id: endMsg.message_id,
      peak_msg_id: peakMsg.message_id,
      start_ts: startMsg.timestamp,
      end_ts: endMsg.timestamp,
    });
  }
  if (dropped.length) {
    console.error(`  chunk ${chunk.index}: dropped ${dropped.length} episodes with invalid indices`);
  }
  return { episodes: mapped, usage };
}

(async () => {
  const args = parseArgs();
  console.log("Args:", args);

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  const { rows: messages } = await pool.query(
    `SELECT message_id, author, content, timestamp
     FROM messages
     WHERE channel_id = $1
       AND timestamp >= $2
       AND timestamp < $3
     ORDER BY timestamp ASC`,
    [args.channel, args.start, args.end]
  );

  console.log(`Loaded ${messages.length} messages from channel ${args.channel} (${args.start} → ${args.end}).`);

  const chunks = chunkMessages(messages, CHUNK_SIZE, OVERLAP);
  console.log(`Sliced into ${chunks.length} chunks (size=${CHUNK_SIZE}, overlap=${OVERLAP}).`);

  const allEpisodes = [];
  const perChunk = [];
  let totalInput = 0;
  let totalOutput = 0;

  for (const chunk of chunks) {
    const t0 = Date.now();
    const result = await scanChunk(chunk);
    const ms = Date.now() - t0;
    const eps = result.episodes || [];
    const ui = result.usage?.input_tokens || 0;
    const uo = result.usage?.output_tokens || 0;
    totalInput += ui;
    totalOutput += uo;
    console.log(
      `  chunk ${chunk.index} (${chunk.messages.length} msgs): ${eps.length} episodes, ${ms}ms, in=${ui} out=${uo}`
    );
    for (const e of eps) {
      allEpisodes.push({
        ...e,
        chunk_index: chunk.index,
      });
    }
    perChunk.push({
      index: chunk.index,
      offset: chunk.offset,
      first_msg_id: chunk.messages[0]?.message_id,
      last_msg_id: chunk.messages[chunk.messages.length - 1]?.message_id,
      first_ts: chunk.messages[0]?.timestamp,
      last_ts: chunk.messages[chunk.messages.length - 1]?.timestamp,
      msg_count: chunk.messages.length,
      episode_count: eps.length,
      duration_ms: ms,
      input_tokens: ui,
      output_tokens: uo,
      parseError: result.parseError,
    });
  }

  const output = {
    generator_version: GENERATOR_VERSION,
    model: MODEL,
    args,
    chunk_size: CHUNK_SIZE,
    overlap: OVERLAP,
    total_messages: messages.length,
    total_chunks: chunks.length,
    total_episodes_raw: allEpisodes.length,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    chunks: perChunk,
    episodes: allEpisodes,
  };

  fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${allEpisodes.length} raw episode detections to ${args.out}`);
  console.log(`Total tokens: in=${totalInput} out=${totalOutput}`);

  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
