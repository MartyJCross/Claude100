'use strict';

process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'mp-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { meterAt, buildSeries, analyseProperty, disputeAmounts, quickCheck } = require('../src/lib/analysis');
const { toCents, toNumber, addMonths } = require('../src/lib/format');

const readings = [
  { id: 1, utility: 'water', reading_date: '2026-05-01', value: 1000 },
  { id: 2, utility: 'water', reading_date: '2026-05-31', value: 1015 },
  { id: 3, utility: 'water', reading_date: '2026-06-30', value: 1030 },
  { id: 4, utility: 'water', reading_date: '2026-07-30', value: 1045 },
];

const refuse = (amount) => ({ kind: 'charge', label: 'Refuse', amount_cents: amount, disputed: 0 });
const water = (o) => ({ kind: 'consumption', utility: 'water', units_billed: null, disputed: 0, ...o });

const bills = [
  {
    id: 10,
    bill_date: '2026-06-05',
    lines: [water({ reading_type: 'actual', prev_reading: 1000, curr_reading: 1015, prev_date: '2026-05-01', curr_date: '2026-05-31', amount_cents: 45000 }), refuse(20000)],
  },
  {
    id: 11,
    bill_date: '2026-07-05',
    lines: [water({ reading_type: 'estimated', prev_reading: 1015, curr_reading: 1060, prev_date: '2026-05-31', curr_date: '2026-06-30', amount_cents: 150000 }), refuse(20000)],
  },
  {
    id: 12,
    bill_date: '2026-08-05',
    lines: [water({ reading_type: 'estimated', prev_reading: 1060, curr_reading: 1100, prev_date: '2026-06-30', curr_date: '2026-07-30', amount_cents: 140000 }), refuse(20000)],
  },
];

test('meterAt interpolates, matches exact dates and refuses long extrapolation', () => {
  const series = buildSeries(readings);
  assert.equal(meterAt(series, '2026-05-16').value, 1007.5);
  assert.equal(meterAt(series, '2026-05-31').method, 'exact');
  assert.equal(meterAt(series, '2026-08-09').method, 'extrapolated');
  assert.equal(meterAt(series, '2026-12-01'), null);
  assert.equal(meterAt([], '2026-05-16'), null);
});

test('an accurate actual-reading bill is not flagged', () => {
  const a = analyseProperty({ bills, readings });
  const first = a.bills[0];
  assert.equal(first.flagged, false);
  assert.equal(first.consumption[0].result.actualUnits, 15);
  assert.equal(first.consumption[0].result.overchargeCents, 0);
});

test('estimated readings ahead of the real meter are flagged and priced', () => {
  const a = analyseProperty({ bills, readings });
  const b = a.bills[1].consumption[0].result;
  assert.equal(b.diffUnits, 30);
  assert.equal(b.overchargeCents, 100000);
  const codes = b.flags.map((f) => f.code);
  assert.ok(codes.includes('estimated'));
  assert.ok(codes.includes('overbilled'));
  assert.ok(codes.includes('reading_ahead'));
  assert.equal(a.bills[2].consumption[0].result.overchargeCents, 87500);
  assert.equal(a.totals.disputableCents, 187500);
  assert.equal(a.totals.flaggedBillCount, 2);
  assert.equal(a.currentAhead.water.units, 55);
});

test('undisputed monthly payment removes over-billing from recent bills', () => {
  const a = analyseProperty({ bills, readings });
  // (65000 + 70000 + 72500) / 3
  assert.equal(a.undisputedMonthlyCents, 69167);
});

test('dispute amounts net out later catch-up credits', () => {
  const withCredit = [
    ...bills,
    {
      id: 13,
      bill_date: '2026-09-05',
      // Actual reading finally taken: the bill corrects itself downwards.
      lines: [water({ reading_type: 'actual', prev_reading: 1100, curr_reading: 1060, prev_date: '2026-07-30', curr_date: '2026-08-29', units_billed: -40, amount_cents: -140000 })],
    },
  ];
  const r2 = [...readings, { id: 5, utility: 'water', reading_date: '2026-08-29', value: 1060 }];
  const a = analyseProperty({ bills: withCredit, readings: r2 });
  const amounts = disputeAmounts(a, [11, 12, 13]);
  // 100000 + 87500 + (-55 kL * 3500c) = 0 -> never negative
  assert.equal(amounts.consumptionCents, 0);
});

test('manually disputed charges are included in the dispute total', () => {
  const b2 = JSON.parse(JSON.stringify(bills));
  b2[0].lines[1].disputed = 1;
  b2[0].lines[1].dispute_reason = 'Charged twice';
  const a = analyseProperty({ bills: b2, readings });
  assert.equal(disputeAmounts(a, [10]).totalCents, 20000);
  assert.equal(a.bills[0].flagged, true);
});

test('a sudden jump in the user\'s own readings is reported as a possible leak', () => {
  const r2 = [...readings, { id: 5, utility: 'water', reading_date: '2026-08-09', value: 1060 }];
  const a = analyseProperty({ bills: [], readings: r2 });
  assert.ok(a.utilities.water.leak);
  assert.ok(a.summaryFlags.some((f) => f.code === 'possible_leak'));
});

test('three estimated bills in a row raise a summary flag', () => {
  const three = [11, 12, 13].map((id, i) => ({
    id,
    bill_date: `2026-0${6 + i}-05`,
    lines: [water({ reading_type: 'estimated', prev_reading: null, curr_reading: null, units_billed: 20, amount_cents: 60000 })],
  }));
  const a = analyseProperty({ bills: three, readings: [] });
  assert.ok(a.summaryFlags.some((f) => f.code === 'consecutive_estimates'));
});

test('quickCheck spots a billed reading ahead of the meter', () => {
  const r = quickCheck({ billedReading: 1100, actualReading: 1045, ratePerUnitCents: 3500 });
  assert.equal(r.overbilled, true);
  assert.equal(r.estimatedCents, 192500);
});

test('money and number parsing handles SA formats', () => {
  assert.equal(toCents('R1 234,50'), 123450);
  assert.equal(toCents('1,234.50'), 123450);
  assert.equal(toCents('1.234,50'), 123450);
  assert.equal(toCents('99'), 9900);
  assert.equal(toCents(''), null);
  assert.equal(toNumber('1234,5'), 1234.5);
  assert.equal(toNumber('abc'), null);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
});
