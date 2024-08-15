const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const MongoClient = require('mongodb').MongoClient;
const cors = require('cors');

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json()); // To parse JSON bodies

// Load credentials
const credentials = JSON.parse(fs.readFileSync('./client_secret.json'));
const { client_id, client_secret, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

const uri = 'mongodb+srv://nandhagopy:123@cluster0.cozk4.mongodb.net/'; // Replace with your MongoDB URI
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
client.connect();

// Define scopes
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// Generate auth URL
app.get('/auth', (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  res.redirect(authUrl);
});

// Handle OAuth2 callback
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync('tokens.json', JSON.stringify(tokens));
    res.redirect('https://task-ruby-three.vercel.app/oauth2callback/emails')
  } catch (error) {
    console.error('Error retrieving access token', error);
    res.status(500).send('Error during authentication');
  }
});

// Ensure attachments directory exists
const ensureAttachmentsDirExists = () => {
  const attachmentsDir = path.join(__dirname, 'attachments');
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }
};

// Fetch emails and attachments
app.get('/emails', async (req, res) => {
  try {
    // Load tokens if available
    if (fs.existsSync('tokens.json')) {
      const tokens = JSON.parse(fs.readFileSync('tokens.json'));
      oAuth2Client.setCredentials(tokens);
    } else {
      return res.status(401).send('No tokens file found');
    }

    ensureAttachmentsDirExists(); // Ensure the attachments directory exists

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const response = await gmail.users.messages.list({ userId: 'me' });
    const messages = response.data.messages;

    if (!messages) {
      return res.status(404).send('No messages found');
    }

    // Connect to MongoDB
    const db = client.db('gmail_attachments');
    const emailCollection = db.collection('emails');

    // Fetch and process each message
    const emails = [];
    for (const message of messages) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: message.id });
      const messageData = msg.data;

      const headers = messageData.payload.headers;
      const fromHeader = headers.find(header => header.name === 'From');
      const senderName = fromHeader ? fromHeader.value.split('<')[0].trim() : 'Unknown';

      await emailCollection.updateOne(
        { id: message.id },
        {
          $set: {
            threadId: message.threadId,
            snippet: messageData.snippet,
            payload: messageData.payload,
            internalDate: messageData.internalDate,
            sender: senderName,
            attachments: [] // Initialize empty attachments array
          }
        },
        { upsert: true }
      );

      emails.push({
        id: message.id,
        threadId: message.threadId,
        snippet: messageData.snippet,
        internalDate: messageData.internalDate,
        sender: senderName
      })

      // Handle attachments
      const parts = messageData.payload.parts;
      if (parts) {
        for (const part of parts) {
          if (part.filename && part.body.attachmentId) {
            try {
              const attachment = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId: message.id,
                id: part.body.attachmentId,
              });
              const data = attachment.data.data;
              const buffer = Buffer.from(data, 'base64');

              const attachmentPath = path.join(__dirname, 'attachments', part.filename);
              fs.writeFileSync(attachmentPath, buffer);
              emails.push({
                attachments: { filename: part.filename, path: attachmentPath }
              });

              await emailCollection.updateOne(
                { id: message.id },
                { $push: { attachments: { filename: part.filename, path: attachmentPath } } }
              );
            } catch (attachmentError) {
              console.error(`Error fetching attachment ${part.filename}:`, attachmentError);
            }
          }
        }
      }
    }
    res.send(emails)
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).send('Failed to fetch emails');
  }
});

app.get('/attachments', async (req, res) => {
  const db = client.db('gmail_attachments');
  const emailCollection = db.collection('emails');

  const data = await emailCollection.find().toArray()
  const tempArr = data.filter((mail) => {
    if (mail.attachments.length === 0) {
      return false
    } else {
      return true
    }
  })

  res.json(tempArr)
})

app.get('/getmail', async (req, res) => {
  const {id} = req.query
  
  const db = client.db('gmail_attachments');
  const emailCollection = db.collection('emails');

  const data = await emailCollection.findOne({id:id})
  res.json(data)
})

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
