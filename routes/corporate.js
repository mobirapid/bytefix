const express = require('express');
const db = require('../db');
const { requireAdmin } = require('./auth');
const { verifyBooking, verifyEmailToken } = require('./otp');
const router = express.Router();

const ref = () => 'CORP' + Math.random().toString(36).slice(2, 6).toUpperCase();

// POST /api/corporate — submit a B2B enquiry (public). Provided email/phone must be OTP-verified.
router.post('/', async (req, res) => {
  const { intent, company, contact_name, email, phone, device_types, quantity, message, email_token, phone_token } = req.body;
  if (!['sell', 'buy'].includes(intent)) return res.status(400).json({ error: 'intent must be sell or buy' });
  if (!company || !(email || phone)) return res.status(400).json({ error: 'Company and a contact (email or phone) are required' });
  if (email) {
    const dom = (String(email).split('@')[1] || '').toLowerCase();
    const FREE = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'ymail.com', 'gmx.com', 'mail.com'];
    if (FREE.includes(dom)) return res.status(400).json({ error: 'Please use your work email (not a personal address).' });
  }
  if (email && !verifyEmailToken(email_token, email)) return res.status(400).json({ error: 'Please verify your work email with the code.' });
  if (phone && !(await verifyBooking(phone_token, phone))) return res.status(400).json({ error: 'Please verify your phone with the OTP.' });
  const r = ref();
  db.prepare(`INSERT INTO corporate_leads (ref,intent,company,contact_name,email,phone,device_types,quantity,message)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      r, intent, company, contact_name || '', email || '', phone || '',
      device_types || '', quantity || null, message || '');
  res.json({ ref: r, ok: true });
});

// GET /api/corporate — list (admin)
router.get('/', requireAdmin, (req, res) =>
  res.json(db.prepare('SELECT * FROM corporate_leads ORDER BY id DESC LIMIT 200').all()));

// PUT /api/corporate/:id/status (admin)
router.put('/:id/status', requireAdmin, (req, res) => {
  db.prepare('UPDATE corporate_leads SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
