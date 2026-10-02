// Small shared helpers: DOM, formatting, geo math, time zones, event bus.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/* ---------- event bus ---------- */
const target = new EventTarget();
export const bus = {
  on(type, fn) {
    const h = (e) => fn(e.detail);
    target.addEventListener(type, h);
    return () => target.removeEventListener(type, h);
  },
  emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  },
};

/* ---------- geo ---------- */
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
export function distance(a, b) {
  if (!a || !b) return Infinity;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function fmtDist(m) {
  if (!isFinite(m)) return '';
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

// Rough door-to-door estimate: walk short hops, metro/taxi for longer ones.
export function travelEstimate(m) {
  if (!isFinite(m)) return null;
  if (m <= 1800) return { mins: Math.max(1, Math.round((m * 1.3) / 75)), mode: 'walk' };
  return { mins: Math.round(12 + (m / 1000) * 3), mode: 'transit' };
}

export function fmtDuration(mins) {
  mins = Math.round(mins);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function relTime(ms) {
  const past = ms < 0;
  const mins = Math.round(Math.abs(ms) / 60000);
  let s;
  if (mins < 1) return 'now';
  if (mins < 60) s = `${mins} min`;
  else if (mins < 60 * 36) s = fmtDuration(mins);
  else s = `${Math.round(mins / 1440)} days`;
  return past ? `${s} ago` : `in ${s}`;
}

/* ---------- time zones ---------- */
const partFmts = {};
function partsFmt(tz) {
  return (partFmts[tz] ||= new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
}

export function tzParts(date, tz) {
  const o = {};
  for (const p of partsFmt(tz).formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

function tzOffsetMin(date, tz) {
  const p = tzParts(date, tz);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

// Wall-clock time in `tz` -> Date.
export function zonedToDate(y, m, d, h = 0, mi = 0, s = 0, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let t = guess - tzOffsetMin(new Date(guess), tz) * 60000;
  const off2 = tzOffsetMin(new Date(t), tz);
  t = guess - off2 * 60000;
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(date, tz) {
  const p = tzParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function fmtTime(date, tz) {
  const p = tzParts(date, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

export function fmtDate(date, tz, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(date);
}

// For <input type="datetime-local"> in the trip time zone.
export function toLocalInput(date, tz) {
  const p = tzParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
export function fromLocalInput(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value || '');
  if (!m) return null;
  return zonedToDate(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
}

/* ---------- misc ---------- */
export function directionsUrl(p, mode = 'walking') {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=${mode}`;
}

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const CATEGORY = {
  museum: { emoji: '🖼️', color: '#A50044', label: 'Museum' },
  landmark: { emoji: '🏛️', color: '#DA121A', label: 'Landmark' },
  church: { emoji: '⛪', color: '#7A0033', label: 'Church' },
  park: { emoji: '🌳', color: '#2E7D32', label: 'Park' },
  viewpoint: { emoji: '🌅', color: '#F2A900', label: 'Viewpoint' },
  market: { emoji: '🧺', color: '#D4A000', label: 'Market' },
  food: { emoji: '🍽️', color: '#C8102E', label: 'Food & drink' },
  cafe: { emoji: '☕', color: '#7A4A2A', label: 'Café' },
  sweets: { emoji: '🧁', color: '#E0457F', label: 'Sweets' },
  books: { emoji: '📚', color: '#5A2E91', label: 'Books & shops' },
  square: { emoji: '⛲', color: '#0067B1', label: 'Square' },
  street: { emoji: '🛍️', color: '#004D98', label: 'Street' },
  beach: { emoji: '🏖️', color: '#0098D8', label: 'Beach' },
  transport: { emoji: '🚌', color: '#111114', label: 'Transport' },
  airport: { emoji: '✈️', color: '#111114', label: 'Airport' },
  neighbourhood: { emoji: '🏘️', color: '#5A5C66', label: 'Neighbourhood' },
  hotel: { emoji: '🛏️', color: '#111114', label: 'Hotel' },
};
export const cat = (c) => CATEGORY[c] || { emoji: '📍', color: '#6E6E78', label: 'Place' };
