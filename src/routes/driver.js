'use strict';
const express = require('express');
const pool = require('../db');
const { requireLogin, requireCsrf } = require('../middleware');
const { FUEL_TYPES, parseLocalDateTime, toInputDateTime, todayStr } = require('../lib');

const router = express.Router();
router.use(requireLogin);

async function formLookups() {
  const [customers, sites, equipment, recentEq] = await Promise.all([
    pool.query("SELECT id, name FROM customers WHERE active ORDER BY name"),
    pool.query(`SELECT s.id, s.name, s.customer_id, c.name AS customer_name
                FROM sites s JOIN customers c ON c.id = s.customer_id
                WHERE s.active AND c.active ORDER BY c.name, s.name`),
    pool.query(`SELECT e.id, e.label, e.site_id, s.name AS site_name
                FROM equipment e LEFT JOIN sites s ON s.id = e.site_id
                WHERE e.active ORDER BY e.label`),
    pool.query(`SELECT equipment_label, MAX(filled_at) AS m FROM fills GROUP BY equipment_label ORDER BY m DESC LIMIT 24`),
  ]);
  return {
    customers: customers.rows,
    sites: sites.rows,
    equipment: equipment.rows,
    recentEquipment: recentEq.rows.map((r) => r.equipment_label),
  };
}

function validateFill(body) {
  const errors = [];
  const customerId = parseInt(body.customer_id, 10);
  if (!customerId) errors.push('Pick a customer.');
  const siteId = body.site_id ? parseInt(body.site_id, 10) : null;
  if (body.site_id && !siteId) errors.push('Invalid site.');

  let fuelType = String(body.fuel_type || '').trim();
  if (fuelType === '__custom') fuelType = String(body.fuel_type_custom || '').trim();
  if (!fuelType) errors.push('Pick a fuel type.');
  if (fuelType.length > 60) errors.push('Fuel type is too long.');

  const gallons = Number(String(body.gallons || '').replace(/,/g, ''));
  if (!Number.isFinite(gallons) || gallons <= 0) errors.push('Gallons must be a positive number.');
  if (gallons >= 100000) errors.push('Gallons looks too large.');

  let filledAt = parseLocalDateTime(String(body.filled_at || ''));
  if (!filledAt) {
    if (!String(body.filled_at || '').trim()) filledAt = new Date(); // empty = now
    else errors.push('Enter a valid date and time.');
  }

  const equipmentLabel = String(body.equipment_label || '').trim().slice(0, 120);
  if (!equipmentLabel) errors.push('Enter the equipment (e.g. "Gen 3").');

  const notes = String(body.notes || '').trim().slice(0, 2000);
  return { errors, data: { customerId, siteId, fuelType, gallons, filledAt, equipmentLabel, notes } };
}

// --- Dashboard ---
router.get('/', async (req, res) => {
  const driverId = res.locals.user.id;
  const today = todayStr();
  const [jobs, recent, stats] = await Promise.all([
    pool.query(
      `SELECT j.*, c.name AS customer_name, s.name AS site_name
       FROM jobs j JOIN customers c ON c.id = j.customer_id
       LEFT JOIN sites s ON s.id = j.site_id
       WHERE j.driver_id = $1 AND j.scheduled_date >= $2 AND j.status IN ('scheduled','in_progress')
       ORDER BY j.scheduled_date, j.window_start NULLS LAST LIMIT 10`,
      [driverId, today]
    ),
    pool.query(
      `SELECT f.*, c.name AS customer_name
       FROM fills f JOIN customers c ON c.id = f.customer_id
       WHERE f.driver_id = $1 ORDER BY f.filled_at DESC LIMIT 8`,
      [driverId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(gallons),0)::float AS gal
       FROM fills WHERE driver_id = $1 AND filled_at >= date_trunc('day', NOW())`,
      [driverId]
    ),
  ]);
  res.render('driver/dashboard', { jobs: jobs.rows, recent: recent.rows, stats: stats.rows[0] });
});

// --- My schedule ---
router.get('/schedule', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT j.*, c.name AS customer_name, s.name AS site_name, s.address AS site_address
     FROM jobs j JOIN customers c ON c.id = j.customer_id
     LEFT JOIN sites s ON s.id = j.site_id
     WHERE j.driver_id = $1 AND j.scheduled_date >= $2
     ORDER BY j.scheduled_date, j.window_start NULLS LAST`,
    [res.locals.user.id, todayStr()]
  );
  res.render('driver/schedule', { jobs: rows });
});

// --- My fills ---
router.get('/fills', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.*, c.name AS customer_name, s.name AS site_name
     FROM fills f JOIN customers c ON c.id = f.customer_id
     LEFT JOIN sites s ON s.id = f.site_id
     WHERE f.driver_id = $1 AND f.filled_at >= NOW() - INTERVAL '90 days'
     ORDER BY f.filled_at DESC`,
    [res.locals.user.id]
  );
  res.render('driver/fills', { fills: rows });
});

// --- New fill form ---
router.get('/fills/new', async (req, res) => {
  const lookups = await formLookups();
  res.render('driver/fill_form', {
    lookups, errors: [], form: { filled_at: toInputDateTime(new Date()) }, editing: null,
  });
});

router.post('/fills', requireCsrf, async (req, res) => {
  const { errors, data } = validateFill(req.body);
  if (errors.length) {
    const lookups = await formLookups();
    return res.status(400).render('driver/fill_form', { lookups, errors, form: req.body, editing: null });
  }
  // Verify customer/site exist and are active (and site belongs to customer).
  const cust = await pool.query('SELECT id FROM customers WHERE id = $1 AND active', [data.customerId]);
  if (!cust.rows.length) {
    const lookups = await formLookups();
    return res.status(400).render('driver/fill_form', { lookups, errors: ['Unknown customer.'], form: req.body, editing: null });
  }
  if (data.siteId) {
    const site = await pool.query(
      'SELECT id FROM sites WHERE id = $1 AND customer_id = $2 AND active', [data.siteId, data.customerId]);
    if (!site.rows.length) {
      const lookups = await formLookups();
      return res.status(400).render('driver/fill_form', { lookups, errors: ['That site does not belong to the chosen customer.'], form: req.body, editing: null });
    }
  }
  await pool.query(
    `INSERT INTO fills (filled_at, customer_id, site_id, equipment_label, fuel_type, gallons, driver_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [data.filledAt, data.customerId, data.siteId, data.equipmentLabel, data.fuelType, data.gallons, res.locals.user.id, data.notes || null]
  );
  res.redirect('/driver/fills?saved=1');
});

// --- Edit own fill ---
router.get('/fills/:id/edit', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM fills WHERE id = $1 AND driver_id = $2', [req.params.id, res.locals.user.id]);
  if (!rows.length) return res.status(404).send('Fill not found.');
  const lookups = await formLookups();
  const f = rows[0];
  res.render('driver/fill_form', {
    lookups, errors: [],
    form: {
      customer_id: String(f.customer_id), site_id: f.site_id ? String(f.site_id) : '',
      equipment_label: f.equipment_label,
      fuel_type: FUEL_TYPES.includes(f.fuel_type) ? f.fuel_type : '__custom',
      fuel_type_custom: FUEL_TYPES.includes(f.fuel_type) ? '' : f.fuel_type,
      gallons: f.gallons, filled_at: toInputDateTime(f.filled_at), notes: f.notes || '',
    },
    editing: f,
  });
});

router.post('/fills/:id/edit', requireCsrf, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM fills WHERE id = $1 AND driver_id = $2', [req.params.id, res.locals.user.id]);
  if (!rows.length) return res.status(404).send('Fill not found.');
  const { errors, data } = validateFill(req.body);
  if (errors.length) {
    const lookups = await formLookups();
    return res.status(400).render('driver/fill_form', { lookups, errors, form: req.body, editing: rows[0] });
  }
  await pool.query(
    `UPDATE fills SET filled_at=$1, customer_id=$2, site_id=$3, equipment_label=$4,
     fuel_type=$5, gallons=$6, notes=$7, updated_at=NOW() WHERE id=$8`,
    [data.filledAt, data.customerId, data.siteId, data.equipmentLabel, data.fuelType, data.gallons, data.notes || null, req.params.id]
  );
  res.redirect('/driver/fills?saved=1');
});

router.post('/fills/:id/delete', requireCsrf, async (req, res) => {
  await pool.query('DELETE FROM fills WHERE id = $1 AND driver_id = $2', [req.params.id, res.locals.user.id]);
  res.redirect('/driver/fills?deleted=1');
});

module.exports = router;
