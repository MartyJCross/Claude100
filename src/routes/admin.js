'use strict';

const express = require('express');
const db = require('../db');
const { html } = require('../lib/html');
const { render, notFound } = require('../lib/render');
const { csrfField } = require('../views/layout');
const { requireAdmin } = require('../lib/security');
const metrics = require('../lib/metrics');
const { PLANS, tierOf, TIERS, paidUntil, grant } = require('../lib/plans');
const { fulfil } = require('../lib/billing');
const { columns, hbars } = require('../views/charts');
const { rand, prettyDate, num } = require('../lib/format');

const router = express.Router();
router.use('/admin', requireAdmin);

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');

function adminNav(active) {
  const l = (href, label) => html`<a href="${href}" class="btn small ${active === href ? '' : 'secondary'}">${label}</a>`;
  return html`<div class="row" style="margin-bottom:20px">${l('/admin', 'Metrics')}${l('/admin/users', 'Users')}${l('/admin/payments', 'Payments')}${l('/admin/events', 'Events')}</div>`;
}

router.get('/admin', (req, res) => {
  const m = metrics.overview();
  const days = metrics.signupsByDay(30);
  const months = metrics.revenueByMonth(12);
  const sources = metrics.topSources();
  const f = m.funnel;
  const tile = (label, value, sub = '') => html`<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>`;
  render(req, res, {
    title: 'Admin · Metrics',
    active: 'admin',
    noindex: true,
    body: html`<section class="wrap page">
      <h1>Business metrics</h1>
      ${adminNav('/admin')}
      <div class="card" style="margin-bottom:16px">
        <div class="label muted">Monthly recurring revenue</div>
        <div class="hero-figure">${rand(m.mrrCents + m.annualMrrCents, { decimals: 0 })}</div>
        <p class="text-2" style="margin:4px 0 0">${rand(m.mrrCents, { decimals: 0 })} from ${m.activeSubs} monthly ${m.activeSubs === 1 ? 'subscription' : 'subscriptions'} + ${rand(m.annualMrrCents, { decimals: 0 })} from annual plans · ARR run-rate ${rand(m.arrCents, { decimals: 0 })}</p>
      </div>
      <div class="tiles">
        ${tile('Revenue, last 30 days', rand(m.rev30.gross, { decimals: 0 }), `${m.rev30.n} payments · fees ${rand(m.rev30.fees, { decimals: 0 })}`)}
        ${tile('Net after fees, 30 days', rand(m.rev30.gross - m.rev30.fees, { decimals: 0 }))}
        ${tile('Lifetime revenue', rand(m.revAll.gross, { decimals: 0 }), `${m.revAll.customers} paying customers`)}
        ${tile('Revenue per customer', rand(m.arpuCents, { decimals: 0 }))}
        ${tile('Paying now', num(m.paying), `${m.activeSubs} on subscriptions`)}
        ${tile('Subscription churn, 30 days', pct(m.cancels30, m.activeSubs + m.cancels30), `${m.cancels30} cancelled`)}
        ${tile('Users', num(m.users), `+${m.signups7} this week · +${m.signups30} in 30 days`)}
        ${tile('Activated users', num(m.activated), `${pct(m.activated, m.users)} have a bill and a reading`)}
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">${columns({
          title: 'Sign-ups per day',
          sub: 'Last 30 days',
          categories: days.map((d) => prettyDate(d.date).replace(/ \d{4}$/, '')),
          endLabels: true,
          integer: true,
          series: [{ name: 'Sign-ups', cls: 'solo', values: days.map((d) => d.n), tips: days.map((d) => `${prettyDate(d.date)}\n${d.n} sign-up${d.n === 1 ? '' : 's'}`) }],
          fmt: (v) => num(v, 0),
          height: 180,
        })}</div>
        <div class="card">${columns({
          title: 'Revenue per month',
          sub: 'Gross, Rand, last 12 months',
          categories: months.map((x) => x.label.slice(0, 3)),
          series: [{ name: 'Revenue', cls: 'solo', values: months.map((x) => x.gross / 100), tips: months.map((x) => `${x.label}\n${rand(x.gross)} gross\n${rand(x.gross - x.fees)} net`) }],
          fmt: (v) => (v >= 1000 ? `R${num(v / 1000, 1)}k` : `R${num(v, 0)}`),
          height: 180,
        })}</div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">${hbars({
          title: 'Funnel, last 30 days',
          sub: 'Visitors → sign-ups, then what those sign-ups went on to do',
          rows: [
            { label: 'Visitors', value: f.visitors, display: num(f.visitors) },
            { label: 'Used free checker', value: f.toolUsers, display: `${num(f.toolUsers)} · ${pct(f.toolUsers, f.visitors)}` },
            { label: 'Signed up', value: f.signups, display: `${num(f.signups)} · ${pct(f.signups, f.visitors)}` },
            { label: 'Added a bill', value: f.activated, display: `${num(f.activated)} · ${pct(f.activated, f.signups)}` },
            { label: 'Built a dispute', value: f.dispute, display: `${num(f.dispute)} · ${pct(f.dispute, f.signups)}` },
            { label: 'Paid', value: f.paid, display: `${num(f.paid)} · ${pct(f.paid, f.signups)}` },
          ],
        })}</div>
        <div class="card">
          <div class="chart-title">Customer outcomes</div>
          <div class="chart-sub">Your best marketing numbers</div>
          <div class="tiles">
            ${tile('Disputes created', num(m.outcomes.disputes), `${m.outcomes.lodged} lodged · ${m.outcomes.resolved} resolved`)}
            ${tile('Amount disputed', rand(m.outcomes.disputed, { decimals: 0 }))}
            ${tile('Credits won', rand(m.outcomes.credited, { decimals: 0 }))}
          </div>
          <h3 style="margin-top:18px">Top acquisition sources</h3>
          <div class="table-wrap"><table><thead><tr><th>Source</th><th class="num">Sign-ups</th><th class="num">Paid</th><th class="num">Conv.</th></tr></thead><tbody>
            ${sources.map((s) => html`<tr><td>${s.source}</td><td class="num">${s.signups}</td><td class="num">${s.paid}</td><td class="num">${pct(s.paid, s.signups)}</td></tr>`)}
          </tbody></table></div>
        </div>
      </div>

      <details class="card" style="margin-top:16px"><summary><strong>Data tables</strong> (chart values)</summary>
        <div class="grid-2" style="margin-top:12px">
          <div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">Gross</th><th class="num">Fees</th></tr></thead><tbody>${months.map((x) => html`<tr><td>${x.label}</td><td class="num">${rand(x.gross)}</td><td class="num">${rand(x.fees)}</td></tr>`)}</tbody></table></div>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Sign-ups</th></tr></thead><tbody>${days.slice().reverse().map((d) => html`<tr><td>${d.date}</td><td class="num">${d.n}</td></tr>`)}</tbody></table></div>
        </div>
      </details>
    </section>`,
  });
});

router.get('/admin/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const users = q
    ? db.all('SELECT * FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 200', `%${q}%`, `%${q}%`)
    : db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 200');
  render(req, res, {
    title: 'Admin · Users',
    active: 'admin',
    noindex: true,
    body: html`<section class="wrap page"><h1>Users</h1>${adminNav('/admin/users')}
      <form method="get" class="row" style="margin-bottom:12px"><input name="q" type="text" placeholder="Search email or name" value="${q}" style="max-width:320px"><button class="btn secondary small" type="submit">Search</button></form>
      <div class="table-wrap"><table><thead><tr><th>User</th><th>Plan</th><th>Until</th><th>Source</th><th>Joined</th><th>Last login</th></tr></thead><tbody>
        ${users.map((u) => html`<tr><td><a href="/admin/users/${u.id}">${u.email}</a><br><span class="muted">${u.name}</span></td><td>${TIERS[tierOf(u)].label}${u.sub_status === 'active' ? ' (sub)' : ''}</td><td>${paidUntil(u) ? prettyDate(paidUntil(u)) : '—'}</td><td>${u.utm_source || u.referrer || 'direct'}</td><td>${prettyDate(u.created_at.slice(0, 10))}</td><td>${u.last_login_at ? prettyDate(u.last_login_at.slice(0, 10)) : '—'}</td></tr>`)}
      </tbody></table></div></section>`,
  });
});

router.get('/admin/users/:id', (req, res) => {
  const u = db.one('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return notFound(req, res);
  const props = db.all('SELECT p.*, (SELECT COUNT(*) FROM bills b WHERE b.property_id = p.id) AS bills, (SELECT COUNT(*) FROM readings r WHERE r.property_id = p.id) AS readings FROM properties p WHERE p.user_id = ?', u.id);
  const payments = db.all('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC', u.id);
  const disputes = db.all('SELECT * FROM disputes WHERE user_id = ? ORDER BY created_at DESC', u.id);
  const events = db.all('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 40', u.id);
  render(req, res, {
    title: `Admin · ${u.email}`,
    active: 'admin',
    noindex: true,
    body: html`<section class="wrap page stack"><div><div class="crumbs"><a href="/admin/users">Users</a></div><h1>${u.name}</h1>
      <p class="muted">${u.email} · ${u.phone || 'no phone'} · joined ${prettyDate(u.created_at.slice(0, 10))} · plan ${TIERS[tierOf(u)].label}${paidUntil(u) ? ` until ${prettyDate(paidUntil(u))}` : ''} · subscription ${u.sub_status || 'none'}</p></div>
      <div class="card"><h2>Grant access</h2><p class="muted">For support cases or refunds-in-kind. Recorded as a R0 payment.</p>
        <form method="post" action="/admin/users/${u.id}/grant" class="row">${csrfField(req.csrfToken)}
          <select name="sku" style="max-width:280px">${Object.values(PLANS).filter((p) => p.kind === 'once').map((p) => html`<option value="${p.sku}">${p.name} (${p.months} months)</option>`)}</select>
          <button class="btn small" type="submit">Grant</button></form></div>
      <div class="card"><h2>Properties</h2>${props.length ? html`<ul>${props.map((p) => html`<li>${p.nickname} · ${p.municipality} · ${p.readings} readings · ${p.bills} bills</li>`)}</ul>` : html`<p class="muted">None</p>`}</div>
      <div class="card"><h2>Disputes</h2>${disputes.length ? html`<ul>${disputes.map((d) => html`<li>${d.title} · ${d.status} · ${rand(d.disputed_amount_cents)}${d.credit_cents ? ` · credited ${rand(d.credit_cents)}` : ''}</li>`)}</ul>` : html`<p class="muted">None</p>`}</div>
      <div class="card"><h2>Payments</h2>${payments.length ? html`<ul>${payments.map((p) => html`<li>${prettyDate(p.created_at.slice(0, 10))} · ${p.sku} · ${p.method} · ${p.status} · ${rand(p.amount_cents)} ${p.status === 'complete' ? html`· <a href="/billing/receipt/${p.id}.pdf">receipt</a>` : ''}</li>`)}</ul>` : html`<p class="muted">None</p>`}</div>
      <div class="card"><h2>Recent activity</h2><ul>${events.map((e) => html`<li>${e.ts.slice(0, 16).replace('T', ' ')} · ${e.name}${e.path ? ` · ${e.path}` : ''}</li>`)}</ul></div>
    </section>`,
  });
});

router.post('/admin/users/:id/grant', (req, res) => {
  const u = db.one('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  const plan = PLANS[req.body.sku];
  if (!u || !plan || plan.kind !== 'once') return notFound(req, res);
  const now = new Date().toISOString();
  db.run("INSERT INTO payments (user_id, user_email, sku, method, status, amount_cents, created_at, completed_at, raw) VALUES (?,?,?,?,?,?,?,?,?)", u.id, u.email, plan.sku, 'comp', 'complete', 0, now, now, JSON.stringify({ grantedBy: req.user.email }));
  grant(u.id, plan.sku);
  res.redirect(`/admin/users/${u.id}`);
});

router.get('/admin/payments', (req, res) => {
  const pendingEft = db.all("SELECT * FROM payments WHERE method = 'eft' AND status = 'pending' ORDER BY created_at");
  const recent = db.all('SELECT * FROM payments ORDER BY created_at DESC LIMIT 200');
  render(req, res, {
    title: 'Admin · Payments',
    active: 'admin',
    noindex: true,
    body: html`<section class="wrap page"><h1>Payments</h1>${adminNav('/admin/payments')}
      <div class="card" style="margin-bottom:16px"><h2>EFTs awaiting payment</h2>
        <p class="muted">Match these references against your bank statement, then mark them received to activate the customer's plan.</p>
        ${pendingEft.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Customer</th><th>Plan</th><th class="num">Amount</th><th>Ordered</th><th></th></tr></thead><tbody>
          ${pendingEft.map((p) => html`<tr><td><strong>${p.reference}</strong></td><td>${p.user_email}</td><td>${PLANS[p.sku] ? PLANS[p.sku].name : p.sku}</td><td class="num">${rand(p.amount_cents)}</td><td>${prettyDate(p.created_at.slice(0, 10))}</td>
            <td><form method="post" action="/admin/payments/${p.id}/received" data-confirm="Mark ${p.reference} as received and activate the plan?">${csrfField(req.csrfToken)}<button class="btn small" type="submit">Mark received</button></form></td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">Nothing pending.</p>`}
      </div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Ref</th><th>Customer</th><th>Plan</th><th>Method</th><th>Status</th><th class="num">Gross</th><th class="num">Fee</th></tr></thead><tbody>
        ${recent.map((p) => html`<tr><td>${(p.completed_at || p.created_at).slice(0, 16).replace('T', ' ')}</td><td>${p.reference || ''}</td><td>${p.user_email}</td><td>${p.sku}${p.is_recurring ? ' (renewal)' : ''}</td><td>${p.method}</td><td>${p.status}</td><td class="num">${rand(p.amount_cents)}</td><td class="num">${rand(p.fee_cents)}</td></tr>`)}
      </tbody></table></div></section>`,
  });
});

router.post('/admin/payments/:id/received', (req, res) => {
  const p = db.one("SELECT * FROM payments WHERE id = ? AND method = 'eft' AND status = 'pending'", Number(req.params.id));
  if (!p) return res.redirect('/admin/payments');
  fulfil(p, { raw: JSON.stringify({ markedBy: req.user.email }) });
  res.redirect('/admin/payments');
});

router.get('/admin/events', (req, res) => {
  const events = db.all('SELECT * FROM events WHERE name != ? ORDER BY id DESC LIMIT 300', 'page_view');
  const counts = db.all("SELECT name, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY name ORDER BY n DESC", new Date(Date.now() - 30 * 86400000).toISOString());
  render(req, res, {
    title: 'Admin · Events',
    active: 'admin',
    noindex: true,
    body: html`<section class="wrap page"><h1>Product events</h1>${adminNav('/admin/events')}
      <div class="grid-2" style="align-items:start">
        <div class="table-wrap"><table><thead><tr><th>Event (30 days)</th><th class="num">Count</th></tr></thead><tbody>${counts.map((c) => html`<tr><td>${c.name}</td><td class="num">${c.n}</td></tr>`)}</tbody></table></div>
        <div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>User</th><th>Details</th></tr></thead><tbody>
          ${events.map((e) => html`<tr><td>${e.ts.slice(0, 16).replace('T', ' ')}</td><td>${e.name}</td><td>${e.user_id ? html`<a href="/admin/users/${e.user_id}">#${e.user_id}</a>` : '—'}</td><td class="muted">${e.props || ''}</td></tr>`)}
        </tbody></table></div>
      </div></section>`,
  });
});

module.exports = router;
