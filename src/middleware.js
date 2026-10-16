'use strict';
const crypto = require('crypto');

function currentUser(req) {
  return req.session && req.session.userId
    ? { id: req.session.userId, role: req.session.role, name: req.session.name, email: req.session.email }
    : null;
}

function attachUser(req, res, next) {
  res.locals.user = currentUser(req);
  next();
}

function requireLogin(req, res, next) {
  if (!currentUser(req)) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (u.role !== 'admin') return res.status(403).send('Forbidden: office accounts only.');
  next();
}

// --- CSRF (double-submit via session) ---
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  next();
}

function requireCsrf(req, res, next) {
  const sent = req.body && req.body._csrf;
  if (!sent || sent !== req.session.csrf) {
    return res.status(403).send('Invalid form token. Please go back, reload the page, and try again.');
  }
  next();
}

module.exports = { currentUser, attachUser, requireLogin, requireAdmin, csrf, requireCsrf };
