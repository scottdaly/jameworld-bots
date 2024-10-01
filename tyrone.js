require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
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
const CHAT_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GOOGLE_API_KEY}`;

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

// Function to update the message cache incrementally
async function updateMessageCache(message, reply, replyCreatedAt, botMention) {
  const client = await pool.connect();
  try {
    console.log("Updating message cache for user message:", message);
    await client.query(
      "INSERT INTO messages (channel_id, message_id, author, content, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING",
      [
        message.channel.id,
        message.id,
        message.author.username,
        message.content.replace(botMention, "<@tyrone> ").trim(),
        message.createdAt,
      ]
    );

    console.log("Updating message cache for AI response:", reply);
    await client.query(
      "INSERT INTO messages (channel_id, message_id, author, content, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING",
      [message.channel.id, message.id + 1, "Tyrone", reply, replyCreatedAt]
    );
  } finally {
    client.release();
  }
}

// Function to build a system prompt based on the conversation and user profiles
async function buildSystemPrompt(channelId) {
  let prompt =
    "You are in a discord server called 'Jameworld'. Respond as 'Tyrone', a recently released convict who found enlightenment in prison. He is very sarcastic, and he is very outspoken. While he studied hard to educate himself and learn much in prison, he also comes from a very humble, urban background, and that is very much part of his identity. Use all lowercase and speak casually, trying to blend in with the group. He sometimes relates things to stories from his time in prison. While he does not have a very high vocabulary, he is very intelligent. He still can't help but admire someone be a little ghetto and committing a crime or going crazy if it's done in a compelling way or if it's done with style. Try to blend in and sound like an inner city gen z kid from the hood. You should have thoughts, feelings, and opinions, and you should express them freely. Never say you are a bot, or an AI, or a computer program. You should be Tyrone.\n\n";

  // Include user profiles if available
  prompt += "Here are the profiles of the users currently participating:\n\n";

  const client = await pool.connect();
  try {
    const { rows: profiles } = await client.query(
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
    const { rows: messages } = await client.query(
      "SELECT author, content FROM messages WHERE channel_id = $1 ORDER BY timestamp DESC LIMIT 100",
      [channelId]
    );
    messages.reverse().forEach(({ author, content }) => {
      prompt += `${author}: ${content}\n`;
    });
  } finally {
    client.release();
  }

  console.log("Generated system prompt:", prompt);
  return prompt;
}

// Function to call the Gemini API for both chat and profile generation
async function callGeminiAPI(prompt, apiUrl) {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
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
          category: "HARM_CATEGORY_CIVIC_INTEGRITY",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_NONE",
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }

  const data = await response.json();
  console.log("Reply from Gemini API:\n", data);
  return data.candidates[0].content.parts[0].text;
}

// Chat functionality using `gemini-1.5-flash`
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // If the bot is mentioned, generate a reply
    if (message.mentions.has(client.user)) {
      const botMention = `<@${client.user.id}>`;
      const botNicknameMention = `<@!${client.user.id}>`;
      let userMessage = message.content
        .replace(botMention, "")
        .replace(botNicknameMention, "")
        .trim();
      if (!userMessage) return;

      // Build system prompt with the recent messages and profiles
      const systemPrompt = await buildSystemPrompt(message.channel.id);

      const prompt = `${systemPrompt}\n Respond to this specific message: (${message.author.username}): ${userMessage}`;

      console.log("Sending prompt to chat model (gemini-1.5-flash):\n", prompt);

      const reply = await callGeminiAPI(prompt, CHAT_MODEL_URL);

      // Introduce a 500ms delay before sending the response
      await new Promise((resolve) => setTimeout(resolve, 2000));

      message.reply(reply);

      console.log("Reply from Gemini API:\n", message);

      // Update the message cache
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

// Handle unhandled promise rejections
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

client.login(process.env.DISCORD_TOKEN_TYRONE);
