require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fetch = require("node-fetch");
const { Pool } = require("pg");
const { GoogleAICacheManager } = require("@google/generative-ai/server"); // Import Google AI Cache Manager

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
const CHAT_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_API_KEY}`;
const PROFILE_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GOOGLE_API_KEY}`;

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

// Set up the cache manager
const cacheManager = new GoogleAICacheManager(process.env.GOOGLE_API_KEY);

// Function to create and cache the conversation context
async function createContextCache(channelId) {
  const client = await pool.connect();
  try {
    // Fetch the last 100 messages from the channel for the context
    const result = await client.query(
      "SELECT author, content FROM messages WHERE channel_id = $1 ORDER BY timestamp DESC LIMIT 100",
      [channelId]
    );

    const allMessages = result.rows;
    let context = "You are in a Discord channel called 'Jameworld'.\n\n";

    allMessages.forEach(({ author, content }) => {
      context += `${author}: ${content}\n`;
    });

    console.log("Generated context for cache:", context);

    // Create a cache with a TTL (e.g., 1 hour)
    const ttlSeconds = 3600; // 1 hour
    const cache = await cacheManager.create({
      model: "models/gemini-1.5-flash-001",
      displayName: "discord-conversation-history",
      contents: [
        {
          role: "user",
          parts: [{ text: context }],
        },
      ],
      ttlSeconds,
    });

    console.log("Created cache:", cache);

    return cache;
  } catch (err) {
    console.error("Error creating cache:", err);
    return null;
  } finally {
    client.release();
  }
}

// Function to update the cache if needed
async function updateContextCache(cacheName, channelId) {
  const client = await pool.connect();
  try {
    // Fetch new messages to update the cache
    const result = await client.query(
      "SELECT author, content FROM messages WHERE channel_id = $1 ORDER BY timestamp DESC LIMIT 100",
      [channelId]
    );

    const allMessages = result.rows;
    let context = "You are in a Discord channel called 'Jameworld'.\n\n";

    allMessages.forEach(({ author, content }) => {
      context += `${author}: ${content}\n`;
    });

    console.log("Updated context for cache:", context);

    // Update the cache TTL or contents
    const ttlSeconds = 3600; // Extend TTL to another hour
    await cacheManager.update(cacheName, { cachedContent: { ttlSeconds } });

    console.log("Updated cache TTL");
  } finally {
    client.release();
  }
}

// Function to call the Gemini API with cached context
async function callGeminiWithCache(prompt, cacheName) {
  const response = await fetch(CHAT_MODEL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cache: cacheName, // Use the cache
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }

  const data = await response.json();
  console.log("Reply from Gemini API with cache:\n", data);
  return data.candidates[0].content.parts[0].text;
}

// Chat functionality using Gemini with caching
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    if (message.mentions.has(client.user)) {
      const botMention = `<@${client.user.id}>`;
      const botNicknameMention = `<@!${client.user.id}>`;
      let userMessage = message.content
        .replace(botMention, "")
        .replace(botNicknameMention, "")
        .trim();
      if (!userMessage) return;

      // Build system prompt with the user's message
      const prompt = `(${message.author.username}): ${userMessage}`;

      // Check if a cache exists or create one
      const cacheName = "discord-conversation-history";
      const cacheExists = await cacheManager.list().then((listResult) => {
        if (listResult && Array.isArray(listResult.cachedContents)) {
          return listResult.cachedContents.some(
            (cache) => cache.displayName === cacheName
          );
        }
        return false; // If cachedContents is undefined or not an array, assume cache doesn't exist
      });

      if (!cacheExists) {
        // If no cache exists, create one
        await createContextCache(message.channel.id);
      } else {
        // Update the existing cache
        await updateContextCache(cacheName, message.channel.id);
      }

      // Use the cache in the prompt to reduce token cost
      const reply = await callGeminiWithCache(prompt, cacheName);

      // Introduce a 500ms delay before sending the response
      await new Promise((resolve) => setTimeout(resolve, 2000));

      message.reply(reply);

      // Update message cache in the DB
      await updateMessageCache(message, reply, new Date(), botMention);
    }
  } catch (error) {
    console.error("Error handling message:", error);
    message.reply("Sorry, an error occurred while processing your request.");
  }
});

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  try {
    await connectWithRetry();
    console.log("Bot is ready and connected to the database.");
  } catch (error) {
    console.error("Error during startup:", error);
  }
});

client.login(process.env.DISCORD_TOKEN_JOSH_HANSEN);
