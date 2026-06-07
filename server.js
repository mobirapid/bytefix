// Load .env (no dependency) — must run before any module reads process.env.
(() => {
  const fs = require('fs'), path = require('path');
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      if (/^\s*#/.test(line) || !line.trim()) continue;
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1], v = m[2].replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v; // inline env still wins
    }
  } catch (e) { /* no .env file — fine, use real environment */ }
})();

const express = require('express');
const path = require('path');
const { seed } = require('./db/seed');
if (seed()) console.log('  (first run) database seeded with starter data');
const { router: authRouter } = require('./routes/auth');
const catalogRouter = require('./routes/catalog');
const pricingRouter = require('./routes/pricing');
const quotesRouter = require('./routes/quotes');
const ordersRouter = require('./routes/orders');
const corporateRouter = require('./routes/corporate');
const { router: otpRouter } = require('./routes/otp');
const accountRouter = require('./routes/account');
const templatesRouter = require('./routes/templates');
const accessRouter = require('./routes/access');
const serviceRouter = require('./routes/service');

const app = express();
app.use(express.json({ limit: '12mb' })); // room for base64 attachments (≤7MB each)

// API
app.use('/api/auth', authRouter);
app.use('/api', catalogRouter);     // /catalog, /categories, /brands, /models
app.use('/api', pricingRouter);     // /repair-issues, /conditions, /settings
app.use('/api/quotes', quotesRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/corporate', corporateRouter);
app.use('/api/otp', otpRouter);
app.use('/api/account', accountRouter);
app.use('/api', templatesRouter);    // /order-templates
app.use('/api/access', accessRouter);   // user/role management (superadmin)
app.use('/api/service', serviceRouter); // statuses, operator orders, thread, comments, reviews

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ReGear running → http://localhost:${PORT}`);
  console.log(`  Customer app   → http://localhost:${PORT}/`);
  console.log(`  Admin console  → http://localhost:${PORT}/admin   (admin@regear.in / admin123)\n`);
});
