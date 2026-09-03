require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, ChannelType } = require("discord.js");
const { Pool } = require("pg");
const { z } = require("zod");
const { execFile } = require("child_process");
const {
  query: sdkQuery,
  tool,
  createSdkMcpServer,
} = require("@anthropic-ai/claude-agent-sdk");
const { runFeatureEpic, salvageWorkDir, stashAttachments } = require("./toaster-feature.js");
const jobs = require("./job-queue.js");

/* Which half of the bot this process is.
 *
 *   gateway (default) -- holds the Discord connection, answers everything
 *                        short, and hands feature work to the queue.
 *   worker            -- no Discord connection at all; claims feature jobs
 *                        and runs them.
 *
 * Both are this same file, started with a different DATA_BOY_ROLE. Splitting
 * it into two modules would have meant extracting answer(), the SDK plumbing
 * and buildSystemPrompt() out from under the Discord client they currently
 * sit beside -- a large refactor to gain nothing the env var does not.
 *
 * TOASTER_SPLIT is separate on purpose. The role decides what a process does;
 * the flag decides whether feature requests actually go to the queue. Shipped
 * off, the gateway runs jobs inline exactly as it does today, so this can be
 * deployed and watched before anything depends on it.
 */
const JOB_ROLE = process.argv.includes("--worker")
  ? "worker"
  : (process.env.DATA_BOY_ROLE || "gateway").toLowerCase();
const SPLIT_ENABLED = process.env.TOASTER_SPLIT === "1";
const WORKER_POLL_MS = Number(process.env.TOASTER_WORKER_POLL_MS || 4000);
const GATEWAY_POLL_MS = Number(process.env.TOASTER_GATEWAY_POLL_MS || 5000);
const MAX_QUEUED_PER_USER = Number(process.env.TOASTER_MAX_QUEUED_PER_USER || 2);

const DISCORD_MAX_LEN = 2000;
const REPLY_CHUNK_LEN = 1900;
// Turn cap is per-depth. Deep synthesis questions ("SWOT of Zuck", "top 10
// pinned comments ranked") do many query_db round-trips gathering samples and
// were empirically burning all 30 turns before writing final prose — surfacing
// as "(Data Boy returned no answer.)" with status=error_max_turns / length.
// Shallow lookups don't need the headroom. Watch data_boy_logs.status to tune.
// The cap is no longer a cliff: runVercelAiSdkAnswer does a tool-free salvage
// pass when the budget runs out mid-investigation, so hitting it costs a
// less-researched answer rather than no answer at all. Grep logs for
// [SALVAGED] to see how often that fires before raising these further.
const MAX_TURNS = 30; // shallow default (also the fallback when depth unknown)
const MAX_TURNS_DEEP = 70;

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
  // API-key path: full model catalog is available.
  //
  // Both tiers are the same model on purpose. The pro tier was measurably
  // WORSE at this job than flash: on 2026-08-25 the same catch-up question
  // ran deep on gemini-3.1-pro-preview and stopped itself at 20 of 70 turns
  // having pulled 17k input tokens, where flash had spent 41k on the shallow
  // attempt. More budget and a "smarter" model produced a thinner answer,
  // because pro decided it was done early. Data Boy's work is wide sampling
  // and synthesis, not hard reasoning, and flash is better at wide sampling.
  //
  // So depth no longer picks a model — it picks a turn budget (MAX_TURNS vs
  // MAX_TURNS_DEEP) and a prompt tier that tells the model how much to
  // sample. Those are the levers that actually make a deep answer deeper.
  "gemini-api": { shallow: "gemini-3.7-flash", deep: "gemini-3.7-flash" },
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
  // Catch-up / "what did I miss" questions. These read as casual — often
  // literally phrased as "a quick rundown" — but answering one means sweeping
  // an open-ended date range and synthesising it, which is deep work. Asking
  // for a SHORT answer is not the same as asking an EASY question; depth is
  // about the investigation, not the reply length.
  "rundown",
  "recap",
  "up to speed",
  "what did i miss",
  "what have i missed",
  "what i missed",
  "what's new",
  "whats new",
];

// Same job as DEEP_KEYWORDS, for phrasings that need a wildcard in the middle
// ("catch Jake up", "since he last dropped in") and so can't be a substring.
const DEEP_PATTERNS = [
  /\bcatch\s+(?:\w+\s+)?up\b/,
  /\bsince\s+(?:he|she|they|we|you|i|\w+)\s+(?:last|was|were)\b/,
  /\bwhat(?:'s|s|\s+has|\s+have|\s+had)?\s+(?:been\s+)?(?:happen(?:ed|ing)|going\s+on)\s+(?:since|lately|recently)\b/,
];

function classifyDepth(question) {
  const lower = question.toLowerCase();
  if (DEEP_KEYWORDS.some((kw) => lower.includes(kw))) return "deep";
  if (DEEP_PATTERNS.some((re) => re.test(lower))) return "deep";
  return "shallow";
}

// ── Route: which DOMAIN is this question about? ────────────────────────────
// Orthogonal to depth (how hard). "chat" = the jameworld message history, the
// original and default behaviour. "code" = Scott's GitHub repos.
//
// A chat-routed question builds a prompt byte-identical to the pre-GitHub bot,
// so adding code mode cannot regress existing answers.
const CODE_KEYWORDS = [
  "repo", "repos", "repository", "github", "commit", "commits", "codebase",
  "branch", "pull request", "merge", "pushed", "deployed", "deploy",
  "source code", "the code", "his code", "your code", "scott's code",
  "implemented", "implementation", "refactor", "bug fix", "bugfix",
  "what is lumen", "how does lumen", "working on lately", "been working on",
  "been building", "been coding", "what has scott", "what's scott been",
  "api", "endpoint", "schema", "migration", "dependency", "package.json",
  "function", "class", "module", "architecture", "stack", "framework",
  "written in", "built with", "how does it work", "how did he build",
  "how did scott", "link to that project", "send me a link",
];

// Explicit override beats the classifier: "@Data Boy code: <question>".
const ROUTE_PREFIX = /^(code|chat|db|github|gh|feature|build)\s*[:\-]\s*/i;

// Repo names are the strongest signal there is — a bare "how does lumen render"
// should route to code even with no keyword. Filled in at startup from gh.
let KNOWN_REPO_NAMES = [];

// Whole-word containment, deliberately regex-free. A repo named "lumen" must
// not match inside "volumendata", but building the pattern with a template
// literal is a known footgun here (an escaped word-boundary silently becomes a
// backspace character), so this does the boundary check directly.
function containsWord(haystack, word) {
  const w = word.toLowerCase();
  const isWordChar = (c) => c !== undefined && /[a-z0-9]/i.test(c);
  let i = haystack.indexOf(w);
  while (i !== -1) {
    if (!isWordChar(haystack[i - 1]) && !isWordChar(haystack[i + w.length])) {
      return true;
    }
    i = haystack.indexOf(w, i + 1);
  }
  return false;
}

// Discord has TWO mention forms and stripMention() only handles the user one
// (<@id>). When the client autocompletes to the bot's ROLE instead (<@&id>),
// the mention survives into the question text -- which silently defeated the
// "^" anchor on ROUTE_PREFIX and made "chat:" overrides do nothing. Strip any
// leading mention of either form before looking for the prefix. Character
// classes rather than \d/\s on purpose; see the note on bashTimeoutFor.
const LEADING_MENTIONS = /^(?:<@[!&]?[0-9]+>[ ]*)+/;

function parseRoute(rawQuestion) {
  const raw = (rawQuestion || "").replace(LEADING_MENTIONS, "").trim();
  const m = raw.match(ROUTE_PREFIX);
  if (m) {
    const tag = m[1].toLowerCase();
    return {
      route:
        tag === "chat" || tag === "db"
          ? "chat"
          : tag === "feature" || tag === "build"
            ? "feature"
            : "code",
      question: raw.slice(m[0].length).trim(),
      forced: true,
    };
  }
  const lower = raw.toLowerCase();
  const hit =
    CODE_KEYWORDS.some((kw) => lower.includes(kw)) ||
    KNOWN_REPO_NAMES.some((r) => r.length > 3 && containsWord(lower, r));
  return { route: hit ? "code" : "chat", question: raw, forced: false };
}

const PROMPT_PATH = path.join(__dirname, "data-boy-prompt.md");
// Code-mode prompt. Separate file, not an append — a code question must not
// carry the 20KB of Postgres/message-history instructions, and vice versa.
const CODE_PROMPT_PATH = path.join(__dirname, "code-prompt.md");
// Code questions clone and grep real repos, so they need more headroom than a
// SQL lookup, but the terse-answer rules keep output short regardless.
// Feature mode edits real C and must get it compiling, which takes many more
// steps than answering a question. Ambitious requests are the point, so this is
// deliberately generous -- the prompt governs reply length, not the turn cap.
const FEATURE_PROMPT_PATH = path.join(__dirname, "feature-prompt.md");
const MAX_TURNS_FEATURE = Number(process.env.MAX_TURNS_FEATURE || 200);
// Feature mode always runs on the Anthropic path regardless of
// MODEL_PROVIDER: editing 1200 lines of C until it compiles is a different
// job from answering a question, and the global provider serves the latter.
const FEATURE_MODEL = process.env.FEATURE_MODEL || "claude-opus-5";
const MAX_TURNS_CODE = 40;
const MAX_TURNS_CODE_DEEP = 60;
// Persistent clone cache (see Dockerfile.data-boy). Survives between questions.
const REPO_CACHE = process.env.REPO_CACHE || "/var/cache/repos";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "scottdaly";
// Base dir for per-question scratch space. Each invocation gets its own
// subdirectory (keyed on the Discord message id) so concurrent questions from
// different users can't wipe each other's files or pick up each other's
// generated attachments.
const WORK_ROOT = "/tmp/data-boy-work";

// Per-user in-flight question lock (Discord user id → boolean).
const inFlight = new Set();

// What each running job is doing right now. Without this the only evidence a
// long job is alive was file timestamps in its work dir -- the Discord
// placeholder is transient and overwritten, and the logs go quiet between
// "Classified" and the build twenty minutes later.
const liveJobs = new Map();   // logRowId -> {user, question, started, note, at}

function jobNote(id, fields) {
  const j = liveJobs.get(id) || {};
  liveJobs.set(id, Object.assign(j, fields, { at: Date.now() }));
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
}

// When this process started. Recovery uses it to tell an orphaned job from a
// live one: every unfinished row looks identical, so without this a second
// instance (or a slow boot) would declare a running job lost and mark it
// failed while its worker was still going.
const BOOT_TIME = new Date();

// A rebuild sends SIGTERM. Killing a job mid-run leaves the asker with a
// placeholder that never resolves and work that is silently lost -- so refuse
// new work and wait for what is running to finish. Docker's default 10s stop
// timeout is far too short for a ~60s feature build; docker-compose.yml sets
// stop_grace_period to match DRAIN_MS.
let shuttingDown = false;
// Feature jobs routinely run 3-7 minutes; a drain shorter than that just
// means Docker SIGKILLs the job anyway. Matches stop_grace_period.
const DRAIN_MS = Number(process.env.DRAIN_MS || 880_000);

/* Jobs this process is running that did not arrive through Discord.
 *
 * The drain below only ever watched `inFlight`, which the message handler
 * populates -- and in worker mode that handler never runs. SIGTERM therefore
 * saw zero work and exited immediately, killing the job in the very container
 * built to protect it. The 900s grace period was never reached. */
const workerJobs = new Set();

async function drainThenExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const busy = () => inFlight.size + workerJobs.size;
  console.log(`${signal}: draining ${busy()} in-flight job(s), up to ${DRAIN_MS}ms.`);
  const deadline = Date.now() + DRAIN_MS;
  while (busy() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (busy() > 0) {
    console.warn(`${signal}: giving up with ${busy()} still running.`);
  } else {
    console.log(`${signal}: drained cleanly.`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => drainThenExit("SIGTERM"));
process.on("SIGINT", () => drainThenExit("SIGINT"));

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

// If this question is itself a Discord reply (to something other than Data
// Boy — that case is handled separately above), fetch the message it's
// replying to and surface it explicitly. Without this, a pronoun like "his"
// in "add it to his clueless tally" has no resolved antecedent — the model
// only sees a flat, unlinked transcript in fetchRecentContext and has to
// guess, which biases it toward whichever person is already the strongest
// running bit in the channel rather than the actual reply target.
async function fetchReplyTarget(message, botUserId) {
  const refId = message.reference?.messageId;
  if (!refId) return "";
  try {
    const ref = await message.fetchReference();
    let content = (ref.cleanContent || ref.content || "").trim();
    if (!content) return "";
    if (content.length > RECENT_CONTEXT_MAX_CHARS_PER_MSG) {
      content = content.slice(0, RECENT_CONTEXT_MAX_CHARS_PER_MSG) + " …[truncated]";
    }
    const author = ref.author.id === botUserId ? "Data Boy" : ref.author.username;
    return `**This message is a reply to** ${author}: "${content}"\n\n`;
  } catch (err) {
    console.error("Failed to fetch reply target:", err.message);
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
// chunk so the reader sees them after the prose. An optional `prefix` (e.g.
// the "thought for Ns" line) is prepended to the very first chunk instead of
// being posted as its own message.
async function postChunked(question, text, files = [], prefix = "") {
  const channel = question.channel;
  const trimmed = text.trim();
  const lead = prefix ? `${prefix}\n` : "";
  if (trimmed.length === 0 && files.length === 0) {
    await replyOrSend(question, `${lead}(Data Boy returned no answer.)`);
    return;
  }
  if (lead.length + trimmed.length <= DISCORD_MAX_LEN) {
    await replyOrSend(question, { content: `${lead}${trimmed}` || " ", files });
    return;
  }
  const parts = [];
  let remaining = trimmed;
  // First chunk has less room to make space for the prepended prefix.
  let chunkLimit = REPLY_CHUNK_LEN - lead.length;
  while (remaining.length > 0) {
    if (remaining.length <= chunkLimit) {
      parts.push(remaining);
      break;
    }
    // Prefer splitting at a newline, fall back to a space, hard-cut only if needed.
    let splitAt = remaining.lastIndexOf("\n", chunkLimit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", chunkLimit);
    if (splitAt <= 0) splitAt = chunkLimit;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
    chunkLimit = REPLY_CHUNK_LEN;
  }
  for (let i = 0; i < parts.length; i++) {
    const labeled = `${i === 0 ? lead : ""}${parts[i]}\n*(part ${i + 1}/${parts.length})*`;
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
    "user_profiles(username, profile, updated_at), " +
    "author_aliases(alias, canonical). " +
    "Prefer the messages_canonical view (same columns as messages, but author " +
    "resolved through author_aliases) whenever counting/grouping by author, so " +
    "renamed users like 'Almighty Zuck'/'Zuckerbuns' aren't split.",
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
// Repo index, cached so we don't shell out to gh on every code question.
let repoIndexCache = { at: 0, text: "" };
const REPO_INDEX_TTL_MS = 10 * 60 * 1000;

function ghJson(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: 20_000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) {
        console.error("gh failed:", err.message);
        return resolve(null);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        console.error("gh returned non-JSON:", e.message);
        resolve(null);
      }
    });
  });
}

// Inject the repo list into the code prompt so the model doesn't burn a turn
// listing them, and refresh KNOWN_REPO_NAMES so routing can recognise bare
// repo names like "lumen".
async function fetchRepoIndex() {
  if (Date.now() - repoIndexCache.at < REPO_INDEX_TTL_MS) return repoIndexCache.text;
  const repos = await ghJson([
    "repo", "list", GITHUB_OWNER,
    "--limit", "60", "--source",
    "--json", "name,description,pushedAt,visibility,primaryLanguage,url",
  ]);
  if (!repos || !repos.length) {
    // Don't cache a failure for 10 minutes — retry on the next question.
    return "(Repo list unavailable — run `gh repo list` yourself to see what exists.)";
  }
  KNOWN_REPO_NAMES = repos.map((r) => r.name.toLowerCase());
  const lines = repos
    .slice()
    .sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""))
    .map((r) => {
      const when = (r.pushedAt || "").slice(0, 10);
      const lang = r.primaryLanguage?.name ? `, ${r.primaryLanguage.name}` : "";
      const vis = (r.visibility || "").toLowerCase();
      const desc = r.description ? ` — ${r.description}` : "";
      return `- **${r.name}** (${vis}${lang}, last push ${when})${desc}`;
    });
  const text = lines.join("\n");
  repoIndexCache = { at: Date.now(), text };
  return text;
}

async function buildCodeSystemPrompt(depth) {
  const template = fs.readFileSync(CODE_PROMPT_PATH, "utf8");
  const repoIndex = await fetchRepoIndex();
  const depthGuidance =
    depth === "deep"
      ? "**Depth tier: DEEP.** Read the actual source before answering — clone and grep rather than relying on commit messages. You still answer concisely; depth applies to your investigation, NOT to your reply length."
      : "**Depth tier: SHALLOW.** A repo listing or a commit log is probably enough. Don't clone unless the question really needs the source.";
  return [
    template,
    "",
    "---",
    "",
    "## Runtime context (injected per question)",
    "",
    `- GitHub owner: **${GITHUB_OWNER}**`,
    `- Clone cache: \`${REPO_CACHE}\` (persists between questions)`,
    `- Today: **${new Date().toISOString().slice(0, 10)}**`,
    "",
    depthGuidance,
    "",
    "### Repos (most recently pushed first)",
    "",
    repoIndex,
  ].join("\n");
}

async function buildSystemPrompt(depth = "shallow", route = "chat") {
  // Code questions get a completely separate prompt — no message-history
  // instructions, no DB stats, no channel map. Chat questions fall through to
  // the original path below, byte-identical to before GitHub support existed.
  if (route === "feature") return fs.readFileSync(FEATURE_PROMPT_PATH, "utf8");
  if (route === "code") return buildCodeSystemPrompt(depth);

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
      ? "**Depth tier: DEEP.** This question requires synthesis across many messages. Pull a substantial sample — scale with the user's total message count (aim for `min(2000, total/8)` messages, well-spread across the date range). Take your time; multiple passes are fine. Verify relationship claims (girlfriend vs sister, roommate vs brother, etc.) before asserting them. **Exception: catch-up questions.** If the question is \"what did X miss\" / \"what's happened since…\", follow the Catch-up section instead — scope to that person's absence window and read it in full. Spreading a sample across the whole archive will miss exactly the recent, low-volume things a catch-up is asking for."
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
async function answer(question, systemPrompt, model, onProgress = null, maxTurns = MAX_TURNS, workDir, prepared = false, provider = MODEL_PROVIDER, opts = {}) {
  // Fresh scratch dir per question (unique per invocation — see WORK_ROOT).
  // Feature mode passes prepared=true: it has already cloned the repo in there
  // and cutting it away would delete the checkout we are about to edit.
  if (!prepared) {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
  }

  // Model and provider arrive as separate arguments, so they can drift apart --
  // and they did: the feature planner passed a Claude model while inheriting the
  // global gemini-api provider, and Google answered "models/claude-opus-5 is not
  // found for API version v1beta", which reads like a missing model rather than
  // a routing mistake. Fail here with something that says what actually happened.
  const claudeModel = /^claude-/.test(String(model || ""));
  const geminiProvider = provider === "gemini" || provider === "gemini-api";
  if (claudeModel && geminiProvider) {
    throw new Error(
      `routing mistake: model '${model}' is Anthropic's but provider is '${provider}'. ` +
        `Pass "anthropic" as the provider argument alongside a claude-* model.`
    );
  }
  if (!claudeModel && provider === "anthropic") {
    throw new Error(
      `routing mistake: model '${model}' is not an Anthropic model but provider is 'anthropic'.`
    );
  }

  if (provider === "gemini") {
    return answerWithGemini(question, systemPrompt, model, onProgress, maxTurns, workDir);
  }
  if (provider === "gemini-api") {
    return answerWithGeminiApi(question, systemPrompt, model, onProgress, maxTurns, workDir);
  }
  return answerWithAnthropic(question, systemPrompt, model, onProgress, maxTurns, workDir, opts);
}

/* ── what the agent is actually doing ──────────────────────────────────────
 * The stream carries a tool_use block every time the agent touches anything,
 * and we used to filter those out and keep only its prose. That is why a
 * twelve-minute stretch of editing main.c looked exactly like a hang: the
 * model has nothing to say while it works, so the placeholder just sat there
 * counting seconds. These turn the blocks into the words somebody watching
 * over its shoulder would use.
 */
function baseName(p) {
  return String(p || "").split(/[\\/]/).pop() || "";
}
function describeBash(cmd, desc) {
  const c = String(cmd || "").trim();
  if (/build\.sh/.test(c))            return "running the build gates";
  if (/--savetest/.test(c))           return "checking save compatibility";
  if (/--shot/.test(c))               return "rendering a test frame";
  if (/\bemcc\b/.test(c))             return "building the wasm";
  if (/^git commit/.test(c))          return "committing the change";
  if (/^git push/.test(c))            return "pushing the branch";
  if (/^git (diff|log|status|show)/.test(c)) return "reading the git history";
  if (/^git /.test(c))                return "sorting out git";
  // The agent writes its own one-line description; it is usually better than
  // anything we would infer from the command text.
  if (desc)                           return String(desc).toLowerCase().slice(0, 60);
  return "running " + (c.split(/\s+/)[0] || "a command");
}
function describeToolUse(name, input) {
  const i = input || {};
  switch (name) {
    case "Edit":
    case "NotebookEdit": return "editing " + baseName(i.file_path);
    case "Write":        return "writing " + baseName(i.file_path);
    case "Read":         return "reading " + baseName(i.file_path);
    case "Grep":         return "searching for " + String(i.pattern || "").slice(0, 40);
    case "Glob":         return "looking for " + String(i.pattern || "").slice(0, 40);
    case "Bash":         return describeBash(i.command, i.description);
    default:
      return String(name || "").startsWith("mcp__") ? "querying the database" : "";
  }
}

async function answerWithAnthropic(question, systemPrompt, model, onProgress = null, maxTurns = MAX_TURNS, workDir, opts = {}) {
  let lastAssistantText = "";
  let resultText = null;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let status = null;

  const onActivity = opts.onActivity || null;
  let liveTurns = 0;
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
        // Read-only GitHub access for code-mode questions. gh reads GH_TOKEN
        // itself; git picks it up via the system credential helper.
        GH_TOKEN: process.env.GH_TOKEN || "",
        GITHUB_OWNER,
        REPO_CACHE,
        // The container is an isolated sandbox already; tell Claude Code so it
        // doesn't refuse to use bypassPermissions just because we're root.
        IS_SANDBOX: "1",
      },
    },
  })) {
    if (msg.type === "assistant" && msg.message?.content) {
      // num_turns only arrives in the final result message, so a live counter
      // has to be our own.
      liveTurns++;
      const textBlocks = msg.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (textBlocks) {
        lastAssistantText = textBlocks;
        onProgress?.(textBlocks);
      }
      for (const b of msg.message.content) {
        if (b.type !== "tool_use") continue;
        const what = describeToolUse(b.name, b.input);
        if (what) onActivity?.(what, liveTurns);
      }
    } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      // A failed tool is the other thing worth saying out loud: a build gate
      // going red is the difference between "still working" and "stuck".
      for (const b of msg.message.content) {
        if (b.type === "tool_result" && b.is_error) {
          onActivity?.("that didn't work - trying another way", liveTurns);
        }
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
// Cloning a real repo blows straight through the 60s default. Widen the budget
// only for commands that actually fetch over the network, so message-history
// questions keep exactly the timeout they always had.
function bashTimeoutFor(command) {
  const c = String(command || "").toLowerCase();
  // Deliberately no word-boundary escapes here: this file is edited through a
  // shell layer that silently turns an escaped backslash-b into a literal backspace
  // byte, which matches nothing. Explicit character classes are safe.
  const usesGit = /(^|[^a-z0-9_-])(git|gh)([^a-z0-9_-]|$)/.test(c);
  const isNetworkOp = /(^|[^a-z0-9_-])(clone|fetch|pull)([^a-z0-9_-]|$)/.test(c);
  return usesGit && isNetworkOp ? 300_000 : 60_000;
}

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
        "author_aliases(alias, canonical), " +
        "episodes(channel_id, start_ts, end_ts, kind, sentiment, intensity, topic, summary, representative_quote, arc, participants, ...). " +
        "Prefer the messages_canonical view (messages with author resolved via " +
        "author_aliases) when counting/grouping by author so renamed users like " +
        "'Almighty Zuck'/'Zuckerbuns' aren't split.",
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
            { cwd: workDir, env, timeout: bashTimeoutFor(command), maxBuffer: 10 * 1024 * 1024 },
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
  // Vercel AI SDK finishReason: 'stop' | 'length' | 'tool-calls' |
  // 'content-filter' | 'error' | 'other'. 'length'/'tool-calls' at the end
  // is the Gemini-path analogue of Anthropic's error_max_turns.
  const status = result.finishReason ?? null;
  let text = result.text || lastText || "";
  let salvaged = false;
  let salvageInput = 0;
  let salvageOutput = 0;

  // Budget exhausted mid-investigation: stopWhen cut the loop while the model
  // was still calling tools, so it never got to write prose and `text` is
  // empty. Everything it learned is still sitting in the message history —
  // throwing that away and reporting nothing wastes the whole run. Ask once
  // more with toolChoice:'none' so it MUST answer from what it already has.
  if (text.trim().length === 0 && (status === "tool-calls" || status === "length")) {
    try {
      const salvage = await generateText({
        model: modelHandle,
        system: systemPrompt,
        messages: [
          { role: "user", content: question },
          ...(result.response?.messages ?? []),
          {
            role: "user",
            content:
              "You are out of tool budget and cannot call any more tools. " +
              "Answer the original question now, using only what you already " +
              "found above. If your research was cut off before you had the " +
              "whole picture, say so in one short line and then give the best " +
              "answer you can from what you do have.",
          },
        ],
        // Tools stay declared so the message history stays schema-valid;
        // toolChoice:'none' is what actually forces prose.
        tools,
        toolChoice: "none",
        ...(providerOptions ? { providerOptions } : {}),
      });
      if ((salvage.text || "").trim().length > 0) {
        text = salvage.text;
        salvaged = true;
        stepCount++;
        salvageInput = salvage.usage?.inputTokens ?? salvage.usage?.promptTokens ?? 0;
        salvageOutput = salvage.usage?.outputTokens ?? salvage.usage?.completionTokens ?? 0;
      }
    } catch (err) {
      // A dangling tool call with no result will make the provider reject the
      // replayed history. Nothing to do but report the empty answer as before.
      console.warn(`Salvage pass failed: ${err.message}`);
    }
  }

  return {
    text,
    turns: stepCount,
    inputTokens:
      (result.usage?.inputTokens ?? result.usage?.promptTokens ?? inputTokens) + salvageInput,
    outputTokens:
      (result.usage?.outputTokens ?? result.usage?.completionTokens ?? outputTokens) + salvageOutput,
    status,
    salvaged,
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
async function claimMessage(messageId, discordUser, question, channelId) {
  try {
    const result = await adminPool.query(
      `INSERT INTO data_boy_logs (discord_message_id, discord_user, question, discord_channel_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_message_id) WHERE discord_message_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [messageId, discordUser, question, channelId]
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

  if (message.content.trim().toLowerCase() === "!status") {
    if (liveJobs.size === 0) {
      await message.reply("Nothing running.");
      return;
    }
    const now = Date.now();
    const rows = [...liveJobs.entries()].map(([id, j]) =>
      `**${j.user || "?"}** — ${String(j.question || "").slice(0, 46)}\n` +
      `-# ${ago(now - (j.started || now))} in · last: ${j.note || "?"} (${ago(now - (j.at || now))} ago)`
    );
    await message.reply(rows.join("\n\n"));
    return;
  }

  if (message.content.trim().toLowerCase() === "!datastats") {
    await handleStats(message);
    return;
  }

  // Bare-prefix feature command, in the same style as !datastats above, so a
  // change request doesn't need an @mention. "@Data Boy feature: ..." still
  // works; both land on the same route.
  const bang = message.content.trim().match(/^!(?:feature|build)(?:\s+([\s\S]*))?$/i);
  if (bang && !(bang[1] || "").trim()) {
    // Never leave a bare !feature unanswered -- say what it wants instead.
    await message.reply(
      "Tell me what to change, e.g. `!feature make the night sky purple`. " +
        "I'll edit the game, build it, and post the result."
    );
    return;
  }
  if (!bang && !message.mentions.has(discord.user)) return;

  console.log(`messageCreate from ${message.author.username} (msg=${message.id}, len=${message.content.length})`);

  const skipReason = shouldSkipDuplicate(message);
  if (skipReason) {
    console.log(`Skipping duplicate messageCreate for ${message.id} (reason: ${skipReason}).`);
    return;
  }

  // Discord auto-prepends an @mention when you reply to a message. Don't treat
  // a plain reply to Data Boy as a new question — the user must explicitly
  // @mention to ask something new.
  // ...but an explicit !feature is never an accidental reply, so let it through.
  if (
    !bang &&
    message.reference?.messageId &&
    message.mentions.repliedUser?.id === discord.user.id
  ) {
    return;
  }

  const rawQuestion = bang
    ? `feature: ${(bang[1] || "").trim()}`
    : stripMention(message.content, discord.user.id, message);
  // Route BEFORE anything else so an explicit "code:"/"chat:" prefix is
  // stripped before the question reaches logging, context enrichment, or the
  // model. Chat is the default and behaves exactly as it always has.
  const { route, question, forced: routeForced } = parseRoute(rawQuestion);
  if (!question) {
    await message.reply(
      "Ask me something! e.g. `@Data Boy who said \"lol\" the most?`"
    );
    return;
  }

  const userId = message.author.id;
  const userTag = message.author.tag;

  if (shuttingDown) {
    await message.reply("I'm restarting right now — give me a few seconds and ask again.");
    return;
  }
  if (inFlight.has(userId)) {
    await message.reply("I'm still working on your last question. One at a time!");
    return;
  }
  // Claim the slot synchronously, before the first await. Checking here and
  // adding after `await claimMessage` leaves a gap two fast messages from the
  // same person can both slip through -- and then whichever finishes first
  // deletes the key, making the user look idle while the other still runs.
  // Every early return below must release it again.
  inFlight.add(userId);

  if (!rateLimitCheck(userId)) {
    inFlight.delete(userId);
    // No liveJobs.delete() here: logRowId is declared below and claimMessage
    // has not run, so there is no job to forget -- and referencing it threw a
    // ReferenceError from the temporal dead zone, which meant the twelfth
    // question got a crash instead of the sentence explaining the limit.
    await message.reply(
      `You've asked ${RATE_LIMIT_PER_HOUR} questions in the last hour. Take a breather.`
    );
    return;
  }

  // DB-level dedup: atomically claim this Discord message_id. If another
  // invocation already claimed it (uniqueness violation), bail without
  // touching Discord. This is the bulletproof layer beneath the in-memory
  // dedup — it works even across processes.
  const logRowId = await claimMessage(message.id, userTag, question, message.channel.id);
  if (logRowId === null) {
    console.log(`DB-dedup: message ${message.id} already claimed by another invocation — skipping.`);
    inFlight.delete(userId);
    return;
  }

  const startedAt = Date.now();
  jobNote(logRowId, { user: userTag, question, started: startedAt, note: "starting" });
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

  let handedOff = false;        // queued for a worker; this process is done
  let progressSnippet = null;
  let activitySnippet = null;   // what the agent is touching right now
  let liveTurn = 0;
  let lastProgressEdit = 0;
  async function editProgress() {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const clock = elapsed < 90 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
    const lines = [];
    if (progressSnippet) {
      lines.push(`_(still thinking… ${clock})_`);
      lines.push("> " + progressSnippet.replace(/\n+/g, " ").slice(0, 300));
    } else {
      lines.push(`Data Boy is still thinking… (${clock}) 🧠`);
    }
    // The freshest signal goes last, where the eye lands.
    if (activitySnippet) {
      lines.push(`-# ${activitySnippet}${liveTurn ? ` · turn ${liveTurn}` : ""}`);
    }
    try {
      await placeholder.edit(lines.join("\n"));
      lastProgressEdit = Date.now();
    } catch {}
  }
  // Heartbeat so the elapsed timer ticks even when the model is quiet.
  const progressInterval = setInterval(editProgress, 15_000);

  const depth = classifyDepth(question);
  const model =
    route === "feature" ? FEATURE_MODEL : depth === "deep" ? MODEL_DEEP : MODEL_SHALLOW;
  // Code questions clone and grep real repos, so they get a higher turn cap
  // than a SQL lookup. Reply length is governed by the prompt, not by turns.
  const maxTurns =
    route === "feature"
      ? MAX_TURNS_FEATURE
      : route === "code"
      ? depth === "deep"
        ? MAX_TURNS_CODE_DEEP
        : MAX_TURNS_CODE
      : depth === "deep"
        ? MAX_TURNS_DEEP
        : MAX_TURNS;
  const askerUsername = message.author.username;
  const askerLine =
    route === "code"
      ? `**Asker:** Discord user \`${askerUsername}\`.\n\n`
      : `**Asker:** Discord user \`${askerUsername}\` (look them up in the People table to use their friendly name when addressing them).\n\n`;
  const recentContext = await fetchRecentContext(
    message.channel,
    message.id,
    discord.user.id
  );
  const contextBlock = recentContext
    ? `**Recent channel conversation** (last ~${RECENT_CONTEXT_LIMIT} messages, chronological; use to resolve follow-ups like "expand on #N", "the one about X", "no, the other one", etc.):\n\n${recentContext}\n\n---\n\n`
    : "";
  const replyTargetBlock = await fetchReplyTarget(message, discord.user.id);
  const enrichedQuestion = `${askerLine}${contextBlock}${replyTargetBlock}**Current question:**\n${question}`;
  console.log(`Classified "${question.slice(0, 60)}" as ${route}/${depth}${routeForced ? " (forced)" : ""} → ${model} (maxTurns=${maxTurns}, asker: ${askerUsername}, ctx: ${recentContext.length} chars)`);

  try {
    const systemPrompt = await buildSystemPrompt(depth, route);
    logBotPrompt({
      channelId: message.channel.id,
      author: askerUsername,
      content: enrichedQuestion,
      systemPrompt,
    });
    const onProgress = (text) => {
      progressSnippet = text;
      // Also record it: a placeholder edit is overwritten by the next one, so
      // without this there is no trace afterwards of what a job was doing.
      const line = String(text || "").replace(/\s+/g, " ").trim().slice(0, 110);
      if (line) {
        jobNote(logRowId, { note: line });
        console.log(`[job ${logRowId}] ${line}`);
      }
      // Update immediately when the model says something, throttled to 5s.
      if (Date.now() - lastProgressEdit > 5_000) editProgress();
    };
    // Fires on every tool the agent picks up, which is far more often than it
    // speaks. Discord allows about five edits per five seconds per channel, so
    // this only ever marks the text dirty -- the 5s floor below and the 15s
    // heartbeat above are what actually talk to Discord.
    let lastActivityLogged = "";
    const onActivity = (what, turn) => {
      activitySnippet = what;
      if (turn) liveTurn = turn;
      if (what !== lastActivityLogged) {
        lastActivityLogged = what;
        jobNote(logRowId, { note: what, turn });
        console.log(`[job ${logRowId}] turn ${turn}: ${what}`);
      }
      if (Date.now() - lastProgressEdit > 5_000) editProgress();
    };
    let result;
    let capacityRetries = 0;

    if (route === "feature" && SPLIT_ENABLED) {
      // Hand it to a worker and stop holding this handler open. The whole
      // point: restarting this process to ship a change no longer kills a job
      // somebody asked for forty minutes ago.
      clearInterval(progressInterval);
      clearInterval(typingInterval);
      // inFlight is released the moment this handler returns, so it no longer
      // limits anything for queued work. Cap the queue itself instead.
      try {
        const { rows: q } = await adminPool.query(
          `SELECT count(*)::int AS n FROM data_boy_logs
            WHERE discord_user = $1 AND job_status IN ('queued', 'running')`,
          [userTag]
        );
        if (q[0] && q[0].n >= MAX_QUEUED_PER_USER) {
          clearInterval(progressInterval);
          clearInterval(typingInterval);
          await placeholder.edit(
            `You already have ${q[0].n} feature jobs queued or running. ` +
              "I'll take another once one of those lands."
          );
          await finalizeQuery(logRowId, { error: "per-user queue limit", duration_ms: 0 });
          handedOff = true;   // the work dir is not ours to delete either way
          return;
        }
      } catch (e) {
        console.warn(`queue-depth check failed, allowing: ${e.message}`);
      }

      const atts = [...message.attachments.values()].map((a) => ({
        name: a.name, url: a.url, size: a.size, contentType: a.contentType,
      }));
      // Fetch it now, while the link is certainly still good.
      let audioStash = null;
      if (atts.length) {
        try {
          audioStash = await stashAttachments(workDir, atts);
        } catch (e) {
          console.warn(`could not stash attachment for ${logRowId}: ${e.message}`);
        }
      }

      await jobs.enqueue(adminPool, logRowId, {
        request: question,
        attachments: atts,
        audioStash,
        model,
        maxTurns,
        placeholder_id: placeholder.id,
        queued_at: Date.now(),
      });
      handedOff = true;
      jobNote(logRowId, {
        user: askerUsername, question, started: startedAt, note: "queued for a worker",
      });
      try { await placeholder.edit("Queued — a worker is picking this up. 🛠️"); } catch {}
      console.log(`Queued feature job (row ${logRowId}) for a worker.`);
      return;
    }

    if (route === "feature") {
      const fr = await runFeatureEpic({
        request: question,
        // Discord CDN links expire, so the module downloads these immediately
        // rather than handing the agent a URL that may be dead by then.
        attachments: [...message.attachments.values()].map((a) => ({
          name: a.name,
          url: a.url,
          size: a.size,
          contentType: a.contentType,
        })),
        workDir,
        answer,
        systemPrompt,
        model,
        maxTurns,
        onProgress: (s) => {
          progressSnippet = s;
          editProgress();
        },
        onActivity,
        // Written after the plan and after every landed increment, so a
        // restart can pick the plan back up instead of losing it.
        persist: (s) => saveJobState(logRowId, s),
        // Posted between increments of a large request, and awaited: the
        // screenshot lives in the work dir, which the next increment's clone
        // wipes, so it has to be delivered before we move on.
        onIncrement: async (inc) => {
          const files = [];
          try {
            if (inc.preview && fs.existsSync(inc.preview)) {
              files.push({ attachment: inc.preview, name: `step-${inc.index}.png` });
            }
          } catch {}
          const header = `-# step ${inc.index} of ${inc.of} — **${inc.title}** is live`;
          await postChunked(message, inc.text || "", files, header);
        },
      });
      // runFeature always returns text -- success, failure, or exhaustion. The
      // built frame is left in workDir, so collectAttachments posts it.
      result = {
        text: fr.ok ? `${fr.text}

${fr.url}` : fr.text,
        turns: fr.turns || 0,
        inputTokens: fr.inputTokens || 0,
        outputTokens: fr.outputTokens || 0,
        status: fr.ok ? "success" : "feature_failed",
      };
    } else
    while (true) {
      try {
        result = await answer(enrichedQuestion, systemPrompt, model, onProgress, maxTurns, workDir,
                              false, MODEL_PROVIDER, { onActivity });
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
    // Drop the placeholder entirely and fold the "thought for Ns" line into
    // the top of the actual answer message, instead of leaving it behind as
    // its own edited-in-place message.
    const secs = Math.round(duration / 1000);
    const thoughtLine = `-# 🧠 Data Boy thought for ${secs} second${secs === 1 ? "" : "s"}`;
    await placeholder.delete().catch(() => {});
    const isEmpty = (result.text || "").trim().length === 0 && attachments.length === 0;
    if (isEmpty) {
      // Don't fall through to postChunked's generic "(Data Boy returned no
      // answer.)" — it tells the asker nothing about what went wrong or what
      // to do next. If we got here the salvage pass failed too.
      const ranOut =
        result.status === "tool-calls" ||
        result.status === "length" ||
        result.status === "error_max_turns"; // the Anthropic path's spelling
      await replyOrSend(
        message,
        `${thoughtLine}\n` +
          (ranOut
            ? `I ran out of digging time on that one — ${result.turns} steps and I still hadn't pulled it together. Try narrowing it down to a specific person, channel, or date range and I'll get there.`
            : "(Data Boy returned no answer.)")
      );
    } else {
      await postChunked(message, result.text, attachments, thoughtLine);
    }
    const retryTag = capacityRetries > 0 ? ` [after ${capacityRetries} capacity retr${capacityRetries === 1 ? "y" : "ies"}]` : "";
    const salvageTag = result.salvaged ? " [SALVAGED]" : "";
    console.log(
      `Answered "${question.slice(0, 60)}" in ${duration}ms (${depth}/${model}${retryTag}, ${result.turns} turns, ${result.inputTokens}+${result.outputTokens} tokens, status=${result.status ?? "?"})${salvageTag}${isEmpty ? " [EMPTY ANSWER]" : ""}`
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
    // A handed-off job has not started yet: the worker still needs the scratch
    // dir, and the placeholder has to survive until the worker's answer
    // replaces it. Tearing either down here is how a queued job would arrive
    // with no work dir and no message to edit.
    if (!handedOff) {
      livePlaceholderIds.delete(placeholder.id);
      // Remove this question's scratch dir so /tmp doesn't accumulate.
      fs.rmSync(workDir, { recursive: true, force: true });
    }
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
  // A queued or running job's placeholder is *supposed* to be old -- a feature
  // job runs for the better part of an hour. livePlaceholderIds only knows
  // about jobs this process is running, which after the split is none of them,
  // and it does not survive a restart either. The queue does.
  const guarded = new Set();
  try {
    const { rows } = await adminPool.query(
      `SELECT job_payload->>'placeholder_id' AS pid
         FROM data_boy_logs
        WHERE job_status IN ('queued', 'running')
          AND job_payload->>'placeholder_id' IS NOT NULL`
    );
    for (const r of rows) if (r.pid) guarded.add(r.pid);
  } catch (err) {
    // If we cannot tell which are live, delete nothing. A stale placeholder is
    // untidy; deleting the one a running job is writing to is a lost answer.
    console.warn(`Placeholder guard query failed, skipping cleanup: ${err.message}`);
    return;
  }

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
            // Never touch a placeholder for a query still running here...
            if (livePlaceholderIds.has(m.id)) continue;
            // ...nor one a worker in another container is writing to.
            if (guarded.has(m.id)) continue;
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

  // Previews copied out of a work dir so they could survive the hop to the
  // gateway. The gateway deletes each one as it posts it; these are the ones
  // it never got to.
  try {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(WORK_ROOT)) {
      if (!f.startsWith("post-") || !f.endsWith(".png")) continue;
      const p = path.join(WORK_ROOT, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch { /* the sweep is housekeeping; never let it break cleanup */ }
}


// A job killed mid-run (a rebuild, a crash) leaves its log row unfinalized and
// its asker staring at a placeholder that never resolves. Going quiet is the one
// outcome we refuse, so on boot: find those rows, tell the asker, close them out.
/* The plan a feature job is working through, and how far it got. A shipped
 * increment is already merged and published -- the only thing a restart
 * destroys is the knowledge that it happened, which is exactly the kind of
 * thing a database is for. */
async function saveJobState(rowId, state) {
  await adminPool.query("UPDATE data_boy_logs SET job_state = $1 WHERE id = $2", [
    JSON.stringify(state),
    rowId,
  ]);
}

/* Carry on with a plan a restart interrupted, instead of telling somebody who
 * waited forty minutes to type it again. The increments in state.shipped are
 * live on main; only what was mid-flight is redone. */
async function resumeFeatureJob(row, state) {
  const startedAt = Date.now();
  const left = state.plan.length - state.step;
  const ch = await discord.channels.fetch(row.discord_channel_id);
  const msg = await ch.messages.fetch(row.discord_message_id);
  const placeholder = await msg.reply(
    `I got restarted mid-job. **${state.shipped.length} of ${state.plan.length}** ` +
      `already shipped and live; ${left === 1 ? "one step is" : `${left} steps are`} ` +
      "still to go — picking up where I left off rather than starting over."
  );
  jobNote(row.id, {
    user: row.discord_user || "?", question: row.question,
    started: startedAt, note: "resuming after a restart",
  });

  const workDir = path.join(WORK_ROOT, String(row.discord_message_id));
  const systemPrompt = await buildSystemPrompt("shallow", "feature");
  let snippet = null, activity = null, turn = 0, lastEdit = 0;
  async function redraw() {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const clock = secs < 90 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
    const lines = [`_(picking up where I left off… ${clock})_`];
    if (snippet) lines.push("> " + String(snippet).replace(/\n+/g, " ").slice(0, 300));
    if (activity) lines.push(`-# ${activity}${turn ? ` · turn ${turn}` : ""}`);
    try { await placeholder.edit(lines.join("\n")); lastEdit = Date.now(); } catch {}
  }
  const beat = setInterval(redraw, 15_000);

  try {
    const fr = await runFeatureEpic({
      request: row.question,
      attachments: [],           // the originals expired long ago
      workDir, answer, systemPrompt,
      model: FEATURE_MODEL,
      maxTurns: MAX_TURNS_FEATURE,
      resume: state,
      persist: (s) => saveJobState(row.id, Object.assign({}, s, { resumes: (state.resumes || 0) + 1 })),
      onProgress: (s) => { snippet = s; if (Date.now() - lastEdit > 5_000) redraw(); },
      onActivity: (what, t) => {
        activity = what; if (t) turn = t;
        jobNote(row.id, { note: what, turn: t });
        if (Date.now() - lastEdit > 5_000) redraw();
      },
      onIncrement: async (inc) => {
        const files = [];
        try {
          if (inc.preview && fs.existsSync(inc.preview)) {
            files.push({ attachment: inc.preview, name: `step-${inc.index}.png` });
          }
        } catch {}
        await postChunked(msg, inc.text || "", files,
          `-# step ${inc.index} of ${inc.of} — **${inc.title}** is live`);
      },
    });
    clearInterval(beat);
    try { await placeholder.delete(); } catch {}
    await postChunked(msg, fr.ok ? `${fr.text}\n\n${fr.url}` : fr.text, collectAttachments(workDir));
    await finalizeQuery(row.id, {
      answer: fr.text, status: fr.ok ? "success" : "feature_failed",
      turns: fr.turns || 0,
      input_tokens: fr.inputTokens || 0,
      output_tokens: fr.outputTokens || 0,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    clearInterval(beat);
    console.error(`Recovery: resume of row ${row.id} failed: ${err.message}`);
    try { await msg.reply(`I tried to pick that back up and hit an error: ${err.message}`); } catch {}
    await finalizeQuery(row.id, { error: `resume failed: ${err.message}`, duration_ms: Date.now() - startedAt });
  } finally {
    liveJobs.delete(row.id);
  }
}

async function recoverInterruptedJobs() {
  try {
    await adminPool.query(
      "ALTER TABLE data_boy_logs ADD COLUMN IF NOT EXISTS discord_channel_id TEXT"
    );
    await adminPool.query(
      "ALTER TABLE data_boy_logs ADD COLUMN IF NOT EXISTS job_state JSONB"
    );
    const { rows } = await adminPool.query(
      `SELECT id, discord_message_id, discord_channel_id, discord_user, question, job_state
         FROM data_boy_logs
        WHERE answer IS NULL AND error IS NULL AND status IS NULL
          AND asked_at > NOW() - INTERVAL '24 hours'
          AND asked_at < $1
          -- A job the queue has ever owned is not this process's to recover.
          -- Without this, restarting the gateway would resume a job in-process
          -- that a worker is still running -- two agents editing the same
          -- branch, the exact failure the queue exists to prevent. 'done' is
          -- excluded too: a worker whose bookkeeping write failed leaves the
          -- row done-but-blank, and recovering that would re-run a job whose
          -- answer is already sitting in the outbox. The queue's own reaper
          -- handles anything it has stranded.
          AND job_status IS NULL
        ORDER BY id DESC LIMIT 20`,
      [BOOT_TIME]
    );
    if (rows.length === 0) return;
    console.log(`Recovery: ${rows.length} interrupted job(s) from before the restart.`);

    let resumed = 0;
    for (const r of rows) {
      // The work dir is on a volume, so an interrupted job's edits are still
      // on disk. Push them somewhere durable before telling anyone it's lost.
      const salvaged = await salvageWorkDir(
        path.join(WORK_ROOT, String(r.discord_message_id)),
        r.id
      );

      // A plan with steps left is worth finishing rather than apologising for.
      // One at a time, so a crash loop cannot start four jobs at boot, and
      // capped at two attempts so a job that dies on every restart eventually
      // gets a straight answer instead of an infinite retry.
      const st = r.job_state && typeof r.job_state === "object" ? r.job_state : null;
      if (
        resumed < 1 && st && Array.isArray(st.plan) && st.plan.length > 1 &&
        Number(st.step) >= 0 && Number(st.step) < st.plan.length &&
        (Number(st.resumes) || 0) < 2 && r.discord_channel_id && r.discord_message_id
      ) {
        resumed++;
        console.log(`Recovery: resuming row ${r.id} at step ${Number(st.step) + 1}/${st.plan.length}`);
        // Deliberately not awaited: the bot has to finish coming up. The row
        // stays open until the resumed job closes it, so another restart in
        // the meantime picks it up again.
        resumeFeatureJob(r, st).catch((e) =>
          console.error(`Recovery: resume of row ${r.id} threw: ${e.message}`)
        );
        continue;
      }

      let told = false;
      if (r.discord_channel_id && r.discord_message_id) {
        try {
          const ch = await discord.channels.fetch(r.discord_channel_id);
          const msg = await ch.messages.fetch(r.discord_message_id);
          await msg.reply(
            salvaged
              ? "I got restarted while working on this — sorry. I saved what I had " +
                  `to the branch \`${salvaged.branch}\`, so nothing is lost. Ask ` +
                  "again and I'll redo it properly."
              : "I got restarted while working on this and lost it — sorry. Ask again and I'll pick it up."
          );
          told = true;
        } catch (err) {
          console.warn(`Recovery: could not reply to ${r.discord_message_id}: ${err.message}`);
        }
      }
      await finalizeQuery(r.id, {
        error:
          (told ? "interrupted by restart (asker notified)" : "interrupted by restart") +
          (salvaged ? ` [salvaged to ${salvaged.branch}]` : ""),
        duration_ms: 0,
      });
      console.log(`Recovery: closed row ${r.id} ("${(r.question || "").slice(0, 40)}")`);
    }
  } catch (err) {
    // Never let recovery stop the bot from coming up.
    console.error("Recovery failed:", err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fenceOf = (row) => ({ worker: jobs.WORKER_ID, attempt: row.job_attempts });

/* ── worker ───────────────────────────────────────────────────────────────
 * Claim a job, run it, say what happened, repeat. The loop never exits: a
 * worker that stops polling is indistinguishable from one that is gone, and
 * a container that exits gets restarted anyway.
 */
async function runQueuedJob(row) {
  const startedAt = Date.now();
  const payload = row.job_payload && typeof row.job_payload === "object" ? row.job_payload : {};
  const state = row.job_state && typeof row.job_state === "object" ? row.job_state : null;
  const workDir = path.join(WORK_ROOT, String(row.discord_message_id));
  const systemPrompt = await buildSystemPrompt("shallow", "feature");

  // Live progress goes into the row, overwritten in place. The gateway reads
  // it on a timer -- a tool fires far more often than anyone needs told.
  // Proof of ownership, checked by every write from here on. A re-claim bumps
  // job_attempts, so if this worker's lease lapsed and another took the job,
  // our predicate stops matching and we find out instead of trampling them.
  const fence = { worker: jobs.WORKER_ID, attempt: row.job_attempts };
  let fenced = false;
  const loseFence = (where) => {
    if (fenced) return;
    fenced = true;
    console.error(
      `[worker] LOST THE FENCE on job ${row.id} at ${where}: another worker has ` +
      "claimed it. Abandoning quietly -- it now owns the reply."
    );
  };

  let snippet = null, activity = null, turn = 0;
  const beat = setInterval(() => {
    jobs.heartbeat(adminPool, row.id, { snippet, activity, turn }, fence)
      .then((ok) => { if (!ok) loseFence("heartbeat"); })
      .catch((e) => console.warn(`heartbeat failed for ${row.id}: ${e.message}`));
  }, jobs.HEARTBEAT_MS);

  try {
    console.log(`[worker] job ${row.id} attempt ${row.job_attempts}: ` +
      `${String(row.question || "").slice(0, 60)}`);
    const fr = await runFeatureEpic({
      request: payload.request || row.question,
      attachments: payload.attachments || [],
      // Downloaded when the request came in; the URL above may be dead by now.
      audioStash: payload.audioStash || null,
      workDir,
      answer,
      systemPrompt,
      model: payload.model || FEATURE_MODEL,
      maxTurns: payload.maxTurns || MAX_TURNS_FEATURE,
      // A re-claimed job already has a plan and a shipped list, so picking it
      // back up is the same machinery as recovering one -- nothing extra.
      resume: state && Array.isArray(state.plan) ? state : null,
      persist: async (s) => {
        if (!(await jobs.heartbeat(adminPool, row.id, s, fence))) loseFence("checkpoint");
      },
      onProgress: (s) => { snippet = s; },
      onActivity: (what, t) => { activity = what; if (t) turn = t; },
      onIncrement: async (inc) => {
        // The preview lives in the work dir, which the next increment's clone
        // wipes -- so copy it somewhere the gateway can still find it when it
        // gets round to posting.
        let keep = null;
        try {
          if (inc.preview && fs.existsSync(inc.preview)) {
            keep = path.join(WORK_ROOT, `post-${row.id}-${inc.index}.png`);
            fs.copyFileSync(inc.preview, keep);
          }
        } catch (e) { console.warn(`could not keep preview: ${e.message}`); }
        await jobs.pushOutbox(adminPool, {
          logId: row.id, channelId: row.discord_channel_id,
          replyTo: row.discord_message_id, kind: "increment",
          text: `-# step ${inc.index} of ${inc.of} — **${inc.title}** is live\n\n${inc.text || ""}`,
          filePath: keep,
        });
      },
    });

    let keep = null;
    try {
      const shot = path.join(workDir, "preview.png");
      if (fs.existsSync(shot)) {
        keep = path.join(WORK_ROOT, `post-${row.id}-final.png`);
        fs.copyFileSync(shot, keep);
      }
    } catch (e) { console.warn(`could not keep final preview: ${e.message}`); }

    if (fenced) {
      // Whoever holds the job now will post its own answer. Two finals in the
      // channel is worse than one late one.
      console.warn(`[worker] job ${row.id} finished but we no longer own it; not posting.`);
      return;
    }
    // Answer recorded, claim released and reply queued together, so there is
    // no window where the job looks unfinished but the answer is already out
    // -- or the reverse.
    const kept = await jobs.finishJob(
      adminPool, row.id, fence,
      {
        answer: fr.text, status: fr.ok ? "success" : "feature_failed",
        turns: fr.turns || 0, input_tokens: fr.inputTokens || 0,
        output_tokens: fr.outputTokens || 0, duration_ms: Date.now() - startedAt,
      },
      {
        channelId: row.discord_channel_id, replyTo: row.discord_message_id,
        kind: "final",
        text: fr.ok ? `${fr.text}\n\n${fr.url}` : fr.text,
        filePath: keep,
      }
    );
    if (!kept) { loseFence("finish"); return; }
    console.log(`[worker] job ${row.id} done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } finally {
    clearInterval(beat);
  }
}

async function runWorkerLoop() {
  for (;;) {
    // Once we are shutting down, finish what is in hand and take nothing new.
    // Claiming during a drain would start a job with seconds left to live.
    if (shuttingDown) { await sleep(1000); continue; }
    let row = null;
    try {
      row = await jobs.claimNext(adminPool);
    } catch (err) {
      console.error(`[worker] claim failed: ${err.message}`);
      await sleep(WORKER_POLL_MS);
      continue;
    }
    if (!row) { await sleep(WORKER_POLL_MS); continue; }

    workerJobs.add(row.id);
    try {
      await runQueuedJob(row);
    } catch (err) {
      // runFeatureEpic already promises never to reject, so this is the
      // outbox or the database. Either way the asker is owed a sentence.
      console.error(`[worker] job ${row.id} threw: ${(err && err.stack) || err}`);
      try {
        await jobs.pushOutbox(adminPool, {
          logId: row.id, channelId: row.discord_channel_id,
          replyTo: row.discord_message_id, kind: "final",
          text: `That job hit an unexpected error and stopped: ${err.message}`,
        });
      } catch (e) { console.error(`[worker] could not even report: ${e.message}`); }
      await finalizeQuery(row.id, { error: String(err.message), duration_ms: 0 });
    } finally {
      // Fenced or not, complete() is predicated on ownership, so this can only
      // ever close a job this worker still holds.
      try { await jobs.complete(adminPool, row.id, fenceOf(row)); }
      catch (e) { console.error(`[worker] could not release ${row.id}: ${e.message}`); }
      // Nobody else will. The gateway used to delete this in its own finally,
      // but a handed-off job returns from that handler before the work has
      // even started -- so without this the clone sits on the volume forever,
      // one full checkout of the game per request. Safe here: the previews
      // worth keeping were copied out to post-*.png above.
      try {
        const wd = path.join(WORK_ROOT, String(row.discord_message_id));
        fs.rmSync(wd, { recursive: true, force: true });
        // runFeature only retires a stash it created itself, and this one came
        // from the gateway -- so nobody else is going to remove it.
        fs.rmSync(wd + ".audio", { force: true });
      } catch (e) {
        console.warn(`[worker] could not clean work dir for ${row.id}: ${e.message}`);
      }
      workerJobs.delete(row.id);
    }
  }
}

/* ── gateway ──────────────────────────────────────────────────────────────
 * Everything the worker wanted said, said. Two jobs: post what is in the
 * outbox, and keep each running job's placeholder showing live progress.
 */
async function postOutboxRow(r) {
  const ch = await discord.channels.fetch(r.channel_id);
  const files = [];
  if (r.file_path && fs.existsSync(r.file_path)) {
    files.push({ attachment: r.file_path, name: path.basename(r.file_path) });
  }
  const target = r.reply_to
    ? await ch.messages.fetch(r.reply_to).catch(() => null)
    : null;
  if (target) await postChunked(target, r.text || "", files);
  else await ch.send({ content: String(r.text || "").slice(0, DISCORD_MAX_LEN), files });

  if (r.kind === "final" && r.log_id) {
    // Nothing is watching this job any more.
    liveJobs.delete(Number(r.log_id));
    // The placeholder has done its job; the answer is above it now.
    try {
      const { rows } = await adminPool.query(
        "SELECT job_payload FROM data_boy_logs WHERE id = $1", [r.log_id]
      );
      const pid = rows[0] && rows[0].job_payload && rows[0].job_payload.placeholder_id;
      if (pid) {
        livePlaceholderIds.delete(pid);
        const ph = await ch.messages.fetch(pid).catch(() => null);
        if (ph) await ph.delete().catch(() => {});
      }
    } catch (e) { console.warn(`placeholder cleanup for ${r.log_id}: ${e.message}`); }
  }
  // The kept copy exists only to survive the hop between processes.
  if (r.file_path && r.file_path.startsWith(path.join(WORK_ROOT, "post-"))) {
    try { fs.rmSync(r.file_path, { force: true }); } catch {}
  }
}

async function refreshQueuedPlaceholders() {
  const rows = await jobs.liveRows(adminPool);
  for (const r of rows) {
    const payload = r.job_payload || {};
    const st = r.job_state || {};
    if (!payload.placeholder_id || !r.discord_channel_id) continue;
    const secs = Math.round((Date.now() - (payload.queued_at || Date.now())) / 1000);
    const clock = secs < 90 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
    const lines = [];
    if (st.snippet) {
      lines.push(`_(still thinking… ${clock})_`);
      lines.push("> " + String(st.snippet).replace(/\n+/g, " ").slice(0, 300));
    } else {
      lines.push(`Data Boy is still thinking… (${clock}) 🧠`);
    }
    if (Array.isArray(st.plan) && st.plan.length > 1) {
      lines.push(`-# step ${Math.min((st.step || 0) + 1, st.plan.length)} of ${st.plan.length}`);
    }
    if (st.activity) lines.push(`-# ${st.activity}${st.turn ? ` · turn ${st.turn}` : ""}`);
    // Keep !status honest for jobs this process is not running.
    jobNote(r.id, {
      user: r.discord_user || "?", question: r.question,
      started: payload.queued_at || Date.now(),
      note: st.activity || st.snippet || "working",
      turn: st.turn,
    });
    try {
      const ch = await discord.channels.fetch(r.discord_channel_id);
      const ph = await ch.messages.fetch(payload.placeholder_id).catch(() => null);
      if (ph) await ph.edit(lines.join("\n"));
    } catch (e) { /* a deleted placeholder is not an error worth logging every 5s */ }
  }
  // Jobs nobody can finish. Say so rather than leaving them queued forever.
  for (const dead of await jobs.reapExhausted(adminPool)) {
    liveJobs.delete(dead.id);
    // Never picked up is a different problem from tried and failed, and the
    // person waiting should be told which.
    const neverRan = Number(dead.attempts) === 0;
    try {
      await jobs.pushOutbox(adminPool, {
        logId: dead.id, channelId: dead.discord_channel_id,
        replyTo: dead.discord_message_id, kind: "final",
        text: neverRan
          ? "That one sat in the queue and nothing ever picked it up — most " +
            "likely no worker is running. Nothing was changed; worth a look at " +
            "the containers before asking again."
          : "I tried that one a few times and it failed every time, so I've " +
            "stopped retrying it. Worth a look at the logs before asking again.",
      });
      await finalizeQuery(dead.id, {
        error: neverRan ? "job was never claimed by a worker" : "job exhausted its attempts",
        duration_ms: 0,
      });
    } catch (e) { console.error(`reaping ${dead.id}: ${e.message}`); }
  }
}

function startGatewayPolling() {
  let busy = false;
  setInterval(async () => {
    if (busy) return;           // a slow post must not stack up behind itself
    busy = true;
    try {
      await jobs.drainOutbox(adminPool, postOutboxRow);
      await refreshQueuedPlaceholders();
      // Cheap, and only actually deletes anything once a week's worth exists.
      if (Math.random() < 0.01) await jobs.pruneOutbox(adminPool);
    } catch (err) {
      console.error(`gateway poll failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }, GATEWAY_POLL_MS);
}

discord.once("ready", async () => {
  console.log(`Logged in as ${discord.user.tag}.`);
  await recoverInterruptedJobs();
  // Deliberately not behind SPLIT_ENABLED. Turning the flag off is how a
  // rollback happens, and jobs already queued still finish and still write
  // their answers -- if nothing drains the outbox those answers are simply
  // never delivered. With an empty queue this costs one cheap query per tick.
  startGatewayPolling();
  // Run cleanup periodically so stranded placeholders self-clean.
  setInterval(() => { cleanupStalePlaceholders().catch(() => {}); }, 90 * 1000);
  await cleanupStalePlaceholders();
  // Warm the repo index. Routing recognises bare repo names ("how does lumen
  // render") via KNOWN_REPO_NAMES, which fetchRepoIndex populates -- without
  // this, the very first code question would have to rely on keywords alone.
  // Non-fatal: if there is no GH_TOKEN, code mode simply stays keyword-only.
  if (process.env.GH_TOKEN) {
    try {
      await fetchRepoIndex();
      console.log(`GitHub: indexed ${KNOWN_REPO_NAMES.length} repos for ${GITHUB_OWNER}.`);
    } catch (err) {
      console.error("GitHub: repo index warm-up failed:", err.message);
    }
  } else {
    console.log("GitHub: GH_TOKEN not set -- code mode will be keyword-routed only.");
  }
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
  await jobs.ensureSchema(adminPool);

  if (JOB_ROLE === "worker") {
    // No Discord connection: this process exists to survive the one that has
    // it being restarted. Anything it wants said goes through the outbox.
    console.log(`Worker ${jobs.WORKER_ID} up, polling every ${WORKER_POLL_MS}ms.`);
    await runWorkerLoop();     // never returns
    return;
  }

  if (SPLIT_ENABLED) console.log("Feature jobs go to the queue (TOASTER_SPLIT=1).");
  await discord.login(process.env.DISCORD_TOKEN_DATA_BOY);
})().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
