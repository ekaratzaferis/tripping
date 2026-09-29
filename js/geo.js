// Live position: watches the device GPS, records a thinned track to IndexedDB,
// and supports a simulated location for trying the app before the trip.
import { settings, track } from './store.js';
import { bus, distance } from './util.js';

const MAX_ACCURACY = 80; // metres; worse fixes are shown but not recorded
const MIN_MOVE = 15; // metres between recorded points
const MAX_GAP = 5 * 60 * 1000; // record at least every 5 min while stationary

let watchId = null;
let lastRecorded = null;

export const geo = {
  real: null,
  error: null,
  get pos() {
    const sim = settings.get().simLocation;
    if (sim) return { ...sim, acc: 8, sim: true, t: Date.now() };
    return geo.real;
  },
  start() {
    if (watchId != null) return;
    if (!('geolocation' in navigator)) {
      geo.error = 'Geolocation is not available in this browser.';
      bus.emit('position', geo.pos);
      return;
    }
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 30000,
    });
  },
  stop() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  },
  get watching() {
    return watchId != null;
  },
};

async function onPos(p) {
  const c = p.coords;
  geo.error = null;
  geo.real = {
    lat: c.latitude,
    lng: c.longitude,
    acc: c.accuracy,
    heading: Number.isFinite(c.heading) ? c.heading : null,
    speed: c.speed,
    t: p.timestamp,
  };
  bus.emit('position', geo.pos);
  if (settings.get().tracking) await maybeRecord(geo.real);
}

function onErr(e) {
  geo.error = e.code === 1 ? 'Location permission denied.' : e.message || 'Location unavailable.';
  bus.emit('position', geo.pos);
}

async function maybeRecord(p) {
  if (p.acc > MAX_ACCURACY) return;
  if (!lastRecorded) lastRecorded = await track.last();
  if (lastRecorded) {
    const moved = distance(lastRecorded, p);
    const gap = p.t - lastRecorded.t;
    if (gap <= 0) return;
    if (moved < Math.max(MIN_MOVE, p.acc / 2) && gap < MAX_GAP) return;
  }
  const pt = { t: p.t, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), acc: Math.round(p.acc) };
  lastRecorded = pt;
  await track.add(pt);
}

export function resetRecorder() {
  lastRecorded = null;
}
