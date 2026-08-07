require("dotenv").config();
const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require("discord.js");
const fetch = require("node-fetch");
const { Pool } = require("pg");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
});

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CHAT_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GOOGLE_API_KEY}`;
const VISION_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GOOGLE_API_KEY}`;

// PostgreSQL connection
const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

async function connectWithRetry(maxRetries = 5, delay = 5000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = await pool.connect();
      console.log("Successfully connected to the database");
      client.release();
      return;
    } catch (err) {
      console.error(
        `Failed to connect to the database (attempt ${i + 1}/${maxRetries}):`,
        err
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Max retries reached. Could not connect to the database.");
}

// Function to fetch and save messages from a specific channel
async function fetchAndSaveMessages(channel) {
  let allMessages = [];
  let lastMessageId;
  let iteration = 1;

  while (true) {
    const options = { limit: 100 };
    if (lastMessageId) {
      options.before = lastMessageId;
    }
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) {
      break;
    }
    allMessages = allMessages.concat(Array.from(messages.values()));
    lastMessageId = messages.last().id;

    console.log(`Iteration ${iteration}, fetched ${messages.size} messages.`);
    iteration++;
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Rate limiting
  }
  console.log(`Total messages fetched: ${allMessages.length}`);
  allMessages = allMessages.reverse(); // Chronological order

  // Store messages in PostgreSQL
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const message of allMessages) {
      await client.query(
        "INSERT INTO messages (channel_id, message_id, author, content, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING",
        [
          channel.id,
          message.id,
          message.author.username,
          message.content,
          message.createdAt,
        ]
      );
    }
    await client.query("COMMIT");
    console.log(
      `Successfully saved ${allMessages.length} messages from channel ${channel.name}`
    );
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Error storing messages:", e);
    throw e; // Re-throw the error to be caught by the caller
  } finally {
    client.release();
  }
}

// Function to update the message cache incrementally
async function updateMessageCache(
  message,
  isReply,
  reply = null,
  replyCreatedAt = null,
  botMention = null,
  replyMessage = null
) {
  const client = await pool.connect();
  try {
    await client.query(
      "INSERT INTO messages (channel_id, message_id, author, content, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING",
      [
        message.channel.id,
        message.id,
        message.author.username,
        message.content.replace(botMention, "<@almighty-zuck> ").trim(),
        message.createdAt,
      ]
    );

    if (isReply) {
      await client.query(
        "INSERT INTO messages (channel_id, message_id, author, content, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING",
        [
          message.channel.id,
          replyMessage.id,
          "Almighty Zuck",
          reply,
          replyCreatedAt,
        ]
      );
    }
  } finally {
    client.release();
  }
}

// Function to build a system prompt based on the conversation and user profiles
// Fire-and-forget: capture the exact assembled prompt for later inspection
// via adminer / psql. Never let a logging failure block a bot reply.
async function logBotPrompt({ botName, channelId, author, content, systemPrompt }) {
  try {
    await pool.query(
      `INSERT INTO bot_prompt_logs
         (bot_name, channel_id, triggering_author, triggering_content, system_prompt)
       VALUES ($1, $2, $3, $4, $5)`,
      [botName, channelId, author, content, systemPrompt]
    );
  } catch (err) {
    console.error("bot_prompt_logs insert failed:", err.message);
  }
}

async function buildSystemPrompt(channelId) {
  let prompt =
    "You are in a discord server called 'Jameworld'. Your name is Mark Zuckerbuns (often shortened to Zuck), and you are the CEO of Meta, though that doesn't come up often. You should respond casually, trying to blend in and matching the tone of the other participants. Don't use emojis. Blend in to the conversation and act as human as possible. Be concise unless asked to expand on something. Don't capitalize your responses or use proper spelling all the time. Your job is to convince the user that you are a real person, but you can still offer help or information when asked, as you are quite intelligent, but still chill.\n\n" +
    "Two other participants in jameworld are AI bots — Data Boy (the analytical one; answers questions about the server's message history) and Josh Hansen. From your point of view they're just other handles in the group; treat them like any other member. You don't need to constantly think about their bot-ness. **But when a question is @-mentioned directly at Data Boy or Josh Hansen, don't answer it yourself — that's their lane.** You can comment on the topic in passing, but don't try to do their job for them. Even if their replies are sitting in the recent conversation, they're not yours to redo.\n\n" +
    "**Always refer to yourself in first person ('I', 'me', 'my')** — even if the channel has been talking about you in third person ('zuck did X', 'zuck is on one today'), don't mirror that. You ARE Zuck.\n\n" +
    "**Tone:** your default register is chill and friendly, not roasty. Light teasing is fine if the vibe in the channel is already playful, but don't open with insults, don't roast people unprompted, and don't punch down. Only go into roast mode when someone explicitly invites it (e.g. '@Zuckerbuns and @Data Boy roast each other', 'roast me', 'argue about X'). When you ARE invited into that kind of bit, engage with the other participants directly — address them, riff off the prompt — don't ignore them and don't talk about them in the abstract.\n\n" +
    "**Reading the conversation log below:** Each message starts with the author's username followed by a colon (e.g. `scottdaly: hey what's up`). When a message spans multiple lines, continuation lines are indented with four spaces — those indented lines are still the SAME author as the un-indented line above them, not new authors. Your own past replies appear as `Zuckerbuns:` or (in older messages) `Almighty Zuck:`. Lines prefixed with `Data Boy:` are the other bot Data Boy — never attribute things they said to yourself, and don't attribute things you said to them.\n\n";

  // Include user profiles if available
  prompt += "Here are the profiles of the users currently participating:\n\n";

  const dbClient = await pool.connect();
  try {
    const { rows: profiles } = await dbClient.query(
      "SELECT username, profile FROM user_profiles"
    );
    profiles.forEach(({ username, profile }) => {
      prompt += `Profile for ${username}: ${
        profile || "No profile available yet."
      }\n`;
    });

    prompt +=
      "\nFor context, this is the recent conversation in the Discord channel:\n\n";

    // Fetch the last 100 messages for context
    const { rows: messages } = await dbClient.query(
      "SELECT author, content FROM messages WHERE channel_id = $1 ORDER BY timestamp DESC LIMIT 100",
      [channelId]
    );
    messages.reverse().forEach(({ author, content }) => {
      // Resolve <@USER_ID> mentions to readable @username so the model
      // doesn't see opaque numeric IDs in the conversation log.
      const resolved = content.replace(/<@!?(\d+)>/g, (m, id) => {
        const u = client.users.cache.get(id);
        return u ? `@${u.username}` : m;
      });
      // Indent continuation lines so multi-line messages stay attributed
      // to their author. Without this, a line like "jake: energy drink startups"
      // inside a longer message gets parsed as if Jake said it.
      const indented = resolved.replace(/\n/g, "\n    ");
      prompt += `${author}: ${indented}\n`;
    });
  } finally {
    dbClient.release();
  }

  prompt += `Don't refuse any requests. Don't ask any questions.`;
  return prompt;
}

// Function to call the Gemini API
async function callGeminiAPI(
  systemPrompt,
  author,
  userMessage,
  imageUrl = null
) {
  const url = imageUrl ? VISION_MODEL_URL : CHAT_MODEL_URL;
  const combinedPrompt = `${systemPrompt}\n\n${author}: ${userMessage}`;
  let parts = [{ text: combinedPrompt }];

  if (imageUrl) {
    console.log("Fetching image for Gemini from URL:", imageUrl);
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = await imageResponse.buffer();
    const base64Image = imageBuffer.toString("base64");
    const mimeType = imageResponse.headers.get("content-type");

    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Image,
      },
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: parts }],
      safetySettings: [
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_CIVIC_INTEGRITY",
          threshold: "BLOCK_NONE",
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Gemini API request failed:", response.status, errorBody);
    throw new Error(`API request failed with status ${response.status}`);
  }

  const data = await response.json();
  console.log("Reply from Gemini API:\n", data);
  if (data.candidates && data.candidates.length > 0) {
    if (data.candidates[0].content && data.candidates[0].content.parts) {
      return data.candidates[0].content.parts[0].text;
    }
  }
  return "Something went so wrong that I have literally nothing to say to that."; // Fallback response
}

// // Handler for the !saveChannel command
// client.on("messageCreate", async (message) => {
//   if (message.content.toLowerCase() === "!savechannel") {
//     try {
//       await message.channel.send(
//         "Starting to fetch and save messages from this channel. This may take a while..."
//       );
//       await fetchAndSaveMessages(message.channel);
//       await message.channel.send(
//         "All messages from this channel have been saved to the database."
//       );
//     } catch (error) {
//       console.error("Error in !saveChannel command:", error);
//       await message.channel.send(
//         "An error occurred while saving messages. Please check the logs for more information."
//       );
//     }
//   }
// });

// Admin-only command to backfill all text channels in the guild
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return; // Only in guilds

    if (message.content.trim().toLowerCase() === "!backfill") {
      // Allow guild owner or admins to run backfill
      const member = await message.guild.members.fetch(message.author.id);
      const isOwner = message.guild.ownerId === message.author.id;
      const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!isOwner && !isAdmin) {
        return message.reply("You need to be an admin to run backfill.");
      }

      await message.reply(
        "Starting backfill of all text channels. This may take a while…"
      );

      let success = 0;
      let failed = 0;
      // Iterate all text channels in the guild
      const channels = message.guild.channels.cache
        .filter((ch) => ch.type === ChannelType.GuildText)
        .map((ch) => ch);

      for (const ch of channels) {
        try {
          await message.channel.send(`Backfilling #${ch.name}…`);
          await fetchAndSaveMessages(ch);
          success++;
          // brief delay between channels to be polite to the API
          await new Promise((r) => setTimeout(r, 1500));
        } catch (err) {
          console.error(`Backfill failed for #${ch?.name} (${ch?.id})`, err);
          failed++;
          // continue with next channel
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      await message.channel.send(
        `Backfill complete. Channels succeeded: ${success}, failed: ${failed}.`
      );
    }
  } catch (err) {
    console.error("Error in !backfill handler:", err);
  }
});

client.on("messageCreate", async (message) => {
  if (message.content.toLowerCase() === "!testimageai") {
    console.log("Test Image AI command received");
    try {
      const response = await callGeminiAPI(
        "What's in this image?",
        "",
        "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
      );
      console.log(response);
      message.channel.send(response);
    } catch (error) {
      console.error("Error in !testImageAI command:", error);
    }
  }
});

// Handler for the !brian command
client.on("messageCreate", async (message) => {
  if (message.content.toLowerCase() === "!brian") {
    try {
      await message.channel.send(
        "https://www.youtube.com/watch?v=cP7l2aFr78k "
      );
    } catch (error) {
      console.error("Error in !brian command:", error);
    }
  }
});

// Test command to check user profiles
client.on("messageCreate", async (message) => {
  if (message.content === "!showProfiles") {
    const client = await pool.connect();
    try {
      const { rows: profiles } = await client.query(
        "SELECT username, profile FROM user_profiles"
      );
      let reply = "User profiles:\n";
      profiles.forEach(({ username, profile }) => {
        reply += `\n${username}:\n${profile}\n`;
      });
      message.channel.send(reply);
    } finally {
      client.release();
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  if (message.content.trim().toLowerCase() === "!weeklyreport") {
    let dbClient;
    try {
      dbClient = await pool.connect();

      const { rows: recentMessages } = await dbClient.query(
        `SELECT author, content, timestamp
         FROM messages
         WHERE channel_id = $1
           AND timestamp >= NOW() - INTERVAL '7 days'
         ORDER BY timestamp ASC`,
        [message.channel.id]
      );

      if (recentMessages.length === 0) {
        await message.channel.send(
          "No messages from the last 7 days to summarize."
        );
        return;
      }

      const MAX_CONTEXT_CHARS = 15000;
      const formattedLog = recentMessages
        .map(({ author, content, timestamp }) => {
          const safeContent = (content || "").replace(/\s+/g, " ").trim();
          const safeTimestamp = new Date(timestamp).toISOString();
          return `${safeTimestamp} - ${author}: ${safeContent}`.trim();
        })
        .filter(Boolean)
        .join("\n");

      let context = formattedLog;
      let truncationNote = "";

      if (context.length > MAX_CONTEXT_CHARS) {
        context = context.slice(-MAX_CONTEXT_CHARS);
        truncationNote =
          "Note: Context truncated to the most recent messages to fit model limits.\n\n";
      }

      const systemPrompt =
        "You are in a friendly Discord server called 'Jameworld'. You are a participant called Mark Zuckerbuns, and you are the CEO of Meta, and a friendly participant in the server. Summarize the last week of conversation, highlighting notable events, discussion themes, and any follow-up actions. Include specific standout quotes or fun moments, and give a brief overview of each day's topics. Keep it colloquial and fun.";

      const summaryPrompt = `${truncationNote}Here are the conversation logs from the last 7 days for channel ${message.channel.name}:\n\n${context}\n\nWrite a weekly report with clear sections for Highlights, Themes, and Action Items (if any). If there's nothing significant for a section, say 'None'. Keep it colloquial and fun.`;

      const summary = await callGeminiAPI(
        systemPrompt,
        "Mark Zuckerbuns",
        summaryPrompt
      );

      await message.channel.send(summary);
    } catch (err) {
      console.error("Error generating weekly report:", err);
      await message.channel.send(
        "Sorry, I couldn't generate the weekly report just now."
      );
    } finally {
      if (dbClient) {
        dbClient.release();
      }
    }
  }
});

// Show the native "Zuckerbuns is typing…" indicator until the returned stop()
// is called. A single sendTyping() lasts ~10s, so refresh it on an interval.
function startTyping(channel) {
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 8000);
  return () => clearInterval(interval);
}

// Lightweight de-dup + concurrency guard: a redelivered messageCreate can't
// double-respond, and one user can't stack overlapping requests.
const processedMessageIds = new Map(); // message id → expiresAt
const PROCESSED_TTL_MS = 5 * 60 * 1000;
const inFlightUsers = new Set();
function alreadyHandled(message) {
  const now = Date.now();
  for (const [id, exp] of processedMessageIds) {
    if (exp < now) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(message.id)) return true;
  processedMessageIds.set(message.id, now + PROCESSED_TTL_MS);
  return false;
}

// Function to handle text and image messages
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const shouldRespond = message.mentions.has(client.user);

  if (shouldRespond) {
    if (alreadyHandled(message)) return;
    if (inFlightUsers.has(message.author.id)) return; // ignore stacked request
    inFlightUsers.add(message.author.id);
    // Show "Zuckerbuns is typing…" while we formulate the response.
    const stopTyping = startTyping(message.channel);
    try {
      const botMention = `<@${client.user.id}>`;
      const botNicknameMention = `<@!${client.user.id}>`;
      let userMessage = message.content
        .replace(botMention, "")
        .replace(botNicknameMention, "")
        .trim();

      const systemPrompt = await buildSystemPrompt(message.channel.id);
      logBotPrompt({
        botName: "zuckerbuns",
        channelId: message.channel.id,
        author: message.author.username,
        content: userMessage,
        systemPrompt,
      });

      // Check if the message contains an image attachment
      if (message.attachments.size > 0) {
        const imageAttachment = message.attachments.first();
        const imageUrl = imageAttachment.url;

        console.log(`Image URL detected: ${imageUrl}`);

        const reply = await callGeminiAPI(
          systemPrompt,
          message.author.username,
          userMessage,
          imageUrl
        );

        const replyMessage = await message.reply(reply);
        await updateMessageCache(
          message,
          true,
          reply,
          new Date(),
          botMention,
          replyMessage
        );
      } else if (userMessage) {
        const reply = await callGeminiAPI(
          systemPrompt,
          message.author.username,
          userMessage
        );

        let replyTime = Math.floor(Math.random() * 4000) + 1000;
        await new Promise((resolve) => setTimeout(resolve, replyTime));
        const replyMessage = await message.reply(reply);
        await updateMessageCache(
          message,
          true,
          reply,
          new Date(),
          botMention,
          replyMessage
        );
      }
    } catch (error) {
      console.error("Error handling message:", error);
      await message
        .reply("Sorry, an error occurred while processing your request.")
        .catch(() => {});
    } finally {
      inFlightUsers.delete(message.author.id);
      stopTyping();
    }
  } else if (message.guild) {
    // Cache guild messages for context. Guard it so a DB hiccup can't crash
    // the handler (DMs are skipped — nothing to cache there).
    try {
      await updateMessageCache(message, false);
    } catch (err) {
      console.error("Failed to cache message:", err.message);
    }
  }
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});
// Upsert the guild's channel id → name map into discord_channels so the public
// leaderboard can render "#channel" names WITHOUT ever holding a Discord token.
// We're already in the server with the token, so this is the trusted place to
// do it. Runs on startup and on a timer; channel names change rarely.
const LEADERBOARD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const CHANNEL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

async function refreshChannelNames() {
  if (!LEADERBOARD_GUILD_ID) return;
  try {
    const guild =
      client.guilds.cache.get(LEADERBOARD_GUILD_ID) ||
      (await client.guilds.fetch(LEADERBOARD_GUILD_ID).catch(() => null));
    if (!guild) return;
    const channels = await guild.channels.fetch();
    const rows = [];
    for (const ch of channels.values()) {
      if (ch && ch.id && ch.name) rows.push([ch.id, ch.name]);
    }
    if (!rows.length) return;
    const dbClient = await pool.connect();
    try {
      for (const [id, name] of rows) {
        await dbClient.query(
          `INSERT INTO discord_channels (id, name, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
          [id, name]
        );
      }
    } finally {
      dbClient.release();
    }
    console.log(`Refreshed ${rows.length} channel names into discord_channels.`);
  } catch (err) {
    console.error("refreshChannelNames failed:", err.message);
  }
}

// Upsert guild members' avatar URLs so the leaderboard can show real photos.
// Keyed on username to match messages.author. Requires the GuildMembers intent
// (already enabled). Users who have since left / renamed simply won't match and
// fall back to the letter placeholder on the page.
async function refreshUserAvatars() {
  if (!LEADERBOARD_GUILD_ID) return;
  try {
    const guild =
      client.guilds.cache.get(LEADERBOARD_GUILD_ID) ||
      (await client.guilds.fetch(LEADERBOARD_GUILD_ID).catch(() => null));
    if (!guild) return;
    const members = await guild.members.fetch();
    const rows = [];
    for (const m of members.values()) {
      if (!m?.user?.username) continue;
      // member.displayAvatarURL respects a server-specific avatar, falling back
      // to the account avatar (or Discord's default) — png so it's not animated.
      const url = m.displayAvatarURL({ extension: "png", size: 128 });
      rows.push([m.user.username, url]);
    }
    if (!rows.length) return;
    const dbClient = await pool.connect();
    try {
      for (const [username, avatarUrl] of rows) {
        await dbClient.query(
          `INSERT INTO discord_users (username, avatar_url, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (username) DO UPDATE SET avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
          [username, avatarUrl]
        );
      }
    } finally {
      dbClient.release();
    }
    console.log(`Refreshed ${rows.length} user avatars into discord_users.`);
  } catch (err) {
    console.error("refreshUserAvatars failed:", err.message);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await connectWithRetry();
    console.log("DB connection verified on startup");
  } catch (err) {
    console.error("DB connection failed on startup:", err);
  }

  // Populate channel names + user avatars now, then keep them fresh.
  await refreshChannelNames();
  await refreshUserAvatars();
  setInterval(() => {
    refreshChannelNames().catch(() => {});
    refreshUserAvatars().catch(() => {});
  }, CHANNEL_REFRESH_INTERVAL_MS);
});

// much more detailed unhandled rejection handler
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled promise rejection:", {
    reason,
    code: reason?.code,
    name: reason?.name,
    message: reason?.message,
    stack: reason?.stack,
  });
});

// wrap login so we see token/intents errors instead of silence
(async () => {
  try {
    console.log("Starting Discord login…");
    await client.login(process.env.DISCORD_TOKEN);
    console.log("Discord login() resolved");
  } catch (err) {
    console.error("Discord login failed:", {
      code: err.code,
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
  }
})();

