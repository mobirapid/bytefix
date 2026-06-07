# ReGear — Device Repair & Resale Platform

A full-stack starter for a platform where customers **book repairs** or **sell used devices** for an instant quote. Pricing, catalog, conditions and orders are all managed from an **admin console** and stored in a real database.

This is the working foundation behind the prototype — every price and quote now comes from the database, not hardcoded files.

---

## Quick start

Requires **Node.js 22.5+** (Node 24 LTS or newer recommended). Uses Node's built-in SQLite, so **nothing needs to compile**.

```bash
npm install        # installs express only — fast, no native build
npm start          # starts the server; auto-seeds the database on first run
```

### Clone & run on another machine (nothing to change)

Everything is path-relative, so a fresh checkout just works:

```bash
git clone <your-repo-url> regear
cd regear
./start.sh          # installs deps, frees port 3000, starts the server
# (or:  npm install && npm start)
```

Only prerequisite: **Node 22.5+** installed on that machine. The database, `node_modules`,
backups and `.env` are intentionally **not** in git (see `.gitignore`) — the DB seeds itself
on first run. **Logins:** super admin `admin@regear.in` / `admin123` (at `/admin`),
operator `operator` / `1234` (Staff link on the main app).

> **Email is optional.** Without a `.env`, order emails run in demo mode (logged to the
> console). To enable real sending on the new machine, copy `.env.example` to `.env` and
> fill in `RESEND_API_KEY` / `MAIL_FROM` (these are secrets, so they're never committed).

> On Node 22 only, start with `node --experimental-sqlite server.js` instead.
> You may see a one-line "SQLite is experimental" warning on startup — it's harmless.

Then open:

| URL | What |
|-----|------|
| http://localhost:3000/ | **Customer app** — Fix & Sell flows, quotes, order tracking |
| http://localhost:3000/admin | **Admin console** — manage everything |

**Admin login:** `admin@regear.in` / `admin123`

Useful scripts:
```bash
npm run seed       # seed manually (no-op if already seeded)
npm run reset      # wipe the DB and re-seed from scratch
```

---

## What's included

**Customer storefront** (`public/index.html`) — a full marketing website
- Header (logo + nav + city), hero, how-it-works, device categories, why-us, stats, testimonials, FAQ, and a full footer
- SEO tags (title, meta description, Open Graph, canonical, JSON-LD LocalBusiness) in the served HTML
- Logo, favicon, tagline, phone, email, address, city and meta description are all driven by **Settings** in the admin — edit once, the whole site updates
- Fix & Sell flows run inside the site: category → brand → model → (issues | condition) → quote → schedule → **OTP verification** → order → tracking
- Bookings require a verified phone — an order can't be created without passing OTP (enforced server-side)
- **For business** page — B2B enquiry form for bulk **sell** (asset recovery) and bulk **buy** (procurement), submitted as corporate leads

**Admin console** (`public/admin.html`) — a dashboard with a fixed sidebar and an Overview home page
- **Overview** — live KPIs (orders, repairs, resale pickups, order value), recent orders, catalog summary, and a "needs attention" list
- **Catalog** — add/edit/delete categories, brands, models (with base resale value); set each category's icon by emoji or uploaded image, and rename inline
- **Repair pricing** — issue types + **default** prices/ETA per category, plus **per-model overrides** (pick a model to set a different price where parts cost more/less; "reset" reverts to the default). GST rate too.
- **Model-specific issues** — control which issues each model shows. Mark an issue "all models" off (e.g. Touch Bar) so it's hidden by default, then switch it on only for the models that have it; or hide a standard issue for a model that doesn't support it. The storefront and quotes respect this.
- **Resale** — condition questions and the % multiplier each answer applies
- **Orders** — see every repair/sell order, move it through its status pipeline
- **Corporate** — B2B bulk sell/buy enquiries, with status follow-up (new → contacted → closed)
- **Settings** — brand name, city, GST
- Token-based login; all write endpoints require it

**Backend** (`server.js`, `routes/`, `db/`)
- Express REST API + SQLite via Node's built-in `node:sqlite` (`db/regear.db`, created automatically — no native dependency)
- Quote math lives on the **server** so prices can't be tampered with from the browser

---

## Architecture

```
Browser (customer app + admin console)
        │  fetch() JSON
        ▼
Express API (server.js + routes/)
        │  SQL
        ▼
SQLite database (db/regear.db)
```

### Database tables (`db/index.js`)
- `categories` → `brands` → `models` (the catalog; `models.base_value` = fair resale price)
- `repair_issues` (issue types + **default** price per category)
- `model_repair_prices` (per-model price/eta **overrides**; falls back to the default when absent)
- `condition_groups` + `condition_options` (resale multipliers, in %)
- `orders` (repair & sell, with status + customer details)
- `corporate_leads` (B2B bulk sell/buy enquiries)
- `settings` (key/value: gst, city, brand name)
- `admin_users` (login)

### Key API endpoints
```
POST /api/auth/login                  -> { token }
GET  /api/catalog                     full category→brand→model tree
GET  /api/repair-issues?category_id=  default issues for a category
GET  /api/models/:id/repair-issues    effective issues for one model (price + `applies` flag)
GET  /api/conditions                  resale condition groups + options
POST /api/quotes/repair  { model_id, issue_ids }  -> itemised total + GST (per-model prices)
POST /api/quotes/sell    { model_id, answers }     -> payout
POST /api/otp/send      { phone }                 -> sends a code (dev: returns it)
POST /api/otp/verify    { phone, code }           -> { token }  (valid 15 min)
POST /api/orders         { type, ..., booking_token }  -> { ref }  (token required)
POST /api/corporate      { intent, company, ... } -> { ref }  (B2B enquiry)
GET  /api/orders/:ref                  track one order (public)

# admin (require Authorization: Bearer <token>)
POST/PUT/DELETE  /api/categories /api/brands /api/models
POST/PUT/DELETE  /api/repair-issues /api/condition-groups /api/condition-options
PUT/DELETE       /api/model-repair-prices   set/clear a per-model price override and/or applicability (`enabled`)
GET              /api/orders            list all
PUT              /api/orders/:ref/status
PUT              /api/settings
```

---

## Going to production — what to change

This runs locally and is intentionally simple. Before real users:

1. **Database** — swap SQLite for **PostgreSQL** (the schema maps directly). Use a migration tool (Prisma / Knex) instead of raw SQL.
2. **Auth & security** — passwords are plaintext here; hash with **bcrypt**, use JWT or sessions, add admin roles + an audit log of price changes. Add rate limiting and input validation (zod).
3. **Payments** — Razorpay for collecting repair fees; Razorpay/RazorpayX **payouts** for resale (the harder half).
4. **Notifications** — OTP login is built in (phone-verified bookings). It runs in **demo mode** (the code is shown on screen / logged) until you add SMS credentials. **MSG91 is wired in**: set `MSG91_AUTHKEY`, `MSG91_TEMPLATE_ID`, `MSG91_OTP_VAR` (and `SMS_COUNTRY_CODE`) and codes are sent by real SMS — then set `DEV_OTP=false`. No code change needed. Optionally add WhatsApp status updates later.
5. **Ops** — technician/agent assignment, slot availability, real pickup logistics.
6. **Frontend** — the two HTML files are fine to start; migrate to Next.js + a shared component library when the team grows. Add SEO landing pages per locality.
7. **Hosting** — API on Render/Railway/Fly, Postgres managed, frontend on Vercel.

The data model and API shape you see here are production-realistic — most of this is swapping implementations, not redesigning.
