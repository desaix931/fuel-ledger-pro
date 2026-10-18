'use strict';
// Shared fill-form machinery used by both the driver routes (drivers edit
// their own fills) and the admin routes (office can edit any fill).
const multer = require('multer');
const pool = require('./db');
const { parseLocalDateTime } = require('./lib');

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
  const [customers, sites, equipment, recentEq, recentBol] = await Promise.all([
    pool.query("SELECT id, name FROM customers WHERE active ORDER BY name"),
    pool.query(`SELECT s.id, s.name, s.customer_id, c.name AS customer_name
                FROM sites s JOIN customers c ON c.id = s.customer_id
                WHERE s.active AND c.active ORDER BY c.name, s.name`),
    pool.query(`SELECT e.id, e.label, e.site_id, s.name AS site_name
                FROM equipment e LEFT JOIN sites s ON s.id = e.site_id
                WHERE e.active ORDER BY e.label`),
    pool.query(`SELECT equipment_label, MAX(filled_at) AS m FROM fills GROUP BY equipment_label ORDER BY m DESC LIMIT 24`),
    pool.query(`SELECT bol_number, MAX(filled_at) AS m FROM fills
                WHERE bol_number IS NOT NULL AND bol_number <> ''
                GROUP BY bol_number ORDER BY m DESC LIMIT 10`),
  ]);
  return {
    customers: customers.rows,
    sites: sites.rows,
    equipment: equipment.rows,
    recentEquipment: recentEq.rows.map((r) => r.equipment_label),
    recentBolNumbers: recentBol.rows.map((r) => r.bol_number),
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

  const bolNumber = String(body.bol_number || '').trim().slice(0, 60);

  // GPS captured on the fill form (optional — the fill saves without it).
  const numOrNull = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };
  const latitude = numOrNull(body.latitude);
  const longitude = numOrNull(body.longitude);
  const locationAccuracy = numOrNull(body.location_accuracy);
  if (Number.isNaN(latitude) || (latitude !== null && (latitude < -90 || latitude > 90))) errors.push('Invalid GPS latitude.');
  if (Number.isNaN(longitude) || (longitude !== null && (longitude < -180 || longitude > 180))) errors.push('Invalid GPS longitude.');
  if (Number.isNaN(locationAccuracy) || (locationAccuracy !== null && locationAccuracy < 0)) errors.push('Invalid GPS accuracy.');
  const latOk = latitude !== null && !Number.isNaN(latitude);
  const lngOk = longitude !== null && !Number.isNaN(longitude);
  if (latOk !== lngOk) errors.push('Incomplete GPS location.');
  return { errors, data: { customerId, siteId, fuelType, gallons, filledAt, equipmentLabel, notes,
    bolNumber,
    latitude: Number.isNaN(latitude) ? null : latitude,
    longitude: Number.isNaN(longitude) ? null : longitude,
    locationAccuracy: Number.isNaN(locationAccuracy) ? null : locationAccuracy } };
}

module.exports = { bolUploadFields, validateBolDocs, formLookups, validateFill };

// For admins logging a fill on someone's behalf: the "who did this fill"
// picker. Returns { isAdmin, drivers } for the form view. Drivers get an
// empty list and no picker.
async function driverPickerLocals(user) {
  if (!user || user.role !== 'admin') return { isAdmin: false, drivers: [] };
  const { rows } = await pool.query(
    `SELECT id, name, role FROM users WHERE active ORDER BY role, name`);
  return { isAdmin: true, drivers: rows };
}

// Resolve which user a fill is attributed to. Drivers can only ever log as
// themselves (a tampered driver_id in the body is ignored); admins may pick
// any active user, defaulting to themselves.
async function resolveFillDriver(user, body) {
  if (!user || user.role !== 'admin') return user.id;
  const picked = parseInt(body && body.driver_id, 10);
  if (!picked) return user.id;
  const { rows } = await pool.query('SELECT id FROM users WHERE id = $1 AND active', [picked]);
  return rows.length ? picked : user.id;
}

module.exports.driverPickerLocals = driverPickerLocals;
module.exports.resolveFillDriver = resolveFillDriver;
