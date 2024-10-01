\c jameworld;

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT UNIQUE NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
    username TEXT PRIMARY KEY,
    profile TEXT
);