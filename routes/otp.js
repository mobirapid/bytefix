const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { sendEmail } = require('./mailer');
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

// 2Factor.in OTP provider (AUTOGEN: they generate + send + verify the code).
// Admin-configurable; key kept server-side (redacted from public /settings).
const twoFactorKey = () => {
  try { const r = db.prepare("SELECT value FROM settings WHERE key='twofactor_api_key'").get(); if (r && r.value) return r.value; } catch (e) {}
  return process.env.TWOFACTOR_API_KEY || '';
};
const twoFactorOn = () => {
  try { const r = db.prepare("SELECT value FROM settings WHERE key='otp_2factor'").get(); return !!(r && r.value === '1') && !!twoFactorKey(); } catch (e) { return false; }
};
// Optional SMS template name created in the 2Factor dashboard. Forces delivery via
// that SMS template (otherwise 2Factor may use a default that rings as a voice call).
const twoFactorTemplate = () => {
  try { const r = db.prepare("SELECT value FROM settings WHERE key='twofactor_template'").get(); return (r && r.value || '').trim(); } catch (e) { return ''; }
};

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

// Core OTP sender — reusable so other routes (e.g. operator e-sign) don't need an
// internal HTTP loopback (which fails under Passenger). Throws Error with .status.
async function sendOtp(phoneRaw) {
  const phone = norm(phoneRaw);
  if (phone.length < 10) { const e = new Error('Enter a valid 10-digit mobile number'); e.status = 400; throw e; }
  const existing = codes.get(phone);
  if (existing && Date.now() - existing.lastSent < 30000) { const e = new Error('Please wait a few seconds before requesting another code'); e.status = 429; throw e; }
  // 2Factor: send OUR generated code over the explicit SMS route (SMS only).
  if (twoFactorOn()) {
    const cc = process.env.SMS_COUNTRY_CODE || '91';
    const tpl = twoFactorTemplate();
    const code = gen();
    const url = `https://2factor.in/API/V1/${encodeURIComponent(twoFactorKey())}/SMS/+${cc}${phone}/${code}` + (tpl ? '/' + encodeURIComponent(tpl) : '');
    try {
      const r = await fetch(url);
      const d = await r.json().catch(() => ({}));
      if (d.Status !== 'Success') throw new Error(d.Details || ('2Factor ' + r.status));
    } catch (err) { console.error('[OTP 2factor send]', err.message); const e = new Error('Could not send the code right now. Please try again.'); e.status = 502; throw e; }
    codes.set(phone, { code, expires: Date.now() + 5 * 60000, attempts: 0, lastSent: Date.now() });
    return { sent: true };
  }
  const code = STATIC_OTP || gen();
  if (!STATIC_OTP) {
    try { await deliver(phone, code); }
    catch (err) { console.error('[OTP] send failed:', err.message); const e = new Error('Could not send the code right now. Please try again.'); e.status = 502; throw e; }
  }
  codes.set(phone, { code, expires: Date.now() + 5 * 60000, attempts: 0, lastSent: Date.now() });
  return { sent: true, ...(DEV ? { dev_code: code } : {}) };
}

// POST /api/otp/send  { phone }
router.post('/send', async (req, res) => {
  try { res.json(await sendOtp(req.body.phone)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/otp/verify  { phone, code } -> { token }
router.post('/verify', async (req, res) => {
  const phone = norm(req.body.phone);
  const code = String(req.body.code || '').trim();
  const issue = () => { const token = crypto.randomBytes(16).toString('hex'); tokens.set(token, { phone, expires: Date.now() + 15 * 60000 }); return token; };
  if (STATIC_OTP && !twoFactorOn() && code === STATIC_OTP) {
    codes.delete(phone);
    return res.json({ verified: true, token: issue() });
  }
  const rec = codes.get(phone);
  if (!rec) return res.status(400).json({ error: 'Request a code first' });
  if (Date.now() > rec.expires) { codes.delete(phone); return res.status(400).json({ error: 'Code expired — request a new one' }); }
  if (rec.attempts >= 5) { codes.delete(phone); return res.status(429).json({ error: 'Too many attempts — request a new code' }); }
  if (rec.code !== code) { rec.attempts++; return res.status(400).json({ error: 'Incorrect code' }); }
  codes.delete(phone);
  res.json({ verified: true, token: issue() });
});

// ---- Firebase Phone Auth: verify the client's ID token, then mint our booking token ----
// No external dependency: the JWT is verified against Google's public x509 certs.
let _certCache = { at: 0, keys: null };
async function googleCerts() {
  if (_certCache.keys && Date.now() - _certCache.at < 3600000) return _certCache.keys;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  const keys = await r.json();
  _certCache = { at: Date.now(), keys };
  return keys;
}
function firebaseProjectId() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='firebase_config'").get();
    if (row && row.value) { const c = JSON.parse(row.value); if (c.projectId) return c.projectId; }
  } catch (e) {}
  return process.env.FIREBASE_PROJECT_ID || '';
}
// Verifies a Firebase ID token's signature/claims and returns the full payload.
// Used for both phone and email (passwordless email-link) sign-in.
async function verifyFirebasePayload(idToken) {
  const pid = firebaseProjectId();
  if (!pid) throw new Error('Firebase not configured');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const certs = await googleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('Unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
    crypto.createPublicKey(pem), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== pid) throw new Error('Wrong audience');
  if (payload.iss !== 'https://securetoken.google.com/' + pid) throw new Error('Wrong issuer');
  if (payload.exp < now) throw new Error('Token expired');
  return payload;
}
async function verifyFirebaseToken(idToken) {
  const payload = await verifyFirebasePayload(idToken);
  if (!payload.phone_number) throw new Error('No phone number in token');
  return payload.phone_number;
}
// Returns the verified email from a Firebase email-link sign-in token.
async function verifyFirebaseEmail(idToken) {
  const payload = await verifyFirebasePayload(idToken);
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !payload.email_verified) throw new Error('Email not verified in token');
  return email;
}

// POST /api/otp/firebase { idToken } -> { verified, token, phone }
router.post('/firebase', async (req, res) => {
  try {
    const phoneE164 = await verifyFirebaseToken(req.body.idToken);
    const phone = norm(phoneE164);
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, { phone, expires: Date.now() + 15 * 60000 });
    res.json({ verified: true, token, phone });
  } catch (e) {
    console.error('[OTP firebase]', e.message);
    res.status(401).json({ error: 'Could not verify phone sign-in.' });
  }
});

// Verify a raw OTP for a phone (consumes it on success). Used by operator e-sign.
function verifyCode(phoneRaw, codeRaw) {
  const phone = norm(phoneRaw); const code = String(codeRaw || '').trim();
  if (STATIC_OTP && !twoFactorOn() && code === STATIC_OTP) { codes.delete(phone); return true; }
  const rec = codes.get(phone);
  if (!rec) return false;
  if (Date.now() > rec.expires) { codes.delete(phone); return false; }
  if (rec.attempts >= 5) { codes.delete(phone); return false; }
  if (rec.code !== code) { rec.attempts++; return false; }
  codes.delete(phone); return true;
}

// ---- Email OTP (used by the B2B form to verify a work email) ----
const emailCodes = new Map();   // email -> { code, expires, attempts, lastSent }
const emailTokens = new Map();  // token -> { email, expires }
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
router.post('/email/send', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  const ex = emailCodes.get(email);
  if (ex && Date.now() - ex.lastSent < 30000) return res.status(429).json({ error: 'Please wait a few seconds before requesting another code' });
  const code = gen();
  emailCodes.set(email, { code, expires: Date.now() + 5 * 60000, attempts: 0, lastSent: Date.now() });
  sendEmail(email, 'Your verification code', `Your verification code is ${code}. It is valid for 5 minutes.`);
  res.json({ sent: true, ...(DEV ? { dev_code: code } : {}) });
});
router.post('/email/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const rec = emailCodes.get(email);
  if (!rec) return res.status(400).json({ error: 'Request a code first' });
  if (Date.now() > rec.expires) { emailCodes.delete(email); return res.status(400).json({ error: 'Code expired — request a new one' }); }
  if (rec.attempts >= 5) { emailCodes.delete(email); return res.status(429).json({ error: 'Too many attempts — request a new code' }); }
  if (rec.code !== code) { rec.attempts++; return res.status(400).json({ error: 'Incorrect code' }); }
  emailCodes.delete(email);
  const token = crypto.randomBytes(16).toString('hex');
  emailTokens.set(token, { email, expires: Date.now() + 15 * 60000 });
  res.json({ verified: true, token });
});
// Firebase email-link verification → issue the same kind of email token the
// 6-digit flow does, so downstream consumers (B2B form) don't need to change.
router.post('/email/firebase', async (req, res) => {
  try {
    const email = await verifyFirebaseEmail(req.body.idToken);
    const token = crypto.randomBytes(16).toString('hex');
    emailTokens.set(token, { email, expires: Date.now() + 15 * 60000 });
    res.json({ verified: true, token, email });
  } catch (e) {
    console.error('[OTP email firebase]', e.message);
    res.status(401).json({ error: 'Could not verify email sign-in.' });
  }
});
function verifyEmailToken(token, email) {
  const t = emailTokens.get(token);
  if (!t) return false;
  if (Date.now() > t.expires) { emailTokens.delete(token); return false; }
  return t.email === String(email || '').trim().toLowerCase();
}

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

module.exports = { router, verifyBooking, phoneForToken, verifyCode, verifyEmailToken, sendOtp, verifyFirebaseEmail };
