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
const MAX_TURNS = 30;
const MODEL = "claude-sonnet-4-6";

const PROMPT_PATH = path.join(__dirname, "data-boy-prompt.md");
const WORK_DIR = "/tmp/data-boy-work";

// Per-user in-flight question lock (Discord user id → boolean).
const inFlight = new Set();

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

function stripMention(content, botUserId) {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .trim();
}

async function postChunked(channel, text, placeholder) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    await placeholder.edit("(Data Boy returned no answer.)");
    return;
  }
  if (trimmed.length <= DISCORD_MAX_LEN) {
    await placeholder.edit(trimmed);
    return;
  }
  const parts = [];
  for (let i = 0; i < trimmed.length; i += REPLY_CHUNK_LEN) {
    parts.push(trimmed.slice(i, i + REPLY_CHUNK_LEN));
  }
  for (let i = 0; i < parts.length; i++) {
    const labeled = `${parts[i]}\n*(part ${i + 1}/${parts.length})*`;
    if (i === 0) {
      await placeholder.edit(labeled);
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

// ── Startup context ────────────────────────────────────────────────────────
async function buildSystemPrompt() {
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
    "### Channel ID → name",
    "",
    ...channelLines,
  ].join("\n");

  return template + context;
}

// ── The core: run one question through the SDK ─────────────────────────────
async function answer(question, systemPrompt) {
  // Fresh scratch dir per question.
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  let lastAssistantText = "";
  let resultText = null;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const msg of sdkQuery({
    prompt: question,
    options: {
      model: MODEL,
      maxTurns: MAX_TURNS,
      cwd: WORK_DIR,
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
      if (textBlocks) lastAssistantText = textBlocks;
    } else if (msg.type === "result") {
      resultText = msg.result || null;
      turns = msg.num_turns ?? turns;
      inputTokens = msg.usage?.input_tokens ?? inputTokens;
      outputTokens = msg.usage?.output_tokens ?? outputTokens;
    }
  }

  return {
    text: resultText || lastAssistantText || "",
    turns,
    inputTokens,
    outputTokens,
  };
}

async function logQuery(row) {
  try {
    await adminPool.query(
      `INSERT INTO data_boy_logs
        (discord_user, question, answer, turns, input_tokens, output_tokens, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.discord_user,
        row.question,
        row.answer ?? null,
        row.turns ?? null,
        row.input_tokens ?? null,
        row.output_tokens ?? null,
        row.error ?? null,
        row.duration_ms ?? null,
      ]
    );
  } catch (err) {
    console.error("Failed to log query:", err.message);
  }
}

// ── Discord event handling ─────────────────────────────────────────────────
discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.mentions.has(discord.user)) return;

  const question = stripMention(message.content, discord.user.id);
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

  inFlight.add(userId);
  const placeholder = await message.reply("Data Boy is thinking…");
  const startedAt = Date.now();

  try {
    const systemPrompt = await buildSystemPrompt();
    const result = await answer(question, systemPrompt);
    await postChunked(message.channel, result.text, placeholder);
    const duration = Date.now() - startedAt;
    console.log(
      `Answered "${question.slice(0, 60)}" in ${duration}ms (${result.turns} turns, ${result.inputTokens}+${result.outputTokens} tokens)`
    );
    await logQuery({
      discord_user: userTag,
      question,
      answer: result.text,
      turns: result.turns,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      duration_ms: duration,
    });
  } catch (err) {
    console.error("Error in answer():", err);
    await placeholder.edit(`Data Boy hit an error: \`${err.message}\``);
    await logQuery({
      discord_user: userTag,
      question,
      error: err.message,
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    inFlight.delete(userId);
  }
});

discord.once("ready", () => {
  console.log(`Logged in as ${discord.user.tag}.`);
});

(async () => {
  if (!process.env.DISCORD_TOKEN_DATA_BOY) {
    console.error("DISCORD_TOKEN_DATA_BOY is not set; refusing to start.");
    process.exit(1);
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_CODE_AUTH_TOKEN) {
    console.error(
      "CLAUDE_CODE_OAUTH_TOKEN (or CLAUDE_CODE_AUTH_TOKEN) is not set; refusing to start."
    );
    process.exit(1);
  }
  await waitForDb(adminPool, "admin");
  await waitForDb(readonlyPool, "readonly");
  fs.mkdirSync(WORK_DIR, { recursive: true });
  await discord.login(process.env.DISCORD_TOKEN_DATA_BOY);
})().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
