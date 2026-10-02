'use strict';

const config = require('../config');
const { html, raw } = require('../lib/html');
const { tierOf, paidUntil, TIERS } = require('../lib/plans');
const { prettyDate, daysBetween, today } = require('../lib/format');

const LOGO = raw(`<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)"/><path d="M8 20a8 8 0 0 1 16 0" fill="none" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round"/><path d="M16 20l4.5-5.5" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="20" r="2" fill="var(--accent-ink)"/></svg>`);

// Short, human messages shown after redirects (?ok=code).
const MESSAGES = {
  saved: 'Saved.',
  deleted: 'Deleted.',
  welcome: `Welcome to ${config.brand}! Start by adding the property whose municipal account you want to check.`,
  reading: 'Reading saved. Tip: take a reading on the same day each month to build your evidence.',
  bill: 'Bill saved and checked against your readings.',
  dispute: 'Dispute created. Review the letter, then send it to the municipality.',
  lodged: 'Marked as lodged. We will remind you to follow up if there is no response.',
  password: 'Password updated.',
  reset: 'If that email has an account, a reset link is on its way.',
  paid: 'Payment received. Your plan is active.',
  pending: 'Thanks! We are waiting for PayFast to confirm your payment. This usually takes a few seconds.',
  cancelled: 'Subscription cancelled. You keep access until the end of the paid period.',
  eft: 'EFT order created. Your plan activates as soon as the payment reflects.',
  loggedout: 'You have been logged out.',
};

function nav(user, active) {
  const link = (href, label, key) => html`<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  if (user) {
    return html`<nav class="nav" aria-label="Main">
      ${link('/app', 'Dashboard', 'app')}
      ${link('/billing', 'Plan', 'billing')}
      ${link('/account', 'Account', 'account')}
      ${user.isAdmin ? link('/admin', 'Admin', 'admin') : ''}
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${user.csrf}"><button class="linklike" type="submit">Log out</button></form>
    </nav>`;
  }
  return html`<nav class="nav" aria-label="Main">
    ${link('/tools/bill-checker', 'Free bill checker', 'tool')}
    ${link('/guides/dispute-municipal-bill', 'Guide', 'guide')}
    ${link('/pricing', 'Pricing', 'pricing')}
    ${link('/login', 'Log in', 'login')}
    <a class="btn small" href="/signup">Start free</a>
  </nav>`;
}

function planBanner(user) {
  if (!user) return '';
  const tier = tierOf(user);
  if (tier === 'free') return '';
  const until = paidUntil(user);
  const left = daysBetween(today(), until);
  if (user.sub_status === 'active' || left > 10) return '';
  return html`<div class="plan-banner"><div class="wrap">Your ${TIERS[tier].label} access ${left >= 0 ? `ends on ${prettyDate(until)}` : 'has ended'}. <a href="/billing">Renew</a> to keep your dispute letters and reminders.</div></div>`;
}

function page({ title, body, user = null, active = '', description = '', flash = '', csrf = '', noindex = false }) {
  if (user) user.csrf = csrf;
  const message = flash && MESSAGES[flash];
  const fullTitle = title ? `${title} · ${config.brand}` : `${config.brand}: check your municipal bill against your meter`;
  return html`<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${description || 'Log dated meter photos, catch estimated and inflated municipal bills, and lodge a Section 102 dispute that protects you from disconnection.'}">
${noindex ? raw('<meta name="robots" content="noindex">') : ''}
<meta name="theme-color" content="#0f6b5c">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/styles.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header class="site-header"><div class="wrap">
  <a class="brand" href="${user ? '/app' : '/'}">${LOGO}<span>${config.brand}</span></a>
  ${nav(user, active)}
</div></header>
${planBanner(user)}
<main id="main">
${message ? html`<div class="wrap" style="padding-top:16px"><div class="notice" role="status">${message}</div></div>` : ''}
${body}
</main>
<footer class="site-footer"><div class="wrap">
  <div class="row between">
    <div>${config.brand} · Made in South Africa · <a href="mailto:${config.supportEmail}">${config.supportEmail}</a></div>
    <div class="row">
      <a href="/tools/bill-checker">Bill checker</a>
      <a href="/guides/dispute-municipal-bill">Dispute guide</a>
      <a href="/pricing">Pricing</a>
      <a href="/legal/terms">Terms</a>
      <a href="/legal/privacy">Privacy (POPIA)</a>
    </div>
  </div>
  <p style="margin-top:12px">${config.brand} is a self-help tool and does not provide legal advice. For complex matters, consult an attorney.</p>
</div></footer>
</body>
</html>`;
}

function errorsBox(errors) {
  if (!errors || !errors.length) return '';
  return html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

module.exports = { page, errorsBox, csrfField, LOGO, MESSAGES };
