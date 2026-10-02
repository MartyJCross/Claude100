'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const { html } = require('../lib/html');
const { render, notFound } = require('../lib/render');
const { errorsBox, csrfField } = require('../views/layout');
const { requireAuth, verifyCsrf } = require('../lib/security');
const { MUNICIPALITIES, municipalityName } = require('../lib/municipalities');
const { getProperty, listProperties, analyse, saveUpload, deleteUpload, propertyFiles } = require('../lib/data');
const { isPaid, propertyLimit, tierOf, TIERS } = require('../lib/plans');
const { track } = require('../lib/analytics');
const { rand, toCents, toNumber, today, nowIso, isValidDate, prettyDate, daysBetween, num, units, MONTHS } = require('../lib/format');
const { columns, line } = require('../views/charts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });

router.use('/app', requireAuth);

// Multer errors (e.g. too large) become a friendly message instead of a crash.
function uploadOne(field) {
  return (req, res, next) =>
    upload.single(field)(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 12 MB. Please upload a smaller photo or PDF.' : 'The upload failed. Please try again.';
        req.body = req.body || {};
      }
      next();
    });
}

const SEVERITY_LABEL = { high: 'Problem', medium: 'Check', low: 'Note' };
const SEVERITY_ICON = { high: '!', medium: '?', low: 'i' };

function flagList(flags) {
  if (!flags.length) return '';
  return html`<ul class="flags">${flags.map((f) => html`<li class="flag ${f.severity}"><span class="ic" aria-hidden="true">${SEVERITY_ICON[f.severity]}</span><div><strong>${SEVERITY_LABEL[f.severity]}</strong>${f.message}</div></li>`)}</ul>`;
}

// ---------------------------------------------------------------- Dashboard
router.get('/app', (req, res) => {
  const properties = listProperties(req.user.id);
  if (!properties.length) return res.redirect('/app/properties/new');
  const disputes = db.all(`SELECT d.*, p.nickname FROM disputes d JOIN properties p ON p.id = d.property_id WHERE d.user_id = ? ORDER BY d.updated_at DESC LIMIT 10`, req.user.id);
  const cards = properties.map((p) => {
    const { analysis, readings, bills } = analyse(p.id);
    const last = readings.length ? readings[readings.length - 1].reading_date : null;
    const stale = !last || daysBetween(last, today()) > 35;
    return { p, analysis, last, stale, billCount: bills.length };
  });
  const limit = propertyLimit(req.user);
  render(req, res, {
    title: 'Dashboard',
    active: 'app',
    body: html`<section class="wrap page">
      <div class="page-head">
        <div><h1>Your properties</h1><p class="muted">Plan: ${TIERS[tierOf(req.user)].label} · ${properties.length} of ${limit} ${limit === 1 ? 'property' : 'properties'}</p></div>
        ${properties.length < limit ? html`<a class="btn secondary" href="/app/properties/new">Add property</a>` : html`<a class="btn secondary" href="/pricing">Need more properties?</a>`}
      </div>
      <div class="grid-2">
        ${cards.map(({ p, analysis, last, stale, billCount }) => html`<article class="card">
          <div class="card-head"><h2><a href="/app/properties/${p.id}">${p.nickname}</a></h2>
            ${analysis.totals.disputableCents > 0 ? html`<span class="badge bad">Over-billed</span>` : billCount ? html`<span class="badge good">No problems found</span>` : html`<span class="badge">Getting started</span>`}</div>
          <p class="muted" style="margin-top:-6px">${municipalityName(p)}${p.account_number ? ` · Acc ${p.account_number}` : ''}</p>
          ${analysis.totals.disputableCents > 0 ? html`<p><span class="hero-figure" style="font-size:2rem">${rand(analysis.totals.disputableCents)}</span><br><span class="text-2">likely over-billed across ${analysis.totals.flaggedBillCount} ${analysis.totals.flaggedBillCount === 1 ? 'bill' : 'bills'}</span></p>` : ''}
          <p class="text-2">${billCount} ${billCount === 1 ? 'bill' : 'bills'} checked · last reading ${last ? prettyDate(last) : 'none yet'}</p>
          ${stale ? html`<p class="flag medium" style="display:grid"><span class="ic">?</span><span>${last ? 'It has been more than a month since your last reading.' : 'Take your first meter reading today.'}</span></p>` : ''}
          <div class="row" style="margin-top:12px"><a class="btn small" href="/app/properties/${p.id}/readings/new">Add reading</a><a class="btn small secondary" href="/app/properties/${p.id}/bills/new">Add bill</a><a class="btn small ghost" href="/app/properties/${p.id}">Open</a></div>
        </article>`)}
      </div>
      <h2 style="margin-top:32px">Disputes</h2>
      ${disputes.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Dispute</th><th>Property</th><th>Status</th><th class="num">Amount</th><th>Updated</th></tr></thead><tbody>
          ${disputes.map((d) => html`<tr><td><a href="/app/disputes/${d.id}">${d.title}</a></td><td>${d.nickname}</td><td>${statusBadge(d.status)}</td><td class="num">${rand(d.disputed_amount_cents)}</td><td>${prettyDate(d.updated_at.slice(0, 10))}</td></tr>`)}
          </tbody></table></div>`
        : html`<p class="muted">No disputes yet. When we find over-billing on a property, you can start one from the property page.</p>`}
    </section>`,
  });
});

const STATUS = {
  draft: ['Draft', ''],
  lodged: ['Lodged', 'info'],
  acknowledged: ['Acknowledged', 'info'],
  escalated: ['Escalated', 'warn'],
  appealed: ['Appealed', 'warn'],
  resolved: ['Resolved', 'good'],
  rejected: ['Rejected', 'bad'],
  withdrawn: ['Withdrawn', ''],
};
function statusBadge(status) {
  const [label, cls] = STATUS[status] || [status, ''];
  return html`<span class="badge ${cls}">${label}</span>`;
}

// ---------------------------------------------------------------- Properties
function propertyForm(req, res, { property = {}, errors = [], isNew = true }, status = 200) {
  const knownIds = MUNICIPALITIES.map((m) => m.id);
  const isOther = property.municipality && !knownIds.includes(property.municipality);
  const selected = isOther ? 'other' : property.municipality || '';
  render(req, res, {
    title: isNew ? 'Add a property' : `Edit ${property.nickname}`,
    active: 'app',
    body: html`<section class="wrap page narrow">
      <div class="crumbs"><a href="/app">Dashboard</a></div>
      <h1>${isNew ? 'Add the property' : 'Edit property'}</h1>
      ${isNew ? html`<p class="text-2">You will find most of this on your municipal bill. Only a name and the municipality are required now; the rest can be filled in before you send a dispute.</p>` : ''}
      <div class="card">
        ${errorsBox(errors)}
        <form method="post" action="${isNew ? '/app/properties' : `/app/properties/${property.id}`}">
          ${csrfField(req.csrfToken)}
          <div class="field"><label for="nickname">Name for this property <span class="hint">e.g. "Home" or "Flat 4, Rosebank"</span></label>
            <input id="nickname" name="nickname" type="text" required maxlength="80" value="${property.nickname || ''}"></div>
          <div class="field"><label for="municipality">Municipality</label>
            <select id="municipality" name="municipality" data-other-toggle="municipality_other_wrap" required>
              <option value="">Choose…</option>
              ${MUNICIPALITIES.map((m) => html`<option value="${m.id}" ${selected === m.id ? 'selected' : ''}>${m.name}</option>`)}
            </select></div>
          <div class="field" id="municipality_other_wrap" ${selected === 'other' ? '' : 'hidden'}><label for="municipality_other">Municipality name</label>
            <input id="municipality_other" name="municipality_other" type="text" maxlength="120" value="${isOther ? property.municipality : ''}"></div>
          <div class="form-grid">
            <div class="field"><label for="account_number">Municipal account number</label><input id="account_number" name="account_number" type="text" maxlength="40" value="${property.account_number || ''}"></div>
            <div class="field"><label for="account_holder">Account holder (as on bill)</label><input id="account_holder" name="account_holder" type="text" maxlength="120" value="${property.account_holder || ''}"></div>
          </div>
          <div class="field"><label for="address">Property address</label><input id="address" name="address" type="text" maxlength="200" value="${property.address || ''}"></div>
          <div class="form-grid">
            <div class="field"><label for="stand_number">Erf / stand number <span class="hint">Optional</span></label><input id="stand_number" name="stand_number" type="text" maxlength="40" value="${property.stand_number || ''}"></div>
            <div class="field"><label for="dispute_email">Billing dispute email <span class="hint">From your bill or the municipality's website</span></label><input id="dispute_email" name="dispute_email" type="email" maxlength="120" value="${property.dispute_email || ''}"></div>
          </div>
          <fieldset><legend>Meters to track</legend>
            <label class="check"><input type="checkbox" name="track_water" value="1" ${property.track_water === undefined || property.track_water ? 'checked' : ''}> <span>Water meter</span></label>
            <div class="field"><label for="water_meter_no">Water meter number <span class="hint">Printed on the meter and on your bill</span></label><input id="water_meter_no" name="water_meter_no" type="text" maxlength="40" value="${property.water_meter_no || ''}"></div>
            <label class="check"><input type="checkbox" name="track_electricity" value="1" ${property.track_electricity ? 'checked' : ''}> <span>Electricity meter (municipal, not prepaid)</span></label>
            <div class="field"><label for="elec_meter_no">Electricity meter number</label><input id="elec_meter_no" name="elec_meter_no" type="text" maxlength="40" value="${property.elec_meter_no || ''}"></div>
          </fieldset>
          <button class="btn big" type="submit">${isNew ? 'Save and add first reading' : 'Save changes'}</button>
        </form>
      </div>
      ${!isNew ? html`<form method="post" action="/app/properties/${property.id}/delete" style="margin-top:24px" data-confirm="Delete this property with all its readings, bills, photos and disputes? This cannot be undone.">${csrfField(req.csrfToken)}<button class="btn danger small" type="submit">Delete property</button></form>` : ''}
    </section>`,
  }, status);
}

function readPropertyBody(body) {
  const known = MUNICIPALITIES.map((m) => m.id);
  let municipality = String(body.municipality || '');
  if (municipality === 'other' && String(body.municipality_other || '').trim()) municipality = String(body.municipality_other).trim().slice(0, 120);
  else if (!known.includes(municipality)) municipality = '';
  const s = (k, n) => String(body[k] || '').trim().slice(0, n);
  const p = {
    nickname: s('nickname', 80),
    municipality,
    account_number: s('account_number', 40),
    account_holder: s('account_holder', 120),
    address: s('address', 200),
    stand_number: s('stand_number', 40),
    dispute_email: s('dispute_email', 120),
    water_meter_no: s('water_meter_no', 40),
    elec_meter_no: s('elec_meter_no', 40),
    track_water: body.track_water ? 1 : 0,
    track_electricity: body.track_electricity ? 1 : 0,
  };
  const errors = [];
  if (!p.nickname) errors.push('Give the property a name.');
  if (!p.municipality) errors.push('Choose the municipality.');
  if (!p.track_water && !p.track_electricity) errors.push('Track at least one meter.');
  if (p.dispute_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.dispute_email)) errors.push('The dispute email address does not look right.');
  return { p, errors };
}

router.get('/app/properties/new', (req, res) => {
  if (listProperties(req.user.id).length >= propertyLimit(req.user)) return res.redirect('/pricing?reason=properties');
  propertyForm(req, res, {});
});

router.post('/app/properties', (req, res) => {
  if (listProperties(req.user.id).length >= propertyLimit(req.user)) return res.redirect('/pricing?reason=properties');
  const { p, errors } = readPropertyBody(req.body);
  if (errors.length) return propertyForm(req, res, { property: p, errors }, 422);
  const r = db.run(
    `INSERT INTO properties (user_id, nickname, municipality, account_number, account_holder, address, stand_number, dispute_email, water_meter_no, elec_meter_no, track_water, track_electricity, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.user.id, p.nickname, p.municipality, p.account_number, p.account_holder, p.address, p.stand_number, p.dispute_email, p.water_meter_no, p.elec_meter_no, p.track_water, p.track_electricity, nowIso(),
  );
  track('property_created', { req });
  res.redirect(`/app/properties/${r.lastInsertRowid}/readings/new`);
});

router.get('/app/properties/:id/edit', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  propertyForm(req, res, { property, isNew: false });
});

router.post('/app/properties/:id', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  const { p, errors } = readPropertyBody(req.body);
  if (errors.length) return propertyForm(req, res, { property: { ...p, id: property.id }, errors, isNew: false }, 422);
  db.run(
    `UPDATE properties SET nickname=?, municipality=?, account_number=?, account_holder=?, address=?, stand_number=?, dispute_email=?, water_meter_no=?, elec_meter_no=?, track_water=?, track_electricity=? WHERE id=?`,
    p.nickname, p.municipality, p.account_number, p.account_holder, p.address, p.stand_number, p.dispute_email, p.water_meter_no, p.elec_meter_no, p.track_water, p.track_electricity, property.id,
  );
  res.redirect(`/app/properties/${property.id}?ok=saved`);
});

router.post('/app/properties/:id/delete', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  const files = propertyFiles(property.id);
  db.run('DELETE FROM properties WHERE id = ?', property.id);
  files.forEach(deleteUpload);
  res.redirect('/app?ok=deleted');
});

// ---------------------------------------------------------------- Property overview
function utilityCharts(utility, analysis) {
  const u = units(utility);
  const rows = analysis.bills.flatMap((b) => b.consumption.filter((c) => c.line.utility === utility).map((c) => ({ b, c }))).slice(-8);
  const parts = [];
  if (rows.some((r) => r.c.result.billedUnits !== null)) {
    parts.push(columns({
      title: `${utility === 'water' ? 'Water' : 'Electricity'}: billed vs your meter`,
      sub: `${u} per bill. Where orange towers over blue, you were charged for usage that did not happen.`,
      // Year hides on narrow screens so month labels never collide.
      categories: rows.map((r) => html`${MONTHS[Number(r.b.bill.bill_date.slice(5, 7)) - 1]}<span class="yr"> ’${r.b.bill.bill_date.slice(2, 4)}</span>`),
      series: [
        { name: 'Your meter (actual)', cls: 's1', values: rows.map((r) => r.c.result.actualUnits), tips: rows.map((r) => `${prettyDate(r.b.bill.bill_date)}\nYour meter: ${num(r.c.result.actualUnits)} ${u}`) },
        { name: 'Billed', cls: 's2', values: rows.map((r) => r.c.result.billedUnits), tips: rows.map((r) => `${prettyDate(r.b.bill.bill_date)}\nBilled: ${num(r.c.result.billedUnits)} ${u}${r.c.line.reading_type === 'estimated' ? ' (estimated)' : ''}`) },
      ],
      fmt: (v) => num(v, 0),
    }));
  }
  const rates = analysis.utilities[utility].rates.filter((r) => r.perDay >= 0).slice(-12);
  if (rates.length >= 2) {
    parts.push(line({
      title: `${utility === 'water' ? 'Water' : 'Electricity'} use per day, from your readings`,
      sub: `Average ${u}/day between readings. A sudden jump with no change at home can mean a leak.`,
      points: rates.map((r) => ({ day: Math.round(new Date(`${r.to}T00:00:00Z`).getTime() / 86400000), label: prettyDate(r.to), value: r.perDay, tip: `${prettyDate(r.from)} to ${prettyDate(r.to)}\n${num(r.perDay, 3)} ${u}/day` })),
      fmt: (v) => num(v, 1),
    }));
  }
  return parts;
}

router.get('/app/properties/:id', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  const { analysis, readings, bills } = analyse(property.id);
  const disputes = db.all('SELECT * FROM disputes WHERE property_id = ? ORDER BY created_at DESC', property.id);
  const t = analysis.totals;
  const tracked = ['water', 'electricity'].filter((u) => property[u === 'water' ? 'track_water' : 'track_electricity']);
  const paid = isPaid(req.user);
  track('analysis_viewed', { req, props: { property: property.id, disputable: t.disputableCents } });

  let verdict;
  if (!readings.length || !bills.length) {
    verdict = html`<div class="card"><h2>Get your first result in three steps</h2>
      <ol class="stack" style="padding-left:20px">
        <li>${readings.length ? html`<strong>Done:</strong> ` : ''}<a href="/app/properties/${property.id}/readings/new">Photograph your meter and record the reading</a>. Do it today, and again on the same day each month.</li>
        <li>${bills.length ? html`<strong>Done:</strong> ` : ''}<a href="/app/properties/${property.id}/bills/new">Add your latest municipal bill</a> (and older ones if you have them). Copy the readings and amounts from the bill.</li>
        <li>We compare each bill with what your meter really shows and price any difference in Rand.</li>
      </ol></div>`;
  } else if (t.disputableCents > 0) {
    verdict = html`<div class="callout"><span class="eyebrow" style="color:var(--critical-text)">Over-billing found</span>
      <div class="hero-figure">${rand(t.disputableCents)}</div>
      <p class="text-2" style="margin-top:6px">likely over-billed across ${t.flaggedBillCount} ${t.flaggedBillCount === 1 ? 'bill' : 'bills'}, based on ${readings.length} of your own meter readings.
      ${analysis.undisputedMonthlyCents ? html`While you dispute, keep paying about <strong>${rand(analysis.undisputedMonthlyCents)}</strong> a month (your actual usage) so the municipality cannot say you stopped paying.` : ''}</p>
      <div class="row"><a class="btn big" href="/app/properties/${property.id}/disputes/new">${paid ? 'Prepare my dispute' : 'Prepare my dispute pack'}</a><a class="btn ghost" href="/guides/dispute-municipal-bill">How disputes work</a></div></div>`;
  } else {
    verdict = html`<div class="callout good"><span class="eyebrow" style="color:var(--good-text)">All clear</span><h2>No over-billing found on ${t.billCount} ${t.billCount === 1 ? 'bill' : 'bills'}</h2>
      <p class="text-2">Keep adding a reading each month and each new bill. We will flag the first estimated or inflated charge.</p></div>`;
  }

  const billRows = analysis.bills.slice().reverse();
  render(req, res, {
    title: property.nickname,
    active: 'app',
    body: html`<section class="wrap page">
      <div class="crumbs"><a href="/app">Dashboard</a></div>
      <div class="page-head">
        <div><h1>${property.nickname}</h1><p class="muted">${municipalityName(property)}${property.account_number ? ` · Account ${property.account_number}` : ''}${property.address ? ` · ${property.address}` : ''}</p></div>
        <div class="row"><a class="btn" href="/app/properties/${property.id}/readings/new">Add reading</a><a class="btn secondary" href="/app/properties/${property.id}/bills/new">Add bill</a><a class="btn ghost" href="/app/properties/${property.id}/edit">Edit</a></div>
      </div>
      <div class="stack">
        ${verdict}
        ${analysis.summaryFlags.length ? html`<div class="card">${flagList(analysis.summaryFlags)}</div>` : ''}
        ${tracked.map((u) => {
          const charts = utilityCharts(u, analysis);
          return charts.length ? html`<div class="grid-2">${charts.map((c) => html`<div class="card">${c}</div>`)}</div>` : '';
        })}

        <div class="card">
          <div class="card-head"><h2>Bills</h2><a class="btn small secondary" href="/app/properties/${property.id}/bills/new">Add bill</a></div>
          ${billRows.length ? html`<div class="table-wrap"><table>
            <thead><tr><th>Bill date</th><th>Service</th><th class="num">Billed</th><th class="num">Your meter</th><th class="num">Difference</th><th class="num">Over-billed</th><th>Findings</th><th></th></tr></thead>
            <tbody>${billRows.map((b) => {
              const lines = b.consumption.length ? b.consumption : [null];
              return lines.map((c, i) => {
                const r = c && c.result;
                const flags = [...(r ? r.flags : []), ...(i === 0 ? b.flags : [])];
                return html`<tr>
                  <td>${i === 0 ? html`<a href="/app/bills/${b.bill.id}/edit">${prettyDate(b.bill.bill_date)}</a>` : ''}</td>
                  <td>${r ? html`${r.utility === 'water' ? 'Water' : 'Electricity'}${c.line.reading_type === 'estimated' ? html` <span class="badge warn">Estimated</span>` : c.line.reading_type === 'actual' ? html` <span class="badge">Actual</span>` : ''}` : html`<span class="muted">Other charges only</span>`}</td>
                  <td class="num">${r && r.billedUnits !== null ? `${num(r.billedUnits)} ${units(r.utility)}` : '—'}</td>
                  <td class="num">${r && r.actualUnits !== null ? `${num(r.actualUnits)} ${units(r.utility)}` : '—'}</td>
                  <td class="num">${r && r.diffUnits !== null ? `${r.diffUnits > 0 ? '+' : ''}${num(r.diffUnits)}` : '—'}</td>
                  <td class="num">${r && r.overchargeCents && r.confidence ? rand(r.overchargeCents) : i === 0 && b.manualDisputedCents ? rand(b.manualDisputedCents) : '—'}</td>
                  <td>${flags.length ? html`<details><summary>${flags.filter((f) => f.severity === 'high').length ? html`<span class="badge bad">${flags.length} ${flags.length === 1 ? 'finding' : 'findings'}</span>` : html`<span class="badge warn">${flags.length} ${flags.length === 1 ? 'note' : 'notes'}</span>`}</summary><div style="margin-top:8px;min-width:260px">${flagList(flags)}</div></details>` : r && r.actualUnits !== null ? html`<span class="badge good">Matches</span>` : ''}</td>
                  <td>${i === 0 ? html`<a href="/app/bills/${b.bill.id}/edit" class="muted">Edit</a>` : ''}</td>
                </tr>`;
              });
            })}</tbody></table></div>`
            : html`<p class="empty">No bills yet. <a href="/app/properties/${property.id}/bills/new">Add your latest municipal bill</a>.</p>`}
        </div>

        <div class="card">
          <div class="card-head"><h2>Meter readings</h2><a class="btn small" href="/app/properties/${property.id}/readings/new">Add reading</a></div>
          ${readings.length ? html`<div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Meter</th><th class="num">Reading</th><th>Photo</th><th>Camera time</th><th>Note</th><th></th></tr></thead>
            <tbody>${readings.slice().reverse().map((r) => html`<tr>
              <td>${prettyDate(r.reading_date)}</td>
              <td>${r.utility === 'water' ? 'Water' : 'Electricity'}</td>
              <td class="num">${num(r.value, 3)} ${units(r.utility)}</td>
              <td>${r.photo_file ? (['image/jpeg', 'image/png', 'image/webp'].includes(r.photo_mime) ? html`<a href="/files/${r.photo_file}" target="_blank"><img class="photo-thumb" src="/files/${r.photo_file}" alt="Meter photo ${prettyDate(r.reading_date)}" loading="lazy"></a>` : html`<a href="/files/${r.photo_file}">View</a>`) : html`<span class="muted">None</span>`}</td>
              <td>${r.photo_taken_at ? html`<span class="badge good">${r.photo_taken_at.replace('T', ' ').slice(0, 16)}</span>` : html`<span class="muted">—</span>`}</td>
              <td>${r.note}</td>
              <td><form method="post" action="/app/readings/${r.id}/delete" data-confirm="Delete this reading?">${csrfField(req.csrfToken)}<button class="linklike" type="submit">Delete</button></form></td>
            </tr>`)}</tbody></table></div>`
            : html`<p class="empty">No readings yet. <a href="/app/properties/${property.id}/readings/new">Record your first reading</a>.</p>`}
        </div>

        ${disputes.length ? html`<div class="card"><h2>Disputes</h2><div class="table-wrap"><table><thead><tr><th>Dispute</th><th>Status</th><th class="num">Amount</th><th>Created</th></tr></thead><tbody>
          ${disputes.map((d) => html`<tr><td><a href="/app/disputes/${d.id}">${d.title}</a></td><td>${statusBadge(d.status)}</td><td class="num">${rand(d.disputed_amount_cents)}</td><td>${prettyDate(d.created_at.slice(0, 10))}</td></tr>`)}
        </tbody></table></div></div>` : ''}
      </div>
    </section>`,
  });
});

// ---------------------------------------------------------------- Readings
function readingForm(req, res, { property, values = {}, errors = [] }, status = 200) {
  const tracked = ['water', 'electricity'].filter((u) => property[u === 'water' ? 'track_water' : 'track_electricity']);
  render(req, res, {
    title: 'Add a meter reading',
    active: 'app',
    body: html`<section class="wrap page narrow">
      <div class="crumbs"><a href="/app">Dashboard</a> / <a href="/app/properties/${property.id}">${property.nickname}</a></div>
      <h1>Add a meter reading</h1>
      <p class="text-2">Photograph the meter so the dial numbers are readable, then type the reading exactly as shown, including the red digits after the decimal point if your meter has them. Your phone camera stamps the photo with the date and time, which makes it strong evidence.</p>
      <div class="card">
        ${errorsBox(errors)}
        <form method="post" action="/app/properties/${property.id}/readings" enctype="multipart/form-data">
          ${csrfField(req.csrfToken)}
          ${tracked.length > 1
            ? html`<div class="field"><label for="utility">Meter</label><select id="utility" name="utility">${tracked.map((u) => html`<option value="${u}" ${values.utility === u ? 'selected' : ''}>${u === 'water' ? 'Water (kL)' : 'Electricity (kWh)'}</option>`)}</select></div>`
            : html`<input type="hidden" name="utility" value="${tracked[0] || 'water'}">`}
          <div class="field"><label for="photo">Photo of the meter <span class="hint">Recommended. JPEG, PNG or HEIC up to 12 MB.</span></label>
            <input id="photo" name="photo" type="file" accept="image/*" capture="environment"></div>
          <div class="form-grid">
            <div class="field"><label for="value">Reading <span class="hint">${tracked.length > 1 ? 'kL or kWh' : units(tracked[0])}</span></label>
              <input id="value" name="value" type="text" inputmode="decimal" required value="${values.value || ''}" placeholder="e.g. 1045.32"></div>
            <div class="field"><label for="reading_date">Date read</label>
              <input id="reading_date" name="reading_date" type="date" required max="${today()}" value="${values.reading_date || today()}"></div>
          </div>
          <div class="field"><label for="note">Note <span class="hint">Optional, e.g. "meter reader visited today"</span></label><input id="note" name="note" type="text" maxlength="200" value="${values.note || ''}"></div>
          <button class="btn big" type="submit">Save reading</button>
        </form>
      </div>
    </section>`,
  }, status);
}

router.get('/app/properties/:id/readings/new', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  readingForm(req, res, { property, values: { utility: req.query.utility } });
});

router.post('/app/properties/:id/readings', uploadOne('photo'), verifyCsrf, (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  const utility = req.body.utility === 'electricity' ? 'electricity' : 'water';
  const value = toNumber(req.body.value);
  const date = String(req.body.reading_date || '');
  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);
  if (value === null || value < 0) errors.push('Enter the reading as a number, e.g. 1045.32');
  if (!isValidDate(date)) errors.push('Enter the date you read the meter.');
  else if (date > today()) errors.push('The reading date cannot be in the future.');
  let saved = null;
  if (!errors.length && req.file) {
    saved = saveUpload(req.file);
    if (!saved) errors.push('That photo format is not supported. Please upload a JPEG, PNG, WebP or HEIC image.');
  }
  if (errors.length) return readingForm(req, res, { property, values: req.body, errors }, 422);
  db.run(
    'INSERT INTO readings (property_id, utility, reading_date, value, photo_file, photo_mime, photo_taken_at, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    property.id, utility, date, value, saved ? saved.name : null, saved ? saved.mime : null, saved ? saved.takenAt : null, String(req.body.note || '').slice(0, 200), nowIso(),
  );
  track('reading_added', { req, props: { photo: !!saved, exif: !!(saved && saved.takenAt) } });
  res.redirect(`/app/properties/${property.id}?ok=reading`);
});

router.post('/app/readings/:id/delete', (req, res) => {
  const r = db.one('SELECT r.* FROM readings r JOIN properties p ON p.id = r.property_id WHERE r.id = ? AND p.user_id = ?', Number(req.params.id), req.user.id);
  if (!r) return notFound(req, res);
  db.run('DELETE FROM readings WHERE id = ?', r.id);
  deleteUpload(r.photo_file);
  res.redirect(`/app/properties/${r.property_id}?ok=deleted`);
});

// ---------------------------------------------------------------- Bills
const DEFAULT_CHARGES = [
  { kind: 'charge', label: 'Property rates' },
  { kind: 'charge', label: 'Refuse removal' },
  { kind: 'charge', label: 'Sewerage' },
  { kind: 'interest', label: 'Interest' },
  { kind: 'charge', label: '' },
  { kind: 'charge', label: '' },
];
const CHARGE_ROWS = DEFAULT_CHARGES.length;

function billFormValues(bill, lastLines) {
  const v = { bill_date: '', due_date: '', total_due: '', notes: '' };
  for (const u of ['water', 'electricity']) {
    v[`${u}_type`] = 'unknown';
    const last = lastLines && lastLines[u];
    if (last) {
      v[`${u}_prev`] = last.curr_reading ?? '';
      v[`${u}_prev_date`] = last.curr_date || '';
    }
  }
  DEFAULT_CHARGES.forEach((c, i) => {
    v[`charge_kind_${i}`] = c.kind;
    v[`charge_label_${i}`] = c.label;
  });
  if (!bill) return v;
  v.bill_date = bill.bill_date;
  v.due_date = bill.due_date || '';
  v.total_due = bill.total_due_cents ? (bill.total_due_cents / 100).toFixed(2) : '';
  v.notes = bill.notes;
  let ci = 0;
  for (const l of bill.lines) {
    if (l.kind === 'consumption') {
      const u = l.utility;
      v[`${u}_type`] = l.reading_type;
      v[`${u}_prev`] = l.prev_reading ?? '';
      v[`${u}_prev_date`] = l.prev_date || '';
      v[`${u}_curr`] = l.curr_reading ?? '';
      v[`${u}_curr_date`] = l.curr_date || '';
      v[`${u}_units`] = l.units_billed ?? '';
      v[`${u}_amount`] = (l.amount_cents / 100).toFixed(2);
    } else if (ci < CHARGE_ROWS) {
      v[`charge_kind_${ci}`] = l.kind;
      v[`charge_label_${ci}`] = l.label;
      v[`charge_amount_${ci}`] = (l.amount_cents / 100).toFixed(2);
      v[`charge_disputed_${ci}`] = l.disputed ? '1' : '';
      v[`charge_reason_${ci}`] = l.dispute_reason;
      ci++;
    }
  }
  for (; ci < CHARGE_ROWS; ci++) {
    v[`charge_kind_${ci}`] = 'charge';
    v[`charge_label_${ci}`] = '';
  }
  return v;
}

function consumptionFieldset(u, v) {
  const unit = units(u);
  const f = (k) => v[`${u}_${k}`] ?? '';
  return html`<fieldset><legend>${u === 'water' ? 'Water' : 'Electricity'}</legend>
    <div class="field"><label for="${u}_type">Reading type on the bill <span class="hint">Bills usually mark readings as "A" (actual) or "E" (estimated).</span></label>
      <select id="${u}_type" name="${u}_type">
        ${[['unknown', 'Not shown / not sure'], ['actual', 'Actual reading'], ['estimated', 'Estimated reading']].map(([val, label]) => html`<option value="${val}" ${f('type') === val ? 'selected' : ''}>${label}</option>`)}
      </select></div>
    <div class="form-grid">
      <div class="field"><label for="${u}_prev">Previous reading</label><input id="${u}_prev" name="${u}_prev" type="text" inputmode="decimal" value="${f('prev')}"></div>
      <div class="field"><label for="${u}_prev_date">Previous reading date</label><input id="${u}_prev_date" name="${u}_prev_date" type="date" value="${f('prev_date')}"></div>
      <div class="field"><label for="${u}_curr">Current reading</label><input id="${u}_curr" name="${u}_curr" type="text" inputmode="decimal" value="${f('curr')}"></div>
      <div class="field"><label for="${u}_curr_date">Current reading date</label><input id="${u}_curr_date" name="${u}_curr_date" type="date" value="${f('curr_date')}"></div>
      <div class="field"><label for="${u}_units">Units charged (${unit}) <span class="hint">If different from current minus previous</span></label><input id="${u}_units" name="${u}_units" type="text" inputmode="decimal" value="${f('units')}"></div>
      <div class="field"><label for="${u}_amount">Amount charged (R) <span class="hint">Including VAT</span></label><input id="${u}_amount" name="${u}_amount" type="text" inputmode="decimal" value="${f('amount')}"></div>
    </div></fieldset>`;
}

function billForm(req, res, { property, bill = null, values, errors = [] }, status = 200) {
  const v = values;
  const tracked = ['water', 'electricity'].filter((u) => property[u === 'water' ? 'track_water' : 'track_electricity']);
  const action = bill ? `/app/bills/${bill.id}` : `/app/properties/${property.id}/bills`;
  render(req, res, {
    title: bill ? 'Edit bill' : 'Add a municipal bill',
    active: 'app',
    body: html`<section class="wrap page" style="max-width:820px">
      <div class="crumbs"><a href="/app">Dashboard</a> / <a href="/app/properties/${property.id}">${property.nickname}</a></div>
      <h1>${bill ? `Bill of ${prettyDate(bill.bill_date)}` : 'Add a municipal bill'}</h1>
      <p class="text-2">Copy the figures from the bill's consumption section. Leave a service blank if it is not on this bill. Previous readings are pre-filled from your last bill.</p>
      ${errorsBox(errors)}
      <form method="post" action="${action}" enctype="multipart/form-data" class="stack">
        ${csrfField(req.csrfToken)}
        <div class="card">
          <div class="form-grid">
            <div class="field"><label for="bill_date">Bill (statement) date</label><input id="bill_date" name="bill_date" type="date" required value="${v.bill_date}"></div>
            <div class="field"><label for="due_date">Due date <span class="hint">Optional</span></label><input id="due_date" name="due_date" type="date" value="${v.due_date}"></div>
            <div class="field"><label for="total_due">Total amount due (R) <span class="hint">Optional</span></label><input id="total_due" name="total_due" type="text" inputmode="decimal" value="${v.total_due}"></div>
          </div>
          <div class="field"><label for="document">Copy of the bill <span class="hint">Optional. PDF or photo, attached to your evidence pack.${bill && bill.document_file ? ' A copy is already saved; uploading replaces it.' : ''}</span></label><input id="document" name="document" type="file" accept="application/pdf,image/*"></div>
        </div>
        <div class="card">${tracked.map((u) => consumptionFieldset(u, v))}</div>
        <div class="card">
          <h2>Other charges on this bill</h2>
          <p class="muted">Optional, but needed to work out what you should keep paying during a dispute. Tick "Dispute" for any charge that is wrong (e.g. refuse charged twice, wrong tariff, interest on a disputed amount).</p>
          <div class="table-wrap"><table>
            <thead><tr><th>Charge</th><th class="num">Amount (R)</th><th>Dispute</th><th>Why it is wrong</th></tr></thead>
            <tbody>${Array.from({ length: CHARGE_ROWS }, (_, i) => html`<tr>
              <td><input type="hidden" name="charge_kind_${i}" value="${v[`charge_kind_${i}`] || 'charge'}"><input aria-label="Charge name" name="charge_label_${i}" type="text" maxlength="60" value="${v[`charge_label_${i}`] || ''}" placeholder="Charge name"></td>
              <td><input aria-label="Amount" name="charge_amount_${i}" type="text" inputmode="decimal" value="${v[`charge_amount_${i}`] || ''}" style="min-width:100px"></td>
              <td style="text-align:center"><input aria-label="Dispute this charge" type="checkbox" name="charge_disputed_${i}" value="1" ${v[`charge_disputed_${i}`] ? 'checked' : ''} style="width:20px;height:20px"></td>
              <td><input aria-label="Reason" name="charge_reason_${i}" type="text" maxlength="200" value="${v[`charge_reason_${i}`] || ''}" style="min-width:180px"></td>
            </tr>`)}</tbody>
          </table></div>
        </div>
        <div class="card"><div class="field"><label for="notes">Notes <span class="hint">Optional</span></label><textarea id="notes" name="notes" maxlength="1000">${v.notes || ''}</textarea></div>
          <button class="btn big" type="submit">${bill ? 'Save bill' : 'Save and check this bill'}</button></div>
      </form>
      ${bill ? html`<form method="post" action="/app/bills/${bill.id}/delete" style="margin-top:20px" data-confirm="Delete this bill?">${csrfField(req.csrfToken)}<button class="btn danger small" type="submit">Delete bill</button></form>` : ''}
    </section>`,
  }, status);
}

function parseBill(body, property) {
  const errors = [];
  const bill = {
    bill_date: String(body.bill_date || ''),
    due_date: isValidDate(String(body.due_date || '')) ? body.due_date : null,
    total_due_cents: toCents(body.total_due) || 0,
    notes: String(body.notes || '').slice(0, 1000),
  };
  if (!isValidDate(bill.bill_date)) errors.push('Enter the bill date.');
  const lines = [];
  for (const u of ['water', 'electricity']) {
    if (!property[u === 'water' ? 'track_water' : 'track_electricity']) continue;
    const g = (k) => body[`${u}_${k}`];
    const any = ['prev', 'curr', 'units', 'amount'].some((k) => String(g(k) || '').trim() !== '');
    if (!any) continue;
    const name = u === 'water' ? 'water' : 'electricity';
    const l = {
      kind: 'consumption',
      utility: u,
      label: u === 'water' ? 'Water' : 'Electricity',
      reading_type: ['actual', 'estimated'].includes(g('type')) ? g('type') : 'unknown',
      prev_reading: toNumber(g('prev')),
      curr_reading: toNumber(g('curr')),
      prev_date: isValidDate(String(g('prev_date') || '')) ? g('prev_date') : null,
      curr_date: isValidDate(String(g('curr_date') || '')) ? g('curr_date') : null,
      units_billed: toNumber(g('units')),
      amount_cents: toCents(g('amount')),
      disputed: 0,
      dispute_reason: '',
    };
    if (l.amount_cents === null) errors.push(`Enter the ${name} amount charged.`);
    if (l.units_billed === null && (l.prev_reading === null || l.curr_reading === null)) errors.push(`Enter either the ${name} readings or the units charged.`);
    if ((l.prev_reading !== null || l.curr_reading !== null) && (!l.prev_date || !l.curr_date)) errors.push(`Enter both ${name} reading dates so we can match them to your meter readings.`);
    if (l.prev_date && l.curr_date && l.curr_date < l.prev_date) errors.push(`The ${name} current reading date is before the previous reading date.`);
    lines.push(l);
  }
  for (let i = 0; i < CHARGE_ROWS; i++) {
    const label = String(body[`charge_label_${i}`] || '').trim().slice(0, 60);
    const amount = toCents(body[`charge_amount_${i}`]);
    if (amount === null) continue;
    lines.push({
      kind: body[`charge_kind_${i}`] === 'interest' ? 'interest' : 'charge',
      utility: null,
      label: label || 'Charge',
      reading_type: 'unknown',
      prev_reading: null,
      curr_reading: null,
      prev_date: null,
      curr_date: null,
      units_billed: null,
      amount_cents: amount,
      disputed: body[`charge_disputed_${i}`] ? 1 : 0,
      dispute_reason: String(body[`charge_reason_${i}`] || '').slice(0, 200),
    });
  }
  if (!errors.length && !lines.length) errors.push('Enter at least one charge from the bill.');
  return { bill, lines, errors };
}

function insertLines(billId, lines) {
  for (const l of lines) {
    db.run(
      `INSERT INTO bill_lines (bill_id, kind, utility, label, reading_type, prev_reading, curr_reading, prev_date, curr_date, units_billed, amount_cents, disputed, dispute_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      billId, l.kind, l.utility, l.label, l.reading_type, l.prev_reading, l.curr_reading, l.prev_date, l.curr_date, l.units_billed, l.amount_cents, l.disputed, l.dispute_reason,
    );
  }
}

function lastLines(propertyId) {
  const out = {};
  for (const u of ['water', 'electricity']) {
    out[u] = db.one(`SELECT l.* FROM bill_lines l JOIN bills b ON b.id = l.bill_id WHERE b.property_id = ? AND l.kind = 'consumption' AND l.utility = ? ORDER BY b.bill_date DESC, b.id DESC LIMIT 1`, propertyId, u);
  }
  return out;
}

router.get('/app/properties/:id/bills/new', (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  billForm(req, res, { property, values: billFormValues(null, lastLines(property.id)) });
});

router.post('/app/properties/:id/bills', uploadOne('document'), verifyCsrf, (req, res) => {
  const property = getProperty(req.user.id, req.params.id);
  if (!property) return notFound(req, res);
  const { bill, lines, errors } = parseBill(req.body, property);
  if (req.uploadError) errors.push(req.uploadError);
  let doc = null;
  if (!errors.length && req.file) {
    doc = saveUpload(req.file, { allowPdf: true });
    if (!doc) errors.push('The bill copy must be a PDF or an image.');
  }
  if (errors.length) return billForm(req, res, { property, values: req.body, errors }, 422);
  db.tx(() => {
    const r = db.run(
      'INSERT INTO bills (property_id, bill_date, due_date, total_due_cents, document_file, document_mime, notes, created_at) VALUES (?,?,?,?,?,?,?,?)',
      property.id, bill.bill_date, bill.due_date, bill.total_due_cents, doc ? doc.name : null, doc ? doc.mime : null, bill.notes, nowIso(),
    );
    insertLines(Number(r.lastInsertRowid), lines);
  });
  track('bill_added', { req, props: { lines: lines.length, estimated: lines.some((l) => l.reading_type === 'estimated') } });
  res.redirect(`/app/properties/${property.id}?ok=bill`);
});

function ownedBill(userId, id) {
  const bill = db.one('SELECT b.* FROM bills b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND p.user_id = ?', Number(id), userId);
  if (bill) bill.lines = db.all('SELECT * FROM bill_lines WHERE bill_id = ? ORDER BY id', bill.id);
  return bill;
}

router.get('/app/bills/:id/edit', (req, res) => {
  const bill = ownedBill(req.user.id, req.params.id);
  if (!bill) return notFound(req, res);
  const property = getProperty(req.user.id, bill.property_id);
  billForm(req, res, { property, bill, values: billFormValues(bill) });
});

router.post('/app/bills/:id', uploadOne('document'), verifyCsrf, (req, res) => {
  const existing = ownedBill(req.user.id, req.params.id);
  if (!existing) return notFound(req, res);
  const property = getProperty(req.user.id, existing.property_id);
  const { bill, lines, errors } = parseBill(req.body, property);
  if (req.uploadError) errors.push(req.uploadError);
  let doc = null;
  if (!errors.length && req.file) {
    doc = saveUpload(req.file, { allowPdf: true });
    if (!doc) errors.push('The bill copy must be a PDF or an image.');
  }
  if (errors.length) return billForm(req, res, { property, bill: existing, values: req.body, errors }, 422);
  db.tx(() => {
    db.run('UPDATE bills SET bill_date=?, due_date=?, total_due_cents=?, notes=? WHERE id=?', bill.bill_date, bill.due_date, bill.total_due_cents, bill.notes, existing.id);
    if (doc) db.run('UPDATE bills SET document_file=?, document_mime=? WHERE id=?', doc.name, doc.mime, existing.id);
    db.run('DELETE FROM bill_lines WHERE bill_id = ?', existing.id);
    insertLines(existing.id, lines);
  });
  if (doc) deleteUpload(existing.document_file);
  res.redirect(`/app/properties/${property.id}?ok=saved`);
});

router.post('/app/bills/:id/delete', (req, res) => {
  const bill = ownedBill(req.user.id, req.params.id);
  if (!bill) return notFound(req, res);
  db.run('DELETE FROM bills WHERE id = ?', bill.id);
  deleteUpload(bill.document_file);
  res.redirect(`/app/properties/${bill.property_id}?ok=deleted`);
});

// ---------------------------------------------------------------- Private files
router.get('/files/:name', requireAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const row =
    db.one('SELECT r.photo_mime AS mime FROM readings r JOIN properties p ON p.id = r.property_id WHERE r.photo_file = ? AND p.user_id = ?', name, req.user.id) ||
    db.one('SELECT b.document_mime AS mime FROM bills b JOIN properties p ON p.id = b.property_id WHERE b.document_file = ? AND p.user_id = ?', name, req.user.id);
  if (!row) return notFound(req, res);
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(config.uploadDir, name));
});

module.exports = router;
module.exports.statusBadge = statusBadge;
module.exports.flagList = flagList;
module.exports.STATUS = STATUS;
