require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

// Optional Discord channel name cache
const DISCORD_TOKEN = process.env.DISCORD_TOKEN_LEADERBOARD || process.env.DISCORD_TOKEN || '';
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
let CHANNEL_NAME_MAP = {};
let CHANNEL_CACHE_TS = 0;
const CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function loadDiscordChannels() {
  if (!DISCORD_TOKEN || !DISCORD_GUILD_ID) return;
  try {
    const resp = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/channels`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.warn('Failed to fetch Discord channels:', resp.status, t);
      return;
    }
    const data = await resp.json();
    const map = {};
    for (const ch of data) {
      if (ch && ch.id && ch.name) map[ch.id] = `#${ch.name}`;
    }
    CHANNEL_NAME_MAP = map;
    CHANNEL_CACHE_TS = Date.now();
  } catch (e) {
    console.warn('Error fetching Discord channels:', e.message);
  }
}

async function ensureChannelCacheFresh() {
  if (!DISCORD_TOKEN || !DISCORD_GUILD_ID) return; // optional
  if (Date.now() - CHANNEL_CACHE_TS > CHANNEL_CACHE_TTL_MS) {
    await loadDiscordChannels();
  }
}

function channelLabel(id) {
  return CHANNEL_NAME_MAP[id] || `#${id}`;
}

// (Channel names are fetched from Discord API if token+guild are provided.)

// Simple health endpoint
app.get('/health', async (_req, res) => {
  try {
    const client = await pool.connect();
    client.release();
    res.status(200).send('ok');
  } catch (e) {
    res.status(500).send('db error');
  }
});

function normalizeRange(input) {
  switch (String(input || 'all').toLowerCase()) {
    case '24h':
    case '24hr':
    case '24hrs':
    case '1d':
      return '24h';
    case '7d':
    case 'week':
      return '7d';
    case '30d':
    case 'month':
      return '30d';
    default:
      return 'all';
  }
}

function rangeWhereClause(rangeKey) {
  switch (rangeKey) {
    case '24h':
      return "timestamp >= NOW() - INTERVAL '24 hours'";
    case '7d':
      return "timestamp >= NOW() - INTERVAL '7 days'";
    case '30d':
      return "timestamp >= NOW() - INTERVAL '30 days'";
    default:
      return null;
  }
}

function buildWhere(rangeKey, channelId) {
  const parts = [];
  const params = [];
  if (rangeKey && rangeKey !== 'all') parts.push(rangeWhereClause(rangeKey));
  if (channelId) {
    params.push(channelId);
    parts.push(`channel_id = $${params.length}`);
  }
  const sql = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  return { sql, params };
}

// buildWhere and channelLabel defined above

// JSON API for leaderboard data
app.get('/api/leaderboard', async (req, res) => {
  const range = normalizeRange(req.query.range);
  await ensureChannelCacheFresh();
  const channel = req.query.channel ? String(req.query.channel) : '';
  const { sql, params } = buildWhere(range, channel);
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT author, COUNT(*)::int AS message_count
         FROM messages
         ${sql}
         GROUP BY author
         ORDER BY message_count DESC, author ASC
         LIMIT 100`,
        params
      );
      res.json({ data: rows, meta: { range, channel: channel || null } });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// JSON API for channels list (by message count)
app.get('/api/channels', async (req, res) => {
  const range = normalizeRange(req.query.range);
  await ensureChannelCacheFresh();
  const { sql, params } = buildWhere(range, '');
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT channel_id, COUNT(*)::int AS message_count
         FROM messages
         ${sql}
         GROUP BY channel_id
         ORDER BY message_count DESC, channel_id ASC
         LIMIT 200`,
        params
      );
      const data = rows.map(r => ({ id: r.channel_id, name: channelLabel(r.channel_id), message_count: r.message_count }));
      res.json({ data, meta: { range } });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching channels:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// HTML page
app.get('/', async (req, res) => {
  const range = normalizeRange(req.query.range);
  await ensureChannelCacheFresh();
  const channel = req.query.channel ? String(req.query.channel) : '';
  const { sql, params } = buildWhere(range, channel);
  try {
    const client = await pool.connect();
    let rows;
    let totals = { messages: 0 };
    try {
      const result = await client.query(
        `SELECT author, COUNT(*)::int AS message_count
         FROM messages
         ${sql}
         GROUP BY author
         ORDER BY message_count DESC, author ASC
         LIMIT 100`,
        params
      );
      rows = result.rows;
      const totalRes = await client.query(
        `SELECT COUNT(*)::int AS total FROM messages ${sql}`,
        params
      );
      totals.messages = totalRes.rows[0]?.total || 0;
    } finally {
      client.release();
    }

    const maxCount = rows.length ? rows[0].message_count : 0;
    const ranges = [
      { key: '24h', label: '24h' },
      { key: '7d', label: '7 days' },
      { key: '30d', label: '30 days' },
      { key: 'all', label: 'All time' },
    ];

    const tabs = ranges
      .map(r => `<a class="tab ${r.key === range ? 'active' : ''}" href="/?range=${r.key}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}">${r.label}</a>`) 
      .join('');

    // Fetch channels list for the selector (top by count in selected range)
    let channels = [];
    try {
      const client = await pool.connect();
      const { sql: chSql, params: chParams } = buildWhere(range, '');
      const q = await client.query(
        `SELECT channel_id, COUNT(*)::int AS message_count
         FROM messages
         ${chSql}
         GROUP BY channel_id
         ORDER BY message_count DESC, channel_id ASC
         LIMIT 200`,
        chParams
      );
      channels = q.rows.map(r => ({ id: r.channel_id, name: channelLabel(r.channel_id), count: r.message_count }));
      // Ensure selected channel is present in the list
      if (channel && !channels.find(c => c.id === channel)) {
        channels.unshift({ id: channel, name: channelLabel(channel), count: null });
      }
    } catch (e) {
      console.error('Error loading channels for selector:', e);
    }

    const html = `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Jameworld Leaderboard</title>
        <style>
          :root { color-scheme: light dark; --bg:#0a0b0d; --fg:#e9ecf1; --muted:#8a909b; --card:#14161a; --border:#22252b; --acc:#5b8cff; --acc2:#8aa9ff; }
          @media (prefers-color-scheme: light) {
            :root { --bg:#f7f8fb; --fg:#0f1220; --muted:#5b6270; --card:#ffffff; --border:#e7e9ee; --acc:#2f6df6; --acc2:#75a2ff; }
          }
          html, body { height: 100%; }
          body {
            margin: 0; background:
              radial-gradient(1400px 700px at 80% -120px, rgba(95,139,255,0.25), transparent 60%),
              radial-gradient(800px 400px at -120px 80%, rgba(120,180,255,0.18), transparent 60%),
              var(--bg);
            color: var(--fg); font: 15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
          }
          .wrap { max-width: 980px; margin: 0 auto; padding: clamp(16px, 4vw, 28px); }
          .header { display:flex; align-items:center; justify-content:space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
          .brand { display:flex; align-items:center; gap: 10px; }
          .logo { width: 12px; height: 12px; border-radius: 999px; background: linear-gradient(135deg, var(--acc), var(--acc2)); box-shadow: 0 0 0 6px rgba(91,140,255,0.10); }
          h1 { font-size: clamp(20px, 2.2vw, 24px); margin: 0; letter-spacing: 0.2px; }
          .sub { color: var(--muted); margin: 4px 0 18px; }
          .tabs { display:inline-flex; gap:8px; background: color-mix(in srgb, var(--card), transparent 5%); border:1px solid var(--border); padding:6px; border-radius: 12px; backdrop-filter: blur(6px); }
          .tab { text-decoration:none; color: var(--muted); padding:10px 14px; border-radius: 10px; transition: background .2s ease, color .2s ease, box-shadow .2s ease; }
          .tab:hover { color: var(--fg); background: rgba(91,140,255,0.12); }
          .tab.active { color:#fff; background: linear-gradient(135deg, var(--acc), var(--acc2)); box-shadow: 0 2px 10px rgba(47,109,246,0.35); }
          .controls { display:flex; align-items:center; gap: 10px; flex-wrap: wrap; }
          .select { appearance:none; -webkit-appearance:none; -moz-appearance:none; border:1px solid var(--border); background: var(--card); color: var(--fg); padding: 9px 36px 9px 12px; border-radius: 10px; font: inherit; cursor: pointer; position: relative; }
          .select-wrap { position: relative; display:inline-block; }
          .select-wrap:after { content:""; position:absolute; right: 12px; top:50%; width:0; height:0; border-left:5px solid transparent; border-right:5px solid transparent; border-top:6px solid var(--muted); transform: translateY(-25%); pointer-events: none; }
          .card { background: color-mix(in srgb, var(--card), transparent 0%); border:1px solid var(--border); border-radius: 16px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.18), 0 6px 18px rgba(0,0,0,0.10); }
          .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 16px; }
          table { border-collapse: collapse; width: 100%; min-width: 520px; }
          thead th { position: sticky; top:0; background: linear-gradient(0deg, var(--card), var(--card)); z-index:1; font-weight: 600; font-size: 13px; color: var(--muted); }
          th, td { text-align: left; padding: 14px 16px; border-bottom: 1px solid var(--border); }
          tbody tr:hover { background: color-mix(in srgb, var(--acc), transparent 93%); }
          .right { text-align: right; white-space: nowrap; }
          .rank { width: 3ch; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
          .rank.badge-1 { color:#f2c200; font-weight: 700; }
          .rank.badge-2 { color:#c0c6cf; font-weight: 650; }
          .rank.badge-3 { color:#d19a66; font-weight: 650; }
          .user { display:flex; align-items:center; gap: 12px; }
          .avatar { width: 28px; height: 28px; border-radius: 50%; display:grid; place-items:center; font-weight:700; font-size: 12px; color:#fff; background: linear-gradient(135deg, var(--acc), var(--acc2)); box-shadow: inset 0 -10px 20px rgba(0,0,0,0.12); }
          .meter { min-width: 160px; }
          .track { height: 6px; background: color-mix(in srgb, var(--fg), transparent 92%); border-radius: 999px; overflow: hidden; margin-top: 6px; }
          .fill { height: 100%; background: linear-gradient(90deg, var(--acc), var(--acc2)); }
          .footer { color: var(--muted); margin-top: 14px; font-size: 12px; }
          .metrics { color: var(--muted); }
          @media (max-width: 720px) {
            .tab { padding: 10px 12px; }
            .select { padding: 10px 36px 10px 12px; }
            .meter { display:none; }
            th, td { padding: 12px; }
            table { min-width: 420px; }
          }
          @media (max-width: 480px) {
            .wrap { padding: 12px; }
            .brand { gap: 8px; }
            h1 { font-size: 18px; }
            .sub { font-size: 12px; }
            .rank { width: 2.5ch; }
            /* Stack rows for extra-small screens */
            thead { display: none; }
            table { min-width: 0; }
            tbody tr { display: grid; grid-template-columns: 1fr auto; align-items: center; row-gap: 8px; padding: 8px 12px; }
            tbody tr td { border-bottom: none; padding: 4px 0; }
            tbody tr td.rank { grid-column: 2; justify-self: end; }
            tbody tr td.usercell { grid-column: 1 / span 2; padding-top: 0; }
            tbody tr td.right::before { content: 'Messages'; color: var(--muted); font-size: 12px; margin-right: 8px; }
            .card { border-radius: 14px; }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="header">
            <div class="brand">
              <div class="logo"></div>
              <div>
                <h1>Jameworld Leaderboard</h1>
                <div class="sub">Top 100 by messages · <span class="metrics">${rows.length} users · ${Number(totals.messages).toLocaleString()} messages</span></div>
              </div>
            </div>
            <div class="controls">
              <div class="tabs">${tabs}</div>
              <form method="GET" action="/">
                <input type="hidden" name="range" value="${range}" />
                <span class="select-wrap">
                  <select class="select" name="channel" onchange="this.form.submit()">
                    <option value="" ${channel ? '' : 'selected'}>All channels</option>
                    ${channels
                      .map(c => `<option value="${escapeHtml(c.id)}" ${channel===c.id?'selected':''}>${escapeHtml(c.name)}${c.count!==null?` · ${Number(c.count).toLocaleString()}`:''}</option>`)
                      .join('')}
                  </select>
                </span>
              </form>
            </div>
          </div>
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="rank">#</th>
                  <th>User</th>
                  <th class="meter">Share</th>
                  <th class="right">Messages</th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map((r, i) => {
                    const pct = maxCount ? Math.round((r.message_count / maxCount) * 100) : 0;
                    const badge = i === 0 ? 'badge-1' : i === 1 ? 'badge-2' : i === 2 ? 'badge-3' : '';
                    const initials = escapeHtml(String(r.author || '?').slice(0,1).toUpperCase());
                    return `
                      <tr>
                        <td class="rank ${badge}">${i + 1}</td>
                        <td class="usercell"><div class="user"><div class="avatar">${initials}</div><div>${escapeHtml(r.author)}</div></div></td>
                        <td class="meter"><div class="track"><div class="fill" style="width:${pct}%"></div></div></td>
                        <td class="right" data-label="Messages">${Number(r.message_count).toLocaleString()}</td>
                      </tr>
                    `;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="footer">API: <code>/api/leaderboard?range=${range}${channel?`&channel=${encodeURIComponent(channel)}`:''}</code> · Channels: <code>/api/channels?range=${range}</code></div>
        </div>
      </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Error rendering page:', err);
    res.status(500).send('Internal Server Error');
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

app.listen(port, () => {
  console.log(`Leaderboard server listening on port ${port}`);
});
