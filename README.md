# Fuel Ledger Pro

Multi-user fuel delivery ledger for a fuel distribution business. Drivers log
fills from their phones; the office manages customers, dispatch, ledgers, and
billing exports. Replaces a handwritten paper ledger.

**Stack:** Node.js + Express (server-rendered pages, no SPA framework),
PostgreSQL for all data (sessions included), bcrypt password hashing.
All timestamps are the business's local time.

## Roles

- **Driver** — log fills (mobile-first form), view/edit own recent fills, see "My schedule".
- **Admin (office)** — everything: dashboard, full entry log with filters,
  customer/site/equipment management, user management, dispatch scheduling,
  ledger builder (PDF / CSV / copy-as-text / **email to multiple recipients**),
  billing CSV export, CSV import.

## Run locally

Prerequisites: Node 20+ and PostgreSQL 14+.

```bash
# 1. Create the database
createdb fuelledger
# (or: CREATE DATABASE fuelledger; with a user of your choice)

# 2. Configure
cp .env.example .env
# Edit .env: set DATABASE_URL, generate SESSION_SECRET with `openssl rand -hex 32`,
# and set ADMIN_EMAIL / ADMIN_PASSWORD for the first-boot admin account.

# 3. Install and start
npm install
npm start
```

On boot the app applies the schema, then — only if the users table is empty —
creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. **Change that
password immediately** under Admin → Users.

Open http://localhost:3000 and log in.

## Deploy on Render (when ready)

You need: a Render account and this repo pushed to GitHub/GitLab.

1. **Push this folder to a git repo** (GitHub recommended).
2. In Render: **New → Blueprint**, point it at the repo. Render reads
   `render.yaml` and creates two things: the `fuel-ledger-pro` web service
   (Docker) and the `fuel-ledger-db` managed Postgres database.
3. When prompted for the `sync: false` env vars, fill in:
   - `ADMIN_EMAIL` — the office login email
   - `ADMIN_PASSWORD` — a strong password (change it after first login)
   - `COMPANY_NAME`, `COMPANY_PHONE`, `COMPANY_EMAIL`, `COMPANY_ADDRESS` (optional; also editable in Admin → Settings)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (optional — only needed for the "Email this ledger" feature; see below)
   - `SESSION_SECRET` is generated automatically.
4. Deploy. The container runs migrations and the admin seed on first boot.
   Health check: `https://<your-service>.onrender.com/healthz`
5. Log in at the Render URL, change the admin password, add drivers
   (Admin → Users), customers, and sites. Done.

Notes:
- Ledger data lives in the managed Postgres database, **not** on the
  container's disk — it survives restarts and redeploys.
- The starter database + web service are each a few dollars a month; the
  free tier works for a trial but the database sleeps/spins down on free.

## Email setup (optional — for "Email this ledger")

On the ledger page, the office can email the ledger as a PDF attachment to
up to 20 recipients at once (comma- or semicolon-separated). This needs SMTP
credentials:

- **Easiest:** your company's existing email. If the domain's mail is hosted
  at GoDaddy/Microsoft 365/Google Workspace, create a dedicated mailbox (or
  app password) and use its SMTP settings.
- **Alternative:** a transactional service (SendGrid, Mailgun, Amazon SES —
  all have free tiers).

Set on Render (service → Environment), or in `.env` locally:

| Var | Example |
|---|---|
| `SMTP_HOST` | `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` (only `true` for port 465) |
| `SMTP_USER` | `ledgers@yourcompany.com` |
| `SMTP_PASS` | the mailbox password or app password |
| `SMTP_FROM` | `ledgers@yourcompany.com` |

If `SMTP_HOST` is not set, the email form shows a notice instead of failing —
everything else works normally. The recipient field is pre-filled with the
customer's billing email when one is saved.

## Point a domain at it (later)

Recommended: host the app on a **subdomain** of the company's existing
domain (e.g. `app.yourcompany.com`). The main website and email (MX records)
stay exactly as they are — only one DNS record is added.

1. In Render: open the `fuel-ledger-pro` service → **Settings → Custom Domains → Add**,
   enter the subdomain (e.g. `app.yourcompany.com`). Render shows the DNS target.
2. At your DNS host (wherever the domain's DNS lives):
   add a **CNAME** record, host `app`, value = the Render hostname
   (e.g. `fuel-ledger-pro.onrender.com`).
   (If you ever want the app on the apex domain instead, Render provides A
   records — add both, host `@`.)
3. Wait for DNS to propagate (usually minutes, up to a few hours). Render
   provisions the HTTPS certificate automatically.

## CSV import format

Header row (order doesn't matter):

```
date,customer,site,equipment,fuel_type,gallons,driver,notes
```

- `date`: `YYYY-MM-DD` or `YYYY-MM-DD HH:mm` (columns named `filled_at` or `datetime` are also accepted)
- `customer`: matched by name, created if missing
- `site`: matched within the customer, created if missing (may be blank)
- `driver`: matched by email or name to an existing driver; unmatched rows
  use the default driver you pick on the import page
- `gallons`: positive number

## Security notes

- Passwords hashed with bcrypt (12 rounds). Sessions stored in Postgres,
  cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Login is rate-limited; all forms carry CSRF tokens; all inputs are
  validated server-side and all SQL is parameterized.
- Drivers can only see and edit their own fills and their own schedule.
