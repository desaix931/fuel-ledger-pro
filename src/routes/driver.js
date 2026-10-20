'use strict';
const express = require('express');
const pool = require('../db');
const { requireLogin, requireCsrf } = require('../middleware');
const { FUEL_TYPES, toInputDateTime, todayStr } = require('../lib');
const { bolUploadFields, validateBolDocs, formLookups, validateFill, driverPickerLocals, resolveFillDriver } = require('../fillForm');

// View chrome for the shared fill form (driver URLs). Admins (managers who
// also drive) can use the same form; their cancel/save lands back in the
// admin entry log instead of the driver fill list.
function driverChrome(editId, user) {
  const admin = user && user.role === 'admin';
  return {
    formAction: editId ? '/driver/fills/' + editId + '/edit' : '/driver/fills',
    cancelUrl: admin ? '/admin/entries' : '/driver/fills',
    docBase: '/driver/fills',
  };
}

// Where a successful save lands: admins back to the entry log, drivers to
// their fill list. Fills are always attributed to the logged-in user.
function afterSaveUrl(user) {
  return user.role === 'admin' ? '/admin/entries' : '/driver/fills?saved=1';
}

const router = express.Router();
router.use(requireLogin);

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
    lookups, errors: [], form: {}, editing: null,
    ...driverChrome(null, res.locals.user), ...(await driverPickerLocals(res.locals.user)),
  });
});

router.post('/fills', bolUploadFields, requireCsrf, async (req, res) => {
  const { errors, data } = validateFill(req.body);
  const { errors: docErrors, docs: bolDocs } = req.bolUploadError
    ? { errors: [req.bolUploadError], docs: [] }
    : validateBolDocs(req.files);
  const allErrors = errors.concat(docErrors);
  const picker = await driverPickerLocals(res.locals.user);
  const renderForm = async (errs) => {
    const lookups = await formLookups();
    return res.status(400).render('driver/fill_form', { lookups, errors: errs, form: req.body, editing: null, ...driverChrome(null, res.locals.user), ...picker });
  };
  if (allErrors.length) return renderForm(allErrors);
  // Verify customer/site exist and are active (and site belongs to customer).
  const cust = await pool.query('SELECT id FROM customers WHERE id = $1 AND active', [data.customerId]);
  if (!cust.rows.length) return renderForm(['Unknown customer.']);
  if (data.siteId) {
    const site = await pool.query(
      'SELECT id FROM sites WHERE id = $1 AND customer_id = $2 AND active', [data.siteId, data.customerId]);
    if (!site.rows.length) return renderForm(['That site does not belong to the chosen customer.']);
  }
  // Who the fill is attributed to: the logged-in user, or (admins only) the
  // driver picked on the form.
  const driverId = await resolveFillDriver(res.locals.user, req.body);
  // Save the fill + its BOL photos atomically: one transaction, never a half-saved fill.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ins } = await client.query(
      `INSERT INTO fills (filled_at, customer_id, site_id, equipment_label, fuel_type, gallons, driver_id, notes,
                          latitude, longitude, location_accuracy, bol_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [data.filledAt, data.customerId, data.siteId, data.equipmentLabel, data.fuelType, data.gallons, driverId, data.notes || null,
       data.latitude, data.longitude, data.locationAccuracy, data.bolNumber || null]
    );
    const fillId = ins[0].id;
    for (const d of bolDocs) {
      await client.query(
        `INSERT INTO fill_documents (fill_id, filename, mimetype, size_bytes, data)
         VALUES ($1,$2,$3,$4,$5)`,
        [fillId, d.filename, d.mimetype, d.size, d.buffer]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.redirect(afterSaveUrl(res.locals.user));
});

// Remove a value from the fill form's tap-to-reuse chips (the × on a chip:
// equipment labels and BOL numbers). The fills themselves are untouched —
// the value just stops being offered, until a newer fill uses it again.
// Shared by drivers and office: both use this same form.
router.post('/fills/suggestions/dismiss', requireCsrf, async (req, res) => {
  const kind = req.body.kind === 'bol' ? 'bol' : req.body.kind === 'equipment' ? 'equipment' : null;
  const value = String(req.body.value || '').trim().slice(0, 120);
  if (!kind || !value) return res.status(400).json({ ok: false });
  const col = kind === 'bol' ? 'bol_number' : 'equipment_label';
  const { rows } = await pool.query(`SELECT MAX(filled_at) AS m FROM fills WHERE ${col} = $1`, [value]);
  await pool.query(
    `INSERT INTO hidden_suggestions (kind, value, hidden_through) VALUES ($1, $2, $3)
     ON CONFLICT (kind, value) DO UPDATE SET hidden_through = EXCLUDED.hidden_through`,
    [kind, value, rows.length ? rows[0].m : null]
  );
  res.json({ ok: true });
});

// --- Edit own fill ---
router.get('/fills/:id/edit', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM fills WHERE id = $1 AND driver_id = $2', [req.params.id, res.locals.user.id]);
  if (!rows.length) return res.status(404).send('Fill not found.');
  const lookups = await formLookups();
  const docs = await pool.query(
    'SELECT id, filename, size_bytes FROM fill_documents WHERE fill_id = $1 ORDER BY id', [req.params.id]);
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
    editing: f, ...driverChrome(f.id, res.locals.user),
    bolDocs: docs.rows,
  });
});

router.post('/fills/:id/edit', bolUploadFields, requireCsrf, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM fills WHERE id = $1 AND driver_id = $2', [req.params.id, res.locals.user.id]);
  if (!rows.length) return res.status(404).send('Fill not found.');
  const { errors, data } = validateFill(req.body);
  const { errors: docErrors, docs: bolDocs } = req.bolUploadError
    ? { errors: [req.bolUploadError], docs: [] }
    : validateBolDocs(req.files);
  const existing = await pool.query('SELECT COUNT(*)::int AS n FROM fill_documents WHERE fill_id = $1', [req.params.id]);
  if (existing.rows[0].n + bolDocs.length > 3) {
    docErrors.push('A fill can have at most 3 BOL photos. This fill already has ' +
      existing.rows[0].n + ' — add fewer.');
  }
  const allErrors = errors.concat(docErrors);
  if (allErrors.length) {
    const lookups = await formLookups();
    const docs = await pool.query(
      'SELECT id, filename, size_bytes FROM fill_documents WHERE fill_id = $1 ORDER BY id', [req.params.id]);
    return res.status(400).render('driver/fill_form', { lookups, errors: allErrors, form: req.body, editing: rows[0], ...driverChrome(req.params.id, res.locals.user), bolDocs: docs.rows });
  }
  // Update the fill + append new BOL photos atomically.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fills SET filled_at=$1, customer_id=$2, site_id=$3, equipment_label=$4,
       fuel_type=$5, gallons=$6, notes=$7, updated_at=NOW() WHERE id=$8`,
      [data.filledAt, data.customerId, data.siteId, data.equipmentLabel, data.fuelType, data.gallons, data.notes || null, req.params.id]
    );
    for (const d of bolDocs) {
      await client.query(
        `INSERT INTO fill_documents (fill_id, filename, mimetype, size_bytes, data)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, d.filename, d.mimetype, d.size, d.buffer]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.redirect(afterSaveUrl(res.locals.user));
});

// Serve a BOL photo's bytes. Driver-scoped: only the driver who logged the fill.
router.get('/fills/:id/documents/:docId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.filename, d.mimetype, d.size_bytes, d.data
     FROM fill_documents d JOIN fills f ON f.id = d.fill_id
     WHERE d.id = $1 AND d.fill_id = $2 AND f.driver_id = $3`,
    [req.params.docId, req.params.id, res.locals.user.id]
  );
  if (!rows.length) return res.status(404).send('Document not found.');
  const d = rows[0];
  res.set('Content-Type', d.mimetype);
  res.set('Content-Length', String(d.size_bytes));
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(d.data);
});

router.post('/fills/:id/delete', requireCsrf, async (req, res) => {
  await pool.query('DELETE FROM fills WHERE id = $1 AND driver_id = $2', [req.params.id, res.locals.user.id]);
  res.redirect('/driver/fills?deleted=1');
});

module.exports = router;
