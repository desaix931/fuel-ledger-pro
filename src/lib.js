'use strict';

// Small shared helpers: validation + formatting.

const FUEL_TYPES = ['Diesel', 'Off-Road Diesel', 'Gasoline', 'DEF', 'Kerosene'];

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// Parses an HTML datetime-local value ("2026-10-16T14:30") into a Date.
// Returns null when invalid.
function parseLocalDateTime(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Interprets a datetime-local wall time entered in the CLIENT's timezone and
// returns the equivalent UTC-wall Date, matching how filled_at is stored.
// tzOffsetMin is the browser's Date#getTimezoneOffset() (minutes behind UTC;
// e.g. 240 for EDT). Falls back to the legacy UTC interpretation when the
// offset is missing or invalid (old cached pages).
function parseClientDateTime(s, tzOffsetMin) {
  const d = parseLocalDateTime(s);
  if (!d) return null;
  const off = Number(tzOffsetMin);
  if (!Number.isFinite(off) || Math.abs(off) > 840) return d;
  return new Date(d.getTime() + off * 60000);
}

// Formats a Date as "YYYY-MM-DDTHH:mm" using UTC components — the inverse of
// parseClientDateTime's output, safe regardless of the server's TZ setting.
function toUtcInput(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
}

// Formats a Date/db timestamp as "YYYY-MM-DDTHH:mm" for datetime-local inputs.
function toInputDateTime(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function fmtDateTime(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function fmtDate(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function fmtGal(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function todayStr() {
  return fmtDate(new Date());
}

// Password rule: 4–12 characters. Returns an error message, or null if OK.
function passwordError(pw) {
  const s = String(pw || '');
  if (s.length < 4) return 'Password must be at least 4 characters.';
  if (s.length > 12) return 'Password must be no more than 12 characters.';
  return null;
}

module.exports = {
  FUEL_TYPES, isEmail, parseLocalDateTime, parseClientDateTime, toUtcInput, toInputDateTime,
  fmtDateTime, fmtDate, fmtGal, csvCell, todayStr, passwordError,
};
