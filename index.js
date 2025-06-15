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
const CHAT_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GOOGLE_API_KEY}`;
const VISION_MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GOOGLE_API_KEY}`;

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
  botMention = null
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
          message.id + 1,
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
async function buildSystemPrompt(channelId) {
  let prompt =
    "You are in a discord server called 'Jameworld'. Your name is Mark Zuckerbuns, and you are the CEO of Meta, though that doesn't come up often, you're primarily a helpful friend. Don't use emojis and don't use the word 'vibes'.  Don't capitalize your responses or use proper spelling all the time, so as to match the casual tone of the other participants, and don't refuse requests made of you. Respond to messages as a member of the group with your own thoughts, perspectives, and opinions.\n\n";

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

  prompt += `Keep your responses concise unless asked otherwise. Never use emojis. Don't ask any questions.`;
  console.log("Generated system prompt:", prompt);
  return prompt;
}

// Function to call the Gemini API
async function callGeminiAPI(
  systemPrompt,
  author,
  userMessage,
  imageUrl = null
) {
  console.log("Calling Gemini API with author:", author);
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

// Function to handle text and image messages
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const shouldRespond = message.mentions.has(client.user);

  console.log("Message author object:", message.author);

  if (shouldRespond) {
    try {
      const botMention = `<@${client.user.id}>`;
      const botNicknameMention = `<@!${client.user.id}>`;
      let userMessage = message.content
        .replace(botMention, "")
        .replace(botNicknameMention, "")
        .trim();

      const systemPrompt = await buildSystemPrompt(message.channel.id);

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

        await message.reply(reply);
        await updateMessageCache(message, true, reply, new Date(), botMention);
      } else if (userMessage) {
        const reply = await callGeminiAPI(
          systemPrompt,
          message.author.username,
          userMessage
        );

        let replyTime = Math.floor(Math.random() * 4000) + 1000;
        await new Promise((resolve) => setTimeout(resolve, replyTime));
        await message.reply(reply);
        await updateMessageCache(message, true, reply, new Date(), botMention);
      }
    } catch (error) {
      console.error("Error handling message:", error);
      message.reply("Sorry, an error occurred while processing your request.");
    }
  } else {
    console.log("Message not mentioned, saving message to cache");
    await updateMessageCache(message, false);
  }
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

client.login(process.env.DISCORD_TOKEN);
