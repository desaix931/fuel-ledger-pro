'use strict';
const express = require('express');
const PDFDocument = require('pdfkit');

const pool = require('../db');
const { requireAdmin, requireCsrf } = require('../middleware');
const { csvCell, fmtDateTime, fmtGal } = require('../lib');
const mailer = require('../lib/mailer');

const router = express.Router();
router.use(requireAdmin);

async function companyInfo() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function ledgerData(customerId, from, to) {
  const params = [customerId];
  const where = ['f.customer_id = $1'];
  if (from) { params.push(from); where.push(`f.filled_at >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`f.filled_at < ($${params.length}::date + INTERVAL '1 day')`); }
  const clause = 'WHERE ' + where.join(' AND ');
  const [cust, fills, totals] = await Promise.all([
    pool.query('SELECT * FROM customers WHERE id = $1', [customerId]),
    pool.query(
      `SELECT f.*, s.name AS site_name, u.name AS driver_name,
              (SELECT COUNT(*) FROM fill_documents d WHERE d.fill_id = f.id) AS bol_count
       FROM fills f LEFT JOIN sites s ON s.id = f.site_id JOIN users u ON u.id = f.driver_id
       ${clause} ORDER BY f.filled_at`, params),
    pool.query(
      `SELECT f.fuel_type, SUM(f.gallons)::float AS gal, COUNT(*)::int AS n
       FROM fills f ${clause} GROUP BY f.fuel_type ORDER BY f.fuel_type`, params),
  ]);
  const grand = totals.rows.reduce((a, r) => a + r.gal, 0);
  return { customer: cust.rows[0], fills: fills.rows, totals: totals.rows, grand, from, to };
}

function ledgerText(company, data) {
  const L = [];
  if (company.company_name) L.push(company.company_name);
  if (company.company_phone || company.company_email) {
    L.push([company.company_phone, company.company_email].filter(Boolean).join(' | '));
  }
  if (company.company_address) L.push(company.company_address);
  L.push('');
  L.push('FUEL DELIVERY LEDGER');
  L.push(`Customer: ${data.customer.name}`);
  L.push(`Period: ${data.from || 'beginning'} to ${data.to || 'today'}`);
  L.push('');
  L.push('Date              Site            Equipment        Fuel Type       Gallons  Driver');
  L.push('-'.repeat(84));
  for (const f of data.fills) {
    L.push(
      `${fmtDateTime(f.filled_at).padEnd(18)}${(f.site_name || '-').slice(0, 15).padEnd(16)}` +
      `${f.equipment_label.slice(0, 16).padEnd(17)}${f.fuel_type.slice(0, 14).padEnd(16)}` +
      `${fmtGal(f.gallons).padStart(8)}  ${f.driver_name}`
    );
  }
  L.push('-'.repeat(84));
  L.push('TOTALS BY FUEL TYPE:');
  for (const t of data.totals) L.push(`  ${t.fuel_type}: ${fmtGal(t.gal)} gal (${t.n} fills)`);
  L.push(`GRAND TOTAL: ${fmtGal(data.grand)} gal across ${data.fills.length} fills`);
  return L.join('\n');
}

// Build the ledger PDF into a Buffer (shared by download + email).
function buildLedgerPdf(company, data, from, to) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (company.company_name) doc.fontSize(18).text(company.company_name);
    doc.fontSize(10).fillColor('#444');
    [company.company_phone, company.company_email, company.company_address].filter(Boolean)
      .forEach((l) => doc.text(l));
    doc.moveDown().fillColor('#000').fontSize(14).text('Fuel Delivery Ledger');
    doc.fontSize(10).text(`Customer: ${data.customer.name}`);
    doc.text(`Period: ${from || 'beginning'} to ${to || 'today'}`);
    doc.moveDown();

    const cols = [92, 110, 110, 90, 62]; // date, site, equipment, fuel, gallons
    const headers = ['Date', 'Site', 'Equipment', 'Fuel type', 'Gallons'];
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    let x = 48;
    headers.forEach((h, i) => { doc.text(h, x, y0, { width: cols[i] }); x += cols[i]; });
    doc.font('Helvetica').fontSize(9);
    let y = y0 + 16;
    const rowH = 14;
    for (const f of data.fills) {
      if (y > 700) { doc.addPage(); y = 48; }
      x = 48;
      const cells = [fmtDateTime(f.filled_at), f.site_name || '-', f.equipment_label, f.fuel_type, fmtGal(f.gallons)];
      cells.forEach((c, i) => { doc.text(String(c).slice(0, 28), x, y, { width: cols[i] }); x += cols[i]; });
      y += rowH;
    }
    doc.moveDown(2);
    doc.font('Helvetica-Bold').text('Totals by fuel type:');
    doc.font('Helvetica');
    for (const t of data.totals) doc.text(`  ${t.fuel_type}: ${fmtGal(t.gal)} gal (${t.n} fills)`);
    doc.moveDown();
    doc.font('Helvetica-Bold').fontSize(11)
      .text(`Grand total: ${fmtGal(data.grand)} gal across ${data.fills.length} fills`);
    doc.fontSize(9).fillColor('#666')
      .text(`Generated ${fmtDateTime(new Date())}`, { align: 'right' });
    doc.end();
  });
}

function ledgerFilename(data, from, to, ext) {
  return `ledger-${data.customer.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${from || 'all'}-to-${to || 'all'}.${ext}`;
}
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM customers ORDER BY name');
  res.render('admin/ledger', { customers: rows });
});

// --- Ledger preview ---
router.get('/view', async (req, res) => {
  const customerId = parseInt(req.query.customer_id, 10);
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  if (!customerId) return res.redirect('/admin/ledger');
  const data = await ledgerData(customerId, from, to);
  if (!data.customer) return res.status(404).send('Customer not found.');
  const company = await companyInfo();
  const q = `customer_id=${customerId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  res.render('admin/ledger_view', {
    data, company, q, text: ledgerText(company, data),
    emailConfigured: mailer.isConfigured(),
    emailed: req.query.emailed || null,
    emailerr: req.query.emailerr || null,
    defaultSubject: `Fuel delivery ledger — ${data.customer.name} (${from || 'all'} to ${to || 'all'})`,
    defaultMessage: `Attached is the fuel delivery ledger for ${data.customer.name}, ` +
      `${from || 'the beginning'} to ${to || 'today'}.`,
  });
});

// --- PDF download ---
router.get('/pdf', async (req, res) => {
  const customerId = parseInt(req.query.customer_id, 10);
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  if (!customerId) return res.status(400).send('Missing customer.');
  const data = await ledgerData(customerId, from, to);
  if (!data.customer) return res.status(404).send('Customer not found.');
  const company = await companyInfo();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${ledgerFilename(data, from, to, 'pdf')}"`);
  const pdf = await buildLedgerPdf(company, data, from, to);
  res.send(pdf);
});

// --- Email ledger (PDF attached) to multiple recipients ---
router.post('/email', requireCsrf, async (req, res) => {
  const customerId = parseInt(req.body.customer_id, 10);
  const from = String(req.body.from || '').slice(0, 10);
  const to = String(req.body.to || '').slice(0, 10);
  const q = `customer_id=${customerId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const back = (msg, ok) =>
    res.redirect(`/admin/ledger/view?${q}&${ok ? 'emailed' : 'emailerr'}=${encodeURIComponent(msg)}`);

  if (!customerId) return back('Missing customer.', false);
  let recipients;
  try {
    recipients = mailer.parseRecipients(req.body.recipients);
  } catch (e) {
    return back(e.message, false);
  }
  const subject = String(req.body.subject || '').trim().slice(0, 200) || 'Fuel delivery ledger';
  const message = String(req.body.message || '').trim().slice(0, 5000);

  const data = await ledgerData(customerId, from, to);
  if (!data.customer) return res.status(404).send('Customer not found.');
  const company = await companyInfo();
  const pdf = await buildLedgerPdf(company, data, from, to);
  const text = ledgerText(company, data);

  try {
    await mailer.sendMail({
      to: recipients.join(', '),
      subject,
      text: (message ? message + '\n\n' : '') + text,
      attachments: [{ filename: ledgerFilename(data, from, to, 'pdf'), content: pdf, contentType: 'application/pdf' }],
    });
  } catch (e) {
    return back('Could not send email: ' + e.message, false);
  }
  return back(`Sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`, true);
});

// --- CSV download ---
router.get('/csv', async (req, res) => {
  const customerId = parseInt(req.query.customer_id, 10);
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  if (!customerId) return res.status(400).send('Missing customer.');
  const data = await ledgerData(customerId, from, to);
  if (!data.customer) return res.status(404).send('Customer not found.');
  const lines = [['date', 'site', 'equipment', 'fuel_type', 'gallons', 'driver', 'notes'].join(',')];
  for (const f of data.fills) {
    lines.push([fmtDateTime(f.filled_at), f.site_name, f.equipment_label, f.fuel_type,
      Number(f.gallons).toFixed(2), f.driver_name, f.notes].map(csvCell).join(','));
  }
  lines.push([]);
  lines.push(['TOTALS BY FUEL TYPE'].join(','));
  for (const t of data.totals) lines.push([t.fuel_type, Number(t.gal).toFixed(2)].map(csvCell).join(','));
  lines.push([`GRAND TOTAL, ${Number(data.grand).toFixed(2)} gallons`].join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition',
    `attachment; filename="ledger-${data.customer.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${from || 'all'}-to-${to || 'all'}.csv"`);
  res.send(lines.join('\r\n'));
});

module.exports = router;
