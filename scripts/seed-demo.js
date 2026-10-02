'use strict';

// Fills a fresh database with a realistic demo: an over-billed homeowner, a
// handful of customers, payments and traffic so every screen has data.
// Usage: DATA_DIR=./data-demo npm run seed

const db = require('../src/db');
const { hashPassword } = require('../src/lib/security');
const { addDays, addMonths, today, nowIso } = require('../src/lib/format');

if (db.one('SELECT COUNT(*) AS n FROM users').n > 0) {
  console.error('Refusing to seed: this database already has users. Point DATA_DIR at an empty folder.');
  process.exit(1);
}

const t = today();
const iso = (date, hour = 9) => `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const pw = hashPassword('demo password');

function user(email, name, createdDaysAgo, extra = {}) {
  const r = db.run(
    'INSERT INTO users (email, password_hash, name, phone, postal_address, created_at, utm_source, referrer, home_until, landlord_until, sub_sku, sub_status, sub_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    email, pw, name, extra.phone || '', extra.address || '', iso(addDays(t, -createdDaysAgo)), extra.utm || null, extra.ref || null,
    extra.home_until || null, extra.landlord_until || null, extra.sub_sku || null, extra.sub_status || null, extra.sub_token || null,
  );
  return Number(r.lastInsertRowid);
}

function pay(userId, email, sku, amount, fee, daysAgo, method = 'payfast', recurring = 0) {
  const at = iso(addDays(t, -daysAgo), 12);
  db.run(
    'INSERT INTO payments (user_id, user_email, sku, method, status, amount_cents, fee_cents, m_payment_id, pf_payment_id, reference, is_recurring, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    userId, email, sku, method, 'complete', amount, fee, `demo-${userId}-${daysAgo}-${sku}`, method === 'payfast' ? `pf-${userId}-${daysAgo}` : null, `MP${String(userId).padStart(5, '0')}`, recurring, at, at,
  );
}

function event(name, daysAgo, anon, userId = null, props = null) {
  db.run('INSERT INTO events (ts, anon_id, user_id, name, path, props) VALUES (?,?,?,?,?,?)', iso(addDays(t, -daysAgo), 8 + (anon.length % 10)), anon, userId, name, '/', props ? JSON.stringify(props) : null);
}

db.tx(() => {
  // The owner (admin) account.
  user('owner@meterproof.co.za', 'MeterProof Owner', 120);

  // Demo homeowner with a Johannesburg water problem.
  const thandi = user('demo@meterproof.co.za', 'Thandi Nkosi', 75, {
    phone: '082 555 0199', address: '12 Jacaranda Street, Melville, Johannesburg, 2092', utm: 'facebook', home_until: addMonths(t, 5),
  });
  const prop = Number(db.run(
    `INSERT INTO properties (user_id, nickname, address, municipality, account_number, account_holder, stand_number, water_meter_no, track_water, track_electricity, dispute_email, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    thandi, 'Home, Melville', '12 Jacaranda Street, Melville', 'johannesburg', '550012345', 'T Nkosi', 'Erf 1234', 'WM-88231', 1, 0, 'billing.disputes@example.gov.za', iso(addDays(t, -75)),
  ).lastInsertRowid);

  // ~0.6 kL/day actual use; readings every month for 7 months.
  const start = addMonths(t, -7);
  let value = 2180;
  for (let i = 0; i <= 7; i++) {
    const date = addMonths(start, i);
    db.run('INSERT INTO readings (property_id, utility, reading_date, value, photo_taken_at, note, created_at) VALUES (?,?,?,?,?,?,?)', prop, 'water', date, Math.round(value * 10) / 10, i > 2 ? `${date}T07:${10 + i}:00` : null, '', iso(date));
    value += 18 + (i % 3);
  }
  const readings = db.all('SELECT * FROM readings WHERE property_id = ? ORDER BY reading_date', prop);

  // Bills: first three accurate, then four inflated estimates at ~R33/kL.
  let billed = readings[0].value;
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1];
    const cur = readings[i];
    const estimated = i >= 4;
    const units = estimated ? Math.round((cur.value - prev.value) * 2.1) : Math.round((cur.value - prev.value) * 10) / 10;
    const currReading = Math.round((billed + units) * 10) / 10;
    const amount = Math.round(units * 3300);
    const billDate = addDays(cur.reading_date, 6);
    const billId = Number(db.run('INSERT INTO bills (property_id, bill_date, due_date, total_due_cents, notes, created_at) VALUES (?,?,?,?,?,?)', prop, billDate, addDays(billDate, 21), amount + 68000, '', iso(billDate)).lastInsertRowid);
    db.run(
      `INSERT INTO bill_lines (bill_id, kind, utility, label, reading_type, prev_reading, curr_reading, prev_date, curr_date, amount_cents) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      billId, 'consumption', 'water', 'Water', estimated ? 'estimated' : 'actual', billed, currReading, prev.reading_date, cur.reading_date, amount,
    );
    db.run("INSERT INTO bill_lines (bill_id, kind, label, amount_cents) VALUES (?, 'charge', 'Property rates', 41000)", billId);
    db.run("INSERT INTO bill_lines (bill_id, kind, label, amount_cents) VALUES (?, 'charge', 'Refuse removal', 27000)", billId);
    if (i >= 6) db.run("INSERT INTO bill_lines (bill_id, kind, label, amount_cents, disputed, dispute_reason) VALUES (?, 'interest', 'Interest', 8600, 1, 'Interest charged on the disputed amount')", billId);
    billed = currReading;
  }
  pay(thandi, 'demo@meterproof.co.za', 'dispute_pack', 29900, 1147, 30);

  // Other customers and free users across 90 days.
  const sources = ['facebook', 'google', 'whatsapp', null, 'ratepayers-assoc', 'facebook', 'google'];
  for (let i = 0; i < 46; i++) {
    const daysAgo = Math.floor((i * 89) / 46);
    const kind = i % 7;
    const email = `customer${i}@example.com`;
    const sub = kind === 1 || kind === 4;
    const landlord = kind === 6 && i % 2 === 0;
    const id = user(email, `Customer ${i}`, daysAgo, {
      utm: sources[i % sources.length],
      home_until: sub || kind === 0 || kind === 3 ? addMonths(t, 1) : null,
      landlord_until: landlord ? addMonths(t, 1) : null,
      sub_sku: landlord ? 'landlord_monthly' : sub ? 'home_monthly' : null,
      sub_status: landlord || sub ? 'active' : null,
    });
    const p = Number(db.run("INSERT INTO properties (user_id, nickname, municipality, created_at) VALUES (?,?,?,?)", id, 'Home', ['johannesburg', 'tshwane', 'ekurhuleni', 'cape-town'][i % 4], iso(addDays(t, -daysAgo))).lastInsertRowid);
    if (i % 3 !== 2) {
      db.run("INSERT INTO bills (property_id, bill_date, created_at) VALUES (?,?,?)", p, addDays(t, -daysAgo), iso(addDays(t, -daysAgo)));
      db.run("INSERT INTO readings (property_id, utility, reading_date, value, created_at) VALUES (?, 'water', ?, 100, ?)", p, addDays(t, -daysAgo), iso(addDays(t, -daysAgo)));
    }
    if (kind === 0 || kind === 3) {
      pay(id, email, 'dispute_pack', 29900, 1147, Math.max(0, daysAgo - 1), i % 5 === 0 ? 'eft' : 'payfast');
      db.run("INSERT INTO disputes (user_id, property_id, title, status, disputed_amount_cents, credit_cents, created_at, updated_at, lodged_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id, p, 'Water over-billing', i % 2 ? 'resolved' : 'lodged', 180000 + i * 9000, i % 2 ? 150000 + i * 7000 : 0, iso(addDays(t, -daysAgo)), nowIso(), addDays(t, -daysAgo));
    }
    if (sub) for (let m = daysAgo; m >= 0; m -= 30) pay(id, email, 'home_monthly', 5900, 340, m, 'payfast', m === daysAgo ? 0 : 1);
    if (landlord) for (let m = daysAgo; m >= 0; m -= 30) pay(id, email, 'landlord_monthly', 24900, 940, m, 'payfast', m === daysAgo ? 0 : 1);
  }
  for (let i = 0; i < 3; i++) event('subscription_cancelled', 5 + i * 7, `anon-c${i}`);

  // Traffic: ~25 visitors a day, a third use the free checker.
  for (let d = 0; d < 30; d++) {
    for (let v = 0; v < 18 + (d % 9); v++) {
      const anon = `anon-${d}-${v}`;
      event('page_view', d, anon);
      if (v % 3 === 0) event('tool_used', d, anon, null, { overbilled: v % 2 === 0 });
    }
  }
});

console.log('Demo data created.');
console.log('  Customer login: demo@meterproof.co.za / demo password');
console.log('  Admin login:    owner@meterproof.co.za / demo password (set ADMIN_EMAILS=owner@meterproof.co.za)');
