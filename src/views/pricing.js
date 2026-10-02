'use strict';

const config = require('../config');
const { html } = require('../lib/html');
const { PLANS } = require('../lib/plans');
const { rand } = require('../lib/format');

const FEATURES_FREE = ['1 property', 'Unlimited meter readings with dated photos', 'Unlimited bills, each checked against your meter', 'Over-billing found and priced in Rand', 'Leak and estimated-reading alerts'];
const FEATURES_PAID = ['Section 102 dispute letter, ready to send', 'Evidence pack PDF: photos, readings log, calculation', 'Follow-up, appeal (s62) and disconnection-response letters', 'Dispute tracker with follow-up reminders', 'Monthly meter-reading reminders'];

// Buy button: logged-in users POST straight to checkout; others sign up first.
function buy(user, csrf, sku, label, { primary = true, next = '' } = {}) {
  if (!user) return html`<a class="btn ${primary ? '' : 'secondary'}" href="/signup?next=${encodeURIComponent('/pricing')}">${label}</a>`;
  return html`<form method="post" action="/billing/checkout" class="stack" style="margin:0">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="sku" value="${sku}">
    <input type="hidden" name="next" value="${next}">
    <button class="btn ${primary ? '' : 'secondary'}" type="submit" name="method" value="payfast" style="width:100%">${label}</button>
    ${config.eft.enabled && PLANS[sku].kind === 'once' ? html`<button class="linklike" type="submit" name="method" value="eft" style="padding:0">or pay by EFT</button>` : ''}
  </form>`;
}

function pricingCards({ user = null, csrf = '', next = '' } = {}) {
  const d = PLANS.dispute_pack;
  const hm = PLANS.home_monthly;
  const ha = PLANS.home_annual;
  const lm = PLANS.landlord_monthly;
  const la = PLANS.landlord_annual;
  return html`<div class="pricing">
    <article class="card price-card">
      <h3>Free</h3>
      <div class="price">R0</div>
      <p class="muted">Find out if you are being over-billed.</p>
      <ul class="ticks">${FEATURES_FREE.map((f) => html`<li>${f}</li>`)}</ul>
      ${user ? html`<a class="btn secondary" href="/app">Go to dashboard</a>` : html`<a class="btn secondary" href="/signup">Start free</a>`}
    </article>
    <article class="card price-card featured">
      <span class="eyebrow">Best for a bad bill</span>
      <h3>${d.name}</h3>
      <div class="price">${rand(d.amountCents, { decimals: 0 })} <small>once-off</small></div>
      <p class="muted">${d.summary}. Everything you need to dispute and get the bill corrected.</p>
      <ul class="ticks"><li>Everything in Free</li>${FEATURES_PAID.map((f) => html`<li>${f}</li>`)}</ul>
      ${buy(user, csrf, 'dispute_pack', `Get the Dispute Pack · ${rand(d.amountCents, { decimals: 0 })}`, { next })}
    </article>
    <article class="card price-card">
      <h3>${hm.name}</h3>
      <div class="price">${rand(hm.amountCents, { decimals: 0 })} <small>/ month</small></div>
      <p class="muted">For ongoing peace of mind: every bill checked, every month, with disputes included.</p>
      <ul class="ticks"><li>Everything in the Dispute Pack</li><li>Cancel any time</li><li>Or ${rand(ha.amountCents, { decimals: 0 })} for 12 months (2 months free)</li></ul>
      <div class="stack">${buy(user, csrf, 'home_monthly', `Subscribe · ${rand(hm.amountCents, { decimals: 0 })}/month`, { primary: false, next })}
      ${buy(user, csrf, 'home_annual', `Pay ${rand(ha.amountCents, { decimals: 0 })} for 12 months`, { primary: false, next })}</div>
    </article>
    <article class="card price-card">
      <h3>${lm.name}</h3>
      <div class="price">${rand(lm.amountCents, { decimals: 0 })} <small>/ month</small></div>
      <p class="muted">For landlords, trustees and agents who carry the municipal accounts on several properties.</p>
      <ul class="ticks"><li>Up to 15 properties</li><li>Everything in Homeowner</li><li>Or ${rand(la.amountCents, { decimals: 0 })} for 12 months</li></ul>
      <div class="stack">${buy(user, csrf, 'landlord_monthly', `Subscribe · ${rand(lm.amountCents, { decimals: 0 })}/month`, { primary: false, next })}
      ${buy(user, csrf, 'landlord_annual', `Pay ${rand(la.amountCents, { decimals: 0 })} for 12 months`, { primary: false, next })}</div>
    </article>
  </div>
  <p class="muted" style="margin-top:12px">Prices in South African Rand${config.business.vatNumber ? ', including VAT' : ''}. Card, Instant EFT and other methods via PayFast; direct EFT also accepted for once-off plans.</p>`;
}

module.exports = { pricingCards };
