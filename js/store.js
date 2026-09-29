// Persistence: localStorage for preferences / checklist / statuses,
// IndexedDB for the GPS track (can grow beyond localStorage limits).
import { bus } from './util.js';

const P = 'triparw:';

function read(key, def) {
  try {
    const v = localStorage.getItem(P + key);
    return v == null ? def : JSON.parse(v);
  } catch {
    return def;
  }
}
function write(key, val) {
  try {
    if (val === undefined) localStorage.removeItem(P + key);
    else localStorage.setItem(P + key, JSON.stringify(val));
  } catch (e) {
    console.warn('localStorage write failed', e);
  }
}

/* ---------- global settings ---------- */
const DEFAULTS = {
  gmapsKey: '',
  hotel: null, // {name, address, lat, lng}
  terminal: 'T1',
  tracking: true,
  notifications: false,
  wakeLock: false,
  simOffset: 0, // ms added to Date.now() for "what if it were…" testing
  simLocation: null, // {lat,lng}
  cameraOffsetMin: 0, // camera clock minus real time, in minutes
  showAllPlaces: false,
  theme: 'auto',
};
let settingsCache = null;
export const settings = {
  get() {
    return (settingsCache ||= { ...DEFAULTS, ...read('settings', {}) });
  },
  set(patch) {
    settingsCache = { ...settings.get(), ...patch };
    write('settings', settingsCache);
    bus.emit('settings', patch);
  },
};

export const now = () => new Date(Date.now() + (settings.get().simOffset || 0));

/* ---------- per-trip state ---------- */
export function tripState(tripId) {
  const k = (name) => `${tripId}:${name}`;
  const get = (name, def) => read(k(name), def);
  const set = (name, val, silent) => {
    write(k(name), val);
    if (!silent) bus.emit('store', name);
  };
  const patch = (name, fn, silent) => set(name, fn(get(name, {})), silent);

  return {
    get,
    set,
    // checklists
    checked: (id) => !!get('checks', {})[id],
    toggle: (id, v) => patch('checks', (c) => ({ ...c, [id]: v ?? !c[id] })),
    customItems: () => get('custom', []), // [{id, list, group, title, note}]
    addItem: (item) => set('custom', [...get('custom', []), item]),
    removeItem: (id) => {
      const custom = get('custom', []);
      if (custom.some((i) => i.id === id)) set('custom', custom.filter((i) => i.id !== id));
      else patch('hidden', (h) => ({ ...h, [id]: true }));
    },
    hidden: () => get('hidden', {}),
    restoreHidden: () => set('hidden', {}),
    // event statuses: 'done' | 'skipped'
    status: (id) => get('status', {})[id] || null,
    setStatus: (id, s) => patch('status', (st) => {
      const n = { ...st };
      if (s) n[id] = s; else delete n[id];
      return n;
    }),
    // geofence visits: {placeId: {first, last}}
    visits: () => get('visits', {}),
    markVisit: (placeId, t) => patch('visits', (v) => ({
      ...v, [placeId]: { first: v[placeId]?.first ?? t, last: t },
    }), true),
    // snoozed alerts & sent notifications
    snoozedUntil: (key) => get('snooze', {})[key] || 0,
    snooze: (key, until) => patch('snooze', (s) => ({ ...s, [key]: until })),
    wasNotified: (key) => !!get('notified', {})[key],
    markNotified: (key) => patch('notified', (s) => ({ ...s, [key]: Date.now() }), true),
    // in-app navigation target
    target: () => get('target', null),
    setTarget: (placeId) => set('target', placeId ? { placeId, since: Date.now() } : null),
  };
}

export const tripOverride = {
  get: () => read('tripOverride', null),
  set: (json) => write('tripOverride', json),
  clear: () => write('tripOverride', undefined),
};

// Everything under our prefix, for backups.
export function exportLocal() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith(P)) out[key] = localStorage.getItem(key);
  }
  return out;
}
export function importLocal(obj) {
  for (const [key, v] of Object.entries(obj || {})) if (key.startsWith(P)) localStorage.setItem(key, v);
  settingsCache = null;
}
export function clearLocal() {
  for (const key of Object.keys(localStorage)) if (key.startsWith(P)) localStorage.removeItem(key);
  settingsCache = null;
}

/* ---------- GPS track in IndexedDB ---------- */
let dbp;
function db() {
  return (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('triparw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('points', { keyPath: 't' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
const store = async (mode) => (await db()).transaction('points', mode).objectStore('points');
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const track = {
  async add(p) {
    await req((await store('readwrite')).put(p));
    bus.emit('track', p);
  },
  async bulkAdd(pts) {
    const s = await store('readwrite');
    await Promise.all(pts.map((p) => req(s.put(p))));
    bus.emit('track', null);
  },
  range: async (from, to) => req((await store('readonly')).getAll(IDBKeyRange.bound(+from, +to))),
  all: async () => req((await store('readonly')).getAll()),
  count: async () => req((await store('readonly')).count()),
  last: async () => (await req((await store('readonly')).openCursor(null, 'prev')))?.value || null,
  async clear() {
    await req((await store('readwrite')).clear());
    bus.emit('track', null);
  },
};
