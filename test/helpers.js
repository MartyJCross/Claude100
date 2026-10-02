'use strict';

// Builds a minimal JPEG with an EXIF block: IFD0 -> ExifIFD -> DateTimeOriginal.
function jpegWithExif(dateString, littleEndian = true) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4 + 20);
  const w16 = (v, o) => (littleEndian ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (v, o) => (littleEndian ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1');
  w16(42, 2);
  w32(8, 4); // IFD0 at offset 8
  w16(1, 8); // one entry
  w16(0x8769, 10); // ExifIFD pointer
  w16(4, 12);
  w32(1, 14);
  w32(26, 18); // ExifIFD at 26
  w32(0, 22); // next IFD
  w16(1, 26);
  w16(0x9003, 28); // DateTimeOriginal
  w16(2, 30); // ASCII
  w32(20, 32);
  w32(44, 36); // value at 44
  w32(0, 40);
  tiff.write(`${dateString}\0`, 44, 'latin1');
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1Body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1Body, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}

module.exports = { jpegWithExif };
