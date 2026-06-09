const express = require('express');
const db = require('../db');
const { requireAdmin } = require('./auth');
const { verifyBooking } = require('./otp');
const { notify } = require('./notify');
const { sendEmail } = require('./mailer');
const { record } = require('./auditlog');
const router = express.Router();

const ref = () => 'RG' + Math.random().toString(36).slice(2, 7).toUpperCase();
const DEV_OTP = process.env.DEV_OTP !== 'false';
const delCodes = new Map(); // adminId -> { code, ref, expires }

// POST /api/orders  — create a repair or sell order (customer). Requires a verified phone.
router.post('/', async (req, res) => {
  const { type, model_id, device_label, details, amount, service_mode,
          customer_name, customer_phone, customer_email, address, slot, city, booking_token } = req.body;
  if (!['repair', 'sell'].includes(type)) return res.status(400).json({ error: 'type must be repair or sell' });
  if (!(await verifyBooking(booking_token, customer_phone)))
    return res.status(401).json({ error: 'Phone not verified. Please verify with the OTP first.' });
  const r = ref();
  const info = db.prepare(`INSERT INTO orders
    (ref,type,model_id,device_label,details,amount,service_mode,customer_name,customer_phone,customer_email,address,slot,city,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r, type, model_id || null, device_label || '', JSON.stringify(details || {}),
      amount || 0, service_mode || null, customer_name || '', customer_phone || '', customer_email || '',
      address || '', slot || '', city || '', 'placed');
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(info.lastInsertRowid);
  notify(o, 'placed'); // booking confirmation email
  try { db.prepare('INSERT INTO consent_log (phone,email,kind,detail,ip) VALUES (?,?,?,?,?)')
    .run(o.customer_phone || '', o.customer_email || '', 'booking', 'Agreed to Terms & Privacy at booking ' + o.ref, req.ip || ''); } catch (e) {}
  res.json(o);
});

// GET /api/orders/:ref — public tracking
router.get('/:ref', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  res.json(o);
});

// GET /api/orders — admin list (with KYC presence + verification status)
router.get('/', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT o.*,
      (k.order_ref IS NOT NULL) AS has_kyc, COALESCE(k.verified,0) AS kyc_verified,
      (k.doc_name IS NOT NULL) AS has_doc
    FROM orders o LEFT JOIN order_kyc k ON k.order_ref=o.ref
    ORDER BY o.id DESC LIMIT 200`).all());
});

// PUT /api/orders/:ref/status — admin update (emails the customer using the step template)
router.put('/:ref/status', requireAdmin, (req, res) => {
  const status = String(req.body.status || '').trim();
  const o0 = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o0) return res.status(404).json({ error: 'Order not found' });
  const valid = db.prepare('SELECT 1 FROM order_statuses WHERE flow=? AND key=?').get(o0.type, status);
  if (!valid) return res.status(400).json({ error: 'Unknown status for this journey' });
  db.prepare('UPDATE orders SET status=? WHERE ref=?').run(status, req.params.ref);
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  notify(o, status); // emails the customer for this stage (if enabled)
  db.prepare('INSERT INTO order_comments (order_ref,author_role,author_name,body) VALUES (?,?,?,?)')
    .run(o.ref, 'system', 'System', 'Status changed to "' + status + '".');
  res.json(o);
});

// Superadmin order delete — requires an emailed OTP to confirm.
router.post('/:ref/delete-otp', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT ref FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  delCodes.set(req.admin.id, { code, ref: o.ref, expires: Date.now() + 5 * 60000 });
  const to = req.admin.email || req.admin.username;
  if (to) sendEmail(to, 'Confirm order deletion', `Your code to delete order ${o.ref} is ${code}. It is valid for 5 minutes. If this wasn't you, ignore this email.`);
  res.json({ sent: true, ...(DEV_OTP ? { dev_code: code } : {}) });
});
router.delete('/:ref', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const rec = delCodes.get(req.admin.id);
  const code = String(req.body.code || '').trim();
  if (!rec || rec.ref !== o.ref || Date.now() > rec.expires || rec.code !== code)
    return res.status(400).json({ error: 'Invalid or expired confirmation code.' });
  delCodes.delete(req.admin.id);
  db.tx(() => {
    db.prepare('DELETE FROM order_attachments WHERE comment_id IN (SELECT id FROM order_comments WHERE order_ref=?)').run(o.ref);
    db.prepare('DELETE FROM order_comments WHERE order_ref=?').run(o.ref);
    db.prepare('DELETE FROM order_reviews WHERE order_ref=?').run(o.ref);
    db.prepare('DELETE FROM order_kyc WHERE order_ref=?').run(o.ref);
    db.prepare('DELETE FROM orders WHERE ref=?').run(o.ref);
  });
  record({ actor_id: req.admin.id, actor_name: req.admin.name || req.admin.username, actor_role: 'superadmin', action: 'ORDER_DELETED', detail: o.ref + ' (' + o.type + ', ' + (o.device_label || '') + ')', ip: req.ip || '' });
  res.json({ ok: true });
});

module.exports = router;
