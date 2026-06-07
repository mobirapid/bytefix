const express = require('express');
const db = require('../db');
const { requireAdmin } = require('./auth');
const router = express.Router();

/* ---------------- REPAIR ISSUES (per category) ---------------- */
router.get('/repair-issues', (req, res) => {
  const { category_id } = req.query;
  const rows = category_id
    ? db.prepare('SELECT * FROM repair_issues WHERE category_id=? ORDER BY sort, id').all(category_id)
    : db.prepare('SELECT * FROM repair_issues ORDER BY category_id, sort').all();
  res.json(rows);
});
router.post('/repair-issues', requireAdmin, (req, res) => {
  const { category_id, name, price = 0, eta = '', sort = 0, default_on = 1 } = req.body;
  if (!category_id || !name) return res.status(400).json({ error: 'category_id and name required' });
  const info = db.prepare('INSERT INTO repair_issues (category_id,name,price,eta,sort,default_on) VALUES (?,?,?,?,?,?)')
    .run(category_id, name, price, eta, sort, default_on ? 1 : 0);
  res.json(db.prepare('SELECT * FROM repair_issues WHERE id=?').get(info.lastInsertRowid));
});
router.put('/repair-issues/:id', requireAdmin, (req, res) => {
  const { name, price, eta, sort, default_on } = req.body;
  db.prepare('UPDATE repair_issues SET name=COALESCE(?,name), price=COALESCE(?,price), eta=COALESCE(?,eta), sort=COALESCE(?,sort), default_on=COALESCE(?,default_on) WHERE id=?')
    .run(name ?? null, price ?? null, eta ?? null, sort ?? null, default_on ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM repair_issues WHERE id=?').get(req.params.id));
});
router.delete('/repair-issues/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM repair_issues WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- PER-MODEL REPAIR PRICES ---------------- */
// effective issue list for one model: override price/eta if set, else category default
router.get('/models/:id/repair-issues', (req, res) => {
  const rows = db.prepare(`
    SELECT ri.id AS issue_id, ri.name, ri.sort, ri.default_on,
           ri.price AS default_price, ri.eta AS default_eta,
           mrp.price AS override_price, mrp.eta AS override_eta, mrp.enabled AS enabled
    FROM repair_issues ri
    LEFT JOIN model_repair_prices mrp ON mrp.issue_id = ri.id AND mrp.model_id = ?
    WHERE ri.category_id = (SELECT b.category_id FROM models m JOIN brands b ON b.id = m.brand_id WHERE m.id = ?)
    ORDER BY ri.sort, ri.id`).all(req.params.id, req.params.id);
  res.json(rows.map(r => ({
    issue_id: r.issue_id, name: r.name,
    default_price: r.default_price, default_eta: r.default_eta,
    price: r.override_price ?? r.default_price,
    eta: r.override_eta ?? r.default_eta,
    is_override: r.override_price != null,
    default_on: !!r.default_on,
    applies: r.enabled != null ? !!r.enabled : !!r.default_on,
  })));
});

// admin: set a model-specific price/eta and/or applicability (enabled)
router.put('/model-repair-prices', requireAdmin, (req, res) => {
  const { model_id, issue_id, price, eta, enabled } = req.body;
  if (!model_id || !issue_id) return res.status(400).json({ error: 'model_id and issue_id required' });
  const cur = db.prepare('SELECT price,eta,enabled FROM model_repair_prices WHERE model_id=? AND issue_id=?').get(model_id, issue_id) || {};
  const nPrice = price !== undefined ? (price ?? null) : (cur.price ?? null);
  const nEta = eta !== undefined ? (eta ?? null) : (cur.eta ?? null);
  const nEnabled = enabled !== undefined ? (enabled === null ? null : (enabled ? 1 : 0)) : (cur.enabled ?? null);
  // nothing left to store → drop the row so it cleanly inherits category defaults
  if (nPrice == null && (nEta == null || nEta === '') && nEnabled == null) {
    db.prepare('DELETE FROM model_repair_prices WHERE model_id=? AND issue_id=?').run(model_id, issue_id);
    return res.json({ ok: true, cleared: true });
  }
  db.prepare(`INSERT INTO model_repair_prices (model_id,issue_id,price,eta,enabled) VALUES (?,?,?,?,?)
    ON CONFLICT(model_id,issue_id) DO UPDATE SET price=?, eta=?, enabled=?`)
    .run(model_id, issue_id, nPrice, nEta, nEnabled, nPrice, nEta, nEnabled);
  res.json({ ok: true });
});

// admin: clear an override (revert this model+issue to the category default)
router.delete('/model-repair-prices', requireAdmin, (req, res) => {
  const { model_id, issue_id } = req.body;
  db.prepare('DELETE FROM model_repair_prices WHERE model_id=? AND issue_id=?').run(model_id, issue_id);
  res.json({ ok: true });
});

/* ---------------- CONDITION MODIFIERS (resale) ---------------- */
router.get('/conditions', (req, res) => {
  const groups = db.prepare('SELECT * FROM condition_groups ORDER BY sort, id').all();
  const opts = db.prepare('SELECT * FROM condition_options ORDER BY sort, id').all();
  res.json(groups.map(g => ({ ...g, options: opts.filter(o => o.group_id === g.id) })));
});
router.post('/condition-groups', requireAdmin, (req, res) => {
  const info = db.prepare('INSERT INTO condition_groups (name,sort) VALUES (?,?)').run(req.body.name, req.body.sort || 0);
  res.json(db.prepare('SELECT * FROM condition_groups WHERE id=?').get(info.lastInsertRowid));
});
router.delete('/condition-groups/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM condition_groups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
router.post('/condition-options', requireAdmin, (req, res) => {
  const { group_id, label, factor = 100, sort = 0 } = req.body;
  const info = db.prepare('INSERT INTO condition_options (group_id,label,factor,sort) VALUES (?,?,?,?)').run(group_id, label, factor, sort);
  res.json(db.prepare('SELECT * FROM condition_options WHERE id=?').get(info.lastInsertRowid));
});
router.put('/condition-options/:id', requireAdmin, (req, res) => {
  const { label, factor } = req.body;
  db.prepare('UPDATE condition_options SET label=COALESCE(?,label), factor=COALESCE(?,factor) WHERE id=?')
    .run(label ?? null, factor ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM condition_options WHERE id=?').get(req.params.id));
});
router.delete('/condition-options/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM condition_options WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- SETTINGS ---------------- */
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
router.put('/settings', requireAdmin, (req, res) => {
  const set = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  db.tx(() => { for (const [k, v] of Object.entries(req.body || {})) set.run(k, String(v)); });
  res.json({ ok: true });
});

module.exports = router;
