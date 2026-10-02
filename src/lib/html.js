'use strict';

// Auto-escaping tagged template. Interpolated values are escaped unless they
// are SafeStrings (produced by html`` itself or raw()).
class SafeString {
  constructor(s) {
    this.s = String(s);
  }
  toString() {
    return this.s;
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeString) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escape(v);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeString(out);
}

const raw = (s) => new SafeString(s);

module.exports = { html, raw, escape, SafeString };
