'use strict';

const express = require('express');
const db = require('../db');
const { html } = require('../lib/html');
const { render, notFound } = require('../lib/render');
const { csrfField } = require('../views/layout');
const { requireAuth } = require('../lib/security');
const { getProperty, analyse } = require('../lib/data');
const { disputeAmounts } = require('../lib/analysis');
const { LETTER_KINDS, toText } = require('../lib/letters');
const { letterPdf, evidencePackPdf } = require('../lib/pdf');
const { isPaid } = require('../lib/plans');
const { track } = require('../lib/analytics');
const { municipalityName, findMunicipality } = require('../lib/municipalities');
const { rand, toCents, today, nowIso, isValidDate, prettyDate, daysBetween, MONTHS } = require('../lib/format');
const { statusBadge, flagList, STATUS } = require('./properties');

const router = express.Router();
router.use('/app', requireAuth);

function ownedDispute(userId, id) {
  return db.one('SELECT * FROM disputes WHERE id = ? AND user_id = ?', Number(id), userId) || null;
}

function defaultTitle(chosen) {
  if (!chosen.length) return 'Billing dispute';
  const dates = chosen.map((b) => b.bill.bill_date).sort();
  const fmt = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
  const services = [...new Set(chosen.flatMap((b) => b.consumption.filter((c) => c.result.overchargeCents > 0).map((c) => c.line.utility)))];
  const what = services.length ? `${services.map((s) => (s === 'water' ? 'Water' : 'Electricity')).join(' & ')} over-billing` : 'Disputed charges';
  return dates.length > 1 && fmt(dates[0]) !== fmt(dates[dates.length - 1]) ? `${what}, ${fmt(dates[0])} to ${fmt(dates[dates.length - 1])}` : `${what}, ${fmt(dates[0])}`;
}

// ---------------------------------------------------------------- New dispute
router.get('/app/properties/:id/disputes/new', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  const { analysis } = analyse(property.id);
  const candidates = analysis.bills.filter((b) => b.consumptionOverCents !== 0 || b.manualDisputedCents > 0 || b.flagged);
  const preselected = candidates.filter((b) => b.flagged);
  const amounts = disputeAmounts(analysis, preselected.map((b) => b.bill.id));
  track('dispute_builder_viewed', { req, props: { disputable: amounts.totalCents } });
  render(req, res, {
    title: 'Prepare a dispute',
    active: 'app',
    body: html`<section class="wrap page" style="max-width:820px">
      <div class="crumbs"><a href="/app">Dashboard</a> / <a href="/app/properties/${property.id}">${property.nickname}</a></div>
      <h1>Prepare your dispute</h1>
      <p class="text-2">A valid dispute must name <strong>specific amounts</strong> and the reasons they are wrong. The courts have held that a general complaint about a bill is not enough to stop credit control. We have pre-selected the bills where your readings show over-billing.</p>
      ${!property.account_number ? html`<div class="errors">Your municipal account number is missing. <a href="/app/properties/${property.id}/edit">Add it to the property</a> before sending the letter.</div>` : ''}
      <form method="post" action="/app/properties/${property.id}/disputes" class="stack">
        ${csrfField(req.csrfToken)}
        <div class="card">
          <h2>Bills to include</h2>
          ${candidates.length ? html`<div class="table-wrap"><table>
            <thead><tr><th></th><th>Bill date</th><th>Findings</th><th class="num">Amount</th></tr></thead>
            <tbody>${candidates.map((b) => html`<tr>
              <td><input type="checkbox" name="bill_ids" value="${b.bill.id}" aria-label="Include bill ${prettyDate(b.bill.bill_date)}" ${b.flagged ? 'checked' : ''} style="width:20px;height:20px"></td>
              <td>${prettyDate(b.bill.bill_date)}</td>
              <td>${b.consumption.flatMap((c) => c.result.flags).filter((f) => f.severity === 'high').length} problem(s)${b.manualDisputedCents ? ` · ${rand(b.manualDisputedCents)} disputed charges` : ''}${b.consumptionOverCents < 0 ? ' · catch-up credit' : ''}</td>
              <td class="num">${rand(b.consumptionOverCents + b.manualDisputedCents)}</td>
            </tr>`)}</tbody></table></div>
            <p class="muted" style="margin-top:8px">Include later bills that corrected an estimate (negative amounts) so the total is fair. The total is never allowed to go below zero.</p>`
            : html`<p>No over-billing has been found yet. Add readings around your bill dates and your bills, or tick "Dispute" on a wrong charge when editing a bill.</p>`}
        </div>
        <div class="card">
          <div class="field"><label for="title">Dispute name</label><input id="title" name="title" type="text" maxlength="120" value="${defaultTitle(preselected)}"></div>
          <div class="field"><label for="grounds_extra">Anything else the municipality should know? <span class="hint">Optional. Written into the letter's grounds, e.g. "The meter reader has not been able to access the property since March because..."</span></label><textarea id="grounds_extra" name="grounds_extra" maxlength="1500"></textarea></div>
          <div class="form-grid">
            <div class="field"><label for="amount_override">Disputed amount (R) <span class="hint">Leave blank to use our calculation (${rand(amounts.totalCents)})</span></label><input id="amount_override" name="amount_override" type="text" inputmode="decimal"></div>
            <div class="field"><label for="undisputed_override">You will keep paying (R/month) <span class="hint">Leave blank to use ${analysis.undisputedMonthlyCents ? rand(analysis.undisputedMonthlyCents) : 'our estimate'}</span></label><input id="undisputed_override" name="undisputed_override" type="text" inputmode="decimal"></div>
          </div>
          <button class="btn big" type="submit" ${candidates.length ? '' : 'disabled'}>Create dispute</button>
        </div>
      </form>
    </section>`,
  });
});

router.post('/app/properties/:id/disputes', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  const { analysis } = analyse(property.id);
  const raw = req.body.bill_ids;
  const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(Number).filter((n) => analysis.bills.some((b) => b.bill.id === n));
  if (!ids.length) return res.redirect(`/app/properties/${property.id}/disputes/new`);
  const amounts = disputeAmounts(analysis, ids);
  const override = toCents(req.body.amount_override);
  const undisputed = toCents(req.body.undisputed_override);
  const findings = {
    computedTotalCents: amounts.totalCents,
    consumptionCents: amounts.consumptionCents,
    manualCents: amounts.manualCents,
    bills: amounts.bills.map((b) => ({ id: b.bill.id, date: b.bill.bill_date, overCents: b.consumptionOverCents, manualCents: b.manualDisputedCents })),
  };
  const r = db.run(
    `INSERT INTO disputes (user_id, property_id, title, status, bill_ids, disputed_amount_cents, undisputed_monthly_cents, findings_json, grounds_extra, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    req.user.id, property.id, String(req.body.title || defaultTitle(amounts.bills)).slice(0, 120) || 'Billing dispute', 'draft', JSON.stringify(ids),
    override !== null && override > 0 ? override : amounts.totalCents,
    undisputed !== null && undisputed >= 0 ? undisputed : analysis.undisputedMonthlyCents || 0,
    JSON.stringify(findings), String(req.body.grounds_extra || '').slice(0, 1500), nowIso(), nowIso(),
  );
  const disputeId = Number(r.lastInsertRowid);
  db.run('INSERT INTO dispute_events (dispute_id, event_date, kind, description, created_at) VALUES (?,?,?,?,?)', disputeId, today(), 'created', `Dispute prepared for ${rand(override || amounts.totalCents)}.`, nowIso());
  track('dispute_created', { req, props: { amount: override || amounts.totalCents } });
  res.redirect(`/app/disputes/${disputeId}?ok=dispute`);
});

// ---------------------------------------------------------------- Letter building
function letterContext(user, dispute, extra = {}) {
  const property = db.one('SELECT * FROM properties WHERE id = ?', dispute.property_id);
  const { analysis, readings, bills } = analyse(property.id);
  const ids = JSON.parse(dispute.bill_ids || '[]');
  const amounts = disputeAmounts(analysis, ids);
  const relevantBills = bills.filter((b) => ids.includes(b.id));
  let photoIndex = 0;
  const numbered = readings.map((r) => ({ ...r, photoIndex: r.photo_file ? ++photoIndex : null }));
  const evidence = {
    readingCount: readings.length,
    photoCount: readings.filter((r) => r.photo_file).length,
    exifCount: readings.filter((r) => r.photo_taken_at).length,
    billDocCount: relevantBills.filter((b) => b.document_file).length,
  };
  return { user, property, dispute, amounts, analysis, readings: numbered, billDocs: relevantBills.filter((b) => b.document_file), evidence, undisputedMonthlyCents: analysis.undisputedMonthlyCents, ...extra };
}

function buildLetter(kind, ctx) {
  const def = LETTER_KINDS[kind];
  if (!def) return null;
  return def.build(ctx);
}

function letterExtras(query) {
  return {
    decisionDate: isValidDate(String(query.decision_date || '')) ? query.decision_date : null,
    decisionSummary: String(query.decision_summary || '').slice(0, 1000),
    noticeDate: isValidDate(String(query.notice_date || '')) ? query.notice_date : null,
  };
}

function paywall(req, res) {
  res.redirect(`/pricing?reason=letters&next=${encodeURIComponent(req.originalUrl)}`);
}

// ---------------------------------------------------------------- Dispute page
router.get('/app/disputes/:id', (req, res) => {
  const dispute = ownedDispute(req.user.id, req.params.id);
  if (!dispute) return notFound(req, res);
  const ctx = letterContext(req.user, dispute);
  const { property } = ctx;
  const letter = buildLetter('dispute', ctx);
  const text = toText(letter);
  const paid = isPaid(req.user);
  const events = db.all('SELECT * FROM dispute_events WHERE dispute_id = ? ORDER BY event_date DESC, id DESC', dispute.id);
  const open = !['resolved', 'withdrawn'].includes(dispute.status);
  const lodged = dispute.lodged_at;
  const daysOpen = lodged ? daysBetween(lodged, today()) : null;
  const m = findMunicipality(property.municipality);
  const mailto = property.dispute_email
    ? `mailto:${property.dispute_email}?subject=${encodeURIComponent(letter.subject)}&body=${encodeURIComponent(`Dear Sir/Madam\n\nPlease find attached my formal dispute in terms of section 102 of the Municipal Systems Act regarding account ${property.account_number}, together with my evidence pack.\n\nPlease acknowledge receipt and provide a dispute reference number.\n\nRegards\n${req.user.name}\n${req.user.phone || ''}`)}`
    : null;

  const preview = paid
    ? html`<div class="letter-preview"><pre>${text}</pre></div>`
    : html`<div class="letter-preview" style="position:relative;overflow:hidden;max-height:420px"><pre>${text.split('\n').slice(0, 22).join('\n')}</pre>
        <div style="position:absolute;inset:auto 0 0 0;height:220px;background:linear-gradient(to bottom, transparent, var(--surface) 55%)"></div></div>
        <div class="card" style="border:2px solid var(--accent);margin-top:-30px;position:relative">
          <h2>Unlock your dispute pack</h2>
          <p class="text-2">Get the full Section 102 letter, the evidence pack PDF (your dated meter photos, readings log and calculations), follow-up, appeal and disconnection letters, plus reminders until it is resolved.</p>
          <p><strong>${rand(dispute.disputed_amount_cents)}</strong> in dispute. The Dispute Pack is a once-off R299. No subscription.</p>
          <a class="btn big" href="/pricing?reason=letters&next=${encodeURIComponent(req.originalUrl)}">Unlock for R299</a>
        </div>`;

  render(req, res, {
    title: dispute.title,
    active: 'app',
    body: html`<section class="wrap page">
      <div class="crumbs"><a href="/app">Dashboard</a> / <a href="/app/properties/${property.id}">${property.nickname}</a></div>
      <div class="page-head">
        <div><h1>${dispute.title}</h1><p class="muted">${municipalityName(property)} · Account ${property.account_number || '(missing)'} ${dispute.reference_number ? `· Ref ${dispute.reference_number}` : ''}</p></div>
        <div>${statusBadge(dispute.status)}</div>
      </div>
      <div class="tiles" style="margin-bottom:16px">
        <div class="tile"><div class="label">In dispute</div><div class="value">${rand(dispute.disputed_amount_cents)}</div></div>
        <div class="tile"><div class="label">Keep paying monthly</div><div class="value">${dispute.undisputed_monthly_cents ? rand(dispute.undisputed_monthly_cents) : '—'}</div><div class="sub">Your actual usage</div></div>
        <div class="tile"><div class="label">${lodged ? 'Days since lodged' : 'Status'}</div><div class="value">${lodged ? daysOpen : 'Not sent'}</div>${lodged ? html`<div class="sub">Lodged ${prettyDate(lodged)}</div>` : ''}</div>
        ${dispute.status === 'resolved' ? html`<div class="tile"><div class="label">Credited</div><div class="value">${rand(dispute.credit_cents)}</div></div>` : ''}
      </div>

      <div class="grid-2" style="align-items:start">
        <div class="stack">
          ${dispute.status === 'draft' ? html`<div class="card"><h2>Send it in four steps</h2>
            <ol class="stack" style="padding-left:20px;margin:0">
              <li><strong>Download the evidence pack.</strong> It contains the letter, your readings log with dated photos and the calculation.</li>
              <li><strong>Send it to the municipality</strong>${property.dispute_email ? html` at <strong>${property.dispute_email}</strong>` : html` using the billing dispute channel on your bill or the municipality's website (<a href="/app/properties/${property.id}/edit">save the address</a>)`}. Email is best because you get a dated record. If you deliver it by hand, ask for a stamped copy.</li>
              <li><strong>Record that you have lodged it</strong> below, with the reference number when you get one.</li>
              <li><strong>Keep paying ${dispute.undisputed_monthly_cents ? rand(dispute.undisputed_monthly_cents) : 'the undisputed amount'} a month.</strong> Section 102 protects the disputed amount only.</li>
            </ol></div>` : ''}

          <div class="card">
            <h2>Documents</h2>
            ${paid ? html`<div class="stack">
              <a class="btn" href="/app/disputes/${dispute.id}/evidence.pdf">Download evidence pack (PDF)</a>
              <div class="row"><a class="btn secondary small" href="/app/disputes/${dispute.id}/letter/dispute.pdf">Letter only (PDF)</a>
              <button class="btn secondary small" type="button" data-copy="#letter-text">Copy letter text</button>
              ${mailto ? html`<a class="btn secondary small" href="${mailto}">Open email to municipality</a>` : ''}</div>
              <textarea id="letter-text" class="sr-only" aria-hidden="true" tabindex="-1">${text}</textarea>
              </div>`
              : html`<p class="text-2">Your letter and evidence pack are ready. Unlock them to download.</p><a class="btn" href="/pricing?reason=letters&next=${encodeURIComponent(req.originalUrl)}">Unlock dispute pack</a>`}
          </div>

          ${open ? html`<div class="card">
            <h2>Update the status</h2>
            ${!lodged ? html`<form method="post" action="/app/disputes/${dispute.id}/lodge" class="stack">
                ${csrfField(req.csrfToken)}
                <div class="form-grid">
                  <div class="field"><label for="lodged_at">Date sent</label><input id="lodged_at" name="lodged_at" type="date" value="${today()}" max="${today()}" required></div>
                  <div class="field"><label for="method">How</label><select id="method" name="method"><option>Email</option><option>Online portal</option><option>Hand delivered</option><option>Registered post</option></select></div>
                </div>
                <div class="field"><label for="reference_number">Reference number <span class="hint">If you already have one</span></label><input id="reference_number" name="reference_number" type="text" maxlength="60"></div>
                <button class="btn" type="submit">I have sent the dispute</button>
              </form>`
              : html`<form method="post" action="/app/disputes/${dispute.id}/status" class="stack">
                ${csrfField(req.csrfToken)}
                <div class="field"><label for="status">New status</label><select id="status" name="status">
                  ${['acknowledged', 'escalated', 'appealed', 'resolved', 'rejected', 'withdrawn'].map((s) => html`<option value="${s}" ${dispute.status === s ? 'selected' : ''}>${STATUS[s][0]}</option>`)}
                </select></div>
                <div class="form-grid">
                  <div class="field"><label for="reference_number2">Reference number</label><input id="reference_number2" name="reference_number" type="text" maxlength="60" value="${dispute.reference_number}"></div>
                  <div class="field"><label for="credit">Credit received (R) <span class="hint">If resolved</span></label><input id="credit" name="credit" type="text" inputmode="decimal" value="${dispute.credit_cents ? (dispute.credit_cents / 100).toFixed(2) : ''}"></div>
                </div>
                <div class="field"><label for="outcome">What happened?</label><input id="outcome" name="outcome" type="text" maxlength="300" value="${dispute.outcome}"></div>
                <button class="btn" type="submit">Save status</button>
              </form>`}
          </div>` : ''}

          ${paid && lodged ? html`<div class="card">
            <h2>Next letters</h2>
            ${daysOpen >= 14 && open ? html`<p class="flag medium" style="display:grid"><span class="ic">?</span><span>It has been ${daysOpen} days. If you have no reference number or resolution yet, send the follow-up letter.</span></p>` : ''}
            <div class="stack">
              <div><strong>Follow-up / escalation</strong><br><span class="muted">For when the municipality has not responded or resolved it.${m && m.ombud ? ` Mentions the ${m.ombud}.` : ''}</span><br>
                <a href="/app/disputes/${dispute.id}/evidence.pdf?kind=followup">Evidence pack with follow-up letter</a> · <a href="/app/disputes/${dispute.id}/letter/followup.pdf">Letter only</a></div>
              <form method="get" action="/app/disputes/${dispute.id}/evidence.pdf"><input type="hidden" name="kind" value="disconnection">
                <strong>Received a disconnection notice?</strong><br><span class="muted">Responds citing section 102(2) and asks for written confirmation within 48 hours.</span>
                <div class="row" style="margin-top:6px"><label for="notice_date" class="sr-only">Notice date</label><input id="notice_date" name="notice_date" type="date" style="max-width:180px" value="${today()}"><button class="btn small secondary" type="submit">Create response</button></div></form>
              <form method="get" action="/app/disputes/${dispute.id}/evidence.pdf"><input type="hidden" name="kind" value="appeal">
                <strong>Dispute rejected?</strong><br><span class="muted">A section 62 appeal must reach the municipal manager within 21 days of the decision.</span>
                <div class="field" style="margin-top:6px"><label for="decision_date">Date you were told</label><input id="decision_date" name="decision_date" type="date" value="${today()}" style="max-width:180px"></div>
                <div class="field"><label for="decision_summary">What did they decide?</label><input id="decision_summary" name="decision_summary" type="text" maxlength="500" placeholder="e.g. Dispute declined; readings said to be correct"></div>
                <button class="btn small secondary" type="submit">Create appeal</button></form>
            </div></div>` : ''}

          <div class="card">
            <h2>Timeline</h2>
            <ul class="timeline">${events.map((e) => html`<li><strong>${prettyDate(e.event_date)}</strong> · ${e.kind}${e.reference ? ` · ref ${e.reference}` : ''}<br><span class="text-2">${e.description}</span></li>`)}</ul>
            <details style="margin-top:8px"><summary>Add a note (call, email, visit…)</summary>
              <form method="post" action="/app/disputes/${dispute.id}/events" class="stack" style="margin-top:10px">
                ${csrfField(req.csrfToken)}
                <div class="form-grid">
                  <div class="field"><label for="event_date">Date</label><input id="event_date" name="event_date" type="date" value="${today()}" max="${today()}"></div>
                  <div class="field"><label for="kind">Type</label><select id="kind" name="kind"><option>call</option><option>email</option><option>visit</option><option>meter reading</option><option>credit</option><option>note</option></select></div>
                  <div class="field"><label for="reference">Reference / name</label><input id="reference" name="reference" type="text" maxlength="80"></div>
                </div>
                <div class="field"><label for="description">What happened?</label><textarea id="description" name="description" maxlength="1000" required></textarea></div>
                <button class="btn small" type="submit">Add to timeline</button>
              </form></details>
          </div>
          <form method="post" action="/app/disputes/${dispute.id}/delete" data-confirm="Delete this dispute and its timeline?">${csrfField(req.csrfToken)}<button class="linklike" type="submit">Delete dispute</button></form>
        </div>
        <div>
          <h2>Your letter</h2>
          ${preview}
        </div>
      </div>
    </section>`,
  });
});

router.post('/app/disputes/:id/lodge', (req, res) => {
  const dispute = ownedDispute(req.user.id, req.params.id);
  if (!dispute) return notFound(req, res);
  const date = isValidDate(String(req.body.lodged_at || '')) && req.body.lodged_at <= today() ? req.body.lodged_at : today();
  const ref = String(req.body.reference_number || '').trim().slice(0, 60);
  const method = String(req.body.method || 'Email').slice(0, 40);
  db.tx(() => {
    db.run('UPDATE disputes SET status = ?, lodged_at = ?, reference_number = ?, updated_at = ? WHERE id = ?', ref ? 'acknowledged' : 'lodged', date, ref, nowIso(), dispute.id);
    db.run('INSERT INTO dispute_events (dispute_id, event_date, kind, description, reference, created_at) VALUES (?,?,?,?,?,?)', dispute.id, date, 'lodged', `Dispute sent to the municipality (${method}).`, ref, nowIso());
  });
  track('dispute_lodged', { req });
  res.redirect(`/app/disputes/${dispute.id}?ok=lodged`);
});

router.post('/app/disputes/:id/status', (req, res) => {
  const dispute = ownedDispute(req.user.id, req.params.id);
  if (!dispute) return notFound(req, res);
  const status = String(req.body.status || '');
  if (!STATUS[status] || status === 'draft') return res.redirect(`/app/disputes/${dispute.id}`);
  const ref = String(req.body.reference_number || '').trim().slice(0, 60);
  const credit = Math.max(0, toCents(req.body.credit) || 0);
  const outcome = String(req.body.outcome || '').slice(0, 300);
  const resolved = ['resolved', 'rejected', 'withdrawn'].includes(status);
  db.tx(() => {
    db.run(
      'UPDATE disputes SET status = ?, reference_number = ?, credit_cents = ?, outcome = ?, resolved_at = ?, updated_at = ? WHERE id = ?',
      status, ref, credit, outcome, resolved ? dispute.resolved_at || today() : null, nowIso(), dispute.id,
    );
    if (status !== dispute.status) {
      db.run('INSERT INTO dispute_events (dispute_id, event_date, kind, description, reference, created_at) VALUES (?,?,?,?,?,?)', dispute.id, today(), status, outcome || `Status changed to ${STATUS[status][0].toLowerCase()}.`, ref, nowIso());
    }
  });
  if (status === 'resolved') track('dispute_resolved', { req, props: { credit } });
  res.redirect(`/app/disputes/${dispute.id}?ok=saved`);
});

router.post('/app/disputes/:id/events', (req, res) => {
  const dispute = ownedDispute(req.user.id, req.params.id);
  if (!dispute) return notFound(req, res);
  const date = isValidDate(String(req.body.event_date || '')) ? req.body.event_date : today();
  const description = String(req.body.description || '').trim().slice(0, 1000);
  if (description) {
    db.run('INSERT INTO dispute_events (dispute_id, event_date, kind, description, reference, created_at) VALUES (?,?,?,?,?,?)', dispute.id, date, String(req.body.kind || 'note').slice(0, 30), description, String(req.body.reference || '').slice(0, 80), nowIso());
    db.run('UPDATE disputes SET updated_at = ? WHERE id = ?', nowIso(), dispute.id);
  }
  res.redirect(`/app/disputes/${dispute.id}?ok=saved`);
});

router.post('/app/disputes/:id/delete', (req, res) => {
  const dispute = ownedDispute(req.user.id, req.params.id);
  if (!dispute) return notFound(req, res);
  db.run('DELETE FROM disputes WHERE id = ?', dispute.id);
  res.redirect(`/app/properties/${dispute.property_id}?ok=deleted`);
});

// ---------------------------------------------------------------- Downloads (paid)
function safeFilename(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
}

router.get('/app/disputes/:id/letter/:file', (req, res) => {
  const dispute = ownedDispute(req.user.id, req.params.id);
  if (!dispute) return notFound(req, res);
  const m = req.params.file.match(/^(dispute|followup|appeal|disconnection)\.(pdf|txt)$/);
  if (!m) return notFound(req, res);
  if (!isPaid(req.user)) return paywall(req, res);
  const letter = buildLetter(m[1], letterContext(req.user, dispute, letterExtras(req.query)));
  track('letter_downloaded', { req, props: { kind: m[1], format: m[2] } });
  const name = `${safeFilename(`${m[1]}-${dispute.title}`)}.${m[2]}`;
  if (m[2] === 'txt') {
    res.set('Content-Disposition', `attachment; filename="${name}"`).type('text/plain').send(toText(letter));
    return;
  }
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"` });
  letterPdf(letter, res);
});

router.get('/app/disputes/:id/evidence.pdf', (req, res) => {
  const dispute = ownedDispute(req.user.id, req.params.id);
  if (!dispute) return notFound(req, res);
  if (!isPaid(req.user)) return paywall(req, res);
  const kind = LETTER_KINDS[req.query.kind] ? req.query.kind : 'dispute';
  const ctx = letterContext(req.user, dispute, letterExtras(req.query));
  const letter = buildLetter(kind, ctx);
  if (kind !== 'dispute') {
    db.run('INSERT INTO dispute_events (dispute_id, event_date, kind, description, created_at) VALUES (?,?,?,?,?)', dispute.id, today(), 'letter', `${LETTER_KINDS[kind].label} generated.`, nowIso());
    if (kind === 'appeal' && dispute.status !== 'appealed') db.run("UPDATE disputes SET status = 'appealed', updated_at = ? WHERE id = ?", nowIso(), dispute.id);
    if (kind === 'followup' && ['lodged', 'acknowledged'].includes(dispute.status)) db.run("UPDATE disputes SET status = 'escalated', updated_at = ? WHERE id = ?", nowIso(), dispute.id);
  }
  track('evidence_pack_downloaded', { req, props: { kind } });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeFilename(`evidence-pack-${kind}-${dispute.title}`)}.pdf"` });
  evidencePackPdf({ letter, property: ctx.property, amounts: ctx.amounts, readings: ctx.readings, billDocs: ctx.billDocs }, res);
});

module.exports = router;
module.exports.flagList = flagList;
