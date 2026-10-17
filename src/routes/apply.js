'use strict';
// Public CDL driver job application. No login required.
// Anti-spam: honeypot field + per-IP rate limiting. No CSRF (no session).
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const pool = require('../db');
const { isEmail } = require('../lib');
const mailer = require('../lib/mailer');

const router = express.Router();

// Document photos: kept in memory and stored as bytea in Postgres
// (Render's container disk is ephemeral, so disk storage would lose them).
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 }, // 8 MB per photo, max 6 photos
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  },
});

const DOC_FIELDS = [
  { name: 'doc_license_front', maxCount: 1 },
  { name: 'doc_license_back', maxCount: 1 },
  { name: 'doc_medical_card', maxCount: 1 },
  { name: 'doc_other', maxCount: 3 },
];

// Defense in depth: the client can spoof mimetypes, so sniff the magic bytes too.
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Friendly error page for multer failures (too big, wrong type, too many files).
function handleDocUpload(req, res, next) {
  docUpload.fields(DOC_FIELDS)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'One of your photos is larger than 8 MB. Please use a smaller photo and try again.'
        : 'One of your uploads was not a valid photo (JPEG, PNG, or WebP). Please check your files and try again.';
      const v = parseBody(req.body || {});
      return res.status(400).render('apply/form', { values: v, errors: [msg + ' (You will need to re-select your photos.)'], endorsements: ENDORSEMENTS, equipment_types: EQUIPMENT_TYPES });
    }
    next();
  });
}

const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,                  // 10 submissions per IP per hour is plenty
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many applications from this address. Please try again in an hour.',
});

const ENDORSEMENTS = ['H', 'N', 'P', 'S', 'T', 'X'];
const EQUIPMENT_TYPES = ['Truck', 'Truck tractor', 'Semitrailer', 'Full trailer', 'Pole trailer', 'Bus', 'Tanker'];
const CDL_CLASSES = ['A', 'B', 'C'];
const YES_NO = ['yes', 'no'];

const str = (v, max) => String(v || '').trim().slice(0, max);
const yn = (v) => (v === 'yes' ? true : v === 'no' ? false : null);
const first = (x) => (Array.isArray(x) ? x[0] : x); // duplicate params: keep the first

const blankAddr = () => ({ street: '', city: '', state: '', zip: '', dates: '' });
const blankEmployer = () => ({ company: '', street: '', city: '', state: '', zip: '', dates: '', reason: '', fmcsr: '', safety: '' });
const blankCmv = () => ({ company: '', city: '', state: '', dates: '', reason: '' });

function emptyValues() {
  return {
    full_name: '', phone: '', email: '', street: '', city: '', state: '', zip: '', dob: '', ssn: '',
    cdl_class: '', cdl_state: '', cdl_number: '', cdl_expiry: '',
    endorsements: [], equipment_types: [],
    years_experience: '', current_employer: '',
    // Flat employer fields kept for back-compat; full data lives in `employers`.
    emp1_company: '', emp1_dates: '', emp1_reason: '',
    emp2_company: '', emp2_dates: '', emp2_reason: '',
    emp3_company: '', emp3_dates: '', emp3_reason: '',
    employers: [blankEmployer(), blankEmployer(), blankEmployer()],
    prev_addresses: [blankAddr(), blankAddr(), blankAddr()],
    cmv_history: [blankCmv(), blankCmv(), blankCmv(), blankCmv(), blankCmv()],
    accidents_3yr: '', accidents_details: '',
    violations_3yr: '', violations_details: '',
    license_suspended: '', license_suspended_details: '',
    can_pass_drug_test: '', twic_holder: '', authorized_to_work: '',
    background_consent: '', heard_about: '', signature: '', signature_date: '',
  };
}

// Render helper — the form needs both chip lists every time.
const renderForm = (res, status, values, errors) =>
  res.status(status).render('apply/form', {
    values, errors, endorsements: ENDORSEMENTS, equipment_types: EQUIPMENT_TYPES,
  });

function parseBody(b) {
  const v = emptyValues();
  const SCALAR_SKIP = new Set(['endorsements', 'equipment_types', 'employers', 'prev_addresses', 'cmv_history']);
  for (const k of Object.keys(v)) {
    if (SCALAR_SKIP.has(k)) continue;
    v[k] = String(first(b[k]) || '').trim();
  }
  // Checkbox: only present in the POST body when checked.
  v.background_consent = first(b.background_consent) ? 'yes' : '';
  const checkList = (name, allowed) => {
    const raw = b[name] === undefined ? [] : (Array.isArray(b[name]) ? b[name] : [b[name]]);
    return raw.map((e) => String(e).trim()).filter((e) => allowed.includes(e));
  };
  v.endorsements = checkList('endorsements', ENDORSEMENTS);
  v.equipment_types = checkList('equipment_types', EQUIPMENT_TYPES);
  for (let n = 1; n <= 3; n++) {
    const e = {
      company: str(first(b[`emp${n}_company`]), 160),
      street: str(first(b[`emp${n}_street`]), 200),
      city: str(first(b[`emp${n}_city`]), 100),
      state: str(first(b[`emp${n}_state`]), 60),
      zip: str(first(b[`emp${n}_zip`]), 20),
      dates: str(first(b[`emp${n}_dates`]), 80),
      reason: str(first(b[`emp${n}_reason`]), 500),
      fmcsr: YES_NO.includes(first(b[`emp${n}_fmcsr`])) ? first(b[`emp${n}_fmcsr`]) : '',
      safety: YES_NO.includes(first(b[`emp${n}_safety`])) ? first(b[`emp${n}_safety`]) : '',
    };
    v.employers[n - 1] = e;
    // Keep the flat columns in sync for back-compat.
    v[`emp${n}_company`] = e.company;
    v[`emp${n}_dates`] = e.dates;
    v[`emp${n}_reason`] = e.reason;
  }
  for (let n = 1; n <= 3; n++) {
    v.prev_addresses[n - 1] = {
      street: str(first(b[`pa${n}_street`]), 200),
      city: str(first(b[`pa${n}_city`]), 100),
      state: str(first(b[`pa${n}_state`]), 60),
      zip: str(first(b[`pa${n}_zip`]), 20),
      dates: str(first(b[`pa${n}_dates`]), 80),
    };
  }
  for (let n = 1; n <= 5; n++) {
    v.cmv_history[n - 1] = {
      company: str(first(b[`cmv${n}_company`]), 160),
      city: str(first(b[`cmv${n}_city`]), 100),
      state: str(first(b[`cmv${n}_state`]), 60),
      dates: str(first(b[`cmv${n}_dates`]), 80),
      reason: str(first(b[`cmv${n}_reason`]), 500),
    };
  }
  return v;
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function validate(v) {
  const errors = [];
  if (!v.full_name) errors.push('Full name is required.');
  const digits = v.phone.replace(/\D/g, '');
  if (digits.length < 7) errors.push('Enter a valid phone number.');
  if (!isEmail(v.email)) errors.push('Enter a valid email address.');
  if (!v.street) errors.push('Street address is required.');
  if (!v.city) errors.push('City is required.');
  if (!v.state) errors.push('State is required.');
  const dob = validDate(v.dob);
  if (!dob) errors.push('Enter a valid date of birth.');
  else {
    const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 18 || age > 100) errors.push('Date of birth looks wrong — applicants must be at least 18.');
  }
  if (!CDL_CLASSES.includes(v.cdl_class)) errors.push('Select your CDL class (A, B, or C).');
  const yrs = Number(v.years_experience);
  if (v.years_experience === '' || !Number.isFinite(yrs) || yrs < 0 || yrs > 60) {
    errors.push('Enter your years of CDL driving experience (0–60).');
  }
  // 391.21(b)(2): SSN required on a DOT driver application.
  const ssnDigits = v.ssn.replace(/\D/g, '');
  if (!/^\d{9}$/.test(ssnDigits) || /^0+$/.test(ssnDigits) || /^(\d)\1{8}$/.test(ssnDigits)) {
    errors.push('Enter a valid Social Security number (9 digits).');
  }
  // 391.21(b)(5): issuing state, number, and expiration of each unexpired CDL.
  if (!/^[A-Za-z]{2}$/.test(v.cdl_state)) errors.push('Enter the 2-letter issuing state of your CDL.');
  if (!v.cdl_number) errors.push('Enter your CDL number.');
  const cdlExp = validDate(v.cdl_expiry);
  if (!cdlExp) errors.push('Enter your CDL expiration date.');
  else if (cdlExp < new Date(new Date().toDateString())) errors.push('Your CDL expiration date is in the past — renew before applying.');
  // 391.21(b)(3): every address in the last 3 years. Current address (above) counts as the first.
  v.prev_addresses.forEach((pa, i) => {
    if (pa.street || pa.city || pa.state || pa.zip || pa.dates) {
      if (!pa.street || !pa.city || !pa.state) {
        errors.push(`Previous address ${i + 1}: street, city, and state are all required.`);
      }
    }
  });
  // 391.21(b)(10): 3-year employer history needs addresses + DOT-regulated flags.
  v.employers.forEach((e, i) => {
    const n = i + 1;
    if (e.company || e.dates || e.reason || e.street || e.city || e.state || e.zip) {
      if (!e.company) errors.push(`Employer ${n}: company name is required.`);
      if (!e.dates) errors.push(`Employer ${n}: dates employed are required.`);
      if (!e.city || !e.state) errors.push(`Employer ${n}: city and state are required.`);
      if (!YES_NO.includes(e.fmcsr)) errors.push(`Employer ${n}: say whether you were subject to the FMCSRs at that job.`);
      if (!YES_NO.includes(e.safety)) errors.push(`Employer ${n}: say whether that job was a DOT safety-sensitive function.`);
    }
  });
  // 391.21(b)(11): CMV-operator employers 4–10 years back (optional blocks).
  v.cmv_history.forEach((c, i) => {
    if (c.company && !c.dates) errors.push(`Commercial driving job ${i + 1}: dates employed are required.`);
  });
  if (!v.emp1_company || !v.emp1_dates) {
    errors.push('List at least your most recent employer (company and dates).');
  }
  for (const [field, label] of [['accidents_3yr', 'accidents'], ['violations_3yr', 'traffic violations'], ['license_suspended', 'license suspension/revocation']]) {
    if (!YES_NO.includes(v[field])) errors.push(`Answer the question about ${label} in the last 3 years.`);
  }
  for (const [field, label] of [['can_pass_drug_test', 'passing a DOT drug test'], ['twic_holder', 'holding a TWIC card'], ['authorized_to_work', 'being authorized to work in the US']]) {
    if (!YES_NO.includes(v[field])) errors.push(`Answer the question about ${label}.`);
  }
  if (v.accidents_3yr === 'yes' && !v.accidents_details) errors.push('Give details for your accident(s).');
  if (v.violations_3yr === 'yes' && !v.violations_details) errors.push('Give details for your traffic violation(s).');
  if (v.license_suspended === 'yes' && !v.license_suspended_details) errors.push('Give details for the license suspension/revocation.');
  if (v.background_consent !== 'yes') errors.push('You must consent to the background check and MVR review to apply.');
  if (!v.signature) errors.push('Type your full name as your signature.');
  const sigDate = validDate(v.signature_date);
  if (!sigDate) errors.push('Enter the signature date.');
  else if (sigDate > new Date()) errors.push('The signature date cannot be in the future.');
  return errors;
}

const DOC_LABELS = {
  doc_license_front: "Driver's license — front",
  doc_license_back: "Driver's license — back",
  doc_medical_card: "DOT medical examiner's certificate",
  doc_other: 'Additional document',
};

// Returns { errors, docs } where docs is the list of sanitized documents to save.
function validateDocs(files) {
  const errors = [];
  const docs = [];
  const reqFields = ['doc_license_front', 'doc_license_back', 'doc_medical_card'];
  for (const field of DOC_FIELDS) {
    const list = (files && files[field.name]) || [];
    if (reqFields.includes(field.name) && !list.length) {
      errors.push(`${DOC_LABELS[field.name]} is required — take a photo and attach it.`);
    }
    for (const f of list) {
      const sniffed = sniffImageMime(f.buffer);
      if (!sniffed || f.size > 8 * 1024 * 1024) {
        errors.push(`${DOC_LABELS[field.name]} must be a photo (JPEG, PNG, or WebP), 8 MB or smaller.`);
        continue;
      }
      const docType = field.name === 'doc_license_front' ? 'license_front'
        : field.name === 'doc_license_back' ? 'license_back'
        : field.name === 'doc_medical_card' ? 'medical_card' : 'other';
      docs.push({
        doc_type: docType,
        filename: String(f.originalname || 'photo').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'photo.jpg',
        mimetype: sniffed,
        size: f.size,
        buffer: f.buffer,
      });
    }
  }
  return { errors, docs };
}

async function notifyOffice(app, docCount) {
  // Returns true if the notification email was sent. Never throws —
  // a failed email must never lose an application.
  try {
    if (!mailer.isConfigured()) return false;
    let to = String(process.env.APPLY_NOTIFY_EMAIL || '').trim();
    if (!to) {
      const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'company_email'");
      to = String(rows[0]?.value || process.env.COMPANY_EMAIL || '').trim();
    }
    if (!to || !isEmail(to)) return false;
    const lines = [
      `New CDL driver application received ${new Date().toLocaleString('en-US')}`,
      '',
      `Name: ${app.full_name}`,
      `Phone: ${app.phone}   Email: ${app.email}`,
      `Address: ${[app.street, app.city, app.state, app.zip].filter(Boolean).join(', ')}`,
      `SSN on file: •••-••-${String(app.ssn || '').replace(/\D/g, '').slice(-4)} (full number in the office app — do not forward this email)`,
      `CDL Class ${app.cdl_class} · ${app.cdl_state} ${app.cdl_number}, exp ${app.cdl_expiry}  Endorsements: ${app.endorsements.length ? app.endorsements.join(', ') : 'none'}  Experience: ${app.years_experience} yrs`,
      `Equipment operated: ${app.equipment_types.length ? app.equipment_types.join(', ') : '—'}`,
      `Current employer: ${app.current_employer || '—'}`,
      `Employers (3yr): ${(app.employers || []).filter((e) => e.company).map((e) => `${e.company} (${[e.city, e.state].filter(Boolean).join(', ')})`).join(' | ') || '—'}`,
      `CMV jobs 4–10yr ago: ${(app.cmv_history || []).filter((c) => c.company).length}`,
      `Previous addresses (3yr): ${(app.prev_addresses || []).filter((a) => a.street || a.city).length}`,
      `Drug test OK: ${app.can_pass_drug_test ? 'yes' : 'no'}   TWIC: ${app.twic_holder ? 'yes' : 'no'}   Authorized to work: ${app.authorized_to_work ? 'yes' : 'no'}`,
      `Accidents (3yr): ${app.accidents_3yr ? 'YES' : 'no'}${app.accidents_details ? ' — ' + app.accidents_details : ''}`,
      `Violations (3yr): ${app.violations_3yr ? 'YES' : 'no'}${app.violations_details ? ' — ' + app.violations_details : ''}`,
      `License suspended/revoked: ${app.license_suspended ? 'YES' : 'no'}${app.license_suspended_details ? ' — ' + app.license_suspended_details : ''}`,
      `Background/MVR consent: ${app.background_consent ? 'YES' : 'no'}`,
      `Heard about us: ${app.heard_about || '—'}`,
      `Documents attached: ${docCount} photo(s)`,
      '',
      'Review it in the office app: Admin → Applications.',
    ];
    await mailer.sendMail({
      to,
      subject: `New CDL driver application: ${app.full_name} (Class ${app.cdl_class})`,
      text: lines.join('\n'),
    });
    return true;
  } catch (e) {
    console.error('application notify email failed:', e.message);
    return false;
  }
}

// ---------- Public form ----------
router.get('/', (req, res) => {
  renderForm(res, 200, emptyValues(), []);
});

router.get('/thanks', (req, res) => {
  res.render('apply/thanks');
});

router.post('/', applyLimiter, handleDocUpload, async (req, res) => {
  const b = req.body || {};
  // Honeypot: bots fill the hidden "website" field. Pretend success, save nothing.
  if (str(b.website, 200)) return res.redirect('/apply/thanks');

  const v = parseBody(b);
  const errors = validate(v);
  const { errors: docErrors, docs } = validateDocs(req.files);
  const allErrors = errors.concat(docErrors);
  if (allErrors.length) {
    // File inputs can't be repopulated by the browser, so the applicant must re-select photos.
    const shown = docErrors.length
      ? allErrors.map((e) => docErrors.includes(e) ? e + ' (You will need to re-select your document photos.)' : e)
      : allErrors;
    return renderForm(res, 400, v, shown);
  }

  // Save application + documents atomically: one transaction, never a half-saved application.
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO job_applications
        (full_name, phone, email, street, city, state, zip, dob, ssn, cdl_class, cdl_state,
         cdl_number, cdl_expiry, endorsements, equipment_types,
         years_experience, current_employer,
         emp1_company, emp1_dates, emp1_reason, emp2_company, emp2_dates, emp2_reason,
         emp3_company, emp3_dates, emp3_reason,
         employers, prev_addresses, cmv_history,
         accidents_3yr, accidents_details, violations_3yr, violations_details,
         license_suspended, license_suspended_details,
         can_pass_drug_test, twic_holder, authorized_to_work,
         background_consent, heard_about, signature, signature_date, source_ip)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         $12,$13,$14,$15,
         $16,$17,
         $18,$19,$20,$21,$22,$23,
         $24,$25,$26,
         $27,$28,$29,
         $30,$31,$32,$33,
         $34,$35,
         $36,$37,$38,
         $39,$40,$41,$42,$43)
       RETURNING id`,
      [
        str(v.full_name, 120), str(v.phone, 40), v.email.toLowerCase(), str(v.street, 200),
        str(v.city, 100), str(v.state, 60), str(v.zip, 20), v.dob, v.ssn.replace(/\D/g, ''),
        v.cdl_class, v.cdl_state.toUpperCase(),
        str(v.cdl_number, 40), v.cdl_expiry, v.endorsements.join(','), v.equipment_types.join(','),
        Number(v.years_experience), str(v.current_employer, 160) || null,
        str(v.emp1_company, 160), str(v.emp1_dates, 80), str(v.emp1_reason, 500) || null,
        str(v.emp2_company, 160) || null, str(v.emp2_dates, 80) || null, str(v.emp2_reason, 500) || null,
        str(v.emp3_company, 160) || null, str(v.emp3_dates, 80) || null, str(v.emp3_reason, 500) || null,
        JSON.stringify(v.employers.filter((e) => e.company || e.dates)),
        JSON.stringify(v.prev_addresses.filter((a) => a.street || a.city || a.state)),
        JSON.stringify(v.cmv_history.filter((c) => c.company || c.dates)),
        yn(v.accidents_3yr), str(v.accidents_details, 2000) || null,
        yn(v.violations_3yr), str(v.violations_details, 2000) || null,
        yn(v.license_suspended), str(v.license_suspended_details, 2000) || null,
        yn(v.can_pass_drug_test), yn(v.twic_holder), yn(v.authorized_to_work),
        true, str(v.heard_about, 200) || null, str(v.signature, 120), v.signature_date,
        (req.ip || '').slice(0, 45),
      ]
    );
    id = rows[0].id;
    for (const d of docs) {
      await client.query(
        `INSERT INTO application_documents (application_id, doc_type, filename, mimetype, size_bytes, data)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, d.doc_type, d.filename, d.mimetype, d.size, d.buffer]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const app = { ...v, id };
  const sent = await notifyOffice(app, docs.length);
  await pool.query('UPDATE job_applications SET email_sent = $1 WHERE id = $2', [sent, id]);

  res.redirect('/apply/thanks');
});

module.exports = router;
