'use strict';
// Optional SMTP email. All settings come from env vars; if SMTP_HOST is not
// set, email is disabled and the app shows a clear notice instead of failing.
const nodemailer = require('nodemailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function transporter() {
  if (!isConfigured()) return null;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  });
  return t;
}

// Parse "a@x.com, b@y.com; c@z.com" -> array of valid emails. Throws on invalid.
function parseRecipients(raw, max = 20) {
  const list = String(raw || '')
    .split(/[,;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) throw new Error('Enter at least one recipient email address.');
  if (unique.length > max) throw new Error(`Too many recipients (max ${max}).`);
  const bad = unique.filter((e) => !EMAIL_RE.test(e) || e.length > 254);
  if (bad.length) throw new Error(`Invalid email address: ${bad[0]}`);
  return unique;
}

async function sendMail({ to, subject, text, attachments }) {
  // Prefer Microsoft OAuth2 (application permission) when its credentials
  // are configured — required when the tenant blocks basic SMTP AUTH
  // (MFA / Security Defaults). Otherwise fall back to plain SMTP AUTH.
  const msmail = require('./msmail');
  if (msmail.isEnvConfigured()) {
    return msmail.sendMail({ to, subject, text, attachments });
  }
  const t = transporter();
  if (!t) throw new Error('Email is not configured. Set SMTP_HOST (and friends) in the environment.');
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) throw new Error('Email is not configured. Set SMTP_FROM in the environment.');
  await t.sendMail({ from, to, subject, text, attachments });
}

// 'oauth' = Microsoft modern sign-in configured, 'smtp' = basic SMTP AUTH,
// 'none' = nothing configured.
async function emailMode() {
  const msmail = require('./msmail');
  if (msmail.isEnvConfigured()) return 'oauth';
  if (isConfigured()) return 'smtp';
  return 'none';
}

module.exports = { isConfigured, parseRecipients, sendMail, emailMode };
