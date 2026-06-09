// Access management — superadmin searches users and updates their roles.
const express = require('express');
const db = require('../db');
const { requireAdmin, rolesOf, permsOf } = require('./auth');
const router = express.Router();

const VALID = () => db.prepare('SELECT key FROM roles').all().map(r => r.key);

// List / search users (with their roles). Superadmin only.
router.get('/users', requireAdmin, (req, res) => {
  const q = '%' + String(req.query.q || '').trim().toLowerCase() + '%';
  const rows = db.prepare(`SELECT id,name,email,phone,username,created_at FROM users
    WHERE lower(COALESCE(name,'')) LIKE ? OR lower(COALESCE(email,'')) LIKE ?
       OR COALESCE(phone,'') LIKE ? OR lower(COALESCE(username,'')) LIKE ?
    ORDER BY id DESC LIMIT 200`).all(q, q, q, q);
  res.json(rows.map(u => ({ ...u, roles: rolesOf(u.id), perms: permsOf(u.id) })));
});

// All roles (for the picker).
router.get('/roles', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT key,name,description,sort FROM roles ORDER BY sort').all());
});

// Replace a user's roles. Superadmin only.
router.put('/users/:id/roles', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const valid = VALID();
  const roles = Array.isArray(req.body.roles) ? req.body.roles.filter(r => valid.includes(r)) : [];
  // Guard: never strip the last superadmin in the system.
  if (!roles.includes('superadmin')) {
    const supers = db.prepare("SELECT COUNT(*) c FROM user_roles WHERE role_key='superadmin'").get().c;
    const wasSuper = rolesOf(id).includes('superadmin');
    if (wasSuper && supers <= 1) return res.status(400).json({ error: 'Cannot remove the last superadmin.' });
  }
  db.tx(() => {
    db.prepare('DELETE FROM user_roles WHERE user_id=?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO user_roles (user_id,role_key) VALUES (?,?)');
    (roles.length ? roles : ['customer']).forEach(r => ins.run(id, r));
  });
  res.json({ id, roles: rolesOf(id), perms: permsOf(id) });
});

// DPDP data-deletion requests (superadmin).
router.get('/deletion-requests', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM deletion_requests ORDER BY id DESC LIMIT 300').all());
});
router.put('/deletion-requests/:id', requireAdmin, (req, res) => {
  const status = ['open', 'done'].includes(req.body.status) ? req.body.status : 'open';
  db.prepare('UPDATE deletion_requests SET status=? WHERE id=?').run(status, Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
