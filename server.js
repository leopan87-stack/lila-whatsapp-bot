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

let fontItalic = null;   // Playfair Display Italic — body text
let fontBold = null;     // Playfair Display Bold — big impact word
let fontScript = null;   // Dancing Script Bold — accent/script word
let fontTagline = null;  // Roboto — small tagline
try {
  fontItalic  = TextToSVG.loadSync(path.join(__dirname, 'fonts', 'PlayfairDisplay-Italic.ttf'));
  fontBold    = TextToSVG.loadSync(path.join(__dirname, 'fonts', 'PlayfairDisplay-Bold.ttf'));
  fontScript  = TextToSVG.loadSync(path.join(__dirname, 'fonts', 'DancingScript-Bold.ttf'));
  fontTagline = TextToSVG.loadSync(path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'));
  console.log('✅ Fonts loaded: Playfair Bold + Italic + Dancing Script + Roboto');
} catch (e) {
  console.warn('⚠️ Font load failed, will use bitmap fallback:', e.message);
}

// Alias for existing code
const captionTTS = fontItalic;
const taglineTTS = fontTagline;

const GOOGLE_AI_KEY = process.env.GOOGLE_AI_KEY;

async function createBrandedImageAI(imageBuffer, captionText, withModel = false) {
  const SIZE = 1080;
  const GOLD = '#F5D285';
  const base64Image = imageBuffer.toString('base64');

  // ── Step 1: Gemini enhances photo ──
  const bgPrompt = withModel
    ? `You are a professional jewelry photographer for Lila Miami, a luxury jewelry brand in Miami.
Using the product photo as reference, generate a close-up lifestyle photo of the jewelry being worn — NO face, NO head.

- Frame the shot tightly on the body part where the jewelry sits: wrist and hand for a bracelet, neck and collarbone for a necklace, earlobe and neck for earrings, finger for a ring
- The face must NOT appear in the frame at all — crop well above or below it
- Warm Latina skin tone, matte and natural — skin looks real, not oily, not shiny, not plastic
- Skin has subtle visible texture: fine pores, faint hair follicles, natural variation in tone — no airbrushing
- NO specular highlights or wet-looking shine on skin — matte finish like real skin in soft light
- Skin color is warm and even but not perfect — slight natural variation between wrist, knuckles, and fingers
- The jewelry must match EXACTLY the design, colors, stones, and materials from the reference photo
- The jewelry is the clear hero of the shot — well-lit, sharp, and beautiful
- Background is soft, warm, slightly blurred — lifestyle feel, real environment
- Lighting is diffused and soft — no harsh flash, no direct sun creating shine or hot spots on skin
- The photo must look like a real professional camera shot, not AI-generated
- Output: square 1:1 format, photorealistic, no text, no watermarks`
    : `You are a luxury photographer for Lila Miami, a jewelry brand in Miami.
Transform this photo into an editorial Instagram image:
- If there is a person in the photo, keep them EXACTLY as-is — do NOT alter their face, body, skin, or appearance in any way
- Keep the jewelry EXACTLY as-is — same shape, colors, materials, design — do NOT modify it
- Replace or enhance the background creatively — choose a setting that complements the jewelry's colors, style, and mood
- Enhance the lighting to make the jewelry glow and the overall image look luxurious and editorial
- Output: square 1:1 format, photorealistic, no text, no watermarks`;

  let enhancedBuffer;
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_AI_KEY}`,
      {
        contents: [{ parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
          { text: bgPrompt }
        ]}],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      }
    );
    const parts = response.data.candidates[0].content.parts;
    const imgPart = parts.find(p => p.inlineData);
    if (imgPart) {
      // Use cover now — WE add text via SVG, so cropping Gemini's output is fine
      enhancedBuffer = await sharp(Buffer.from(imgPart.inlineData.data, 'base64'))
        .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 95 })
        .toBuffer();
      console.log('✅ Gemini enhanced background successfully');
    } else {
      const textPart = parts.find(p => p.text);
      console.warn('⚠️ Gemini returned no image. Text response:', textPart?.text?.substring(0, 200));
    }
  } catch (e) {
    console.warn('⚠️ Gemini failed:', e.response?.data?.error?.message || e.message);
  }

  // Fallback: if Gemini failed, use the original photo — still gets our text overlay
  if (!enhancedBuffer) {
    enhancedBuffer = await sharp(imageBuffer)
      .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
      .modulate({ brightness: 0.88, saturation: 1.15 })
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  // ── Step 2: Our code adds text — 100% guaranteed, consistent every time ──
  // Strip markdown formatting Claude may add (**bold**, *italic*, ## headings)
  let clean = stripEmojis(captionText).replace(/\*\*/g, '').replace(/\*/g, '').replace(/#+\s*/g, '').trim();
  const dot = clean.search(/[.!?]/);
  if (dot > 10 && dot < 100) clean = clean.substring(0, dot + 1);
  else { clean = clean.substring(0, 55); const sp = clean.lastIndexOf(' '); if (sp > 15) clean = clean.substring(0, sp) + '...'; }
  console.log(`🖊️ Adding text overlay: "${clean}"`);

  const captionLines = wrapText(clean, 22, 3);
  const lineH = 72;
  const totalTextH = captionLines.length * lineH;
  // Caption centered, sitting 120px above the tagline area
  const captionY = SIZE - 140 - totalTextH;

  let captionPaths = '';
  captionLines.forEach((line, i) => {
    if (!fontItalic) return;
    const metrics = fontItalic.getMetrics(line, { fontSize: 62 });
    const x = (SIZE - metrics.width) / 2;
    captionPaths += fontItalic.getPath(line, {
      fontSize: 62, anchor: 'top left', x, y: captionY + i * lineH,
      attributes: { fill: GOLD, filter: 'url(#ts)' },
    });
  });

  const taglines = fontTagline ? buildTaglineAndHandle(SIZE) : '';

  const textSvg = Buffer.from(`<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.88"/>
      </linearGradient>
      <filter id="ts" x="-10%" y="-20%" width="130%" height="160%">
        <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="black" flood-opacity="0.9"/>
      </filter>
    </defs>
    <rect x="0" y="${SIZE - 320}" width="${SIZE}" height="320" fill="url(#gb)"/>
    ${captionPaths}
    ${taglines}
  </svg>`);

  return await sharp(enhancedBuffer)
    .composite([{ input: textSvg, top: 0, left: 0 }])
    .jpeg({ quality: 95 })
    .toBuffer();
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
const pendingPhoto = {}; // stores photo info while waiting for keywords
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
      const message = `Good morning, ${name}! ☀️ Ready to create today's Lila Miami post?\n\nSend me a product photo 📸 — or would you like me to pull a piece from your new arrivals on the website and post it for you? Just say *website*! 💎`;
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

async function fetchNewCollection() {
  const res = await axios.get(
    'https://lilamiami.com/collections/new/products.json?limit=30',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  return res.data.products || [];
}

function getTodayProduct(products) {
  // Rotate through products — different one each day
  const dayIndex = Math.floor(Date.now() / 86400000);
  return products[dayIndex % products.length];
}

async function handleWebsitePull(from) {
  await sendMessage(from, `On it, ${getName(from)}! Pulling today's product from the Lila Miami new collection... 🛍️`);
  try {
    const products = await fetchNewCollection();
    if (!products.length) {
      await sendMessage(from, `Hmm, couldn't reach the store right now. Send me a photo instead! 📸`);
      return;
    }

    const product = getTodayProduct(products);
    const imageUrl = product.images?.[0]?.src;
    if (!imageUrl) {
      await sendMessage(from, `Today's product has no image. Send me a photo instead! 📸`);
      return;
    }

    const keywords = `${product.title}. ${(product.body_html || '').replace(/<[^>]+>/g, '').substring(0, 200)}`;
    await sendMessage(from, `Today's featured product: *${product.title}* 💎\n\nCreating your post now...`);

    const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(imgRes.data);
    const base64 = buffer.toString('base64');
    const content = await generateContent(base64, 'image/jpeg', keywords);
    lastContent[from] = content;

    const shortCaption = extractCaption(content);
    let brandedBuffer;
    try { brandedBuffer = await createBrandedImage(buffer, shortCaption); }
    catch (e) { brandedBuffer = await sharp(buffer).resize(1080, 1080, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer(); }

    const whatsappUrl = await uploadToImgBB(brandedBuffer);
    const igUrl = storeImageForInstagram(brandedBuffer);
    lastImageUrl[from] = igUrl;
    lastCaption[from] = extractInstagramCaption(content);
    setState(from, 'waiting_for_approval');

    await sendImageMessage(from, whatsappUrl, `What do you think, ${getName(from)}? 👆\n\n*YES* — post it to Instagram ✅\n*RECREATE* — try a different version 🔄\n*NO* — skip this one ❌`);
    for (const chunk of splitMessage(extractInstagramCaption(content))) await sendMessage(from, chunk);

  } catch (err) {
    console.error('❌ Website pull error:', err.message);
    await sendMessage(from, `Couldn't reach the store right now. Send me a photo instead! 📸`);
  }
}

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

function wrapText(text, charsPerLine, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (test.length > charsPerLine) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= maxLines - 1) { lines.push(cur); break; }
    } else cur = test;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

function buildTaglineAndHandle(SIZE) {
  if (!fontTagline) return '';
  const tagPath = fontTagline.getPath("MIAMI'S EVERYDAY GOLD", {
    fontSize: 18, anchor: 'top left', x: 60, y: SIZE - 46,
    attributes: { fill: 'rgba(255,255,255,0.80)' },
  });
  const lilaText = '@lilamiami';
  const lilaW = fontTagline.getMetrics(lilaText, { fontSize: 18 }).width;
  const lilaPath = fontTagline.getPath(lilaText, {
    fontSize: 18, anchor: 'top left', x: SIZE - 60 - lilaW, y: SIZE - 46,
    attributes: { fill: 'rgba(255,255,255,0.80)' },
  });
  return tagPath + lilaPath;
}

async function createBrandedImage(imageBuffer, captionText) {
  const SIZE = 1080;
  const GOLD = '#F5D285';
  const GOLD_DIM = 'rgba(245,210,133,0.85)';
  const WHITE = 'rgba(255,255,255,0.92)';

  // Photo editing — warm luxury look
  const editedBuffer = await sharp(imageBuffer)
    .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
    .modulate({ brightness: 1.08, saturation: 1.35, hue: 8 })
    .linear(1.15, -15)
    .sharpen({ sigma: 0.8 })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Vignette
  const vignetteSvg = Buffer.from(`<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="v" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="black" stop-opacity="0"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.45"/>
    </radialGradient></defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#v)"/>
  </svg>`);

  const baseBuffer = await sharp(editedBuffer)
    .composite([{ input: vignetteSvg, blend: 'multiply' }])
    .jpeg({ quality: 95 })
    .toBuffer();

  // Clean caption
  let clean = stripEmojis(captionText);
  const dot = clean.search(/[.!?]/);
  if (dot > 10 && dot < 100) clean = clean.substring(0, dot + 1);
  else { clean = clean.substring(0, 55); const sp = clean.lastIndexOf(' '); if (sp > 15) clean = clean.substring(0, sp) + '...'; }
  console.log(`🖊️ Style layout, caption: "${clean}"`);

  // Pick layout style — rotate every post
  const style = Math.floor(Date.now() / 1000) % 3;

  if (!fontBold || !fontItalic || !fontScript || !fontTagline) {
    // Jimp fallback
    const image = await Jimp.read(baseBuffer);
    const font64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    const font16 = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    image.print(font64, 50, SIZE - 300, { text: clean, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, SIZE - 100, 240);
    image.print(font16, 50, SIZE - 55, "MIAMI'S EVERYDAY GOLD");
    image.print(font16, SIZE - 220, SIZE - 55, '@lilamiami');
    return await image.getBufferAsync(Jimp.MIME_JPEG);
  }

  let textSvgStr = '';

  if (style === 0) {
    // ── STYLE 1: Bold impact word top-left + italic caption bottom ──
    // Extract first word as BIG impact word
    const impactWord = clean.split(' ')[0].replace(/[.,!?]/, '').toUpperCase();
    const restWords = clean.split(' ').slice(1).join(' ');
    const restLines = wrapText(restWords, 24, 3);

    const impactPath = fontBold.getPath(impactWord, {
      fontSize: 130, anchor: 'top left', x: 55, y: 60,
      attributes: { fill: GOLD, filter: 'url(#ts)' },
    });
    const impactW = fontBold.getMetrics(impactWord, { fontSize: 130 }).width;
    const accentLine = `<line x1="55" y1="200" x2="${Math.min(55 + impactW, SIZE - 60)}" y2="200" stroke="${GOLD}" stroke-width="2" opacity="0.6"/>`;

    let restPaths = '';
    restLines.forEach((line, i) => {
      restPaths += fontItalic.getPath(line, {
        fontSize: 58, anchor: 'top left', x: 60, y: SIZE - 200 - (restLines.length - 1 - i) * 68,
        attributes: { fill: WHITE, filter: 'url(#ts)' },
      });
    });

    textSvgStr = `
      <defs>
        <linearGradient id="gt" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="40%" stop-color="black" stop-opacity="0.5"/>
        </linearGradient>
        <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.85"/>
        </linearGradient>
        <filter id="ts" x="-5%" y="-10%" width="120%" height="140%">
          <feDropShadow dx="1" dy="2" stdDeviation="4" flood-color="black" flood-opacity="0.8"/>
        </filter>
      </defs>
      <rect x="0" y="0" width="${SIZE}" height="240" fill="url(#gt)"/>
      <rect x="0" y="${SIZE - 430}" width="${SIZE}" height="430" fill="url(#gb)"/>
      ${impactPath}
      ${accentLine}
      ${restPaths}
      ${buildTaglineAndHandle(SIZE)}`;

  } else if (style === 1) {
    // ── STYLE 2: Centered script + bold — editorial center block ──
    const scriptLines = wrapText(clean, 20, 2);
    const centerY = SIZE / 2 - (scriptLines.length * 80) / 2;

    let scriptPaths = '';
    scriptLines.forEach((line, i) => {
      const metrics = fontScript.getMetrics(line, { fontSize: 88 });
      const x = (SIZE - metrics.width) / 2;
      scriptPaths += fontScript.getPath(line, {
        fontSize: 88, anchor: 'top left', x, y: centerY + i * 100,
        attributes: { fill: GOLD, filter: 'url(#ts)' },
      });
    });

    // Thin gold frame
    const pad = 40;
    const frame = `<rect x="${pad}" y="${pad}" width="${SIZE - pad * 2}" height="${SIZE - pad * 2}"
      fill="none" stroke="${GOLD}" stroke-width="1.5" opacity="0.5"/>`;

    textSvgStr = `
      <defs>
        <radialGradient id="gc" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="black" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.75"/>
        </radialGradient>
        <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.80"/>
        </linearGradient>
        <filter id="ts" x="-5%" y="-10%" width="120%" height="140%">
          <feDropShadow dx="1" dy="2" stdDeviation="4" flood-color="black" flood-opacity="0.8"/>
        </filter>
      </defs>
      <rect width="${SIZE}" height="${SIZE}" fill="url(#gc)"/>
      <rect x="0" y="${SIZE - 300}" width="${SIZE}" height="300" fill="url(#gb)"/>
      ${frame}
      ${scriptPaths}
      ${buildTaglineAndHandle(SIZE)}`;

  } else {
    // ── STYLE 3: Full bottom dark panel — bold large + script small ──
    const boldLines = wrapText(clean, 18, 2);
    const panelH = 360;
    const boldY = SIZE - panelH + 40;

    let boldPaths = '';
    boldLines.forEach((line, i) => {
      boldPaths += fontBold.getPath(line, {
        fontSize: 82, anchor: 'top left', x: 60, y: boldY + i * 96,
        attributes: { fill: GOLD, filter: 'url(#ts)' },
      });
    });

    // Script accent word — "by @lilamiami" style
    const scriptAccent = fontScript.getPath('everyday gold.', {
      fontSize: 52, anchor: 'top left', x: 62, y: boldY + boldLines.length * 96 + 8,
      attributes: { fill: 'rgba(255,255,255,0.75)', filter: 'url(#ts)' },
    });

    const lilaText = '@lilamiami';
    const lilaW = fontTagline.getMetrics(lilaText, { fontSize: 18 }).width;
    const lilaPath = fontTagline.getPath(lilaText, {
      fontSize: 18, anchor: 'top left', x: SIZE - 60 - lilaW, y: SIZE - 46,
      attributes: { fill: 'rgba(255,255,255,0.80)' },
    });
    const tagPath = fontTagline.getPath("MIAMI'S EVERYDAY GOLD", {
      fontSize: 18, anchor: 'top left', x: 60, y: SIZE - 46,
      attributes: { fill: 'rgba(255,255,255,0.80)' },
    });

    // Gold accent line
    const accentLine = `<line x1="60" y1="${boldY - 16}" x2="200" y2="${boldY - 16}" stroke="${GOLD}" stroke-width="1.5" opacity="0.7"/>`;

    textSvgStr = `
      <defs>
        <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.92"/>
        </linearGradient>
        <filter id="ts" x="-5%" y="-10%" width="120%" height="140%">
          <feDropShadow dx="1" dy="2" stdDeviation="4" flood-color="black" flood-opacity="0.8"/>
        </filter>
      </defs>
      <rect x="0" y="${SIZE - panelH}" width="${SIZE}" height="${panelH}" fill="url(#gb)"/>
      ${accentLine}
      ${boldPaths}
      ${scriptAccent}
      ${tagPath}
      ${lilaPath}`;
  }

  const textSvg = Buffer.from(`<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">${textSvgStr}</svg>`);

  return await sharp(baseBuffer)
    .composite([{ input: textSvg, top: 0, left: 0 }])
    .jpeg({ quality: 95 })
    .toBuffer();
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
  // Caption text only
  const captionMatch = fullContent.match(/CAPTION[^\n]*\n+([\s\S]*?)(?=\n\s*(?:HASHTAG|BEST TIME|QUICK TIP|#️⃣|⏰|💡)|$)/i);
  const captionText = captionMatch ? captionMatch[1].trim() : '';

  // Hashtags only — stop before BEST TIME or QUICK TIP
  const hashtagMatch = fullContent.match(/HASHTAG[^\n]*\n+([\s\S]*?)(?=\n\s*(?:BEST TIME|QUICK TIP|⏰|💡)|$)/i);
  const hashtags = hashtagMatch ? hashtagMatch[1].trim() : '';

  // Only caption + hashtags — no tips or timing info
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

When given a product photo, generate an Instagram post with these 2 sections:

📝 CAPTION
2-3 sentences. IMPORTANT: Start with a short, punchy first sentence under 55 characters that ends with a period, exclamation, or question mark. Then 1-2 follow-up sentences. Include 1-2 tasteful emojis. Speak to the modern Miami woman.

#️⃣ HASHTAGS
25 relevant hashtags. Mix popular (#jewelry #gold) with niche (#miamijewelry #lilamiami #goldjewelry #handpickedjewelry) and lifestyle tags (#miamiwoman #everydayluxury).`,
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

async function processPhoto(from, mediaUrl, mediaContentType, caption, withModel = false) {
  if (processing.has(from)) return; // ignore duplicate webhook
  processing.add(from);
  await sendMessage(from, withModel
    ? `Love it! Generating your post with a model wearing it, ${getName(from)}... 👗✨`
    : `Perfect! Give me a moment while I create your post, ${getName(from)}... ✨`);

  try {
    const { buffer, contentType } = await downloadImageBuffer(mediaUrl);
    const base64 = buffer.toString('base64');

    // Generate content with Claude
    const content = await generateContent(base64, contentType, caption);
    lastContent[from] = content;

    // Extract short caption for image overlay
    const shortCaption = extractCaption(content);
    console.log(`📝 Extracted caption: "${shortCaption.substring(0, 100)}..."`);

    // Create branded image — try Gemini AI first, fall back to sharp/SVG
    let brandedBuffer;
    if (GOOGLE_AI_KEY) {
      try {
        console.log('🎨 Using Gemini AI image enhancement...');
        brandedBuffer = await createBrandedImageAI(buffer, shortCaption, withModel);
        console.log('✅ Gemini image ready');
      } catch (aiErr) {
        console.error('⚠️ Gemini failed, falling back to sharp:', aiErr.message);
        brandedBuffer = await createBrandedImage(buffer, shortCaption);
      }
    } else {
      brandedBuffer = await createBrandedImage(buffer, shortCaption);
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

    // Image with approval prompt as caption — arrives together, guaranteed order
    await sendImageMessage(from, imageUrl, `What do you think, ${getName(from)}? 👆\n\n*YES* — post it to Instagram ✅\n*RECREATE* — try a different version 🔄\n*NO* — skip this one ❌`);

    // Caption + hashtags sent after
    for (const chunk of splitMessage(extractInstagramCaption(content))) {
      await sendMessage(from, chunk);
    }

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
      // Save photo info and ask for keywords first
      pendingPhoto[from] = { mediaUrl, mediaContentType };
      setState(from, 'waiting_for_keywords');
      await sendMessage(from, `Love it, ${getName(from)}! 💎 Before I create your post — any keywords or details you want me to highlight?\n\nExamples: "gift for mom", "gold bracelet", "new arrival", "summer vibes"\n\nOr just say *skip* to go straight to it!`);
    } else if (['pull from website', 'pull website', 'website', 'new collection'].some(w => body.includes(w))) {
      await handleWebsitePull(from);
    } else {
      await sendMessage(from, `Send me a Lila Miami product photo 📸 or would you like me to pull a piece from your new arrivals on the website and create the post for you? Just say *website*! 💎`);
    }
    return;
  }

  if (currentState === 'waiting_for_product_pick') {
    const pick = parseInt(body.trim()) - 1;
    const pending = pendingPhoto[from];
    const products = pending?.shopifyProducts;
    if (products && pick >= 0 && pick < products.length) {
      const product = products[pick];
      const imageUrl = product.images?.[0]?.src;
      const keywords = `${product.title}. ${product.body_html?.replace(/<[^>]+>/g, '').substring(0, 200) || ''}`;
      delete pendingPhoto[from];
      if (imageUrl) {
        await sendMessage(from, `Great choice! Generating a post for *${product.title}*... ✨`);
        // Download product image and process
        const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imgRes.data);
        const base64 = buffer.toString('base64');
        const content = await generateContent(base64, 'image/jpeg', keywords);
        lastContent[from] = content;
        const shortCaption = extractCaption(content);
        let brandedBuffer;
        if (GOOGLE_AI_KEY) {
          try { brandedBuffer = await createBrandedImageAI(buffer, shortCaption); }
          catch (e) { brandedBuffer = await createBrandedImage(buffer, shortCaption); }
        } else {
          try { brandedBuffer = await createBrandedImage(buffer, shortCaption); }
          catch (e) { brandedBuffer = await sharp(buffer).resize(1080,1080,{fit:'cover'}).jpeg({quality:92}).toBuffer(); }
        }
        const whatsappUrl = await uploadToImgBB(brandedBuffer);
        const igUrl = storeImageForInstagram(brandedBuffer);
        lastImageUrl[from] = igUrl;
        lastCaption[from] = extractInstagramCaption(content);
        setState(from, 'waiting_for_approval');
        await sendImageMessage(from, whatsappUrl, `What do you think, ${getName(from)}? 👆\n\n*YES* — post it to Instagram ✅\n*RECREATE* — try a different version 🔄\n*NO* — skip this one ❌`);
        for (const chunk of splitMessage(extractInstagramCaption(content))) await sendMessage(from, chunk);
      } else {
        await sendMessage(from, `That product doesn't have an image in the store. Send me a photo and I'll use that! 📸`);
        setState(from, 'waiting_for_photo');
      }
    } else {
      await sendMessage(from, `Just reply with a number from the list — which product do you want to post?`);
    }
    return;
  }

  if (currentState === 'waiting_for_keywords') {
    const keywords = body === 'skip' ? '' : rawBody;
    const pending = pendingPhoto[from];
    if (pending) {
      pendingPhoto[from] = { ...pending, keywords };
      setState(from, 'waiting_for_model_choice');
      await sendMessage(from, `Got it! 💎 One more thing — would you like me to add a model wearing the piece?\n\n*YES* — generate a model wearing it 👗\n*NO* — keep the product shot as-is 📸`);
    } else {
      setState(from, 'waiting_for_photo');
      await sendMessage(from, `Send me the photo first, ${getName(from)}! 📸`);
    }
    return;
  }

  if (currentState === 'waiting_for_model_choice') {
    const pending = pendingPhoto[from];
    delete pendingPhoto[from];
    if (!pending) {
      setState(from, 'waiting_for_photo');
      await sendMessage(from, `Send me the photo first, ${getName(from)}! 📸`);
      return;
    }
    const withModel = ['yes', 'si', 'sí', 'yep', 'yeah', 'model'].some(w => body.includes(w));
    await processPhoto(from, pending.mediaUrl, pending.mediaContentType, pending.keywords || '', withModel);
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
    // Ask for keywords before processing (same as waiting_for_photo)
    pendingPhoto[from] = { mediaUrl, mediaContentType };
    setState(from, 'waiting_for_keywords');
    await sendMessage(from, `Love it, ${getName(from)}! 💎 Any keywords or details you want me to highlight?\n\nExamples: "gold cuff", "gift for her", "new arrival", "summer vibes"\n\nOr just say *skip* to go straight to it!`);
  } else if (['pull from website', 'pull website', 'website', 'new collection'].some(w => body.includes(w))) {
    await handleWebsitePull(from);
  } else {
    setState(from, 'waiting_for_photo');
    await sendMessage(from, `Hi ${getName(from)}! 👋 Send me a Lila Miami product photo 📸 — or would you like me to pull a piece from your new arrivals on the website and create the post for you? Just say *website*! 💎`);
  }
});

app.get('/', (req, res) => res.send('Lila Miami WhatsApp Bot is running 💎'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💎 Lila Miami WhatsApp Bot running on port ${PORT}`);
  console.log(`📅 Daily ping scheduled for 10:00 AM Miami time`);
});
