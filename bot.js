require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static('web'));
app.use(
  session({
    secret: 'kick-bot-secret-2025',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

let ws;
let currentUserToken = null;
let currentChannel = null;

// === Token management ===
const TOKENS_FILE = '/tmp/tokens.json'; // lokasi aman di Vercel
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

// === PKCE helpers ===
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
function generateState() {
  return crypto.randomBytes(16).toString('base64url');
}

// === 1. Authorize ===
app.get('/auth/kick', (req, res) => {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  req.session.state = state;
  req.session.codeVerifier = verifier;

  const scopes = 'chat:read chat:write user:read';
  const authUrl = `https://id.kick.com/oauth/authorize?client_id=${process.env.KICK_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    process.env.REDIRECT_URI
  )}&response_type=code&scope=${encodeURIComponent(
    scopes
  )}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  res.redirect(authUrl);
});

// === 2. Callback ===
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`Error: ${error}`);
  if (!code) return res.send('No code received.');

  if (state !== req.session.state) return res.send('Invalid state.');

  const verifier = req.session.codeVerifier;
  if (!verifier) return res.send('Session expired. Try again.');

  try {
    const tokenRes = await axios.post(
      'https://id.kick.com/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.KICK_CLIENT_ID,
        client_secret: process.env.KICK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.REDIRECT_URI,
        code_verifier: verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    currentUserToken = access_token;

    const userRes = await axios.get('https://kick.com/api/v2/user/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const username = userRes.data.username;
    currentChannel = username;

    tokens[username] = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    };
    saveTokens(tokens);

    delete req.session.state;
    delete req.session.codeVerifier;

    connectChat(access_token, username);

    res.send(`
      <h1>✅ Authorize Sukses!</h1>
      <p>Bot terhubung ke channel <b>@${username}</b></p>
      <a href="/">Kembali ke Tester</a>
    `);
  } catch (err) {
    console.error('❌ Token exchange error:', err.response?.data || err.message);
    res.send(`Gagal authorize: ${err.response?.data?.error_description || err.message}`);
  }
});

// === 3. Chat Connection ===
async function connectChat(token, username) {
  try {
    const channelRes = await axios.get(`https://kick.com/api/v2/channels/${username}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const chatroomId = channelRes.data.chatroom.id;

    ws = new WebSocket(`wss://ws.kick.com/chat/${chatroomId}`);

    ws.on('open', () => {
      console.log(`✅ Connected to @${username} chat!`);
      ws.send(JSON.stringify({ event: 'auth', data: { token } }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'message') {
        const sender = msg.data.sender.username;
        const text = msg.data.message.content.toLowerCase();

        console.log(`[${sender}]: ${text}`);

        if (text.includes('halo')) sendChat(`Halo @${sender}! 👋 Bot aktif.`);
        if (text === '!waktu') sendChat(`🕒 Sekarang: ${new Date().toLocaleString('id-ID')}`);
        if (text === '!help') sendChat('Perintah: halo, !waktu, !help');
      }
    });

    ws.on('close', () => {
      console.log('⚠️ WS closed, reconnecting...');
      setTimeout(() => connectChat(token, username), 5000);
    });
  } catch (err) {
    console.error('❌ Connect error:', err.message);
    setTimeout(() => connectChat(token, username), 10000);
  }
}

// === 4. Send Chat ===
function sendChat(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('WS not open, skip send.');
    return;
  }
  ws.send(JSON.stringify({ event: 'send_message', data: { content: message } }));
  console.log(`💬 Sent to @${currentChannel}: ${message}`);
}

// === 5. Web Tester ===
app.post('/send', (req, res) => {
  const { command } = req.body;
  if (command && currentUserToken) {
    sendChat(command);
    res.json({ success: true, channel: currentChannel });
  } else {
    res.json({ success: false, error: 'Belum authorize.' });
  }
});

app.get('/', (req, res) => res.sendFile(__dirname + '/web/index.html'));

// === 6. Export for Vercel ===
module.exports = app;
