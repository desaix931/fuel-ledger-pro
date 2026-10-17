'use strict';
// Public DOT compliance hiring package. No login required.
// This is the post-application, pre-hire FMCSA driver-qualification paperwork
// (separate from the /apply job application). The driver's portions only —
// the office still runs the MVR, Clearinghouse queries, previous-employer
// inquiries, and pre-employment drug test itself. Operational info, not legal advice.
const express = require('express');
const rateLimit = require('express-rate-limit');

const pool = require('../db');
const { isEmail } = require('../lib');
const mailer = require('../lib/mailer');

const router = express.Router();

const hireLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,                  // 10 submissions per IP per hour is plenty
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many submissions from this address. Please try again in an hour.',
});

const YES_NO = ['yes', 'no'];
const MAX_EMPLOYERS = 5;
const MAX_VIOLATIONS = 4;

const str = (v, max) => String(v || '').trim().slice(0, max);
const first = (x) => (Array.isArray(x) ? x[0] : x);

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const d = new Date(s + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- values / parsing ----------

function emptyEmployer() {
  return {
    company: '', city: '', state: '', contact_name: '', contact_phone: '',
    contact_email: '', dates: '', func: '',
  };
}

function emptyViolation() {
  return { date: '', offense: '', location: '', vehicle: '' };
}

function emptyValues() {
  const employers = [];
  for (let i = 0; i < MAX_EMPLOYERS; i++) employers.push(emptyEmployer());
  const violations = [];
  for (let i = 0; i < MAX_VIOLATIONS; i++) violations.push(emptyViolation());
  return {
    full_name: '', email: '', dob: '',
    employers,
    release_signature: '', release_date: '',
    drug_test_issue: '', da_employer: '', da_date: '', da_substance: '', da_sap: '',
    clearinghouse_ack: '',
    med_examiner_name: '', med_registry_no: '', med_issue_date: '', med_expiry_date: '',
    no_violations: '', violations,
    viol_signature: '', viol_date: '',
    road_test_ack: '',
  };
}

function parseBody(b) {
  const v = emptyValues();
  v.full_name = str(first(b.full_name), 120);
  v.email = str(first(b.email), 160);
  v.dob = str(first(b.dob), 10);
  for (let i = 0; i < MAX_EMPLOYERS; i++) {
    const n = i + 1;
    const p = 'emp' + n + '_';
    v.employers[i] = {
      company: str(first(b[p + 'company']), 160),
      city: str(first(b[p + 'city']), 100),
      state: str(first(b[p + 'state']), 60),
      contact_name: str(first(b[p + 'contact_name']), 120),
      contact_phone: str(first(b[p + 'contact_phone']), 40),
      contact_email: str(first(b[p + 'contact_email']), 160),
      dates: str(first(b[p + 'dates']), 80),
      func: ['drove_cmv', 'other'].includes(first(b[p + 'func'])) ? first(b[p + 'func']) : '',
    };
  }
  v.release_signature = str(first(b.release_signature), 120);
  v.release_date = str(first(b.release_date), 10);
  v.drug_test_issue = first(b.drug_test_issue) === 'yes' ? 'yes' : (first(b.drug_test_issue) === 'no' ? 'no' : '');
  v.da_employer = str(first(b.da_employer), 160);
  v.da_date = str(first(b.da_date), 10);
  v.da_substance = str(first(b.da_substance), 160);
  v.da_sap = str(first(b.da_sap), 500);
  v.clearinghouse_ack = first(b.clearinghouse_ack) ? 'yes' : '';
  v.med_examiner_name = str(first(b.med_examiner_name), 160);
  v.med_registry_no = str(first(b.med_registry_no), 40);
  v.med_issue_date = str(first(b.med_issue_date), 10);
  v.med_expiry_date = str(first(b.med_expiry_date), 10);
  v.no_violations = first(b.no_violations) ? 'yes' : '';
  for (let i = 0; i < MAX_VIOLATIONS; i++) {
    const n = i + 1;
    const p = 'viol' + n + '_';
    v.violations[i] = {
      date: str(first(b[p + 'date']), 10),
      offense: str(first(b[p + 'offense']), 200),
      location: str(first(b[p + 'location']), 160),
      vehicle: str(first(b[p + 'vehicle']), 80),
    };
  }
  v.viol_signature = str(first(b.viol_signature), 120);
  v.viol_date = str(first(b.viol_date), 10);
  v.road_test_ack = first(b.road_test_ack) ? 'yes' : '';
  return v;
}

// ---------- validation ----------

function validate(v) {
  const errors = [];
  if (!v.full_name) errors.push('Full name is required.');
  if (!isEmail(v.email)) errors.push('Enter a valid email address.');
  const dob = validDate(v.dob);
  if (!dob) errors.push('Enter a valid date of birth.');
  else {
    const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 18 || age > 100) errors.push('Date of birth looks wrong — drivers must be at least 18.');
  }

  // Section B: safety performance history — at least employer 1, with contact info.
  const e1 = v.employers[0];
  if (!e1.company) errors.push('Section B: list at least your most recent DOT-regulated employer (employer 1).');
  else {
    if (!e1.contact_name) errors.push('Section B: employer 1 needs a contact name.');
    if (!e1.contact_phone && !e1.contact_email) errors.push('Section B: employer 1 needs a contact phone or email.');
  }
  v.employers.slice(1).forEach((e, i) => {
    if (e.company && (!e.contact_name || (!e.contact_phone && !e.contact_email))) {
      errors.push(`Section B: employer ${i + 2} lists a company but is missing contact name / phone or email.`);
    }
  });

  if (!v.release_signature) errors.push('Section B: type your full name to sign the safety-performance-history release.');
  const relDate = validDate(v.release_date);
  if (!relDate) errors.push('Section B: enter the release signature date.');
  else if (relDate > new Date()) errors.push('Section B: the release signature date cannot be in the future.');

  // Section C: drug & alcohol history (Part 382 / 40.25).
  if (!YES_NO.includes(v.drug_test_issue)) {
    errors.push('Section C: answer the drug/alcohol testing history question.');
  } else if (v.drug_test_issue === 'yes') {
    if (!v.da_employer) errors.push('Section C: name the employer where the positive/refusal occurred.');
    if (!validDate(v.da_date)) errors.push('Section C: enter the date it occurred.');
    if (!v.da_substance) errors.push('Section C: enter the substance involved.');
    if (!v.da_sap) errors.push('Section C: describe your SAP return-to-duty status.');
  }

  // Section D: Clearinghouse acknowledgment.
  if (v.clearinghouse_ack !== 'yes') {
    errors.push('Section D: you must acknowledge the FMCSA Clearinghouse pre-employment query.');
  }

  // Section E: medical certification.
  if (!v.med_examiner_name) errors.push('Section E: enter the medical examiner\'s name.');
  if (!v.med_registry_no) errors.push('Section E: enter the examiner\'s National Registry number.');
  const medIssue = validDate(v.med_issue_date);
  const medExp = validDate(v.med_expiry_date);
  if (!medIssue) errors.push('Section E: enter the medical certificate issue date.');
  if (!medExp) errors.push('Section E: enter the medical certificate expiry date.');
  if (medIssue && medExp) {
    if (medExp < medIssue) errors.push('Section E: the medical certificate expiry date is before the issue date.');
    if (medExp < new Date()) errors.push('Section E: the medical certificate has expired — get a current one before proceeding.');
  }

  // Section F: 12-month violation certification (391.27).
  const rows = v.violations.filter((r) => r.date || r.offense || r.location || r.vehicle);
  if (v.no_violations === 'yes' && rows.length) {
    errors.push('Section F: you checked "no violations" but also entered violation details — clear one or the other.');
  }
  if (v.no_violations !== 'yes' && !rows.length) {
    errors.push('Section F: either check "no violations in the past 12 months" or list your violations.');
  }
  rows.forEach((r, i) => {
    if (!validDate(r.date)) errors.push(`Section F: violation ${i + 1} needs a valid date.`);
    if (!r.offense) errors.push(`Section F: violation ${i + 1} needs the offense.`);
    if (!r.location) errors.push(`Section F: violation ${i + 1} needs the location.`);
    if (!r.vehicle) errors.push(`Section F: violation ${i + 1} needs the vehicle type.`);
  });
  if (!v.viol_signature) errors.push('Section F: type your full name to sign the violation certification.');
  const violDate = validDate(v.viol_date);
  if (!violDate) errors.push('Section F: enter the violation certification date.');
  else if (violDate > new Date()) errors.push('Section F: the certification date cannot be in the future.');

  // Section G: road test acknowledgment (391.33).
  if (v.road_test_ack !== 'yes') {
    errors.push('Section G: you must acknowledge the road-test statement.');
  }
  return errors;
}

// ---------- soft match to a job application ----------

async function softMatch(v) {
  const { rows } = await pool.query(
    'SELECT * FROM job_applications WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
    [v.email]
  );
  if (!rows.length) return { matched: null, match_status: 'unmatched' };
  const app = rows[0];
  const nameEq = String(app.full_name || '').trim().toLowerCase() === v.full_name.toLowerCase();
  let dobEq = false;
  if (app.dob) {
    const appDob = app.dob instanceof Date ? app.dob.toISOString().slice(0, 10) : String(app.dob).slice(0, 10);
    dobEq = appDob === v.dob;
  }
  if (nameEq || dobEq) return { matched: app, match_status: 'matched' };
  return { matched: null, match_status: 'unmatched' };
}

// ---------- office notification ----------

async function notifyOffice(pkg) {
  // Returns true if sent. Never throws — a failed email must never lose a package.
  try {
    if (!mailer.isConfigured()) return false;
    let to = String(process.env.APPLY_NOTIFY_EMAIL || '').trim();
    if (!to) {
      const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'company_email'");
      to = String(rows[0]?.value || process.env.COMPANY_EMAIL || '').trim();
    }
    if (!to || !isEmail(to)) return false;
    const empLines = pkg.employers.map((e, i) =>
      `${i + 1}. ${e.company} (${e.dates || 'dates n/a'}) — contact: ${e.contact_name || '—'}, ${e.contact_phone || e.contact_email || 'no contact'}`
    );
    const da = pkg.drug_alcohol_history;
    const lines = [
      `New DOT compliance hiring package received ${new Date().toLocaleString('en-US')}`,
      '',
      `Name: ${pkg.full_name}`,
      `Email: ${pkg.email}   DOB: ${pkg.dob}`,
      `Application match: ${pkg.match_status === 'matched' ? `YES (application #${pkg.matched_application_id})` : 'NO MATCH — review manually'}`,
      '',
      'Previous DOT employers (safety performance history release signed):',
      ...empLines,
      '',
      `Drug/alcohol history (2 yr): ${da.issue ? 'YES — ' + da.details : 'no issues reported'}`,
      `Clearinghouse ack: ${pkg.clearinghouse_ack ? 'YES' : 'no'}`,
      `Medical: ${pkg.medical.examiner_name} / Reg# ${pkg.medical.registry_no} / exp ${pkg.medical.expiry_date}`,
      `12-mo violations: ${pkg.violations.no_violations ? 'none reported' : pkg.violations.items.length + ' listed'}`,
      `Road test ack: ${pkg.road_test_ack ? 'YES' : 'no'}`,
      '',
      'Review it in the office app: Admin → DOT Packages.',
    ];
    await mailer.sendMail({
      to,
      subject: `New DOT hiring package: ${pkg.full_name}${pkg.match_status === 'matched' ? ' (matched to application)' : ' (NO APPLICATION MATCH)'}`,
      text: lines.join('\n'),
    });
    return true;
  } catch (e) {
    console.error('DOT package notify email failed:', e.message);
    return false;
  }
}

// ---------- routes ----------

router.get('/package', (req, res) => {
  res.render('hire/package', { values: emptyValues(), errors: [] });
});

router.get('/thanks', (req, res) => {
  res.render('hire/thanks');
});

router.post('/package', hireLimiter, async (req, res) => {
  const b = req.body || {};
  // Honeypot: bots fill the hidden "website" field. Pretend success, save nothing.
  if (str(b.website, 200)) return res.redirect('/hire/thanks');

  const v = parseBody(b);
  const errors = validate(v);
  if (errors.length) {
    return res.status(400).render('hire/package', { values: v, errors });
  }

  const { matched, match_status } = await softMatch(v);

  const employers = v.employers
    .filter((e) => e.company)
    .map((e) => ({
      company: e.company, city: e.city, state: e.state, contact_name: e.contact_name,
      contact_phone: e.contact_phone, contact_email: e.contact_email, dates: e.dates,
      func: e.func === 'drove_cmv' ? 'drove_cmv' : 'other',
    }));
  const drug_alcohol_history = {
    issue: v.drug_test_issue === 'yes',
    employer: v.da_employer || null,
    date: v.da_date || null,
    substance: v.da_substance || null,
    sap: v.da_sap || null,
    details: v.drug_test_issue === 'yes'
      ? `${v.da_employer}, ${v.da_date} — ${v.da_substance}; SAP: ${v.da_sap}`
      : null,
  };
  const medical = {
    examiner_name: v.med_examiner_name,
    registry_no: v.med_registry_no,
    issue_date: v.med_issue_date,
    expiry_date: v.med_expiry_date,
  };
  const violations = {
    no_violations: v.no_violations === 'yes',
    items: v.violations
      .filter((r) => r.date || r.offense || r.location || r.vehicle)
      .map((r) => ({ date: r.date, offense: r.offense, location: r.location, vehicle: r.vehicle })),
  };

  const { rows } = await pool.query(
    `INSERT INTO dot_packages
      (matched_application_id, full_name, email, dob, employers, drug_alcohol_history,
       clearinghouse_ack, medical, violations, road_test_ack,
       release_signature, release_date, violation_signature, violation_date,
       match_status, source_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      matched ? matched.id : null,
      v.full_name, v.email.toLowerCase(), v.dob || null,
      JSON.stringify(employers), JSON.stringify(drug_alcohol_history),
      true, JSON.stringify(medical), JSON.stringify(violations), true,
      v.release_signature, v.release_date, v.viol_signature, v.viol_date,
      match_status, (req.ip || '').slice(0, 45),
    ]
  );
  const id = rows[0].id;

  const pkg = {
    id, full_name: v.full_name, email: v.email, dob: v.dob,
    matched_application_id: matched ? matched.id : null, match_status,
    employers, drug_alcohol_history, clearinghouse_ack: true,
    medical, violations, road_test_ack: true,
  };
  const sent = await notifyOffice(pkg);
  await pool.query('UPDATE dot_packages SET email_sent = $1 WHERE id = $2', [sent, id]);

  res.redirect('/hire/thanks');
});

module.exports = router;
