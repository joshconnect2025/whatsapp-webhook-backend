import express from 'express';
import mongoose from 'mongoose';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors({ origin: 'https://edu9.in' }));

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN || 'default-token';
const mongoUri = process.env.MONGO_URI;
const apiKey = process.env.API_KEY || 'default-key';
const metaAccessToken = process.env.META_ACCESS_TOKEN;

if (!mongoUri || !metaAccessToken) {
  console.error('MONGO_URI or META_ACCESS_TOKEN is not defined');
  process.exit(1);
}

await mongoose.connect(mongoUri);
console.log('Connected to MongoDB');

const messageSchema = new mongoose.Schema({
  phoneNumberId: { type: String, required: true },
  from: String,
  to: String,
  message: String,
  type: String,
  direction: String,
  timestamp: { type: Date, default: Date.now },
  metadata: mongoose.Schema.Types.Mixed
});
const Message = mongoose.model('Message', messageSchema);

// Webhook verification
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }
  console.log('Webhook verification failed');
  res.status(403).end();
});

// Incoming webhook messages
app.post('/', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\nWebhook received ${timestamp}\n`, JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const phoneNumberId = change?.value?.metadata?.phone_number_id;
    const messages = change?.value?.messages;

    if (messages?.length) {
      for (const msg of messages) {
        const newMessage = new Message({
          phoneNumberId,
          from: msg.from,
          message: msg.text?.body || (msg.type === 'image' ? '[Image]' : '[Other Media]'),
          type: msg.type,
          direction: 'incoming',
          metadata: { id: msg.id, timestamp: msg.timestamp }
        });
        await newMessage.save();
        console.log(`Stored incoming message from ${msg.from} on phone ${phoneNumberId}`);
      }
    }
    res.status(200).end();
  } catch (error) {
    console.error('Error storing message:', error);
    res.status(500).end();
  }
});

// Get messages
app.get('/messages', async (req, res) => {
  const { phoneId, contactNumber, apiKey: providedKey } = req.query;
  if (providedKey !== apiKey) return res.status(403).json({ error: 'Invalid API key' });
  if (!phoneId || !contactNumber) return res.status(400).json({ error: 'phoneId and contactNumber required' });

  try {
    const messages = await Message.find({
      phoneNumberId: phoneId,
      $or: [{ from: contactNumber }, { to: contactNumber }]
    }).sort({ timestamp: -1 }).limit(100);
    res.json({ messages });
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Fetch error' });
  }
});

// Send message
app.post('/send', async (req, res) => {
  const { apiKey: providedKey } = req.query;
  const { phoneNumberId, to, message } = req.body;
  if (providedKey !== apiKey) return res.status(403).json({ error: 'Invalid API key' });
  if (!phoneNumberId || !to || !message) return res.status(400).json({ error: 'Missing phoneNumberId, to, or message' });

  try {
    const metaUrl = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: message } };

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
    await new Message({ phoneNumberId, from: 'me', to, message, type: 'text', direction: 'outgoing', metadata: { metaId: data.messages[0].id } }).save();

    console.log(`Sent and stored message to ${to} from phone ${phoneNumberId}`);
    res.json({ success: true, metaData: data });
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ error: 'Send failed' });
  }
});

// Get contacts
app.get('/contacts', async (req, res) => {
  const { phoneId, apiKey: providedKey } = req.query;
  if (providedKey !== apiKey) return res.status(403).json({ error: 'Invalid API key' });
  if (!phoneId) return res.status(400).json({ error: 'phoneId required' });

  try {
    const messages = await Message.find({ phoneNumberId: phoneId }).sort({ timestamp: -1 });
    const contactsMap = new Map();

    messages.forEach(msg => {
      const number = msg.direction === 'incoming' ? msg.from : msg.to;
      if (!number) return;
      const contact = contactsMap.get(number) || { number, name: null, lastMessage: '', lastMessageTime: null, unreadCount: 0 };
      contact.lastMessage = msg.message;
      contact.lastMessageTime = msg.timestamp;
      if (msg.direction === 'incoming') contact.unreadCount++;
      contactsMap.set(number, contact);
    });

    res.json({ contacts: Array.from(contactsMap.values()) });
  } catch (error) {
    console.error('Fetch contacts error:', error);
    res.status(500).json({ error: 'Fetch contacts error' });
  }
});

app.listen(port, () => console.log(`\nListening on port ${port}\n`));
