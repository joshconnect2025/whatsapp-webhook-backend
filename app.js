// app.js
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ====== ENV CONFIG ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "vibecode123";
const SYSTEM_USER_TOKEN = process.env.SYSTEM_USER_TOKEN; // Permanent Meta Token
const API_KEY = process.env.API_KEY || "edu9WhatsApp123";
const MONGO_URI = process.env.MONGO_URI;

// ====== MIDDLEWARE ======
app.use(express.json());
app.use(cors());

// ====== DB CONNECT ======
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ====== SCHEMA ======
const messageSchema = new mongoose.Schema({
  phoneId: String,
  from: String,
  to: String,
  text: String,
  direction: String, // incoming / outgoing
  timestamp: { type: Date, default: Date.now },
  status: { type: String, default: "unread" }
});
const Message = mongoose.model("Message", messageSchema);

// ====== ROOT ROUTE ======
app.get("/", (req, res) => {
  res.send("✅ WhatsApp Backend is running!");
});

// ====== WEBHOOK VERIFY (GET) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ====== WEBHOOK RECEIVE (POST) ======
app.post("/webhook", async (req, res) => {
  try {
    const apiKey = req.query.apiKey;
    if (apiKey !== API_KEY) return res.sendStatus(403);

    const body = req.body;
    if (body.object) {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from;
        const text = msg.text?.body || "";

        await Message.create({
          phoneId: value.metadata.phone_number_id,
          from,
          text,
          direction: "incoming",
          status: "unread"
        });

        console.log("📥 Incoming:", from, text);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ====== SEND MESSAGE ======
app.post("/send", async (req, res) => {
  try {
    const apiKey = req.query.apiKey;
    if (apiKey !== API_KEY) return res.sendStatus(403);

    const { phoneId, to, text } = req.body;
    if (!phoneId || !to || !text) return res.status(400).json({ error: "Missing fields" });

    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      },
      {
        headers: { Authorization: `Bearer ${SYSTEM_USER_TOKEN}` }
      }
    );

    await Message.create({
      phoneId,
      to,
      text,
      direction: "outgoing"
    });

    console.log("📤 Outgoing:", to, text);
    res.json({ success: true, message: "Message sent" });
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ====== GET MESSAGES ======
app.get("/messages", async (req, res) => {
  try {
    const { phoneId, number, apiKey } = req.query;
    if (apiKey !== API_KEY) return res.sendStatus(403);
    const messages = await Message.find({ phoneId, from: number }).sort({ timestamp: 1 });
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ====== CONTACTS API ======
app.get("/contacts", async (req, res) => {
  try {
    const apiKey = req.query.apiKey;
    const phoneId = req.query.phoneId;
    if (apiKey !== API_KEY) return res.sendStatus(403);

    const pipeline = [
      { $match: { phoneId } },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$from",
          lastMessage: { $first: "$text" },
          lastMessageTime: { $first: "$timestamp" },
          unreadCount: {
            $sum: { $cond: [{ $eq: ["$status", "unread"] }, 1, 0] }
          }
        }
      },
      { $project: { _id: 0, number: "$_id", lastMessage: 1, lastMessageTime: 1, unreadCount: 1 } }
    ];

    const contacts = await Message.aggregate(pipeline);
    res.json({ contacts });
  } catch (err) {
    console.error("Contacts error:", err);
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
