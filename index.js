require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { OpenAI } = require("openai"); // Import OpenAI
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

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Make sure to add this to your .env file
});

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
async function updateMessageCache(message) {
  const client = await pool.connect();
  try {
    await client.query(
      "INSERT INTO messages (channel_id, message_id, author, content, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING",
      [
        message.channel.id,
        message.id,
        message.author.username,
        message.content,
        message.createdAt,
      ]
    );
  } finally {
    client.release();
  }
}

// Function to build a system prompt based on the conversation and user profiles
async function buildSystemPrompt(channelId) {
  let prompt =
    "You are in a discord server called 'Jameworld'. It is a group of friends who all grew up in Columbia, Maryland. Your name is G. Don't use emojis. Be friendly and respond casually, matching the tone of the other participants, but also be helpful and informative when asked. Don't capitalize your responses or use proper spelling all the time, so as to match the casual tone of the other participants.\n\n";

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

  prompt += `Keep your responses concise unless asked otherwise. Never use emojis.`;
  console.log("Generated system prompt:", prompt);
  return prompt;
}

// Function to call the OpenAI API for both chat and profile generation
async function callOpenAIAPI(
  systemPrompt,
  userMessage,
  isProfileGeneration = false
) {
  const model = isProfileGeneration ? "gpt-4o" : "gpt-4o-mini";
  const response = await openai.chat.completions.create({
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${userMessage}` },
    ],
    max_tokens: 4000,
  });

  console.log("OpenAI API response:", response);
  return response.choices[0].message.content;
}

// Update the buildUserProfile function
async function buildUserProfile(username, isBot) {
  if (isBot) {
    return `Skipped profile generation for bot or app user: ${username}`;
  }

  const client = await pool.connect();
  try {
    const { rows: messages } = await client.query(
      "SELECT content FROM messages WHERE author = $1",
      [username]
    );

    let prompt = `Generate a detailed profile for the user "${username}" based on their entire conversation history. Include information about their writing style, personality, and tone. Make a list of specific quotes from the messages that best represent their writing style, personality, and tone. Also make a list of specific facts about them based on the entire conversation history. Here are the messages:\n\n`;

    messages.forEach(({ content }) => {
      prompt += `${username}: ${content}\n`;
    });

    console.log(`Generated prompt for ${username}:`, prompt);

    const profile = await callOpenAIAPI(prompt, true);

    await client.query(
      "INSERT INTO user_profiles (username, profile) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET profile = $2",
      [username, profile]
    );

    return profile;
  } finally {
    client.release();
  }
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
  if (message.content.toLowerCase() === "!generateprofiles") {
    try {
      const client = await pool.connect();
      const { rows: users } = await client.query(
        "SELECT username FROM messages GROUP BY username ORDER BY COUNT(*) DESC LIMIT 10"
      );
      for (const { username } of users) {
        await buildUserProfile(username, false);
      }
      await message.channel.send("All user profiles have been generated.");
    } catch (error) {
      console.error("Error generating user profiles:", error);
      await message.channel.send(
        "An error occurred while generating user profiles."
      );
    } finally {
      client.release();
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

      const systemPrompt = await buildSystemPrompt(message.channel.id);

      console.log("Sending prompt to OpenAI:", systemPrompt);

      const reply = await callOpenAIAPI(systemPrompt, userMessage);

      await new Promise((resolve) => setTimeout(resolve, 2000));

      message.reply(reply);

      await updateMessageCache(message);
    }
  } catch (error) {
    console.error("Error handling message:", error);
    message.reply("Sorry, an error occurred while processing your request.");
  }
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

client.login(process.env.DISCORD_TOKEN);
