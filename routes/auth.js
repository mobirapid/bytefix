const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { sendEmail } = require('./mailer');
const pw = require('./pw');
const { record } = require('./auditlog');
const router = express.Router();

// basic login rate limit per ip+id
const loginHits = new Map();
function loginLimited(k) { const now = Date.now(); const a = (loginHits.get(k) || []).filter(t => now - t < 600000); a.push(now); loginHits.set(k, a); return a.length > 8; }

// ----- role / permission helpers (DB-driven) -----
const rolesOf = (uid) =>
  db.prepare('SELECT role_key FROM user_roles WHERE user_id=?').all(uid).map(r => r.role_key);
const permsOf = (uid) =>
  db.prepare(`SELECT DISTINCT rp.perm FROM user_roles ur
              JOIN role_permissions rp ON rp.role_key=ur.role_key
              WHERE ur.user_id=?`).all(uid).map(r => r.perm);
const citiesFor = (uid) =>
  db.prepare('SELECT city FROM user_cities WHERE user_id=?').all(uid).map(r => r.city);
const newToken = () => crypto.randomBytes(24).toString('hex');

function userFromToken(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return t ? db.prepare('SELECT * FROM users WHERE token=?').get(t) : null;
}

// POST /api/auth/login — DISABLED. Superadmin sign-in is now phone-OTP only
// (see /login-phone below). Kept as an explicit, audited rejection so old
// default credentials can't be used via the API either. Operators are
// unaffected — they sign in via /api/account/staff-login.
router.post('/login', (req, res) => {
  record({ action: 'LOGIN_BLOCKED (password login disabled)', detail: 'id=' + String((req.body || {}).email || '').trim(), ip: req.ip || '' });
  return res.status(410).json({ error: 'Password login is disabled. Admin sign-in is via phone OTP.' });
});

// ---- Forgot password (admin): email an OTP, then reset ----
const resetCodes = new Map(); // email -> { code, expires, attempts, lastSent }
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const adminByEmail = (id) =>
  db.prepare('SELECT * FROM users WHERE (lower(email)=lower(?) OR username=?) AND password IS NOT NULL').get(id, id);
const brandName = () => { try { const r = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get(); return (r && r.value) || 'ByteFix'; } catch (e) { return 'ByteFix'; } };

// POST /api/auth/forgot { email } — always returns ok (doesn't reveal if the account exists)
router.post('/forgot', (req, res) => {
  const email = String(req.body.email || '').trim();
  const prev = resetCodes.get(email.toLowerCase());
  if (prev && Date.now() - prev.lastSent < 30000)
    return res.status(429).json({ error: 'Please wait a few seconds before requesting another code.' });
  const u = email && adminByEmail(email);
  if (u && permsOf(u.id).includes('admin_panel') && u.email) {
    const code = genCode();
    resetCodes.set(email.toLowerCase(), { code, expires: Date.now() + 10 * 60000, attempts: 0, lastSent: Date.now() });
    const bn = brandName();
    sendEmail(u.email, `${bn} admin password reset code`,
      `Your ${bn} admin password reset code is ${code}. It is valid for 10 minutes. If you did not request this, please ignore this email.`);
  }
  res.json({ ok: true });
});

// POST /api/auth/reset { email, code, password }
router.post('/reset', (req, res) => {
  const email = String(req.body.email || '').trim();
  const code = String(req.body.code || '').trim();
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const rec = resetCodes.get(email.toLowerCase());
  if (!rec) return res.status(400).json({ error: 'Request a reset code first.' });
  if (Date.now() > rec.expires) { resetCodes.delete(email.toLowerCase()); return res.status(400).json({ error: 'Code expired — request a new one.' }); }
  if (rec.attempts >= 5) { resetCodes.delete(email.toLowerCase()); return res.status(429).json({ error: 'Too many attempts — request a new code.' }); }
  if (rec.code !== code) { rec.attempts++; return res.status(400).json({ error: 'Incorrect code.' }); }
  const u = adminByEmail(email);
  if (!u || !permsOf(u.id).includes('admin_panel')) { resetCodes.delete(email.toLowerCase()); return res.status(400).json({ error: 'Account not found.' }); }
  db.prepare('UPDATE users SET password=?, token=NULL WHERE id=?').run(pw.hash(password), u.id);
  resetCodes.delete(email.toLowerCase());
  record({ actor_id: u.id, actor_name: u.name || u.username, actor_role: permsOf(u.id).join(','), action: 'PASSWORD_RESET', ip: req.ip || '' });
  res.json({ ok: true });
});

// ---- Forgot password via Firebase email-link (no 6-digit code; Google delivers) ----
// Step 1: client signs in with the email link, sends us the Firebase idToken; we
// verify the email and, if it's an admin, mint a short-lived reset ticket.
const fbResetTickets = new Map(); // ticket -> { email, expires }
router.post('/forgot-firebase', async (req, res) => {
  try {
    const { verifyFirebaseEmail } = require('./otp');
    const email = await verifyFirebaseEmail(req.body.idToken);
    const u = adminByEmail(email);
    if (!u || !permsOf(u.id).includes('admin_panel'))
      return res.status(403).json({ error: 'This email is not an admin account.' });
    const ticket = crypto.randomBytes(24).toString('hex');
    fbResetTickets.set(ticket, { email, expires: Date.now() + 10 * 60000 });
    res.json({ ok: true, ticket, email });
  } catch (e) {
    console.error('[auth forgot-firebase]', e.message);
    res.status(401).json({ error: 'Could not verify email sign-in.' });
  }
});
// Step 2: set the new password using the reset ticket from step 1.
router.post('/reset-firebase', (req, res) => {
  const ticket = String(req.body.ticket || '');
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const rec = fbResetTickets.get(ticket);
  if (!rec || Date.now() > rec.expires) { fbResetTickets.delete(ticket); return res.status(400).json({ error: 'Reset session expired — verify your email again.' }); }
  const u = adminByEmail(rec.email);
  if (!u || !permsOf(u.id).includes('admin_panel')) { fbResetTickets.delete(ticket); return res.status(400).json({ error: 'Account not found.' }); }
  db.prepare('UPDATE users SET password=?, token=NULL WHERE id=?').run(pw.hash(password), u.id);
  fbResetTickets.delete(ticket);
  record({ actor_id: u.id, actor_name: u.name || u.username, actor_role: permsOf(u.id).join(','), action: 'PASSWORD_RESET (firebase)', ip: req.ip || '' });
  res.json({ ok: true });
});

// ---- Admin login via phone OTP (superadmin). The phone must belong to a user
// that holds admin_panel. The OTP itself is verified by the shared /otp layer
// (Firebase phone / 2Factor SMS / demo) which mints the booking token we check. ----
const digits10 = p => String(p || '').replace(/\D/g, '').slice(-10);
router.post('/login-phone', (req, res) => {
  const { token, phone } = req.body || {};
  const ip = req.ip || req.socket.remoteAddress || '';
  const { verifyBooking } = require('./otp');
  if (!verifyBooking(token, phone)) return res.status(401).json({ error: 'Phone not verified. Please request an OTP first.' });
  const want = digits10(phone);
  if (want.length < 10) return res.status(400).json({ error: 'Enter a valid mobile number.' });
  const u = db.prepare('SELECT * FROM users').all()
    .find(x => digits10(x.phone) === want && permsOf(x.id).includes('admin_panel'));
  if (!u) {
    record({ action: 'ADMIN_PHONE_LOGIN_DENIED', detail: 'phone=' + want, ip });
    return res.status(403).json({ error: 'This number is not registered to an admin account.' });
  }
  const t = newToken();
  db.prepare('UPDATE users SET token=? WHERE id=?').run(t, u.id);
  record({ actor_id: u.id, actor_name: u.name || u.username, actor_role: rolesOf(u.id).join(','), action: 'LOGIN (phone OTP)', ip });
  res.json({ token: t, email: u.email || u.username, name: u.name, roles: rolesOf(u.id) });
});

// Protects admin-panel write routes — requires the admin_panel permission.
function requireAdmin(req, res, next) {
  const u = userFromToken(req);
  if (!u) return res.status(401).json({ error: 'Missing or invalid admin session' });
  if (!permsOf(u.id).includes('admin_panel')) return res.status(403).json({ error: 'Forbidden' });
  req.admin = u; req.user = u; next();
}

// Generic permission gate for any authenticated user (e.g. operators).
function requirePerm(perm) {
  return (req, res, next) => {
    const u = userFromToken(req);
    if (!u) return res.status(401).json({ error: 'Please sign in.' });
    if (!permsOf(u.id).includes(perm)) return res.status(403).json({ error: 'Forbidden' });
    req.user = u; next();
  };
}

module.exports = { router, requireAdmin, requirePerm, rolesOf, permsOf, citiesFor, userFromToken };
