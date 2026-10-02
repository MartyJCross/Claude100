'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const { analyseProperty } = require('./analysis');
const { readExifDate, sniffImage, sniffDocument } = require('./exif');
const { randomToken } = require('./security');

function getProperty(userId, id) {
  return db.one('SELECT * FROM properties WHERE id = ? AND user_id = ?', Number(id), userId) || null;
}

function listProperties(userId) {
  return db.all('SELECT * FROM properties WHERE user_id = ? ORDER BY created_at', userId);
}

function loadReadings(propertyId) {
  return db.all('SELECT * FROM readings WHERE property_id = ? ORDER BY reading_date, id', propertyId);
}

function loadBills(propertyId) {
  const bills = db.all('SELECT * FROM bills WHERE property_id = ? ORDER BY bill_date, id', propertyId);
  if (!bills.length) return bills;
  const lines = db.all(`SELECT * FROM bill_lines WHERE bill_id IN (${bills.map(() => '?').join(',')}) ORDER BY id`, ...bills.map((b) => b.id));
  for (const b of bills) b.lines = lines.filter((l) => l.bill_id === b.id);
  return bills;
}

function analyse(propertyId) {
  const bills = loadBills(propertyId);
  const readings = loadReadings(propertyId);
  return { bills, readings, analysis: analyseProperty({ bills, readings }) };
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };

// Persist a multer memory upload after checking its real type. Returns null if rejected.
function saveUpload(file, { allowPdf = false } = {}) {
  if (!file || !file.buffer || !file.buffer.length) return null;
  const mime = allowPdf ? sniffDocument(file.buffer) : sniffImage(file.buffer);
  if (!mime) return null;
  const name = `${randomToken(18)}.${EXT[mime]}`;
  fs.writeFileSync(path.join(config.uploadDir, name), file.buffer, { mode: 0o600 });
  return { name, mime, takenAt: mime === 'image/jpeg' ? readExifDate(file.buffer) : null };
}

function deleteUpload(name) {
  if (!name) return;
  try {
    fs.unlinkSync(path.join(config.uploadDir, path.basename(name)));
  } catch {
    // Already gone.
  }
}

// Files belonging to a user (for export and deletion).
function userFiles(userId) {
  const r = db.all('SELECT r.photo_file AS f FROM readings r JOIN properties p ON p.id = r.property_id WHERE p.user_id = ? AND r.photo_file IS NOT NULL', userId);
  const b = db.all('SELECT b.document_file AS f FROM bills b JOIN properties p ON p.id = b.property_id WHERE p.user_id = ? AND b.document_file IS NOT NULL', userId);
  return [...r, ...b].map((x) => x.f);
}

function propertyFiles(propertyId) {
  const r = db.all('SELECT photo_file AS f FROM readings WHERE property_id = ? AND photo_file IS NOT NULL', propertyId);
  const b = db.all('SELECT document_file AS f FROM bills WHERE property_id = ? AND document_file IS NOT NULL', propertyId);
  return [...r, ...b].map((x) => x.f);
}

module.exports = { getProperty, listProperties, loadReadings, loadBills, analyse, saveUpload, deleteUpload, userFiles, propertyFiles };
