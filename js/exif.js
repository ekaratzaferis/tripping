// Minimal EXIF reader: pulls the capture time (and GPS, if present) out of
// JPEG files and TIFF-based RAWs (DNG, NEF, ARW, CR2, ORF…). Only the first
// 512 KB of each file is read.

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_ORIGINAL = 0x9011;
const TAG_SUBSEC_ORIGINAL = 0x9291;

export async function readExif(file) {
  const buf = await file.slice(0, 512 * 1024).arrayBuffer();
  const v = new DataView(buf);
  let tiff = -1;
  if (v.getUint16(0) === 0xffd8) {
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { tiff = off + 10; break; }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } else if (v.getUint16(0) === 0x4949 || v.getUint16(0) === 0x4d4d) {
    tiff = 0;
  }
  if (tiff < 0) return null;

  const le = v.getUint16(tiff) === 0x4949;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const str = (o, n) => {
    let s = '';
    for (let i = 0; i < n && o + i < v.byteLength; i++) {
      const c = v.getUint8(o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const rational = (o) => u32(o) / (u32(o + 4) || 1);

  function readIfd(start) {
    const out = {};
    if (start + 2 > v.byteLength) return out;
    const n = u16(start);
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const size = (sizes[type] || 1) * count;
      const valOff = size > 4 ? tiff + u32(e + 8) : e + 8;
      if (valOff + Math.min(size, 8) > v.byteLength) continue;
      if (type === 2) out[tag] = str(valOff, count);
      else if (type === 3) out[tag] = u16(valOff);
      else if (type === 4) out[tag] = u32(valOff);
      else if (type === 5) out[tag] = Array.from({ length: count }, (_, k) => rational(valOff + k * 8));
      else if (type === 1 || type === 7) out[tag] = str(valOff, count);
    }
    return out;
  }

  const ifd0 = readIfd(tiff + u32(tiff + 4));
  const exif = ifd0[TAG_EXIF_IFD] ? readIfd(tiff + ifd0[TAG_EXIF_IFD]) : {};
  const gps = ifd0[TAG_GPS_IFD] ? readIfd(tiff + ifd0[TAG_GPS_IFD]) : {};

  const raw = exif[TAG_DATETIME_ORIGINAL] || ifd0[TAG_DATETIME];
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw || '');
  const result = {
    wallTime: m ? { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] } : null,
    offset: exif[TAG_OFFSET_ORIGINAL] || null, // e.g. "+02:00"
    subsec: exif[TAG_SUBSEC_ORIGINAL] || null,
    gps: null,
  };
  if (gps[2] && gps[4]) {
    const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
    let lat = dms(gps[2]);
    let lng = dms(gps[4]);
    if (/S/i.test(gps[1])) lat = -lat;
    if (/W/i.test(gps[3])) lng = -lng;
    if (isFinite(lat) && isFinite(lng) && (lat || lng)) result.gps = { lat, lng };
  }
  return result;
}
