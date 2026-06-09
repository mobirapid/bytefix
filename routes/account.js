const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { phoneForToken } = require('./otp');
const { rolesOf, permsOf } = require('./auth');
const pw = require('./pw');
const { record } = require('./auditlog');
const { sendEmail } = require('./mailer');
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
  if (!u || !pw.verify(password, u.password)) { record({ action: 'STAFF_LOGIN_FAILED', detail: 'user=' + username, ip: req.ip || '' }); return res.status(401).json({ error: 'Invalid username or password.' }); }
  if (!pw.isHashed(u.password)) db.prepare('UPDATE users SET password=? WHERE id=?').run(pw.hash(password), u.id); // upgrade legacy
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET token=? WHERE id=?').run(token, u.id);
  record({ actor_id: u.id, actor_name: u.name || u.username, actor_role: rolesOf(u.id).join(','), action: 'STAFF_LOGIN', ip: req.ip || '' });
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
  if (req.body.consent) {
    try { db.prepare('INSERT INTO consent_log (phone,email,kind,detail,ip) VALUES (?,?,?,?,?)')
      .run(phone, email || '', 'signup', 'Agreed to Terms & Privacy at signup', req.ip || ''); } catch (e) {}
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

// DPDP: export all of my data (account + orders + my comments/reviews + consent).
router.get('/export', requireUser, (req, res) => {
  const u = req.user;
  const last10 = String(u.phone || '').replace(/\D/g, '').slice(-10);
  const orders = last10 ? db.prepare('SELECT * FROM orders WHERE customer_phone LIKE ?').all('%' + last10) : [];
  const comments = db.prepare('SELECT order_ref,body,created_at FROM order_comments WHERE author_user_id=?').all(u.id);
  const reviews = db.prepare('SELECT order_ref,role,rating,review,created_at FROM order_reviews WHERE author_user_id=?').all(u.id);
  const consent = db.prepare('SELECT kind,detail,ts FROM consent_log WHERE user_id=? OR phone=? OR lower(email)=lower(?)').all(u.id, u.phone || '', u.email || '');
  const data = {
    exported_at: new Date().toISOString(),
    account: { id: u.id, name: u.name, phone: u.phone, email: u.email, city: u.city, email_updates: !!u.email_updates, created_at: u.created_at, roles: rolesOf(u.id) },
    orders, comments, reviews, consent,
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.send(JSON.stringify(data, null, 2));
});

// DPDP: request account deletion (erasure). Logged + emailed to admin; you're signed out.
router.post('/delete', requireUser, (req, res) => {
  const u = req.user;
  const reason = String(req.body.reason || '').slice(0, 500);
  db.prepare('INSERT INTO deletion_requests (user_id,name,phone,email,reason) VALUES (?,?,?,?,?)')
    .run(u.id, u.name || '', u.phone || '', u.email || '', reason);
  record({ actor_id: u.id, actor_name: u.name || u.phone || ('#' + u.id), actor_role: 'customer', action: 'DATA_DELETION_REQUEST', detail: reason, ip: req.ip || '' });
  const adminEmail = (db.prepare("SELECT value FROM settings WHERE key='email'").get() || {}).value;
  if (adminEmail) sendEmail(adminEmail, 'Account deletion request', `User ${u.name || ''} (${u.phone || ''} ${u.email || ''}) requested account deletion.${reason ? ' Reason: ' + reason : ''}`);
  db.prepare('UPDATE users SET token=NULL WHERE id=?').run(u.id); // sign out
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
