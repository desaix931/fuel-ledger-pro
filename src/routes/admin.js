'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

const pool = require('../db');
const { requireAdmin, requireCsrf } = require('../middleware');
const { isEmail, csvCell, todayStr } = require('../lib');

const router = express.Router();
router.use(requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Dashboard ----------
router.get('/', async (req, res) => {
  const [today, week, month, byCustomer, byDay, recent] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(gallons),0)::float gal FROM fills WHERE filled_at >= date_trunc('day', NOW())`),
    pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(gallons),0)::float gal FROM fills WHERE filled_at >= date_trunc('week', NOW())`),
    pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(gallons),0)::float gal FROM fills WHERE filled_at >= date_trunc('month', NOW())`),
    pool.query(
      `SELECT c.name, COUNT(*)::int n, SUM(f.gallons)::float gal
       FROM fills f JOIN customers c ON c.id = f.customer_id
       WHERE f.filled_at >= NOW() - INTERVAL '30 days'
       GROUP BY c.name ORDER BY gal DESC LIMIT 10`),
    pool.query(
      `SELECT date_trunc('day', filled_at)::date AS d, SUM(gallons)::float gal
       FROM fills WHERE filled_at >= NOW() - INTERVAL '14 days'
       GROUP BY 1 ORDER BY 1`),
    pool.query(
      `SELECT f.*, c.name AS customer_name, u.name AS driver_name
       FROM fills f JOIN customers c ON c.id = f.customer_id JOIN users u ON u.id = f.driver_id
       ORDER BY f.filled_at DESC LIMIT 10`),
  ]);
  res.render('admin/dashboard', {
    today: today.rows[0], week: week.rows[0], month: month.rows[0],
    byCustomer: byCustomer.rows, byDay: byDay.rows, recent: recent.rows,
  });
});

// ---------- Entry log with filters ----------
router.get('/entries', async (req, res) => {
  const f = {
    from: (req.query.from || '').slice(0, 10),
    to: (req.query.to || '').slice(0, 10),
    customer_id: req.query.customer_id || '',
    driver_id: req.query.driver_id || '',
    site_id: req.query.site_id || '',
    fuel_type: req.query.fuel_type || '',
  };
  const where = [];
  const params = [];
  if (f.from) { params.push(f.from); where.push(`f.filled_at >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); where.push(`f.filled_at < ($${params.length}::date + INTERVAL '1 day')`); }
  if (f.customer_id) { params.push(f.customer_id); where.push(`f.customer_id = $${params.length}`); }
  if (f.driver_id) { params.push(f.driver_id); where.push(`f.driver_id = $${params.length}`); }
  if (f.site_id) { params.push(f.site_id); where.push(`f.site_id = $${params.length}`); }
  if (f.fuel_type) { params.push(f.fuel_type); where.push(`f.fuel_type = $${params.length}`); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [fills, totals, customers, drivers, sites] = await Promise.all([
    pool.query(
      `SELECT f.*, c.name AS customer_name, s.name AS site_name, u.name AS driver_name
       FROM fills f JOIN customers c ON c.id = f.customer_id
       LEFT JOIN sites s ON s.id = f.site_id JOIN users u ON u.id = f.driver_id
       ${clause} ORDER BY f.filled_at DESC LIMIT 500`, params),
    pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(f.gallons),0)::float gal FROM fills f ${clause}`, params),
    pool.query('SELECT id, name FROM customers ORDER BY name'),
    pool.query("SELECT id, name FROM users WHERE role = 'driver' ORDER BY name"),
    pool.query(`SELECT s.id, s.name, c.name AS customer_name FROM sites s
                JOIN customers c ON c.id = s.customer_id ORDER BY c.name, s.name`),
  ]);
  res.render('admin/entries', { fills: fills.rows, totals: totals.rows[0], f, customers: customers.rows, drivers: drivers.rows, sites: sites.rows });
});

// ---------- Users ----------
router.get('/users', async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, role, active, created_at FROM users ORDER BY role, name');
  res.render('admin/users', { users: rows, error: null });
});

router.post('/users', requireCsrf, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const name = String(req.body.name || '').trim().slice(0, 120);
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'driver';
  const { rows } = await pool.query('SELECT id, email, name, role, active, created_at FROM users ORDER BY role, name');
  const fail = (error) => res.status(400).render('admin/users', { users: rows, error });
  if (!isEmail(email)) return fail('Enter a valid email address.');
  if (!name) return fail('Enter a name.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4)', [email, name, hash, role]);
  } catch (e) {
    if (e.code === '23505') return fail('That email is already in use.');
    throw e;
  }
  res.redirect('/admin/users?created=1');
});

router.post('/users/:id/toggle', requireCsrf, async (req, res) => {
  if (String(req.params.id) === String(res.locals.user.id)) {
    return res.status(400).send('You cannot disable your own account.');
  }
  await pool.query('UPDATE users SET active = NOT active WHERE id = $1', [req.params.id]);
  res.redirect('/admin/users');
});

router.post('/users/:id/reset-password', requireCsrf, async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).send('Password must be at least 8 characters.');
  const hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
  res.redirect('/admin/users?reset=1');
});

// ---------- Customers ----------
router.get('/customers', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers ORDER BY name');
  res.render('admin/customers', { customers: rows, error: null });
});

router.post('/customers', requireCsrf, async (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim().slice(0, 160);
  const { rows } = await pool.query('SELECT * FROM customers ORDER BY name');
  if (!name) return res.status(400).render('admin/customers', { customers: rows, error: 'Customer name is required.' });
  await pool.query(
    'INSERT INTO customers (name, contact_name, contact_email, contact_phone, notes) VALUES ($1,$2,$3,$4,$5)',
    [name, b.contact_name?.trim().slice(0, 120) || null, b.contact_email?.trim().slice(0, 160) || null,
     b.contact_phone?.trim().slice(0, 40) || null, b.notes?.trim().slice(0, 2000) || null]
  );
  res.redirect('/admin/customers?created=1');
});

router.post('/customers/:id/edit', requireCsrf, async (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim().slice(0, 160);
  if (!name) return res.status(400).send('Customer name is required.');
  await pool.query(
    'UPDATE customers SET name=$1, contact_name=$2, contact_email=$3, contact_phone=$4, notes=$5 WHERE id=$6',
    [name, b.contact_name?.trim().slice(0, 120) || null, b.contact_email?.trim().slice(0, 160) || null,
     b.contact_phone?.trim().slice(0, 40) || null, b.notes?.trim().slice(0, 2000) || null, req.params.id]
  );
  res.redirect('/admin/customers?saved=1');
});

router.post('/customers/:id/toggle', requireCsrf, async (req, res) => {
  await pool.query('UPDATE customers SET active = NOT active WHERE id = $1', [req.params.id]);
  res.redirect('/admin/customers');
});

// ---------- Sites ----------
router.get('/sites', async (req, res) => {
  const [sites, customers] = await Promise.all([
    pool.query(`SELECT s.*, c.name AS customer_name FROM sites s JOIN customers c ON c.id = s.customer_id ORDER BY c.name, s.name`),
    pool.query('SELECT id, name FROM customers WHERE active ORDER BY name'),
  ]);
  res.render('admin/sites', { sites: sites.rows, customers: customers.rows, error: null });
});

router.post('/sites', requireCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 160);
  const customerId = parseInt(req.body.customer_id, 10);
  const [sites, customers] = await Promise.all([
    pool.query(`SELECT s.*, c.name AS customer_name FROM sites s JOIN customers c ON c.id = s.customer_id ORDER BY c.name, s.name`),
    pool.query('SELECT id, name FROM customers WHERE active ORDER BY name'),
  ]);
  if (!name || !customerId) return res.status(400).render('admin/sites', { sites: sites.rows, customers: customers.rows, error: 'Site name and customer are required.' });
  await pool.query('INSERT INTO sites (customer_id, name, address) VALUES ($1,$2,$3)',
    [customerId, name, String(req.body.address || '').trim().slice(0, 300) || null]);
  res.redirect('/admin/sites?created=1');
});

router.post('/sites/:id/toggle', requireCsrf, async (req, res) => {
  await pool.query('UPDATE sites SET active = NOT active WHERE id = $1', [req.params.id]);
  res.redirect('/admin/sites');
});

// ---------- Equipment ----------
router.get('/equipment', async (req, res) => {
  const [equipment, sites] = await Promise.all([
    pool.query(`SELECT e.*, s.name AS site_name, c.name AS customer_name
                FROM equipment e LEFT JOIN sites s ON s.id = e.site_id LEFT JOIN customers c ON c.id = s.customer_id
                ORDER BY e.label`),
    pool.query(`SELECT s.id, s.name, c.name AS customer_name FROM sites s
                JOIN customers c ON c.id = s.customer_id WHERE s.active ORDER BY c.name, s.name`),
  ]);
  res.render('admin/equipment', { equipment: equipment.rows, sites: sites.rows, error: null });
});

router.post('/equipment', requireCsrf, async (req, res) => {
  const label = String(req.body.label || '').trim().slice(0, 120);
  const siteId = req.body.site_id ? parseInt(req.body.site_id, 10) : null;
  const [equipment, sites] = await Promise.all([
    pool.query(`SELECT e.*, s.name AS site_name FROM equipment e LEFT JOIN sites s ON s.id = e.site_id ORDER BY e.label`),
    pool.query('SELECT id, name FROM sites WHERE active ORDER BY name'),
  ]);
  if (!label) return res.status(400).render('admin/equipment', { equipment: equipment.rows, sites: sites.rows, error: 'Equipment label is required.' });
  await pool.query('INSERT INTO equipment (site_id, label, eq_type) VALUES ($1,$2,$3)',
    [siteId, label, String(req.body.eq_type || '').trim().slice(0, 60) || null]);
  res.redirect('/admin/equipment?created=1');
});

router.post('/equipment/:id/toggle', requireCsrf, async (req, res) => {
  await pool.query('UPDATE equipment SET active = NOT active WHERE id = $1', [req.params.id]);
  res.redirect('/admin/equipment');
});

// ---------- Dispatch ----------
router.get('/dispatch', async (req, res) => {
  const [jobs, customers, drivers, sitesAll] = await Promise.all([
    pool.query(
      `SELECT j.*, c.name AS customer_name, s.name AS site_name, u.name AS driver_name
       FROM jobs j JOIN customers c ON c.id = j.customer_id
       LEFT JOIN sites s ON s.id = j.site_id LEFT JOIN users u ON u.id = j.driver_id
       WHERE j.scheduled_date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY j.scheduled_date DESC, j.window_start NULLS LAST LIMIT 200`),
    pool.query('SELECT id, name FROM customers WHERE active ORDER BY name'),
    pool.query("SELECT id, name FROM users WHERE role = 'driver' AND active ORDER BY name"),
    pool.query(`SELECT s.id, s.name, s.customer_id, c.name AS customer_name FROM sites s
                JOIN customers c ON c.id = s.customer_id WHERE s.active ORDER BY c.name, s.name`),
  ]);
  res.render('admin/dispatch', { jobs: jobs.rows, customers: customers.rows, drivers: drivers.rows, sitesAll: sitesAll.rows, error: null });
});

router.post('/dispatch', requireCsrf, async (req, res) => {
  const b = req.body;
  const customerId = parseInt(b.customer_id, 10);
  const date = String(b.scheduled_date || '').slice(0, 10);
  const [jobs, customers, drivers, sitesAll] = await Promise.all([
    pool.query('SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON c.id=j.customer_id ORDER BY j.scheduled_date DESC LIMIT 50'),
    pool.query('SELECT id, name FROM customers WHERE active ORDER BY name'),
    pool.query("SELECT id, name FROM users WHERE role = 'driver' AND active ORDER BY name"),
    pool.query(`SELECT s.id, s.name, s.customer_id, c.name AS customer_name FROM sites s
                JOIN customers c ON c.id = s.customer_id WHERE s.active ORDER BY c.name, s.name`),
  ]);
  const fail = (error) => res.status(400).render('admin/dispatch', { jobs: jobs.rows, customers: customers.rows, drivers: drivers.rows, sitesAll: sitesAll.rows, error });
  if (!customerId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Customer and a valid date are required.');
  const siteId = b.site_id ? parseInt(b.site_id, 10) : null;
  const driverId = b.driver_id ? parseInt(b.driver_id, 10) : null;
  const ws = b.window_start && /^\d{2}:\d{2}$/.test(b.window_start) ? b.window_start : null;
  const we = b.window_end && /^\d{2}:\d{2}$/.test(b.window_end) ? b.window_end : null;
  await pool.query(
    `INSERT INTO jobs (customer_id, site_id, scheduled_date, window_start, window_end, driver_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [customerId, siteId, date, ws, we, driverId, String(b.notes || '').trim().slice(0, 2000) || null]
  );
  res.redirect('/admin/dispatch?created=1');
});

router.post('/dispatch/:id/status', requireCsrf, async (req, res) => {
  const ok = ['scheduled', 'in_progress', 'done', 'cancelled'];
  if (!ok.includes(req.body.status)) return res.status(400).send('Invalid status.');
  await pool.query('UPDATE jobs SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
  res.redirect('/admin/dispatch');
});

// ---------- CSV import ----------
router.get('/import', async (req, res) => {
  const { rows } = await pool.query("SELECT id, name FROM users WHERE role = 'driver' AND active ORDER BY name");
  res.render('admin/import', { result: null, error: null, drivers: rows });
});

router.post('/import', upload.single('file'), requireCsrf, async (req, res) => {
  const { rows: drivers } = await pool.query("SELECT id, name, email FROM users WHERE role = 'driver' AND active");
  const fail = (error) => res.status(400).render('admin/import', { result: null, error, drivers });
  if (!req.file) return fail('Choose a CSV file to upload.');
  const defaultDriverId = parseInt(req.body.default_driver_id, 10);
  if (!defaultDriverId) return fail('Pick a default driver for rows whose driver cannot be matched.');

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), {
      columns: true, skip_empty_lines: true, trim: true,
      relax_column_count: true, // tolerate ragged rows; validated per-row below
    });
  } catch (e) {
    return fail('Could not parse the CSV: ' + e.message);
  }
  // Expected headers (case-insensitive): date, customer, site, equipment, fuel_type, gallons, driver, notes
  const norm = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().trim(), v]));
  const custCache = new Map();
  const siteCache = new Map();
  let imported = 0;
  const skipped = [];
  for (let i = 0; i < records.length; i++) {
    const r = norm(records[i]);
    const line = i + 2;
    try {
      const dateRaw = String(r.date || r.filled_at || r.datetime || '').trim();
      const m = dateRaw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?)?$/);
      if (!m) throw new Error(`bad date "${dateRaw}" (use YYYY-MM-DD or YYYY-MM-DD HH:mm)`);
      const filledAt = m[1] + 'T' + (m[2] || '12:00');
      const custName = String(r.customer || '').trim();
      if (!custName) throw new Error('missing customer');
      const gallons = Number(String(r.gallons || '').replace(/,/g, ''));
      if (!Number.isFinite(gallons) || gallons <= 0 || gallons >= 100000) throw new Error(`bad gallons "${r.gallons}"`);
      const fuelType = String(r.fuel_type || r.fueltype || '').trim().slice(0, 60) || 'Diesel';
      const eqLabel = String(r.equipment || '').trim().slice(0, 120) || 'Unspecified';
      const notes = String(r.notes || '').trim().slice(0, 2000) || null;

      let customerId;
      const ck = custName.toLowerCase();
      if (custCache.has(ck)) customerId = custCache.get(ck);
      else {
        const found = await pool.query('SELECT id FROM customers WHERE LOWER(name) = $1', [ck]);
        if (found.rows.length) customerId = found.rows[0].id;
        else {
          const ins = await pool.query('INSERT INTO customers (name) VALUES ($1) RETURNING id', [custName]);
          customerId = ins.rows[0].id;
        }
        custCache.set(ck, customerId);
      }
      let siteId = null;
      const siteName = String(r.site || '').trim();
      if (siteName) {
        const sk = customerId + '|' + siteName.toLowerCase();
        if (siteCache.has(sk)) siteId = siteCache.get(sk);
        else {
          const found = await pool.query('SELECT id FROM sites WHERE customer_id = $1 AND LOWER(name) = $2', [customerId, siteName.toLowerCase()]);
          if (found.rows.length) siteId = found.rows[0].id;
          else {
            const ins = await pool.query('INSERT INTO sites (customer_id, name) VALUES ($1,$2) RETURNING id', [customerId, siteName]);
            siteId = ins.rows[0].id;
          }
          siteCache.set(sk, siteId);
        }
      }
      const drvRaw = String(r.driver || '').trim().toLowerCase();
      let driverId = defaultDriverId;
      if (drvRaw) {
        const match = drivers.find((d) => d.email.toLowerCase() === drvRaw || d.name.toLowerCase() === drvRaw);
        if (match) driverId = match.id;
      }
      await pool.query(
        `INSERT INTO fills (filled_at, customer_id, site_id, equipment_label, fuel_type, gallons, driver_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [filledAt, customerId, siteId, eqLabel, fuelType, gallons, driverId, notes]
      );
      imported++;
    } catch (e) {
      skipped.push(`Row ${line}: ${e.message}`);
      if (skipped.length > 25) { skipped.push('…stopping after 25 errors'); break; }
    }
  }
  res.render('admin/import', { result: { imported, skipped }, error: null, drivers });
});

// ---------- Billing export ----------
router.get('/billing.csv', async (req, res) => {
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  const where = [];
  const params = [];
  if (from) { params.push(from); where.push(`f.filled_at >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`f.filled_at < ($${params.length}::date + INTERVAL '1 day')`); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT f.filled_at, c.name AS customer, s.name AS site, f.equipment_label AS equipment,
            f.fuel_type, f.gallons, u.name AS driver, f.notes
     FROM fills f JOIN customers c ON c.id = f.customer_id
     LEFT JOIN sites s ON s.id = f.site_id JOIN users u ON u.id = f.driver_id
     ${clause} ORDER BY f.filled_at`, params);
  const lines = [['date', 'customer', 'site', 'equipment', 'fuel_type', 'gallons', 'driver', 'notes'].join(',')];
  for (const r of rows) {
    lines.push([r.filled_at.toISOString().slice(0, 16).replace('T', ' '), r.customer, r.site, r.equipment,
      r.fuel_type, Number(r.gallons).toFixed(2), r.driver, r.notes].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="billing-export-${from || 'all'}-to-${to || 'all'}.csv"`);
  res.send(lines.join('\r\n'));
});

// ---------- Settings ----------
router.get('/settings', async (req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.render('admin/settings', { s, saved: !!req.query.saved });
});

router.post('/settings', requireCsrf, async (req, res) => {
  const keys = ['company_name', 'company_phone', 'company_email', 'company_address'];
  for (const k of keys) {
    const v = String(req.body[k] || '').trim().slice(0, 300);
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [k, v]
    );
  }
  res.redirect('/admin/settings?saved=1');
});

module.exports = router;
