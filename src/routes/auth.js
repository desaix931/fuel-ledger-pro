'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const pool = require('../db');
const { requireLogin, requireCsrf } = require('../middleware');
const { isEmail, passwordError } = require('../lib');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please wait a few minutes and try again.',
});

router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { error: null, next: req.query.next || '' });
});

router.post('/login', loginLimiter, requireCsrf, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const fail = (msg) => res.status(401).render('login', { error: msg, next: req.body.next || '' });

  if (!isEmail(email) || !password) return fail('Enter your email and password.');

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !user.active) return fail('Invalid email or password.');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return fail('Invalid email or password.');

  req.session.regenerate((err) => {
    if (err) return fail('Could not start a session. Try again.');
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.name = user.name;
    req.session.email = user.email;
    const next = String(req.body.next || '');
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : null;
    if (safeNext) return req.session.save(() => res.redirect(safeNext));
    req.session.save(() => res.redirect(user.role === 'admin' ? '/admin' : '/driver'));
  });
});

router.post('/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Self-service password change (any logged-in user).
router.get('/password', requireLogin, (req, res) => {
  res.render('password', { error: null, ok: req.query.ok ? 'Password changed.' : null });
});

router.post('/password', requireLogin, loginLimiter, requireCsrf, async (req, res) => {
  const userId = res.locals.user.id;
  const fail = (error) => res.status(400).render('password', { error, ok: null });
  const current = String(req.body.current_password || '');
  const pw1 = String(req.body.new_password || '');
  const pw2 = String(req.body.confirm_password || '');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows.length) return fail('Account not found.');
  if (!(await bcrypt.compare(current, rows[0].password_hash))) return fail('Current password is incorrect.');
  const pwErr = passwordError(pw1);
  if (pwErr) return fail(pwErr);
  if (pw1 !== pw2) return fail('New passwords do not match.');
  const hash = await bcrypt.hash(pw1, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  // Sign out every other session for this user (this device stays logged in).
  try {
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`, [String(userId), req.sessionID]);
  } catch (e) { /* session table may not exist yet */ }
  res.redirect('/password?ok=1');
});

module.exports = router;
