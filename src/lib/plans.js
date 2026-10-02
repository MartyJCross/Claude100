'use strict';

const db = require('../db');
const { today, addMonths, addDays, nowIso } = require('./format');

// Everything sold. Prices in cents (ZAR). "once" SKUs are paid up-front for a
// fixed period; "subscription" SKUs renew monthly through PayFast.
const PLANS = {
  dispute_pack: {
    sku: 'dispute_pack',
    name: 'Dispute Pack',
    tier: 'home',
    kind: 'once',
    amountCents: 29900,
    months: 6,
    summary: 'One property · 6 months · no subscription',
  },
  home_monthly: {
    sku: 'home_monthly',
    name: 'Homeowner',
    tier: 'home',
    kind: 'subscription',
    amountCents: 5900,
    months: 1,
    summary: 'One property · billed monthly · cancel any time',
  },
  home_annual: {
    sku: 'home_annual',
    name: 'Homeowner (12 months)',
    tier: 'home',
    kind: 'once',
    amountCents: 59000,
    months: 12,
    summary: 'One property · 12 months prepaid (2 months free)',
  },
  landlord_monthly: {
    sku: 'landlord_monthly',
    name: 'Landlord',
    tier: 'landlord',
    kind: 'subscription',
    amountCents: 24900,
    months: 1,
    summary: 'Up to 15 properties · billed monthly · cancel any time',
  },
  landlord_annual: {
    sku: 'landlord_annual',
    name: 'Landlord (12 months)',
    tier: 'landlord',
    kind: 'once',
    amountCents: 249000,
    months: 12,
    summary: 'Up to 15 properties · 12 months prepaid (2 months free)',
  },
};

const TIERS = {
  free: { label: 'Free', properties: 1 },
  home: { label: 'Homeowner', properties: 1 },
  landlord: { label: 'Landlord', properties: 15 },
};

// A few days' grace so a late PayFast renewal never locks anyone out.
const GRACE_DAYS = 3;

function activeUntil(dateStr, on = today()) {
  return !!dateStr && dateStr >= addDays(on, -GRACE_DAYS);
}

function tierOf(user, on = today()) {
  if (!user) return 'free';
  if (activeUntil(user.landlord_until, on)) return 'landlord';
  if (activeUntil(user.home_until, on)) return 'home';
  return 'free';
}

const isPaid = (user) => tierOf(user) !== 'free';
const propertyLimit = (user) => TIERS[tierOf(user)].properties;

function paidUntil(user) {
  const t = tierOf(user);
  if (t === 'landlord') return user.landlord_until;
  if (t === 'home') return user.home_until;
  return null;
}

// Extend the user's access for a purchased SKU. Returns the new end date.
function grant(userId, sku) {
  const plan = PLANS[sku];
  if (!plan) throw new Error(`Unknown plan ${sku}`);
  const column = plan.tier === 'landlord' ? 'landlord_until' : 'home_until';
  const user = db.one('SELECT * FROM users WHERE id = ?', userId);
  if (!user) return null;
  const current = user[column];
  const base = current && current > today() ? current : today();
  const until = addMonths(base, plan.months);
  db.run(`UPDATE users SET ${column} = ? WHERE id = ?`, until, userId);
  return until;
}

function startSubscription(userId, sku, token) {
  db.run('UPDATE users SET sub_sku = ?, sub_status = ?, sub_token = ?, sub_started_at = ?, sub_cancelled_at = NULL WHERE id = ?', sku, 'active', token || null, nowIso(), userId);
}

function endSubscription(userId, status = 'cancelled') {
  db.run('UPDATE users SET sub_status = ?, sub_cancelled_at = ? WHERE id = ?', status, nowIso(), userId);
}

module.exports = { PLANS, TIERS, GRACE_DAYS, tierOf, isPaid, propertyLimit, paidUntil, grant, startSubscription, endSubscription };
