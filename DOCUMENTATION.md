# ReGear — Full Documentation

A full-stack platform where customers **book device repairs** or **sell used devices** for an instant quote, with bulk **B2B** enquiries, phone-OTP-verified bookings, and an admin console that controls the catalog, pricing, branding and orders.

- **Version:** 1.0
- **Customer storefront:** `http://localhost:3000/`
- **Admin console:** `http://localhost:3000/admin` (demo login `admin@regear.in` / `admin123`)

---

## 1. Table of contents

1. Quick start
2. Architecture overview
3. Tech stack
4. Project structure
5. Configuration (environment variables)
6. Database schema
7. Pricing model (how quotes are calculated)
8. Authentication & OTP
9. The customer storefront
10. The admin console
11. Corporate (B2B) leads
12. Branding & SEO
13. API reference
14. Common how-to recipes
15. Going to production
16. Troubleshooting
17. Extending the project

---

## 2. Quick start

**Requirements:** Node.js **22.5 or newer** (Node 24 LTS+ recommended). Nothing compiles — the database uses Node's built-in SQLite.

```bash
npm install      # installs Express only — fast, no native build
npm start        # starts the server; auto-seeds the database on first run
```

Open:

| URL | Purpose |
|-----|---------|
| `http://localhost:3000/` | Customer storefront |
| `http://localhost:3000/admin` | Admin console |

**Demo admin login:** `admin@regear.in` / `admin123`

Other scripts:

```bash
npm run seed     # seed manually (no-op if already seeded)
npm run reset    # wipe the database and re-seed from scratch
```

> On Node 22.x only, start with `node --experimental-sqlite server.js`. On Node 23.4+ the built-in SQLite is unflagged and `npm start` works as-is. A harmless one-line "SQLite is experimental" warning may print on startup.

---

## 3. Architecture overview

```
                Browser
   ┌───────────────────────────────────┐
   │  Storefront (public/index.html)    │   Admin (public/admin.html)
   │  marketing site + Fix/Sell/Corp    │   dashboard: catalog, pricing,
   │  flows + OTP + order tracking      │   orders, corporate, settings
   └───────────────┬───────────────────┘
                   │  fetch() — JSON over HTTP
                   ▼
   ┌───────────────────────────────────┐
   │  Express API (server.js, routes/)  │
   │  auth · catalog · pricing · quotes │
   │  orders · corporate · otp          │
   │  (quote math runs here)            │
   └───────────────┬───────────────────┘
                   │  SQL (synchronous)
                   ▼
   ┌───────────────────────────────────┐
   │  SQLite database (db/regear.db)    │
   │  via Node's built-in node:sqlite   │
   └───────────────────────────────────┘
```

Key principles:

- **Single source of truth.** Catalog and pricing live in the database; both the storefront and admin read the same data.
- **Quotes are computed server-side**, so prices cannot be tampered with from the browser.
- **Bookings are gated by OTP server-side** — an order cannot be created without a valid verification token for the phone number.
- **No build step, no native modules.** Express + Node's built-in SQLite only.

---

## 4. Tech stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Node.js ≥ 22.5 | Built-in `node:sqlite` (no native compile) |
| Server | Express 4 | REST API + static file serving |
| Database | SQLite (`node:sqlite`) | Single file at `db/regear.db` |
| Frontend | Vanilla HTML/CSS/JS | Two self-contained pages, no framework/build |
| Fonts | Bricolage Grotesque, Hanken Grotesk, JetBrains Mono | Loaded from Google Fonts |

Design language: warm "paper" background, deep ink-green text, green primary accent, amber secondary (used for resale / corporate). The admin uses a dark sidebar with a light content area.

---

## 5. Project structure

```
regear/
├── server.js              Express app: mounts routes, serves /public, auto-seeds
├── package.json           Scripts + the single dependency (express)
├── .env.example           PORT, DEV_OTP
├── README.md              Short readme
├── DOCUMENTATION.md       This file
├── db/
│   ├── index.js           DB connection + full schema + tx() helper
│   ├── seed.js            Starter data (categories, models, pricing, conditions, demo overrides)
│   └── regear.db          Created automatically on first run (git-ignored)
├── routes/
│   ├── auth.js            Admin login + requireAdmin middleware
│   ├── catalog.js         Categories, brands, models (read public, write admin)
│   ├── pricing.js         Repair issues, per-model prices, conditions, settings
│   ├── quotes.js          Repair + resale quote computation
│   ├── orders.js          Create / track / list / update orders
│   ├── corporate.js       B2B bulk sell/buy leads
│   └── otp.js             Phone OTP send/verify + booking-token verification
└── public/
    ├── index.html         Customer storefront (marketing site + flows)
    └── admin.html         Admin dashboard
```

---

## 6. Configuration (environment variables)

Copy `.env.example` if you use a process manager, or set these in the environment.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Port the server listens on |
| `DEV_OTP` | `true` | When `true`, the OTP code is returned in the API response and shown on screen (demo). Set to `false` in production once real SMS sending is wired in. |

> The project does not auto-load a `.env` file (no `dotenv` dependency). Set variables inline, e.g. `PORT=4000 npm start`, or add `dotenv` if you prefer a file.

---

## 7. Database schema

SQLite file: `db/regear.db`. All tables are created on startup if missing (`db/index.js`). `ON DELETE CASCADE` keeps child rows clean when a parent is deleted.

### categories
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| slug | TEXT UNIQUE | e.g. `phone` |
| name | TEXT | e.g. `Phone` |
| emoji | TEXT | An emoji **or** a `data:` image URL (uploaded icon) |
| sort | INTEGER | Display order |
| active | INTEGER | 1 = shown |

### brands
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| category_id | INTEGER FK → categories | |
| name | TEXT | e.g. `Apple` |
| sort | INTEGER | |

### models
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| brand_id | INTEGER FK → brands | |
| name | TEXT | e.g. `iPhone 14` |
| base_value | INTEGER | Fair resale value (₹) for a flawless unit |
| active | INTEGER | |

### repair_issues  *(category-level default prices)*
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| category_id | INTEGER FK → categories | |
| name | TEXT | e.g. `Screen replacement` |
| price | INTEGER | Default price (₹) for the whole category |
| eta | TEXT | e.g. `30 min` |
| sort | INTEGER | |

### model_repair_prices  *(per-model overrides)*
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| model_id | INTEGER FK → models | |
| issue_id | INTEGER FK → repair_issues | |
| price | INTEGER | Overrides the category default for this model |
| eta | TEXT | Optional override |
|  | UNIQUE(model_id, issue_id) | One override per model+issue |

### condition_groups + condition_options  *(resale multipliers)*
- `condition_groups`: `id, name` (a question, e.g. "Screen").
- `condition_options`: `id, group_id, label, factor` — `factor` is a **percentage** applied to `base_value` (e.g. `Cracked = 60` → 60%).

### orders
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| ref | TEXT UNIQUE | Public reference, e.g. `RGAB12C` |
| type | TEXT | `repair` or `sell` |
| model_id | INTEGER FK → models | |
| device_label | TEXT | Snapshot, e.g. `Apple iPhone 14` |
| details | TEXT | JSON: `{issues:[…],service_mode}` or `{answers:{…}}` |
| amount | INTEGER | Repair total or resale payout (₹) |
| service_mode | TEXT | `doorstep` / `pickup` / `walkin` (repairs) |
| customer_name, customer_phone, address, slot | TEXT | |
| status | TEXT | Pipeline status (see below) |
| created_at | TEXT | |

**Order status pipelines:**
- Repair: `placed → assigned → diagnosis → repairing → ready`
- Sell: `placed → agent → verified → paid → done`

### corporate_leads
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| ref | TEXT UNIQUE | e.g. `CORPAB12` |
| intent | TEXT | `sell` (asset recovery) or `buy` (procurement) |
| company, contact_name, email, phone, device_types, message | TEXT | |
| quantity | INTEGER | |
| status | TEXT | `new → contacted → closed` |
| created_at | TEXT | |

### settings  *(key/value store — drives the storefront)*
| Key | Used for |
|-----|----------|
| `brand_name` | Site/brand name |
| `tagline` | Footer/marketing tagline |
| `city` | Shown in header, footer, copy |
| `phone`, `email`, `address` | Footer + tracking contact |
| `gst_percent` | GST added to repair totals |
| `meta_description` | SEO description + JSON-LD |
| `logo` | Header/footer logo (`data:` image URL) |
| `favicon` | Browser-tab icon (`data:` image URL) |

### admin_users
`id, email, password, token`. **Password is plaintext in this demo** — hash with bcrypt before production. `token` is the current session token issued at login.

---

## 8. Pricing model (how quotes are calculated)

All math runs on the server (`routes/quotes.js`), never the browser.

### Repair quote
1. The customer selects a **model** and one or more **issues**.
2. For each issue, the **effective price** = the model's override (`model_repair_prices`) **if it exists**, otherwise the category **default** (`repair_issues.price`). Same logic for ETA.
3. `subtotal` = sum of effective prices.
4. `gst` = `round(subtotal × gst_percent / 100)`.
5. `total` = `subtotal + gst`.

This is why an iPhone 15 Pro screen can be ₹12,000 while a Redmi screen is ₹1,800 for the same "Screen replacement" issue — the model overrides the default.

### Resale quote
1. The customer selects a **model** (its `base_value`) and answers each **condition question** by choosing one option.
2. `payout` = `base_value × (factor₁/100) × (factor₂/100) × …` for each chosen option.
3. Rounded to the nearest ₹50.

Example: base ₹41,000 × 55% (switches on, minor issues) × 60% (cracked screen) ≈ ₹13,550.

---

## 9. Authentication & OTP

There are **two independent auth systems**:

### (a) Admin authentication
- `POST /api/auth/login` with `{email, password}` returns a random `token`.
- The token is stored in `admin_users.token` and kept in the browser's `localStorage` by the admin page.
- Every admin write request must send `Authorization: Bearer <token>`. The `requireAdmin` middleware rejects missing/invalid tokens with `401`.

### (b) Customer booking OTP (backend-owned)
The booking flow requires a verified phone number, enforced **server-side**:

1. `POST /api/otp/send { phone }` — the server generates a 6-digit code, stores it (5-minute expiry, max 5 attempts, 1 resend / 30s), and "sends" it via the `deliver()` function in `routes/otp.js`.
2. `POST /api/otp/verify { phone, code }` — on success the server issues a short-lived **booking token** (15 minutes) bound to that phone number.
3. `POST /api/orders` requires `booking_token`; the server checks it is valid **and matches the order's phone**. A token verified for one number cannot be reused for another.

**Demo mode (`DEV_OTP=true`):** since no SMS gateway is configured, the code is returned in the send response and shown on the verification screen so you can test the full flow.

**Going live with real SMS:** open `routes/otp.js` and put your provider call inside `deliver(phone, code)` — e.g. an HTTPS request to MSG91 / Twilio / Gupshup, or Firebase Admin. Then set `DEV_OTP=false`. **No frontend change is needed** — the storefront only ever calls `/api/otp/send` and `/api/otp/verify`; how the code is delivered is entirely a backend detail.

> OTP codes and booking tokens are kept in-memory (they are short-lived by nature). They reset if the server restarts, which is fine for verification. For multi-instance deployments, move them to Redis.

---

## 10. The customer storefront (`/`)

A full marketing website plus the transactional flows.

**Marketing homepage:** sticky header (logo, nav, city, "Get a quote"), hero with the two primary CTAs, how-it-works, device category grid, why-us features, stats band, testimonials, a "For business" band, FAQ accordion, and a full footer. Content (brand, tagline, contact, city, logo, favicon, SEO) is driven by **Settings**.

**Flows (run inside the site):**
- **Fix:** category → brand → model → select issues → service mode (doorstep / pickup / walk-in) → quote → schedule → **OTP** → confirmation → tracking.
- **Sell:** category → brand → model → condition questions → instant payout → schedule pickup → **OTP** → confirmation → tracking.
- **Track order:** enter a reference (e.g. `RGAB12C`) to see a status timeline.
- **For business:** the corporate lead form (see §11).

---

## 11. Corporate (B2B) leads

Accessible from the header/footer "For business" link. A single page with a **Sell in bulk / Buy in bulk** toggle and one enquiry form (company, contact, work email, phone, device types, quantity, message). Submitting creates a `corporate_leads` row and returns a `CORP…` reference.

In the admin, the **Corporate** section lists every enquiry with an intent badge, quantity and contact details, and a status dropdown (`new → contacted → closed`). New leads also surface on the Overview "Needs attention" panel.

This is intentionally a **lead-capture** flow (matching how recommerce companies run B2B): real bulk deals involve negotiated pricing, grading, contracts and GST invoicing, so the form captures the opportunity and your team follows up.

---

## 12. Branding & SEO

Everything below is editable in **Admin → Settings** and applied live on the storefront:

- **Logo** and **favicon** — upload an image (auto-resized in the browser, stored inline). Shown in header, footer and the browser tab.
- **Brand name, tagline, phone, email, address, city.**
- **Meta description** — used in the page metadata and JSON-LD.
- **Category icons** — in Catalog, each category's icon can be an emoji or an uploaded image.

**SEO built into the served HTML:** `<title>`, meta description, Open Graph tags, canonical link, and JSON-LD `LocalBusiness` structured data (with city, phone, email).

> **SEO limitation:** the storefront is client-rendered, so crawlers see the static tags but not JS-generated sections. For ranking-grade SEO, move the storefront to a server-rendered framework (e.g. Next.js) with a page per locality/device.

---

## 13. API reference

Base URL: `/api`. All bodies and responses are JSON. Admin-only endpoints require the header `Authorization: Bearer <token>` from `/api/auth/login`.

### Auth
| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| POST | `/auth/login` | — | `{email, password}` | `{token, email}` |

### Catalog
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/catalog` | — | Full tree: categories → brands → models |
| GET | `/categories` | — | |
| GET | `/categories/:id/brands` | — | |
| GET | `/brands/:id/models` | — | |
| POST | `/categories` | admin | `{slug, name, emoji?, sort?}` |
| PUT | `/categories/:id` | admin | `{name?, emoji?, sort?, active?}` |
| DELETE | `/categories/:id` | admin | |
| POST | `/brands` | admin | `{category_id, name, sort?}` |
| PUT | `/brands/:id` | admin | `{name?, sort?}` |
| DELETE | `/brands/:id` | admin | |
| POST | `/models` | admin | `{brand_id, name, base_value?}` |
| PUT | `/models/:id` | admin | `{name?, base_value?, active?}` |
| DELETE | `/models/:id` | admin | |

### Pricing
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/repair-issues?category_id=` | — | Category default issues |
| POST | `/repair-issues` | admin | `{category_id, name, price?, eta?, sort?}` |
| PUT | `/repair-issues/:id` | admin | `{name?, price?, eta?, sort?}` |
| DELETE | `/repair-issues/:id` | admin | |
| GET | `/models/:id/repair-issues` | — | **Effective** issues for one model (override else default), with `is_override`, `default_price`, `default_eta` |
| PUT | `/model-repair-prices` | admin | `{model_id, issue_id, price, eta?}` — set/replace an override |
| DELETE | `/model-repair-prices` | admin | `{model_id, issue_id}` — revert to default |
| GET | `/conditions` | — | Condition groups + options |
| POST | `/condition-groups` | admin | `{name, sort?}` |
| DELETE | `/condition-groups/:id` | admin | |
| POST | `/condition-options` | admin | `{group_id, label, factor?, sort?}` |
| PUT | `/condition-options/:id` | admin | `{label?, factor?}` |
| DELETE | `/condition-options/:id` | admin | |
| GET | `/settings` | — | All settings as a key→value object |
| PUT | `/settings` | admin | `{key: value, …}` (any keys) |

### Quotes
| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| POST | `/quotes/repair` | — | `{model_id, issue_ids:[…]}` | `{items, subtotal, gst_percent, gst, total}` |
| POST | `/quotes/sell` | — | `{model_id, answers:{groupId:optionId}}` | `{base_value, applied:[…], payout}` |

### Orders
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/orders` | OTP token | `{type, model_id, device_label, details, amount, service_mode, customer_name, customer_phone, address, slot, booking_token}` — `booking_token` required & must match the phone |
| GET | `/orders/:ref` | — | Public tracking |
| GET | `/orders` | admin | List (latest 200) |
| PUT | `/orders/:ref/status` | admin | `{status}` |

### Corporate
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/corporate` | — | `{intent:'sell'|'buy', company, contact_name?, email?, phone?, device_types?, quantity?, message?}` — company + (email or phone) required |
| GET | `/corporate` | admin | List |
| PUT | `/corporate/:id/status` | admin | `{status}` |

### OTP
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/otp/send` | — | `{phone}` → `{sent:true, dev_code?}` (`dev_code` only when `DEV_OTP=true`) |
| POST | `/otp/verify` | — | `{phone, code}` → `{verified:true, token}` (token valid 15 min) |

### Misc
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/health` | `{ok:true, ts}` |
| GET | `/` | Customer storefront |
| GET | `/admin` | Admin console |

**Error format:** non-2xx responses return `{ "error": "message" }`. Common codes: `400` (validation), `401` (auth / unverified phone), `404` (not found), `429` (rate-limited OTP resend / too many attempts).

---

## 14. Common how-to recipes

**Add a new device category** — Admin → Catalog → fill the "New category" bar (emoji, name, slug) → ＋ Category. Then add brands and models under it.

**Set a model-specific repair price** — Admin → Repair pricing → pick the category → click the model chip (instead of "Default") → type the new price (turns amber = override). "reset" reverts to the category default.

**Change a resale question or its weighting** — Admin → Resale → edit an option's label or its `%`, or add a new question/answer.

**Change GST** — Admin → Repair pricing (or Settings) → set the GST %.

**Rebrand the whole site** — Admin → Settings → upload logo + favicon, set brand name, tagline, contact, city, meta description.

**Move an order forward** — Admin → Orders → change the status dropdown; the customer sees it on the tracking page.

**Follow up a B2B enquiry** — Admin → Corporate → set status new → contacted → closed.

---

## 15. Going to production

This runs locally and is intentionally simple. Before real users:

1. **Database** — swap SQLite for **PostgreSQL** (the schema maps directly). Use a migration tool (Prisma / Knex) instead of inline SQL.
2. **Admin security** — passwords are plaintext; hash with **bcrypt**, use proper sessions/JWED with expiry, add roles and an audit log of pricing changes. Add rate limiting and input validation (e.g. zod).
3. **OTP / SMS** — wire a provider into `deliver()` in `routes/otp.js` and set `DEV_OTP=false`. Move the OTP/token stores to Redis if running more than one instance.
4. **Payments** — Razorpay to collect repair fees; RazorpayX (or similar) **payouts** for resale. *(Not yet built.)*
5. **Notifications** — WhatsApp order updates (Gupshup / Interakt). *(Not yet built.)*
6. **Uploads** — logo/favicon/category icons are stored inline as data URLs (fine for small images). For heavy use, move uploads to object storage / CDN.
7. **SEO / frontend** — migrate the storefront to a server-rendered framework (Next.js) for crawlable pages and per-locality landing pages.
8. **Hosting** — API on Render / Railway / Fly, managed Postgres, frontend on Vercel; put it behind HTTPS.

**Status at a glance:** Catalog ✓ · Per-model pricing ✓ · Quotes ✓ · Orders + tracking ✓ · Corporate leads ✓ · OTP-gated bookings ✓ (demo SMS) · Branding/SEO settings ✓ · Payments ✗ · WhatsApp ✗ · Postgres/prod-auth ✗.

---

## 16. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `zsh: command not found: npm` | Node.js isn't installed. Install from nodejs.org (LTS) or `brew install node`. |
| `pip install npm` / `pip3 install node` "works" but no `npm` | npm is **not** a Python package. It ships with Node.js — install Node, not via pip. |
| `better-sqlite3 … node-gyp … GetPrototype` build errors | An old build against a too-new Node. This project no longer uses better-sqlite3 — it uses built-in `node:sqlite`, so `npm install` shouldn't compile anything. Make sure you're on the current code. |
| `Cannot find module 'express'` | You ran `npm start` before `npm install`. Run `npm install` first. |
| `EADDRINUSE: address already in use :::3000` | Another instance holds the port. `lsof -ti:3000 \| xargs kill -9` then `npm start`, or `PORT=3001 npm start`. |
| `EPERM: process.cwd … uv_cwd` | Your shell is in a folder that was deleted/recreated under it. `cd` to the real path again, e.g. `cd ~/Desktop/regear`. |
| "Could not reach server" on the page | The server isn't running, or you opened the file directly. Start it with `npm start` and open `http://localhost:3000`. |
| SQLite "experimental" warning on startup | Harmless. The built-in SQLite is marked experimental but stable enough here. |
| Booking fails with "Phone not verified" | The OTP step must succeed first; the order needs a valid `booking_token` for that phone. In demo mode the code is shown on the verify screen. |

---

## 17. Extending the project

- **New API resource:** add a file in `routes/`, mount it in `server.js` with `app.use('/api/...', router)`, and add any tables to `db/index.js`.
- **New admin section:** add an entry to `PAGES` and the sidebar `order` array in `admin.html`, a branch in `boot()`, and a `…View()` render function.
- **New storefront section:** add a `…HTML()` function in `index.html` and include it in `showHome()`.
- **New settings field:** it's a key/value store — just `saveSetting('your_key', value)` in admin and read `SET.your_key` on the storefront. No schema change needed.

---

*Generated for ReGear v1.0. Keep this file in the repository root.*
