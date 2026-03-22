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
const TextToSVG = require('text-to-svg');

let captionTTS = null;
let taglineTTS = null;
try {
  captionTTS = TextToSVG.loadSync(path.join(__dirname, 'fonts', 'PlayfairDisplay-Italic.ttf'));
  taglineTTS = TextToSVG.loadSync(path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'));
  console.log('✅ Fonts loaded: Playfair Display Italic + Roboto');
} catch (e) {
  console.warn('⚠️ Font load failed, will use bitmap fallback:', e.message);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// In-memory image store — serves images to Instagram (ImgBB blocks IG crawlers)
const imageStore = new Map();
app.get('/img/:id', (req, res) => {
  const buf = imageStore.get(req.params.id);
  if (!buf) return res.status(404).send('Not found');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(buf);
});

function storeImageForInstagram(buffer) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  imageStore.set(id, buffer);
  setTimeout(() => imageStore.delete(id), 15 * 60 * 1000); // auto-cleanup after 15 min
  const base = process.env.BASE_URL || 'https://lila-whatsapp-bot-production.up.railway.app';
  return `${base}/img/${id}`;
}

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

const NAMES = {
  'whatsapp:+13055049095': 'Leo',
  'whatsapp:+17868438920': 'Dani',
  'whatsapp:+17864898034': 'Maria',
};

function getName(number) {
  return NAMES[number] || 'there';
}

const state = {};
const lastContent = {};
const lastImageUrl = {};
const lastCaption = {};
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
  for (const number of GROUP) {
    try {
      const name = getName(number);
      const message = `Good morning, ${name}! ☀️ Ready for today's Lila Miami post?\n\nJust send me a product photo and I'll take care of everything — branded image, caption, hashtags, and I'll post it straight to Instagram for you. 💎`;
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

  // Clean caption — first complete sentence only, max 55 chars
  let clean = stripEmojis(captionText);
  const dot = clean.search(/[.!?]/);
  if (dot > 10 && dot < 100) {
    clean = clean.substring(0, dot + 1);
  } else {
    clean = clean.substring(0, 55);
    const sp = clean.lastIndexOf(' ');
    if (sp > 15) clean = clean.substring(0, sp) + '...';
  }
  console.log(`🖊️ Drawing: "${clean}"`);

  // Word wrap (~22 chars per line at 68px)
  const words = clean.split(' ');
  const svgLines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (test.length > 22) {
      if (cur) svgLines.push(cur);
      cur = w;
      if (svgLines.length >= 3) break;
    } else {
      cur = test;
    }
  }
  if (cur && svgLines.length < 4) svgLines.push(cur);

  // --- text-to-svg path rendering (Playfair Display Italic) ---
  if (captionTTS && taglineTTS) {
    const GOLD = '#F5D285';       // warm champagne gold
    const WHITE = 'rgba(255,255,255,0.90)';
    const lineH = 86;
    // Push caption higher so tagline never overlaps
    const captionY = SIZE - 210 - (svgLines.length - 1) * lineH;
    const decorLineY = captionY - 18;  // thin gold line above text

    let captionPaths = '';
    svgLines.forEach((line, i) => {
      captionPaths += captionTTS.getPath(line, {
        fontSize: 72,
        anchor: 'top left',
        x: 60,
        y: captionY + i * lineH,
        attributes: { fill: GOLD, filter: 'url(#ts)' },
      });
    });

    const taglinePath = taglineTTS.getPath("MIAMI'S EVERYDAY GOLD", {
      fontSize: 19,
      anchor: 'top left',
      x: 60,
      y: SIZE - 48,
      attributes: { fill: WHITE },
    });

    const lilaText = '@lilamiami';
    const lilaW = taglineTTS.getMetrics(lilaText, { fontSize: 19 }).width;
    const lilaPath = taglineTTS.getPath(lilaText, {
      fontSize: 19,
      anchor: 'top left',
      x: SIZE - 60 - lilaW,
      y: SIZE - 48,
      attributes: { fill: WHITE },
    });

    const textSvg = Buffer.from(
      `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="black" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="0.88"/>
          </linearGradient>
          <filter id="ts" x="-5%" y="-10%" width="110%" height="130%">
            <feDropShadow dx="1" dy="2" stdDeviation="3" flood-color="black" flood-opacity="0.75"/>
          </filter>
        </defs>
        <rect x="0" y="${SIZE - 480}" width="${SIZE}" height="480" fill="url(#g)"/>
        <line x1="60" y1="${decorLineY}" x2="280" y2="${decorLineY}" stroke="#F5D285" stroke-width="1.5" opacity="0.75"/>
        ${captionPaths}
        ${taglinePath}
        ${lilaPath}
      </svg>`
    );

    return await sharp(vignetteBuffer)
      .composite([{ input: textSvg, top: 0, left: 0 }])
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  // --- Jimp bitmap fallback (if fonts failed to load) ---
  const image = await Jimp.read(vignetteBuffer);
  const gradStart = Math.floor(SIZE * 0.58);
  for (let y = gradStart; y < SIZE; y++) {
    const alpha = Math.floor(((y - gradStart) / (SIZE - gradStart)) * 180);
    for (let x = 0; x < SIZE; x++) {
      const color = image.getPixelColor(x, y);
      const r = (color >> 24) & 0xff;
      const g = (color >> 16) & 0xff;
      const b = (color >> 8) & 0xff;
      const nr = Math.max(0, r - Math.floor(r * alpha / 255));
      const ng = Math.max(0, g - Math.floor(g * alpha / 255));
      const nb = Math.max(0, b - Math.floor(b * alpha / 255));
      image.setPixelColor(Jimp.rgbaToInt(nr, ng, nb, 255), x, y);
    }
  }
  const font64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const font16 = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  image.print(font64, 50, SIZE - 300, { text: clean, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, SIZE - 100, 240);
  image.print(font16, 50, SIZE - 55, "MIAMI'S EVERYDAY GOLD");
  image.print(font16, SIZE - 220, SIZE - 55, '@lilamiami');
  return await image.getBufferAsync(Jimp.MIME_JPEG);
}

async function postToInstagram(imageUrl, caption) {
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;

  console.log(`📸 Posting to Instagram. Image URL: ${imageUrl}`);

  // Step 1: Create media container
  const containerRes = await axios.post(
    `https://graph.instagram.com/v21.0/${igUserId}/media`,
    null,
    {
      params: {
        image_url: imageUrl,
        caption: caption,
        access_token: token,
      }
    }
  );
  console.log(`📦 Container response:`, JSON.stringify(containerRes.data));
  const creationId = containerRes.data.id;
  if (!creationId) throw new Error('No container ID returned: ' + JSON.stringify(containerRes.data));

  // Step 2: Wait for container to be ready
  await new Promise(r => setTimeout(r, 3000));

  // Step 3: Check status
  const statusRes = await axios.get(`https://graph.instagram.com/v21.0/${creationId}`, {
    params: { fields: 'status_code,status', access_token: token }
  });
  console.log(`📊 Container status:`, JSON.stringify(statusRes.data));

  // Step 4: Publish
  const publishRes = await axios.post(
    `https://graph.instagram.com/v21.0/${igUserId}/media_publish`,
    null,
    { params: { creation_id: creationId, access_token: token } }
  );
  console.log('✅ Posted to Instagram:', JSON.stringify(publishRes.data));
}

async function uploadToImgBB(imageBuffer) {
  const base64 = imageBuffer.toString('base64');
  const params = new URLSearchParams({ key: process.env.IMGBB_API_KEY, image: base64, name: 'lila-post.jpg' });
  const response = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const data = response.data.data;
  console.log(`🖼️ ImgBB URL: ${data.url}`);
  return data.url;
}

function extractInstagramCaption(fullContent) {
  // Extract caption text (first 2 sentences)
  const captionMatch = fullContent.match(/CAPTION[^\n]*\n+([\s\S]*?)(?=\n\s*(?:HASHTAG|BEST TIME|QUICK TIP|#|⏰|💡)|$)/i);
  const captionText = captionMatch ? captionMatch[1].trim() : '';

  // Extract hashtags block
  const hashtagMatch = fullContent.match(/HASHTAG[^\n]*\n+([\s\S]*?)(?=\n\s*(?:BEST TIME|QUICK TIP|⏰|💡)|$)/i);
  const hashtags = hashtagMatch ? hashtagMatch[1].trim() : '';

  return [captionText, hashtags].filter(Boolean).join('\n\n').substring(0, 2200);
}

function extractCaption(fullContent) {
  // Find CAPTION section — robust, works regardless of emoji variant
  const match = fullContent.match(/CAPTION[^\n]*\n+([\s\S]*?)(?=\n\s*(?:HASHTAG|BEST TIME|QUICK TIP|#|⏰|💡)|$)/i);
  if (match) {
    const text = match[1].trim().replace(/[^\x20-\x7E\s]/g, '').trim();
    // Take FIRST sentence only (cleaner overlay text)
    const parts = text.split(/(?<=[.!?])\s+/);
    return parts[0].substring(0, 120).trim();
  }
  // Fallback: first 120 chars stripped of emojis
  return fullContent.replace(/[^\x20-\x7E\s]/g, '').trim().substring(0, 120);
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
2-3 sentences. IMPORTANT: Start with a short, punchy first sentence under 55 characters that ends with a period, exclamation, or question mark. Then 1-2 follow-up sentences. Include 1-2 tasteful emojis. Speak to the modern Miami woman.

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

    // Upload to ImgBB (for WhatsApp preview)
    const imageUrl = await uploadToImgBB(brandedBuffer);

    // Store in memory for Instagram (ImgBB blocked by IG crawlers)
    const igImageUrl = storeImageForInstagram(brandedBuffer);
    lastImageUrl[from] = igImageUrl;
    console.log(`📸 Instagram URL: ${igImageUrl}`);

    // Extract full caption + hashtags for Instagram post
    const igCaption = extractInstagramCaption(content);
    lastCaption[from] = igCaption;

    setState(from, 'waiting_for_approval');

    // Send branded image
    await sendImageMessage(from, imageUrl, '💎 Here\'s your branded Instagram post:');

    // Send content split into chunks (Twilio 1600 char limit)
    for (const chunk of splitMessage(content)) {
      await sendMessage(from, chunk);
    }
    await sendMessage(from, `What do you think, ${getName(from)}? 👆\n\n*YES* — post it to Instagram ✅\n*RECREATE* — try a different version 🔄\n*NO* — skip this one ❌`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    await sendMessage(from, `Sorry ${getName(from)}, something went wrong. Try sending the photo again and I'll get it right! 🙏`);
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
    await sendMessage(from, `Hi ${getName(from)}! 👋 Send me a Lila Miami product photo and I'll create a branded post ready for Instagram. 💎`);
    return;
  }

  if (currentState === 'waiting_for_photo') {
    if (numMedia > 0 && mediaUrl) {
      await processPhoto(from, mediaUrl, mediaContentType, rawBody);
    } else {
      await sendMessage(from, `Go ahead and send me the photo, ${getName(from)}! 📸 I'll handle the rest.`);
    }
    return;
  }

  if (currentState === 'waiting_for_approval') {
    const isYes = ['yes', 'si', 'sí', 'yep', 'yeah', 'ok', 'perfect', 'perfecto', 'listo'].some(w => body.includes(w));
    const isRecreate = ['recreate', 'otra', 'again', 'new', 'different', 'cambiar', 'otro'].some(w => body.includes(w));
    const isNo = ['no', 'cancel', 'cancelar', 'nope', 'stop'].includes(body);

    if (isYes) {
      setState(from, 'idle');
      await sendMessage(from, `On it, ${getName(from)}! Posting to Instagram now... ⏳`);
      try {
        await postToInstagram(lastImageUrl[from], lastCaption[from]);
        await sendMessage(from, `Done! 🎉 It's live on Instagram. Great content, ${getName(from)} — keep it up! 💎`);
      } catch (igErr) {
        console.error('❌ Instagram post failed:', igErr.response?.data || igErr.message);
        await sendMessage(from, `Hmm, Instagram didn't accept it this time. The image is saved so you can post it manually. Sorry about that! 🙏\n\nError: ` + (igErr.response?.data?.error?.message || igErr.message));
      }
    } else if (isRecreate) {
      setState(from, 'waiting_for_photo');
      await sendMessage(from, `No problem, ${getName(from)}! Send me the photo again and I'll come up with a completely different look. 🔄`);
    } else if (isNo) {
      setState(from, 'idle');
      await sendMessage(from, `Got it! Whenever you're ready for the next one, just send me a photo. 📸`);
    } else if (numMedia > 0 && mediaUrl) {
      await processPhoto(from, mediaUrl, mediaContentType, rawBody);
    } else {
      await sendMessage(from, `Just reply *YES* to post it, *RECREATE* for a new version, or *NO* to skip. 😊`);
    }
    return;
  }

  // IDLE
  if (numMedia > 0 && mediaUrl) {
    setState(from, 'waiting_for_photo');
    await processPhoto(from, mediaUrl, mediaContentType, rawBody);
  } else {
    setState(from, 'waiting_for_photo');
    await sendMessage(from, `Hi ${getName(from)}! 👋 Send me a Lila Miami product photo and I'll create a branded post ready for Instagram. 💎`);
  }
});

app.get('/', (req, res) => res.send('Lila Miami WhatsApp Bot is running 💎'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💎 Lila Miami WhatsApp Bot running on port ${PORT}`);
  console.log(`📅 Daily ping scheduled for 10:00 AM Miami time`);
});
