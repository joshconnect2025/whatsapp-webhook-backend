const express = require('express');
const mongoose = require('mongoose');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN || 'default-token';
const mongoUri = process.env.MONGO_URI;
const apiKey = process.env.API_KEY || 'default-key';
const metaAccessToken = process.env.META_ACCESS_TOKEN;

if (!mongoUri) {
  console.error('MONGO_URI is not defined');
  process.exit(1);
}
if (!metaAccessToken) {
  console.error('META_ACCESS_TOKEN is not defined');
  process.exit(1);
}
mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

const messageSchema = new mongoose.Schema({
  phoneNumberId: { type: String, required: true },
  from: String,
  to: String,
  message: String,
  type: String,
  direction: String, // "incoming" or "outgoing"
  timestamp: { type: Date, default: Date.now },
  metadata: mongoose.Schema.Types.Mixed
});
const Message = mongoose.model('Message', messageSchema);

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    console.log('Webhook verification failed');
    res.status(403).end();
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\nWebhook received ${timestamp}\n`);
    console.log(JSON.stringify(req.body, null, 2));
    const entry = req.body.entry && req.body.entry[0];
    if (entry && entry.changes && entry.changes[0]) {
      const change = entry.changes[0];
      const phoneNumberId = change.value.metadata.phone_number_id;
      const messages = change.value.messages;
      if (messages && messages.length > 0) {
        for (const msg of messages) {
          const newMessage = new Message({
            phoneNumberId: phoneNumberId,
            from: msg.from,
            message: msg.text ? msg.text.body : (msg.type === 'image' ? '[Image]' : '[Other Media]'),
            type: msg.type,
            direction: 'incoming',
            metadata: { id: msg.id, timestamp: msg.timestamp }
          });
          await newMessage.save();
          console.log(`Stored incoming message from ${msg.from} on phone ${phoneNumberId}`);
        }
      }
    }
    res.status(200).end();
  } catch (error) {
    console.error('Error storing message:', error.message);
    res.status(500).end();
  }
});

app.get('/messages', async (req, res) => {
  const { phoneId, apiKey: providedKey } = req.query;
  if (providedKey !== apiKey) return res.status(403).json({ error: 'Invalid API key' });
  if (!phoneId) return res.status(400).json({ error: 'phoneId required' });
  try {
    const messages = await Message.find({ phoneNumberId: phoneId }).sort({ timestamp: -1 }).limit(100);
    res.json({ messages });
  } catch (error) {
    console.error('Fetch error:', error.message);
    res.status(500).json({ error: 'Fetch error' });
  }
});

app.post('/send', async (req, res) => {
  const { apiKey: providedKey } = req.query;
  const { phoneNumberId, to, message } = req.body;
  if (providedKey !== apiKey) return res.status(403).json({ error: 'Invalid API key' });
  if (!phoneNumberId || !to || !message) return res.status(400).json({ error: 'Missing phoneNumberId, to, or message' });
  try {
    const metaUrl = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { body: message }
    };
    const response = await fetch(metaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${metaAccessToken}` },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Meta send error: ${JSON.stringify(errorData)}`);
    }
    const data = await response.json();
    const newMessage = new Message({
      phoneNumberId,
      from: 'me',
      to,
      message,
      type: 'text',
      direction: 'outgoing',
      metadata: { metaId: data.messages[0].id }
    });
    await newMessage.save();
    console.log(`Sent and stored message to ${to} from phone ${phoneNumberId}`);
    res.json({ success: true, metaData: data });
  } catch (error) {
    console.error('Send error:', error.message);
    res.status(500).json({ error: 'Send failed' });
  }
});

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});