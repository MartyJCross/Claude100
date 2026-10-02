'use strict';

// PayFast integration: checkout form signing, ITN (Instant Transaction
// Notification) verification and the subscriptions API.
// Docs: https://developers.payfast.co.za/docs

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const config = require('../config');

const HOSTS = { live: 'https://www.payfast.co.za', sandbox: 'https://sandbox.payfast.co.za' };
const API = 'https://api.payfast.co.za';
const VALID_HOSTNAMES = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];

const processUrl = () => `${HOSTS[config.payfast.mode]}/eng/process`;
const validateUrl = () => `${HOSTS[config.payfast.mode]}/eng/query/validate`;

// PHP urlencode() semantics, which PayFast uses server-side.
function phpEncode(value) {
  return encodeURIComponent(String(value).trim())
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
// The variant used in PayFast's own Node examples (differs only for !'()*~).
function jsEncode(value) {
  return encodeURIComponent(String(value).trim()).replace(/%20/g, '+');
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function paramString(pairs, encode = phpEncode) {
  return pairs
    .filter(([k, v]) => k !== 'signature' && v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}=${encode(v)}`)
    .join('&');
}

function sign(pairs, passphrase = config.payfast.passphrase, encode = phpEncode) {
  let s = paramString(pairs, encode);
  if (passphrase) s += `&passphrase=${encode(passphrase)}`;
  return md5(s);
}

/**
 * Build the ordered checkout fields for a payment. Field order matters for the
 * signature and must follow PayFast's documented attribute order.
 */
function checkoutFields({ payment, plan, user, returnUrl, cancelUrl, notifyUrl }) {
  const [first, ...rest] = String(user.name || '').trim().split(/\s+/);
  const amount = (payment.amount_cents / 100).toFixed(2);
  const pairs = [
    ['merchant_id', config.payfast.merchantId],
    ['merchant_key', config.payfast.merchantKey],
    ['return_url', returnUrl],
    ['cancel_url', cancelUrl],
    ['notify_url', notifyUrl],
    ['name_first', (first || '').slice(0, 100)],
    ['name_last', rest.join(' ').slice(0, 100)],
    ['email_address', user.email],
    ['m_payment_id', payment.m_payment_id],
    ['amount', amount],
    ['item_name', `${config.brand} ${plan.name}`.slice(0, 100)],
    ['item_description', plan.summary.replace(/·/g, '-').slice(0, 255)],
    ['custom_int1', String(user.id)],
    ['custom_str1', plan.sku],
  ];
  if (plan.kind === 'subscription') {
    pairs.push(
      ['subscription_type', '1'],
      ['billing_date', payment.created_at.slice(0, 10)],
      ['recurring_amount', amount],
      ['frequency', '3'], // monthly
      ['cycles', '0'], // until cancelled
    );
  }
  const clean = pairs.filter(([, v]) => v !== '' && v !== undefined && v !== null);
  clean.push(['signature', sign(clean)]);
  return clean;
}

// Parse an urlencoded ITN body preserving the order PayFast sent the fields in.
function parseOrdered(rawBody) {
  const out = [];
  for (const part of String(rawBody || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    out.push([k, v]);
  }
  return out;
}

// ITN signatures include every posted field (empty ones too) in posted order.
function itnSignatureValid(pairs) {
  const sig = (pairs.find(([k]) => k === 'signature') || [])[1];
  if (!sig) return false;
  const fields = pairs.filter(([k]) => k !== 'signature');
  for (const encode of [phpEncode, jsEncode]) {
    let s = fields.map(([k, v]) => `${k}=${encode(v)}`).join('&');
    if (config.payfast.passphrase) s += `&passphrase=${encode(config.payfast.passphrase)}`;
    if (md5(s) === sig) return true;
  }
  return false;
}

let hostCache = { at: 0, ips: new Set() };
async function sourceIpValid(ip) {
  if (process.env.PAYFAST_CHECK_IP !== '1') return true;
  if (Date.now() - hostCache.at > 3600 * 1000) {
    const ips = new Set();
    for (const host of VALID_HOSTNAMES) {
      try {
        for (const r of await dns.lookup(host, { all: true })) ips.add(r.address);
      } catch {
        // ignore unresolvable host
      }
    }
    hostCache = { at: Date.now(), ips };
  }
  return hostCache.ips.has(String(ip).replace(/^::ffff:/, ''));
}

// Server-to-server confirmation that PayFast really sent this ITN.
async function confirmWithPayfast(pairs) {
  if (config.payfast.skipValidation) return true;
  const body = pairs.filter(([k]) => k !== 'signature').map(([k, v]) => `${k}=${phpEncode(v)}`).join('&');
  try {
    const res = await fetch(validateUrl(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
    const text = (await res.text()).trim();
    return text === 'VALID';
  } catch (err) {
    console.error('payfast: validation request failed', err.message);
    return false;
  }
}

// ---------------------------------------------------------------- Subscriptions API
function apiTimestamp() {
  const sa = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 19);
  return `${sa}+02:00`;
}

function apiSignature(headers, body = {}) {
  const all = { ...headers, ...body };
  if (config.payfast.passphrase) all.passphrase = config.payfast.passphrase;
  const s = Object.keys(all)
    .sort()
    .map((k) => `${k}=${phpEncode(all[k])}`)
    .join('&');
  return md5(s);
}

async function apiRequest(method, path) {
  const headers = { 'merchant-id': config.payfast.merchantId, version: 'v1', timestamp: apiTimestamp() };
  headers.signature = apiSignature(headers);
  const url = `${API}${path}${config.payfast.mode === 'sandbox' ? '?testing=true' : ''}`;
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

const cancelSubscription = (token) => apiRequest('PUT', `/subscriptions/${encodeURIComponent(token)}/cancel`);
const fetchSubscription = (token) => apiRequest('GET', `/subscriptions/${encodeURIComponent(token)}/fetch`);

module.exports = {
  processUrl,
  validateUrl,
  phpEncode,
  sign,
  paramString,
  checkoutFields,
  parseOrdered,
  itnSignatureValid,
  sourceIpValid,
  confirmWithPayfast,
  apiSignature,
  cancelSubscription,
  fetchSubscription,
};
