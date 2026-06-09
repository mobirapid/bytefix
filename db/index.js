// Uses Node's built-in SQLite (node:sqlite) — zero native compilation required.
// Available without any flag on Node 23.4+; on Node 22 run with --experimental-sqlite.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// DB_PATH lets you point the database at a persistent disk in production
// (e.g. DB_PATH=/data/regear.db). Defaults to the local db/ folder for dev.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'regear.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, emoji TEXT DEFAULT '',
  sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
  for_repair INTEGER DEFAULT 1, for_sell INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort INTEGER DEFAULT 0,
  for_repair INTEGER DEFAULT 1, for_sell INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL, base_value INTEGER NOT NULL DEFAULT 0, active INTEGER DEFAULT 1,
  for_repair INTEGER DEFAULT 1, for_sell INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS repair_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0, eta TEXT DEFAULT '', sort INTEGER DEFAULT 0,
  default_on INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS condition_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS condition_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES condition_groups(id) ON DELETE CASCADE,
  label TEXT NOT NULL, factor INTEGER NOT NULL DEFAULT 100, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
  model_id INTEGER REFERENCES models(id), device_label TEXT, details TEXT,
  amount INTEGER, service_mode TEXT, customer_name TEXT, customer_phone TEXT, customer_email TEXT,
  address TEXT, slot TEXT, status TEXT DEFAULT 'placed',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL, token TEXT
);
-- per-model price/eta overrides for a repair issue. If no row exists, the
-- category-level repair_issues.price (the default) is used.
CREATE TABLE IF NOT EXISTS model_repair_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES repair_issues(id) ON DELETE CASCADE,
  price INTEGER, eta TEXT, enabled INTEGER,
  UNIQUE(model_id, issue_id)
);
-- B2B / corporate enquiries: bulk sell (asset recovery) or bulk buy (procurement)
CREATE TABLE IF NOT EXISTS corporate_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  intent TEXT NOT NULL,           -- 'sell' | 'buy'
  company TEXT, contact_name TEXT, email TEXT, phone TEXT,
  device_types TEXT, quantity INTEGER, message TEXT,
  status TEXT DEFAULT 'new',      -- 'new' | 'contacted' | 'closed'
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Lightweight migrations so existing databases gain new columns without a reset.
for (const stmt of [
  "ALTER TABLE repair_issues ADD COLUMN default_on INTEGER DEFAULT 1",
  "ALTER TABLE model_repair_prices ADD COLUMN enabled INTEGER",
  "ALTER TABLE orders ADD COLUMN customer_email TEXT",
  "ALTER TABLE users ADD COLUMN google_sub TEXT",
  "ALTER TABLE users ADD COLUMN username TEXT",   // staff (operator/superadmin) login id
  "ALTER TABLE users ADD COLUMN password TEXT",   // staff password (plaintext demo)
  "ALTER TABLE categories ADD COLUMN for_repair INTEGER DEFAULT 1",  // show in Repair flow
  "ALTER TABLE categories ADD COLUMN for_sell INTEGER DEFAULT 1",    // show in Resale flow
  "ALTER TABLE orders ADD COLUMN city TEXT",                          // city for operator routing
  "ALTER TABLE brands ADD COLUMN for_repair INTEGER DEFAULT 1",
  "ALTER TABLE brands ADD COLUMN for_sell INTEGER DEFAULT 1",
  "ALTER TABLE models ADD COLUMN for_repair INTEGER DEFAULT 1",
  "ALTER TABLE models ADD COLUMN for_sell INTEGER DEFAULT 1",
]) { try { db.exec(stmt); } catch (e) { /* column already exists — ignore */ } }

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, name TEXT, email TEXT, city TEXT,
  email_updates INTEGER DEFAULT 1, token TEXT, google_sub TEXT,
  username TEXT, password TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_templates (
  key TEXT PRIMARY KEY, type TEXT, status TEXT, label TEXT, subject TEXT, body TEXT
);

-- ===== Roles, permissions & access control (DB-driven) =====
CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  perm TEXT NOT NULL,
  UNIQUE(role_key, perm)
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  UNIQUE(user_id, role_key)
);
-- Cities an operator covers. No rows = all cities (unrestricted).
CREATE TABLE IF NOT EXISTS user_cities (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city TEXT NOT NULL,
  UNIQUE(user_id, city)
);

-- ===== Configurable order statuses (per flow) with colour =====
-- color is one of: red, orange, yellow, lightgreen, darkgreen
CREATE TABLE IF NOT EXISTS order_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow TEXT NOT NULL,            -- 'repair' | 'sell'
  key TEXT NOT NULL,            -- machine status, e.g. 'placed'
  label TEXT NOT NULL,          -- shown to humans
  color TEXT NOT NULL DEFAULT 'orange',
  sort INTEGER DEFAULT 0,
  UNIQUE(flow, key)
);

-- ===== Service-request discussion: comments + attachments + reviews =====
CREATE TABLE IF NOT EXISTS order_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT NOT NULL,
  author_user_id INTEGER,        -- null for unauthenticated/system
  author_role TEXT,              -- 'customer' | 'operator' | 'superadmin' | 'system'
  author_name TEXT,
  body TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL REFERENCES order_comments(id) ON DELETE CASCADE,
  name TEXT, mime TEXT, size INTEGER, data BLOB,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT NOT NULL,
  author_user_id INTEGER,
  role TEXT,                      -- 'customer' | 'operator'
  rating INTEGER,                 -- 1..5
  review TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(order_ref, role)
);
`);
// City-wise availability: a row = item (category/brand/model) is available in `city`
// for `flow` (repair/sell). Explicit opt-in — no rows means not available there.
db.exec(`CREATE TABLE IF NOT EXISTS item_cities (
  level TEXT NOT NULL,        -- 'category' | 'brand' | 'model'
  item_id INTEGER NOT NULL,
  flow TEXT NOT NULL,         -- 'repair' | 'sell'
  city TEXT NOT NULL,
  UNIQUE(level, item_id, flow, city)
);
CREATE INDEX IF NOT EXISTS idx_item_cities ON item_cities(level, flow, city);`);

// Audit log — tamper-evident record of admin/operator actions ("authorities log").
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  actor_id INTEGER, actor_name TEXT, actor_role TEXT,
  action TEXT, detail TEXT, ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(id DESC);`);

// DPDP: consent records + data-erasure requests.
db.exec(`CREATE TABLE IF NOT EXISTS consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, phone TEXT, email TEXT,
  kind TEXT, detail TEXT, ip TEXT, ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, phone TEXT, email TEXT,
  reason TEXT, status TEXT DEFAULT 'open', ts TEXT DEFAULT (datetime('now'))
);`);

// Resale KYC / ownership record per order. ID number is NOT stored in full —
// only the last 4 digits + the document image (BLOB, operator-access only).
db.exec(`CREATE TABLE IF NOT EXISTS order_kyc (
  order_ref TEXT PRIMARY KEY,
  id_type TEXT, id_last4 TEXT, id_number TEXT, serial TEXT,
  consent INTEGER DEFAULT 0, consent_name TEXT, consent_at TEXT,
  by_user INTEGER, ip TEXT,
  doc_name TEXT, doc_mime TEXT, doc_size INTEGER, doc_data BLOB,
  consent_method TEXT, sign_ref TEXT, signed_phone TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);`);
for (const stmt of [
  "ALTER TABLE order_kyc ADD COLUMN consent_method TEXT",
  "ALTER TABLE order_kyc ADD COLUMN sign_ref TEXT",
  "ALTER TABLE order_kyc ADD COLUMN signed_phone TEXT",
  "ALTER TABLE order_kyc ADD COLUMN id_number TEXT",
]) { try { db.exec(stmt); } catch (e) {} }

const _tpl = db.prepare('INSERT OR IGNORE INTO order_templates (key,type,status,label,subject,body) VALUES (?,?,?,?,?,?)');
for (const [ty, st, lb, su, bo] of [
  ['repair','placed','Booking confirmed','Your repair is booked · {ref}','Hi {name}, your {device} repair is booked. We will keep you posted at every step. Reference: {ref}.'],
  ['repair','assigned','Technician assigned','A technician is assigned · {ref}','Hi {name}, a technician has been assigned for your {device} and will arrive at your chosen slot.'],
  ['repair','diagnosis','Diagnosis complete','Diagnosis complete · {ref}','Hi {name}, we have diagnosed your {device} and will proceed with the agreed repair.'],
  ['repair','repairing','Repair in progress','Repair in progress · {ref}','Hi {name}, your {device} is being repaired right now. Almost there!'],
  ['repair','ready','Repair complete','Your device is ready · {ref}','Hi {name}, your {device} repair is complete. Thank you for choosing us!'],
  ['sell','placed','Pickup booked','Your pickup is booked · {ref}','Hi {name}, your {device} pickup is booked for {amount}. See you at your slot.'],
  ['sell','agent','Agent assigned','An agent is on the way · {ref}','Hi {name}, an agent has been assigned to collect your {device}.'],
  ['sell','verified','Device verified','Your device is verified · {ref}','Hi {name}, we have verified your {device}. Payment of {amount} will follow shortly.'],
  ['sell','paid','Payment sent','Payment sent · {ref}','Hi {name}, we have sent {amount} for your {device}. Thank you!'],
  ['sell','done','Completed','Order complete · {ref}','Hi {name}, your order is complete. Thanks for choosing ReGear!'],
]) _tpl.run(ty + ':' + st, ty, st, lb, su, bo);

// Tiny transaction helper (node:sqlite has no db.transaction()).
db.tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ===== Idempotent bootstrap: roles, permissions, statuses, staff accounts =====
// Runs on every boot so existing databases also gain this without a reset.
(function bootstrapAccessControl() {
  // 1) Roles
  const insRole = db.prepare('INSERT OR IGNORE INTO roles (key,name,description,sort) VALUES (?,?,?,?)');
  [
    ['superadmin',      'Super Admin',      'Full access to the admin panel, the main app, and everything else.', 0],
    ['operator',        'Operator (all)',   'Handles both repair and resale service requests from the main app.', 1],
    ['repair_operator', 'Repair Operator',  'Handles only repair service requests from the main app.', 2],
    ['sell_operator',   'Resale Operator',  'Handles only resale service requests from the main app.', 3],
    ['customer',        'Customer',         'A regular customer who books repairs or sells devices.', 4],
  ].forEach(r => insRole.run(...r));

  // 2) Permissions per role (capability keys checked by the app)
  //    service_requests = can open the console; service_repair / service_sell = which flow(s).
  const insPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_key,perm) VALUES (?,?)');
  const PERMS = {
    superadmin:      ['admin_panel','manage_access','manage_catalog','manage_pricing','manage_orders',
                      'manage_comms','manage_settings','service_requests','service_repair','service_sell','book'],
    operator:        ['service_requests','service_repair','service_sell','book'],
    repair_operator: ['service_requests','service_repair','book'],
    sell_operator:   ['service_requests','service_sell','book'],
    customer:        ['book'],
  };
  for (const [role, perms] of Object.entries(PERMS)) perms.forEach(p => insPerm.run(role, p));

  // 3) Configurable order statuses with colours (red→darkgreen progression)
  const insSt = db.prepare('INSERT OR IGNORE INTO order_statuses (flow,key,label,color,sort) VALUES (?,?,?,?,?)');
  const STATUSES = [
    ['repair','placed','Placed','red',0],
    ['repair','assigned','Technician assigned','orange',1],
    ['repair','diagnosis','Diagnosis','yellow',2],
    ['repair','repairing','Repairing','lightgreen',3],
    ['repair','ready','Ready','darkgreen',4],
    ['sell','placed','Placed','red',0],
    ['sell','agent','Agent assigned','orange',1],
    ['sell','verified','Verified','yellow',2],
    ['sell','paid','Paid','lightgreen',3],
    ['sell','done','Done','darkgreen',4],
  ];
  STATUSES.forEach(s => insSt.run(...s));

  // 4) Staff accounts as unified users with roles.
  //    Superadmin mirrors the demo admin login; Operator is operator/1234.
  function ensureStaff(username, password, name, email, roleKeys) {
    let u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!u) {
      const info = db.prepare('INSERT INTO users (phone,name,email,username,password,email_updates) VALUES (NULL,?,?,?,?,1)')
        .run(name, email || '', username, password);
      u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    } else if (!u.password) {
      db.prepare('UPDATE users SET password=? WHERE id=?').run(password, u.id);
    }
    const link = db.prepare('INSERT OR IGNORE INTO user_roles (user_id,role_key) VALUES (?,?)');
    roleKeys.forEach(rk => link.run(u.id, rk));
    return u;
  }
  ensureStaff('admin@regear.in', 'admin123', 'Administrator', 'admin@regear.in', ['superadmin']);
  ensureStaff('operator', '1234', 'Operator', '', ['operator']);

  // 5) Backfill: any existing account with no role becomes a customer.
  db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_key)
              SELECT id, 'customer' FROM users
              WHERE id NOT IN (SELECT user_id FROM user_roles)`).run();

  // 6) Starter legal/policy content (editable in Admin → Settings → Legal).
  const setIf = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  const PLACEHOLDER = '\n\n(Replace this starter text with your own policy reviewed by a legal advisor.)';
  setIf.run('policy_privacy',
    'Privacy Policy\n\nWe collect only the information needed to provide repair and resale services — your name, phone number, email, address and device details. We use it to process your bookings, verify your identity (OTP), keep you updated, and meet legal obligations. We do not sell your personal data. You can request access to or deletion of your data from your account, or by contacting us.' + PLACEHOLDER);
  setIf.run('policy_terms',
    'Terms of Service\n\nBy using this site you agree to provide accurate information and to use the service lawfully. Repair quotes are estimates confirmed after a free diagnosis; resale quotes are valid for the stated period and subject to device verification at pickup. Warranty terms apply as stated for each repair.' + PLACEHOLDER);
  setIf.run('policy_refund',
    'Refund & Cancellation Policy\n\nYou may cancel a booking before service begins at no charge. Repair charges are payable only after you approve the final quote. Resale payments are made after the device is verified at pickup. Refunds, where applicable, are processed to the original payment method within 5–7 business days.' + PLACEHOLDER);
  setIf.run('policy_shipping',
    'Shipping & Pickup Policy\n\nWe offer free pickup and drop in serviceable cities at the slot you choose. Timelines are estimates and may vary with location and device condition. Please keep the device and any agreed accessories ready at pickup.' + PLACEHOLDER);
})();

module.exports = db;
