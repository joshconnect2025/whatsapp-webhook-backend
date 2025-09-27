// Import required modules
const express = require('express');
const mongoose = require('mongoose');

// Create Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Environment variables (set on Render)
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN; // e.g., "vibecode"
const mongoUri = process.env.MONGO_URI; // Your Mongo connection string
const apiKey = process.env.API_KEY; // Simple key for dashboard fetches, e.g., "mysecretkey"

// Connect to MongoDB
mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define Message Schema (stores incoming messages permanently)
const messageSchema = new mongoose.Schema({
  phoneNumberId: { type: String, required: true }, // Your 4 phone IDs
  from: String, // Sender number
  message: String, // Text content
  type: String, // e.g., "text", "image"
  timestamp: { type: Date, default: Date.now }, // When received
  metadata: mongoose.Schema.Types.Mixed // Extra like media URL, etc.
});

const Message = mongoose.model('Message', messageSchema);

// Webhook Verification (GET /)
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Webhook for Incoming Messages (POST /)
app.post('/', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\nWebhook received ${timestamp}\n`);
    console.log(JSON.stringify(req.body, null, 2));

    // Parse Meta's webhook payload (standard format)
    const entry = req.body.entry && req.body.entry[0];
    if (entry && entry.changes && entry.changes[0]) {
      const change = entry.changes[0];
      const phoneNumberId = change.value.metadata.phone_number_id; // Your phone ID
      const messages = change.value.messages;

      if (messages && messages.length > 0) {
        for (const msg of messages) {
          const newMessage = new Message({
            phoneNumberId: phoneNumberId,
            from: msg.from,
            message: msg.text ? msg.text.body : (msg.type === 'image' ? '[Image]' : '[Other Media]'), // Handle text/media simply
            type: msg.type,
            metadata: { id: msg.id, timestamp: msg.timestamp } // Add more if needed
          });
          await newMessage.save(); // Store permanently
          console.log(`Stored message from ${msg.from} on phone ${phoneNumberId}`);
        }
      }
    }

    res.status(200).end();
  } catch (error) {
    console.error('Error storing message:', error);
    res.status(500).end();
  }
});

// API Endpoint for Dashboard to Fetch Messages (/messages?phoneId=123&apiKey=secret)
app.get('/messages', async (req, res) => {
  const { phoneId, apiKey: providedKey } = req.query;

  if (providedKey !== apiKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  if (!phoneId) {
    return res.status(400).json({ error: 'phoneId required' });
  }

  try {
    const messages = await Message.find({ phoneNumberId: phoneId }).sort({ timestamp: -1 }).limit(100); // Last 100, newest first
    res.json({ messages: messages });
  } catch (error) {
    res.status(500).json({ error: 'Fetch error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
