// Audit middleware + admin viewer/export. Logs every authenticated, mutating
// admin/operator request automatically.
const express = require('express');
const { requireAdmin, userFromToken, rolesOf } = require('./auth');
const { record, list } = require('./auditlog');
const router = express.Router();

const SECRET_FIELDS = ['password', 'twofactor_api_key', 'idToken', 'credential', 'booking_token', 'token', 'attachments', 'data', 'id_number'];
function summarize(body) {
  if (!body || typeof body !== 'object') return '';
  const o = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_FIELDS.includes(k)) o[k] = '[redacted]';
    else if (typeof v === 'string') o[k] = v.length > 120 ? v.slice(0, 120) + '…' : v;
    else if (Array.isArray(v)) o[k] = '[' + v.length + ' items]';
    else if (v && typeof v === 'object') o[k] = '{…}';
    else o[k] = v;
  }
  let s = JSON.stringify(o);
  if (s.length > 600) s = s.slice(0, 600) + '…';
  return s;
}

// Auto-log authenticated writes. Mount on /api before the routers.
function auditMiddleware(req, res, next) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400) return;
      const path = (req.originalUrl || req.url).split('?')[0];
      // Skip noisy/customer/pre-auth endpoints (logins are logged explicitly).
      if (/^\/api\/(otp|chat)\b/.test(path)) return;
      if (/^\/api\/(auth\/(login|forgot|reset)|account\/(staff-login|google|resolve|save))/.test(path)) return;
      const u = userFromToken(req);
      if (!u) return;
      record({
        actor_id: u.id, actor_name: u.name || u.username || ('#' + u.id),
        actor_role: rolesOf(u.id).join(','), action: req.method + ' ' + path,
        detail: summarize(req.body), ip: req.ip || req.socket.remoteAddress || '',
      });
    } catch (e) {}
  });
  next();
}

router.get('/audit', requireAdmin, (req, res) => {
  res.json(list({ q: req.query.q, limit: req.query.limit }));
});
router.get('/audit.csv', requireAdmin, (req, res) => {
  const rows = list({ q: req.query.q, limit: 5000 });
  const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const head = 'time,actor,role,action,detail,ip\n';
  const body = rows.map(r => [r.ts, r.actor_name, r.actor_role, r.action, r.detail, r.ip].map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(head + body);
});

module.exports = { router, auditMiddleware };
