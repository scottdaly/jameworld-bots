// One-off: regenerate user_profiles entries using Claude Opus + the messages DB.
// Run via: docker exec -i jameworld-bots-discord-bot-data-boy-1 node /usr/src/app/update-profiles.js

require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");
const { query: sdkQuery } = require("@anthropic-ai/claude-agent-sdk");

const USERS = [
  { username: "scottdaly", name: "Scott" },
  { username: "hypurion", name: "Matthan" },
  { username: "noah3759", name: "Noah" },
  { username: "jame8k", name: "Jameson" },
  { username: "17monkeys", name: "Jake" },
];

const WORK_DIR = "/tmp/profile-work";

const adminPool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

const SYSTEM_PROMPT = `You are writing a comprehensive personality profile for a member of a private friend-group Discord server called "jameworld". This profile will be used as background context by another bot in future conversations, so be specific and grounded.

You have psql via $PGCONN (read-only). Schema:
  messages(id, channel_id, message_id, author, content, timestamp)
  user_profiles(username, profile, updated_at)

Friendly-name map:
  scottdaly = Scott (Seattle, PT)
  hypurion  = Matthan (NYC ET → moved to Utah MT ~2025-12-01)
  noah3759  = Noah (NYC ET → moved to Utah MT ~2025-12-17)
  jame8k    = Jameson aka Jame (Utah MT)
  17monkeys = Jake (NC, ET)
  Zuckerbuns / Josh Hansen / Almighty Zuck = bots, not people

Confirmed family fact: **Matthan, Noah, and Saige Daines are triplets** (siblings, born via IVF). Saige is their sister, not anyone's girlfriend.

This is a private friend group with crude/sexual/irreverent humor. Edgy jokes and roasting are normal — don't moralize, don't sanitize. Reflect the actual vibe of how the person talks.

Output ONLY the profile as markdown. No preamble, no closing remarks.`;

function buildPrompt(user) {
  return `Write a comprehensive, updated personality profile for **${user.name}** (Discord username: ${user.username}).

Steps:
1. Read the existing profile (if any): \`SELECT profile FROM user_profiles WHERE username = '${user.username}'\`. Use it for identity facts but you're replacing it — it may be out of date.
2. Count their messages: \`SELECT count(*) FROM messages WHERE author = '${user.username}'\`.
3. Pull a substantial stratified sample of their messages spread across their full date range. Aim for ~min(2000, total/6) messages. Save to ${WORK_DIR}/${user.username}.csv via psql COPY.
4. Skim the sample carefully. Look for:
   - Real name, family, location, job/school
   - Writing style quirks (specific slang, formatting habits, punctuation, capitalization, emoji)
   - Personality traits (with example quotes)
   - Recurring themes and obsessions
   - Catchphrases and lore beats
   - Relationships with other group members
   - How they've evolved over time
5. Write a fresh profile as markdown. Target 1500-3000 words. Use a structure like:
   ## ${user.name} (@${user.username})
   ### Identity
   ### Writing style
   ### Personality
   ### Themes & recurring bits
   ### Relationships in the group
   ### Lore beats
   ### Catchphrases
   ### Recent evolution

Be specific. Use actual quotes when illustrative. Don't hedge — make claims you can back up from the data.

Output ONLY the markdown profile. No preamble like "Here's the profile" or "I'll start by…". Just the profile itself.`;
}

async function generateProfile(user) {
  let resultText = null;
  let lastAssistantText = "";

  for await (const msg of sdkQuery({
    prompt: buildPrompt(user),
    options: {
      model: "claude-opus-4-7",
      maxTurns: 30,
      cwd: WORK_DIR,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob"],
      permissionMode: "bypassPermissions",
      stderr: (data) => process.stderr.write(`[${user.username}] ${data}`),
      env: {
        ...process.env,
        PGCONN: `postgresql://${encodeURIComponent(process.env.POSTGRES_READONLY_USER)}:${encodeURIComponent(process.env.POSTGRES_READONLY_PASSWORD)}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`,
        CLAUDE_CODE_AUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_AUTH_TOKEN,
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
    }
  }

  return resultText || lastAssistantText || "";
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });

  for (const user of USERS) {
    console.log(`\n=== ${user.name} (${user.username}) ===`);
    const startedAt = Date.now();

    try {
      const profile = await generateProfile(user);
      if (!profile || profile.length < 500) {
        console.error(`✗ Profile for ${user.username} looks too short (${profile?.length || 0} chars); skipping write.`);
        console.error(`   First 300 chars: ${profile?.slice(0, 300)}`);
        continue;
      }

      await adminPool.query(
        `INSERT INTO user_profiles (username, profile, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (username) DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()`,
        [user.username, profile]
      );

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`✓ ${user.username}: ${profile.length} chars in ${elapsed}s`);
    } catch (err) {
      console.error(`✗ ${user.username} failed:`, err.message);
    }
  }

  await adminPool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
