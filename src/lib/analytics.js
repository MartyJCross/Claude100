'use strict';

// First-party, cookie-light product analytics: page views and funnel events
// stored in our own database (no third-party trackers, POPIA-friendly).

const db = require('../db');
const { setCookie } = require('./security');
const { nowIso } = require('./format');

const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|headless|lighthouse|python-requests|axios/i;

function attribution(req) {
  let utm = {};
  try {
    utm = JSON.parse(req.cookies.utm || '{}');
  } catch {
    utm = {};
  }
  return utm;
}

function track(name, { req = null, userId = null, props = null } = {}) {
  try {
    const utm = req ? attribution(req) : {};
    db.run(
      'INSERT INTO events (ts, anon_id, user_id, name, path, referrer, utm_source, utm_medium, utm_campaign, props) VALUES (?,?,?,?,?,?,?,?,?,?)',
      nowIso(),
      req ? req.anonId : null,
      userId ?? (req && req.user ? req.user.id : null),
      name,
      req ? req.path.slice(0, 200) : null,
      utm.ref || null,
      utm.source || null,
      utm.medium || null,
      utm.campaign || null,
      props ? JSON.stringify(props).slice(0, 2000) : null,
    );
  } catch (err) {
    console.error('analytics: failed to record event', name, err.message);
  }
}

// Records page views for public and app pages and keeps first-touch attribution.
function pageViews(req, res, next) {
  if (req.method !== 'GET' || BOT.test(req.get('user-agent') || '')) return next();
  if (/^\/(static|files|admin|billing\/payfast)|\.(pdf|txt|json|xml|ico|png)$/.test(req.path)) return next();

  if (!req.cookies.utm) {
    const q = req.query || {};
    const ref = (() => {
      try {
        const host = new URL(req.get('referer') || '').hostname;
        return host && host !== req.hostname ? host : '';
      } catch {
        return '';
      }
    })();
    if (q.utm_source || ref) {
      const utm = {
        source: String(q.utm_source || '').slice(0, 60),
        medium: String(q.utm_medium || '').slice(0, 60),
        campaign: String(q.utm_campaign || '').slice(0, 80),
        ref: ref.slice(0, 120),
      };
      req.cookies.utm = JSON.stringify(utm);
      setCookie(res, 'utm', req.cookies.utm, { maxAgeDays: 90 });
    }
  }
  track('page_view', { req });
  next();
}

module.exports = { track, pageViews, attribution };
