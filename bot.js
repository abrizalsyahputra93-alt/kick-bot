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
app.use(session({
  secret: 'kick-bot-secret-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

let ws;
let currentUserToken = null;
let currentChannel = null;

// ====== Token Storage ======
const TOKENS_FILE = 'tokens.json';
let tokens = loadTokens();

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTokens() {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// ====== PKCE Helper ======
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('base64url');
}

// ====== 1. OAuth Kick ======
app.get('/auth/kick', (req, res) => {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  req.session.state = state;
  req.session.codeVerifier = verifier;

  const scopes = 'chat:read chat:write user:read';
  const authUrl = `https://id.kick.com/oauth/authorize?client_id=${process.env.KICK_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  console.log('🔗 Redirect ke Kick:', authUrl);
  res.redirect(authUrl);
});

// ====== 2. Callback ======
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`Error: ${error}`);
  if (!code) return res.send('No code received.');

  if (state !== req.session.state) {
    return res.send('Invalid state. CSRF protection triggered.');
  }

  const verifier = req.session.codeVerifier;
  if (!verifier) return res.send('Session expired. Try again.');

  try {
    console.log('🔑 Exchanging code for token...');
    const tokenRes = await axios.post('https://id.kick.com/oauth/token', new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.KICK_CLIENT_ID,
      client_secret: process.env.KICK_CLIENT_SECRET,
      code,
      redirect_uri: process.env.REDIRECT_URI,
      code_verifier: verifier
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

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
      expires_at: Date.now() + (expires_in * 1000)
    };
    saveTokens();

    delete req.session.state;
    delete req.session.codeVerifier;

    console.log(`✅ Authorized sukses: @${username}`);
    connectChat(access_token, username);

    res.send(`
      <h1>Authorize Sukses!</h1>
      <p>Bot terhubung ke channel <strong>@${username}</strong></p>
      <script>alert('Sukses! Bot siap balas di channel kamu.');</script>
    `);
  } catch (err) {
    console.error('❌ Token exchange error:', err.response?.data || err.message);
    res.send(`Gagal authorize: ${err.response?.data?.error_description || err.message}`);
  }
});

// ====== 3. Connect ke Chat ======
async function connectChat(token, username) {
  try {
    console.log(`🌐 Menghubungkan ke chatroom @${username}...`);
    const channelRes = await axios.get(`https://kick.com/api/v2/channels/${username}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const chatroomId = channelRes.data.chatroom.id;

    ws = new WebSocket(`wss://ws.kick.com/chat/${chatroomId}`);

    ws.on('open', () => {
      console.log(`✅ WS Connected ke @${username}`);
      ws.send(JSON.stringify({ event: 'auth', data: { token } }));
      // Tes kirim setelah 2 detik
      setTimeout(() => sendChat('✅ Bot connected! Siap menerima perintah.'), 2000);
    });

    ws.on('message', (data) => {
      console.log('📩 WS Message:', data.toString());
      const msg = JSON.parse(data.toString());
      if (msg.event === 'message') {
        const sender = msg.data.sender.username;
        const text = msg.data.message.content.toLowerCase();

        console.log(`[${sender}]: ${text}`);

        if (text.includes('halo')) sendChat(`Halo @${sender}! Bot aktif.`);
        else if (text === '!waktu') sendChat(`⏰ Sekarang: ${new Date().toLocaleString('id-ID')}`);
        else if (text === '!help') sendChat('💡 Command: halo | !waktu | !help');
      }
    });

    ws.on('close', () => {
      console.log('⚠️ WS closed, mencoba reconnect...');
      setTimeout(() => connectChat(token, username), 5000);
    });

    ws.on('error', (err) => {
      console.error('❌ WS error:', err.message);
    });

  } catch (err) {
    console.error('❌ Connect error:', err.message);
    setTimeout(() => connectChat(token, username), 10000);
  }
}

// ====== 4. Send Chat ======
function sendChat(message) {
  if (!ws) {
    console.log('❌ No WS connection.');
    return;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    console.log('🕓 WS belum open, tunggu sebentar...');
    ws.once('open', () => {
      ws.send(JSON.stringify({
        event: 'send_message',
        data: { content: message }
      }));
      console.log(`✅ Bot sent (delayed): ${message}`);
    });
    return;
  }

  ws.send(JSON.stringify({
    event: 'send_message',
    data: { content: message }
  }));
  console.log(`✅ Bot sent: ${message}`);
}

// ====== 5. Web Tester ======
app.post('/send', (req, res) => {
  const { command } = req.body;
  if (command && currentUserToken) {
    sendChat(command);
    res.json({ success: true, channel: currentChannel });
  } else {
    res.json({ success: false, error: 'Belum authorize atau token expired.' });
  }
});

app.get('/', (req, res) => res.sendFile(__dirname + '/web/index.html'));

// ====== 6. Auto Refresh Token ======
setInterval(async () => {
  if (currentUserToken && tokens[currentChannel]) {
    const tokenData = tokens[currentChannel];
    if (Date.now() > tokenData.expires_at - 60000) {
      try {
        const refreshRes = await axios.post('https://id.kick.com/oauth/token', new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.KICK_CLIENT_ID,
          client_secret: process.env.KICK_CLIENT_SECRET,
          refresh_token: tokenData.refresh_token
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        tokens[currentChannel] = {
          ...tokenData,
          access_token: refreshRes.data.access_token,
          refresh_token: refreshRes.data.refresh_token || tokenData.refresh_token,
          expires_at: Date.now() + (refreshRes.data.expires_in * 1000)
        };
        saveTokens();
        currentUserToken = refreshRes.data.access_token;
        console.log('🔄 Token refreshed!');
        connectChat(currentUserToken, currentChannel);
      } catch (err) {
        console.error('❌ Refresh failed:', err.message);
      }
    }
  }
}, 300000); // cek tiap 5 menit

// ====== 7. Start Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server jalan di: http://localhost:${PORT}`);
  console.log(`👉 Authorize: http://localhost:${PORT}/auth/kick`);
});
