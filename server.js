import express from "express";
import session from "express-session";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { WebSocket } from "ws";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("web"));
app.use(
  session({
    secret: "kickbotsecret",
    resave: false,
    saveUninitialized: true,
  })
);

let ws;

// --- 1️⃣ Halaman utama ---
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "web", "index.html"));
});

// --- 2️⃣ Tombol authorize Kick ---
app.get("/auth/kick", (req, res) => {
  const state = Math.random().toString(36).substring(7);
  const authorizeUrl = `https://id.kick.com/oauth/authorize?client_id=${process.env.KICK_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    process.env.REDIRECT_URI
  )}&response_type=code&scope=chat:read chat:write user:read&state=${state}`;
  res.redirect(authorizeUrl);
});

// --- 3️⃣ Callback dari Kick ---
app.get("/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await axios.post("https://id.kick.com/oauth/token", {
      client_id: process.env.KICK_CLIENT_ID,
      client_secret: process.env.KICK_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: process.env.REDIRECT_URI,
    });

    const { access_token } = tokenRes.data;
    req.session.access_token = access_token;

    res.send(`
      <h2>✅ Authorized berhasil!</h2>
      <p>Access token tersimpan di session.</p>
      <a href="/">⬅️ Kembali ke Home</a>
    `);
  } catch (err) {
    console.error("❌ Token exchange error:", err.response?.data || err.message);
    res.send(
      `<h2>❌ Gagal authorize:</h2><pre>${JSON.stringify(
        err.response?.data || err.message,
        null,
        2
      )}</pre>`
    );
  }
});

// --- 4️⃣ WebSocket Kick Bot ---
async function connectKickChat(channelName, token) {
  if (ws) ws.close();
  const url = `wss://chat.kick.com/chat/v2/${channelName}`;
  ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  ws.on("open", () => {
    console.log("✅ Connected to Kick chat");
  });

  ws.on("message", (msg) => {
    console.log("📩 Message:", msg.toString());
  });

  ws.on("close", () => console.log("❌ Disconnected from chat"));
  ws.on("error", (e) => console.log("⚠️ WS Error:", e.message));
}

app.get("/start-bot", async (req, res) => {
  if (!req.session.access_token)
    return res.send("❌ Belum authorize. <a href='/auth/kick'>Login Kick</a>");

  await connectKickChat("nama_channel_kamu", req.session.access_token);
  res.send("🤖 Bot started!");
});

// Jalankan server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
