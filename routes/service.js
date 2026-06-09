// Service Requests: configurable statuses, operator order management,
// discussion comments + attachments, and ratings/reviews.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAdmin, requirePerm, userFromToken, permsOf, rolesOf, citiesFor } = require('./auth');
const { notify } = require('./notify');
const { verifyCode, sendOtp } = require('./otp');
const router = express.Router();

const COLORS = ['red', 'orange', 'yellow', 'lightgreen', 'darkgreen'];
const MAX_BYTES = 7 * 1024 * 1024; // 7 MB
const OK_MIME = (m) => /^image\//.test(m) || m === 'application/pdf';

/* ---------------- Configurable statuses ---------------- */
// Public: storefront + admin both read these for badges and pipelines.
router.get('/order-statuses', (req, res) => {
  res.json(db.prepare('SELECT id,flow,key,label,color,sort FROM order_statuses ORDER BY flow,sort,id').all());
});
router.post('/order-statuses', requireAdmin, (req, res) => {
  let { flow, key, label, color, sort } = req.body || {};
  flow = String(flow || '').trim(); key = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  label = String(label || '').trim(); color = COLORS.includes(color) ? color : 'orange';
  if (!['repair', 'sell'].includes(flow)) return res.status(400).json({ error: 'flow must be repair or sell' });
  if (!key) return res.status(400).json({ error: 'A status key is required' });
  if (!label) return res.status(400).json({ error: 'A label is required' });
  const exists = db.prepare('SELECT 1 FROM order_statuses WHERE flow=? AND key=?').get(flow, key);
  if (exists) return res.status(400).json({ error: 'That status already exists for this journey' });
  const n = (sort == null) ? (db.prepare('SELECT COALESCE(MAX(sort)+1,0) s FROM order_statuses WHERE flow=?').get(flow).s) : Number(sort);
  const info = db.prepare('INSERT INTO order_statuses (flow,key,label,color,sort) VALUES (?,?,?,?,?)').run(flow, key, label, color, n);
  // Ensure an email template row exists for the new step.
  db.prepare('INSERT OR IGNORE INTO order_templates (key,type,status,label,subject,body) VALUES (?,?,?,?,?,?)')
    .run(flow + ':' + key, flow, key, label, 'Update on your order · {ref}', 'Hi {name}, your {device} is now: ' + label + '. Reference: {ref}.');
  res.json(db.prepare('SELECT * FROM order_statuses WHERE id=?').get(info.lastInsertRowid));
});
router.put('/order-statuses/:id', requireAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM order_statuses WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Status not found' });
  let { label, color, sort } = req.body || {};
  if (color != null && !COLORS.includes(color)) return res.status(400).json({ error: 'Invalid colour' });
  db.prepare('UPDATE order_statuses SET label=COALESCE(?,label), color=COALESCE(?,color), sort=COALESCE(?,sort) WHERE id=?')
    .run(label ?? null, color ?? null, (sort == null ? null : Number(sort)), s.id);
  res.json(db.prepare('SELECT * FROM order_statuses WHERE id=?').get(s.id));
});
router.delete('/order-statuses/:id', requireAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM order_statuses WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Status not found' });
  const used = db.prepare('SELECT COUNT(*) c FROM orders WHERE type=? AND status=?').get(s.flow, s.key).c;
  if (used) return res.status(400).json({ error: `In use by ${used} order(s) — reassign them first.` });
  db.prepare('DELETE FROM order_statuses WHERE id=?').run(s.id);
  res.json({ ok: true });
});

/* ---------------- Operator order management ---------------- */
// Which order flows may this user handle? repair_operator → repair, sell_operator
// → sell, operator/superadmin → both.
function flowsFor(uid) {
  const p = permsOf(uid), f = [];
  if (p.includes('service_repair') || p.includes('admin_panel')) f.push('repair');
  if (p.includes('service_sell') || p.includes('admin_panel')) f.push('sell');
  return f;
}
// Cities an operator may handle. null = all (superadmin, or operator with none set).
function cityScope(uid) {
  if (permsOf(uid).includes('admin_panel')) return null;
  const c = citiesFor(uid);
  return c.length ? c : null;
}
// Can this user act on this order? (flow + city)
function allowed(uid, o) {
  if (!flowsFor(uid).includes(o.type)) return false;
  const cs = cityScope(uid);
  if (cs && !cs.includes(o.city || '')) return false;
  return true;
}
// Operators see and move only the service requests in their flow(s).
router.get('/orders', requirePerm('service_requests'), (req, res) => {
  const flows = flowsFor(req.user.id);
  if (!flows.length) return res.json([]);
  const args = [...flows];
  let sql = `SELECT * FROM orders WHERE type IN (${flows.map(() => '?').join(',')})`;
  const cs = cityScope(req.user.id);
  if (cs) { sql += ` AND city IN (${cs.map(() => '?').join(',')})`; args.push(...cs); }
  sql += ' ORDER BY id DESC LIMIT 300';
  res.json(db.prepare(sql).all(...args));
});
router.get('/orders/:ref', requirePerm('service_requests'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!allowed(req.user.id, o)) return res.status(403).json({ error: 'Not in your queue.' });
  res.json(o);
});
router.put('/orders/:ref/status', requirePerm('service_requests'), (req, res) => {
  const status = String(req.body.status || '').trim();
  const o0 = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o0) return res.status(404).json({ error: 'Order not found' });
  if (!allowed(req.user.id, o0)) return res.status(403).json({ error: 'Not in your queue.' });
  const valid = db.prepare('SELECT 1 FROM order_statuses WHERE flow=? AND key=?').get(o0.type, status);
  if (!valid) return res.status(400).json({ error: 'Unknown status for this journey' });
  db.prepare('UPDATE orders SET status=? WHERE ref=?').run(status, req.params.ref);
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  notify(o, status);
  // log a system comment in the discussion
  db.prepare('INSERT INTO order_comments (order_ref,author_role,author_name,body) VALUES (?,?,?,?)')
    .run(o.ref, 'system', 'System', 'Status changed to "' + status + '".');
  res.json(o);
});

/* ---------------- Discussion: comments + attachments ---------------- */
// Helper: who is acting, and may they touch this order?
function actor(req) {
  const u = userFromToken(req);
  if (!u) return null;
  const perms = permsOf(u.id);
  const isOp = perms.includes('service_requests');
  return { u, isOp, role: isOp ? 'operator' : 'customer' };
}
function ownsOrder(u, order) {
  const last10 = String(u.phone || '').replace(/\D/g, '').slice(-10);
  return last10 && String(order.customer_phone || '').replace(/\D/g, '').endsWith(last10);
}

// Public read by ref (order tracking is public by reference). Attachments as metadata.
router.get('/orders/:ref/thread', (req, res) => {
  const o = db.prepare('SELECT ref FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const comments = db.prepare('SELECT id,author_role,author_name,body,created_at FROM order_comments WHERE order_ref=? ORDER BY id').all(req.params.ref);
  const att = db.prepare('SELECT id,comment_id,name,mime,size FROM order_attachments WHERE comment_id IN (SELECT id FROM order_comments WHERE order_ref=?)').all(req.params.ref);
  const byC = {}; att.forEach(a => (byC[a.comment_id] = byC[a.comment_id] || []).push(a));
  res.json(comments.map(c => ({ ...c, attachments: byC[c.id] || [] })));
});

// Post a comment (+ optional attachments). Customer (owner) or operator only.
router.post('/orders/:ref/comments', (req, res) => {
  const a = actor(req);
  if (!a) return res.status(401).json({ error: 'Please sign in to comment.' });
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (a.isOp) { if (!allowed(a.u.id, o) && !ownsOrder(a.u, o)) return res.status(403).json({ error: 'Not in your queue.' }); }
  else if (!ownsOrder(a.u, o)) return res.status(403).json({ error: 'This is not your order.' });

  const body = String(req.body.body || '').trim();
  const atts = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  if (!body && !atts.length) return res.status(400).json({ error: 'Write a message or attach a file.' });
  if (atts.length > 5) return res.status(400).json({ error: 'Up to 5 attachments per message.' });

  // Validate attachments before writing anything.
  const decoded = [];
  for (const f of atts) {
    const mime = String(f.mime || '');
    if (!OK_MIME(mime)) return res.status(400).json({ error: 'Only images and PDF files are allowed.' });
    let buf;
    try { buf = Buffer.from(String(f.data || '').split(',').pop(), 'base64'); }
    catch (e) { return res.status(400).json({ error: 'Bad file data.' }); }
    if (!buf.length) return res.status(400).json({ error: 'Empty file.' });
    if (buf.length > MAX_BYTES) return res.status(400).json({ error: 'Each file must be 7MB or smaller.' });
    decoded.push({ name: String(f.name || 'file').slice(0, 120), mime, size: buf.length, data: buf });
  }

  const id = db.tx(() => {
    const cid = db.prepare('INSERT INTO order_comments (order_ref,author_user_id,author_role,author_name,body) VALUES (?,?,?,?,?)')
      .run(o.ref, a.u.id, a.role, a.u.name || (a.isOp ? 'Operator' : 'Customer'), body).lastInsertRowid;
    const ia = db.prepare('INSERT INTO order_attachments (comment_id,name,mime,size,data) VALUES (?,?,?,?,?)');
    decoded.forEach(d => ia.run(cid, d.name, d.mime, d.size, d.data));
    return cid;
  });
  const c = db.prepare('SELECT id,author_role,author_name,body,created_at FROM order_comments WHERE id=?').get(id);
  c.attachments = db.prepare('SELECT id,comment_id,name,mime,size FROM order_attachments WHERE comment_id=?').all(id);
  res.json(c);
});

// Download an attachment by id.
router.get('/attachments/:id', (req, res) => {
  const a = db.prepare('SELECT name,mime,data FROM order_attachments WHERE id=?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + (a.name || 'file').replace(/"/g, '') + '"');
  res.send(Buffer.from(a.data));
});

/* ---------------- Ratings & reviews ---------------- */
router.get('/orders/:ref/reviews', (req, res) => {
  res.json(db.prepare('SELECT role,rating,review,created_at,updated_at FROM order_reviews WHERE order_ref=? ORDER BY role').all(req.params.ref));
});
router.post('/orders/:ref/reviews', (req, res) => {
  const a = actor(req);
  if (!a) return res.status(401).json({ error: 'Please sign in to review.' });
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (a.isOp) { if (!allowed(a.u.id, o) && !ownsOrder(a.u, o)) return res.status(403).json({ error: 'Not in your queue.' }); }
  else if (!ownsOrder(a.u, o)) return res.status(403).json({ error: 'This is not your order.' });
  const rating = Math.round(Number(req.body.rating));
  const review = String(req.body.review || '').trim().slice(0, 2000);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Rating must be 1 to 5 stars.' });
  db.prepare(`INSERT INTO order_reviews (order_ref,author_user_id,role,rating,review)
              VALUES (?,?,?,?,?)
              ON CONFLICT(order_ref,role) DO UPDATE SET
                rating=excluded.rating, review=excluded.review,
                author_user_id=excluded.author_user_id, updated_at=datetime('now')`)
    .run(o.ref, a.u.id, a.role, rating, review);
  res.json(db.prepare('SELECT role,rating,review,created_at,updated_at FROM order_reviews WHERE order_ref=? AND role=?').get(o.ref, a.role));
});

/* ---------------- Resale KYC / ownership document ---------------- */
function kycMeta(ref) {
  // Includes id_number — only ever returned to operators on flow-gated endpoints.
  const r = db.prepare(`SELECT k.order_ref,k.id_type,k.id_last4,k.id_number,k.serial,k.consent,k.consent_name,k.consent_at,
      k.consent_method,k.sign_ref,k.signed_phone,k.doc_name,k.doc_mime,k.doc_size,k.updated_at,
      k.verified,k.verified_at,
      u.name AS operator_name, u.username AS operator_username,
      v.name AS verified_name, v.username AS verified_username
    FROM order_kyc k LEFT JOIN users u ON u.id=k.by_user LEFT JOIN users v ON v.id=k.verified_by WHERE k.order_ref=?`).get(ref);
  return r ? { ...r, has_doc: !!r.doc_name } : null;
}
function kycGuard(req, res) {
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) { res.status(404).json({ error: 'Order not found' }); return null; }
  if (!allowed(req.user.id, o)) { res.status(403).json({ error: 'Not in your queue.' }); return null; }
  return o;
}
router.get('/orders/:ref/kyc', requirePerm('service_requests'), (req, res) => {
  if (!kycGuard(req, res)) return;
  res.json(kycMeta(req.params.ref) || {});
});
router.put('/orders/:ref/kyc', requirePerm('service_requests'), (req, res) => {
  const o = kycGuard(req, res); if (!o) return;
  const b = req.body || {};
  const id_type = String(b.id_type || '').slice(0, 24);
  const id_number = String(b.id_number || '').trim().slice(0, 40);
  const id_last4 = id_number.replace(/\D/g, '').slice(-4);
  const serial = String(b.serial || '').slice(0, 80).trim();
  const consent = b.consent ? 1 : 0;
  const consent_name = String(b.consent_name || '').slice(0, 120);
  let doc = null;
  if (b.doc && b.doc.data) {
    const mime = String(b.doc.mime || '');
    if (!OK_MIME(mime)) return res.status(400).json({ error: 'ID must be an image or PDF.' });
    let buf; try { buf = Buffer.from(String(b.doc.data).split(',').pop(), 'base64'); } catch (e) { return res.status(400).json({ error: 'Bad file.' }); }
    if (!buf.length) return res.status(400).json({ error: 'Empty file.' });
    if (buf.length > MAX_BYTES) return res.status(400).json({ error: 'ID file must be 7MB or smaller.' });
    doc = { name: String(b.doc.name || 'id').slice(0, 120), mime, size: buf.length, data: buf };
  }
  const existing = db.prepare('SELECT * FROM order_kyc WHERE order_ref=?').get(o.ref);
  const consent_at = consent ? new Date().toISOString() : (existing ? existing.consent_at : null);
  if (existing) {
    db.prepare(`UPDATE order_kyc SET id_type=?,id_last4=?,id_number=?,serial=?,consent=?,consent_name=?,consent_at=?,by_user=?,ip=?,updated_at=datetime('now')
      ${doc ? ',doc_name=?,doc_mime=?,doc_size=?,doc_data=?' : ''} WHERE order_ref=?`)
      .run(id_type, id_last4, id_number, serial, consent, consent_name, consent_at, req.user.id, req.ip || '',
        ...(doc ? [doc.name, doc.mime, doc.size, doc.data] : []), o.ref);
  } else {
    db.prepare(`INSERT INTO order_kyc (order_ref,id_type,id_last4,id_number,serial,consent,consent_name,consent_at,by_user,ip,doc_name,doc_mime,doc_size,doc_data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(o.ref, id_type, id_last4, id_number, serial, consent, consent_name, consent_at, req.user.id, req.ip || '',
        doc ? doc.name : null, doc ? doc.mime : null, doc ? doc.size : null, doc ? doc.data : null);
  }
  res.json(kycMeta(o.ref));
});
// Send an OTP to the seller's phone for e-signing the consent.
router.post('/orders/:ref/kyc/send-otp', requirePerm('service_requests'), async (req, res) => {
  const o = kycGuard(req, res); if (!o) return;
  const phone = (o.customer_phone || '').replace(/\D/g, '');
  if (phone.length < 10) return res.status(400).json({ error: 'No valid phone on this order.' });
  try {
    const out = await sendOtp(phone); // direct call — no internal HTTP loopback
    res.json({ sent: true, phone_last4: phone.slice(-4), dev_code: out.dev_code });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || 'Could not send the OTP.' });
  }
});

// Verify the seller's OTP and record it as a digital signature on the consent.
router.post('/orders/:ref/kyc/sign', requirePerm('service_requests'), (req, res) => {
  const o = kycGuard(req, res); if (!o) return;
  const phone = o.customer_phone || '';
  if (!verifyCode(phone, req.body.code)) return res.status(400).json({ error: 'Incorrect or expired OTP.' });
  const signRef = 'ESIGN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const at = new Date().toISOString();
  const existing = db.prepare('SELECT order_ref FROM order_kyc WHERE order_ref=?').get(o.ref);
  if (existing) {
    db.prepare("UPDATE order_kyc SET consent=1, consent_method='otp', consent_at=?, sign_ref=?, signed_phone=?, by_user=?, ip=?, updated_at=datetime('now') WHERE order_ref=?")
      .run(at, signRef, phone, req.user.id, req.ip || '', o.ref);
  } else {
    db.prepare("INSERT INTO order_kyc (order_ref,consent,consent_method,consent_at,sign_ref,signed_phone,by_user,ip) VALUES (?,1,'otp',?,?,?,?,?)")
      .run(o.ref, at, signRef, phone, req.user.id, req.ip || '');
  }
  res.json(kycMeta(o.ref));
});

// Superadmin verifies (approves) the KYC — the document is only valid once verified.
router.post('/orders/:ref/kyc/verify', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT ref FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const k = db.prepare('SELECT order_ref FROM order_kyc WHERE order_ref=?').get(o.ref);
  if (!k) return res.status(400).json({ error: 'No KYC to verify on this order.' });
  const verified = req.body.verified === false ? 0 : 1;
  db.prepare('UPDATE order_kyc SET verified=?, verified_by=?, verified_at=? WHERE order_ref=?')
    .run(verified, verified ? req.admin.id : null, verified ? new Date().toISOString() : null, o.ref);
  res.json(kycMeta(o.ref));
});

// Stream the stored ID document — operators only (NOT public).
router.get('/orders/:ref/kyc/doc', requirePerm('service_requests'), (req, res) => {
  if (!kycGuard(req, res)) return;
  const r = db.prepare('SELECT doc_name,doc_mime,doc_data FROM order_kyc WHERE order_ref=?').get(req.params.ref);
  if (!r || !r.doc_data) return res.status(404).json({ error: 'No document on file' });
  res.setHeader('Content-Type', r.doc_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + (r.doc_name || 'id').replace(/"/g, '') + '"');
  res.send(Buffer.from(r.doc_data));
});

module.exports = router;
