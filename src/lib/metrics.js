'use strict';

// Business metrics for the admin dashboard, computed straight from the database.

const db = require('../db');
const { PLANS, GRACE_DAYS } = require('./plans');
const { today, addDays, addMonths, MONTHS } = require('./format');

const sinceIso = (days) => new Date(Date.now() - days * 86400000).toISOString();

function count(sql, ...params) {
  return db.one(sql, ...params).n || 0;
}

function overview() {
  const t = today();
  const graceDate = addDays(t, -GRACE_DAYS);
  const d30 = sinceIso(30);
  const d7 = sinceIso(7);

  const users = count('SELECT COUNT(*) AS n FROM users');
  const signups30 = count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', d30);
  const signups7 = count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', d7);
  const activated = count(`SELECT COUNT(DISTINCT p.user_id) AS n FROM properties p WHERE EXISTS (SELECT 1 FROM bills b WHERE b.property_id = p.id) AND EXISTS (SELECT 1 FROM readings r WHERE r.property_id = p.id)`);
  const paying = count('SELECT COUNT(*) AS n FROM users WHERE home_until >= ? OR landlord_until >= ?', graceDate, graceDate);

  const subs = db.all("SELECT sub_sku, COUNT(*) AS n FROM users WHERE sub_status = 'active' AND (home_until >= ? OR landlord_until >= ?) GROUP BY sub_sku", graceDate, graceDate);
  const mrrCents = subs.reduce((s, r) => s + (PLANS[r.sub_sku] ? PLANS[r.sub_sku].amountCents * r.n : 0), 0);
  const activeSubs = subs.reduce((s, r) => s + r.n, 0);
  // Annual prepaid plans contribute 1/12 of their price to recurring revenue while active.
  const annual = db.all(
    `SELECT p.sku, COUNT(*) AS n FROM payments p WHERE p.status = 'complete' AND p.sku IN ('home_annual','landlord_annual') AND p.completed_at >= ? GROUP BY p.sku`,
    new Date(`${addMonths(t, -12)}T00:00:00Z`).toISOString(),
  );
  const annualMrrCents = annual.reduce((s, r) => s + Math.round((PLANS[r.sku].amountCents * r.n) / 12), 0);

  const rev30 = db.one("SELECT COALESCE(SUM(amount_cents),0) AS gross, COALESCE(SUM(fee_cents),0) AS fees, COUNT(*) AS n FROM payments WHERE status = 'complete' AND completed_at >= ?", d30);
  const revAll = db.one("SELECT COALESCE(SUM(amount_cents),0) AS gross, COUNT(DISTINCT user_id) AS customers FROM payments WHERE status = 'complete' AND amount_cents > 0");
  const cancels30 = count("SELECT COUNT(*) AS n FROM events WHERE name = 'subscription_cancelled' AND ts >= ?", d30);
  const churnRate = activeSubs + cancels30 ? cancels30 / (activeSubs + cancels30) : 0;

  // Funnel for the last 30 days, by cohort of visitors/signups in that window.
  const visitors = count("SELECT COUNT(DISTINCT anon_id) AS n FROM events WHERE name = 'page_view' AND ts >= ?", d30);
  const toolUsers = count("SELECT COUNT(DISTINCT anon_id) AS n FROM events WHERE name = 'tool_used' AND ts >= ?", d30);
  const cohortActivated = count(
    `SELECT COUNT(*) AS n FROM users u WHERE u.created_at >= ? AND EXISTS (SELECT 1 FROM properties p WHERE p.user_id = u.id AND EXISTS (SELECT 1 FROM bills b WHERE b.property_id = p.id))`,
    d30,
  );
  const cohortDispute = count('SELECT COUNT(*) AS n FROM users u WHERE u.created_at >= ? AND EXISTS (SELECT 1 FROM disputes d WHERE d.user_id = u.id)', d30);
  const cohortPaid = count("SELECT COUNT(*) AS n FROM users u WHERE u.created_at >= ? AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'complete' AND p.amount_cents > 0)", d30);

  const outcomes = db.one(
    `SELECT COUNT(*) AS disputes,
            COALESCE(SUM(CASE WHEN status != 'draft' THEN 1 ELSE 0 END),0) AS lodged,
            COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END),0) AS resolved,
            COALESCE(SUM(disputed_amount_cents),0) AS disputed,
            COALESCE(SUM(credit_cents),0) AS credited
       FROM disputes`,
  );

  return {
    users,
    signups7,
    signups30,
    activated,
    paying,
    activeSubs,
    subs,
    mrrCents,
    annualMrrCents,
    arrCents: (mrrCents + annualMrrCents) * 12,
    rev30,
    revAll,
    arpuCents: revAll.customers ? Math.round(revAll.gross / revAll.customers) : 0,
    churnRate,
    cancels30,
    funnel: { visitors, toolUsers, signups: signups30, activated: cohortActivated, dispute: cohortDispute, paid: cohortPaid },
    outcomes,
  };
}

function signupsByDay(days = 30) {
  const rows = db.all("SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY d", sinceIso(days));
  const map = new Map(rows.map((r) => [r.d, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, n: map.get(d) || 0 });
  }
  return out;
}

function revenueByMonth(months = 12) {
  const rows = db.all("SELECT substr(completed_at, 1, 7) AS m, SUM(amount_cents) AS gross, SUM(fee_cents) AS fees FROM payments WHERE status = 'complete' GROUP BY m");
  const map = new Map(rows.map((r) => [r.m, r]));
  const out = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const r = map.get(key);
    out.push({ month: key, label: `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`, gross: r ? r.gross : 0, fees: r ? r.fees : 0 });
  }
  return out;
}

function topSources(limit = 8) {
  return db.all(
    `SELECT COALESCE(NULLIF(utm_source, ''), NULLIF(referrer, ''), 'direct') AS source, COUNT(*) AS signups,
            SUM(CASE WHEN home_until IS NOT NULL OR landlord_until IS NOT NULL THEN 1 ELSE 0 END) AS paid
       FROM users GROUP BY source ORDER BY signups DESC LIMIT ?`,
    limit,
  );
}

module.exports = { overview, signupsByDay, revenueByMonth, topSources };
