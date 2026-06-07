const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { phoneForToken } = require('./otp');
const { rolesOf, permsOf } = require('./auth');
const router = express.Router();

const pub = (u) => u && {
  id: u.id, phone: u.phone, name: u.name, email: u.email, city: u.city,
  email_updates: !!u.email_updates, username: u.username || null,
  roles: rolesOf(u.id), perms: permsOf(u.id),
};
const byPhone = (phone) => db.prepare('SELECT * FROM users WHERE phone=?').get(phone);

// Staff (operator / superadmin) sign-in on the MAIN app with username + password.
// Returns a normal customer-style session; the storefront reads roles from /me.
router.post('/staff-login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  const u = db.prepare('SELECT * FROM users WHERE username=? AND password IS NOT NULL').get(username);
  if (!u || u.password !== password) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET token=? WHERE id=?').run(token, u.id);
  res.json({ user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)), session: token });
});

function requireUser(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const u = tok && db.prepare('SELECT * FROM users WHERE token=?').get(tok);
  if (!u) return res.status(401).json({ error: 'Please sign in again.' });
  req.user = u;
  next();
}

// Does an account already exist for the phone behind this verified booking token?
router.post('/resolve', (req, res) => {
  const phone = phoneForToken(req.body.booking_token);
  if (!phone) return res.status(401).json({ error: 'Verify your phone first.' });
  const u = byPhone(phone);
  res.json({ exists: !!u, user: pub(u), phone });
});

// Create or update the account for the verified phone, and issue a session token.
router.post('/save', (req, res) => {
  const phone = phoneForToken(req.body.booking_token);
  if (!phone) return res.status(401).json({ error: 'Verify your phone first.' });
  const { name, email, city, email_updates } = req.body;
  const token = crypto.randomBytes(16).toString('hex');
  const eu = email_updates == null ? null : (email_updates ? 1 : 0);
  let u = byPhone(phone);
  // Account linking: if no phone account yet but a Google account exists with this
  // email (and no phone), attach the verified phone to it instead of duplicating.
  if (!u && email) {
    const g = db.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND (phone IS NULL OR phone='')").get(email);
    if (g) {
      db.prepare("UPDATE users SET phone=?, name=COALESCE(NULLIF(name,''),?), city=COALESCE(?,city), email_updates=COALESCE(?,email_updates), token=? WHERE id=?")
        .run(phone, name ?? null, city ?? null, eu, token, g.id);
      return res.json({ user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(g.id)), session: token });
    }
  }
  if (u) {
    db.prepare('UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), city=COALESCE(?,city), email_updates=COALESCE(?,email_updates), token=? WHERE phone=?')
      .run(name ?? null, email ?? null, city ?? null, eu, token, phone);
  } else {
    db.prepare('INSERT INTO users (phone,name,email,city,email_updates,token) VALUES (?,?,?,?,?,?)')
      .run(phone, name || '', email || '', city || '', eu == null ? 1 : eu, token);
  }
  res.json({ user: pub(byPhone(phone)), session: token });
});

router.get('/me', requireUser, (req, res) => res.json({ user: pub(req.user) }));

router.put('/me', requireUser, (req, res) => {
  const { name, email, city, email_updates } = req.body;
  const eu = email_updates == null ? null : (email_updates ? 1 : 0);
  db.prepare('UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), city=COALESCE(?,city), email_updates=COALESCE(?,email_updates) WHERE id=?')
    .run(name ?? null, email ?? null, city ?? null, eu, req.user.id);
  res.json({ user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

// Orders belonging to this user (matched on the last 10 digits of the phone).
router.get('/orders', requireUser, (req, res) => {
  const last10 = String(req.user.phone || '').replace(/\D/g, '').slice(-10);
  res.json(db.prepare('SELECT ref,type,device_label,amount,status,created_at FROM orders WHERE customer_phone LIKE ? ORDER BY id DESC LIMIT 50').all('%' + last10));
});

router.post('/logout', requireUser, (req, res) => {
  db.prepare('UPDATE users SET token=NULL WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});

// Attach a verified phone to the signed-in (e.g. Google) account, merging any
// duplicate phone-only account so past bookings show up under one account.
router.post('/attach-phone', requireUser, (req, res) => {
  const phone = phoneForToken(req.body.booking_token);
  if (!phone) return res.status(401).json({ error: 'Verify the number first.' });
  const other = db.prepare('SELECT * FROM users WHERE phone=? AND id<>?').get(phone, req.user.id);
  if (other) {
    db.prepare("UPDATE users SET name=COALESCE(NULLIF(name,''),?), city=COALESCE(NULLIF(city,''),?), google_sub=COALESCE(google_sub,?) WHERE id=?")
      .run(other.name || '', other.city || '', other.google_sub || null, req.user.id);
    db.prepare('DELETE FROM users WHERE id=?').run(other.id);
  }
  db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, req.user.id);
  res.json({ user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

// Sign in / sign up with Google. Verifies the ID token with Google and checks the audience.
const googleClientId = () => {
  const r = db.prepare("SELECT value FROM settings WHERE key='google_client_id'").get();
  return (r && r.value) || process.env.GOOGLE_CLIENT_ID || '';
};
router.post('/google', async (req, res) => {
  const cid = googleClientId();
  const cred = req.body.credential;
  if (!cred) return res.status(400).json({ error: 'Missing Google credential.' });
  if (!cid) return res.status(400).json({ error: 'Google sign-in is not configured yet.' });
  let p;
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred), { signal: ctrl.signal });
    clearTimeout(tm);
    if (!r.ok) return res.status(401).json({ error: 'Could not verify Google sign-in.' });
    p = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'Google verification failed, please try again.' });
  }
  if (p.aud !== cid) return res.status(401).json({ error: 'Google sign-in token did not match this site.' });
  if (p.email_verified !== 'true' && p.email_verified !== true) return res.status(401).json({ error: 'Your Google email is not verified.' });
  const email = (p.email || '').toLowerCase();
  if (!email) return res.status(401).json({ error: 'Google did not return an email.' });
  const name = p.name || p.given_name || email.split('@')[0];
  const sub = p.sub || null;
  const token = crypto.randomBytes(16).toString('hex');
  let u = db.prepare('SELECT * FROM users WHERE email=? OR (google_sub IS NOT NULL AND google_sub=?)').get(email, sub);
  if (u) {
    db.prepare("UPDATE users SET name=COALESCE(NULLIF(name,''),?), email=?, google_sub=?, token=? WHERE id=?")
      .run(name, email, sub, token, u.id);
    u = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  } else {
    const info = db.prepare('INSERT INTO users (phone,name,email,city,email_updates,token,google_sub) VALUES (NULL,?,?,?,1,?,?)')
      .run(name, email, '', token, sub);
    u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  }
  res.json({ user: pub(u), session: token });
});

module.exports = router;
