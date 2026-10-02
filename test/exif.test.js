'use strict';

process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'mp-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { readExifDate, sniffImage, sniffDocument } = require('../src/lib/exif');
const { jpegWithExif } = require('./helpers');

test('reads DateTimeOriginal in both byte orders', () => {
  assert.equal(readExifDate(jpegWithExif('2026:07:14 08:15:02')), '2026-07-14T08:15:02');
  assert.equal(readExifDate(jpegWithExif('2026:07:14 08:15:02', false)), '2026-07-14T08:15:02');
});

test('returns null for files without EXIF or garbage', () => {
  assert.equal(readExifDate(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  assert.equal(readExifDate(Buffer.from('not an image')), null);
  assert.equal(readExifDate(jpegWithExif('0000:00:00 00:00:00')), null);
});

test('sniffs real file types from magic bytes', () => {
  assert.equal(sniffImage(jpegWithExif('2026:07:14 08:15:02')), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')), 'image/png');
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(sniffDocument(Buffer.from('%PDF-1.7 ......')), 'application/pdf');
});

