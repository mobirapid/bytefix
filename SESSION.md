# ReGear — Session Handoff

Read this file **and `CLAUDE.md`** before doing anything. They tell you what this
project is, what's already built, how it's structured, and the rules to follow.
The actual code lives in this same folder — inspect it as needed.

---

## What this project is
**ReGear** is a device **repair + recommerce** web app (book a doorstep repair, or
sell your phone/laptop/tablet for an instant price). It's modeled on **cashify.com**
(also referenced: ifixindia.in, hellore.in, hellofi.in). Indian market, ₹ INR,
Bengaluru-first.

## Tech stack (keep it this way unless told otherwise)
- **Node.js ≥ 22.5 + Express 4.** Only one runtime dependency: `express`.
- **Database: Node's built-in `node:sqlite`** (`DatabaseSync`) writing to a real
  file `db/regear.db` (WAL mode). No native build step. Override path with `DB_PATH`.
  - Must run with the flag on Node 22: `node --experimental-sqlite server.js`
    (unflagged on Node 23.4+/24). The npm `start` script already includes the flag.
- **Frontend: two vanilla HTML single-page apps**, no framework, no build:
  - `public/index.html` — customer storefront
  - `public/admin.html` — admin console
- **Fonts:** Bricolage Grotesque (display), Hanken Grotesk (body), JetBrains Mono (numbers).

## How to run
```bash
npm install
npm start            # → http://localhost:3000  (admin at /admin)
```
- Admin login: **admin@regear.in / admin123**
- Demo OTP in dev: a static code **123456** is accepted for any number (no SMS sent),
  unless `DEV_OTP=false` or MSG91 env is configured.

## Project structure
```
server.js              Express app; mounts routes; serves /public; seeds on first run
db/index.js            schema + lightweight migrations + tx() helper
db/seed.js             seed data (runs on first boot if DB empty)
db/regear.db           the SQLite database file (gitignored; do not overwrite on update)
routes/
  auth.js              admin auth (token), requireAdmin
  catalog.js           categories / brands / models (+ admin CRUD)
  pricing.js           repair-issues, conditions, settings (GET returns ALL settings)
  quotes.js            POST /quotes/repair, /quotes/sell (server-side calc)
  orders.js            create order (OTP-gated), admin status update (sends email)
  corporate.js         B2B leads
  otp.js               phone OTP (in-memory codes+tokens); MSG91 hook; static demo OTP
  account.js           passwordless phone/Google accounts (resolve/save/me/orders/...)
  templates.js         order-update templates (public GET, admin PUT)
  mailer.js            sendEmail() hook (Resend via RESEND_API_KEY, else logs in demo)
public/index.html      storefront SPA
public/admin.html      admin SPA
backup.sh / update.sh  local backup + update helpers (see CLAUDE.md)
backups/               timestamped snapshots (backup_DDMMYYYY_HHMMSS/)
CLAUDE.md              the working agreement + preferences (READ IT)
```

## Database (tables, summarized)
- `categories(slug, name, emoji[emoji or data: URL], sort, active)`
- `brands(category_id, name, sort)`
- `models(brand_id, name, base_value, active)`
- `repair_issues(category_id, name, price, eta, sort, default_on)`
- `model_repair_prices(model_id, issue_id, price, eta, enabled)` — per-model override + applicability
- `condition_groups` / `condition_options(label, factor%)` — resale multipliers
- `settings(key, value)` — gst_percent, city, cities (comma list), brand_name, logo,
  phone, email, address, seo_*, **google_client_id**
- `orders(ref, type['repair'|'sell'], model_id, device_label, details JSON, amount,
  service_mode, customer_name, customer_phone, customer_email, address, slot, status, created_at)`
- `admin_users(email, password[plaintext demo], token)`
- `corporate_leads(ref, intent, company, contact_name, email, phone, device_types, quantity, message, status)`
- `users(phone UNIQUE nullable, name, email, city, email_updates, token, google_sub)` — customer accounts
- `order_templates(key='type:status', type, status, label, subject, body)` — editable update copy

## Pricing logic
- **Repair:** effective issue price = per-model override else category default; only issues
  where `COALESCE(mrp.enabled, ri.default_on)=1` are priced; total = subtotal + GST.
- **Resale:** payout = base_value × product(condition factors/100), rounded to nearest ₹50.
- Quote breakdown is snapshotted onto `orders.details` at booking.

## Order pipelines (used by tracker + email templates)
- Repair: `placed → assigned → diagnosis → repairing → ready`
- Sell:   `placed → agent → verified → paid → done`

---

## What has been built (chronological highlights)
1. **Core app:** catalog CRUD with uploadable per-category icons; per-model repair pricing
   (default + override) and per-model issue applicability toggles; resale condition
   multipliers; server-side quotes with snapshotted calculation; orders + tracking;
   full admin dashboard (overview/catalog/repair/resale/orders/corporate/settings);
   corporate B2B leads; backend OTP-gated bookings (MSG91 wired + static demo OTP);
   branding/SEO/contact settings.
2. **Clean UI redesign** to a navy / sky-blue / grey / white minimal-professional theme,
   applied to **both** the storefront and the admin console (see palette in CLAUDE.md).
   Removed all gradients/shine; flat, subtle, intuitive.
3. **Forms & inputs (Phase 1):** "Step - 1/2/3" labels in bold blue; country dropdown
   with flag (default 🇮🇳 +91) on every phone field; "Use my current location" button
   that reverse-geocodes and autofills an editable address; inline field validations
   across booking + corporate forms; email field added and stored on orders; city-picker
   modal in the nav with an **admin-editable** city list (Settings → Service cities).
4. **Accounts (Phase 2):** passwordless **phone-OTP** accounts (Cashify-style). On booking,
   after OTP it auto-signs-in if the account exists, else prompts a quick sign-up and
   continues the order. Standalone **Log in** + **Sign up** buttons in the nav. A customer
   **profile** page (edit name/email/city, email-update preference, order list, logout).
5. **Notifications & admin templates (Phase 3):** per-account **email-update preference**;
   admin **"Order updates"** editor to customize the label/subject/body for every pipeline
   status (placeholders `{name} {ref} {device} {amount}`); the customer **tracking timeline**
   (Amazon-style) is driven by those same templates; emails are sent on status change via a
   `sendEmail()` hook (real via `RESEND_API_KEY`, otherwise logged in demo mode).
6. **Google sign-in / sign-up:** "Continue with Google" on the auth screen using Google
   Identity Services; the **Client ID is an admin setting** (Settings → Sign-in), so it
   activates when configured and hides gracefully otherwise. Backend verifies the token
   (audience check) and creates/sign-ins by email.
7. **Account linking + add mobile:** phone and Google accounts **merge by email**; a
   Google-only user can **add & verify a mobile** from the profile (merges any duplicate
   phone-only account); a logged-in user booking just attaches the verified phone.
8. **Home recent-orders:** when logged in, the hero's right-hand panel is replaced by a
   "Welcome back" card showing the **3 most recent orders** as compact vertical cards
   (device, badge, progress bar, status, amount, tap-to-track) + an "All (n)" link.
9. **Bug fixes / hardening:** fixed order `type` mapping (`fix → repair`) that blocked
   repair bookings; reset `S.fromBooking` on standalone login; prefill booking from the
   logged-in account; made `npm start` use `--experimental-sqlite` for Node 22.
10. **Backup/update workflow:** `backup.sh`, `update.sh`, `backups/`, and `CLAUDE.md`
    (see CLAUDE.md for the rules).

## Roles, access control & service requests (added)
- **Unified accounts + roles (DB-driven).** All accounts live in `users`; roles are in
  `roles` + `role_permissions`, assigned via `user_roles` (many-to-many). One account can
  hold several roles. Staff get `username`/`password` columns on `users`.
  - Seeded: **superadmin** `admin@regear.in`/`admin123` (logs into `/admin`),
    **operator** `operator`/`1234` (logs into the **main app** for service work),
    **customer** (default for booking accounts). All seeding is idempotent in `db/index.js`.
  - Auth is unified in `routes/auth.js`: `/api/auth/login` authenticates a user with the
    `admin_panel` permission; `requireAdmin`/`requirePerm(perm)` gate routes;
    `/api/account/staff-login` logs operators into the storefront. `/account/me` returns
    `roles` + `perms`.
- **Access screen** (admin → Access, `routes/access.js`): search any user, assign roles.
  Guard prevents removing the last superadmin.
- **Operator Service Requests console** (storefront, shown when the account has the
  `service_requests` perm): list/filter all orders, change status, threaded discussion
  with the customer, attachments, and reviews. Backend: `routes/service.js`.
- **Discussion + attachments + reviews** (`order_comments`, `order_attachments` BLOB,
  `order_reviews`). Attachments are images/PDF only, ≤7MB (validated client + server).
  Both customer and operator can rate (1–5) and review each request. Status changes log a
  system note in the thread. JSON body limit raised to 12mb for base64 uploads.
- **Configurable statuses + colour badges** (`order_statuses`, per flow, with colour from
  red/orange/yellow/lightgreen/darkgreen). Managed in admin → Communications (two journey
  tabs, status picked via dropdown; edit label, colour, and the email template per step;
  add/delete steps). Badges render everywhere (admin orders/overview, storefront my-orders,
  tracker, operator console).
- **CSS externalised**: `public/admin.css` and `public/app.css`, each with a shared spacing
  token system (`--s1..--s6`, `--card-pad`, `--sec-gap`, `--field-gap`) for consistent
  padding/margins across sections. Inline `<style>` blocks were replaced with `<link>`s.
- **Email**: `.env` (gitignored) carries `RESEND_API_KEY`/`MAIL_FROM`; `server.js` loads
  `.env` with a zero-dependency loader. `routes/notify.js` is the shared send helper.

## Current state
- Latest packaged build delivered to the owner was **regear3.zip**. Delivered zips are
  named `regear` + an incrementing number (next is `regear4`).
- Data persists in `db/regear.db`. Only OTP codes and session tokens are in-memory.

## Known limitations / sensible next steps
- **Google sign-in** needs (a) an OAuth **Web** Client ID pasted in Admin → Settings →
  Sign-in, and (b) the site origin added to "Authorized JavaScript origins" in Google
  Cloud Console. If it fails, the button shows a note and logs the exact reason to the console.
- OTP codes + tokens are in-memory (fine for one instance; use Redis for multi-instance).
- Admin password is plaintext demo (`admin123`) — hash it (bcrypt) before production.
- "Use my current location" uses a free public geocoder for the demo — swap for a paid one in prod.
- Reverse-geocode/account-link edge cases are handled but worth re-testing after big changes.
- Possible future: WhatsApp updates, CDN for uploaded icons, SSR for SEO, managed Postgres.

## Working rules for a NEW session (important)
1. **Read `CLAUDE.md`** and honor every preference there.
2. **Back up before any change** (see CLAUDE.md → run `./backup.sh` or `npm run backup`).
3. Use **cashify.com** as the feature reference; keep the **navy/sky/grey/white** UI.
4. **Test before declaring done** (start the server, exercise the relevant flow).
5. Narrate mid-level progress so the owner can follow along.
