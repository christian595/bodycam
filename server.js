require('dotenv').config();

const express   = require('express');
const multer    = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const CLAUDE_MODEL    = 'claude-sonnet-4-20250514';
const DESCRIBE_PROMPT = 'Describe what you see in this photo in 2-3 sentences';
const DB_KEY          = 'captures.json';   // stored in R2 alongside images

// ─── Cloudflare R2 ─────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2(buffer, filename, mimetype) {
  await r2.send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME,
    Key:         filename,
    Body:        buffer,
    ContentType: mimetype,
  }));
  return `${process.env.R2_PUBLIC_URL}/${filename}`;
}

async function deleteFromR2(filename) {
  try {
    await r2.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key:    filename,
    }));
  } catch (err) {
    console.error(`R2 delete failed for ${filename}:`, err.message);
  }
}

// ─── captures.json stored in R2 — no disk needed ───────────────────────────────
async function readCaptures() {
  try {
    const res  = await r2.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key:    DB_KEY,
    }));
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey') return [];   // first run
    throw err;
  }
}

async function writeCaptures(captures) {
  await r2.send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME,
    Key:         DB_KEY,
    Body:        JSON.stringify(captures, null, 2),
    ContentType: 'application/json',
  }));
}

// ─── Multer ─────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are accepted'));
    }
    cb(null, true);
  },
});

// ─── Anthropic ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function describeImage(buffer, mimetype) {
  const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType = supported.includes(mimetype) ? mimetype : 'image/jpeg';

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
        },
        { type: 'text', text: DESCRIBE_PROMPT },
      ],
    }],
  });

  return response.content[0].text;
}

// ─── Express ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /api/capture ───────────────────────────────────────────────────────────
app.post('/api/capture', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const { address, latitude, longitude } = req.body;
    if (!address)   return res.status(400).json({ error: 'address is required' });
    if (!latitude)  return res.status(400).json({ error: 'latitude is required' });
    if (!longitude) return res.status(400).json({ error: 'longitude is required' });

    const ext      = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
    const filename = `${uuidv4()}${ext}`;
    const photoUrl = await uploadToR2(req.file.buffer, filename, req.file.mimetype);

    let description = '';
    try {
      description = await describeImage(req.file.buffer, req.file.mimetype);
    } catch (err) {
      console.error('Claude API error:', err.message);
      description = '(Description unavailable)';
    }

    const capture = {
      id: uuidv4(),
      filename,
      photoUrl,
      address,
      latitude:  parseFloat(latitude),
      longitude: parseFloat(longitude),
      description,
      timestamp: new Date().toISOString(),
    };

    const captures = await readCaptures();
    captures.unshift(capture);
    await writeCaptures(captures);

    res.status(201).json(capture);
  } catch (err) {
    console.error('POST /api/capture error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/captures ───────────────────────────────────────────────────────────
app.get('/api/captures', async (_req, res) => {
  try {
    res.json(await readCaptures());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/captures/:id ────────────────────────────────────────────────────
app.delete('/api/captures/:id', async (req, res) => {
  try {
    let captures = await readCaptures();
    const target = captures.find(c => c.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Not found' });

    await deleteFromR2(target.filename);
    captures = captures.filter(c => c.id !== req.params.id);
    await writeCaptures(captures);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Bodycam dashboard running at http://localhost:${PORT}`);
});
