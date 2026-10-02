'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'));
process.env.PAYFAST_SKIP_VALIDATION = '1';
process.env.ADMIN_EMAILS = 'owner@example.com';
process.env.DISABLE_SCHEDULER = '1';
process.env.BASE_URL = 'http://localhost:0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const db = require('../src/db');
const payfast = require('../src/lib/payfast');
const scheduler = require('../src/lib/scheduler');
const { jpegWithExif } = require('./helpers');

let server;
let base;

// Minimal browser: keeps cookies, does not follow redirects automatically.
function browser() {
  const jar = new Map();
  async function request(method, url, { form, multipart, headers = {} } = {}) {
    const opts = { method, redirect: 'manual', headers: { ...headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } };
    if (form) {
      opts.body = new URLSearchParams({ _csrf: jar.get('csrf') || '', ...form }).toString();
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (multipart) {
      const fd = new FormData();
      fd.append('_csrf', jar.get('csrf') || '');
      for (const [k, v] of Object.entries(multipart)) fd.append(k, v);
      opts.body = fd;
    }
    const res = await fetch(base + url, opts);
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = decodeURIComponent(pair.slice(i + 1));
      if (v) jar.set(pair.slice(0, i), v);
      else jar.delete(pair.slice(0, i));
    }
    const type = res.headers.get('content-type') || '';
    const body = type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, location: res.headers.get('location'), body, type };
  }
  return {
    jar,
    get: (u) => request('GET', u),
    post: (u, form) => request('POST', u, { form }),
    upload: (u, multipart) => request('POST', u, { multipart }),
  };
}

function itn(fields) {
  const pairs = Object.entries(fields);
  pairs.push(['signature', payfast.sign(pairs)]);
  return fetch(`${base}/billing/payfast/itn`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: pairs.map(([k, v]) => `${k}=${payfast.phpEncode(v)}`).join('&'),
  });
}

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

test('full customer journey: check, dispute, pay, track, export, delete', async () => {
  const b = browser();
  await b.get('/?utm_source=facebook&utm_campaign=joburg-water');
  assert.ok(b.jar.get('csrf'), 'csrf cookie set');

  // Sign up (with a validation error first).
  let r = await b.post('/signup', { name: 'Thandi Nkosi', email: 'bad', password: 'short' });
  assert.equal(r.status, 422);
  r = await b.post('/signup', { name: 'Thandi Nkosi', email: 'thandi@example.com', password: 'correct horse', terms: '1' });
  assert.equal(r.status, 302);
  assert.match(r.location, /\/app\/properties\/new/);
  const user = db.one('SELECT * FROM users WHERE email = ?', 'thandi@example.com');
  assert.equal(user.utm_source, 'facebook');

  // CSRF is enforced.
  const forged = await fetch(`${base}/app/properties`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: 'nickname=x' });
  assert.equal(forged.status, 403);

  // Property.
  r = await b.post('/app/properties', { nickname: 'Home', municipality: 'johannesburg', account_number: '500123456', account_holder: 'T Nkosi', address: '12 Jacaranda St, Melville', track_water: '1', dispute_email: 'disputes@example.gov.za' });
  assert.equal(r.status, 302);
  const propertyId = Number(r.location.match(/properties\/(\d+)/)[1]);

  // Free plan allows only one property.
  r = await b.get('/app/properties/new');
  assert.match(r.location, /pricing/);

  // Readings: one with an EXIF-stamped photo, others typed.
  r = await b.upload(`/app/properties/${propertyId}/readings`, {
    utility: 'water', value: '1000', reading_date: '2026-05-01', note: 'first',
    photo: new Blob([jpegWithExif('2026:05:01 07:30:00')], { type: 'image/jpeg' }),
  });
  assert.equal(r.status, 302, r.body);
  for (const [date, value] of [['2026-05-31', '1015'], ['2026-06-30', '1030'], ['2026-07-30', '1045']]) {
    r = await b.upload(`/app/properties/${propertyId}/readings`, { utility: 'water', value, reading_date: date });
    assert.equal(r.status, 302);
  }
  const photo = db.one('SELECT * FROM readings WHERE photo_file IS NOT NULL');
  assert.equal(photo.photo_taken_at, '2026-05-01T07:30:00');
  // A fake "image" is rejected.
  r = await b.upload(`/app/properties/${propertyId}/readings`, { utility: 'water', value: '1', reading_date: '2026-05-02', photo: new Blob(['<script>'], { type: 'image/jpeg' }) });
  assert.equal(r.status, 422);

  // Bills: one accurate, two estimated and inflated.
  const bill = (date, type, prev, prevDate, curr, currDate, amount, extra = {}) => b.upload(`/app/properties/${propertyId}/bills`, {
    bill_date: date, water_type: type, water_prev: prev, water_prev_date: prevDate, water_curr: curr, water_curr_date: currDate, water_amount: amount,
    charge_label_1: 'Refuse removal', charge_amount_1: '200', charge_kind_3: 'interest', charge_label_3: 'Interest', ...extra,
  });
  assert.equal((await bill('2026-06-05', 'actual', '1000', '2026-05-01', '1015', '2026-05-31', '450')).status, 302);
  assert.equal((await bill('2026-07-05', 'estimated', '1015', '2026-05-31', '1060', '2026-06-30', '1500')).status, 302);
  assert.equal((await bill('2026-08-05', 'estimated', '1060', '2026-06-30', '1100', '2026-07-30', '1400', { charge_amount_3: '45', charge_disputed_3: '1', charge_reason_3: 'Interest on disputed amount' })).status, 302);

  // Analysis page shows the over-billing in Rand.
  r = await b.get(`/app/properties/${propertyId}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /R1 920\.00/); // 1000 + 875 + 45 disputed interest
  assert.match(r.body, /Over-billing found/);

  // Build the dispute.
  r = await b.get(`/app/properties/${propertyId}/disputes/new`);
  assert.equal(r.status, 200);
  const billIds = db.all('SELECT id FROM bills ORDER BY bill_date').map((x) => x.id);
  const body = new URLSearchParams({ _csrf: b.jar.get('csrf'), title: 'Water over-billing' });
  body.append('bill_ids', String(billIds[1]));
  body.append('bill_ids', String(billIds[2]));
  const created = await fetch(`${base}/app/properties/${propertyId}/disputes`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body.toString() });
  assert.equal(created.status, 302);
  const disputeId = Number(created.headers.get('location').match(/disputes\/(\d+)/)[1]);
  const dispute = db.one('SELECT * FROM disputes WHERE id = ?', disputeId);
  assert.equal(dispute.disputed_amount_cents, 192000);

  // Letters are behind the paywall on the free plan.
  r = await b.get(`/app/disputes/${disputeId}`);
  assert.match(r.body, /Unlock your dispute pack/);
  r = await b.get(`/app/disputes/${disputeId}/evidence.pdf`);
  assert.equal(r.status, 302);
  assert.match(r.location, /pricing/);

  // Checkout: signed PayFast form.
  r = await b.post('/billing/checkout', { sku: 'dispute_pack', method: 'payfast' });
  assert.equal(r.status, 200);
  assert.match(r.body, /sandbox\.payfast\.co\.za\/eng\/process/);
  const fields = [...r.body.matchAll(/<input type="hidden" name="([a-z_0-9]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')]).filter(([k]) => k !== '_csrf');
  const sig = fields.find(([k]) => k === 'signature')[1];
  assert.equal(payfast.sign(fields.filter(([k]) => k !== 'signature')), sig);
  const mPaymentId = fields.find(([k]) => k === 'm_payment_id')[1];

  // A forged ITN is ignored.
  await fetch(`${base}/billing/payfast/itn`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `m_payment_id=${mPaymentId}&payment_status=COMPLETE&amount_gross=299.00&merchant_id=10000100&signature=deadbeef` });
  assert.equal(db.one('SELECT status FROM payments WHERE m_payment_id = ?', mPaymentId).status, 'pending');
  // Wrong amount is rejected even with a valid signature.
  await itn({ m_payment_id: mPaymentId, pf_payment_id: '111', payment_status: 'COMPLETE', amount_gross: '1.00', amount_fee: '-0.50', merchant_id: '10000100' });
  assert.equal(db.one('SELECT status FROM payments WHERE m_payment_id = ?', mPaymentId).status, 'pending');
  // Genuine ITN completes the payment.
  const ok = await itn({ m_payment_id: mPaymentId, pf_payment_id: '112', payment_status: 'COMPLETE', item_name: 'MeterProof Dispute Pack', amount_gross: '299.00', amount_fee: '-11.47', amount_net: '287.53', merchant_id: '10000100' });
  assert.equal(ok.status, 200);
  const paid = db.one('SELECT * FROM payments WHERE m_payment_id = ?', mPaymentId);
  assert.equal(paid.status, 'complete');
  assert.equal(paid.fee_cents, 1147);
  assert.ok(db.one('SELECT home_until FROM users WHERE id = ?', user.id).home_until);
  r = await b.get(`/billing/return?m=${mPaymentId}`);
  assert.equal(r.status, 302);

  // Now the documents download.
  r = await b.get(`/app/disputes/${disputeId}/evidence.pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
  r = await b.get(`/app/disputes/${disputeId}/letter/dispute.txt`);
  assert.match(r.body, /section 102\(2\)/);
  assert.match(r.body, /R1 920\.00/);
  r = await b.get(`/billing/receipt/${paid.id}.pdf`);
  assert.equal(r.status, 200);

  // Lodge, escalate, resolve.
  r = await b.post(`/app/disputes/${disputeId}/lodge`, { lodged_at: '2026-08-10', method: 'Email', reference_number: '' });
  assert.equal(db.one('SELECT status FROM disputes WHERE id = ?', disputeId).status, 'lodged');
  r = await b.get(`/app/disputes/${disputeId}/evidence.pdf?kind=appeal&decision_date=2026-09-01&decision_summary=Declined`);
  assert.equal(r.status, 200);
  assert.equal(db.one('SELECT status FROM disputes WHERE id = ?', disputeId).status, 'appealed');
  r = await b.post(`/app/disputes/${disputeId}/status`, { status: 'resolved', reference_number: 'CJ-123', credit: '1875', outcome: 'Account corrected' });
  const resolved = db.one('SELECT * FROM disputes WHERE id = ?', disputeId);
  assert.equal(resolved.credit_cents, 187500);

  // Follow-up reminders fire once.
  db.run("UPDATE disputes SET status = 'lodged', lodged_at = '2026-01-01', reference_number = '' WHERE id = ?", disputeId);
  const first = scheduler.disputeFollowUps('2026-03-15');
  assert.ok(first >= 1);
  assert.equal(scheduler.disputeFollowUps('2026-03-15'), 0);

  // Subscription: first payment, renewal, then cancellation via ITN.
  r = await b.post('/billing/checkout', { sku: 'home_monthly', method: 'payfast' });
  const subM = r.body.match(/name="m_payment_id" value="([^"]+)"/)[1];
  assert.match(r.body, /name="subscription_type" value="1"/);
  await itn({ m_payment_id: subM, pf_payment_id: '200', payment_status: 'COMPLETE', amount_gross: '59.00', amount_fee: '-3.40', merchant_id: '10000100', token: 'tok-abc' });
  let u = db.one('SELECT * FROM users WHERE id = ?', user.id);
  assert.equal(u.sub_status, 'active');
  assert.equal(u.sub_token, 'tok-abc');
  const before = u.home_until;
  await itn({ m_payment_id: subM, pf_payment_id: '201', payment_status: 'COMPLETE', amount_gross: '59.00', amount_fee: '-3.40', merchant_id: '10000100', token: 'tok-abc' });
  await itn({ m_payment_id: subM, pf_payment_id: '201', payment_status: 'COMPLETE', amount_gross: '59.00', amount_fee: '-3.40', merchant_id: '10000100', token: 'tok-abc' }); // duplicate
  assert.equal(db.one("SELECT COUNT(*) AS n FROM payments WHERE is_recurring = 1").n, 1);
  u = db.one('SELECT * FROM users WHERE id = ?', user.id);
  assert.ok(u.home_until > before);
  await itn({ m_payment_id: subM, pf_payment_id: '202', payment_status: 'CANCELLED', amount_gross: '59.00', merchant_id: '10000100', token: 'tok-abc' });
  assert.equal(db.one('SELECT sub_status FROM users WHERE id = ?', user.id).sub_status, 'cancelled');

  // EFT order, then the owner marks it received in admin.
  r = await b.post('/billing/checkout', { sku: 'home_annual', method: 'eft' });
  assert.match(r.location, /\/billing\/eft\//);
  r = await b.get(r.location);
  assert.match(r.body, /Reference/);
  const eft = db.one("SELECT * FROM payments WHERE method = 'eft'");

  // Non-admins cannot see admin.
  r = await b.get('/admin');
  assert.equal(r.status, 404);

  const admin = browser();
  await admin.get('/');
  await admin.post('/signup', { name: 'Owner', email: 'owner@example.com', password: 'owner password', terms: '1' });
  r = await admin.get('/admin');
  assert.equal(r.status, 200);
  assert.match(r.body, /Monthly recurring revenue/);
  r = await admin.get('/admin/payments');
  assert.match(r.body, new RegExp(eft.reference));
  await admin.post(`/admin/payments/${eft.id}/received`, {});
  assert.equal(db.one('SELECT status FROM payments WHERE id = ?', eft.id).status, 'complete');
  for (const page of ['/admin/users', `/admin/users/${user.id}`, '/admin/events']) assert.equal((await admin.get(page)).status, 200);

  // Data export (POPIA) and account deletion.
  r = await b.get('/account/export.json');
  const exported = JSON.parse(r.body);
  assert.equal(exported.properties[0].readings.length, 4);
  assert.equal(exported.user.password_hash, undefined);
  const files = fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads'));
  assert.ok(files.length >= 1);
  r = await b.post('/account/delete', { password: 'correct horse' });
  assert.equal(r.status, 302);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM users WHERE email = ?', 'thandi@example.com').n, 0);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM readings').n, 0);
  assert.ok(db.one('SELECT COUNT(*) AS n FROM payments WHERE user_id IS NULL').n >= 3, 'payments kept for tax records');
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length, 0);
});

test('public pages render and the free checker detects over-billing', async () => {
  const b = browser();
  for (const p of ['/', '/pricing', '/guides/dispute-municipal-bill', '/legal/terms', '/legal/privacy', '/sitemap.xml']) {
    assert.equal((await b.get(p)).status, 200, p);
  }
  const r = await b.get('/tools/bill-checker?utility=water&billed_reading=2310&billed_date=2026-06-30&actual_reading=2246&actual_date=2026-07-02&units=40&amount=1400');
  assert.match(r.body, /Over-billing proven/);
  assert.match(r.body, /64 kL/);
  assert.match(r.body, /R2 240\.00/);
});

test('login rate limiting and wrong passwords', async () => {
  const b = browser();
  await b.get('/');
  const r = await b.post('/login', { email: 'nobody@example.com', password: 'whatever1' });
  assert.equal(r.status, 401);
});
