'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const { html } = require('../lib/html');
const { render, notFound } = require('../lib/render');
const { csrfField } = require('../views/layout');
const { pricingCards } = require('../views/pricing');
const { requireAuth } = require('../lib/security');
const { PLANS, TIERS, tierOf, paidUntil } = require('../lib/plans');
const payfast = require('../lib/payfast');
const { createPayment, fulfil, recordRenewal, cancelled } = require('../lib/billing');
const { receiptPdf } = require('../lib/pdf');
const { track } = require('../lib/analytics');
const { sendMail } = require('../lib/mailer');
const { rand, prettyDate, toCents } = require('../lib/format');

const router = express.Router();

const REASONS = {
  letters: 'Your dispute is ready. Choose a plan to download the letter and evidence pack.',
  properties: 'Your current plan covers one property. The Landlord plan covers up to 15.',
};

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/app') ? next : '';
}

// ---------------------------------------------------------------- Pricing (public)
router.get('/pricing', (req, res) => {
  const reason = REASONS[req.query.reason];
  if (req.query.reason) track('paywall_viewed', { req, props: { reason: req.query.reason } });
  render(req, res, {
    title: 'Pricing',
    active: 'pricing',
    description: 'Free to check your municipal bill against your meter. R299 once-off for a complete Section 102 dispute pack.',
    body: html`<section class="wrap page">
      <div class="section-head"><h1>Simple pricing</h1>
        <p class="text-2">Checking is free. Pay only when you want to dispute. One corrected water bill usually covers the cost many times over.</p></div>
      ${reason ? html`<div class="notice">${reason}</div>` : ''}
      ${pricingCards({ user: req.user, csrf: req.csrfToken, next: safeNext(req.query.next) })}
      <div class="section" style="padding-bottom:0">
        <h2>Questions about paying</h2>
        <details class="faq"><summary>Is the Dispute Pack really once-off?</summary><p>Yes. You pay once and get six months of full access for one property, long enough for most disputes to run their course. Nothing renews automatically.</p></details>
        <details class="faq"><summary>How do I cancel a monthly plan?</summary><p>On your Plan page, click "Cancel subscription". It stops the next PayFast debit immediately and you keep access until the end of the month you paid for.</p></details>
        <details class="faq"><summary>Can I pay by EFT?</summary><p>Yes, for the Dispute Pack and the 12-month plans. You get our bank details and a reference; your plan activates as soon as the payment reflects (usually the same or next business day).</p></details>
        <details class="faq"><summary>What if you find nothing wrong with my bill?</summary><p>Then you have not paid anything: checking is free. If you buy a plan and are unhappy within 7 days, email us for a full refund.</p></details>
      </div>
    </section>`,
  });
});

// ---------------------------------------------------------------- Plan page
router.get('/billing', requireAuth, (req, res) => {
  const user = req.user;
  const tier = tierOf(user);
  const payments = db.all("SELECT * FROM payments WHERE user_id = ? AND status IN ('complete','pending') ORDER BY created_at DESC LIMIT 50", user.id);
  const until = paidUntil(user);
  const subActive = user.sub_status === 'active';
  render(req, res, {
    title: 'Your plan',
    active: 'billing',
    body: html`<section class="wrap page">
      <div class="page-head"><div><h1>Your plan</h1>
        <p class="text-2"><strong>${TIERS[tier].label}</strong>${until ? html` · access until ${prettyDate(until)}` : ''}${subActive ? html` · <span class="badge good">${PLANS[user.sub_sku] ? PLANS[user.sub_sku].name : 'Subscription'} active, renews monthly</span>` : user.sub_status === 'cancelled' ? html` · <span class="badge">Subscription cancelled</span>` : ''}</p></div></div>
      ${subActive ? html`<div class="card" style="margin-bottom:16px"><div class="row between"><div><strong>Monthly subscription</strong><br><span class="muted">Billed ${rand(PLANS[user.sub_sku].amountCents)} per month via PayFast.</span></div>
        <form method="post" action="/billing/cancel-subscription" data-confirm="Cancel your subscription? You keep access until the end of the current paid month.">${csrfField(req.csrfToken)}<button class="btn secondary small" type="submit">Cancel subscription</button></form></div></div>` : ''}
      ${tier === 'free' || !subActive ? html`<h2>${tier === 'free' ? 'Upgrade' : 'Extend or change your plan'}</h2>${pricingCards({ user, csrf: req.csrfToken })}` : ''}
      <h2 style="margin-top:32px">Payments</h2>
      ${payments.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Plan</th><th>Method</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
        ${payments.map((p) => html`<tr><td>${prettyDate((p.completed_at || p.created_at).slice(0, 10))}</td><td>${PLANS[p.sku] ? PLANS[p.sku].name : p.sku}${p.is_recurring ? ' (renewal)' : ''}</td><td>${p.method === 'eft' ? `EFT · ref ${p.reference}` : p.method === 'payfast' ? 'PayFast' : p.method}</td>
          <td>${p.status === 'complete' ? html`<span class="badge good">Paid</span>` : html`<span class="badge warn">Awaiting payment</span>`}</td><td class="num">${rand(p.amount_cents)}</td>
          <td>${p.status === 'complete' ? html`<a href="/billing/receipt/${p.id}.pdf">Receipt</a>` : p.method === 'eft' ? html`<a href="/billing/eft/${p.m_payment_id}">Bank details</a>` : ''}</td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">No payments yet.</p>`}
    </section>`,
  });
});

// ---------------------------------------------------------------- Checkout
router.post('/billing/checkout', requireAuth, (req, res) => {
  const plan = PLANS[req.body.sku];
  if (!plan) return res.redirect('/pricing');
  const method = req.body.method === 'eft' && config.eft.enabled && plan.kind === 'once' ? 'eft' : 'payfast';
  if (plan.kind === 'subscription' && req.user.sub_status === 'active') return res.redirect('/billing');
  const payment = createPayment(req.user, plan.sku, method, { next: safeNext(req.body.next) });
  track('checkout_started', { req, props: { sku: plan.sku, method } });

  if (method === 'eft') {
    sendMail({
      to: req.user.email,
      subject: `EFT details for your ${config.brand} order ${payment.reference}`,
      text: `Thank you for your order of ${config.brand} ${plan.name} (${rand(plan.amountCents)}).\n\nPlease pay by EFT to:\nBank: ${config.eft.bankName}\nAccount name: ${config.eft.accountName}\nAccount number: ${config.eft.accountNumber}\nBranch code: ${config.eft.branchCode}\nAccount type: ${config.eft.accountType}\nReference: ${payment.reference}\n\nYour plan activates as soon as the payment reflects. To speed things up, reply with your proof of payment.`,
    });
    return res.redirect(`/billing/eft/${payment.m_payment_id}`);
  }

  const fields = payfast.checkoutFields({
    payment,
    plan,
    user: req.user,
    returnUrl: `${config.baseUrl}/billing/return?m=${payment.m_payment_id}`,
    cancelUrl: `${config.baseUrl}/billing/cancelled?m=${payment.m_payment_id}`,
    notifyUrl: `${config.baseUrl}/billing/payfast/itn`,
  });
  render(req, res, {
    title: 'Redirecting to PayFast',
    noindex: true,
    body: html`<section class="wrap page narrow">
      <h1>Taking you to PayFast…</h1>
      <p class="text-2">You are paying <strong>${rand(plan.amountCents)}</strong> for ${config.brand} ${plan.name}${plan.kind === 'subscription' ? ' (renews monthly until you cancel)' : ''}. PayFast is South Africa's most widely used secure payment gateway.</p>
      ${config.payfast.mode === 'sandbox' ? html`<div class="notice">Test mode: this is the PayFast sandbox. No real money will be taken.</div>` : ''}
      <form method="post" action="${payfast.processUrl()}" data-autosubmit>
        ${fields.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
        <button class="btn big" type="submit">Continue to PayFast</button>
      </form>
      ${config.allowDevPayments ? html`<form method="post" action="/billing/dev/complete/${payment.m_payment_id}" style="margin-top:24px">${csrfField(req.csrfToken)}
        <p class="muted">Development only: complete this payment without PayFast.</p><button class="btn secondary small" type="submit">Simulate successful payment</button></form>` : ''}
    </section>`,
  });
});

router.get('/billing/eft/:m', requireAuth, (req, res) => {
  const payment = db.one("SELECT * FROM payments WHERE m_payment_id = ? AND user_id = ? AND method = 'eft'", String(req.params.m), req.user.id);
  if (!payment) return notFound(req, res);
  const plan = PLANS[payment.sku];
  const row = (k, v) => html`<tr><th style="width:40%">${k}</th><td><strong>${v}</strong></td></tr>`;
  render(req, res, {
    title: 'Pay by EFT',
    flash: payment.status === 'pending' ? 'eft' : 'paid',
    body: html`<section class="wrap page narrow">
      <h1>Pay by EFT</h1>
      <p class="text-2">${config.brand} ${plan.name} · ${rand(payment.amount_cents)}. Use the reference exactly as shown so we can match your payment.</p>
      <div class="table-wrap"><table><tbody>
        ${row('Bank', config.eft.bankName)}${row('Account name', config.eft.accountName)}${row('Account number', config.eft.accountNumber)}
        ${row('Branch code', config.eft.branchCode)}${row('Account type', config.eft.accountType)}${row('Amount', rand(payment.amount_cents))}${row('Reference', payment.reference)}
      </tbody></table></div>
      <p style="margin-top:16px">Send your proof of payment to <a href="mailto:${config.supportEmail}?subject=${encodeURIComponent(`Proof of payment ${payment.reference}`)}">${config.supportEmail}</a> to activate faster. We have also emailed these details to you.</p>
      <p>Status: ${payment.status === 'complete' ? html`<span class="badge good">Paid</span>` : html`<span class="badge warn">Awaiting payment</span>`}</p>
      <a class="btn secondary" href="/app">Back to dashboard</a>
    </section>`,
  });
});

router.get('/billing/return', requireAuth, (req, res) => {
  const payment = db.one('SELECT * FROM payments WHERE m_payment_id = ? AND user_id = ?', String(req.query.m || ''), req.user.id);
  if (!payment) return res.redirect('/billing');
  let next = '';
  try {
    next = safeNext(JSON.parse(payment.raw || '{}').next);
  } catch {
    next = '';
  }
  if (payment.status === 'complete') return res.redirect(`${next || '/app'}${(next || '/app').includes('?') ? '&' : '?'}ok=paid`);
  const tries = Math.min(Number(req.query.t || 0), 30);
  render(req, res, {
    title: 'Confirming payment',
    flash: 'pending',
    noindex: true,
    body: html`<section class="wrap page narrow">
      ${tries < 30 ? html`<meta http-equiv="refresh" content="3;url=/billing/return?m=${payment.m_payment_id}&t=${tries + 1}">` : ''}
      <h1>Confirming your payment…</h1>
      <p class="text-2">${tries < 30 ? 'This page refreshes automatically.' : 'This is taking longer than usual. Your plan activates automatically as soon as PayFast confirms the payment, and we will email you a receipt.'}</p>
      <a class="btn secondary" href="/app">Go to dashboard</a>
    </section>`,
  });
});

router.get('/billing/cancelled', requireAuth, (req, res) => {
  db.run("UPDATE payments SET status = 'cancelled' WHERE m_payment_id = ? AND user_id = ? AND status = 'pending' AND method = 'payfast'", String(req.query.m || ''), req.user.id);
  track('checkout_cancelled', { req });
  res.redirect('/pricing');
});

router.post('/billing/cancel-subscription', requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    if (user.sub_status !== 'active') return res.redirect('/billing');
    if (user.sub_token) {
      const result = await payfast.cancelSubscription(user.sub_token).catch((err) => ({ ok: false, body: { error: err.message } }));
      if (!result.ok) {
        console.error('payfast: cancel failed', user.id, result.status, JSON.stringify(result.body).slice(0, 300));
        return render(req, res, {
          title: 'Could not cancel',
          body: html`<section class="wrap page narrow"><h1>We could not reach PayFast</h1>
            <p>Your subscription was not cancelled because PayFast did not respond. Please try again in a few minutes, or email <a href="mailto:${config.supportEmail}">${config.supportEmail}</a> and we will cancel it for you the same day.</p>
            <a class="btn" href="/billing">Back to your plan</a></section>`,
        }, 502);
      }
    }
    cancelled(user.id);
    res.redirect('/billing?ok=cancelled');
  } catch (err) {
    next(err);
  }
});

router.get('/billing/receipt/:id.pdf', requireAuth, (req, res) => {
  const payment = db.one("SELECT * FROM payments WHERE id = ? AND status = 'complete'", Number(req.params.id));
  if (!payment || (payment.user_id !== req.user.id && !req.user.isAdmin)) return notFound(req, res);
  const user = db.one('SELECT * FROM users WHERE id = ?', payment.user_id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="receipt-MP-${String(payment.id).padStart(6, '0')}.pdf"` });
  receiptPdf({ payment, user, plan: PLANS[payment.sku] }, res);
});

// Development helper: completes a pending payment without PayFast.
router.post('/billing/dev/complete/:m', requireAuth, (req, res) => {
  if (!config.allowDevPayments) return notFound(req, res);
  const payment = db.one("SELECT * FROM payments WHERE m_payment_id = ? AND user_id = ? AND status = 'pending'", String(req.params.m), req.user.id);
  if (!payment) return res.redirect('/billing');
  fulfil(payment, { pfPaymentId: `dev-${payment.m_payment_id}` });
  res.redirect(`/billing/return?m=${payment.m_payment_id}`);
});

// ---------------------------------------------------------------- PayFast ITN (server to server)
async function handleItn(req, res) {
  // Always acknowledge quickly; PayFast retries on non-200 responses.
  const pairs = payfast.parseOrdered(req.rawBody);
  const data = Object.fromEntries(pairs);
  const reject = (why) => {
    console.warn('payfast ITN rejected:', why, data.m_payment_id || '');
    res.status(200).send('OK');
  };
  if (!payfast.itnSignatureValid(pairs)) return reject('bad signature');
  if (data.merchant_id !== config.payfast.merchantId) return reject('merchant mismatch');
  if (!(await payfast.sourceIpValid(req.ip))) return reject(`unexpected source ${req.ip}`);
  if (!(await payfast.confirmWithPayfast(pairs))) return reject('validation failed');

  const payment = db.one('SELECT * FROM payments WHERE m_payment_id = ?', String(data.m_payment_id || ''));
  if (!payment) return reject('unknown payment');
  const gross = toCents(data.amount_gross);
  const fee = Math.abs(toCents(data.amount_fee) || 0);
  const status = String(data.payment_status || '').toUpperCase();
  const raw = JSON.stringify(data);

  if (status === 'COMPLETE') {
    if (gross === null || Math.abs(gross - payment.amount_cents) > 1) return reject(`amount mismatch ${gross} != ${payment.amount_cents}`);
    if (payment.status === 'complete') {
      // Same m_payment_id, new pf_payment_id: a subscription renewal.
      if (data.pf_payment_id && data.pf_payment_id !== payment.pf_payment_id) {
        recordRenewal(payment, { pfPaymentId: data.pf_payment_id, amountCents: gross, feeCents: fee, raw });
      }
    } else {
      fulfil(payment, { pfPaymentId: data.pf_payment_id || null, feeCents: fee, token: data.token || null, raw });
    }
  } else if (status === 'CANCELLED') {
    if (payment.status === 'pending') db.run("UPDATE payments SET status = 'cancelled', raw = ? WHERE id = ?", raw, payment.id);
    else if (PLANS[payment.sku].kind === 'subscription' && payment.user_id) {
      const user = db.one('SELECT * FROM users WHERE id = ?', payment.user_id);
      if (user && user.sub_status === 'active' && (!data.token || data.token === user.sub_token)) cancelled(user.id);
    }
  } else if (status === 'FAILED') {
    if (payment.status === 'pending') db.run("UPDATE payments SET status = 'failed', raw = ? WHERE id = ?", raw, payment.id);
    track('payment_failed', { userId: payment.user_id, props: { sku: payment.sku } });
  }
  res.status(200).send('OK');
}

// Mounted before the CSRF and body parsers in app.js because PayFast posts it.
const itn = express.Router();
itn.post(
  '/billing/payfast/itn',
  express.raw({ type: '*/*', limit: '64kb' }),
  (req, res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    next();
  },
  (req, res, next) => handleItn(req, res).catch(next),
);

module.exports = router;
module.exports.itn = itn;
