'use strict';
// Microsoft 365 sending for the office mailbox, via Microsoft Graph.
//
// Basic SMTP AUTH (username + password) stops working as soon as the tenant
// enforces MFA / Security Defaults — Microsoft blocks legacy auth outright,
// and app passwords are not offered under Security Defaults. OAuth2 SMTP
// (XOAUTH2 with SMTP.SendAsApp) gets further but still needs an Exchange
// Online PowerShell step to register the app's service principal before
// Exchange will accept it. The path that needs no Exchange-side setup is
// Microsoft Graph: the app authenticates as itself (client credentials, no
// user sign-in, no refresh tokens) and calls POST /users/{mailbox}/sendMail
// with the Mail.Send application permission.
//
// One-time setup (Microsoft 365 admin):
//   1. Entra admin center -> Identity -> Applications -> App registrations
//      -> New registration. Name "Fuel Ledger Mail", single tenant.
//      (No redirect URI needed.)
//   2. API permissions -> Add a permission -> Microsoft Graph ->
//      Application permissions -> check Mail.Send -> Add permissions,
//      then "Grant admin consent".
//   3. Certificates & secrets -> New client secret -> copy the VALUE.
//   4. Set env vars on the server:
//        MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET
//      (SMTP_USER is the mailbox the app sends as; SMTP_FROM, if set,
//       overrides the sending address.)
//   5. In the app: Admin -> Email -> "Send test email" to verify.
//
// Access tokens are cached in the settings table and refreshed automatically.

const pool = require('../db');

// For client-credentials, the scope must be the resource's /.default scope.
const TOKEN_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Graph tokens are cached under their own settings keys — a token minted
// for the old Outlook/SMTP scope would not work against Graph.
const TOKEN_KEY = 'ms_graph_access_token';
const TOKEN_EXP_KEY = 'ms_graph_access_expires_at';

function env() {
  return {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    tenantId: process.env.MS_TENANT_ID || '',
  };
}

function isEnvConfigured() {
  const e = env();
  return Boolean(e.clientId && e.clientSecret && e.tenantId);
}

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

async function getAccessToken(opts = {}) {
  const e = env();
  if (!isEnvConfigured()) throw new Error('Set MS_CLIENT_ID, MS_TENANT_ID and MS_CLIENT_SECRET first.');
  if (!opts.fresh) {
    const cached = await getSetting(TOKEN_KEY);
    const exp = parseInt((await getSetting(TOKEN_EXP_KEY)) || '0', 10);
    if (cached && Date.now() < exp) return cached;
  }

  const body = new URLSearchParams({
    client_id: e.clientId,
    client_secret: e.clientSecret,
    grant_type: 'client_credentials',
    scope: TOKEN_SCOPE,
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(e.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON error */ }
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || `Microsoft token request failed (HTTP ${res.status})`);
  }
  if (!data.access_token) throw new Error('Microsoft did not return an access token.');
  await setSetting(TOKEN_KEY, data.access_token);
  await setSetting(TOKEN_EXP_KEY, String(Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000));
  return data.access_token;
}

// Reads the permission roles embedded in a FRESH access token, without
// logging or exposing the token itself. Used by the Admin -> Email
// "Check Microsoft permissions" diagnostic.
async function tokenRoles() {
  const token = await getAccessToken({ fresh: true });
  const segment = String(token).split('.')[1] || '';
  let payload = {};
  try {
    payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch (_) { /* not a JWT we can read */ }
  return Array.isArray(payload.roles) ? payload.roles : [];
}

// Accepts the same recipient shapes the old SMTP path did: a single address,
// a comma/semicolon-separated string, or an array of addresses.
function recipientList(to) {
  const raw = Array.isArray(to) ? to : String(to || '').split(/[,;]/);
  return raw.map((s) => String(s).trim()).filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

// Converts a nodemailer-style attachment ({ filename, content, contentType })
// into a Microsoft Graph fileAttachment (base64 contentBytes).
function fileAttachment(att) {
  const content = att && att.content != null ? att.content : '';
  let contentBytes;
  if (Buffer.isBuffer(content)) contentBytes = content.toString('base64');
  else if (att && att.encoding === 'base64') contentBytes = String(content);
  else contentBytes = Buffer.from(String(content)).toString('base64');
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: (att && att.filename) || 'attachment',
    contentType: (att && att.contentType) || 'application/octet-stream',
    contentBytes,
  };
}

// Builds the JSON body for POST /users/{mailbox}/sendMail. Graph messages
// carry a single body: an HTML body wins when both are supplied.
// Pure function (no I/O) so it can be unit-tested offline.
function buildGraphPayload({ to, subject, text, html, attachments }) {
  const message = {
    subject: subject || '',
    body: html
      ? { contentType: 'HTML', content: html }
      : { contentType: 'Text', content: text || '' },
    toRecipients: recipientList(to),
  };
  if (Array.isArray(attachments) && attachments.length) {
    message.attachments = attachments.map(fileAttachment);
  }
  return { message, saveToSentItems: false };
}

async function graphSend(accessToken, from, payload) {
  const res = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 202) return; // Accepted — Graph sends asynchronously.
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON error */ }
  const err = data && data.error ? data.error : {};
  const e = new Error(
    `Microsoft Graph sendMail failed (HTTP ${res.status}${err.code ? ' ' + err.code : ''}): ${err.message || 'no error detail returned'}`
  );
  e.status = res.status;
  throw e;
}

async function sendMail({ to, subject, text, html, attachments }) {
  const user = process.env.SMTP_USER;
  if (!user) throw new Error('Set SMTP_USER to the mailbox address (e.g. admin@desaixtransportllc.com).');
  const from = process.env.SMTP_FROM || user;
  const payload = buildGraphPayload({ to, subject, text, html, attachments });
  try {
    await graphSend(await getAccessToken(), from, payload);
  } catch (e) {
    // 401: the cached token is no good. 403: it may have been minted before
    // a permission grant finished propagating, so its roles are stale.
    // Either way, fetch a fresh token and retry once before giving up.
    if (e.status !== 401 && e.status !== 403) throw e;
    await graphSend(await getAccessToken({ fresh: true }), from, payload);
  }
}

module.exports = { isEnvConfigured, getAccessToken, tokenRoles, sendMail, buildGraphPayload };
