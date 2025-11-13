require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('web'));
app.use(
  session({
    secret: 'kick-bot-session-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
  })
);

let ws;
let currentUserToken = null;
let currentChannel = null;

// === Token storage ===
const TOKENS_FILE = '/tmp/tokens.json';
function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}
let tokens = loadTokens();

// === PKCE util ===
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
function generateState() {
  return crypto.randomBytes(16).toString('base64url');
}

// === Authorize ===
app.get('/auth/kick', (req, res) => {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  req.session.state = state;
  req.session.codeVerifier = verifier;

  const scopes = 'chat:read chat:write user:read';
  const redirect = process.env.REDIRECT_URI;

  const authUrl = `https://id.kick.com/oauth/authorize?client_id=${process.env.KICK_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    redirect
  )}&response_type=code&scope=${encodeURIComponent(
    scopes
  )}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  res.redirect(authUrl);
});

// === Callback ===
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`Error: ${error}`);
  if (!code) return res.send('No code received.');
  if (state !== req.session.state) return res.send('Invalid state.');

  const verifier = req.session.codeVerifier;
  if (!verifier) return res.send('Session expired.');

  try {
    const tokenRes = await axios.post(
      'https://id.kick.com/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.KICK_CLIENT_ID,
        client_secret: process.env.KICK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.REDIRECT_URI,
        code_verifier: verifier
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    currentUserToken = access_token;

    const userRes = await axios.get('https://kick.com/api/v2/user/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const username = userRes.data.username;
    currentChannel = username;

    tokens[username] = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000
    };
    saveTokens(tokens);

    delete req.session.state;
    delete req.session.codeVerifier;

    connectChat(access_token, username);

    res.send(`
      <html>
      <body style="font-family: sans-serif; text-align: center; margin-top: 80px;">
        <h1>✅ Login Berhasil</h1>
        <p>Bot sudah terhubung ke channel <b>@${username}</b></p>
        <a href="/">⬅️ Kembali ke Halaman Utama</a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Token error:', err.response?.data || err.message);
    res.send(`Gagal authorize: ${err.response?.data?.error_description || err.message}`);
  }
});

// === Chat WebSocket ===
async function connectChat(token, username) {
  try {
    const channelRes = await axios.get(`https://kick.com/api/v2/channels/${username}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const chatroomId = channelRes.data.chatroom.id;

    ws = new WebSocket(`wss://ws.kick.com/chat/${chatroomId}`);

    ws.on('open', () => {
      console.log(`✅ Connected to @${username} chat`);
      ws.send(JSON.stringify({ event: 'auth', data: { token } }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'message') {
        const sender = msg.data.sender.username;
        const text = msg.data.message.content.toLowerCase();
        console.log(`[${sender}]: ${text}`);

        if (text.includes('halo')) sendChat(`Halo @${sender}! 👋 Bot aktif.`);
        if (text === '!help') sendChat('Command tersedia: halo, !waktu, !help');
        if (text === '!waktu') sendChat(`🕒 Sekarang: ${new Date().toLocaleString('id-ID')}`);
      }
    });

    ws.on('close', () => {
      console.log('⚠️ Chat disconnected, reconnecting...');
      setTimeout(() => connectChat(token, username), 5000);
    });
  } catch (err) {
    console.error('❌ ConnectChat error:', err.message);
  }
}

function sendChat(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('❌ WS not open');
    return;
  }
  ws.send(JSON.stringify({ event: 'send_message', data: { content: message } }));
  console.log(`💬 Bot sent: ${message}`);
}

// === Web UI send test ===
app.post('/send', (req, res) => {
  const { text } = req.body;
  if (text && currentUserToken) {
    sendChat(text);
    return res.json({ success: true });
  }
  res.json({ success: false });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/web/index.html'));

// === Export app for Vercel ===
module.exports = app;
