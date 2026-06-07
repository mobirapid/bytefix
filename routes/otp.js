const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// In-memory stores — fine for OTPs/tokens since they're short-lived and ephemeral.
const codes = new Map();   // phone -> { code, expires, attempts, lastSent }
const tokens = new Map();  // token -> { phone, expires }

// No SMS provider configured in this demo, so we expose the code for testing.
// In production set DEV_OTP=false and integrate a provider in `deliver()`.
const DEV = process.env.DEV_OTP !== 'false';

const norm = p => String(p || '').replace(/\D/g, '').slice(-10);
const gen = () => String(Math.floor(100000 + Math.random() * 900000));

const MSG91 = process.env.MSG91_AUTHKEY && process.env.MSG91_TEMPLATE_ID;

// Static OTP for a pre-SMS pilot: a fixed code that always verifies, for any
// number, with no SMS sent. Explicit STATIC_OTP wins; otherwise it defaults to
// 123456 in demo mode. It is OFF automatically once DEV_OTP=false or MSG91 is set.
const STATIC_OTP = process.env.STATIC_OTP || ((DEV && !MSG91) ? '123456' : '');
if (STATIC_OTP) console.log(`[OTP] Static OTP mode — code "${STATIC_OTP}" is accepted for any number (no SMS sent). Disable with DEV_OTP=false or by configuring MSG91.`);

// Delivers the code to the phone. With MSG91 env vars set it sends a real SMS
// via MSG91's Flow API; otherwise it logs to the console (demo mode).
async function deliver(phone, code) {
  if (MSG91) {
    const cc = process.env.SMS_COUNTRY_CODE || '91';
    const otpVar = process.env.MSG91_OTP_VAR || 'otp';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: process.env.MSG91_AUTHKEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: process.env.MSG91_TEMPLATE_ID,
          recipients: [{ mobiles: cc + phone, [otpVar]: code }],
        }),
        signal: ctrl.signal,
      });
      let data = {}; try { data = await resp.json(); } catch (_) {}
      if (!resp.ok || data.type === 'error') {
        throw new Error(data.message || ('SMS provider returned ' + resp.status));
      }
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  console.log(`[OTP] ${phone} -> ${code}`); // demo: no SMS provider configured
}

// POST /api/otp/send  { phone }
router.post('/send', async (req, res) => {
  const phone = norm(req.body.phone);
  if (phone.length < 10) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  const existing = codes.get(phone);
  if (existing && Date.now() - existing.lastSent < 30000)
    return res.status(429).json({ error: 'Please wait a few seconds before requesting another code' });
  const code = STATIC_OTP || gen();
  if (!STATIC_OTP) {
    try {
      await deliver(phone, code);
    } catch (e) {
      console.error('[OTP] send failed:', e.message);
      return res.status(502).json({ error: 'Could not send the code right now. Please try again.' });
    }
  }
  codes.set(phone, { code, expires: Date.now() + 5 * 60000, attempts: 0, lastSent: Date.now() });
  res.json({ sent: true, ...(DEV ? { dev_code: code } : {}) });
});

// POST /api/otp/verify  { phone, code } -> { token }
router.post('/verify', (req, res) => {
  const phone = norm(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (STATIC_OTP && code === STATIC_OTP) {
    codes.delete(phone);
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, { phone, expires: Date.now() + 15 * 60000 });
    return res.json({ verified: true, token });
  }
  const rec = codes.get(phone);
  if (!rec) return res.status(400).json({ error: 'Request a code first' });
  if (Date.now() > rec.expires) { codes.delete(phone); return res.status(400).json({ error: 'Code expired — request a new one' }); }
  if (rec.attempts >= 5) { codes.delete(phone); return res.status(429).json({ error: 'Too many attempts — request a new code' }); }
  if (rec.code !== code) { rec.attempts++; return res.status(400).json({ error: 'Incorrect code' }); }
  codes.delete(phone);
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { phone, expires: Date.now() + 15 * 60000 });
  res.json({ verified: true, token });
});

// used by the orders route to enforce verification before creating a booking
function verifyBooking(token, phone) {
  const t = tokens.get(token);
  if (!t) return false;
  if (Date.now() > t.expires) { tokens.delete(token); return false; }
  return t.phone === norm(phone);
}

function phoneForToken(token) {
  const t = tokens.get(token);
  if (!t) return null;
  if (Date.now() > t.expires) { tokens.delete(token); return null; }
  return t.phone;
}

module.exports = { router, verifyBooking, phoneForToken };
