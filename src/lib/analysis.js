'use strict';

// The bill-vs-meter engine. Pure functions: given a property's own dated meter
// readings and the bills the municipality issued, work out what was actually
// used in each billing period, what was billed, and what that difference costs.

const { daysBetween, num, units, prettyDate } = require('./format');

// Differences smaller than this are treated as noise (meter-reading rounding).
const TOLERANCE = { water: 1, electricity: 25 };
const RELATIVE_TOLERANCE = 0.1;
// Leak heuristic: latest daily usage this many times the usual, and above a floor.
const LEAK_FACTOR = 1.8;
const LEAK_FLOOR = { water: 0.15, electricity: 6 };

const RANK = { high: 3, medium: 2, low: 1 };

function dayNum(date) {
  return Math.round(new Date(`${date}T00:00:00Z`).getTime() / 86400000);
}

// Sorted, de-duplicated (one value per date; the later entry wins) series.
function buildSeries(readings) {
  const byDate = new Map();
  for (const r of readings) {
    if (r.value === null || r.value === undefined || !r.reading_date) continue;
    byDate.set(r.reading_date, { date: r.reading_date, day: dayNum(r.reading_date), value: Number(r.value), id: r.id, photo: !!r.photo_file });
  }
  return [...byDate.values()].sort((a, b) => a.day - b.day);
}

// Estimate what the meter showed on `date` from the user's own readings.
function meterAt(series, date) {
  if (!series.length || !date) return null;
  const d = dayNum(date);
  const exact = series.find((p) => p.day === d);
  if (exact) return { value: exact.value, method: 'exact', confidence: 'high' };

  const after = series.findIndex((p) => p.day > d);
  if (after > 0) {
    const a = series[after - 1];
    const b = series[after];
    const span = b.day - a.day;
    const value = a.value + ((b.value - a.value) * (d - a.day)) / span;
    const confidence = span <= 45 ? 'high' : span <= 100 ? 'medium' : 'low';
    return { value, method: 'interpolated', confidence, span };
  }
  if (series.length < 2) return null;

  // Outside the range of readings: extrapolate a short distance using the nearest interval.
  const [a, b] = after === 0 ? [series[0], series[1]] : [series[series.length - 2], series[series.length - 1]];
  const rate = (b.value - a.value) / (b.day - a.day);
  const anchor = after === 0 ? a : b;
  const distance = Math.abs(d - anchor.day);
  if (distance > 31) return null;
  return {
    value: anchor.value + rate * (d - anchor.day),
    method: 'extrapolated',
    confidence: distance <= 14 ? 'medium' : 'low',
  };
}

function minConfidence(...levels) {
  return levels.reduce((acc, l) => (RANK[l] < RANK[acc] ? l : acc), 'high');
}

// Average daily usage between consecutive readings.
function dailyRates(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    const gap = series[i].day - series[i - 1].day;
    if (gap < 1) continue;
    out.push({ from: series[i - 1].date, to: series[i].date, days: gap, perDay: (series[i].value - series[i - 1].value) / gap });
  }
  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function detectLeak(utility, rates) {
  if (rates.length < 3) return null;
  const latest = rates[rates.length - 1];
  const baseline = median(rates.slice(0, -1).map((r) => r.perDay).filter((v) => v >= 0));
  if (baseline === null || latest.perDay < 0) return null;
  if (latest.perDay > baseline * LEAK_FACTOR && latest.perDay - baseline > LEAK_FLOOR[utility]) {
    return { latestPerDay: latest.perDay, baselinePerDay: baseline, from: latest.from, to: latest.to };
  }
  return null;
}

// `message` speaks to the user in the app; `letter` is the same finding in the
// first person, ready to quote in a dispute letter.
function flag(code, severity, message, letter = null) {
  return { code, severity, message, letter };
}

// Analyse one consumption line (water or electricity) of a bill.
function analyseConsumption(line, series) {
  const utility = line.utility;
  const u = units(utility);
  const tol = TOLERANCE[utility] ?? 1;
  const flags = [];

  const hasReadings = line.prev_reading !== null && line.prev_reading !== undefined && line.curr_reading !== null && line.curr_reading !== undefined;
  const fromReadings = hasReadings ? line.curr_reading - line.prev_reading : null;
  const billedUnits = line.units_billed !== null && line.units_billed !== undefined ? Number(line.units_billed) : fromReadings;

  if (line.reading_type === 'estimated') {
    flags.push(flag('estimated', 'medium', 'This charge is based on an estimated reading, not an actual reading of your meter.', `The ${utility} charge is based on an estimated reading, not an actual reading of my meter.`));
  }
  if (billedUnits !== null && billedUnits < 0) {
    flags.push(flag('negative', 'high', `The readings on the bill go backwards (${num(fromReadings)} ${u}). The account needs to be corrected.`, `The ${utility} readings on the account go backwards (${num(fromReadings)} ${u}), which shows that earlier readings were overstated.`));
  }
  if (hasReadings && line.units_billed !== null && line.units_billed !== undefined && Math.abs(line.units_billed - fromReadings) > tol) {
    flags.push(flag('units_mismatch', 'high', `The bill charges ${num(line.units_billed)} ${u}, but its own readings only account for ${num(fromReadings)} ${u}.`, `The account charges ${num(line.units_billed)} ${u} of ${utility}, but the readings on the same account only account for ${num(fromReadings)} ${u}.`));
  }

  // Average rate actually charged; also works for negative catch-up corrections.
  const rawRate = billedUnits ? line.amount_cents / billedUnits : null;
  const ratePerUnit = rawRate !== null && rawRate > 0 ? rawRate : null;
  let actualUnits = null;
  let confidence = null;
  let ahead = null;
  let atStart = null;
  let atEnd = null;

  if (line.prev_date && line.curr_date) {
    atStart = meterAt(series, line.prev_date);
    atEnd = meterAt(series, line.curr_date);
    if (atStart && atEnd) {
      actualUnits = atEnd.value - atStart.value;
      confidence = minConfidence(atStart.confidence, atEnd.confidence);
    }
  }
  if (line.curr_reading !== null && line.curr_reading !== undefined && atEnd) {
    ahead = line.curr_reading - atEnd.value;
  }

  let diffUnits = null;
  let overchargeCents = null;
  if (actualUnits !== null && billedUnits !== null) {
    diffUnits = billedUnits - actualUnits;
    if (ratePerUnit !== null) overchargeCents = Math.round(diffUnits * ratePerUnit);
    const material = Math.abs(diffUnits) > tol && Math.abs(diffUnits) > RELATIVE_TOLERANCE * Math.max(actualUnits, 0);
    if (material && diffUnits > 0) {
      const period = `${prettyDate(line.prev_date)} to ${prettyDate(line.curr_date)}`;
      flags.push(flag('overbilled', 'high', `Billed ${num(billedUnits)} ${u} for this period, but your meter shows you used about ${num(actualUnits)} ${u}: ${num(diffUnits)} ${u} too much.`, `I was billed for ${num(billedUnits)} ${u} of ${utility} for ${period}, but my meter readings show actual consumption of about ${num(actualUnits)} ${u}, an over-charge of ${num(diffUnits)} ${u}.`));
    } else if (material && diffUnits < 0) {
      flags.push(flag('underbilled', 'low', `Billed ${num(billedUnits)} ${u}, but you used about ${num(actualUnits)} ${u}. Expect a catch-up charge when the meter is next read.`));
    }
  } else if (billedUnits !== null) {
    flags.push(flag('no_evidence', 'low', `Add a meter reading near ${line.prev_date || 'the start'} and ${line.curr_date || 'the end'} of this period to check this charge.`));
  }

  if (ahead !== null && ahead > tol) {
    flags.push(flag('reading_ahead', 'high', `The bill's closing reading (${num(line.curr_reading)}) is ${num(ahead)} ${u} ahead of what your meter actually showed (${num(atEnd.value)}) on ${prettyDate(line.curr_date)}. You are being charged for usage that has not happened.`, `The closing ${utility} reading on the account (${num(line.curr_reading)} on ${prettyDate(line.curr_date)}) is ${num(ahead)} ${u} ahead of the actual reading on my meter on that date (${num(atEnd.value)}). I am being charged for consumption that has not taken place.`));
  }

  return {
    utility,
    billedUnits,
    actualUnits,
    diffUnits,
    ratePerUnit,
    overchargeCents,
    confidence,
    ahead,
    atStart,
    atEnd,
    flags,
  };
}

function isFlagged(result) {
  return result.flags.some((f) => f.severity === 'high');
}

// Analyse every bill for a property. `bills` items carry a `lines` array.
function analyseProperty({ bills = [], readings = [] }) {
  const seriesByUtility = {
    water: buildSeries(readings.filter((r) => r.utility === 'water')),
    electricity: buildSeries(readings.filter((r) => r.utility === 'electricity')),
  };

  const utilities = {};
  for (const [utility, series] of Object.entries(seriesByUtility)) {
    const rates = dailyRates(series);
    const usable = rates.filter((r) => r.perDay >= 0);
    const totalDays = usable.reduce((s, r) => s + r.days, 0);
    utilities[utility] = {
      series,
      rates,
      avgPerDay: totalDays ? usable.reduce((s, r) => s + r.perDay * r.days, 0) / totalDays : null,
      leak: detectLeak(utility, rates),
      latest: series[series.length - 1] || null,
    };
  }

  const sorted = [...bills].sort((a, b) => (a.bill_date < b.bill_date ? -1 : a.bill_date > b.bill_date ? 1 : a.id - b.id));
  const consecutiveEstimates = { water: 0, electricity: 0 };

  const billResults = sorted.map((bill) => {
    const lines = bill.lines || [];
    const consumption = lines
      .filter((l) => l.kind === 'consumption')
      .map((line) => ({ line, result: analyseConsumption(line, seriesByUtility[line.utility] || []) }));

    for (const { line } of consumption) {
      if (line.reading_type === 'estimated') consecutiveEstimates[line.utility] += 1;
      else if (line.reading_type === 'actual') consecutiveEstimates[line.utility] = 0;
    }

    const others = lines.filter((l) => l.kind !== 'consumption');
    const currentChargesCents = lines.reduce((s, l) => s + (l.amount_cents || 0), 0);
    // Consumption over-billing only counts where we had evidence to measure it.
    const consumptionOverCents = consumption.reduce((s, c) => s + (c.result.overchargeCents && c.result.confidence ? c.result.overchargeCents : 0), 0);
    const manualDisputedCents = lines.filter((l) => l.disputed && l.kind !== 'consumption').reduce((s, l) => s + (l.amount_cents || 0), 0);
    const interestCents = others.filter((l) => l.kind === 'interest').reduce((s, l) => s + (l.amount_cents || 0), 0);
    const interestUndisputedCents = others.filter((l) => l.kind === 'interest' && !l.disputed).reduce((s, l) => s + (l.amount_cents || 0), 0);
    const flagged = consumption.some((c) => isFlagged(c.result)) || manualDisputedCents > 0;

    const billFlags = [];
    if (interestUndisputedCents > 0 && consumption.some((c) => isFlagged(c.result))) {
      billFlags.push(flag('interest', 'medium', 'Interest was charged on an account that includes over-billing. Mark the interest line as disputed to ask for it to be reversed.', 'Interest was levied on an account that includes the over-billing set out above. Interest on the disputed amount must be reversed.'));
    }

    return {
      bill,
      consumption,
      others,
      currentChargesCents,
      consumptionOverCents,
      manualDisputedCents,
      interestCents,
      interestUndisputedCents,
      flagged,
      flags: billFlags,
    };
  });

  const flaggedBills = billResults.filter((b) => b.flagged);
  const netConsumptionOver = billResults.reduce((s, b) => s + b.consumptionOverCents, 0);
  const manualTotal = billResults.reduce((s, b) => s + b.manualDisputedCents, 0);

  // Where the latest bill's closing reading sits relative to the real meter.
  const currentAhead = {};
  for (const utility of ['water', 'electricity']) {
    for (let i = billResults.length - 1; i >= 0; i--) {
      const c = billResults[i].consumption.find((x) => x.line.utility === utility && x.result.ahead !== null);
      if (c) {
        currentAhead[utility] = {
          units: c.result.ahead,
          cents: c.result.ratePerUnit !== null ? Math.round(c.result.ahead * c.result.ratePerUnit) : null,
          billDate: billResults[i].bill.bill_date,
        };
        break;
      }
    }
  }

  const summaryFlags = [];
  for (const utility of ['water', 'electricity']) {
    if (consecutiveEstimates[utility] >= 3) {
      summaryFlags.push(flag('consecutive_estimates', 'high', `Your last ${consecutiveEstimates[utility]} ${utility} charges were all estimated. You are entitled to ask for an actual meter reading.`));
    }
    const leak = utilities[utility].leak;
    if (leak) {
      summaryFlags.push(flag('possible_leak', 'medium', `Your own readings show ${utility} use jumped from about ${num(leak.baselinePerDay)} to ${num(leak.latestPerDay)} ${units(utility)} per day (${leak.from} to ${leak.to}). If nothing changed at home, check for a leak before disputing.`));
    }
  }

  return {
    utilities,
    bills: billResults,
    totals: {
      netConsumptionOverCents: Math.max(0, netConsumptionOver),
      manualDisputedCents: manualTotal,
      disputableCents: Math.max(0, netConsumptionOver) + manualTotal,
      flaggedBillCount: flaggedBills.length,
      billCount: billResults.length,
    },
    currentAhead,
    undisputedMonthlyCents: undisputedMonthly(billResults),
    summaryFlags,
  };
}

// What to keep paying while a dispute runs: the average of the last three
// bills' current charges with the over-billing and disputed items removed.
function undisputedMonthly(billResults) {
  const recent = billResults.slice(-3);
  if (!recent.length) return null;
  // Interest on a flagged bill is excluded too; interest the user explicitly
  // disputed is already part of manualDisputedCents.
  const fair = recent.map((b) => Math.max(0, b.currentChargesCents - Math.max(0, b.consumptionOverCents) - b.manualDisputedCents - (b.flagged ? b.interestUndisputedCents : 0)));
  return Math.round(fair.reduce((s, v) => s + v, 0) / fair.length);
}

// Amounts for a dispute covering a subset of bills.
function disputeAmounts(analysis, billIds) {
  const ids = new Set(billIds.map(Number));
  const chosen = analysis.bills.filter((b) => ids.has(Number(b.bill.id)));
  const consumption = chosen.reduce((s, b) => s + b.consumptionOverCents, 0);
  const manual = chosen.reduce((s, b) => s + b.manualDisputedCents, 0);
  return {
    bills: chosen,
    consumptionCents: Math.max(0, consumption),
    manualCents: manual,
    totalCents: Math.max(0, consumption) + manual,
  };
}

// Quick standalone check used by the free public tool.
function quickCheck({ utility = 'water', billedReading, actualReading, actualDate, billDate, ratePerUnitCents }) {
  const ahead = billedReading - actualReading;
  const tol = TOLERANCE[utility] ?? 1;
  const gap = actualDate && billDate ? Math.abs(daysBetween(actualDate, billDate)) : 0;
  return {
    ahead,
    overbilled: ahead > tol,
    estimatedCents: ratePerUnitCents && ahead > 0 ? Math.round(ahead * ratePerUnitCents) : null,
    dateGapDays: gap,
  };
}

module.exports = {
  TOLERANCE,
  buildSeries,
  meterAt,
  dailyRates,
  detectLeak,
  analyseConsumption,
  analyseProperty,
  disputeAmounts,
  undisputedMonthly,
  quickCheck,
};
