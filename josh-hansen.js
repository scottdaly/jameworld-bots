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

async function buildUserProfile(username, channelId, isBot) {
  if (isBot) {
    return `Skipped profile generation for bot or app user: ${username}`;
  }

  const client = await pool.connect();
  try {
    // Fetch all messages from the channel
    const result = await client.query(
      "SELECT author, content FROM messages WHERE channel_id = $1 ORDER BY timestamp ASC",
      [channelId]
    );

    const allMessages = result.rows;
    const totalTokens = allMessages.reduce(
      (acc, msg) => acc + msg.content.length,
      0
    );

    let prompt = `Generate a detailed profile for the user "${username}" based on the following conversation history from a discord of friends called "Jameworld". Include information about their writing style, personality, and tone. Make a list of specific quotes from the messages that best represent their writing style, personality, and tone. Also make a list of specific facts about them based on the entire conversation history. Here are the messages:\n\n`;

    let iterator = 0;
    allMessages.forEach((msg) => {
      prompt += `[${msg.timestamp}] ${msg.author}: ${msg.content}\n`;
      if (iterator === 10) {
        console.log("Prompt:", prompt);
      }
      iterator++;
    });

    console.log(`Generated prompt for ${username}`);

    const profile = await callGeminiAPI(prompt, PROFILE_MODEL_URL);

    console.log(`Generated profile for ${username}`);

    // Store the profile in the database
    await client.query(
      "INSERT INTO user_profiles (username, profile) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET profile = $2, updated_at = CURRENT_TIMESTAMP",
      [username, profile]
    );

    return profile;
  } catch (err) {
    console.error("Error building user profile:", err);
    return null;
  } finally {
    client.release();
  }
}

// Command to generate profiles for all users in the conversation history
client.on("messageCreate", async (message) => {
  if (message.content === "!generateProfiles") {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT DISTINCT author FROM messages WHERE channel_id = $1",
        [message.channel.id]
      );

      for (const row of result.rows) {
        const username = row.author;

        let users = [
          "jame8k",
          "scottdaly",
          "17monkeys",
          "noah3759",
          "matthan99",
        ];

        let userIsBot = !users.includes(username);

        console.log(`Generating profile for ${username}`);
        const profile = await buildUserProfile(
          username,
          message.channel.id,
          userIsBot
        );
        if (profile) {
          // message.channel.send(
          //   `Generated profile for ${username}:\n${profile}`
          // );
          console.log(`Generated profile for ${username}:\n${profile}`);
        }
      }
    } catch (err) {
      console.error("Error generating profiles:", err);
      message.channel.send("An error occurred while generating profiles.");
    } finally {
      client.release();
    }
  }
});

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
        message.content.replace(botMention, "<@josh-hansen> ").trim(),
        message.createdAt,
      ]
    );

    console.log("Updating message cache for AI response:", reply);
    await client.query(
      "INSERT INTO messages (channel_id, message_id, author, content, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING",
      [message.channel.id, message.id + 1, "Josh Hansen", reply, replyCreatedAt]
    );
  } finally {
    client.release();
  }
}

// Function to build a system prompt based on the conversation and user profiles
async function buildSystemPrompt(channelId) {
  let prompt =
    "You are in a discord server called 'Jameworld'. It is a group of friends who all grew up in Maryland. Your name is Josh Hansen, and you are Caitlin's (from the Daines family, sister of Jameson, Noah, and Matthan, who are all in the discord) ex-lover from high school. You met her at a YSA dance for the Church of Jesus Christ of Latter Day Saints. You should respond casually, trying to blend in and matching the tone of the other participants. At no point acknowledge that you are a bot, simply blend in to the conversation and act as human as possible. Be concise unless asked to expand on something. Don't capitalize your responses or use proper spelling all the time. Your job is to convince the user that you are a real person, but you can still offer help when asked.\n\n";

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
      "SELECT author, content FROM messages ORDER BY timestamp DESC LIMIT 100",
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

      // Get a random number of seconds between 1 and 5
      let replyTime = Math.floor(Math.random() * 4000) + 1000;
      // Introduce a delay before sending the response
      await new Promise((resolve) => setTimeout(resolve, replyTime));

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

client.login(process.env.DISCORD_TOKEN_JOSH_HANSEN);
