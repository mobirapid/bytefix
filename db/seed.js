// Seeds the database with realistic starter data.
// Auto-runs on first `npm start` if the DB is empty; or run manually with `npm run seed`.
const db = require('./index');

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM categories').get().c > 0) return false;

  const insCat = db.prepare('INSERT INTO categories (slug,name,emoji,sort) VALUES (?,?,?,?)');
  const insBrand = db.prepare('INSERT INTO brands (category_id,name,sort) VALUES (?,?,?)');
  const insModel = db.prepare('INSERT INTO models (brand_id,name,base_value) VALUES (?,?,?)');
  const insIssue = db.prepare('INSERT INTO repair_issues (category_id,name,price,eta,sort) VALUES (?,?,?,?,?)');
  const insGroup = db.prepare('INSERT INTO condition_groups (name,sort) VALUES (?,?)');
  const insOpt = db.prepare('INSERT INTO condition_options (group_id,label,factor,sort) VALUES (?,?,?,?)');
  const setKV = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');

  const CATALOG = {
    phone: { name: 'Phone', emoji: '📱', brands: {
      Apple: [['iPhone 15 Pro',62000],['iPhone 14',41000],['iPhone 13',31000],['iPhone 12',22000]],
      Samsung: [['Galaxy S24',47000],['Galaxy S23',34000],['Galaxy A55',18000]],
      OnePlus: [['OnePlus 12',38000],['OnePlus 11',28000],['Nord 4',16000]],
      Xiaomi: [['Xiaomi 14',30000],['Redmi Note 13',9000]] }},
    laptop: { name: 'Laptop', emoji: '💻', brands: {
      Apple: [['MacBook Air M3',78000],['MacBook Pro M2',95000],['MacBook Air M1',48000]],
      Dell: [['XPS 13',42000],['Inspiron 15',19000]],
      HP: [['Spectre x360',46000],['Pavilion 14',18000]],
      Lenovo: [['ThinkPad X1',55000],['IdeaPad 3',16000]] }},
    tablet: { name: 'Tablet', emoji: '🪟', brands: {
      Apple: [['iPad Pro 11',55000],['iPad Air',38000],['iPad 10th gen',22000]],
      Samsung: [['Galaxy Tab S9',42000]] }},
    watch: { name: 'Watch', emoji: '⌚', brands: {
      Apple: [['Watch Series 9',32000],['Watch SE',18000]],
      Samsung: [['Galaxy Watch 6',16000]] }},
    audio: { name: 'Earbuds', emoji: '🎧', brands: {
      Apple: [['AirPods Pro 2',14000],['AirPods 3',9000]],
      Sony: [['WF-1000XM5',12000]], Boat: [['Airdopes 161',600]] }},
  };
  const ISSUES = {
    phone: [['Screen replacement',4500,'30 min'],['Battery replacement',1800,'30 min'],['Charging port',1500,'45 min'],['Back glass',2200,'1 hr'],['Camera repair',2800,'1 hr'],['Water damage',3500,'2–3 days'],['Not turning on',2000,'1–2 days'],['Speaker / mic',1400,'45 min']],
    laptop: [['Screen replacement',8500,'1 day'],['Battery replacement',3800,'2 hrs'],['Keyboard replacement',3200,'2 hrs'],['Liquid damage',6500,'3–4 days'],['Not turning on',4500,'2–3 days'],['SSD upgrade',5000,'1 day'],['OS / software',1200,'Same day']],
    tablet: [['Screen replacement',5500,'1 day'],['Battery replacement',2400,'1 day'],['Charging port',1800,'1 day'],['Not turning on',2600,'2 days']],
    watch: [['Screen replacement',3800,'1 day'],['Battery replacement',1900,'1 day'],['Back glass',1600,'1 day']],
    audio: [['No sound / one side',900,'1 day'],['Charging case',1200,'1 day'],['Battery drain',1100,'2 days']],
  };
  const CONDITIONS = {
    'Power & function': [['Works perfectly',100],['Switches on, minor issues',55],["Dead / won't turn on",18]],
    'Screen': [['Flawless',100],['Minor scratches',90],['Cracked / spots',60]],
    'Body & frame': [['Like new',100],['Light wear',93],['Dents / heavy use',82]],
    'Accessories': [['Box + bill + charger',105],['Charger only',100],['Device only',96]],
  };

  db.tx(() => {
    let cSort = 0;
    for (const [slug, cat] of Object.entries(CATALOG)) {
      const catId = insCat.run(slug, cat.name, cat.emoji, cSort++).lastInsertRowid;
      let bSort = 0;
      for (const [brand, models] of Object.entries(cat.brands)) {
        const brandId = insBrand.run(catId, brand, bSort++).lastInsertRowid;
        for (const [m, base] of models) insModel.run(brandId, m, base);
      }
      (ISSUES[slug] || []).forEach((it, i) => insIssue.run(catId, it[0], it[1], it[2], i));
    }
    let gSort = 0;
    for (const [g, opts] of Object.entries(CONDITIONS)) {
      const gid = insGroup.run(g, gSort++).lastInsertRowid;
      opts.forEach((o, i) => insOpt.run(gid, o[0], o[1], i));
    }
    // demo per-model overrides so prices visibly differ by model
    const findModel = db.prepare('SELECT id FROM models WHERE name=?');
    const findIssue = db.prepare('SELECT ri.id FROM repair_issues ri JOIN categories c ON c.id=ri.category_id WHERE c.slug=? AND ri.name=?');
    const setOverride = db.prepare('INSERT OR REPLACE INTO model_repair_prices (model_id,issue_id,price,eta) VALUES (?,?,?,?)');
    const OVERRIDES = [
      ['iPhone 15 Pro','phone','Screen replacement',12000,'45 min'],
      ['iPhone 15 Pro','phone','Battery replacement',2500,'45 min'],
      ['iPhone 15 Pro','phone','Back glass',6500,'1 day'],
      ['iPhone 14','phone','Screen replacement',7500,'45 min'],
      ['iPhone 12','phone','Screen replacement',4200,'45 min'],
      ['Galaxy S24','phone','Screen replacement',9500,'1 hr'],
      ['Redmi Note 13','phone','Screen replacement',1800,'30 min'],
      ['MacBook Air M3','laptop','Screen replacement',22000,'2 days'],
    ];
    for (const [mn, slug, inm, price, eta] of OVERRIDES) {
      const m = findModel.get(mn), i = findIssue.get(slug, inm);
      if (m && i) setOverride.run(m.id, i.id, price, eta);
    }
    // model-specific issue example: Touch Bar exists only on some MacBooks.
    // Created as default-off (hidden for all), then switched on for one model.
    const labCat = db.prepare("SELECT id FROM categories WHERE slug='laptop'").get();
    if (labCat) {
      const tbId = db.prepare('INSERT INTO repair_issues (category_id,name,price,eta,sort,default_on) VALUES (?,?,?,?,?,0)')
        .run(labCat.id, 'Touch Bar replacement', 14000, '2 days', 20).lastInsertRowid;
      const mp = findModel.get('MacBook Pro M2');
      if (mp) db.prepare('INSERT OR REPLACE INTO model_repair_prices (model_id,issue_id,enabled) VALUES (?,?,1)').run(mp.id, tbId);
    }
    setKV.run('gst_percent', '18'); setKV.run('city', 'Bengaluru'); setKV.run('brand_name', 'ReGear');
    setKV.run('cities', 'Bengaluru, Mumbai, Delhi, Hyderabad, Chennai, Pune, Kolkata, Ahmedabad, Jaipur, Surat, Lucknow, Chandigarh, Kochi, Indore, Nagpur, Coimbatore, Visakhapatnam, Bhopal, Patna, Gurugram, Noida, Mysuru, Vadodara, Thiruvananthapuram');
    db.prepare('INSERT OR IGNORE INTO admin_users (email,password) VALUES (?,?)').run('admin@regear.in', 'admin123');
  });
  return true;
}

module.exports = { seed };

if (require.main === module) {
  const did = seed();
  console.log(did ? '✅ Seeded.' : 'Already seeded — run `npm run reset` to start fresh.');
  if (did) console.log('   Admin login: admin@regear.in / admin123');
}
