'use strict';

// Unambiguous for every reader: space as thousands separator, dot for cents (R1 234.56).
function groupThousands(intString) {
  return intString.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function rand(cents, { decimals = 2 } = {}) {
  const n = Math.round(Number(cents || 0));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (decimals === 0) return `${sign}R${groupThousands(String(Math.round(abs / 100)))}`;
  return `${sign}R${groupThousands(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`;
}

// Parse "R1 234,50", "1234.50", "1,234.50" into integer cents.
function toCents(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/^R\s*/i, '').replace(/\s/g, '');
  if (s === '') return null;
  // If the last separator is a comma followed by 1-2 digits, it is a decimal comma.
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toNumber(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/\s/g, '');
  if (s === '') return null;
  s = /^\d*,\d+$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const pad = (n) => String(n).padStart(2, '0');

function today() {
  // Dates are tracked in South African time (UTC+2, no DST).
  return isoDate(new Date(Date.now() + 2 * 3600 * 1000));
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && isoDate(d) === s;
}

function dayNumber(s) {
  return Math.round(new Date(`${s}T00:00:00Z`).getTime() / 86400000);
}

function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

function addMonths(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return isoDate(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function prettyDate(s, { long = false } = {}) {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${d} ${(long ? MONTHS_LONG : MONTHS)[m - 1]} ${y}`;
}

function units(utility) {
  return utility === 'electricity' ? 'kWh' : 'kL';
}

function num(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const fixed = Number(n).toFixed(dp);
  const [int, frac] = fixed.split('.');
  const trimmed = (frac || '').replace(/0+$/, '');
  const sign = int.startsWith('-') ? '-' : '';
  const out = `${sign}${groupThousands(int.replace('-', ''))}${trimmed ? `.${trimmed}` : ''}`;
  return out === '-0' ? '0' : out;
}

module.exports = {
  rand,
  toCents,
  toNumber,
  today,
  isoDate,
  nowIso,
  isValidDate,
  daysBetween,
  addDays,
  addMonths,
  prettyDate,
  units,
  num,
  MONTHS,
};
