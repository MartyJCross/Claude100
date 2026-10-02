'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { rand, prettyDate, num, units } = require('./format');

const INK = '#1b2430';
const MUTED = '#5b6675';
const ACCENT = '#0f6b5c';
const RULE = '#d5dbe1';

function newDoc(title) {
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title, Author: config.brand } });
  doc.fillColor(INK);
  return doc;
}

const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

function ensureSpace(doc, height) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

// Simple wrapped table with header repeat on page breaks.
function drawTable(doc, head, rows, widths) {
  const x0 = doc.page.margins.left;
  const total = contentWidth(doc);
  const ws = widths || head.map(() => total / head.length);
  const pad = 4;

  const drawRow = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const heights = cells.map((c, i) => doc.heightOfString(String(c ?? ''), { width: ws[i] - pad * 2 }));
    const hgt = Math.max(...heights, 10) + pad * 2;
    if (doc.y + hgt > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      if (!bold) drawRow(head, true);
    }
    const y = doc.y;
    if (bold) doc.rect(x0, y, total, hgt).fill('#eef2f5').fillColor(INK);
    let x = x0;
    cells.forEach((c, i) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK).text(String(c ?? ''), x + pad, y + pad, { width: ws[i] - pad * 2 });
      x += ws[i];
    });
    doc.moveTo(x0, y + hgt).lineTo(x0 + total, y + hgt).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.x = x0;
    doc.y = y + hgt;
  };

  drawRow(head, true);
  for (const r of rows) drawRow(r, false);
  doc.moveDown(0.8);
}

function writeLetter(doc, letter) {
  const left = doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(11).text(letter.from.name, { align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  if (letter.from.address) doc.text(letter.from.address, { align: 'right' });
  doc.text([letter.from.email, letter.from.phone].filter(Boolean).join('  |  '), { align: 'right' });
  doc.moveDown(1.2).fillColor(INK).fontSize(10).text(prettyDate(letter.date, { long: true }));
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').text(letter.to.title);
  doc.font('Helvetica').text(letter.to.organisation);
  if (letter.to.email) doc.text(`By email: ${letter.to.email}`);
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(10.5).text(`RE: ${letter.subject.toUpperCase()}`);
  doc.font('Helvetica').fontSize(9.5);
  for (const [k, v] of letter.re) doc.text(`${k}: ${v}`);
  doc.moveDown(0.8).fontSize(10);

  for (const b of letter.blocks) {
    if (b.type === 'p') {
      ensureSpace(doc, 30);
      doc.font('Helvetica').fontSize(10).text(b.text, { align: 'left', lineGap: 1.5 });
      doc.moveDown(0.6);
    } else if (b.type === 'h') {
      ensureSpace(doc, 40);
      doc.moveDown(0.2).font('Helvetica-Bold').fontSize(10.5).fillColor(ACCENT).text(b.text).fillColor(INK);
      doc.moveDown(0.3);
    } else if (b.type === 'list') {
      b.items.forEach((item, i) => {
        ensureSpace(doc, 24);
        const bullet = b.ordered ? `(${String.fromCharCode(97 + i)})` : '•';
        const y = doc.y;
        doc.font('Helvetica').fontSize(10).text(bullet, left + 6, y, { width: 22 });
        doc.text(item, left + 30, y, { width: contentWidth(doc) - 30, lineGap: 1.5 });
        doc.moveDown(0.3);
      });
      doc.x = left;
      doc.moveDown(0.4);
    } else if (b.type === 'table') {
      const total = contentWidth(doc);
      drawTable(doc, b.head, b.rows, [0.15, 0.2, 0.15, 0.17, 0.15, 0.18].map((f) => f * total));
    }
  }
  ensureSpace(doc, 70);
  doc.moveDown(0.6).font('Helvetica').text(letter.signoff);
  doc.moveDown(2.2).font('Helvetica-Bold').text(letter.signName);
}

function footer(doc, text) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`${text}  ·  Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 34, { width: contentWidth(doc), align: 'center' });
    doc.page.margins.bottom = bottom;
  }
}

function letterPdf(letter, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true, info: { Title: letter.subject, Author: letter.from.name } });
  doc.pipe(stream);
  writeLetter(doc, letter);
  footer(doc, letter.subject);
  doc.end();
}

const uploadPath = (file) => path.join(config.uploadDir, path.basename(file));

// Full evidence pack: letter, calculations, readings log, photos, bill copies list.
function evidencePackPdf({ letter, property, amounts, readings, billDocs }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true, info: { Title: `Evidence pack: ${letter.subject}`, Author: letter.from.name } });
  doc.pipe(stream);
  const total = contentWidth(doc);

  writeLetter(doc, letter);

  // Annexure A: readings log + photos.
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).fillColor(ACCENT).text('Annexure A: Meter readings log').fillColor(INK);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(`Property: ${property.address || property.nickname}   Account: ${property.account_number || ''}`).fillColor(INK);
  if (property.water_meter_no || property.elec_meter_no) {
    doc.text([property.water_meter_no && `Water meter no. ${property.water_meter_no}`, property.elec_meter_no && `Electricity meter no. ${property.elec_meter_no}`].filter(Boolean).join('   '));
  }
  doc.moveDown(0.6);
  drawTable(
    doc,
    ['Date', 'Service', 'Reading', 'Photo', 'Camera timestamp', 'Note'],
    readings.map((r) => [
      prettyDate(r.reading_date),
      r.utility === 'water' ? 'Water' : 'Electricity',
      `${num(r.value, 3)} ${units(r.utility)}`,
      r.photo_file ? `Photo ${r.photoIndex}` : '-',
      r.photo_taken_at ? r.photo_taken_at.replace('T', ' ') : '-',
      r.note || '',
    ]),
    [0.15, 0.13, 0.17, 0.1, 0.2, 0.25].map((f) => f * total),
  );

  const photos = readings.filter((r) => r.photo_file && ['image/jpeg', 'image/png'].includes(r.photo_mime));
  for (let i = 0; i < photos.length; i++) {
    const r = photos[i];
    const file = uploadPath(r.photo_file);
    if (!fs.existsSync(file)) continue;
    if (i % 2 === 0) doc.addPage();
    const boxH = (doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 60) / 2;
    const y = doc.page.margins.top + (i % 2) * (boxH + 30);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(`Photo ${r.photoIndex}: ${r.utility} meter, ${prettyDate(r.reading_date)}, reading ${num(r.value, 3)} ${units(r.utility)}${r.photo_taken_at ? `  (camera timestamp ${r.photo_taken_at.replace('T', ' ')})` : ''}`, doc.page.margins.left, y, { width: total });
    try {
      doc.image(file, doc.page.margins.left, y + 16, { fit: [total, boxH - 10], align: 'center', valign: 'top' });
    } catch {
      doc.font('Helvetica').fontSize(9).text('(Image could not be embedded.)', doc.page.margins.left, y + 20);
    }
  }

  // Annexure B: calculation.
  doc.addPage();
  doc.x = doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(ACCENT).text('Annexure B: Calculation of disputed amounts').fillColor(INK);
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9.5).text('Actual consumption for each billing period is calculated from the account holder\'s own dated meter readings (Annexure A). Where a reading was not taken on the exact billing date, the meter value on that date is interpolated linearly between the nearest readings before and after it. The disputed amount for each charge is the difference between billed and actual consumption, multiplied by the average rate charged per unit on that account.', { lineGap: 1.5 });
  doc.moveDown(0.6);
  const rows = [];
  for (const b of amounts.bills) {
    for (const c of b.consumption) {
      const r = c.result;
      rows.push([
        prettyDate(b.bill.bill_date),
        `${r.utility}${c.line.reading_type === 'estimated' ? ' (est.)' : ''}`,
        `${c.line.prev_date ? prettyDate(c.line.prev_date) : '?'} to ${c.line.curr_date ? prettyDate(c.line.curr_date) : '?'}`,
        r.billedUnits === null ? '-' : `${num(r.billedUnits)} ${units(r.utility)}`,
        r.actualUnits === null ? '-' : `${num(r.actualUnits)} ${units(r.utility)}`,
        r.ratePerUnit === null ? '-' : `${rand(Math.round(r.ratePerUnit))}/${units(r.utility)}`,
        r.overchargeCents === null ? '-' : rand(r.overchargeCents),
        r.confidence || 'no data',
      ]);
    }
    for (const l of b.bill.lines || []) {
      if (l.disputed && l.kind !== 'consumption') rows.push([prettyDate(b.bill.bill_date), l.label || l.kind, '', '', '', '', rand(l.amount_cents), 'disputed item']);
    }
  }
  drawTable(doc, ['Account', 'Service', 'Period', 'Billed', 'Actual', 'Avg rate', 'Difference', 'Confidence'], rows, [0.12, 0.11, 0.2, 0.1, 0.1, 0.11, 0.12, 0.14].map((f) => f * total));
  doc.font('Helvetica-Bold').fontSize(10.5).text(`Total in dispute: ${rand(amounts.totalCents)}`);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Negative differences (under-billing in a period) are netted off against over-billing, so the total is never overstated.').fillColor(INK);

  if (billDocs.length) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(ACCENT).text('Annexure C: Copies of disputed accounts').fillColor(INK);
    doc.moveDown(0.3);
    for (const d of billDocs) {
      const file = uploadPath(d.document_file);
      if (['image/jpeg', 'image/png'].includes(d.document_mime) && fs.existsSync(file)) {
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(10).text(`Account dated ${prettyDate(d.bill_date)}`);
        try {
          doc.image(file, doc.page.margins.left, doc.y + 6, { fit: [total, doc.page.height - doc.y - 90], align: 'center' });
        } catch {
          doc.font('Helvetica').text('(Image could not be embedded.)');
        }
      } else {
        doc.font('Helvetica').fontSize(9.5).text(`Account dated ${prettyDate(d.bill_date)}: attached separately (PDF).`);
      }
    }
  }

  footer(doc, `Evidence pack · ${property.account_number || property.nickname} · prepared with ${config.brand}`);
  doc.end();
}

// Payment receipt for the subscriber.
function receiptPdf({ payment, user, plan }, stream) {
  const doc = newDoc(`Receipt ${payment.id}`);
  doc.pipe(stream);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ACCENT).text(config.brand).fillColor(INK);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(config.business.legalName).text(config.business.address);
  if (config.business.vatNumber) doc.text(`VAT no. ${config.business.vatNumber}`);
  doc.fillColor(INK).moveDown(1.5);
  doc.font('Helvetica-Bold').fontSize(14).text(config.business.vatNumber ? 'Tax invoice / receipt' : 'Receipt');
  doc.font('Helvetica').fontSize(10).moveDown(0.5);
  doc.text(`Receipt no: MP-${String(payment.id).padStart(6, '0')}`);
  doc.text(`Date: ${prettyDate((payment.completed_at || payment.created_at).slice(0, 10), { long: true })}`);
  doc.text(`Billed to: ${user ? `${user.name} <${user.email}>` : payment.user_email}`);
  doc.text(`Payment method: ${payment.method === 'payfast' ? 'Card / instant EFT (PayFast)' : payment.method === 'eft' ? 'Direct EFT' : payment.method}`);
  doc.moveDown(1);
  drawTable(doc, ['Description', 'Amount'], [[plan ? plan.name : payment.sku, rand(payment.amount_cents)]], [0.75, 0.25].map((f) => f * contentWidth(doc)));
  if (config.business.vatNumber) doc.text(`Includes VAT of ${rand(Math.round((payment.amount_cents * 15) / 115))}`);
  doc.font('Helvetica-Bold').text(`Total paid: ${rand(payment.amount_cents)}`);
  doc.moveDown(2).font('Helvetica').fontSize(9).fillColor(MUTED).text(`Questions? ${config.supportEmail}`);
  doc.end();
}

module.exports = { letterPdf, evidencePackPdf, receiptPdf };
