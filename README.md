# Fuel Ledger Pro

Multi-user fuel delivery ledger for a fuel distribution business. Drivers log
fills from their phones; the office manages customers, dispatch, ledgers, and
billing exports. Replaces a handwritten paper ledger.

**Stack:** Node.js + Express (server-rendered pages, no SPA framework),
PostgreSQL for all data (sessions included), bcrypt password hashing.
All timestamps are the business's local time.

## Roles

- **Driver** — log fills (mobile-first form, incl. optional BOL photos), view/edit own recent fills, see "My schedule".
- **Admin (office)** — everything: dashboard, full entry log with filters,
  customer/site/equipment management, user management, dispatch scheduling,
  ledger builder (PDF / CSV / copy-as-text / **email to multiple recipients**),
  billing CSV export, CSV import.

## BOL photos on fills

When logging a fill, a driver can snap up to 3 photos of the bill of lading —
the phone camera opens directly, and photos are resized on-device before
uploading. Photos are stored as bytea in Postgres (survive Render restarts),
validated server-side (JPEG/PNG/WebP magic bytes, 8 MB max each). The office
sees a "BOL ×n" badge in the entry log and on ledgers, and can view/download
the photos from the fill's detail page (admin-only URLs).

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

## CDL driver job application (`/apply`)

A public, mobile-friendly job-application form lives at `/apply` — no login
needed. Drivers apply from their phones; every submission is saved to the
`job_applications` table and the office is emailed (see below). The office
reviews applications under **Admin → Applications** (status: new → reviewed
→ hired / declined).

**Document photos:** the form collects photos of the driver's license (front
and back, required), the DOT medical examiner's certificate (required), and
up to 3 additional documents (optional). On phones the file inputs open the
camera directly. Photos are compressed in the browser before sending (max
1600px on the long edge, JPEG ~0.8 quality). Files are stored as `bytea` in
the `application_documents` table in Postgres — never on the container's
disk, so they survive restarts and redeploys. The office views and downloads
them from the application detail page; document URLs are admin-only and never
public. Server-side rules: JPEG/PNG/WebP only (magic bytes are checked, not
just the claimed type), 8 MB max per file.

**Notification email:** when a driver applies, the office gets an email if
SMTP is configured (see "Email setup"). The recipient is `APPLY_NOTIFY_EMAIL`
when set, otherwise the company email from Admin → Settings. If email isn't
configured, the application is still saved and flagged in the inbox — an
application is never lost because email failed.

Spam protection: a honeypot field plus per-IP rate limiting (10/hour).

### Embed the form on the company website

This replaces the Google Forms "Driver app" link on desaixtransportllc.com.
The form is designed to sit inside an iframe:

```html
<iframe src="https://app.yourdomain.com/apply"
        title="CDL Driver Job Application — Desaix Transport"
        style="width:100%;height:2300px;border:0;"
        loading="lazy"></iframe>
```

Swap `app.yourdomain.com` for your real subdomain, and raise `height` if the
form ever grows (the page itself is responsive, so it works on phones and
desktops alike).

**GoDaddy Website Builder — 3 steps:**

1. In the page editor, click **Add** (or the + between sections) → **HTML** /
   **Embed HTML** block.
2. Paste the snippet above into the **Custom Code** field.
3. Publish — applicants apply right on your site and the office gets emailed.

## DOT compliance hiring package (`/hire/package`)

A **separate** public form for the post-application, pre-hire FMCSA driver
qualification paperwork — the prospective driver fills this out after applying
(it is not part of `/apply`). Mobile-friendly, no login needed.

**What it collects:**
- **A. Link to application** — name, email, DOB. The server soft-matches to a
  `job_applications` row by email (+ name/DOB sanity check). If nothing
  matches, the package is still saved with `match_status='unmatched'` for
  office review — a package is never lost because the driver typo'd an email.
- **B. Safety performance history release (49 CFR 391.23)** — every
  DOT-regulated employer from the past 3 years (up to 5), with contact info,
  plus a typed signature authorizing Desaix Transport LLC to obtain the
  safety history.
- **C. Drug & alcohol testing history (49 CFR Part 382 / §40.25)** — yes/no on
  positives or refusals in the past 2 years, with details + SAP status if yes.
- **D. FMCSA Clearinghouse acknowledgment** — required checkbox: the carrier
  runs a full pre-employment Clearinghouse query; the driver must register and
  provide electronic consent.
- **E. Medical certification details** — examiner name, National Registry
  number, issue/expiry dates (the card photo is already on file from the
  application).
- **F. Driver's certification of violations (49 CFR 391.27)** — all
  non-parking violations in the past 12 months, or a "no violations" check,
  with typed signature + date.
- **G. Road test acknowledgment (49 CFR 391.33)** — required checkbox: the
  valid CDL is accepted in lieu of a road test.

**Office side:** submissions are emailed (same `APPLY_NOTIFY_EMAIL` fallback
chain as applications; a package is never lost if email fails) and appear
under **Admin → DOT Packages** (list shows matched/unmatched, status workflow
pending → reviewed → filed). When a package matches an application, the
application detail page shows a **"DOT hiring package"** card linking to it.

Spam protection: honeypot + per-IP rate limiting (10/hour).

**Embed on the company website** (separate from the application embed):

```html
<iframe src="https://app.yourdomain.com/hire/package"
        title="DOT Compliance Hiring Package — Desaix Transport"
        style="width:100%;height:2600px;border:0;"
        loading="lazy"></iframe>
```

Same 3 GoDaddy steps as the application form. This form collects the driver's
portions — the office still runs the MVR, Clearinghouse queries,
previous-employer inquiries, and pre-employment drug test itself. Operational
info, not legal advice.

## Security notes

- Passwords hashed with bcrypt (12 rounds). Sessions stored in Postgres,
  cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Login is rate-limited; all forms carry CSRF tokens; all inputs are
  validated server-side and all SQL is parameterized.
- Drivers can only see and edit their own fills and their own schedule.
