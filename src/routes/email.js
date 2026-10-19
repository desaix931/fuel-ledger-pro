'use strict';
// Admin -> Email: connect the office Microsoft 365 mailbox via OAuth2
// (modern sign-in), so form notifications can send even when the tenant
// blocks basic SMTP AUTH (MFA / Security Defaults).
const express = require('express');
const crypto = require('crypto');
const { requireAdmin, requireCsrf } = require('../middleware');
const mailer = require('../lib/mailer');
const msmail = require('../lib/msmail');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  const envOk = msmail.isEnvConfigured();
  const connected = envOk && await msmail.isConnected();
  const account = connected ? await msmail.connectedAccount() : null;
  const mode = await mailer.emailMode();
  res.render('admin/email', {
    envOk, connected, account, mode,
    redirectUri: msmail.redirectUri(),
    notifyEmail: process.env.APPLY_NOTIFY_EMAIL || '',
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

// Start the Microsoft sign-in.
router.get('/connect', async (req, res) => {
  if (!msmail.isEnvConfigured()) return res.redirect('/admin/email?err=' + encodeURIComponent('Set MS_CLIENT_ID, MS_TENANT_ID and MS_CLIENT_SECRET first.'));
  const state = crypto.randomBytes(24).toString('hex');
  req.session.ms_oauth_state = state;
  res.redirect(msmail.authorizeUrl(state));
});

// Microsoft redirects back here after sign-in.
router.get('/callback', async (req, res) => {
  const fail = (m) => res.redirect('/admin/email?err=' + encodeURIComponent(m));
  const { code, state, error, error_description } = req.query;
  if (error) return fail(`Microsoft sign-in failed: ${error_description || error}`);
  if (!state || state !== req.session.ms_oauth_state) return fail('Sign-in state mismatch. Please try connecting again.');
  delete req.session.ms_oauth_state;
  if (!code) return fail('Microsoft did not return an authorization code.');
  try {
    await msmail.exchangeCode(String(code));
  } catch (e) {
    return fail('Could not finish connecting: ' + e.message);
  }
  res.redirect('/admin/email?ok=' + encodeURIComponent('Microsoft email connected. Send yourself a test below to verify.'));
});

router.post('/disconnect', requireCsrf, async (req, res) => {
  await msmail.disconnect();
  res.redirect('/admin/email?ok=' + encodeURIComponent('Microsoft email disconnected.'));
});

// One-click verification: sends a test notification to the office inbox.
router.post('/test', requireCsrf, async (req, res) => {
  const to = String(process.env.APPLY_NOTIFY_EMAIL || '').trim();
  if (!to) return res.redirect('/admin/email?err=' + encodeURIComponent('Set APPLY_NOTIFY_EMAIL first.'));
  try {
    await mailer.sendMail({
      to,
      subject: 'Fuel Ledger email test',
      text: 'This is a test from the Fuel Ledger app. If you received this, form notifications are working.',
    });
  } catch (e) {
    return res.redirect('/admin/email?err=' + encodeURIComponent('Test failed: ' + e.message));
  }
  res.redirect('/admin/email?ok=' + encodeURIComponent(`Test email sent to ${to}. Check that inbox.`));
});

module.exports = router;
