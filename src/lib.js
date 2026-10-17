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
  FUEL_TYPES, isEmail, parseLocalDateTime, toInputDateTime,
  fmtDateTime, fmtDate, fmtGal, csvCell, todayStr, passwordError,
};
