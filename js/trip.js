// Loads a trip config (bundled JSON, ?trip=url, or an imported override) and
// resolves dynamic places like "hotel" and "airport" from settings.
import { settings, tripOverride } from './store.js';
import { fmtTime } from './util.js';

export const DEFAULT_TRIP_URL = 'data/barcelona-2026.json';

export async function loadTrip() {
  const override = tripOverride.get();
  if (override) return normalize(override);
  const url = new URLSearchParams(location.search).get('trip') || DEFAULT_TRIP_URL;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return normalize(await res.json());
}

export function validateTrip(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return ['Not a JSON object'];
  if (!raw.id) errors.push('Missing "id"');
  if (!raw.timezone) errors.push('Missing "timezone"');
  if (!Array.isArray(raw.days)) errors.push('Missing "days" array');
  for (const d of raw.days || []) {
    for (const e of d.events || []) {
      if (!e.id || !e.start || !e.title) errors.push(`Event in ${d.date} needs id, start and title`);
      else if (isNaN(new Date(e.start))) errors.push(`Event ${e.id} has an invalid start`);
    }
  }
  return errors;
}

function normalize(raw) {
  const trip = {
    places: {},
    checklists: [],
    nudges: [],
    guide: [],
    links: [],
    terminals: {},
    ...raw,
  };
  trip.events = [];
  trip.days = (raw.days || []).map((day) => {
    const events = (day.events || []).map((e) => ({ ...e, day: day.date }));
    return { ...day, events };
  });
  const flat = trip.days.flatMap((d) => d.events).sort((a, b) => new Date(a.start) - new Date(b.start));
  flat.forEach((e, i) => {
    e.startD = new Date(e.start);
    const next = flat[i + 1];
    e.endD = e.end ? new Date(e.end) : next ? new Date(next.start) : new Date(e.startD.getTime() + 90 * 60000);
    e.index = i;
  });
  trip.events = flat;
  trip.eventById = Object.fromEntries(flat.map((e) => [e.id, e]));
  trip.itemById = {};
  for (const list of trip.checklists)
    for (const g of list.groups || [])
      for (const it of g.items || []) trip.itemById[it.id] = { ...it, list: list.id, group: g.id, tone: g.tone };
  trip.start = flat[0]?.startD;
  trip.end = flat[flat.length - 1]?.endD;
  return trip;
}

export function resolvePlace(trip, id) {
  if (!id) return null;
  if (id === 'hotel') {
    // A hotel set on this device (Settings) wins over the one in the trip file.
    const h = settings.get().hotel;
    if (h && isFinite(h.lat)) return { id, category: 'hotel', radius: 60, ...(trip.hotel || {}), ...h, name: h.name || 'Your hotel' };
    if (trip.hotel && isFinite(trip.hotel.lat)) return { id, category: 'hotel', radius: 60, ...trip.hotel };
    return { id, category: 'hotel', name: 'Your hotel', missing: true };
  }
  if (id === 'airport') {
    const t = settings.get().terminal || 'T1';
    const pid = trip.terminals[t] || Object.values(trip.terminals)[0];
    return pid ? resolvePlace(trip, pid) : null;
  }
  const p = trip.places[id];
  return p ? { id, radius: 70, ...p } : null;
}

// The primary place of an event (for alerts / pins).
export function eventPlace(trip, ev) {
  return resolvePlace(trip, ev.alertPlace || ev.place || ev.stops?.[0]);
}

export function eventPlaces(trip, ev) {
  const ids = [...new Set([ev.place, ...(ev.stops || [])].filter(Boolean))];
  return ids.map((id) => resolvePlace(trip, id)).filter(Boolean);
}

export const hasCoords = (p) => p && isFinite(p.lat) && isFinite(p.lng);

// Event start time for display. Events elsewhere (e.g. a flight leaving
// Athens) carry their own `tz` and show local time there.
export function eventTime(trip, e) {
  if (e.tz && e.tz !== trip.timezone) return `${fmtTime(e.startD, e.tz)} ${e.tzLabel || 'local time'}`;
  return fmtTime(e.startD, trip.timezone);
}
