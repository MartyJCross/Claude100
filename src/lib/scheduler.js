'use strict';

// Hourly background jobs: reminder emails and housekeeping. Every reminder is
// keyed in reminders_sent so restarts and repeated ticks never double-send.

const config = require('../config');
const db = require('../db');
const { sendMail } = require('./mailer');
const { PLANS } = require('./plans');
const { today, addDays, daysBetween, prettyDate, rand, nowIso } = require('./format');

let timer = null;

function once(key, userId, fn) {
  const done = db.one('SELECT key FROM reminders_sent WHERE key = ?', key);
  if (done) return false;
  db.run('INSERT INTO reminders_sent (key, user_id, sent_at) VALUES (?,?,?)', key, userId, nowIso());
  fn();
  return true;
}

function readingReminders(t) {
  const day = Number(t.slice(8, 10));
  const month = t.slice(0, 7);
  const users = db.all(
    'SELECT u.* FROM users u WHERE u.email_opt_in = 1 AND u.reminder_day = ? AND EXISTS (SELECT 1 FROM properties p WHERE p.user_id = u.id)',
    day,
  );
  let sent = 0;
  for (const u of users) {
    const props = db.all('SELECT id, nickname FROM properties WHERE user_id = ?', u.id);
    const sentNow = once(`read:${u.id}:${month}`, u.id, () =>
      sendMail({
        to: u.email,
        subject: 'Meter reading day: take a quick photo',
        text: `Hi ${u.name.split(' ')[0]},\n\nIt is your monthly meter reading day. A dated photo of your meter takes 30 seconds and is the strongest evidence you can have if the municipality ever over-bills you.\n\n${props.map((p) => `- ${p.nickname}`).join('\n')}\n\nTip: add your latest municipal bill at the same time and we will check it immediately.`,
        cta: { label: 'Add today\'s reading', url: `${config.baseUrl}/app/properties/${props[0].id}/readings/new` },
      }),
    );
    if (sentNow) sent++;
  }
  return sent;
}

function disputeFollowUps(t) {
  const rows = db.all(
    `SELECT d.*, u.email, u.name, u.email_opt_in FROM disputes d JOIN users u ON u.id = d.user_id
      WHERE d.status IN ('lodged','acknowledged','escalated','appealed') AND d.lodged_at IS NOT NULL`,
  );
  let sent = 0;
  for (const d of rows) {
    if (!d.email_opt_in) continue;
    const age = daysBetween(d.lodged_at, t);
    const steps = [
      [14, 'No reference number yet? Time to follow up', d.reference_number ? null : `It has been 14 days since you lodged "${d.title}" and there is no reference number recorded. Call or email the municipality for the reference number, and record it in ${config.brand}. If there is no response, send the follow-up letter from your dispute page.`],
      [30, 'Your dispute is 30 days old: escalate it', `"${d.title}" (${rand(d.disputed_amount_cents)}) has been open for 30 days. If it is not resolved, download the follow-up / escalation letter from your dispute page and send it, copying your ward councillor.`],
      [60, 'Still unresolved after 60 days', `"${d.title}" has been open for 60 days. Consider escalating to the municipal Ombudsman (where there is one) or your councillor, and keep paying the undisputed amount${d.undisputed_monthly_cents ? ` of ${rand(d.undisputed_monthly_cents)}` : ''} each month. If the dispute was rejected, remember that a section 62 appeal must be lodged within 21 days of the decision.`],
    ];
    for (const [threshold, subject, text] of steps) {
      if (age < threshold || !text) continue;
      if (once(`d${threshold}:${d.id}`, d.user_id, () => sendMail({ to: d.email, subject, text: `Hi ${d.name.split(' ')[0]},\n\n${text}`, cta: { label: 'Open the dispute', url: `${config.baseUrl}/app/disputes/${d.id}` } }))) sent++;
    }
  }
  // Drafts that were never sent.
  const drafts = db.all("SELECT d.*, u.email, u.name, u.email_opt_in FROM disputes d JOIN users u ON u.id = d.user_id WHERE d.status = 'draft'");
  for (const d of drafts) {
    if (!d.email_opt_in || daysBetween(d.created_at.slice(0, 10), t) < 3) continue;
    if (once(`draft:${d.id}`, d.user_id, () => sendMail({
      to: d.email,
      subject: 'Your dispute is ready to send',
      text: `Hi ${d.name.split(' ')[0]},\n\nYou prepared a dispute for ${rand(d.disputed_amount_cents)} but have not marked it as sent. Section 102 only protects you once the dispute is actually lodged with the municipality, so send it as soon as you can.`,
      cta: { label: 'Finish and send', url: `${config.baseUrl}/app/disputes/${d.id}` },
    }))) sent++;
  }
  return sent;
}

function expiryReminders(t) {
  const soon = addDays(t, 5);
  const users = db.all(
    "SELECT * FROM users WHERE email_opt_in = 1 AND (sub_status IS NULL OR sub_status != 'active') AND ((home_until BETWEEN ? AND ?) OR (landlord_until BETWEEN ? AND ?))",
    t, soon, t, soon,
  );
  let sent = 0;
  for (const u of users) {
    const until = u.landlord_until && u.landlord_until >= t ? u.landlord_until : u.home_until;
    if (once(`exp:${u.id}:${until}`, u.id, () => sendMail({
      to: u.email,
      subject: `Your ${config.brand} access ends on ${prettyDate(until)}`,
      text: `Hi ${u.name.split(' ')[0]},\n\nYour paid access ends on ${prettyDate(until, { long: true })}. Your readings and bills stay in your free account, but dispute letters and reminders stop. If a dispute is still open, the Homeowner plan (${rand(PLANS.home_monthly.amountCents)}/month, cancel any time) keeps everything running.`,
      cta: { label: 'Keep my plan', url: `${config.baseUrl}/billing` },
    }))) sent++;
  }
  return sent;
}

function housekeeping() {
  const now = nowIso();
  db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  db.run('DELETE FROM password_resets WHERE expires_at < ?', now);
  db.run("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND method = 'payfast' AND created_at < ?", new Date(Date.now() - 2 * 86400000).toISOString());
}

function tick() {
  const t = today();
  try {
    const sent = readingReminders(t) + disputeFollowUps(t) + expiryReminders(t);
    housekeeping();
    if (sent) console.log(`scheduler: sent ${sent} reminder email(s)`);
    return sent;
  } catch (err) {
    console.error('scheduler: tick failed', err);
    return 0;
  }
}

function start() {
  setTimeout(tick, 10 * 1000).unref();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { start, stop, tick, readingReminders, disputeFollowUps, expiryReminders };
