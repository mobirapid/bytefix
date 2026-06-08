# Deploying ReGear

ReGear is a single-dependency Node.js (Express) app using Node's **built-in SQLite**
(`node:sqlite`). It needs:

- **Node.js 22.5+** (the built-in SQLite landed in 22.5; the app launches with
  `--experimental-sqlite`, which is set automatically by `npm start` or via `NODE_OPTIONS`).
- A **persistent, writable disk** for `db/regear.db` (SQLite WAL — needs a normal local
  filesystem).
- Outbound HTTPS (for Resend email + Google sign-in verification).

The database **self-seeds on first boot** (catalog, roles, statuses, the `admin@regear.in`
superadmin and `operator` accounts). Nothing to import.

---

## Environment variables

Set these on the host (a `.env` file in the project root also works — the app loads it
with no extra dependency). None are required to boot; without email keys it logs emails
in demo mode.

| Variable | Needed | Purpose |
|----------|--------|---------|
| `PORT` | optional | Port to listen on (most hosts set this for you). Default 3000. |
| `NODE_OPTIONS=--experimental-sqlite` | **on Node 22** | Enables `node:sqlite` when the app is started by a process manager that can't pass CLI flags (e.g. Passenger). Not needed on Node 23.4+. |
| `DB_PATH` | optional | Absolute path to the SQLite file on a persistent disk. Default `db/regear.db`. |
| `DEV_OTP` | optional | `false` in production to disable the demo OTP `123456`. |
| `RESEND_API_KEY` | optional | Enables real email via Resend (else logged). |
| `MAIL_FROM` | optional | e.g. `ReGear <updates@yourdomain>` — domain must be verified in Resend. |
| `GOOGLE_CLIENT_ID` | optional | Google sign-in (can also be set in Admin → Settings). |

Default logins after first boot: super admin **admin@regear.in / admin123** (`/admin`),
operator **operator / 1234** (Staff link on the main app). **Change these in production.**

---

## Option 1 — HostingSpell (cPanel + Phusion Passenger)

Their cPanel "Setup Node.js App" runs the app under Passenger. Any Premium plan includes it.

1. **Get the code on the server** — cPanel → **Terminal** (or SSH):
   ```bash
   cd ~
   git clone https://github.com/mobirapid/bytefix.git regear
   ```
   (Or upload a zip via File Manager and extract to `~/regear`.) Keep it out of
   `public_html`; the Express app serves its own static files.

2. **cPanel → Setup Node.js App → Create Application:**
   - Node.js version: **22**
   - Application mode: **Production**
   - Application root: `regear`
   - Application URL: your domain / subdomain
   - Application startup file: `server.js`

3. **Add Environment Variables** (same screen):
   - `NODE_OPTIONS` = `--experimental-sqlite`  ← **required** (Passenger can't pass the flag)
   - `DEV_OTP` = `false`
   - `RESEND_API_KEY`, `MAIL_FROM` (optional, for live email)

4. Click **Run NPM Install**, then **Start / Restart**.

5. Visit the URL (storefront) and `/admin`. The DB seeds automatically on first hit.

**Before relying on it, confirm with support:** that the Node selector is **22.5 or newer**,
and that the account home directory is a **local filesystem** (SQLite WAL must work). If you
hit a SQLite `disk I/O error`, the filesystem doesn't support WAL — use a VPS instead.

---

## Option 2 — VPS (full control, recommended for scale)

On any Ubuntu VPS (HostingSpell KVM VPS, DigitalOcean, etc.):

```bash
# install Node 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# get the code
git clone https://github.com/mobirapid/bytefix.git regear && cd regear
npm install

# run it persistently with pm2
sudo npm i -g pm2
pm2 start "node --experimental-sqlite server.js" --name regear
pm2 save && pm2 startup
```

Put nginx in front as a reverse proxy to `localhost:3000` and add SSL with certbot.
SQLite lives on the VPS disk (back it up).

---

## Option 3 — PaaS (Render / Railway / Fly.io)

Easiest deploy from this GitHub repo. Pick **Node 22+**, start command `npm start`.
**Caveat:** their default filesystems are ephemeral, so attach a **persistent volume** and
point `DB_PATH` at it (e.g. `/data/regear.db`), otherwise the DB resets on every redeploy.
For heavy scale, migrate SQLite → Postgres (the schema maps directly).

---

## Updating a deployment

```bash
cd regear
git pull
npm install        # in case dependencies changed
# cPanel: click Restart.   VPS: pm2 restart regear
```

`db/regear.db` is never overwritten by a code update (it's git-ignored), and schema
migrations apply automatically on boot.
