'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const { html } = require('../lib/html');
const { render } = require('../lib/render');
const { errorsBox, csrfField } = require('../views/layout');
const { hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions, sha256, randomToken, rateLimit } = require('../lib/security');
const { track, attribution } = require('../lib/analytics');
const { sendMail } = require('../lib/mailer');
const { nowIso } = require('../lib/format');

const router = express.Router();
const authLimit = rateLimit('auth', { max: 20, windowMs: 15 * 60 * 1000 });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Only allow local redirects after login.
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}

function signupForm(req, res, { errors = [], values = {} } = {}, status = 200) {
  render(req, res, {
    title: 'Create your free account',
    active: 'signup',
    body: html`<section class="wrap page narrow">
      <h1>Create your free account</h1>
      <p class="text-2">Free forever for one property: log readings, add bills and see exactly where you are being over-billed. Upgrade only when you want the dispute letters.</p>
      <div class="card">
        ${errorsBox(errors)}
        <form method="post" action="/signup" novalidate>
          ${csrfField(req.csrfToken)}
          <input type="hidden" name="next" value="${values.next || ''}">
          <div class="field"><label for="name">Full name <span class="hint">As it should appear on your dispute letters.</span></label>
            <input id="name" name="name" type="text" autocomplete="name" required value="${values.name || ''}"></div>
          <div class="field"><label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" required value="${values.email || ''}"></div>
          <div class="field"><label for="password">Password <span class="hint">At least 8 characters.</span></label>
            <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
          <div class="field"><label class="check"><input type="checkbox" name="terms" value="1" ${values.terms ? 'checked' : ''}> <span>I agree to the <a href="/legal/terms" target="_blank">Terms</a> and <a href="/legal/privacy" target="_blank">Privacy Policy</a>.</span></label></div>
          <button class="btn big" type="submit" style="width:100%">Create account</button>
        </form>
      </div>
      <p class="muted" style="margin-top:14px">Already have an account? <a href="/login">Log in</a></p>
    </section>`,
  }, status);
}

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/app');
  signupForm(req, res, { values: { next: req.query.next } });
});

router.post('/signup', authLimit, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(req.body.password || '');
  const errors = [];
  if (!name) errors.push('Please enter your name.');
  if (!EMAIL_RE.test(email)) errors.push('Please enter a valid email address.');
  if (password.length < 8) errors.push('Your password must be at least 8 characters.');
  if (!req.body.terms) errors.push('Please accept the Terms and Privacy Policy.');
  if (!errors.length && db.one('SELECT id FROM users WHERE email = ?', email)) errors.push('An account with this email already exists. Try logging in.');
  if (errors.length) return signupForm(req, res, { errors, values: { name, email, terms: req.body.terms, next: req.body.next } }, 422);

  const utm = attribution(req);
  const result = db.run(
    `INSERT INTO users (email, password_hash, name, created_at, anon_id, referrer, utm_source, utm_medium, utm_campaign) VALUES (?,?,?,?,?,?,?,?,?)`,
    email, hashPassword(password), name, nowIso(), req.anonId, utm.ref || null, utm.source || null, utm.medium || null, utm.campaign || null,
  );
  const userId = Number(result.lastInsertRowid);
  createSession(res, userId);
  track('signup', { req, userId });
  sendMail({
    to: email,
    subject: `Welcome to ${config.brand}`,
    text: `Hi ${name.split(' ')[0]},\n\nWelcome to ${config.brand}. Here is how to get the most out of it:\n\n1. Add your property and municipal account number.\n2. Photograph your water (and electricity) meter today, and again on the same day every month. Dated photos are the strongest evidence you can have.\n3. Add your last few municipal bills. We check every charge against your real readings and show you exactly where you are being over-billed.\n\nIf you find over-billing, ${config.brand} prepares a formal Section 102 dispute letter and evidence pack that protects you from disconnection on the disputed amount.`,
    cta: { label: 'Add your property', url: `${config.baseUrl}/app/properties/new` },
  });
  const next = safeNext(req.body.next);
  res.redirect(next === '/app' ? '/app/properties/new?ok=welcome' : next);
});

function loginForm(req, res, { errors = [], email = '', next = '' } = {}, status = 200) {
  render(req, res, {
    title: 'Log in',
    active: 'login',
    body: html`<section class="wrap page narrow">
      <h1>Log in</h1>
      <div class="card">
        ${errorsBox(errors)}
        <form method="post" action="/login">
          ${csrfField(req.csrfToken)}
          <input type="hidden" name="next" value="${next}">
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${email}"></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn big" type="submit" style="width:100%">Log in</button>
        </form>
      </div>
      <p class="muted" style="margin-top:14px"><a href="/forgot">Forgot your password?</a> · New here? <a href="/signup">Create a free account</a></p>
    </section>`,
  }, status);
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  loginForm(req, res, { next: req.query.next || '' });
});

router.post('/login', authLimit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.one('SELECT * FROM users WHERE email = ?', email);
  // Always run a hash so response time does not reveal whether the email exists.
  const ok = user ? verifyPassword(password, user.password_hash) : (verifyPassword(password, hashPassword('timing-equaliser')), false);
  if (!ok) return loginForm(req, res, { errors: ['That email and password do not match.'], email, next: req.body.next }, 401);
  createSession(res, user.id);
  track('login', { req, userId: user.id });
  res.redirect(safeNext(req.body.next));
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/?ok=loggedout');
});

router.get('/forgot', (req, res) => {
  render(req, res, {
    title: 'Reset your password',
    body: html`<section class="wrap page narrow"><h1>Reset your password</h1>
      <div class="card"><form method="post" action="/forgot">${csrfField(req.csrfToken)}
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required></div>
        <button class="btn" type="submit">Send reset link</button></form></div></section>`,
  });
});

router.post('/forgot', authLimit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.one('SELECT * FROM users WHERE email = ?', email);
  if (user) {
    const token = randomToken();
    db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(token), user.id, new Date(Date.now() + 3600 * 1000).toISOString());
    sendMail({
      to: user.email,
      subject: `Reset your ${config.brand} password`,
      text: `Someone (hopefully you) asked to reset your ${config.brand} password. The link below works for one hour.\n\nIf you did not ask for this, you can ignore this email.`,
      cta: { label: 'Choose a new password', url: `${config.baseUrl}/reset/${token}` },
    });
  }
  res.redirect('/login?ok=reset');
});

function validReset(token) {
  return db.one('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', sha256(String(token)), nowIso());
}

router.get('/reset/:token', (req, res) => {
  const row = validReset(req.params.token);
  render(req, res, {
    title: 'Choose a new password',
    noindex: true,
    body: html`<section class="wrap page narrow"><h1>Choose a new password</h1>
      <div class="card">${row
        ? html`<form method="post" action="/reset/${req.params.token}">${csrfField(req.csrfToken)}
            <div class="field"><label for="password">New password <span class="hint">At least 8 characters.</span></label><input id="password" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
            <button class="btn" type="submit">Save password</button></form>`
        : html`<p>This reset link has expired or was already used. <a href="/forgot">Request a new one</a>.</p>`}</div></section>`,
  });
});

router.post('/reset/:token', authLimit, (req, res) => {
  const row = validReset(req.params.token);
  const password = String(req.body.password || '');
  if (!row) return res.redirect(`/reset/${encodeURIComponent(req.params.token)}`);
  if (password.length < 8) return res.redirect(`/reset/${encodeURIComponent(req.params.token)}`);
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), row.user_id);
    db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', nowIso(), row.token_hash);
    destroyAllSessions(row.user_id);
  });
  createSession(res, row.user_id);
  res.redirect('/app?ok=password');
});

module.exports = router;
