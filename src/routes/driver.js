'use strict';
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireLogin, requireCsrf } = require('../middleware');
const { FUEL_TYPES, parseLocalDateTime, toInputDateTime, todayStr } = require('../lib');

const router = express.Router();
router.use(requireLogin);

// BOL photos: kept in memory and stored as bytea in Postgres
// (Render's container disk is ephemeral, so disk storage would lose them).
const bolUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 3 }, // 8 MB per photo, max 3 BOL photos
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  },
});

// Defense in depth: the client can spoof mimetypes, so sniff the magic bytes too.
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Wrap multer so upload failures become a friendly form error instead of a
// crash. MUST run before requireCsrf: multer populates req.body (including
// _csrf) from the multipart form.
function bolUploadFields(req, res, next) {
  bolUpload.fields([{ name: 'bol_photos', maxCount: 3 }])(req, res, (err) => {
    req.bolUploadError = err ? (
      err.code === 'LIMIT_FILE_SIZE'
        ? 'One of your BOL photos is larger than 8 MB. Please use a smaller photo and try again.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Attach at most 3 BOL photos, and only JPEG, PNG, or WebP images.'
          : 'There was a problem with your photo upload. Please try again.'
    ) : null;
    next();
  });
}

// Returns { errors, docs } — sanitized BOL documents ready to store.
function validateBolDocs(files) {
  const errors = [];
  const docs = [];
  const list = (files && files.bol_photos) || [];
  for (const f of list) {
    const sniffed = sniffImageMime(f.buffer);
    if (!sniffed || f.size > 8 * 1024 * 1024) {
      errors.push('Each BOL photo must be a JPEG, PNG, or WebP image, 8 MB or smaller.');
      continue;
    }
    docs.push({
      filename: String(f.originalname || 'bol.jpg').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'bol.jpg',
      mimetype: sniffed,
      size: f.size,
      buffer: f.buffer,
    });
  }
  return { errors, docs };
}

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

router.post('/fills', bolUploadFields, requireCsrf, async (req, res) => {
  const { errors, data } = validateFill(req.body);
  const { errors: docErrors, docs: bolDocs } = req.bolUploadError
    ? { errors: [req.bolUploadError], docs: [] }
    : validateBolDocs(req.files);
  const allErrors = errors.concat(docErrors);
  if (allErrors.length) {
    const lookups = await formLookups();
    return res.status(400).render('driver/fill_form', { lookups, errors: allErrors, form: req.body, editing: null });
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
  // Save the fill + its BOL photos atomically: one transaction, never a half-saved fill.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ins } = await client.query(
      `INSERT INTO fills (filled_at, customer_id, site_id, equipment_label, fuel_type, gallons, driver_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [data.filledAt, data.customerId, data.siteId, data.equipmentLabel, data.fuelType, data.gallons, res.locals.user.id, data.notes || null]
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
  res.redirect('/driver/fills?saved=1');
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
    editing: f,
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
    return res.status(400).render('driver/fill_form', { lookups, errors: allErrors, form: req.body, editing: rows[0], bolDocs: docs.rows });
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
  res.redirect('/driver/fills?saved=1');
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
