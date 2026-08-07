require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, ChannelType } = require("discord.js");
const { Pool } = require("pg");
const { z } = require("zod");
const {
  query: sdkQuery,
  tool,
  createSdkMcpServer,
} = require("@anthropic-ai/claude-agent-sdk");

const DISCORD_MAX_LEN = 2000;
const REPLY_CHUNK_LEN = 1900;
// Turn cap is per-depth. Deep synthesis questions ("SWOT of Zuck", "top 10
// pinned comments ranked") do many query_db round-trips gathering samples and
// were empirically burning all 30 turns before writing final prose — surfacing
// as "(Data Boy returned no answer.)" with status=error_max_turns / length.
// Shallow lookups don't need the headroom. Watch data_boy_logs.status to tune.
const MAX_TURNS = 30; // shallow default (also the fallback when depth unknown)
const MAX_TURNS_DEEP = 50;

// MODEL_PROVIDER controls the LLM backend.
//   - "anthropic" uses the Claude Agent SDK over OAuth (Max account).
//   - "gemini-api" uses the Vercel AI SDK + @ai-sdk/google with a billed
//     GOOGLE_API_KEY. This is the supported path going forward — the OAuth
//     path below stops working 2026-06-18 when Google retires gemini-cli's
//     Code Assist auth.
//   - "gemini" (legacy) uses the Vercel AI SDK with the gemini-cli OAuth
//     provider (Google AI Pro/Ultra account). Kept for emergency rollback;
//     dies 2026-06-18 and carries ToS-ban risk in the meantime.
const MODEL_PROVIDER = (process.env.MODEL_PROVIDER || "anthropic").toLowerCase();
const MODELS_BY_PROVIDER = {
  anthropic: { shallow: "claude-sonnet-4-6", deep: "claude-opus-4-7" },
  // API-key path: full model catalog is available, including the newer
  // gemini-3.5-flash that the OAuth backend doesn't yet whitelist.
  "gemini-api": { shallow: "gemini-3.5-flash", deep: "gemini-3.1-pro-preview" },
  // Gemini 3.x with thinking turned down so multi-step tool calls work
  // without the `thoughtSignature` roundtrip the provider doesn't yet
  // support. Sacrifices the model's reasoning mode for now but keeps Gemini
  // 3's training improvements. Revisit thinkingLevel="HIGH" once the provider
  // (or upstream Vercel AI SDK) preserves signatures across turns.
  gemini: { shallow: "gemini-3.1-flash-lite", deep: "gemini-3.1-pro-preview" },
};
if (!MODELS_BY_PROVIDER[MODEL_PROVIDER]) {
  console.error(`Unknown MODEL_PROVIDER=${MODEL_PROVIDER}. Expected one of: ${Object.keys(MODELS_BY_PROVIDER).join(", ")}`);
  process.exit(1);
}
const MODEL_SHALLOW = MODELS_BY_PROVIDER[MODEL_PROVIDER].shallow;
const MODEL_DEEP = MODELS_BY_PROVIDER[MODEL_PROVIDER].deep;

// When the upstream model is capacity-throttled, the Vercel AI SDK has
// already burned its 3 internal retries by the time we see the error. Wait
// these intervals between outer retries — backoff matches what Google
// capacity blips empirically take to clear (seconds to a minute). After the
// last entry is consumed, we give up and surface the friendly final error.
const CAPACITY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const CAPACITY_RETRY_MESSAGE = "Google is cucking data boy right now (ꐦ¬_¬)... give him a minute";

// Recognize the family of "the upstream is overloaded, your retries won't
// help, fail fast" errors. Matches messages emitted by both the Vercel AI
// SDK wrapper and the underlying Gemini / Anthropic transports.
function isCapacityError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("no capacity available") ||
    msg.includes("overloaded") ||
    msg.includes("resource exhausted") ||
    msg.includes("unavailable") ||
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  );
}

// Turn an internal error into something a non-engineer in Discord can read
// without panicking. We keep the raw message in logs (see callers) so we
// don't lose debugging fidelity.
function formatUserFacingError(err) {
  if (isCapacityError(err)) {
    return "Google is still cucking data boy (｡•̀ ⤙ •́ ｡ꐦ)... try again in a few minutes.";
  }
  const raw = String(err?.message || err || "unknown error").trim();
  // Trim Vercel AI SDK's noisy "Failed after N attempts. Last error: …" wrapper.
  const cleaned = raw.replace(/^Failed after \d+ attempts?\.\s*Last error:\s*/i, "");
  return `Data Boy hit an error: \`${cleaned.slice(0, 300)}\``;
}

// Keywords that signal a question requires deeper analysis/synthesis.
// On a hit, we route to Opus and tell the model to pull larger samples.
const DEEP_KEYWORDS = [
  "lore",
  "personality",
  "personalities",
  "analyze",
  "analysis",
  "analyse",
  "psychoanal",
  "characteriz",
  "profile",
  "tell me about",
  "deep dive",
  "writing style",
  "summarize each",
  "summary of each",
  "what should",
  "should each",
  "recommend",
  "advice",
  "maximize",
  "happiest",
  "happiness",
  "saddest",
  // Persona / voice / impersonation — these REQUIRE pulling each person's
  // actual messages to capture lexical fingerprint, not generic archetypes.
  "in our style",
  "in our voice",
  "in their style",
  "in their voice",
  "in my style",
  "in my voice",
  "in the style of",
  "make up a bit",
  "write a bit",
  "do a bit",
  "do an impression",
  "impersonate",
  "imitate",
  "speak like",
  "write as",
  "voice of each",
  "style of each",
  "as if they were",
  "as if i were",
];

function classifyDepth(question) {
  const lower = question.toLowerCase();
  return DEEP_KEYWORDS.some((kw) => lower.includes(kw)) ? "deep" : "shallow";
}

const PROMPT_PATH = path.join(__dirname, "data-boy-prompt.md");
// Base dir for per-question scratch space. Each invocation gets its own
// subdirectory (keyed on the Discord message id) so concurrent questions from
// different users can't wipe each other's files or pick up each other's
// generated attachments.
const WORK_ROOT = "/tmp/data-boy-work";

// Per-user in-flight question lock (Discord user id → boolean).
const inFlight = new Set();

// Discord message ids of "thinking…" placeholders belonging to a query that is
// still running. The janitor (cleanupStalePlaceholders) excludes these so it
// can never delete a live placeholder out from under a slow query.
const livePlaceholderIds = new Set();

// Per-user rate limit: count of starts in the last hour.
const recentStarts = new Map(); // userId → [timestampsMs]
const RATE_LIMIT_PER_HOUR = 12;

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Admin pool — used only for writing audit logs and reading startup context.
const adminPool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

// Read-only pool — used by the query_db tool.
const readonlyPool = new Pool({
  user: process.env.POSTGRES_READONLY_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_READONLY_PASSWORD,
  port: process.env.POSTGRES_PORT,
  max: 4,
});

async function waitForDb(pool, label) {
  for (let i = 0; i < 10; i++) {
    try {
      const c = await pool.connect();
      c.release();
      console.log(`Connected to postgres (${label}).`);
      return;
    } catch (err) {
      console.error(`DB connect (${label}) attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`Could not connect to postgres (${label}).`);
}

function stripMention(content, botUserId, message = null) {
  // Strip our own bot mention so it doesn't appear in the question.
  let result = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "");
  // Resolve any remaining <@USER_ID> to @username so the model can read it.
  result = result.replace(/<@!?(\d+)>/g, (m, id) => {
    const user =
      message?.mentions?.users?.get(id) ||
      message?.client?.users?.cache?.get(id);
    return user ? `@${user.username}` : m;
  });
  return result.trim();
}

// Discord doesn't preserve session state across @-mentions, so each question
// arrives without memory of prior turns. Pull the last N channel messages and
// hand them to Claude as conversation context — this lets follow-ups like
// "expand on 7" or "no the one about X" actually resolve.
const RECENT_CONTEXT_LIMIT = 20;
const RECENT_CONTEXT_MAX_CHARS_PER_MSG = 600;

async function fetchRecentContext(channel, beforeMessageId, botUserId) {
  try {
    const fetched = await channel.messages.fetch({
      limit: RECENT_CONTEXT_LIMIT,
      before: beforeMessageId,
    });
    const ordered = [...fetched.values()].reverse(); // oldest first
    const lines = [];
    for (const m of ordered) {
      let content = (m.cleanContent || m.content || "").trim();
      if (!content) continue;
      // Skip Data Boy's own progress placeholders — they're noise.
      if (
        m.author.id === botUserId &&
        /^(Data Boy is (still )?researching|_\(still working)/i.test(content)
      ) {
        continue;
      }
      if (content.length > RECENT_CONTEXT_MAX_CHARS_PER_MSG) {
        content = content.slice(0, RECENT_CONTEXT_MAX_CHARS_PER_MSG) + " …[truncated]";
      }
      const author = m.author.id === botUserId ? "Data Boy" : m.author.username;
      // Indent continuation lines so multi-line messages stay attributed
      // to one author. Without this, a line like "jake: energy drink startups"
      // inside Zuckerbuns' long reply gets read as if Jake said it.
      const indented = content.replace(/\n/g, "\n    ");
      lines.push(`${author}: ${indented}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.error("Failed to fetch recent context:", err.message);
    return "";
  }
}

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

function collectAttachments(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!/\.(png|jpe?g)$/i.test(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_ATTACHMENT_BYTES) continue;
    out.push({ path: full, name, size: stat.size, mtime: stat.mtimeMs });
  }
  // Newest first; cap.
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_ATTACHMENTS).map((a) => ({ attachment: a.path, name: a.name }));
}

// Reply to the asker's question, falling back to a plain channel send if the
// original message is gone (deleted, etc.). Returns the sent message.
async function replyOrSend(question, payload) {
  try {
    return await question.reply(payload);
  } catch (err) {
    console.warn(`Reply failed (${err.message}); sending to channel instead.`);
    return await question.channel.send(payload);
  }
}

// Post the answer as one or more brand-new messages — no editing of any
// placeholder. The first chunk replies to the asker's question (so it threads
// under it); overflow chunks are plain channel sends. Files ride the final
// chunk so the reader sees them after the prose.
async function postChunked(question, text, files = []) {
  const channel = question.channel;
  const trimmed = text.trim();
  if (trimmed.length === 0 && files.length === 0) {
    await replyOrSend(question, "(Data Boy returned no answer.)");
    return;
  }
  if (trimmed.length <= DISCORD_MAX_LEN) {
    await replyOrSend(question, { content: trimmed || " ", files });
    return;
  }
  const parts = [];
  let remaining = trimmed;
  while (remaining.length > 0) {
    if (remaining.length <= REPLY_CHUNK_LEN) {
      parts.push(remaining);
      break;
    }
    // Prefer splitting at a newline, fall back to a space, hard-cut only if needed.
    let splitAt = remaining.lastIndexOf("\n", REPLY_CHUNK_LEN);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", REPLY_CHUNK_LEN);
    if (splitAt <= 0) splitAt = REPLY_CHUNK_LEN;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  for (let i = 0; i < parts.length; i++) {
    const labeled = `${parts[i]}\n*(part ${i + 1}/${parts.length})*`;
    if (i === 0) {
      await replyOrSend(question, labeled);
    } else if (i === parts.length - 1) {
      await channel.send({ content: labeled, files });
    } else {
      await channel.send(labeled);
    }
  }
}

function rateLimitCheck(userId) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const arr = (recentStarts.get(userId) || []).filter((t) => t > hourAgo);
  if (arr.length >= RATE_LIMIT_PER_HOUR) {
    return false;
  }
  arr.push(now);
  recentStarts.set(userId, arr);
  return true;
}

// ── query_db MCP tool ──────────────────────────────────────────────────────
const queryDbTool = tool(
  "query_db",
  "Run a read-only SELECT/WITH SQL query against the jameworld database. " +
    "Returns up to 1000 rows as JSON. Hard 10s statement timeout. " +
    "Available tables: messages(id, channel_id, message_id, author, content, timestamp), " +
    "user_profiles(username, profile, updated_at).",
  { sql: z.string().describe("A single SELECT or WITH query.") },
  async ({ sql }) => {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    const head = trimmed.slice(0, 6).toUpperCase();
    if (head !== "SELECT" && head !== "WITH  " && trimmed.slice(0, 4).toUpperCase() !== "WITH") {
      return {
        content: [
          {
            type: "text",
            text: `Refused: query_db only accepts SELECT/WITH. Got: ${trimmed.slice(0, 40)}…`,
          },
        ],
        isError: true,
      };
    }
    const client = await readonlyPool.connect();
    try {
      // NB: `LIMIT 1000` appends to the model's SQL textually. Writes are
      // impossible regardless (readonly role + default_transaction_read_only),
      // but if the model ever sends a multi-statement query the LIMIT only
      // binds to the final statement. Acceptable given the role sandbox.
      const result = await client.query(`${trimmed} LIMIT 1000`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                rowCount: result.rowCount,
                truncated: result.rowCount === 1000,
                columns: result.fields.map((f) => f.name),
                rows: result.rows,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `SQL error: ${err.message}` }],
        isError: true,
      };
    } finally {
      client.release();
    }
  },
  { annotations: { readOnlyHint: true } }
);

const mcpServer = createSdkMcpServer({
  name: "data-boy-db",
  version: "0.1.0",
  tools: [queryDbTool],
});

// Fire-and-forget: capture the assembled prompt for later inspection via
// adminer / psql. Never let a logging failure block a bot reply.
async function logBotPrompt({ channelId, author, content, systemPrompt }) {
  try {
    await adminPool.query(
      `INSERT INTO bot_prompt_logs
         (bot_name, channel_id, triggering_author, triggering_content, system_prompt)
       VALUES ($1, $2, $3, $4, $5)`,
      ["data-boy", channelId, author, content, systemPrompt]
    );
  } catch (err) {
    console.error("bot_prompt_logs insert failed:", err.message);
  }
}

// ── Startup context ────────────────────────────────────────────────────────
async function buildSystemPrompt(depth = "shallow") {
  const template = fs.readFileSync(PROMPT_PATH, "utf8");

  const stats = await adminPool.query(`
    SELECT
      (SELECT count(*) FROM messages) AS msg_count,
      (SELECT min(timestamp) FROM messages) AS earliest,
      (SELECT max(timestamp) FROM messages) AS latest,
      (SELECT count(DISTINCT channel_id) FROM messages) AS channel_count,
      (SELECT count(DISTINCT author) FROM messages) AS author_count
  `);
  const s = stats.rows[0];

  // Channel map: only channels that actually appear in messages.
  const channelIdsRes = await adminPool.query(
    `SELECT DISTINCT channel_id FROM messages`
  );
  const seenIds = channelIdsRes.rows.map((r) => r.channel_id);

  const channelLines = [];
  for (const id of seenIds) {
    const ch = discord.channels.cache.get(id);
    const name = ch?.name || "(unknown / private)";
    channelLines.push(`- \`${id}\` → #${name}`);
  }

  const depthGuidance =
    depth === "deep"
      ? "**Depth tier: DEEP.** This question requires synthesis across many messages. Pull a substantial sample — scale with the user's total message count (aim for `min(2000, total/8)` messages, well-spread across the date range). Take your time; multiple passes are fine. Verify relationship claims (girlfriend vs sister, roommate vs brother, etc.) before asserting them."
      : "**Depth tier: SHALLOW.** This is a counting/stats/lookup question. One or two SQL queries should be enough. Don't over-sample.";

  const context = [
    "",
    "---",
    "",
    "## Runtime context (injected at startup)",
    "",
    `- Total messages: **${s.msg_count}**`,
    `- Date range: **${new Date(s.earliest).toISOString().slice(0, 10)}** → **${new Date(s.latest).toISOString().slice(0, 10)}**`,
    `- Distinct authors: ${s.author_count}`,
    `- Distinct channels: ${s.channel_count}`,
    "",
    depthGuidance,
    "",
    "### Channel ID → name",
    "",
    ...channelLines,
  ].join("\n");

  return template + context;
}

// ── The core: run one question through the SDK ─────────────────────────────
async function answer(question, systemPrompt, model, onProgress = null, maxTurns = MAX_TURNS, workDir) {
  // Fresh scratch dir per question (unique per invocation — see WORK_ROOT).
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  if (MODEL_PROVIDER === "gemini") {
    return answerWithGemini(question, systemPrompt, model, onProgress, maxTurns, workDir);
  }
  if (MODEL_PROVIDER === "gemini-api") {
    return answerWithGeminiApi(question, systemPrompt, model, onProgress, maxTurns, workDir);
  }
  return answerWithAnthropic(question, systemPrompt, model, onProgress, maxTurns, workDir);
}

async function answerWithAnthropic(question, systemPrompt, model, onProgress = null, maxTurns = MAX_TURNS, workDir) {
  let lastAssistantText = "";
  let resultText = null;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let status = null;

  for await (const msg of sdkQuery({
    prompt: question,
    options: {
      model,
      maxTurns,
      cwd: workDir,
      systemPrompt,
      mcpServers: {
        "data-boy-db": mcpServer,
      },
      allowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Grep",
        "Glob",
        "mcp__data-boy-db__query_db",
      ],
      permissionMode: "bypassPermissions",
      stderr: (data) => process.stderr.write(`[claude] ${data}`),
      env: {
        ...process.env,
        PGCONN: `postgresql://${encodeURIComponent(process.env.POSTGRES_READONLY_USER)}:${encodeURIComponent(process.env.POSTGRES_READONLY_PASSWORD)}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`,
        CLAUDE_CODE_AUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_AUTH_TOKEN,
        // The container is an isolated sandbox already; tell Claude Code so it
        // doesn't refuse to use bypassPermissions just because we're root.
        IS_SANDBOX: "1",
      },
    },
  })) {
    if (msg.type === "assistant" && msg.message?.content) {
      const textBlocks = msg.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (textBlocks) {
        lastAssistantText = textBlocks;
        onProgress?.(textBlocks);
      }
    } else if (msg.type === "result") {
      resultText = msg.result || null;
      turns = msg.num_turns ?? turns;
      inputTokens = msg.usage?.input_tokens ?? inputTokens;
      outputTokens = msg.usage?.output_tokens ?? outputTokens;
      // subtype: "success" | "error_max_turns" | "error_during_execution".
      // This is what tells an empty answer caused by turn exhaustion apart
      // from the model genuinely returning nothing — the single most useful
      // field for debugging "(Data Boy returned no answer.)".
      status = msg.subtype ?? status;
    }
  }

  return {
    text: resultText || lastAssistantText || "",
    turns,
    inputTokens,
    outputTokens,
    status,
  };
}

// ── Gemini providers (Vercel AI SDK — OAuth and API-key paths) ─────────────
// `ai`, `ai-sdk-provider-gemini-cli`, and `@ai-sdk/google` are ESM-only, so
// we dynamic-import. Modules cached on first call.
let _geminiOauthProvider = null;
let _googleApiProvider = null;
let _aiSdk = null;
async function getGeminiOauthProvider() {
  if (!_geminiOauthProvider) {
    const mod = await import("ai-sdk-provider-gemini-cli");
    _geminiOauthProvider = mod.createGeminiProvider({ authType: "oauth-personal" });
  }
  return _geminiOauthProvider;
}
async function getGoogleApiProvider() {
  if (!_googleApiProvider) {
    const mod = await import("@ai-sdk/google");
    _googleApiProvider = mod.createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
  }
  return _googleApiProvider;
}
async function getAiSdk() {
  if (!_aiSdk) _aiSdk = await import("ai");
  return _aiSdk;
}

// Tool surface is identical across both Gemini paths — pulled out so OAuth
// and API-key flows can't drift. Caller passes the `tool` factory from
// whichever `ai` import they have so the tool objects bind to the right
// module instance.
function buildVercelAiSdkTools(aiTool, workDir) {
  const env = {
    ...process.env,
    PGCONN: `postgresql://${encodeURIComponent(process.env.POSTGRES_READONLY_USER)}:${encodeURIComponent(process.env.POSTGRES_READONLY_PASSWORD)}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`,
  };
  return {
    query_db: aiTool({
      description:
        "Run a read-only SELECT or WITH SQL query against the jameworld DB. " +
        "Returns up to 1000 rows as JSON. Hard 10s statement timeout. " +
        "Tables: messages(id, channel_id, message_id, author, content, timestamp), " +
        "user_profiles(username, profile, updated_at), " +
        "episodes(channel_id, start_ts, end_ts, kind, sentiment, intensity, topic, summary, representative_quote, arc, participants, ...).",
      inputSchema: z.object({ sql: z.string().describe("A single SELECT or WITH query.") }),
      execute: async ({ sql }) => {
        const trimmed = sql.trim().replace(/;+\s*$/, "");
        const upper = trimmed.slice(0, 6).toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
          return { error: `Refused: query_db only accepts SELECT/WITH. Got: ${trimmed.slice(0, 40)}…` };
        }
        const client = await readonlyPool.connect();
        try {
          // See note in the MCP query_db tool: LIMIT is textual; safe under the
          // readonly role even if the model emits a multi-statement query.
          const result = await client.query(`${trimmed} LIMIT 1000`);
          return {
            rowCount: result.rowCount,
            truncated: result.rowCount === 1000,
            columns: result.fields.map((f) => f.name),
            rows: result.rows,
          };
        } catch (err) {
          return { error: `SQL error: ${err.message}` };
        } finally {
          client.release();
        }
      },
    }),
    run_bash: aiTool({
      description:
        "Execute a bash command. cwd is /tmp/data-boy-work (wiped per question). " +
        "PGCONN env is set for psql streaming. 60s timeout, 10MB output cap. " +
        "Returns stdout, stderr, exit_code.",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) =>
        new Promise((resolve) => {
          const { exec } = require("child_process");
          exec(
            command,
            { cwd: workDir, env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) =>
              resolve({
                stdout: String(stdout || "").slice(0, 50_000),
                stderr: String(stderr || "").slice(0, 50_000),
                exit_code: err?.code ?? 0,
                timed_out: !!(err && err.killed && err.signal === "SIGTERM"),
              })
          );
        }),
    }),
    write_file: aiTool({
      description: "Write text to a file under /tmp/data-boy-work. Overwrites if it exists.",
      inputSchema: z.object({
        path: z.string().describe("Relative path under the working dir."),
        content: z.string(),
      }),
      execute: async ({ path: p, content }) => {
        const full = path.join(workDir, p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return { wrote: full, bytes: Buffer.byteLength(content) };
      },
    }),
    read_file: aiTool({
      description: "Read a text file under /tmp/data-boy-work.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: p }) => {
        try {
          const full = path.join(workDir, p);
          return { content: fs.readFileSync(full, "utf8").slice(0, 100_000) };
        } catch (err) {
          return { error: err.message };
        }
      },
    }),
  };
}

// Shared generateText loop used by both Gemini paths. Caller hands in an
// already-constructed model handle (provider(modelName, ...)) and optional
// providerOptions; this fn does the streaming, token accounting, and return
// shape that the rest of the bot expects.
async function runVercelAiSdkAnswer({ modelHandle, providerOptions, systemPrompt, question, onProgress, maxTurns = MAX_TURNS, workDir }) {
  const { generateText, tool: aiTool, stepCountIs } = await getAiSdk();
  const tools = buildVercelAiSdkTools(aiTool, workDir);
  let lastText = "";
  let stepCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const result = await generateText({
    model: modelHandle,
    system: systemPrompt,
    prompt: question,
    tools,
    stopWhen: stepCountIs(maxTurns),
    ...(providerOptions ? { providerOptions } : {}),
    onStepFinish: ({ text, usage }) => {
      stepCount++;
      if (text) {
        lastText = text;
        onProgress?.(text);
      }
      if (usage) {
        inputTokens += usage.inputTokens || usage.promptTokens || 0;
        outputTokens += usage.outputTokens || usage.completionTokens || 0;
      }
    },
  });
  return {
    text: result.text || lastText || "",
    turns: stepCount,
    inputTokens: result.usage?.inputTokens ?? result.usage?.promptTokens ?? inputTokens,
    outputTokens: result.usage?.outputTokens ?? result.usage?.completionTokens ?? outputTokens,
    // Vercel AI SDK finishReason: 'stop' | 'length' | 'tool-calls' |
    // 'content-filter' | 'error' | 'other'. 'length'/'tool-calls' at the end
    // is the Gemini-path analogue of Anthropic's error_max_turns.
    status: result.finishReason ?? null,
  };
}

async function answerWithGemini(question, systemPrompt, modelName, onProgress = null, maxTurns = MAX_TURNS, workDir) {
  const gemini = await getGeminiOauthProvider();
  // Gemini 3 thinking config. Signatures on outgoing functionCall parts are
  // handled by our patch (see patch-gemini-provider.js), so we can let the
  // model reason at full strength. includeThoughts=false keeps thought
  // summaries out of the response — we don't display them and they'd just
  // pollute history. (OAuth provider takes settings as second arg.)
  const geminiSettings = modelName.startsWith("gemini-3")
    ? { thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: false } }
    : {};
  return runVercelAiSdkAnswer({
    modelHandle: gemini(modelName, geminiSettings),
    systemPrompt,
    question,
    onProgress,
    maxTurns,
    workDir,
  });
}

async function answerWithGeminiApi(question, systemPrompt, modelName, onProgress = null, maxTurns = MAX_TURNS, workDir) {
  const google = await getGoogleApiProvider();
  // @ai-sdk/google takes thinkingConfig via providerOptions.google on the
  // generateText call rather than on the model factory. thinkingBudget=-1
  // means "let the model decide" — works for both 2.5 (thinkingBudget) and
  // 3.x (thinkingLevel) without us having to special-case the schema.
  const providerOptions = modelName.startsWith("gemini-3") || modelName.startsWith("gemini-2.5")
    ? { google: { thinkingConfig: { thinkingBudget: -1, includeThoughts: false } } }
    : undefined;
  return runVercelAiSdkAnswer({
    modelHandle: google(modelName),
    providerOptions,
    systemPrompt,
    question,
    onProgress,
    maxTurns,
    workDir,
  });
}

// Atomically claim a Discord message_id in data_boy_logs. Returns the new row
// id on success, or null if another invocation already claimed it (uniqueness
// violation). This is the bulletproof dedup layer — DB enforces it regardless
// of how many process instances or async handler invocations race here.
async function claimMessage(messageId, discordUser, question) {
  try {
    const result = await adminPool.query(
      `INSERT INTO data_boy_logs (discord_message_id, discord_user, question)
       VALUES ($1, $2, $3)
       ON CONFLICT (discord_message_id) WHERE discord_message_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [messageId, discordUser, question]
    );
    return result.rowCount > 0 ? result.rows[0].id : null;
  } catch (err) {
    console.error("claimMessage failed:", err.message);
    return null;
  }
}

async function finalizeQuery(rowId, row) {
  try {
    await adminPool.query(
      `UPDATE data_boy_logs
         SET answer = $2, turns = $3, input_tokens = $4, output_tokens = $5,
             error = $6, duration_ms = $7, status = $8
       WHERE id = $1`,
      [
        rowId,
        row.answer ?? null,
        row.turns ?? null,
        row.input_tokens ?? null,
        row.output_tokens ?? null,
        row.error ?? null,
        row.duration_ms ?? null,
        row.status ?? null,
      ]
    );
  } catch (err) {
    console.error("finalizeQuery failed:", err.message);
  }
}

async function handleStats(message) {
  try {
    const summary = await adminPool.query(`
      WITH recent AS (
        SELECT * FROM data_boy_logs WHERE asked_at > now() - interval '7 days'
      )
      SELECT
        (SELECT count(*) FROM recent) AS total,
        (SELECT count(*) FROM recent WHERE error IS NOT NULL) AS errors,
        (SELECT COALESCE(sum(input_tokens), 0) FROM recent) AS in_tok,
        (SELECT COALESCE(sum(output_tokens), 0) FROM recent) AS out_tok,
        (SELECT COALESCE(avg(duration_ms), 0)::int FROM recent) AS avg_dur,
        (SELECT COALESCE(avg(turns), 0)::numeric(10,1) FROM recent) AS avg_turns
    `);
    const top = await adminPool.query(`
      SELECT discord_user, count(*) AS n
      FROM data_boy_logs
      WHERE asked_at > now() - interval '7 days'
      GROUP BY discord_user
      ORDER BY n DESC
      LIMIT 5
    `);
    const all = await adminPool.query(
      `SELECT count(*) AS n FROM data_boy_logs`
    );
    const s = summary.rows[0];
    const lines = [
      "**Data Boy — last 7 days**",
      "```",
      `Total questions:  ${s.total}`,
      `Errors:           ${s.errors}`,
      `Tokens:           ${Number(s.in_tok).toLocaleString()} in / ${Number(s.out_tok).toLocaleString()} out`,
      `Avg duration:     ${(s.avg_dur / 1000).toFixed(1)}s`,
      `Avg turns:        ${s.avg_turns}`,
      "",
      `Top askers:`,
      ...top.rows.map((r) => `  ${r.discord_user.padEnd(28)} ${r.n}`),
      "```",
      `_Lifetime total: ${all.rows[0].n} questions._`,
    ];
    await message.reply(lines.join("\n"));
  } catch (err) {
    console.error("Stats command failed:", err);
    await message.reply(`Couldn't pull stats: \`${err.message}\``);
  }
}

// ── Discord event handling ─────────────────────────────────────────────────
// Two layers of dedup:
//   1. messageId → catches Discord re-delivering the exact same event
//   2. content fingerprint (channel + author + first 200 chars) → catches
//      cases where two events somehow have different message.ids but
//      represent the same user intent (observed in prod on 2026-05-18).
const processedMessageIds = new Map(); // messageId → expiresAt
const processedFingerprints = new Map(); // fp → expiresAt
const PROCESSED_TTL_MS = 5 * 60 * 1000;
const FINGERPRINT_TTL_MS = 30 * 1000; // shorter — only protect against burst dupes

function shouldSkipDuplicate(message) {
  const now = Date.now();
  // Lazy cleanup.
  for (const [id, expires] of processedMessageIds) {
    if (expires < now) processedMessageIds.delete(id);
  }
  for (const [fp, expires] of processedFingerprints) {
    if (expires < now) processedFingerprints.delete(fp);
  }
  if (processedMessageIds.has(message.id)) return "id";
  const fp = `${message.channel.id}:${message.author.id}:${(message.content || "").slice(0, 200)}`;
  if (processedFingerprints.has(fp)) return "fingerprint";
  processedMessageIds.set(message.id, now + PROCESSED_TTL_MS);
  processedFingerprints.set(fp, now + FINGERPRINT_TTL_MS);
  return null;
}

discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  if (message.content.trim().toLowerCase() === "!datastats") {
    await handleStats(message);
    return;
  }

  if (!message.mentions.has(discord.user)) return;

  console.log(`messageCreate from ${message.author.username} (msg=${message.id}, len=${message.content.length})`);

  const skipReason = shouldSkipDuplicate(message);
  if (skipReason) {
    console.log(`Skipping duplicate messageCreate for ${message.id} (reason: ${skipReason}).`);
    return;
  }

  // Discord auto-prepends an @mention when you reply to a message. Don't treat
  // a plain reply to Data Boy as a new question — the user must explicitly
  // @mention to ask something new.
  if (
    message.reference?.messageId &&
    message.mentions.repliedUser?.id === discord.user.id
  ) {
    return;
  }

  const question = stripMention(message.content, discord.user.id, message);
  if (!question) {
    await message.reply(
      "Ask me something! e.g. `@Data Boy who said \"lol\" the most?`"
    );
    return;
  }

  const userId = message.author.id;
  const userTag = message.author.tag;

  if (inFlight.has(userId)) {
    await message.reply("I'm still working on your last question. One at a time!");
    return;
  }
  if (!rateLimitCheck(userId)) {
    await message.reply(
      `You've asked ${RATE_LIMIT_PER_HOUR} questions in the last hour. Take a breather.`
    );
    return;
  }

  // DB-level dedup: atomically claim this Discord message_id. If another
  // invocation already claimed it (uniqueness violation), bail without
  // touching Discord. This is the bulletproof layer beneath the in-memory
  // dedup — it works even across processes.
  const logRowId = await claimMessage(message.id, userTag, question);
  if (logRowId === null) {
    console.log(`DB-dedup: message ${message.id} already claimed by another invocation — skipping.`);
    return;
  }

  inFlight.add(userId);
  const startedAt = Date.now();
  // Per-question scratch dir, unique to this Discord message.
  const workDir = path.join(WORK_ROOT, String(message.id));

  // A "thinking…" placeholder message that we edit with live progress, plus
  // Discord's native typing indicator. Unlike before, the placeholder is NOT
  // edited into the final answer — the answer is posted as separate new
  // message(s), and the placeholder is edited one last time into a quiet
  // "Data Boy thought for Ns" line (see the success path below).
  const placeholder = await message.reply("Data Boy is thinking… 🧠");
  livePlaceholderIds.add(placeholder.id);

  // Native "Data Boy is typing…" indicator. A single sendTyping() lasts ~10s,
  // so refresh it on an interval until we post the answer.
  message.channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8_000);

  let progressSnippet = null;
  let lastProgressEdit = 0;
  async function editProgress() {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    let status;
    if (progressSnippet) {
      const snippet = progressSnippet.replace(/\n+/g, " ").slice(0, 300);
      status = `_(still thinking… ${elapsed}s)_\n> ${snippet}`;
    } else {
      status = `Data Boy is still thinking… (${elapsed}s) 🧠`;
    }
    try {
      await placeholder.edit(status);
      lastProgressEdit = Date.now();
    } catch {}
  }
  // Heartbeat so the elapsed timer ticks even when the model is quiet.
  const progressInterval = setInterval(editProgress, 15_000);

  const depth = classifyDepth(question);
  const model = depth === "deep" ? MODEL_DEEP : MODEL_SHALLOW;
  const maxTurns = depth === "deep" ? MAX_TURNS_DEEP : MAX_TURNS;
  const askerUsername = message.author.username;
  const askerLine = `**Asker:** Discord user \`${askerUsername}\` (look them up in the People table to use their friendly name when addressing them).\n\n`;
  const recentContext = await fetchRecentContext(
    message.channel,
    message.id,
    discord.user.id
  );
  const contextBlock = recentContext
    ? `**Recent channel conversation** (last ~${RECENT_CONTEXT_LIMIT} messages, chronological; use to resolve follow-ups like "expand on #N", "the one about X", "no, the other one", etc.):\n\n${recentContext}\n\n---\n\n`
    : "";
  const enrichedQuestion = `${askerLine}${contextBlock}**Current question:**\n${question}`;
  console.log(`Classified "${question.slice(0, 60)}" as ${depth} → ${model} (maxTurns=${maxTurns}, asker: ${askerUsername}, ctx: ${recentContext.length} chars)`);

  try {
    const systemPrompt = await buildSystemPrompt(depth);
    logBotPrompt({
      channelId: message.channel.id,
      author: askerUsername,
      content: enrichedQuestion,
      systemPrompt,
    });
    const onProgress = (text) => {
      progressSnippet = text;
      // Update immediately when the model says something, throttled to 5s.
      if (Date.now() - lastProgressEdit > 5_000) editProgress();
    };
    let result;
    let capacityRetries = 0;
    while (true) {
      try {
        result = await answer(enrichedQuestion, systemPrompt, model, onProgress, maxTurns, workDir);
        break;
      } catch (err) {
        if (!isCapacityError(err) || capacityRetries >= CAPACITY_RETRY_DELAYS_MS.length) {
          throw err;
        }
        const waitMs = CAPACITY_RETRY_DELAYS_MS[capacityRetries];
        capacityRetries++;
        console.warn(
          `Capacity error on ${model} (attempt ${capacityRetries}/${CAPACITY_RETRY_DELAYS_MS.length}): ${err.message}. Retrying in ${waitMs}ms.`
        );
        // Surface the capacity blip in the placeholder itself.
        try {
          await placeholder.edit(CAPACITY_RETRY_MESSAGE);
        } catch {}
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    clearInterval(progressInterval);
    clearInterval(typingInterval);
    const duration = Date.now() - startedAt;
    const attachments = collectAttachments(workDir);
    if (attachments.length > 0) {
      console.log(`Attaching ${attachments.length} file(s): ${attachments.map((a) => a.name).join(", ")}`);
    }
    // Convert the placeholder into a quiet "thought for Ns" line, then post the
    // actual answer as separate new message(s).
    const secs = Math.round(duration / 1000);
    await placeholder
      .edit(`-# 🧠 Data Boy thought for ${secs} second${secs === 1 ? "" : "s"}`)
      .catch(() => {});
    await postChunked(message, result.text, attachments);
    const retryTag = capacityRetries > 0 ? ` [after ${capacityRetries} capacity retr${capacityRetries === 1 ? "y" : "ies"}]` : "";
    const isEmpty = (result.text || "").trim().length === 0 && attachments.length === 0;
    console.log(
      `Answered "${question.slice(0, 60)}" in ${duration}ms (${depth}/${model}${retryTag}, ${result.turns} turns, ${result.inputTokens}+${result.outputTokens} tokens, status=${result.status ?? "?"})${isEmpty ? " [EMPTY ANSWER]" : ""}`
    );
    await finalizeQuery(logRowId, {
      answer: result.text,
      turns: result.turns,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      duration_ms: duration,
      status: result.status,
    });
  } catch (err) {
    clearInterval(progressInterval);
    clearInterval(typingInterval);
    console.error("Error in answer():", err);
    // Turn the placeholder into the error message; if it's gone, reply fresh.
    try {
      await placeholder.edit(formatUserFacingError(err));
    } catch {
      await replyOrSend(message, formatUserFacingError(err)).catch((replyErr) =>
        console.error("Failed to deliver error message:", replyErr.message)
      );
    }
    await finalizeQuery(logRowId, {
      error: err.message,
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    inFlight.delete(userId);
    livePlaceholderIds.delete(placeholder.id);
    // Remove this question's scratch dir so /tmp doesn't accumulate.
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// Record a placeholder the janitor deleted, so a vanished message is never
// silent. If this table shows a deletion that overlaps a running query, the
// live-placeholder guard has a hole; in normal operation it should only ever
// log genuinely orphaned placeholders (e.g. left behind by a redeploy).
async function logPlaceholderDeletion({ channelId, messageId, ageMs, content }) {
  try {
    await adminPool.query(
      `INSERT INTO data_boy_placeholder_deletions
         (channel_id, message_id, message_age_ms, content)
       VALUES ($1, $2, $3, $4)`,
      [channelId, messageId, ageMs, (content || "").slice(0, 500)]
    );
  } catch (err) {
    console.error("logPlaceholderDeletion failed:", err.message);
  }
}

// Delete stale "thinking…" / "still thinking…" placeholders (and legacy
// "researching…" / "still working…" ones from older builds) that got orphaned
// when the bot was killed mid-flight — e.g. during a redeploy — so they don't
// sit in the channel forever. Runs at startup and every 90s. A live query's
// placeholder is protected via livePlaceholderIds; STALE_MS is a backstop well
// above the observed max query duration (~306s). Note the final "thought for
// Ns" line and the answer messages don't match these patterns, so they're safe.
async function cleanupStalePlaceholders() {
  const STALE_MS = 15 * 60 * 1000; // 15 min — safely above the slowest real query
  const PATTERNS = [
    /^Data Boy is (still )?thinking/i,
    /^_\(still thinking/i,
    /^Data Boy is (still )?researching/i,
    /^_\(still working/i,
  ];
  let cleaned = 0;
  try {
    for (const guild of discord.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (!channel.isTextBased?.() || !channel.viewable) continue;
        if (!channel.permissionsFor(discord.user)?.has("ManageMessages") &&
            !channel.permissionsFor(discord.user)?.has("ReadMessageHistory")) continue;
        try {
          const recent = await channel.messages.fetch({ limit: 50 });
          for (const m of recent.values()) {
            if (m.author.id !== discord.user.id) continue;
            // Never touch a placeholder for a query still running here.
            if (livePlaceholderIds.has(m.id)) continue;
            const ageMs = Date.now() - m.createdTimestamp;
            if (ageMs < STALE_MS) continue;
            if (!PATTERNS.some((re) => re.test(m.content || ""))) continue;
            const deleted = await m.delete().then(() => true).catch(() => false);
            if (!deleted) continue;
            cleaned++;
            await logPlaceholderDeletion({
              channelId: channel.id,
              messageId: m.id,
              ageMs,
              content: m.content,
            });
          }
        } catch {
          // Channel we don't have perms in — silent skip.
        }
      }
    }
  } catch (err) {
    console.error("cleanupStalePlaceholders error:", err.message);
  }
  if (cleaned > 0) console.log(`Cleaned up ${cleaned} stale placeholder message(s).`);
}

discord.once("ready", async () => {
  console.log(`Logged in as ${discord.user.tag}.`);
  // Run cleanup periodically so stranded placeholders self-clean.
  setInterval(() => { cleanupStalePlaceholders().catch(() => {}); }, 90 * 1000);
  await cleanupStalePlaceholders();
});

(async () => {
  if (!process.env.DISCORD_TOKEN_DATA_BOY) {
    console.error("DISCORD_TOKEN_DATA_BOY is not set; refusing to start.");
    process.exit(1);
  }
  if (MODEL_PROVIDER === "anthropic" && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_CODE_AUTH_TOKEN) {
    console.error(
      "CLAUDE_CODE_OAUTH_TOKEN (or CLAUDE_CODE_AUTH_TOKEN) is not set; refusing to start."
    );
    process.exit(1);
  }
  if (MODEL_PROVIDER === "gemini") {
    const credPath = path.join(process.env.HOME || "/root", ".gemini", "oauth_creds.json");
    if (!fs.existsSync(credPath)) {
      console.error(`MODEL_PROVIDER=gemini but no OAuth creds at ${credPath}. Run \`gemini\` on the host to log in, then mount ~/.gemini into the container.`);
      process.exit(1);
    }
  }
  console.log(`Provider: ${MODEL_PROVIDER}. Models — shallow: ${MODEL_SHALLOW}, deep: ${MODEL_DEEP}.`);
  await waitForDb(adminPool, "admin");
  await waitForDb(readonlyPool, "readonly");
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  await discord.login(process.env.DISCORD_TOKEN_DATA_BOY);
})().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
