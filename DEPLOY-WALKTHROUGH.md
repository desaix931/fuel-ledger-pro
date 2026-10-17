# Deploy walkthrough — Fuel Ledger Pro (self-serve)

Everything is built, tested, and committed. Follow these steps in order; nothing
expires, and you can stop after any step and come back later. ~30 minutes total.

## Step 1 — Get the code onto GitHub (5 min)

The code lives on the Muse computer, not yours — so this is a 2-part step.

1. **You:** go to github.com → **New repository**. Name it `fuel-ledger-pro`,
   Private, no README. On the repo page, copy the repo URL
   (`https://github.com/yourname/fuel-ledger-pro`).
2. **You:** create a deploy token — GitHub → your profile → **Settings →
   Developer settings → Personal access tokens → Tokens (classic)** → Generate
   new token (classic). Name it "fuel-ledger-deploy", set it to expire in
   7 days, tick **repo** (full control of private repositories). Copy the token.
3. **Me:** send me the repo URL + token in chat, and I'll push the whole
   project (already committed and ready) straight from here. You'll see all
   the files — including `render.yaml` — land in the repo.
4. **After the push works:** revoke the token (same tokens page → Delete).
   It was only needed once.

## Step 2 — Spin it up on Render (10 min)

1. render.com → **New → Blueprint**. Connect GitHub if asked, pick `fuel-ledger-pro`.
2. Render reads `render.yaml` and shows two services: the `fuel-ledger-pro` web
   service (Docker, starter plan) and `fuel-ledger-db` (managed Postgres). Click Apply.
3. When prompted for the `sync: false` env vars, fill in:
   - `ADMIN_EMAIL` — your office login (e.g. your company email)
   - `ADMIN_PASSWORD` — a strong password (you'll change it after first login)
   - `COMPANY_NAME`: Desaix Transport LLC, `COMPANY_PHONE`: 931-707-5172,
     `COMPANY_EMAIL`: your company email, `COMPANY_ADDRESS`: PO Box 3879, Crossville, TN 38555
   - SMTP settings — **optional**. Skip for now if you don't want ledger-by-email
     yet; everything else works without it, and you can add it later under
     Render → Environment.
   - `SESSION_SECRET` is auto-generated. Leave it.
4. Wait for the build (a few minutes). Check it: open
   `https://fuel-ledger-pro.onrender.com/healthz` — you should see OK.
5. Log in at the Render URL, go to **Admin → Users**, change the admin password,
   then add your drivers and office staff (each gets their own login).

## Step 3 — Put it on your subdomain (10 min)

Recommended: `app.desaixtransportllc.com`. Your website and email stay untouched —
this adds exactly one DNS record.

1. In Render: open the `fuel-ledger-pro` service → **Settings → Custom Domains → Add**,
   type `app.desaixtransportllc.com`. Render shows you the DNS target hostname
   (looks like `fuel-ledger-pro.onrender.com`).
2. In GoDaddy: your domain → **DNS → Manage DNS** (or DNS Management).
   Add record → **CNAME**, Host: `app`, Points to: the Render hostname from step 1.
   Save.
3. Back in Render, the domain verifies once DNS propagates (usually minutes, up
   to a few hours). Render issues the HTTPS certificate automatically — no action.
4. Test: visit `https://app.desaixtransportllc.com` on your phone and on the
   office computer. Drivers: open in the phone browser, then **Add to Home Screen**.

## Step 4 — Put the hiring forms on your website (5 min)

Two iframe embeds in the README, both with the same 3 GoDaddy Website Builder steps
(Add → HTML block → paste snippet → Publish). Swap in your real subdomain.

- Driver application: `https://app.desaixtransportllc.com/apply` (replaces the
  Google Forms link on desaixtransportllc.com)
- DOT compliance package (separate form): `https://app.desaixtransportllc.com/hire/package`

## Costs (approximate, not quotes)

- Render starter web service ($7) + Basic 256MB Postgres ($6): ~$13/month combined.
- Free tier exists if you want a trial first, but the free database sleeps when
  idle — not what you want for a production tool.
- No cost from GoDaddy for the subdomain or DNS record.

## After it's live

- **Drivers** log in on their phones and log fills (BOL photos optional, camera
  opens automatically). Each driver sees only their own entries.
- **Office** sees everything: full log with filters, BOL badges, dispatch
  scheduling, ledger builder, billing CSV export, and the Applications / DOT
  Packages inboxes (you get emailed on every submission if SMTP is set).

---

*Reference: the repo README (same folder) has the full technical detail —
env var table, CSV import format, email setup options.*
