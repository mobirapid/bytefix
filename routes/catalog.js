const express = require('express');
const db = require('../db');
const { requireAdmin } = require('./auth');
const router = express.Router();

/* ---------------- PUBLIC READ ---------------- */

// Full catalog tree (categories -> brands -> models). Powers the customer app.
// Each node also carries repair_cities[] and sell_cities[] (city-wise availability).
router.get('/catalog', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY sort, id').all();
  const brandsByCat = db.prepare('SELECT * FROM brands ORDER BY sort, name').all();
  const models = db.prepare('SELECT * FROM models WHERE active=1 ORDER BY base_value DESC').all();
  const cityRows = db.prepare('SELECT level,item_id,flow,city FROM item_cities').all();
  const cityMap = {}; // level:id -> { repair:[], sell:[] }
  for (const r of cityRows) {
    const k = r.level + ':' + r.item_id;
    (cityMap[k] || (cityMap[k] = { repair: [], sell: [] }))[r.flow]?.push(r.city);
  }
  const withCities = (level, o) => {
    const c = cityMap[level + ':' + o.id] || { repair: [], sell: [] };
    return { ...o, repair_cities: c.repair, sell_cities: c.sell };
  };
  const tree = cats.map(c => ({
    ...withCities('category', c),
    brands: brandsByCat.filter(b => b.category_id === c.id).map(b => ({
      ...withCities('brand', b),
      models: models.filter(m => m.brand_id === b.id).map(m => withCities('model', m)),
    })),
  }));
  res.json(tree);
});

// Set the cities an item is available in, for a flow. Replaces the list. (admin)
// Body: { level:'category'|'brand'|'model', item_id, flow:'repair'|'sell', cities:[...] }
router.put('/item-cities', requireAdmin, (req, res) => {
  const { level, item_id, flow } = req.body || {};
  if (!['category', 'brand', 'model'].includes(level)) return res.status(400).json({ error: 'bad level' });
  if (!['repair', 'sell'].includes(flow)) return res.status(400).json({ error: 'bad flow' });
  const id = Number(item_id);
  if (!id) return res.status(400).json({ error: 'bad item_id' });
  const cities = Array.isArray(req.body.cities) ? [...new Set(req.body.cities.map(c => String(c).trim()).filter(Boolean))] : [];
  db.tx(() => {
    db.prepare('DELETE FROM item_cities WHERE level=? AND item_id=? AND flow=?').run(level, id, flow);
    const ins = db.prepare('INSERT OR IGNORE INTO item_cities (level,item_id,flow,city) VALUES (?,?,?,?)');
    cities.forEach(c => ins.run(level, id, flow, c));
  });
  res.json({ ok: true, level, item_id: id, flow, cities });
});

router.get('/categories', (req, res) =>
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort, id').all()));

router.get('/categories/:id/brands', (req, res) =>
  res.json(db.prepare('SELECT * FROM brands WHERE category_id=? ORDER BY sort, name').all(req.params.id)));

router.get('/brands/:id/models', (req, res) =>
  res.json(db.prepare('SELECT * FROM models WHERE brand_id=? ORDER BY base_value DESC').all(req.params.id)));

/* ---------------- ADMIN WRITE ---------------- */

// categories
router.post('/categories', requireAdmin, (req, res) => {
  const { slug, name, emoji = '', sort = 0, for_repair = 1, for_sell = 1 } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
  try {
    const info = db.prepare('INSERT INTO categories (slug,name,emoji,sort,for_repair,for_sell) VALUES (?,?,?,?,?,?)')
      .run(slug, name, emoji, sort, for_repair ? 1 : 0, for_sell ? 1 : 0);
    res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(info.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: 'Slug must be unique' }); }
});
router.put('/categories/:id', requireAdmin, (req, res) => {
  const { name, emoji, sort, active, for_repair, for_sell } = req.body;
  const norm = v => v == null ? null : (v ? 1 : 0);
  db.prepare(`UPDATE categories SET name=COALESCE(?,name), emoji=COALESCE(?,emoji), sort=COALESCE(?,sort),
              active=COALESCE(?,active), for_repair=COALESCE(?,for_repair), for_sell=COALESCE(?,for_sell) WHERE id=?`)
    .run(name ?? null, emoji ?? null, sort ?? null, active ?? null, norm(for_repair), norm(for_sell), req.params.id);
  res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id));
});
router.delete('/categories/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// brands
router.post('/brands', requireAdmin, (req, res) => {
  const { category_id, name, sort = 0, for_repair = 1, for_sell = 1 } = req.body;
  if (!category_id || !name) return res.status(400).json({ error: 'category_id and name required' });
  const info = db.prepare('INSERT INTO brands (category_id,name,sort,for_repair,for_sell) VALUES (?,?,?,?,?)')
    .run(category_id, name, sort, for_repair ? 1 : 0, for_sell ? 1 : 0);
  res.json(db.prepare('SELECT * FROM brands WHERE id=?').get(info.lastInsertRowid));
});
router.put('/brands/:id', requireAdmin, (req, res) => {
  const { name, sort, for_repair, for_sell } = req.body;
  const norm = v => v == null ? null : (v ? 1 : 0);
  db.prepare('UPDATE brands SET name=COALESCE(?,name), sort=COALESCE(?,sort), for_repair=COALESCE(?,for_repair), for_sell=COALESCE(?,for_sell) WHERE id=?')
    .run(name ?? null, sort ?? null, norm(for_repair), norm(for_sell), req.params.id);
  res.json(db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id));
});
router.delete('/brands/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM brands WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// models
router.post('/models', requireAdmin, (req, res) => {
  const { brand_id, name, base_value = 0, for_repair = 1, for_sell = 1 } = req.body;
  if (!brand_id || !name) return res.status(400).json({ error: 'brand_id and name required' });
  const info = db.prepare('INSERT INTO models (brand_id,name,base_value,for_repair,for_sell) VALUES (?,?,?,?,?)')
    .run(brand_id, name, base_value, for_repair ? 1 : 0, for_sell ? 1 : 0);
  res.json(db.prepare('SELECT * FROM models WHERE id=?').get(info.lastInsertRowid));
});
router.put('/models/:id', requireAdmin, (req, res) => {
  const { name, base_value, active, for_repair, for_sell } = req.body;
  const norm = v => v == null ? null : (v ? 1 : 0);
  db.prepare('UPDATE models SET name=COALESCE(?,name), base_value=COALESCE(?,base_value), active=COALESCE(?,active), for_repair=COALESCE(?,for_repair), for_sell=COALESCE(?,for_sell) WHERE id=?')
    .run(name ?? null, base_value ?? null, active ?? null, norm(for_repair), norm(for_sell), req.params.id);
  res.json(db.prepare('SELECT * FROM models WHERE id=?').get(req.params.id));
});
router.delete('/models/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM models WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
