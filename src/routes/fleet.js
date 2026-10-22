'use strict';
// Fleet units: the company's own trailers / tankers / trucks, looked up by
// unit number. Every logged-in user (drivers included) can search units and
// view/download their paperwork; only admins can add or edit units, upload or
// delete paperwork, and record inspections. Annual-inspection due dates drive
// the "Inspections due" reminder panel on the fleet list.
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireLogin, requireAdmin, requireCsrf, currentUser } = require('../middleware');

const router = express.Router();

const UNIT_TYPES = ['Trailer', 'Tanker', 'Truck', 'Van', 'Other'];
const DOC_CATEGORIES = ['Registration', 'Insurance', 'Annual inspection', 'Title', 'Lease', 'Maintenance', 'Other'];

// Dates are selected as text (YYYY-MM-DD) so a DATE column never shifts a day
// through JS timezone conversion.
const UNIT_COLS = `id, unit_number, unit_type, description, make, model_year, vin, plate,
  tire_size, tire_brand, axles, capacity_gallons,
  to_char(last_inspection_date, 'YYYY-MM-DD') AS last_inspection_date,
  to_char(inspection_due_date, 'YYYY-MM-DD') AS inspection_due_date,
  (inspection_due_date - CURRENT_DATE) AS days_until_due,
  notes, active, created_at, updated_at`;

function addOneYear(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y + 1, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

const trimOrNull = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
};
const intOrNull = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const numOrNull = (v) => {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
};
const dateOrNull = (v) => {
  const s = trimOrNull(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

function parseUnitForm(b) {
  const unit = {
    unit_number: trimOrNull(b.unit_number),
    unit_type: UNIT_TYPES.includes(b.unit_type) ? b.unit_type : 'Trailer',
    description: trimOrNull(b.description),
    make: trimOrNull(b.make),
    model_year: intOrNull(b.model_year),
    vin: trimOrNull(b.vin),
    plate: trimOrNull(b.plate),
    tire_size: trimOrNull(b.tire_size),
    tire_brand: trimOrNull(b.tire_brand),
    axles: intOrNull(b.axles),
    capacity_gallons: numOrNull(b.capacity_gallons),
    last_inspection_date: dateOrNull(b.last_inspection_date),
    inspection_due_date: dateOrNull(b.inspection_due_date),
    notes: trimOrNull(b.notes),
  };
  // The reminder: a last-inspection date with no explicit due date means the
  // next annual is due one year later.
  if (!unit.inspection_due_date && unit.last_inspection_date) {
    unit.inspection_due_date = addOneYear(unit.last_inspection_date);
  }
  return unit;
}

const UNIT_INSERT = `INSERT INTO fleet_units
  (unit_number, unit_type, description, make, model_year, vin, plate, tire_size, tire_brand,
   axles, capacity_gallons, last_inspection_date, inspection_due_date, notes)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`;

const UNIT_UPDATE = `UPDATE fleet_units SET
  unit_number=$1, unit_type=$2, description=$3, make=$4, model_year=$5, vin=$6, plate=$7,
  tire_size=$8, tire_brand=$9, axles=$10, capacity_gallons=$11, last_inspection_date=$12,
  inspection_due_date=$13, notes=$14, updated_at=NOW() WHERE id=$15`;

const unitParams = (u) => [u.unit_number, u.unit_type, u.description, u.make, u.model_year, u.vin,
  u.plate, u.tire_size, u.tire_brand, u.axles, u.capacity_gallons, u.last_inspection_date,
  u.inspection_due_date, u.notes];

async function getUnit(id) {
  const { rows } = await pool.query(`SELECT ${UNIT_COLS} FROM fleet_units WHERE id = $1`, [id]);
  return rows[0] || null;
}

// --- paperwork uploads (PDF or photo of the document) ---
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 }, // 15 MB per document, max 5 at once
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (ok) return cb(null, true);
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  },
});

// Defense in depth: the client can spoof mimetypes, so sniff the magic bytes too.
function sniffDocMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function uploadDocs(req, res, next) {
  docUpload.array('documents', 5)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'One of those files is over 15 MB — paperwork uploads max out at 15 MB each.'
        : 'Those files could not be accepted — paperwork must be a PDF or a photo (JPG, PNG, or WebP), up to 5 files at a time.';
      return res.redirect(`/fleet/units/${req.params.id}?tab=paperwork&error=${encodeURIComponent(msg)}`);
    }
    return next();
  });
}

// Same upload, but for the Add Unit form (no unit exists yet to redirect to).
function uploadDocsForCreate(req, res, next) {
  docUpload.array('documents', 5)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'One of those files is over 15 MB — paperwork uploads max out at 15 MB each. The unit was not added.'
        : 'Those files could not be accepted — paperwork must be a PDF or a photo (JPG, PNG, or WebP), up to 5 files at a time. The unit was not added.';
      return res.redirect(`/fleet/new?error=${encodeURIComponent(msg)}`);
    }
    return next();
  });
}

// Saves the valid files from an upload as a unit's paperwork. Returns counts.
async function saveDocuments(unitId, files, category, userId) {
  let saved = 0;
  let rejected = 0;
  for (const f of files || []) {
    const sniffed = sniffDocMime(f.buffer);
    if (!sniffed || f.size > 15 * 1024 * 1024) { rejected += 1; continue; }
    await pool.query(
      `INSERT INTO fleet_documents (unit_id, category, filename, mimetype, size_bytes, data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [unitId, category, f.originalname.slice(0, 200), sniffed, f.size, f.buffer, userId]
    );
    saved += 1;
  }
  return { saved, rejected };
}

// --- list + search + inspection reminders ---
router.get('/', requireLogin, async (req, res) => {
  const user = currentUser(req);
  const q = trimOrNull(req.query.q) || '';
  const showRetired = user.role === 'admin' && req.query.show === 'retired';
  const params = [];
  let where = showRetired ? 'WHERE NOT active' : 'WHERE active';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (unit_number ILIKE $1 OR vin ILIKE $1 OR plate ILIKE $1
                    OR make ILIKE $1 OR description ILIKE $1)`;
  }
  const unitsRes = await pool.query(
    `SELECT id, unit_number, unit_type, description, make, model_year, vin, plate,
            tire_size, tire_brand, axles, capacity_gallons,
            to_char(last_inspection_date, 'YYYY-MM-DD') AS last_inspection_date,
            to_char(inspection_due_date, 'YYYY-MM-DD') AS inspection_due_date,
            (inspection_due_date - CURRENT_DATE) AS days_until_due,
            notes, active, created_at, updated_at
       FROM fleet_units ${where} ORDER BY unit_number`,
    params
  );
  const countsRes = await pool.query(
    'SELECT unit_id, COUNT(*)::int AS c FROM fleet_documents GROUP BY unit_id'
  );
  const countByUnit = new Map(countsRes.rows.map((r) => [r.unit_id, r.c]));
  const units = unitsRes.rows.map((u) => ({ ...u, doc_count: countByUnit.get(u.id) || 0 }));
  const dueRes = await pool.query(
    `SELECT id, unit_number, unit_type,
            to_char(inspection_due_date, 'YYYY-MM-DD') AS inspection_due_date,
            (inspection_due_date - CURRENT_DATE) AS days_until_due
       FROM fleet_units
      WHERE active AND inspection_due_date IS NOT NULL
        AND inspection_due_date <= CURRENT_DATE + INTERVAL '30 days'
      ORDER BY inspection_due_date`
  );
  res.render('fleet/list', {
    title: 'Fleet Equipment',
    units, due: dueRes.rows, q, showRetired,
    isAdmin: user.role === 'admin',
    notice: req.query.notice || null, error: req.query.error || null,
  });
});

// --- add a unit (admin); paperwork can be attached in the same step ---
router.get('/new', requireAdmin, (req, res) => {
  res.render('fleet/form', {
    title: 'Add Fleet Unit', unit: null, error: req.query.error || null,
    unitTypes: UNIT_TYPES, categories: DOC_CATEGORIES, action: '/fleet',
  });
});

router.post('/', requireAdmin, uploadDocsForCreate, requireCsrf, async (req, res) => {
  const unit = parseUnitForm(req.body);
  const fileNote = (req.files && req.files.length)
    ? ' Any files you picked were not saved — attach them from the unit’s Paperwork tab.'
    : '';
  if (!unit.unit_number) {
    return res.status(400).render('fleet/form', {
      title: 'Add Fleet Unit', unit, error: 'Unit number is required.' + fileNote,
      unitTypes: UNIT_TYPES, categories: DOC_CATEGORIES, action: '/fleet',
    });
  }
  try {
    const { rows } = await pool.query(UNIT_INSERT, unitParams(unit));
    const unitId = rows[0].id;
    if (req.files && req.files.length) {
      const category = DOC_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
      const { saved, rejected } = await saveDocuments(unitId, req.files, category, currentUser(req).id);
      const note = saved
        ? `Unit ${unit.unit_number} added with ${saved} document${saved === 1 ? '' : 's'}.${rejected ? ` ${rejected} file(s) were skipped (not a PDF or photo).` : ''}`
        : `Unit ${unit.unit_number} added, but no documents were saved — the files must be PDFs or photos (JPG, PNG, WebP).`;
      return res.redirect(`/fleet/units/${unitId}?tab=paperwork&${saved ? 'notice' : 'error'}=${encodeURIComponent(note)}`);
    }
    return res.redirect(`/fleet/units/${unitId}?notice=${encodeURIComponent(`Unit ${unit.unit_number} added.`)}`);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('fleet/form', {
        title: 'Add Fleet Unit', unit,
        error: `Unit number "${unit.unit_number}" is already in use — pick the unit from the list to edit it.` + fileNote,
        unitTypes: UNIT_TYPES, categories: DOC_CATEGORIES, action: '/fleet',
      });
    }
    throw err;
  }
});

// --- unit detail (tabs: overview / specs / paperwork / inspection) ---
router.get('/units/:id', requireLogin, async (req, res) => {
  const user = currentUser(req);
  const unit = await getUnit(req.params.id);
  if (!unit || (!unit.active && user.role !== 'admin')) return res.status(404).send('Unit not found.');
  const { rows: docs } = await pool.query(
    `SELECT d.id, d.category, d.filename, d.mimetype, d.size_bytes, d.created_at, u.name AS uploader
       FROM fleet_documents d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.unit_id = $1 ORDER BY d.category, d.created_at DESC`,
    [unit.id]
  );
  const tab = ['overview', 'specs', 'paperwork', 'inspection'].includes(req.query.tab) ? req.query.tab : 'overview';
  res.render('fleet/detail', {
    title: `Unit ${unit.unit_number}`, unit, docs, tab,
    isAdmin: user.role === 'admin', categories: DOC_CATEGORIES,
    notice: req.query.notice || null, error: req.query.error || null,
  });
});

// --- edit a unit (admin) ---
router.get('/units/:id/edit', requireAdmin, async (req, res) => {
  const unit = await getUnit(req.params.id);
  if (!unit) return res.status(404).send('Unit not found.');
  res.render('fleet/form', {
    title: `Edit Unit ${unit.unit_number}`, unit, error: null,
    unitTypes: UNIT_TYPES, action: `/fleet/units/${unit.id}/edit`,
  });
});

router.post('/units/:id/edit', requireAdmin, requireCsrf, async (req, res) => {
  const existing = await getUnit(req.params.id);
  if (!existing) return res.status(404).send('Unit not found.');
  const unit = parseUnitForm(req.body);
  if (!unit.unit_number) {
    return res.status(400).render('fleet/form', {
      title: `Edit Unit ${existing.unit_number}`, unit: { ...unit, id: existing.id },
      error: 'Unit number is required.', unitTypes: UNIT_TYPES, categories: DOC_CATEGORIES,
      action: `/fleet/units/${existing.id}/edit`,
    });
  }
  try {
    await pool.query(UNIT_UPDATE, [...unitParams(unit), existing.id]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('fleet/form', {
        title: `Edit Unit ${existing.unit_number}`, unit: { ...unit, id: existing.id },
        error: `Unit number "${unit.unit_number}" is already in use by another unit.`,
        unitTypes: UNIT_TYPES, categories: DOC_CATEGORIES, action: `/fleet/units/${existing.id}/edit`,
      });
    }
    throw err;
  }
  return res.redirect(`/fleet/units/${existing.id}?notice=${encodeURIComponent('Unit saved.')}`);
});

// --- retire / restore (admin) ---
router.post('/units/:id/retire', requireAdmin, requireCsrf, async (req, res) => {
  await pool.query('UPDATE fleet_units SET active = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
  res.redirect('/fleet?notice=' + encodeURIComponent('Unit retired. It no longer shows for drivers; its paperwork is kept.'));
});

router.post('/units/:id/restore', requireAdmin, requireCsrf, async (req, res) => {
  await pool.query('UPDATE fleet_units SET active = TRUE, updated_at = NOW() WHERE id = $1', [req.params.id]);
  res.redirect(`/fleet/units/${req.params.id}?notice=` + encodeURIComponent('Unit restored to active service.'));
});

// --- record an annual inspection (admin): sets last date, due = +1 year ---
router.post('/units/:id/inspection', requireAdmin, requireCsrf, async (req, res) => {
  const unit = await getUnit(req.params.id);
  if (!unit) return res.status(404).send('Unit not found.');
  const date = dateOrNull(req.body.inspection_date);
  if (!date) {
    return res.redirect(`/fleet/units/${unit.id}?tab=inspection&error=${encodeURIComponent('Pick the inspection date first.')}`);
  }
  await pool.query(
    'UPDATE fleet_units SET last_inspection_date = $1, inspection_due_date = $2, updated_at = NOW() WHERE id = $3',
    [date, addOneYear(date), unit.id]
  );
  return res.redirect(`/fleet/units/${unit.id}?tab=inspection&notice=${encodeURIComponent(`Inspection recorded — next annual due ${addOneYear(date)}.`)}`);
});

// --- paperwork: upload (admin), view/download (any logged-in user), delete (admin) ---
router.post('/units/:id/documents', requireAdmin, uploadDocs, requireCsrf, async (req, res) => {
  const unit = await getUnit(req.params.id);
  if (!unit) return res.status(404).send('Unit not found.');
  const category = DOC_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  const { saved, rejected } = await saveDocuments(unit.id, req.files, category, currentUser(req).id);
  const note = saved
    ? `${saved} document${saved === 1 ? '' : 's'} added to unit ${unit.unit_number}.${rejected ? ` ${rejected} file(s) were skipped (not a PDF or photo).` : ''}`
    : 'No documents were saved — the files must be PDFs or photos (JPG, PNG, WebP).';
  const key = saved ? 'notice' : 'error';
  return res.redirect(`/fleet/units/${unit.id}?tab=paperwork&${key}=${encodeURIComponent(note)}`);
});

router.get('/units/:id/documents/:docId', requireLogin, async (req, res) => {
  const user = currentUser(req);
  const { rows } = await pool.query(
    `SELECT d.filename, d.mimetype, d.data, u.active AS unit_active
       FROM fleet_documents d JOIN fleet_units u ON u.id = d.unit_id
      WHERE d.id = $1 AND d.unit_id = $2`,
    [req.params.docId, req.params.id]
  );
  const doc = rows[0];
  if (!doc || (!doc.unit_active && user.role !== 'admin')) return res.status(404).send('Document not found.');
  const safeName = String(doc.filename).replace(/["\r\n]/g, '_');
  res.setHeader('Content-Type', doc.mimetype);
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  return res.send(doc.data);
});

router.post('/units/:id/documents/:docId/delete', requireAdmin, requireCsrf, async (req, res) => {
  await pool.query('DELETE FROM fleet_documents WHERE id = $1 AND unit_id = $2', [req.params.docId, req.params.id]);
  res.redirect(`/fleet/units/${req.params.id}?tab=paperwork&notice=${encodeURIComponent('Document deleted.')}`);
});

module.exports = router;
