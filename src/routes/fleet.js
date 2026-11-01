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

// Preset kinds of service a schedule can track or a record can log. Custom
// types are allowed too (typed in), these are just the quick picks.
const SERVICE_TYPES = ['Oil change', 'Tire rotation', 'Air filter', 'Fuel filter',
  'Transmission service', 'Coolant service', 'Brake service', 'Grease / lubrication',
  'PM inspection', 'DPF / DEF service', 'Battery service', 'Alignment', 'Repair', 'Other'];

// Dates are selected as text (YYYY-MM-DD) so a DATE column never shifts a day
// through JS timezone conversion.
const UNIT_COLS = `id, unit_number, unit_type, description, make, model_year, vin, plate,
  tire_size, tire_brand, axles, capacity_gallons,
  to_char(last_inspection_date, 'YYYY-MM-DD') AS last_inspection_date,
  to_char(inspection_due_date, 'YYYY-MM-DD') AS inspection_due_date,
  (inspection_due_date - CURRENT_DATE) AS days_until_due,
  current_miles, current_hours,
  to_char(reading_date, 'YYYY-MM-DD') AS reading_date,
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

// --- maintenance schedules + service records (49 CFR 396.3 recordkeeping) ---
const SCHED_COLS = `id, unit_id, service_type, interval_days, interval_miles, interval_hours,
  to_char(last_done_date, 'YYYY-MM-DD') AS last_done_date, last_done_miles, last_done_hours,
  notes, created_at, updated_at`;
const RECORD_COLS = `id, unit_id, schedule_id,
  to_char(service_date, 'YYYY-MM-DD') AS service_date, service_type, description,
  odometer_miles, engine_hours, performed_by, cost,
  to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, next_due_miles, next_due_hours,
  recorded_by, created_at`;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function todayUtcStr() { return new Date().toISOString().slice(0, 10); }
function daysUntil(dateStr) {
  const a = Date.parse(`${dateStr}T00:00:00Z`);
  const b = Date.parse(`${todayUtcStr()}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}

// Where one schedule stands against the unit's current readings. A schedule
// can run on any mix of days / miles / hours; the most urgent basis that can
// be computed decides the state. "Due soon" = within 30 days, 1,000 miles,
// or 50 engine hours. A basis with an interval but no last-done baseline (or
// no current reading) simply can't be judged yet.
function scheduleStatus(s, unit) {
  const st = { nextDueDate: null, nextDueMiles: null, nextDueHours: null,
    daysLeft: null, milesLeft: null, hoursLeft: null, state: 'unknown' };
  let judged = 0;
  let worst = 'ok';
  const judge = (left, soonAt) => {
    judged += 1;
    if (left < 0) worst = 'overdue';
    else if (left <= soonAt && worst !== 'overdue') worst = 'due';
  };
  if (s.interval_days && s.last_done_date) {
    st.nextDueDate = addDays(s.last_done_date, s.interval_days);
    st.daysLeft = daysUntil(st.nextDueDate);
    judge(st.daysLeft, 30);
  }
  if (s.interval_miles && s.last_done_miles != null) {
    st.nextDueMiles = s.last_done_miles + s.interval_miles;
    if (unit.current_miles != null) {
      st.milesLeft = st.nextDueMiles - unit.current_miles;
      judge(st.milesLeft, 1000);
    }
  }
  if (s.interval_hours && s.last_done_hours != null) {
    st.nextDueHours = Number(s.last_done_hours) + Number(s.interval_hours);
    if (unit.current_hours != null) {
      st.hoursLeft = Math.round((st.nextDueHours - Number(unit.current_hours)) * 10) / 10;
      judge(st.hoursLeft, 50);
    }
  }
  if (judged) st.state = worst;
  return st;
}

async function getSchedules(unitId) {
  const { rows } = await pool.query(
    `SELECT ${SCHED_COLS} FROM fleet_maintenance_schedules WHERE unit_id = $1 ORDER BY service_type`, [unitId]);
  return rows;
}

async function getRecords(unitId, limit) {
  const lim = limit ? ` LIMIT ${parseInt(limit, 10)}` : '';
  const { rows } = await pool.query(
    `SELECT r.id, r.unit_id, r.schedule_id,
            to_char(r.service_date, 'YYYY-MM-DD') AS service_date, r.service_type, r.description,
            r.odometer_miles, r.engine_hours, r.performed_by, r.cost,
            to_char(r.next_due_date, 'YYYY-MM-DD') AS next_due_date, r.next_due_miles, r.next_due_hours,
            r.recorded_by, r.created_at, u.name AS recorder
       FROM fleet_service_records r LEFT JOIN users u ON u.id = r.recorded_by
      WHERE r.unit_id = $1 ORDER BY r.service_date DESC, r.id DESC${lim}`, [unitId]);
  return rows;
}

// After a service is recorded: roll the matching schedule's last-done values
// forward (only when the record is the newest for that type, and only the
// readings the record actually carries) and bump the unit's current readings.
async function syncAfterRecord(unit, rec) {
  const { rows } = await pool.query(
    `SELECT ${SCHED_COLS} FROM fleet_maintenance_schedules WHERE unit_id = $1 AND service_type = $2`,
    [unit.id, rec.service_type]);
  const sched = rows[0] || null;
  let nextDue = { date: null, miles: null, hours: null };
  if (sched) {
    const isNewest = !sched.last_done_date || rec.service_date >= sched.last_done_date;
    if (isNewest) {
      const lastMiles = rec.odometer_miles != null ? rec.odometer_miles : sched.last_done_miles;
      const lastHours = rec.engine_hours != null ? rec.engine_hours : sched.last_done_hours;
      await pool.query(
        `UPDATE fleet_maintenance_schedules
            SET last_done_date = $1, last_done_miles = $2, last_done_hours = $3, updated_at = NOW()
          WHERE id = $4`,
        [rec.service_date, lastMiles, lastHours, sched.id]);
      if (sched.interval_days) nextDue.date = addDays(rec.service_date, sched.interval_days);
      if (sched.interval_miles && lastMiles != null) nextDue.miles = lastMiles + sched.interval_miles;
      if (sched.interval_hours && lastHours != null) {
        nextDue.hours = Math.round((Number(lastHours) + Number(sched.interval_hours)) * 10) / 10;
      }
    } else if (sched.last_done_date) {
      if (sched.interval_days) nextDue.date = addDays(sched.last_done_date, sched.interval_days);
      if (sched.interval_miles && sched.last_done_miles != null) nextDue.miles = sched.last_done_miles + sched.interval_miles;
      if (sched.interval_hours && sched.last_done_hours != null) {
        nextDue.hours = Math.round((Number(sched.last_done_hours) + Number(sched.interval_hours)) * 10) / 10;
      }
    }
    await pool.query(
      `UPDATE fleet_service_records SET schedule_id = $1, next_due_date = $2, next_due_miles = $3, next_due_hours = $4
        WHERE id = $5`,
      [sched.id, nextDue.date, nextDue.miles, nextDue.hours, rec.id]);
  }
  const newMiles = rec.odometer_miles != null && (unit.current_miles == null || rec.odometer_miles > unit.current_miles)
    ? rec.odometer_miles : unit.current_miles;
  const newHours = rec.engine_hours != null && (unit.current_hours == null || Number(rec.engine_hours) > Number(unit.current_hours))
    ? rec.engine_hours : unit.current_hours;
  if (newMiles !== unit.current_miles || newHours !== unit.current_hours) {
    await pool.query(
      'UPDATE fleet_units SET current_miles = $1, current_hours = $2, reading_date = $3, updated_at = NOW() WHERE id = $4',
      [newMiles, newHours, rec.service_date, unit.id]);
  }
  return sched;
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
  // Maintenance standing per unit: worst schedule state + anything overdue
  // or due soon for the reminder panel.
  const schedRes = await pool.query(
    `SELECT s.id, s.unit_id, s.service_type, s.interval_days, s.interval_miles, s.interval_hours,
            to_char(s.last_done_date, 'YYYY-MM-DD') AS last_done_date, s.last_done_miles, s.last_done_hours,
            s.notes, s.created_at, s.updated_at,
            fu.current_miles, fu.current_hours, fu.unit_number, fu.unit_type, fu.active AS unit_active
       FROM fleet_maintenance_schedules s JOIN fleet_units fu ON fu.id = s.unit_id`);
  const maintByUnit = new Map();
  const maintDue = [];
  for (const s of schedRes.rows) {
    const st = scheduleStatus(s, s);
    const rank = { overdue: 3, due: 2, ok: 1, unknown: 0 }[st.state];
    const cur = maintByUnit.get(s.unit_id);
    if (!cur || rank > cur.rank) maintByUnit.set(s.unit_id, { rank, state: st.state });
    if (s.unit_active && (st.state === 'overdue' || st.state === 'due')) {
      maintDue.push({ unit_id: s.unit_id, unit_number: s.unit_number, unit_type: s.unit_type,
        service_type: s.service_type, ...st });
    }
  }
  maintDue.sort((a, b) => {
    const r = (x) => (x.state === 'overdue' ? 0 : 1);
    if (r(a) !== r(b)) return r(a) - r(b);
    const da = a.daysLeft == null ? Infinity : a.daysLeft;
    const db = b.daysLeft == null ? Infinity : b.daysLeft;
    return da - db;
  });
  const units = unitsRes.rows.map((u) => ({
    ...u, doc_count: countByUnit.get(u.id) || 0,
    maint_state: (maintByUnit.get(u.id) || {}).state || null,
  }));
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
    units, due: dueRes.rows, maintDue, q, showRetired,
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
  const schedules = (await getSchedules(unit.id)).map((s) => ({ ...s, status: scheduleStatus(s, unit) }));
  const records = await getRecords(unit.id, 100);
  const overdueCount = schedules.filter((s) => s.status.state === 'overdue').length;
  const tab = ['overview', 'specs', 'paperwork', 'inspection', 'maintenance'].includes(req.query.tab) ? req.query.tab : 'overview';
  res.render('fleet/detail', {
    title: `Unit ${unit.unit_number}`, unit, docs, tab,
    schedules, records, overdueCount, serviceTypes: SERVICE_TYPES,
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

// --- maintenance: readings, schedules, service records, printable history ---
router.post('/units/:id/readings', requireAdmin, requireCsrf, async (req, res) => {
  const unit = await getUnit(req.params.id);
  if (!unit) return res.status(404).send('Unit not found.');
  const miles = intOrNull(req.body.current_miles);
  const hours = numOrNull(req.body.current_hours);
  if (miles == null && hours == null) {
    return res.redirect(`/fleet/units/${unit.id}?tab=maintenance&error=${encodeURIComponent('Enter an odometer reading, an hour reading, or both.')}`);
  }
  await pool.query(
    'UPDATE fleet_units SET current_miles = $1, current_hours = $2, reading_date = CURRENT_DATE, updated_at = NOW() WHERE id = $3',
    [miles != null ? miles : unit.current_miles, hours != null ? hours : unit.current_hours, unit.id]
  );
  return res.redirect(`/fleet/units/${unit.id}?tab=maintenance&notice=${encodeURIComponent('Current readings saved.')}`);
});

// Create or update the schedule for one kind of service on this unit. The
// last-done fields are the baseline the intervals count from (set them when
// the service was last done before tracking started here).
router.post('/units/:id/schedules', requireAdmin, requireCsrf, async (req, res) => {
  const unit = await getUnit(req.params.id);
  if (!unit) return res.status(404).send('Unit not found.');
  const back = (key, msg) => res.redirect(`/fleet/units/${unit.id}?tab=maintenance&${key}=${encodeURIComponent(msg)}`);
  const type = trimOrNull(req.body.service_type_custom) || trimOrNull(req.body.service_type);
  if (!type) return back('error', 'Pick or type the kind of service to track.');
  const sched = {
    interval_days: intOrNull(req.body.interval_days),
    interval_miles: intOrNull(req.body.interval_miles),
    interval_hours: numOrNull(req.body.interval_hours),
    last_done_date: dateOrNull(req.body.last_done_date),
    last_done_miles: intOrNull(req.body.last_done_miles),
    last_done_hours: numOrNull(req.body.last_done_hours),
    notes: trimOrNull(req.body.notes),
  };
  if (!sched.interval_days && !sched.interval_miles && !sched.interval_hours) {
    return back('error', 'Give the schedule at least one interval — days, miles, or hours.');
  }
  await pool.query(
    `INSERT INTO fleet_maintenance_schedules
       (unit_id, service_type, interval_days, interval_miles, interval_hours, last_done_date, last_done_miles, last_done_hours, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (unit_id, service_type) DO UPDATE SET
       interval_days = EXCLUDED.interval_days, interval_miles = EXCLUDED.interval_miles,
       interval_hours = EXCLUDED.interval_hours, last_done_date = EXCLUDED.last_done_date,
       last_done_miles = EXCLUDED.last_done_miles, last_done_hours = EXCLUDED.last_done_hours,
       notes = EXCLUDED.notes, updated_at = NOW()`,
    [unit.id, type.slice(0, 80), sched.interval_days, sched.interval_miles, sched.interval_hours,
     sched.last_done_date, sched.last_done_miles, sched.last_done_hours, sched.notes]
  );
  return back('notice', `Schedule saved for ${type}.`);
});

router.post('/units/:id/schedules/:sid/delete', requireAdmin, requireCsrf, async (req, res) => {
  await pool.query('DELETE FROM fleet_maintenance_schedules WHERE id = $1 AND unit_id = $2',
    [req.params.sid, req.params.id]);
  res.redirect(`/fleet/units/${req.params.id}?tab=maintenance&notice=${encodeURIComponent('Schedule removed. Service history is kept.')}`);
});

// Log work actually performed. This is the 396.3 record: date, nature of the
// work, and the unit's identification lives on the unit itself. Logging
// against a scheduled type rolls that schedule's last-done forward.
router.post('/units/:id/service', requireAdmin, requireCsrf, async (req, res) => {
  const unit = await getUnit(req.params.id);
  if (!unit) return res.status(404).send('Unit not found.');
  const back = (key, msg) => res.redirect(`/fleet/units/${unit.id}?tab=maintenance&${key}=${encodeURIComponent(msg)}`);
  const date = dateOrNull(req.body.service_date);
  const type = trimOrNull(req.body.service_type_custom) || trimOrNull(req.body.service_type);
  if (!date) return back('error', 'Pick the date the work was done.');
  if (!type) return back('error', 'Pick or type the kind of service.');
  const { rows } = await pool.query(
    `INSERT INTO fleet_service_records
       (unit_id, service_date, service_type, description, odometer_miles, engine_hours, performed_by, cost, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [unit.id, date, type.slice(0, 80), trimOrNull(req.body.description),
     intOrNull(req.body.odometer_miles), numOrNull(req.body.engine_hours),
     trimOrNull(req.body.performed_by), numOrNull(req.body.cost), currentUser(req).id]
  );
  const rec = { id: rows[0].id, service_date: date, service_type: type.slice(0, 80),
    odometer_miles: intOrNull(req.body.odometer_miles), engine_hours: numOrNull(req.body.engine_hours) };
  await syncAfterRecord(unit, rec);
  return back('notice', `${type} logged for ${date}.`);
});

// Deleting a record re-derives the matching schedule's last-done from the
// newest remaining record of that type (or clears it when none remain).
router.post('/units/:id/service/:rid/delete', requireAdmin, requireCsrf, async (req, res) => {
  const unit = await getUnit(req.params.id);
  if (!unit) return res.status(404).send('Unit not found.');
  const { rows } = await pool.query(
    'SELECT service_type FROM fleet_service_records WHERE id = $1 AND unit_id = $2',
    [req.params.rid, unit.id]);
  if (rows.length) {
    const type = rows[0].service_type;
    await pool.query('DELETE FROM fleet_service_records WHERE id = $1 AND unit_id = $2', [req.params.rid, unit.id]);
    const { rows: newest } = await pool.query(
      `SELECT to_char(service_date, 'YYYY-MM-DD') AS service_date, odometer_miles, engine_hours
         FROM fleet_service_records WHERE unit_id = $1 AND service_type = $2
        ORDER BY service_date DESC, id DESC LIMIT 1`,
      [unit.id, type]);
    await pool.query(
      `UPDATE fleet_maintenance_schedules
          SET last_done_date = $1, last_done_miles = $2, last_done_hours = $3, updated_at = NOW()
        WHERE unit_id = $4 AND service_type = $5`,
      [newest.length ? newest[0].service_date : null,
       newest.length ? newest[0].odometer_miles : null,
       newest.length ? newest[0].engine_hours : null,
       unit.id, type]);
  }
  res.redirect(`/fleet/units/${unit.id}?tab=maintenance&notice=${encodeURIComponent('Service record deleted.')}`);
});

// Printable 396.3 maintenance file for one unit: identification block, the
// schedule of what's due, and the full service history.
router.get('/units/:id/maintenance/print', requireLogin, async (req, res) => {
  const user = currentUser(req);
  const unit = await getUnit(req.params.id);
  if (!unit || (!unit.active && user.role !== 'admin')) return res.status(404).send('Unit not found.');
  const schedules = (await getSchedules(unit.id)).map((s) => ({ ...s, status: scheduleStatus(s, unit) }));
  const records = await getRecords(unit.id, null);
  res.render('fleet/maintenance_print', {
    layout: false, title: `Maintenance file — Unit ${unit.unit_number}`,
    unit, schedules, records,
  });
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
