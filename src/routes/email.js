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
