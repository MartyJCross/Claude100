'use strict';

// Reads the camera timestamp (EXIF DateTimeOriginal, falling back to DateTime)
// from a JPEG, so a meter photo carries independent proof of when it was taken.
// Returns "YYYY-MM-DDTHH:MM:SS" (camera local time) or null.

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;

function readExifDate(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let off = 2;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
        return parseTiff(buf, off + 10, Math.min(buf.length, off + 2 + len));
      }
      off += 2 + len;
    }
  } catch {
    // Corrupt or truncated metadata is not an error for our purposes.
  }
  return null;
}

function parseTiff(buf, start, end) {
  const order = buf.toString('latin1', start, start + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(start + 2) !== 42) return null;

  const readIfd = (rel) => {
    const at = start + rel;
    if (at + 2 > end) return new Map();
    const count = u16(at);
    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > end) break;
      tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueAt: e + 8 });
    }
    return tags;
  };

  const ascii = (entry) => {
    if (!entry || entry.type !== 2) return null;
    const at = entry.count > 4 ? start + u32(entry.valueAt) : entry.valueAt;
    if (at + entry.count > end) return null;
    return buf.toString('latin1', at, at + entry.count).replace(/\0+$/, '');
  };

  const ifd0 = readIfd(u32(start + 4));
  let value = null;
  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  if (exifPtr) value = ascii(readIfd(u32(exifPtr.valueAt)).get(TAG_DATETIME_ORIGINAL));
  if (!value) value = ascii(ifd0.get(TAG_DATETIME));
  const m = value && value.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

// Recognise uploads by their bytes, not by the client-supplied type.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /hei[cx]|mif1|heim|heis/.test(buf.toString('latin1', 8, 12))) return 'image/heic';
  return null;
}

function sniffDocument(buf) {
  if (buf && buf.length > 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return sniffImage(buf);
}

module.exports = { readExifDate, sniffImage, sniffDocument };
