'use strict';

// Letter models are plain data so the same letter renders to the web page,
// a copy-paste email and the PDF evidence pack.

const { rand, prettyDate, num, units, today, daysBetween } = require('./format');
const { findMunicipality, municipalityName } = require('./municipalities');

const ACT = 'Local Government: Municipal Systems Act 32 of 2000';

const p = (text) => ({ type: 'p', text });
const h = (text) => ({ type: 'h', text });
const list = (items, ordered = true) => ({ type: 'list', items, ordered });
const table = (head, rows) => ({ type: 'table', head, rows });

function header({ user, property, dispute }) {
  const municipality = municipalityName(property);
  const re = [
    ['Account number', property.account_number || '(not provided)'],
    ['Account holder', property.account_holder || user.name],
    ['Property', property.address || property.nickname],
  ];
  if (property.stand_number) re.push(['Erf / stand', property.stand_number]);
  if (dispute && dispute.reference_number) re.push(['Dispute reference', dispute.reference_number]);
  return {
    date: today(),
    from: {
      name: user.name,
      address: user.postal_address || property.address,
      email: user.email,
      phone: user.phone,
    },
    to: {
      title: 'The Municipal Manager / Revenue and Customer Services',
      organisation: municipality,
      email: property.dispute_email || '',
    },
    re,
    signoff: 'Yours faithfully',
    signName: user.name,
    municipality,
  };
}

// Rows describing each disputed item, shared by several letters.
function disputedRows(amounts) {
  const rows = [];
  for (const b of amounts.bills) {
    for (const c of b.consumption) {
      const r = c.result;
      if (!r.overchargeCents || r.overchargeCents <= 0 || !r.confidence) continue;
      const u = units(r.utility);
      rows.push([
        prettyDate(b.bill.bill_date),
        `${r.utility === 'water' ? 'Water' : 'Electricity'} ${c.line.reading_type === 'estimated' ? '(estimated)' : ''}`.trim(),
        `${num(r.billedUnits)} ${u}`,
        `${num(r.actualUnits)} ${u}`,
        `${num(r.diffUnits)} ${u}`,
        rand(r.overchargeCents),
      ]);
    }
    for (const l of b.bill.lines || []) {
      if (!l.disputed || l.kind === 'consumption') continue;
      rows.push([prettyDate(b.bill.bill_date), l.label || (l.kind === 'interest' ? 'Interest' : 'Charge'), '', '', '', rand(l.amount_cents)]);
    }
  }
  return rows;
}

function groundsFor(amounts) {
  const grounds = [];
  for (const b of amounts.bills) {
    for (const c of b.consumption) {
      for (const f of c.result.flags) {
        if (f.letter && (f.severity === 'high' || f.code === 'estimated')) grounds.push(`Account dated ${prettyDate(b.bill.bill_date)}: ${f.letter}`);
      }
    }
    for (const l of b.bill.lines || []) {
      if (l.disputed && l.kind !== 'consumption') {
        const reason = (l.dispute_reason || '').trim().replace(/\.$/, '');
        grounds.push(`Account dated ${prettyDate(b.bill.bill_date)}: the item "${l.label || 'Charge'}" of ${rand(l.amount_cents)} is disputed${reason ? ` (${reason})` : ''}.`);
      }
    }
    for (const f of b.flags) if (f.letter) grounds.push(`Account dated ${prettyDate(b.bill.bill_date)}: ${f.letter}`);
  }
  return [...new Set(grounds)];
}

function annexures(evidence) {
  const items = [];
  items.push(`Annexure A: Meter readings log (${evidence.readingCount} readings${evidence.photoCount ? `, ${evidence.photoCount} dated photographs` : ''}${evidence.exifCount ? `, ${evidence.exifCount} with camera timestamps` : ''}).`);
  items.push('Annexure B: Calculation of the disputed amounts per account.');
  if (evidence.billDocCount) items.push(`Annexure C: Copies of the disputed accounts (${evidence.billDocCount}).`);
  return items;
}

function buildDisputeLetter({ user, property, dispute, amounts, evidence, undisputedMonthlyCents }) {
  const base = header({ user, property, dispute });
  const rows = disputedRows(amounts);
  const grounds = groundsFor(amounts);
  if (dispute.grounds_extra) grounds.push(dispute.grounds_extra);
  const total = dispute.disputed_amount_cents || amounts.totalCents;
  const undisputed = dispute.undisputed_monthly_cents || undisputedMonthlyCents;

  const blocks = [
    p(`I hereby lodge a formal dispute in terms of section 102(2) of the ${ACT}, read with ${base.municipality}'s Credit Control and Debt Collection By-laws and Policy, in respect of the specific amounts set out below.`),
    h('1. Amounts in dispute'),
    table(['Account date', 'Service', 'Billed', 'Actual (my meter)', 'Difference', 'Amount'], rows.length ? rows : [['', 'See grounds below', '', '', '', rand(total)]]),
    p(`Total amount in dispute: ${rand(total)}.`),
    h('2. Grounds of dispute'),
    list(grounds.length ? grounds : ['The charges listed above do not reflect the consumption recorded on my meter.']),
    p('My own meter readings are recorded with dated photographs and are attached as evidence. The calculation of each disputed amount is also attached.'),
    h('3. Request'),
    p(`In terms of section 102(2) of the ${ACT}, credit control and debt collection measures may not be implemented in respect of an amount that is the subject of a dispute. I therefore request that you:`),
    list([
      'register this dispute and provide me with a dispute reference number in writing;',
      'suspend all credit control and debt collection action, including disconnection or restriction of services and the levying of interest, in respect of the disputed amount while the dispute is being resolved;',
      'arrange an actual reading of the meter(s) and, if necessary, test the accuracy of the meter;',
      'correct the account by reversing the over-billed amounts, together with any interest and penalties levied on them; and',
      'provide me with a corrected statement of account.',
    ]),
    h('4. Undisputed amount'),
    p(undisputed
      ? `In good faith, I will continue to pay the undisputed portion of the account, being ${rand(undisputed)} per month (calculated from my actual consumption), until this dispute is resolved.`
      : 'In good faith, I will continue to pay the undisputed portion of the account until this dispute is resolved.'),
    h('5. Supporting documents'),
    list(annexures(evidence), false),
    p('Please acknowledge receipt of this dispute and provide the reference number within 7 days. I can be reached at the contact details above.'),
  ];

  return {
    ...base,
    kind: 'dispute',
    subject: `Formal dispute of account ${property.account_number || ''} in terms of section 102 of the Municipal Systems Act`.replace(/\s+/g, ' '),
    blocks,
  };
}

function buildFollowUpLetter({ user, property, dispute }) {
  const base = header({ user, property, dispute });
  const lodged = dispute.lodged_at || dispute.created_at.slice(0, 10);
  const days = daysBetween(lodged, today());
  const m = findMunicipality(property.municipality);
  const blocks = [
    p(`On ${prettyDate(lodged, { long: true })} I lodged a formal dispute in terms of section 102(2) of the ${ACT} regarding ${rand(dispute.disputed_amount_cents)} on the above account${dispute.reference_number ? ` (reference ${dispute.reference_number})` : ''}. ${days} days have passed and the dispute has not been resolved.`),
    p('I therefore escalate this matter and request that you:'),
    list([
      dispute.reference_number ? 'confirm the current status of the dispute and the name of the official responsible for it;' : 'register the dispute and provide a dispute reference number in writing;',
      'confirm in writing that no credit control or debt collection action, including disconnection or restriction, will be taken in respect of the disputed amount while the dispute is pending;',
      'resolve the dispute and provide a corrected statement within 14 days of this letter.',
    ]),
    p(`I continue to pay the undisputed portion of the account${dispute.undisputed_monthly_cents ? ` (${rand(dispute.undisputed_monthly_cents)} per month)` : ''}. My original dispute and supporting evidence are attached again for convenience.`),
    p(m && m.ombud
      ? `Should the matter remain unresolved, I intend to refer it to the ${m.ombud} and to my ward councillor.`
      : 'Should the matter remain unresolved, I intend to escalate it to my ward councillor and the Speaker of Council, and to consider further remedies available to me.'),
  ];
  return {
    ...base,
    kind: 'followup',
    subject: `Escalation: unresolved billing dispute on account ${property.account_number || ''}`.replace(/\s+/g, ' '),
    blocks,
  };
}

function buildAppealLetter({ user, property, dispute, decisionDate, decisionSummary }) {
  const base = header({ user, property, dispute });
  base.to.title = 'The Municipal Manager';
  const blocks = [
    p(`I hereby give notice of an appeal in terms of section 62 of the ${ACT} against the decision communicated to me on ${prettyDate(decisionDate || today(), { long: true })} regarding my billing dispute${dispute.reference_number ? ` (reference ${dispute.reference_number})` : ''}.`),
    h('1. The decision appealed against'),
    p(decisionSummary || 'My dispute regarding the amounts listed in my original dispute letter was declined.'),
    h('2. Reasons for the appeal'),
    list([
      `The disputed amount of ${rand(dispute.disputed_amount_cents)} is not supported by the consumption recorded on my meter, as shown by the dated meter photographs and readings log attached.`,
      'The decision does not address the evidence I submitted or explain how the billed consumption was determined.',
      'Where charges were based on estimated readings, the estimates have been shown to exceed actual consumption and must be corrected to actual readings.',
    ]),
    h('3. Relief sought'),
    list([
      'that the decision be set aside and the disputed amounts be reversed, together with any interest and penalties levied on them;',
      'that no credit control or debt collection action be taken in respect of the disputed amount until this appeal has been decided; and',
      'that I be provided with written reasons for the outcome of this appeal.',
    ]),
    p('This appeal is lodged within 21 days of the date on which I was notified of the decision. My original dispute and supporting evidence are attached.'),
  ];
  return {
    ...base,
    kind: 'appeal',
    subject: `Appeal in terms of section 62 of the Municipal Systems Act: account ${property.account_number || ''}`.replace(/\s+/g, ' '),
    blocks,
  };
}

function buildDisconnectionLetter({ user, property, dispute, noticeDate }) {
  const base = header({ user, property, dispute });
  const lodged = dispute.lodged_at || dispute.created_at.slice(0, 10);
  const blocks = [
    p(`I refer to the notice of disconnection / restriction of services dated ${prettyDate(noticeDate || today(), { long: true })} relating to the above account.`),
    p(`The amount concerned is the subject of a formal dispute lodged on ${prettyDate(lodged, { long: true })}${dispute.reference_number ? ` under reference ${dispute.reference_number}` : ''}, in respect of ${rand(dispute.disputed_amount_cents)}. I have continued to pay the undisputed portion of the account.`),
    p(`In terms of section 102(2) of the ${ACT}, the Municipality may not implement credit control and debt collection measures in respect of a specific amount that is in dispute. Disconnecting or restricting services on the basis of the disputed amount would therefore be unlawful.`),
    p('I request immediate written confirmation, within 48 hours, that:'),
    list([
      'the notice is withdrawn insofar as it relates to the disputed amount; and',
      'no disconnection or restriction of services will take place while the dispute is pending.',
    ]),
    p('Should services be disconnected or restricted, I reserve my rights, including the right to approach a court for urgent relief and to claim the costs of doing so. A copy of my dispute and the supporting evidence is attached.'),
  ];
  return {
    ...base,
    kind: 'disconnection',
    subject: `URGENT: disputed amount on account ${property.account_number || ''} — disconnection not permitted (s102(2) Municipal Systems Act)`.replace(/\s+/g, ' '),
    blocks,
  };
}

const LETTER_KINDS = {
  dispute: { label: 'Section 102 dispute letter', build: buildDisputeLetter },
  followup: { label: 'Follow-up / escalation letter', build: buildFollowUpLetter },
  appeal: { label: 'Section 62 appeal (dispute rejected)', build: buildAppealLetter },
  disconnection: { label: 'Response to a disconnection notice', build: buildDisconnectionLetter },
};

function toText(letter) {
  const out = [];
  out.push(letter.from.name);
  if (letter.from.address) out.push(letter.from.address);
  out.push([letter.from.email, letter.from.phone].filter(Boolean).join(' | '));
  out.push('');
  out.push(prettyDate(letter.date, { long: true }));
  out.push('');
  out.push(letter.to.title);
  out.push(letter.to.organisation);
  if (letter.to.email) out.push(`By email: ${letter.to.email}`);
  out.push('');
  out.push(`RE: ${letter.subject.toUpperCase()}`);
  for (const [k, v] of letter.re) out.push(`${k}: ${v}`);
  out.push('');
  for (const b of letter.blocks) {
    if (b.type === 'p') out.push(b.text, '');
    else if (b.type === 'h') out.push(b.text.toUpperCase(), '');
    else if (b.type === 'list') {
      b.items.forEach((item, i) => out.push(`${b.ordered ? `(${String.fromCharCode(97 + i)})` : '-'} ${item}`));
      out.push('');
    } else if (b.type === 'table') {
      for (const row of b.rows) out.push(`- ${row.filter(Boolean).join(' | ')}`);
      out.push('');
    }
  }
  out.push(letter.signoff);
  out.push('');
  out.push(letter.signName);
  return out.join('\n');
}

module.exports = { LETTER_KINDS, buildDisputeLetter, buildFollowUpLetter, buildAppealLetter, buildDisconnectionLetter, toText };
