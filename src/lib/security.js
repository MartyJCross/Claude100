'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { nowIso } = require('./format');

const SESSION_DAYS = 30;

// ---------- Passwords (scrypt, no native deps) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// ---------- Cookies ----------
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function setCookie(res, name, value, { maxAgeDays, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (config.isProd) parts.push('Secure');
  if (maxAgeDays !== undefined) parts.push(`Max-Age=${Math.round(maxAgeDays * 86400)}`);
  res.append('Set-Cookie', parts.join('; '));
}

// ---------- Sessions ----------
function createSession(res, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, nowIso(), expires);
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), userId);
  setCookie(res, 'sid', token, { maxAgeDays: SESSION_DAYS });
}

function destroySession(req, res) {
  if (req.cookies.sid) db.run('DELETE FROM sessions WHERE id = ?', sha256(req.cookies.sid));
  setCookie(res, 'sid', '', { maxAgeDays: 0 });
}

function destroyAllSessions(userId) {
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

// Populates req.cookies, req.user, req.anonId and the CSRF token.
function sessionMiddleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = null;
  if (req.cookies.sid) {
    const row = db.one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
      sha256(req.cookies.sid),
      nowIso(),
    );
    if (row) {
      req.user = row;
      req.user.isAdmin = config.adminEmails.includes(row.email.toLowerCase());
    }
  }
  // Anonymous visitor id for funnel analytics (no personal data).
  req.anonId = req.cookies.aid;
  if (!req.anonId || !/^[A-Za-z0-9_-]{10,40}$/.test(req.anonId)) {
    req.anonId = randomToken(12);
    setCookie(res, 'aid', req.anonId, { maxAgeDays: 365 });
  }
  // Double-submit CSRF token: the cookie value must come back in every form.
  req.csrfToken = req.cookies.csrf;
  if (!req.csrfToken || req.csrfToken.length < 20) {
    req.csrfToken = randomToken(24);
    setCookie(res, 'csrf', req.csrfToken, { maxAgeDays: 365 });
  }
  res.locals.user = req.user;
  res.locals.csrf = req.csrfToken;
  next();
}

function verifyCsrf(req, res, next) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(String(req.cookies.csrf || ''));
  if (a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).send('Your form expired. Please go back, refresh the page and try again.');
  }
  next();
}

// Applies CSRF checks to every state-changing request that has a parsed body.
// Multipart routes call verifyCsrf themselves after multer runs.
function csrfUnlessMultipart(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.isAdmin) return res.status(404).send('Not found');
  next();
}

// ---------- Rate limiting (in-memory, per IP + bucket) ----------
const buckets = new Map();
function rateLimit(name, { max, windowMs }) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || entry.reset < now) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).send('Too many attempts. Please wait a few minutes and try again.');
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
}, 60000).unref();

// ---------- Security headers ----------
function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=()',
  });
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  sha256,
  randomToken,
  parseCookies,
  setCookie,
  createSession,
  destroySession,
  destroyAllSessions,
  sessionMiddleware,
  verifyCsrf,
  csrfUnlessMultipart,
  requireAuth,
  requireAdmin,
  rateLimit,
  securityHeaders,
};
