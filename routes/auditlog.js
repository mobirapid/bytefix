// Standalone audit recorder (no auth deps — avoids circular requires).
const db = require('../db');

function record(e) {
  try {
    db.prepare('INSERT INTO audit_log (actor_id,actor_name,actor_role,action,detail,ip) VALUES (?,?,?,?,?,?)')
      .run(e.actor_id ?? null, e.actor_name || '', e.actor_role || '', e.action || '', e.detail || '', e.ip || '');
  } catch (err) { /* never let logging break a request */ }
}

function list({ q, limit = 300 } = {}) {
  limit = Math.min(5000, Math.max(1, Number(limit) || 300));
  if (q) {
    const like = '%' + String(q).toLowerCase() + '%';
    return db.prepare(`SELECT * FROM audit_log
      WHERE lower(COALESCE(actor_name,'')||' '||COALESCE(action,'')||' '||COALESCE(detail,'')||' '||COALESCE(actor_role,'')) LIKE ?
      ORDER BY id DESC LIMIT ?`).all(like, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = { record, list };
