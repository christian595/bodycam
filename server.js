require('dotenv').config();

const express   = require('express');
const multer    = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const DESCRIBE_PROMPT = 'Describe what you see in this photo in 2-3 sentences';

// Persistent data dir — override with DATA_DIR env var on Railway
// Railway: set DATA_DIR=/data and mount a volume at /data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'captures.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

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
  // R2_PUBLIC_URL is your bucket's public URL, e.g. https://pub-xxxx.r2.dev
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

// ─── JSON storage helpers ───────────────────────────────────────────────────────
function readCaptures() {
  if (!fs.existsSync(DB_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return []; }
}

function writeCaptures(captures) {
  fs.writeFileSync(DB_PATH, JSON.stringify(captures, null, 2), 'utf8');
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

    // Upload image to R2
    const ext      = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
    const filename = `${uuidv4()}${ext}`;
    const photoUrl = await uploadToR2(req.file.buffer, filename, req.file.mimetype);

    // Get Claude description
    let description = '';
    try {
      description = await describeImage(req.file.buffer, req.file.mimetype);
    } catch (err) {
      console.error('Claude API error:', err.message);
      description = '(Description unavailable)';
    }

    // Persist capture record
    const capture = {
      id: uuidv4(),
      filename,   // kept for R2 deletion
      photoUrl,   // public CDN URL used by the dashboard
      address,
      latitude:  parseFloat(latitude),
      longitude: parseFloat(longitude),
      description,
      timestamp: new Date().toISOString(),
    };

    const captures = readCaptures();
    captures.unshift(capture);
    writeCaptures(captures);

    res.status(201).json(capture);
  } catch (err) {
    console.error('POST /api/capture error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/captures ───────────────────────────────────────────────────────────
app.get('/api/captures', (_req, res) => {
  res.json(readCaptures());
});

// ── DELETE /api/captures/:id ────────────────────────────────────────────────────
app.delete('/api/captures/:id', async (req, res) => {
  let captures = readCaptures();
  const target = captures.find(c => c.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });

  await deleteFromR2(target.filename);

  captures = captures.filter(c => c.id !== req.params.id);
  writeCaptures(captures);
  res.json({ ok: true });
});

// ─── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Bodycam dashboard running at http://localhost:${PORT}`);
});
