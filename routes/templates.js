const express = require('express');
const db = require('../db');
const { requireAdmin } = require('./auth');
const router = express.Router();

// Public — used by the customer tracking timeline and the admin editor.
router.get('/order-templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM order_templates ORDER BY type, rowid').all());
});

// Admin — edit the label / subject / body for a status step.
router.put('/order-templates/:key', requireAdmin, (req, res) => {
  const { label, subject, body } = req.body;
  db.prepare('UPDATE order_templates SET label=COALESCE(?,label), subject=COALESCE(?,subject), body=COALESCE(?,body) WHERE key=?')
    .run(label ?? null, subject ?? null, body ?? null, req.params.key);
  res.json(db.prepare('SELECT * FROM order_templates WHERE key=?').get(req.params.key));
});

module.exports = router;
