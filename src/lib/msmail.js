'use strict';
// Microsoft 365 OAuth2 (delegated) sending for the office mailbox.
//
// Basic SMTP AUTH (username + password) stops working as soon as the tenant
// enforces MFA / Security Defaults — Microsoft blocks legacy auth outright,
// and app passwords are not offered under Security Defaults. The supported
// path then is OAuth2: the app sends through smtp.office365.com using
// XOAUTH2 with an access token obtained for the mailbox via a delegated
// "SMTP.Send" permission.
//
// One-time setup (Microsoft 365 admin):
//   1. Entra admin center -> Identity -> Applications -> App registrations
//      -> New registration. Name "Fuel Ledger Mail", single tenant.
//      Redirect URI (Web):
//        https://app.desaixtransportllc.com/admin/email/callback
//      (override with MS_REDIRECT_URI env var if the app lives elsewhere)
//   2. API permissions -> Add a permission -> "Office 365 Exchange Online"
//      -> Delegated permissions -> check SMTP.Send -> Add permissions,
//      then "Grant admin consent".
//   3. Certificates & secrets -> New client secret -> copy the VALUE.
//   4. Set env vars on the server:
//        MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET
//      (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_FROM stay as they are)
//   5. In the app: Admin -> Email -> "Connect Microsoft email" and sign in
//      once as the mailbox. The refresh token is stored in the settings
//      table; access tokens are refreshed automatically.

const pool = require('../db');

const SMTP_SCOPE = 'https://outlook.office365.com/SMTP.Send';
const DEFAULT_REDIRECT_URI = 'https://app.desaixtransportllc.com/admin/email/callback';

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

function redirectUri() {
  return process.env.MS_REDIRECT_URI || DEFAULT_REDIRECT_URI;
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

async function delSetting(key) {
  await pool.query('DELETE FROM settings WHERE key = $1', [key]);
}

async function isConnected() {
  return Boolean(await getSetting('ms_smtp_refresh_token'));
}

async function connectedAccount() {
  return getSetting('ms_smtp_account');
}

async function disconnect() {
  for (const k of ['ms_smtp_refresh_token', 'ms_smtp_access_token', 'ms_smtp_access_expires_at', 'ms_smtp_account']) {
    await delSetting(k);
  }
}

function authorizeUrl(state) {
  const e = env();
  const params = new URLSearchParams({
    client_id: e.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: `offline_access ${SMTP_SCOPE}`,
    state,
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(e.tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function tokenRequest(params) {
  const e = env();
  const body = new URLSearchParams({
    client_id: e.clientId,
    client_secret: e.clientSecret,
    ...params,
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
  return data;
}

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
  } catch (_) {
    return {};
  }
}

async function exchangeCode(code) {
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });
  if (!data.refresh_token) throw new Error('Microsoft did not return a refresh token (is "offline_access" in the scope?).');
  await setSetting('ms_smtp_refresh_token', data.refresh_token);
  if (data.access_token) {
    await setSetting('ms_smtp_access_token', data.access_token);
    await setSetting('ms_smtp_access_expires_at', String(Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000));
  }
  const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
  const account = claims.preferred_username || claims.upn || claims.email || '';
  if (account) await setSetting('ms_smtp_account', String(account).toLowerCase());
  return data;
}

async function getAccessToken() {
  const cached = await getSetting('ms_smtp_access_token');
  const exp = parseInt((await getSetting('ms_smtp_access_expires_at')) || '0', 10);
  if (cached && Date.now() < exp) return cached;
  const refresh = await getSetting('ms_smtp_refresh_token');
  if (!refresh) throw new Error('Microsoft email is not connected. Go to Admin -> Email and connect it.');
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  if (data.refresh_token) await setSetting('ms_smtp_refresh_token', data.refresh_token); // rotation
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

module.exports = {
  isEnvConfigured,
  isConnected,
  connectedAccount,
  disconnect,
  authorizeUrl,
  exchangeCode,
  redirectUri,
  DEFAULT_REDIRECT_URI,
  sendMail,
};
