'use strict';

const config = require('../config');
const db = require('../db');
const { PLANS, grant, startSubscription, endSubscription } = require('./plans');
const { track } = require('./analytics');
const { sendMail } = require('./mailer');
const { rand, nowIso, prettyDate } = require('./format');
const { randomToken } = require('./security');

function createPayment(user, sku, method, extra = {}) {
  const plan = PLANS[sku];
  const m = randomToken(12);
  const r = db.run(
    'INSERT INTO payments (user_id, user_email, sku, method, status, amount_cents, m_payment_id, raw, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    user.id, user.email, sku, method, 'pending', plan.amountCents, m, JSON.stringify(extra), nowIso(),
  );
  const id = Number(r.lastInsertRowid);
  const reference = `MP${String(id).padStart(5, '0')}`;
  db.run('UPDATE payments SET reference = ? WHERE id = ?', reference, id);
  return db.one('SELECT * FROM payments WHERE id = ?', id);
}

function receiptEmail(user, payment, until) {
  const plan = PLANS[payment.sku];
  sendMail({
    to: user.email,
    subject: `Payment received: ${config.brand} ${plan.name}`,
    text: `Hi ${user.name.split(' ')[0]},\n\nThank you. We received ${rand(payment.amount_cents)} for ${config.brand} ${plan.name}.\n\nYour access runs until ${prettyDate(until, { long: true })}${plan.kind === 'subscription' ? ' and renews automatically each month until you cancel' : ''}.\n\nYou can download your receipt from your Plan page.`,
    cta: { label: 'Open your dashboard', url: `${config.baseUrl}/app` },
  });
}

/**
 * Mark a pending payment complete and grant the plan. Idempotent: returns
 * false when the payment was already processed.
 */
function fulfil(payment, { pfPaymentId = null, feeCents = 0, token = null, raw = null } = {}) {
  const fresh = db.one('SELECT * FROM payments WHERE id = ?', payment.id);
  if (!fresh || fresh.status === 'complete') return false;
  let until = null;
  db.tx(() => {
    db.run(
      'UPDATE payments SET status = ?, pf_payment_id = COALESCE(?, pf_payment_id), fee_cents = ?, completed_at = ?, raw = COALESCE(?, raw) WHERE id = ?',
      'complete', pfPaymentId, feeCents, nowIso(), raw, fresh.id,
    );
    if (fresh.user_id) {
      until = grant(fresh.user_id, fresh.sku);
      if (PLANS[fresh.sku].kind === 'subscription') startSubscription(fresh.user_id, fresh.sku, token);
    }
  });
  const user = fresh.user_id ? db.one('SELECT * FROM users WHERE id = ?', fresh.user_id) : null;
  track('payment_completed', { userId: fresh.user_id, props: { sku: fresh.sku, amount: fresh.amount_cents, method: fresh.method } });
  if (user) receiptEmail(user, fresh, until);
  return true;
}

// A monthly PayFast renewal: new payment row, access extended by a month.
function recordRenewal(original, { pfPaymentId, amountCents, feeCents, raw }) {
  if (db.one('SELECT id FROM payments WHERE pf_payment_id = ?', pfPaymentId)) return false;
  let until = null;
  db.tx(() => {
    db.run(
      'INSERT INTO payments (user_id, user_email, sku, method, status, amount_cents, fee_cents, m_payment_id, pf_payment_id, reference, is_recurring, raw, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      original.user_id, original.user_email, original.sku, 'payfast', 'complete', amountCents, feeCents, `${original.m_payment_id}-${pfPaymentId}`, pfPaymentId, original.reference, 1, raw, nowIso(), nowIso(),
    );
    if (original.user_id) {
      until = grant(original.user_id, original.sku);
      db.run("UPDATE users SET sub_status = 'active' WHERE id = ?", original.user_id);
    }
  });
  track('subscription_renewed', { userId: original.user_id, props: { sku: original.sku, amount: amountCents } });
  const user = original.user_id ? db.one('SELECT * FROM users WHERE id = ?', original.user_id) : null;
  if (user) receiptEmail(user, { ...original, amount_cents: amountCents }, until);
  return true;
}

function cancelled(userId) {
  endSubscription(userId, 'cancelled');
  track('subscription_cancelled', { userId });
}

module.exports = { createPayment, fulfil, recordRenewal, cancelled };
