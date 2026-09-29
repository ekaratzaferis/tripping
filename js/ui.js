// Shared UI bits: icons, bottom-sheet modal, toasts, and the trencadís mosaic.
import { bus, esc } from './util.js';

const PATHS = {
  map: '<path d="M9 3 3 5.5V21l6-2.5 6 2.5 6-2.5V3l-6 2.5z"/><path d="M9 3v15.5M15 5.5V21"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="3"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  list: '<path d="m3.5 6 2 2 3.5-3.5M3.5 16l2 2 3.5-3.5"/><path d="M13 6.5h8M13 16.5h8"/>',
  route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H17a3.5 3.5 0 0 0 0-7H7a3.5 3.5 0 0 1 0-7h8.5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  layers: '<path d="m12 2.5 9.5 5-9.5 5-9.5-5z"/><path d="m2.5 16.5 9.5 5 9.5-5M2.5 12l9.5 5 9.5-5"/>',
  bulb: '<path d="M9 18h6M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.6.5.8 1.2.8 1.9V16h6v-.8c0-.7.3-1.4.8-1.9A6.5 6.5 0 0 0 12 2.5z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  nav: '<path d="M3 11 22 2l-9 19-2-8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  ticket: '<path d="M3 7.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2V10a2 2 0 0 0 0 4v2.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V14a2 2 0 0 0 0-4z"/><path d="M13.5 5.5v2M13.5 16.5v2M13.5 11v2"/>',
  bag: '<path d="M5.5 7.5h13l1 13.5h-15z"/><path d="M9 7.5V6a3 3 0 0 1 6 0v1.5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  rec: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;

/* ---------- toast ---------- */
export function toast(msg, ms = 3200) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 300);
  }, ms);
}
bus.on('toast', (m) => toast(m));

/* ---------- modal bottom sheet ---------- */
let openModal = null;
export function modal(html, { onMount, onClose, cls = '' } = {}) {
  closeModal();
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-backdrop" data-close></div>
    <div class="modal-card ${cls}" role="dialog" aria-modal="true">
      <button class="icon-btn modal-x" data-close aria-label="Close">${icon('x')}</button>
      <div class="modal-body">${html}</div>
    </div>`;
  root.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => {
    if (openModal !== api) return;
    openModal = null;
    wrap.classList.remove('in');
    setTimeout(() => wrap.remove(), 250);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  const api = { el: wrap.querySelector('.modal-body'), close };
  openModal = api;
  onMount?.(api.el, close);
  return api;
}
export function closeModal() {
  openModal?.close();
}

/* ---------- trencadís mosaic (seeded, deterministic) ---------- */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
// Senyera red & yellow, blaugrana blue & garnet, sea blue and plenty of white.
const TILE_COLORS = ['#DA121A', '#FCDD09', '#004D98', '#A50044', '#FFFFFF', '#0098D8', '#FCDD09', '#FFFFFF', '#DA121A', '#F2F2F2'];

export function mosaicSvg({ w = 420, h = 160, cell = 26, seed = 7, colors = TILE_COLORS } = {}) {
  const r = rng(seed);
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  const pts = [];
  for (let y = 0; y <= rows; y++) {
    pts[y] = [];
    for (let x = 0; x <= cols; x++) pts[y][x] = [x * cell + (r() - 0.5) * cell * 0.7, y * cell + (r() - 0.5) * cell * 0.7];
  }
  let shapes = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const quad = [pts[y][x], pts[y][x + 1], pts[y + 1][x + 1], pts[y + 1][x]];
      const tris = r() < 0.45 ? [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]] : [quad];
      for (const poly of tris) {
        const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
        const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
        const shrink = poly.map(([px, py]) => [cx + (px - cx) * 0.84, cy + (py - cy) * 0.84]);
        const c = colors[Math.floor(r() * colors.length)];
        shapes += `<polygon points="${shrink.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}" fill="${c}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">${shapes}</svg>`;
}
// Single quotes: this ends up inside a double-quoted style="" attribute.
export const mosaicUrl = (o) => `url('data:image/svg+xml;utf8,${encodeURIComponent(mosaicSvg(o))}')`;

export const emptyState = (emoji, title, text) =>
  `<div class="empty"><div class="empty-emoji">${emoji}</div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
