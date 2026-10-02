'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const { html } = require('../lib/html');
const { render } = require('../lib/render');
const { errorsBox, csrfField } = require('../views/layout');
const { requireAuth, verifyPassword, hashPassword, destroyAllSessions, createSession, destroySession } = require('../lib/security');
const { userFiles, deleteUpload } = require('../lib/data');
const payfast = require('../lib/payfast');
const { track } = require('../lib/analytics');
const { nowIso } = require('../lib/format');

const router = express.Router();
router.use('/account', requireAuth);

function accountPage(req, res, { errors = [], section = '' } = {}, status = 200) {
  const u = req.user;
  render(req, res, {
    title: 'Account',
    active: 'account',
    body: html`<section class="wrap page narrow stack">
      <h1>Account</h1>
      <div class="card">
        <h2>Your details</h2>
        <p class="muted">These appear on your dispute letters.</p>
        ${section === 'profile' ? errorsBox(errors) : ''}
        <form method="post" action="/account/profile">
          ${csrfField(req.csrfToken)}
          <div class="field"><label for="name">Full name</label><input id="name" name="name" type="text" required maxlength="120" value="${u.name}"></div>
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="200" value="${u.email}"></div>
          <div class="field"><label for="phone">Phone <span class="hint">Optional, shown on letters</span></label><input id="phone" name="phone" type="tel" maxlength="30" value="${u.phone}"></div>
          <div class="field"><label for="postal_address">Your address for correspondence <span class="hint">Defaults to the property address</span></label><input id="postal_address" name="postal_address" type="text" maxlength="200" value="${u.postal_address}"></div>
          <div class="form-grid">
            <div class="field"><label for="reminder_day">Monthly reading reminder on day</label><input id="reminder_day" name="reminder_day" type="number" min="1" max="28" value="${u.reminder_day}"></div>
          </div>
          <div class="field"><label class="check"><input type="checkbox" name="email_opt_in" value="1" ${u.email_opt_in ? 'checked' : ''}> <span>Email me reading reminders and dispute follow-ups</span></label></div>
          <button class="btn" type="submit">Save details</button>
        </form>
      </div>
      <div class="card">
        <h2>Change password</h2>
        ${section === 'password' ? errorsBox(errors) : ''}
        <form method="post" action="/account/password">
          ${csrfField(req.csrfToken)}
          <div class="field"><label for="current">Current password</label><input id="current" name="current" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="password">New password <span class="hint">At least 8 characters</span></label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
          <button class="btn secondary" type="submit">Change password</button>
        </form>
      </div>
      <div class="card">
        <h2>Your data</h2>
        <p class="text-2">You own your data. Download everything we hold about you as JSON at any time (POPIA section 23). Photos and bill copies can be downloaded from each property.</p>
        <a class="btn secondary" href="/account/export.json">Download my data</a>
      </div>
      <div class="card">
        <h2>Delete account</h2>
        <p class="text-2">Permanently deletes your account, properties, readings, photos, bills and disputes, and cancels any active subscription. Payment records are kept for 5 years as required by tax law, without your property data.</p>
        ${section === 'delete' ? errorsBox(errors) : ''}
        <form method="post" action="/account/delete" data-confirm="This permanently deletes everything. Continue?">
          ${csrfField(req.csrfToken)}
          <div class="field"><label for="confirm_password">Password</label><input id="confirm_password" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn danger" type="submit">Delete my account</button>
        </form>
      </div>
    </section>`,
  }, status);
}

router.get('/account', (req, res) => accountPage(req, res));

router.post('/account/profile', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const errors = [];
  if (!name) errors.push('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push('Enter a valid email address.');
  if (email !== req.user.email && db.one('SELECT id FROM users WHERE email = ?', email)) errors.push('Another account already uses that email.');
  if (errors.length) return accountPage(req, res, { errors, section: 'profile' }, 422);
  const day = Math.min(28, Math.max(1, Number(req.body.reminder_day) || 1));
  db.run(
    'UPDATE users SET name = ?, email = ?, phone = ?, postal_address = ?, reminder_day = ?, email_opt_in = ? WHERE id = ?',
    name, email, String(req.body.phone || '').slice(0, 30), String(req.body.postal_address || '').slice(0, 200), day, req.body.email_opt_in ? 1 : 0, req.user.id,
  );
  res.redirect('/account?ok=saved');
});

router.post('/account/password', (req, res) => {
  if (!verifyPassword(String(req.body.current || ''), req.user.password_hash)) return accountPage(req, res, { errors: ['Your current password is not correct.'], section: 'password' }, 422);
  const password = String(req.body.password || '');
  if (password.length < 8) return accountPage(req, res, { errors: ['Your new password must be at least 8 characters.'], section: 'password' }, 422);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), req.user.id);
  destroyAllSessions(req.user.id);
  createSession(res, req.user.id);
  res.redirect('/account?ok=password');
});

router.get('/account/export.json', (req, res) => {
  const id = req.user.id;
  const { password_hash: _omit, ...user } = db.one('SELECT * FROM users WHERE id = ?', id);
  const properties = db.all('SELECT * FROM properties WHERE user_id = ?', id).map((p) => {
    const bills = db.all('SELECT * FROM bills WHERE property_id = ?', p.id).map((b) => ({ ...b, lines: db.all('SELECT * FROM bill_lines WHERE bill_id = ?', b.id) }));
    return { ...p, readings: db.all('SELECT * FROM readings WHERE property_id = ?', p.id), bills };
  });
  const disputes = db.all('SELECT * FROM disputes WHERE user_id = ?', id).map((d) => ({ ...d, events: db.all('SELECT * FROM dispute_events WHERE dispute_id = ?', d.id) }));
  const payments = db.all('SELECT id, sku, method, status, amount_cents, reference, created_at, completed_at FROM payments WHERE user_id = ?', id);
  track('data_exported', { req });
  res.set('Content-Disposition', `attachment; filename="${config.brand.toLowerCase()}-export.json"`);
  res.json({ exported_at: nowIso(), user, properties, disputes, payments });
});

router.post('/account/delete', async (req, res, next) => {
  try {
    const user = req.user;
    if (!verifyPassword(String(req.body.password || ''), user.password_hash)) return accountPage(req, res, { errors: ['Your password is not correct.'], section: 'delete' }, 422);
    if (user.sub_status === 'active' && user.sub_token) {
      const r = await payfast.cancelSubscription(user.sub_token).catch(() => ({ ok: false }));
      if (!r.ok) console.error('account delete: PayFast cancel failed for user', user.id, '- cancel manually in the PayFast dashboard');
    }
    const files = userFiles(user.id);
    db.tx(() => {
      // Keep payment records (anonymised link) for tax purposes.
      db.run('UPDATE payments SET user_id = NULL WHERE user_id = ?', user.id);
      db.run('UPDATE events SET user_id = NULL WHERE user_id = ?', user.id);
      db.run('DELETE FROM users WHERE id = ?', user.id);
    });
    files.forEach(deleteUpload);
    destroySession(req, res);
    track('account_deleted', {});
    res.redirect('/?ok=deleted');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
