require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const cron = require('node-cron');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// Register fonts
const playfairPath = path.join(__dirname, 'fonts', 'PlayfairDisplay-Regular.ttf');
const robotoPath = path.join(__dirname, 'fonts', 'Roboto-Regular.ttf');
if (fs.existsSync(playfairPath)) { GlobalFonts.registerFromPath(playfairPath, 'Playfair'); console.log('✅ Playfair Display loaded'); }
if (fs.existsSync(robotoPath)) { GlobalFonts.registerFromPath(robotoPath, 'Roboto'); console.log('✅ Roboto loaded'); }

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// Route by country code: +58 = Venezuela → Agro Bot, otherwise → Lila Bot
function isAgroUser(from) {
  return from.includes('+58');
}

// ─── AGRO BOT ────────────────────────────────────────────────────────────────

const AGRO_SYSTEM_PROMPT = `Eres un ingeniero agrónomo experto que trabaja para una tienda de insumos agrícolas en Venezuela.
Tu misión es ayudar a los agricultores venezolanos con sus preguntas sobre cultivos, plagas, enfermedades,
fertilización, riego y manejo agronómico en general.

INSTRUCCIONES:
- Responde siempre en español, de forma clara y práctica
- Da consejos adaptados al clima y condiciones de Venezuela
- Sé específico con dosis, productos y técnicas cuando sea necesario
- Si la pregunta es sobre un cultivo común en Venezuela (maíz, arroz, caña, café, cacao, plátano, yuca, tomate, pimentón, etc.), da respuestas detalladas
- Si no tienes suficiente información sobre el problema, haz preguntas cortas para entender mejor la situación (zona, tipo de suelo, síntomas, etc.)
- Mantén un tono amigable y accesible, como si hablaras con un agricultor de confianza
- Si el agricultor menciona síntomas de plagas o enfermedades, ayúdalo a identificarlas y da recomendaciones de control
- Respuestas deben ser concisas pero completas — no más de 3-4 párrafos por respuesta

IMPORTANTE: Solo responde preguntas relacionadas con agricultura, cultivos, agronomía e insumos agrícolas.
Si te preguntan algo fuera de ese tema, responde amablemente que solo puedes ayudar con temas agrícolas.`;

const agroConversations = {};

async function handleAgroMessage(from, messageText) {
  if (!agroConversations[from]) agroConversations[from] = [];
  agroConversations[from].push({ role: 'user', content: messageText });
  if (agroConversations[from].length > 10) agroConversations[from].shift();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: AGRO_SYSTEM_PROMPT,
    messages: agroConversations[from],
  });

  const reply = response.content[0].text;
  agroConversations[from].push({ role: 'assistant', content: reply });
  await sendMessage(from, reply);
}

// ─── LILA BOT ────────────────────────────────────────────────────────────────

const GROUP = [
  'whatsapp:+13055049095',
  'whatsapp:+17868438920',
  'whatsapp:+17864898034',
];

const state = {};
const lastContent = {};
const processing = new Set(); // deduplicate concurrent webhook calls

function getState(number) {
  return state[number] || 'idle';
}

function setState(number, s) {
  state[number] = s;
}

async function sendMessage(to, body) {
  await twilioClient.messages.create({ from: FROM_NUMBER, to, body });
}

async function sendImageMessage(to, imageUrl, caption) {
  await twilioClient.messages.create({ from: FROM_NUMBER, to, mediaUrl: [imageUrl], body: caption });
}

async function broadcastMorningPing() {
  console.log('📅 Sending morning ping to group...');
  const message =
    '✨ Good morning! Time for today\'s Lila Miami post 📸\n\n' +
    'Send me a product photo and I\'ll create a branded Instagram image with caption, hashtags, and the best time to post!';
  for (const number of GROUP) {
    try {
      await sendMessage(number, message);
      setState(number, 'waiting_for_photo');
      console.log(`✅ Pinged ${number}`);
    } catch (err) {
      console.error(`❌ Failed to ping ${number}:`, err.message);
    }
  }
}

cron.schedule('0 10 * * *', broadcastMorningPing, {
  timezone: 'America/New_York',
});

async function downloadImageBuffer(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
    responseType: 'arraybuffer',
  });
  const contentType = response.headers['content-type'] || 'image/jpeg';
  const buffer = Buffer.from(response.data);
  return { buffer, contentType };
}

function stripEmojis(str) {
  return str.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

async function createBrandedImage(imageBuffer, captionText) {
  const SIZE = 1080;

  // Resize + luxury jewelry photo edit
  const resizedBuffer = await sharp(imageBuffer)
    .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
    .modulate({ brightness: 1.08, saturation: 1.35, hue: 8 }) // warm + vivid
    .linear(1.15, -15)  // contrast boost
    .sharpen({ sigma: 0.8 }) // crisp details
    .jpeg({ quality: 95 })
    .toBuffer();

  // Add vignette (dark edges) using sharp composite
  const vignetteSvg = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="v" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.45"/>
        </radialGradient>
      </defs>
      <rect width="${SIZE}" height="${SIZE}" fill="url(#v)"/>
    </svg>`
  );

  const vignetteBuffer = await sharp(resizedBuffer)
    .composite([{ input: vignetteSvg, blend: 'multiply' }])
    .jpeg({ quality: 95 })
    .toBuffer();

  // Load into canvas for text overlay
  const img = await loadImage(vignetteBuffer);
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  // Dark gradient at bottom
  const grad = ctx.createLinearGradient(0, SIZE - 420, 0, SIZE);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, SIZE - 420, SIZE, 420);

  // Clean caption — first complete sentence only
  let clean = stripEmojis(captionText);
  const dot = clean.search(/[.!?]/);
  if (dot > 15 && dot < 110) {
    clean = clean.substring(0, dot + 1);
  } else {
    clean = clean.substring(0, 80);
    const sp = clean.lastIndexOf(' ');
    if (sp > 30) clean = clean.substring(0, sp);
  }
  console.log(`🖊️ Drawing: "${clean}"`);

  // Word wrap by character count
  const words = clean.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (test.length > 28) { if (cur) lines.push(cur); cur = w; if (lines.length >= 2) break; }
    else cur = test;
  }
  if (cur && lines.length < 3) lines.push(cur);

  // Draw caption in Playfair Display — elegant serif
  ctx.font = '72px Playfair';
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'bottom';
  const lineH = 84;
  const startY = SIZE - 90 - (lines.length - 1) * lineH;
  lines.forEach((line, i) => ctx.fillText(line, 50, startY + i * lineH));

  // Tagline — small caps style
  ctx.font = '22px Roboto';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText("MIAMI'S EVERYDAY GOLD", 50, SIZE - 42);

  // @lilamiami right aligned
  ctx.textAlign = 'right';
  ctx.fillText('@lilamiami', SIZE - 50, SIZE - 42);

  return canvas.toBuffer('image/jpeg');
}

async function uploadToImgBB(imageBuffer) {
  const base64 = imageBuffer.toString('base64');
  const params = new URLSearchParams({ key: process.env.IMGBB_API_KEY, image: base64 });
  const response = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return response.data.data.url;
}

function extractCaption(fullContent) {
  // Find CAPTION section — robust, works regardless of emoji variant
  const match = fullContent.match(/CAPTION[^\n]*\n+([\s\S]*?)(?=\n\s*(?:HASHTAG|BEST TIME|QUICK TIP|#|⏰|💡)|$)/i);
  if (match) {
    const text = match[1].trim().replace(/[^\x20-\x7E\s]/g, '').trim();
    // Take first 2 sentences max
    const parts = text.split(/(?<=[.!?])\s+/);
    return parts.slice(0, 2).join(' ').substring(0, 180).trim();
  }
  // Fallback: first 180 chars stripped of emojis
  return fullContent.replace(/[^\x20-\x7E\s]/g, '').trim().substring(0, 180);
}

async function generateContent(imageBase64, imageContentType, userCaption) {
  const userText = userCaption
    ? `Here is a product photo from Lila Miami. The person said: "${userCaption}". Generate a full Instagram post.`
    : 'Here is a product photo from Lila Miami. Generate a full Instagram post.';

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1200,
    system: `You are a social media expert for Lila Miami, a luxury jewelry brand based in Miami founded by Daniela Matheus, originally from Venezuela.

Brand voice: elegant, warm, Miami chic, modern woman energy.
Tagline: "Miami's everyday gold — handpicked for the modern woman."

When given a product photo, generate a complete Instagram post with these 4 sections:

📝 CAPTION
2-3 sentences. Engaging, on-brand, natural — not salesy. Include 1-2 tasteful emojis. Speak to the modern Miami woman.

#️⃣ HASHTAGS
25 relevant hashtags. Mix popular (#jewelry #gold) with niche (#miamijewelry #lilamiami #goldjewelry #handpickedjewelry) and lifestyle tags (#miamiwoman #everydayluxury).

⏰ BEST TIME TO POST
Give a specific day + time in Miami (ET) with a brief reason (e.g., "Tuesday 7 PM ET — weekday evenings have peak jewelry browsing on Instagram").

💡 QUICK TIP
One actionable tip to boost engagement for this specific photo (lighting, story post, reel idea, etc.).`,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: imageContentType, data: imageBase64 },
          },
          { type: 'text', text: userText },
        ],
      },
    ],
  });

  return response.content[0].text;
}

function splitMessage(text, maxLen = 1500) {
  const chunks = [];
  while (text.length > maxLen) {
    let splitAt = text.lastIndexOf('\n', maxLen);
    if (splitAt < 100) splitAt = maxLen;
    chunks.push(text.substring(0, splitAt).trim());
    text = text.substring(splitAt).trim();
  }
  if (text) chunks.push(text);
  return chunks;
}

async function processPhoto(from, mediaUrl, mediaContentType, caption) {
  if (processing.has(from)) return; // ignore duplicate webhook
  processing.add(from);
  await sendMessage(from, '📸 Got it! Creating your branded post... give me a sec ✨');

  try {
    const { buffer, contentType } = await downloadImageBuffer(mediaUrl);
    const base64 = buffer.toString('base64');

    // Generate content with Claude
    const content = await generateContent(base64, contentType, caption);
    lastContent[from] = content;

    // Extract short caption for image overlay
    const shortCaption = extractCaption(content);
    console.log(`📝 Extracted caption: "${shortCaption.substring(0, 100)}..."`);

    // Create branded image — fallback to plain resized if canvas fails
    let brandedBuffer;
    try {
      brandedBuffer = await createBrandedImage(buffer, shortCaption);
    } catch (imgErr) {
      console.error('⚠️ Canvas failed, using plain image:', imgErr.message);
      brandedBuffer = await sharp(buffer)
        .resize(1080, 1080, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 92 })
        .toBuffer();
    }

    // Upload to ImgBB
    const imageUrl = await uploadToImgBB(brandedBuffer);
    setState(from, 'waiting_for_approval');

    // Send branded image
    await sendImageMessage(from, imageUrl, '💎 Here\'s your branded Instagram post:');

    // Send content split into chunks (Twilio 1600 char limit)
    for (const chunk of splitMessage(content)) {
      await sendMessage(from, chunk);
    }
    await sendMessage(from, '---\nReply *YES* ✅  |  *RECREATE* 🔄  |  *NO* ❌');

  } catch (err) {
    console.error('❌ Error:', err.message);
    await sendMessage(from, 'Something went wrong. Try sending the photo again! 🙏');
    setState(from, 'waiting_for_photo');
  } finally {
    processing.delete(from);
  }
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  const from = req.body.From;
  const rawBody = (req.body.Body || '').trim();
  const body = rawBody.toLowerCase();
  const mediaUrl = req.body.MediaUrl0;
  const mediaContentType = req.body.MediaContentType0 || 'image/jpeg';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  console.log(`📩 From ${from}: "${rawBody}" | Media: ${numMedia}`);

  if (isAgroUser(from)) {
    try {
      await handleAgroMessage(from, rawBody || '(sin texto)');
    } catch (err) {
      console.error('❌ Agro bot error:', err.message);
      await sendMessage(from, 'Lo siento, ocurrió un error. Intenta de nuevo 🙏');
    }
    return;
  }

  const currentState = getState(from);

  if (['hola', 'hello', 'hi', 'reset', 'start', 'menu'].includes(body)) {
    setState(from, 'waiting_for_photo');
    await sendMessage(from, '👋 Hi! Send me a Lila Miami product photo and I\'ll create your branded Instagram post! 📸');
    return;
  }

  if (currentState === 'waiting_for_photo') {
    if (numMedia > 0 && mediaUrl) {
      await processPhoto(from, mediaUrl, mediaContentType, rawBody);
    } else {
      await sendMessage(from, '📷 Please send a photo! I need to see the product to create the post.');
    }
    return;
  }

  if (currentState === 'waiting_for_approval') {
    const isYes = ['yes', 'si', 'sí', 'yep', 'yeah', 'ok', 'perfect', 'perfecto', 'listo'].some(w => body.includes(w));
    const isRecreate = ['recreate', 'otra', 'again', 'new', 'different', 'cambiar', 'otro'].some(w => body.includes(w));
    const isNo = ['no', 'cancel', 'cancelar', 'nope', 'stop'].includes(body);

    if (isYes) {
      setState(from, 'idle');
      await sendMessage(from, '✅ Your post is ready!\n\nSave the image above + copy the caption and hashtags → post on Instagram 🚀\n\n💎 Consistency is everything — keep posting!');
    } else if (isRecreate) {
      setState(from, 'waiting_for_photo');
      await sendMessage(from, '🔄 Got it! Resend the photo and I\'ll create a completely different version 📸');
    } else if (isNo) {
      setState(from, 'idle');
      await sendMessage(from, 'No problem! Whenever you\'re ready, just send a photo 📸');
    } else if (numMedia > 0 && mediaUrl) {
      await processPhoto(from, mediaUrl, mediaContentType, rawBody);
    } else {
      await sendMessage(from, 'Reply *YES* to confirm ✅, *RECREATE* for a new version 🔄, or *NO* to cancel ❌');
    }
    return;
  }

  // IDLE
  if (numMedia > 0 && mediaUrl) {
    setState(from, 'waiting_for_photo');
    await processPhoto(from, mediaUrl, mediaContentType, rawBody);
  } else {
    setState(from, 'waiting_for_photo');
    await sendMessage(from, '👋 Hi! Send me a Lila Miami product photo and I\'ll create your branded Instagram post! 📸');
  }
});

app.get('/', (req, res) => res.send('Lila Miami WhatsApp Bot is running 💎'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💎 Lila Miami WhatsApp Bot running on port ${PORT}`);
  console.log(`📅 Daily ping scheduled for 10:00 AM Miami time`);
});
