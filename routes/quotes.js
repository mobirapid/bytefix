const express = require('express');
const db = require('../db');
const router = express.Router();

const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return r ? r.value : d;
};

// POST /api/quotes/repair  { model_id, issue_ids:[], service_mode }
router.post('/repair', (req, res) => {
  const { model_id = null, issue_ids = [] } = req.body;
  if (!Array.isArray(issue_ids) || !issue_ids.length)
    return res.status(400).json({ error: 'Select at least one issue' });
  const placeholders = issue_ids.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT ri.id, ri.name,
           COALESCE(mrp.price, ri.price) AS price,
           COALESCE(mrp.eta, ri.eta) AS eta
    FROM repair_issues ri
    LEFT JOIN model_repair_prices mrp ON mrp.issue_id = ri.id AND mrp.model_id = ?
    WHERE ri.id IN (${placeholders}) AND COALESCE(mrp.enabled, ri.default_on) = 1`).all(model_id, ...issue_ids);
  if (!items.length) return res.status(400).json({ error: 'Selected issues are not available for this model' });
  const subtotal = items.reduce((a, b) => a + b.price, 0);
  const gst = Math.round(subtotal * Number(getSetting('gst_percent', 18)) / 100);
  res.json({ items, subtotal, gst_percent: Number(getSetting('gst_percent', 18)), gst, total: subtotal + gst });
});

// POST /api/quotes/sell  { model_id, answers: { groupId: optionId, ... } }
router.post('/sell', (req, res) => {
  const { model_id, answers = {} } = req.body;
  const model = db.prepare('SELECT * FROM models WHERE id=?').get(model_id);
  if (!model) return res.status(404).json({ error: 'Model not found' });
  let value = model.base_value;
  const applied = [];
  for (const optId of Object.values(answers)) {
    const opt = db.prepare('SELECT * FROM condition_options WHERE id=?').get(optId);
    if (opt) { value *= opt.factor / 100; applied.push({ label: opt.label, factor: opt.factor }); }
  }
  value = Math.round(value / 50) * 50; // round to nearest ₹50
  res.json({ base_value: model.base_value, applied, payout: value });
});

module.exports = router;
