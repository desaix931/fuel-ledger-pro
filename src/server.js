'use strict';
require('dotenv').config();
require('express-async-errors'); // forward async route errors to the error handler

const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const bcrypt = require('bcryptjs');

const pool = require('./db');
const migrate = require('./migrate');
const { attachUser, csrf } = require('./middleware');
const lib = require('./lib');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-to-a-long-random-string') {
  console.error('FATAL: SESSION_SECRET is not set to a real value. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('trust proxy', 1); // Render terminates TLS at the proxy

app.use(helmet({ contentSecurityPolicy: false })); // CSP off: inline JS used for small UI helpers
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  name: 'flp.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
  },
}));

app.use(attachUser);
app.use(csrf);

// formatting helpers available in every view
app.use((req, res, next) => {
  res.locals.fmtDateTime = lib.fmtDateTime;
  res.locals.fmtDate = lib.fmtDate;
  res.locals.fmtGal = lib.fmtGal;
  res.locals.todayStr = lib.todayStr;
  res.locals.FUEL_TYPES = lib.FUEL_TYPES;
  next();
});

app.get('/healthz', (req, res) => res.send('ok'));

app.use('/', require('./routes/auth'));
app.use('/apply', require('./routes/apply'));
app.use('/hire', require('./routes/hire'));
app.use('/driver', require('./routes/driver'));
app.use('/admin', require('./routes/admin'));
app.use('/admin/ledger', require('./routes/ledger'));

app.get('/', (req, res) => {
  if (!res.locals.user) return res.redirect('/login');
  return res.redirect(res.locals.user.role === 'admin' ? '/admin' : '/driver');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('unhandled error:', err);
  res.status(500).send('Something went wrong. The error has been logged.');
});

async function seedAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return;
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password || password === 'change-me-immediately') {
    console.log('No users exist and no usable ADMIN_EMAIL/ADMIN_PASSWORD set — skipping admin seed.');
    console.log('Set ADMIN_EMAIL and ADMIN_PASSWORD env vars and restart to create the first admin.');
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)',
    [email, 'Administrator', hash, 'admin']
  );
  console.log(`Seeded admin user: ${email} (change the password after first login)`);
}

async function seedCompany() {
  const map = {
    company_name: process.env.COMPANY_NAME,
    company_phone: process.env.COMPANY_PHONE,
    company_email: process.env.COMPANY_EMAIL,
    company_address: process.env.COMPANY_ADDRESS,
  };
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue;
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [k, v]
    );
  }
}

async function boot() {
  await migrate();
  await seedAdmin();
  await seedCompany();
  app.listen(PORT, () => console.log(`fuel-ledger-pro listening on :${PORT}`));
}

boot().catch((err) => { console.error('boot failed:', err); process.exit(1); });
