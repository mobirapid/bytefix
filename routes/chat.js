// AI chat assistant grounded in the live site data.
// - If AI_API_KEY is set, calls an OpenAI-compatible chat API (works with OpenAI,
//   Groq, OpenRouter, Together, Gemini's OpenAI endpoint, etc. via AI_BASE_URL).
// - Otherwise answers common questions from a built-in keyword fallback.
const express = require('express');
const db = require('../db');
const router = express.Router();

const INR = n => '₹' + Number(Math.round(n || 0)).toLocaleString('en-IN');
const setting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : ''; };

// Build a compact, always-current knowledge snapshot of the website.
function buildContext() {
  const brand = setting('brand_name') || 'ByteFix';
  const city = setting('city') || 'Bengaluru';
  const phone = setting('phone') || '';
  const email = setting('email') || '';
  const address = setting('address') || '';
  const gst = setting('gst_percent') || '18';

  const cats = db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY sort,id').all();
  const lines = cats.map(c => {
    const brands = db.prepare('SELECT id,name FROM brands WHERE category_id=?').all(c.id);
    const brandNames = brands.map(b => b.name).join(', ');
    const models = db.prepare(`SELECT m.base_value FROM models m JOIN brands b ON b.id=m.brand_id WHERE b.category_id=? AND m.active=1`).all(c.id);
    const vals = models.map(m => m.base_value).filter(v => v > 0).sort((a, b) => a - b);
    const range = vals.length ? `resale up to ${INR(vals[vals.length - 1])}` : '';
    const issues = db.prepare('SELECT name,price FROM repair_issues WHERE category_id=? ORDER BY sort').all(c.id);
    const issueStr = issues.length ? issues.map(i => `${i.name} (from ${INR(i.price)})`).join('; ') : 'various repairs';
    const avail = [c.for_repair ? 'repair' : null, c.for_sell ? 'sell' : null].filter(Boolean).join(' & ');
    return `- ${c.name} [${avail}]: brands: ${brandNames || '—'}; ${range}; repairs: ${issueStr}.`;
  }).join('\n');

  const conds = db.prepare('SELECT name FROM condition_groups ORDER BY sort').all().map(g => g.name).join(', ');
  const repSteps = db.prepare("SELECT label FROM order_statuses WHERE flow='repair' ORDER BY sort").all().map(s => s.label).join(' → ');
  const sellSteps = db.prepare("SELECT label FROM order_statuses WHERE flow='sell' ORDER BY sort").all().map(s => s.label).join(' → ');

  return `BUSINESS: ${brand} — device repair and resale (recommerce) in ${city}, India. Prices in INR.
CONTACT: phone ${phone || 'n/a'}, email ${email || 'n/a'}, address ${address || 'n/a'}.
SERVICES:
• Repair: book a repair, get a transparent quote (parts + ${gst}% GST). Free diagnosis; final price confirmed after diagnosis. 12-month warranty on parts & labour. Service modes: free pickup & drop, or store walk-in.
• Sell: pick model, answer condition questions (${conds}) for an instant quote, locked 48 hrs, paid instantly (UPI/bank) at pickup with certified data wipe.
DEVICE CATALOGUE (availability in brackets):
${lines}
ORDER TRACKING: customers get a reference like RGAB12C and can track on the site. Repair stages: ${repSteps}. Sell stages: ${sellSteps}.
ACCOUNTS: passwordless phone OTP or Google sign-in. Bookings require phone verification.
SERVICE AREA: ${city} (and other configured cities).`;
}

const SYSTEM = `You are the helpful AI assistant for a device repair & resale website. Answer ONLY using the BUSINESS CONTEXT provided. Be concise, friendly and accurate. Use ₹ for prices. If asked for an exact price, explain it depends on the model/condition and guide them to start a quote on the site (Fix a device / Sell a device) or to use Track order. If something is outside the website's services, politely say you can only help with this store's repair, resale, orders and support. Never invent prices, policies, or models not in the context.`;

// ---- simple in-memory rate limit (per IP) ----
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 60000);
  recent.push(now); hits.set(ip, recent);
  return recent.length > 20; // 20 msgs/min
}

// ---- keyword fallback when no API key is configured ----
function fallback(msg) {
  const m = (msg || '').toLowerCase();
  const brand = setting('brand_name') || 'ByteFix';
  const phone = setting('phone') || '';
  const email = setting('email') || '';
  const city = setting('city') || 'Bengaluru';
  const has = (...w) => w.some(x => m.includes(x));
  if (has('hi', 'hello', 'hey', 'namaste')) return `Hi! I'm the ${brand} assistant. I can help with device repairs, selling your device, pricing, orders and tracking. What do you need?`;
  if (has('sell', 'resale', 'sale', 'exchange')) return `To sell a device: tap "Sell a device", pick your model, and answer a few condition questions for an instant quote. It's locked for 48 hours and paid instantly (UPI/bank) at free pickup, with certified data wiping.`;
  if (has('repair', 'fix', 'broken', 'screen', 'battery', 'damage')) return `For a repair: tap "Fix a device", choose your model and the issues. You'll see a transparent quote (parts + GST). Diagnosis is free, every repair has a 12-month warranty, and you can choose free pickup & drop or a store walk-in.`;
  if (has('price', 'cost', 'quote', 'how much', 'rate')) return `Prices depend on the exact model and condition. Start a quote on the site — "Fix a device" for repairs or "Sell a device" for resale — to see an exact figure in under a minute.`;
  if (has('track', 'status', 'order', 'where is')) return `You can track any order with its reference (e.g. RGAB12C) using "Track order" in the menu. Need help — share your reference or contact us${phone ? ' at ' + phone : ''}.`;
  if (has('warranty', 'guarantee')) return `Every repair is backed by a 12-month warranty covering parts and labour.`;
  if (has('pay', 'payment', 'upi', 'cash')) return `For sales we pay instantly via UPI or bank transfer when our agent verifies the device at pickup. For repairs you pay after approving the final quote.`;
  if (has('pickup', 'doorstep', 'collect', 'location', 'city', 'area')) return `We offer free pickup & drop in ${city} (and other listed cities), or you can visit a store. Pick a slot during checkout.`;
  if (has('data', 'wipe', 'erase', 'privacy')) return `Every device you sell gets a certified data wipe, done transparently before payment.`;
  if (has('contact', 'phone', 'email', 'call', 'support', 'reach')) return `You can reach us${phone ? ' on ' + phone : ''}${email ? ', email ' + email : ''}. I'm here too — ask away!`;
  if (has('login', 'sign in', 'account', 'otp')) return `Sign in is passwordless — use your phone number (one-time code) or Google. Bookings need a verified phone.`;
  return `I can help with repairs, selling a device, pricing, orders and tracking. Try "Fix a device" or "Sell a device" to get a quote, or ask me anything about our services${phone ? ` — or call ${phone}` : ''}.`;
}

router.post('/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  if (limited(ip)) return res.status(429).json({ error: 'Too many messages, please slow down a moment.' });
  const message = String(req.body.message || '').slice(0, 1000).trim();
  if (!message) return res.status(400).json({ error: 'Empty message' });
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-8)
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .map(h => ({ role: h.role, content: String(h.content).slice(0, 1000) })) : [];

  const KEY = process.env.AI_API_KEY;
  if (!KEY) return res.json({ reply: fallback(message), mode: 'fallback' });

  try {
    const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = process.env.AI_MODEL || 'gpt-4o-mini';
    const messages = [
      { role: 'system', content: SYSTEM + '\n\nBUSINESS CONTEXT:\n' + buildContext() },
      ...history,
      { role: 'user', content: message },
    ];
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 400 }),
      signal: ctrl.signal,
    });
    clearTimeout(tm);
    if (!r.ok) { console.error('[AI] provider', r.status); return res.json({ reply: fallback(message), mode: 'fallback' }); }
    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || fallback(message);
    res.json({ reply, mode: 'ai' });
  } catch (e) {
    console.error('[AI] error:', e.message);
    res.json({ reply: fallback(message), mode: 'fallback' });
  }
});

module.exports = router;
