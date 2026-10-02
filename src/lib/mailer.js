'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const config = require('../config');
const { escape } = require('./html');

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

// Plain, readable HTML version of a text email with a call-to-action button.
function wrapHtml(text, cta) {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escape(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = cta
    ? `<p style="margin:22px 0"><a href="${escape(cta.url)}" style="background:#0f6b5c;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escape(cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f7f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#15201b">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<div style="font-weight:700;font-size:18px;margin-bottom:18px;color:#0f6b5c">${escape(config.brand)}</div>
<div style="background:#fff;border:1px solid #dde2dc;border-radius:12px;padding:22px;font-size:15px;line-height:1.55">${paras}${button}</div>
<p style="font-size:12px;color:#6d7872;margin-top:18px">You are receiving this because you have a ${escape(config.brand)} account. Manage email preferences in your account settings: ${escape(config.baseUrl)}/account</p>
</div></body></html>`;
}

async function sendMail({ to, subject, text, cta }) {
  const body = cta ? `${text}\n\n${cta.label}: ${cta.url}` : text;
  const message = { from: config.smtp.from, to, subject, text: body, html: wrapHtml(text, cta) };
  if (!transport) {
    // Development: keep a copy on disk so flows can be tested without SMTP.
    const file = path.join(config.outboxDir, `${Date.now()}-${subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.txt`);
    fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${body}\n`);
    if (!config.isProd) console.log(`[mail] ${to}: ${subject} (saved to ${path.relative(process.cwd(), file)})`);
    return { stored: file };
  }
  try {
    return await transport.sendMail(message);
  } catch (err) {
    console.error('mail: send failed', to, subject, err.message);
    return null;
  }
}

module.exports = { sendMail };
