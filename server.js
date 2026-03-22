require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const cron = require('node-cron');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Load font as base64 at startup for SVG embedding
const fontPath = path.join(__dirname, 'fonts', 'Roboto-Regular.ttf');
const FONT_BASE64 = fs.existsSync(fontPath) ? fs.readFileSync(fontPath).toString('base64') : null;

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
  const GRAD_H = 380;

  // 1. Resize to Instagram square
  const resized = await sharp(imageBuffer)
    .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
    .toBuffer();

  // 2. Clean caption text
  const clean = stripEmojis(captionText).substring(0, 160);

  // 3. Dark gradient overlay (pure SVG, no text — this always works)
  const gradientSvg = Buffer.from(
    `<svg width="${SIZE}" height="${GRAD_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.82"/>
        </linearGradient>
      </defs>
      <rect width="${SIZE}" height="${GRAD_H}" fill="url(#g)"/>
    </svg>`
  );

  // 4. Caption text — sharp's native text input using font file directly
  const captionImg = await sharp({
    text: {
      text: clean,
      fontfile: fontPath,
      rgba: true,
      width: SIZE - 100,
      dpi: 130,
      wrap: 'word',
    },
  }).png().toBuffer();

  const { height: captionH = 120 } = await sharp(captionImg).metadata();

  // 5. @lilamiami watermark — rendered then tinted gold
  const watermarkRaw = await sharp({
    text: {
      text: '@lilamiami',
      fontfile: fontPath,
      rgba: true,
      dpi: 90,
    },
  }).png().toBuffer();

  const watermarkImg = await sharp(watermarkRaw)
    .tint({ r: 212, g: 175, b: 55 })
    .png()
    .toBuffer();

  // 6. Composite all layers
  const branded = await sharp(resized)
    .composite([
      { input: gradientSvg, top: SIZE - GRAD_H, left: 0 },
      { input: captionImg, top: SIZE - captionH - 90, left: 50 },
      { input: watermarkImg, top: SIZE - 55, left: 50 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  return branded;
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
  // Pull text between CAPTION section and the next section
  const match = fullContent.match(/📝\s*CAPTION\s*\n([\s\S]*?)(?=\n#️⃣|\n⏰|\n💡|$)/i);
  if (match) return match[1].trim();
  // Fallback: first 2 sentences
  const sentences = fullContent.split(/[.!?]/);
  return sentences.slice(0, 2).join('. ').trim() + '.';
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

async function processPhoto(from, mediaUrl, mediaContentType, caption) {
  await sendMessage(from, '📸 Got it! Creating your branded post... give me a sec ✨');

  try {
    const { buffer, contentType } = await downloadImageBuffer(mediaUrl);
    const base64 = buffer.toString('base64');

    // Generate content with Claude
    const content = await generateContent(base64, contentType, caption);
    lastContent[from] = content;

    // Extract caption for image overlay
    const shortCaption = extractCaption(content);

    // Create branded image
    const brandedBuffer = await createBrandedImage(buffer, shortCaption);

    // Upload to ImgBB
    const imageUrl = await uploadToImgBB(brandedBuffer);

    setState(from, 'waiting_for_approval');

    // Send branded image first
    await sendImageMessage(from, imageUrl, '💎 Here\'s your branded Instagram post:');

    // Then send full text content
    await sendMessage(from, content);
    await sendMessage(from, '---\nReply *YES* to confirm ✅\nReply *RECREATE* for a different version 🔄\nReply *NO* to cancel ❌');

  } catch (err) {
    console.error('❌ Error generating content:', err.message);
    await sendMessage(from, 'Something went wrong. Try sending the photo again! 🙏');
    setState(from, 'waiting_for_photo');
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
