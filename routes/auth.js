const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { sendEmail } = require('./mailer');
const router = express.Router();

// ----- role / permission helpers (DB-driven) -----
const rolesOf = (uid) =>
  db.prepare('SELECT role_key FROM user_roles WHERE user_id=?').all(uid).map(r => r.role_key);
const permsOf = (uid) =>
  db.prepare(`SELECT DISTINCT rp.perm FROM user_roles ur
              JOIN role_permissions rp ON rp.role_key=ur.role_key
              WHERE ur.user_id=?`).all(uid).map(r => r.perm);
const newToken = () => crypto.randomBytes(24).toString('hex');

function userFromToken(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return t ? db.prepare('SELECT * FROM users WHERE token=?').get(t) : null;
}

// POST /api/auth/login  { email, password } -> { token } for the ADMIN panel.
// Authenticates a unified user (by username or email) that holds the admin_panel
// permission (i.e. a superadmin). Tokens live on users.token.
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const id = String(email || '').trim();
  if (!id || !password) return res.status(400).json({ error: 'Email and password are required' });
  const u = db.prepare('SELECT * FROM users WHERE (username=? OR lower(email)=lower(?)) AND password IS NOT NULL').get(id, id);
  if (!u || u.password !== password) return res.status(401).json({ error: 'Invalid email or password' });
  if (!permsOf(u.id).includes('admin_panel'))
    return res.status(403).json({ error: 'This account does not have admin access.' });
  const token = newToken();
  db.prepare('UPDATE users SET token=? WHERE id=?').run(token, u.id);
  res.json({ token, email: u.email || u.username, name: u.name, roles: rolesOf(u.id) });
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
  db.prepare('UPDATE users SET password=?, token=NULL WHERE id=?').run(password, u.id);
  resetCodes.delete(email.toLowerCase());
  res.json({ ok: true });
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

module.exports = { router, requireAdmin, requirePerm, rolesOf, permsOf, userFromToken };
