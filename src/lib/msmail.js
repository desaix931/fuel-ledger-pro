'use strict';
// Microsoft 365 OAuth2 (application) sending for the office mailbox.
//
// Basic SMTP AUTH (username + password) stops working as soon as the tenant
// enforces MFA / Security Defaults — Microsoft blocks legacy auth outright,
// and app passwords are not offered under Security Defaults. The supported
// path then is OAuth2 client-credentials: the app authenticates as itself
// (no user sign-in, no refresh tokens) and sends through smtp.office365.com
// via XOAUTH2 using the SMTP.SendAsApp application permission.
//
// One-time setup (Microsoft 365 admin):
//   1. Entra admin center -> Identity -> Applications -> App registrations
//      -> New registration. Name "Fuel Ledger Mail", single tenant.
//      (No redirect URI needed.)
//   2. API permissions -> Add a permission -> "APIs my organization uses" ->
//      "Office 365 Exchange Online" -> Application permissions ->
//      check SMTP.SendAsApp -> Add permissions, then "Grant admin consent".
//   3. Certificates & secrets -> New client secret -> copy the VALUE.
//   4. Set env vars on the server:
//        MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET
//      (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_FROM stay as they are;
//       SMTP_USER is the mailbox the app sends as.)
//   5. In the app: Admin -> Email -> "Send test email" to verify.
//
// Access tokens are cached in the settings table and refreshed automatically.

const pool = require('../db');

// For client-credentials, the scope must be the resource's /.default scope.
const TOKEN_SCOPE = 'https://outlook.office365.com/.default';

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

async function getAccessToken() {
  const e = env();
  if (!isEnvConfigured()) throw new Error('Set MS_CLIENT_ID, MS_TENANT_ID and MS_CLIENT_SECRET first.');
  const cached = await getSetting('ms_smtp_access_token');
  const exp = parseInt((await getSetting('ms_smtp_access_expires_at')) || '0', 10);
  if (cached && Date.now() < exp) return cached;

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
  await setSetting('ms_smtp_access_token', data.access_token);
  await setSetting('ms_smtp_access_expires_at', String(Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000));
  return data.access_token;
}

async function sendMail({ to, subject, text, attachments }) {
  const nodemailer = require('nodemailer');
  const user = process.env.SMTP_USER;
  if (!user) throw new Error('Set SMTP_USER to the mailbox address (e.g. admin@desaixtransportllc.com).');
  const accessToken = await getAccessToken();
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { type: 'OAuth2', user, accessToken },
  });
  const from = process.env.SMTP_FROM || user;
  await t.sendMail({ from, to, subject, text, attachments });
}

module.exports = { isEnvConfigured, getAccessToken, sendMail };
