'use strict';

// Charts rendered as HTML/CSS (text stays crisp on phones). Every mark has a
// keyboard-focusable hover tooltip via data-tip; a table view always sits
// alongside each chart on the page.

const { html, raw } = require('../lib/html');

function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

// Tick count that keeps every tick a round number for the max niceMax() picked.
function tickCount(max, integer) {
  if (integer && max <= 5) return max;
  const f = max / Math.pow(10, Math.floor(Math.log10(max)));
  return Math.abs(f - 2) < 1e-9 ? 4 : 5;
}

function axis(max, fmt, ticks = 4) {
  const values = Array.from({ length: ticks + 1 }, (_, i) => (max * i) / ticks);
  return {
    labels: html`<div class="y-axis" aria-hidden="true">${values.map((v) => html`<span style="bottom:${(v / max) * 100}%">${fmt(v)}</span>`)}</div>`,
    grid: values.slice(1).map((v) => html`<div class="gridline" style="bottom:${(v / max) * 100}%"></div>`),
  };
}

/**
 * Grouped or single-series column chart.
 * series: [{ name, cls: 's1'|'s2'|'solo', values: number[] , tips: string[] }]
 */
function columns({ title, sub = '', categories, series, fmt = (v) => String(Math.round(v)), height = 200, integer = false, endLabels = false }) {
  const rawMax = Math.max(0, ...series.flatMap((s) => s.values.filter((v) => v !== null)));
  const maxVal = integer ? Math.max(1, Math.ceil(niceMax(rawMax))) : niceMax(rawMax);
  const { labels, grid } = axis(maxVal, fmt, tickCount(maxVal, integer));
  const legend = series.length > 1
    ? html`<div class="legend">${series.map((s) => html`<span><i class="${s.cls === 's1' ? '' : ''}" style="background:var(--series-${s.cls === 's2' ? 2 : 1})"></i>${s.name}</span>`)}</div>`
    : '';
  return html`<figure class="chart">
    <div class="chart-title">${title}</div>
    ${sub ? html`<div class="chart-sub">${sub}</div>` : ''}
    ${legend}
    <div class="plot-wrap">
      ${labels}
      <div class="plot" style="height:${height}px">
        ${grid}
        <div class="cols">
          ${categories.map((c, i) => html`<div class="col-group">
            ${series.map((s) => {
              const v = s.values[i];
              if (v === null || v === undefined) return html`<div class="bar" style="height:0"></div>`;
              return html`<div class="bar ${s.cls}" tabindex="0" style="height:${Math.max(0, (v / maxVal) * 100)}%" data-tip="${s.tips ? s.tips[i] : `${s.name}: ${fmt(v)}`}"></div>`;
            })}
          </div>`)}
        </div>
      </div>
    </div>
    ${endLabels
      ? html`<div class="x-labels ends" aria-hidden="true"><span>${categories[0]}</span><span>${categories[categories.length - 1]}</span></div>`
      : html`<div class="x-labels" aria-hidden="true">${categories.map((c) => html`<span>${c}</span>`)}</div>`}
  </figure>`;
}

/**
 * Single-series line over time. points: [{ day (number), label, value, tip }]
 */
function line({ title, sub = '', points, fmt = (v) => String(v), height = 180 }) {
  if (points.length < 2) return '';
  const minDay = points[0].day;
  const span = Math.max(1, points[points.length - 1].day - minDay);
  const maxVal = niceMax(Math.max(...points.map((p) => p.value)));
  const { labels, grid } = axis(maxVal, fmt, tickCount(maxVal, false));
  const xy = points.map((p) => [((p.day - minDay) / span) * 100, 100 - (Math.max(0, p.value) / maxVal) * 100]);
  const poly = xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  return html`<figure class="chart">
    <div class="chart-title">${title}</div>
    ${sub ? html`<div class="chart-sub">${sub}</div>` : ''}
    <div class="plot-wrap">
      ${labels}
      <div class="plot" style="height:${height}px">
        ${grid}
        <svg class="line-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points="0,100 ${raw(poly)} 100,100"></polygon>
          <polyline points="${raw(poly)}"></polyline>
        </svg>
        ${points.map((p, i) => html`<div class="dot" tabindex="0" style="left:${xy[i][0]}%;bottom:${100 - xy[i][1]}%" data-tip="${p.tip}"></div>`)}
      </div>
    </div>
    <div class="x-labels" style="justify-content:space-between" aria-hidden="true"><span style="text-align:left;flex:none">${first.label}</span><span style="text-align:right;flex:none">${last.label}</span></div>
  </figure>`;
}

/** Horizontal bars for a funnel or ranking. rows: [{ label, value, display }] */
function hbars({ title, sub = '', rows }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<figure class="chart">
    <div class="chart-title">${title}</div>
    ${sub ? html`<div class="chart-sub">${sub}</div>` : ''}
    <div class="hbars">
      ${rows.map((r) => html`<div class="hbar">
        <span>${r.label}</span>
        <div class="track"><div class="fill" style="width:${(r.value / max) * 100}%" tabindex="0" data-tip="${r.label}: ${r.display ?? r.value}"></div></div>
        <span class="val">${r.display ?? r.value}</span>
      </div>`)}
    </div>
  </figure>`;
}

module.exports = { columns, line, hbars, niceMax };
