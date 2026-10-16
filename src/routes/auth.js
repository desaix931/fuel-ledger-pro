'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const pool = require('../db');
const { requireCsrf } = require('../middleware');
const { isEmail } = require('../lib');

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

module.exports = router;
