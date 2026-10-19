'use strict';
// Admin -> Email: status of the Microsoft 365 mail connection (OAuth2
// application permission) + one-click test.
const express = require('express');
const { requireAdmin, requireCsrf } = require('../middleware');
const mailer = require('../lib/mailer');
const msmail = require('../lib/msmail');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  const envOk = msmail.isEnvConfigured();
  const mode = await mailer.emailMode();
  res.render('admin/email', {
    envOk, mode,
    notifyEmail: process.env.APPLY_NOTIFY_EMAIL || '',
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

// Diagnostic: reads the permission roles inside the app's access token
// (never logs the token) so we can tell a consent problem apart from an
// Exchange-side propagation delay.
router.post('/check', requireCsrf, async (req, res) => {
  try {
    const roles = await msmail.tokenRoles();
    if (roles.includes('SMTP.SendAsApp')) {
      return res.redirect('/admin/email?ok=' + encodeURIComponent(
        'Microsoft issued a token WITH the SMTP.SendAsApp permission. If sending still fails, the permission is still propagating to the mail servers — wait about 30 minutes and hit "Send test email" again.'
      ));
    }
    return res.redirect('/admin/email?err=' + encodeURIComponent(
      `Token is fine, but it does NOT include the SMTP.SendAsApp permission (token carries: ${roles.join(', ') || 'no permissions'}). In Entra, open the app → API permissions → make sure SMTP.SendAsApp shows "Granted", then try again.`
    ));
  } catch (e) {
    return res.redirect('/admin/email?err=' + encodeURIComponent('Permission check failed: ' + e.message));
  }
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
