# CLAUDE.md — ReGear Working Agreement

Instructions and preferences for any Claude (Cowork or Claude Code) working on this
project. Read `SESSION.md` alongside this for full project context. Follow everything
here unless the owner says otherwise in the moment.

---

## Golden rule: back up before every change (per-prompt workflow)
**Claude does this automatically — the owner never runs anything.** On every prompt
that changes code, Claude itself performs both steps, in this order, without being
asked and without depending on any helper script:

1. **Back up FIRST, before touching anything.** Claude snapshots the entire project
   into `backups/backup_DDMMYYYY_HHMMSS_xyz/` *before* making any edit — on every
   change-making prompt, no exceptions, even for tiny edits. Claude performs the copy
   directly with its own tools (do NOT rely on `backup.sh`/`npm run backup` existing).
2. **Then make the changes** and update the canonical project folder
   `/Users/apple/Desktop/regear10` in place with the latest code.

> The owner should never have to run a script. If `backup.sh` is missing, Claude just
> does the copy itself. Backing up and updating the folder is Claude's responsibility,
> performed automatically every time it touches the project.

The snapshot:
- Lives in `backups/` (created automatically if missing).
- Contains the **full project** but **excludes** `node_modules/` and `backups/`,
  and **includes** `db/regear.db` when it exists (the live data).
- Is named `backup_DDMMYYYY_HHMMSS_xyz` — day, month, year, 24h time, then a short
  `xyz` slug briefly describing that change (lowercase, hyphen-separated, a few words).
  Example: `backup_07062026_143501_add-razorpay`. Use **IST (Asia/Kolkata)** for the
  timestamp so the date matches the owner's local day.

Commands (any of these — all produce the same result):

```bash
# Preferred: helper script if present
./backup.sh            # or: npm run backup

# Equivalent manual snapshot (works without the helper script):
STAMP=$(TZ=Asia/Kolkata date "+backup_%d%m%Y_%H%M%S")
mkdir -p "backups/$STAMP"
rsync -a --exclude 'node_modules' --exclude 'backups' ./ "backups/$STAMP"/
```

- To apply a delivered zip with an automatic backup first:
  `./update.sh /path/to/regearN.zip` (preserves your `db/regear.db` and `backups/`).
- Restoring a snapshot: `rsync -a backups/backup_<stamp>/ ./`

> The canonical copy lives at `/Users/apple/Desktop/regear10`. The flow each prompt is:
> **snapshot to `backups/` → edit code in place → leave `regear10` holding the latest.**

## After every task: (re)start the app
**Claude runs this automatically once a task is finished** (after the backup + edits),
from the project root, to bring the server up on the latest code. The three steps are
bundled into `start.sh`, so a full rerun is one command:

```bash
cd /path/to/regear10   # the project root on this machine
./start.sh            # foreground (Ctrl+C to stop)
./start.sh --bg       # background (logs -> server.log)
```

`start.sh` does it all automatically: `npm install` (deps) → free port 3000 →
`npm start` (`node --experimental-sqlite server.js` → http://localhost:3000, admin at
/admin). The equivalent manual commands, if ever needed:

```bash
npm install                       # ensure deps (express); fast no-op once installed
lsof -ti:3000 | xargs kill -9     # free port 3000 (harmless "usage" msg if nothing runs)
npm start                         # node --experimental-sqlite server.js  → http://localhost:3000
```

Notes:
- `npm start` runs in the **foreground** and blocks the terminal; the server stops on
  Ctrl+C / closing it. For a background run use `npm start &` or a manager like `pm2`.
- First start seeds `db/regear.db`; restarts reuse the existing DB (never wiped here).
- Requires Node ≥ 22.5 (`node -v`). The `--experimental-sqlite` flag is in `start`.
- **Sandbox caveat:** when Claude runs these, the server boots inside Claude's sandbox
  (reachable only there), which serves as a clean-boot verification. To use the app on
  the owner's Mac, the owner runs the same three commands in their own terminal.

## Standing preferences (apply to all work)
1. **Reference cashify.com** for feature direction and UX patterns.
2. **Narrate mid-level progress** while working ("here's what I'm doing now") so the
   owner has clarity at each step.
3. Keep the **clean, minimal, professional UI**: navy / black / white / sky-blue / grey.
   No loud/popping colors, no gradients, no shine animations. Subtle and intuitive.
4. **Test before saying it's done** — start the server and exercise the actual flow;
   don't just claim it works.
5. Keep responses focused and concise; own mistakes plainly; don't over-format.
6. Deliverable zips are named `regear` + a number, no spaces (`regear1`, `regear2`, …),
   incrementing each delivery.

## UI design tokens (keep consistent across storefront + admin)
CSS variables both `public/index.html` and `public/admin.html` use:
```
--paper / --bg : #F6F8FB     (cool off-white page background)
--card         : #FFFFFF     (surfaces)
--ink          : #0E1726     (near-black navy text)
--ink-soft     : #5A6675     (grey secondary text)
--green        : #14315C     (PRIMARY — deep navy; name kept for compatibility)
--green-bright : #1E4D86     (navy accent)
--amber        : #3A74B3     (SECONDARY — muted sky blue; name kept for compatibility)
--line         : rgba(14,23,38,.10)
admin sidebar  : --side #102844 navy, --side-2 #1B3D63
```
- Headings: Bricolage Grotesque, weight 700, tight letter-spacing.
- Body: Hanken Grotesk. Numbers/refs/prices: JetBrains Mono.
- Destructive actions (delete) use red (#C0392B) — the only non-palette color, on purpose.
- Badges: repair = navy tint, sell = sky tint.

## Tech constraints (don't break these without asking)
- Backend: **Express 4**, single dependency **express**. No ORM, no extra frameworks.
- DB: **Node `node:sqlite`** file at `db/regear.db` (WAL). Run with
  `node --experimental-sqlite` (already in the `start` script). Don't switch databases.
- Frontend: **vanilla HTML/CSS/JS SPAs** in `public/` — no React/build step.
- Keep the API under `/api`; admin writes require `Authorization: Bearer <token>`.

## Run / scripts
```bash
npm install
npm start            # node --experimental-sqlite server.js  → http://localhost:3000
npm run seed         # seed a fresh DB
npm run reset        # wipe + reseed the DB
npm run backup       # snapshot into backups/
npm run update -- /path/to/regearN.zip   # backup, then apply a new build
```
- Admin: `admin@regear.in` / `admin123` at `/admin`.
- Dev OTP: static **123456** accepted for any number unless `DEV_OTP=false` or MSG91 set.

## Environment variables
```
PORT                default 3000
DB_PATH             default db/regear.db (set to a persistent disk in prod)
DEV_OTP             "false" disables the static demo OTP
STATIC_OTP          fixed OTP code (demo); default 123456 in dev
MSG91_AUTHKEY / MSG91_TEMPLATE_ID   real SMS OTP via MSG91 flow API
SMS_COUNTRY_CODE    default 91
RESEND_API_KEY      enables real email sending (else emails are logged)
MAIL_FROM           e.g. "ReGear <updates@regear.in>"
GOOGLE_CLIENT_ID    Google sign-in audience (or set it in Admin → Settings → Sign-in)
```

## Data / persistence notes
- All real data (catalog, orders, users, settings, templates, leads) lives in
  `db/regear.db`. **Never overwrite that file when updating code** — `update.sh`
  already excludes it.
- Delivered zips ship without a `db/regear.db` so a fresh copy seeds cleanly.
- Only OTP codes and session tokens are in-memory (intentionally short-lived).

## Behavioral defaults
- Before editing/creating files or running code, read the relevant code first.
- Prefer small, surgical edits; keep both SPAs' `<script>` valid (`node --check`).
- When a feature spans backend + both SPAs, update all the pieces and test end-to-end.
- Surface failures to the user (visible notes + console logs) instead of hiding them.
