// The "brain" of the live guide. Given the trip, the time and my position it
// works out: what's happening now, where I'm heading, which alerts to show,
// which activities to check in on, and which tips are relevant.
import { resolvePlace, eventPlace, eventPlaces, hasCoords } from './trip.js';
import { distance, travelEstimate, fmtTime, fmtDist, fmtDuration, dayKey, relTime } from './util.js';

const TRACKED_KINDS = new Set(['fixed', 'free', 'transfer']);
const DEFAULT_LEAD = { fixed: 180, free: 120, transfer: 240, logistics: 90, meal: 60 };
const BUFFER_MIN = 10;

export function activeDayKey(trip, now) {
  const k = dayKey(now, trip.timezone);
  const days = trip.days.map((d) => d.date);
  if (days.includes(k)) return k;
  if (k < days[0]) return days[0];
  return days[days.length - 1];
}

export function computeState({ trip, ts, now, pos }) {
  const tz = trip.timezone;
  const t = now.getTime();
  const visits = ts.visits();
  const status = (e) => ts.status(e.id);
  const open = (e) => !status(e);

  const inTrip = t >= trip.start - 36e5 * 6 && t <= trip.end.getTime() + 36e5 * 2;
  const nearCity = pos ? distance(pos, trip.center) < 60000 : false;
  const today = activeDayKey(trip, now);
  const todayEvents = trip.events.filter((e) => e.day === today);

  const current = [...trip.events].reverse().find((e) => e.startD <= now && now < e.endD && status(e) !== 'skipped') || null;
  const next = trip.events.find((e) => e.startD > now && open(e)) || null;

  // A stop counts as visited if I was there during (or shortly before) the event.
  const visitedDuring = (placeId, e) => {
    const v = visits[placeId];
    return !!v && v.last >= e.startD.getTime() - 30 * 60000 && v.first <= e.endD.getTime() + 30 * 60000;
  };

  /* ---------- where am I heading? ---------- */
  let target = null;
  let targetReason = '';
  const manual = ts.target();
  if (manual) {
    const p = resolvePlace(trip, manual.placeId);
    if (hasCoords(p)) { target = p; targetReason = 'Your pick'; }
  }
  if (!target && current && open(current)) {
    if (current.stops?.length) {
      const nextStop = current.stops.map((id) => resolvePlace(trip, id)).find((p) => hasCoords(p) && !visitedDuring(p.id, current));
      if (nextStop) { target = nextStop; targetReason = current.title; }
    }
    if (!target) {
      const p = eventPlace(trip, current);
      if (hasCoords(p)) { target = p; targetReason = current.title; }
    }
  }
  if (!target && next) {
    const p = eventPlace(trip, next);
    if (hasCoords(p)) { target = p; targetReason = `Next: ${next.title}`; }
  }
  const targetDist = pos && target ? distance(pos, target) : null;
  const atTarget = targetDist != null && targetDist <= (target.radius || 70) + Math.min(pos.acc || 0, 40);

  /* ---------- where am I right now? ---------- */
  let here = null;
  if (pos) {
    let best = Infinity;
    for (const [id, p] of Object.entries(trip.places)) {
      const d = distance(pos, p);
      if (d <= (p.radius || 70) + Math.min(pos.acc || 0, 40) && d < best) { best = d; here = { id, ...p }; }
    }
  }

  /* ---------- alerts ---------- */
  const alerts = [];
  const snoozed = (key) => ts.snoozedUntil(key) > t;

  for (const e of trip.events) {
    if (!e.alert || !open(e)) continue;
    if (e.optional && e.booking && !ts.checked(e.booking)) continue;
    const lead = (e.leadMinutes || DEFAULT_LEAD[e.kind] || 120) * 60000;
    const until = e.startD - t;
    if (until > lead || until < -15 * 60000) continue;
    const place = eventPlace(trip, e);
    const d = pos && hasCoords(place) && nearCity ? distance(pos, place) : null;
    const eta = d != null ? travelEstimate(d) : null;
    const leaveBy = eta ? e.startD.getTime() - (eta.mins + BUFFER_MIN) * 60000 : null;
    const minsToLeave = leaveBy != null ? (leaveBy - t) / 60000 : until / 60000 - 30;
    const arrived = d != null && d <= (place.radius || 70) + 30;
    let level = 'info';
    if (!arrived && minsToLeave <= 0) level = 'urgent';
    else if (!arrived && minsToLeave <= 30) level = 'warn';
    const parts = [`${e.title} at ${fmtTime(e.startD, tz)} (${relTime(e.startD - t)})`];
    if (arrived) parts.push("You're there.");
    else if (eta) parts.push(`${fmtDist(d)} away, ~${fmtDuration(eta.mins)} ${eta.mode === 'walk' ? 'on foot' : 'by metro/taxi'}. ${level === 'urgent' ? 'Leave now!' : `Leave by ${fmtTime(new Date(leaveBy), tz)}.`}`);
    alerts.push({
      key: `ev:${e.id}`, level, icon: e.kind === 'transfer' ? '✈️' : '⏰',
      title: level === 'urgent' ? `Time to go: ${e.title}` : e.kind === 'transfer' ? 'Upcoming transfer' : 'Upcoming reservation',
      text: parts.join(' '), eventId: e.id, placeId: place?.id, notify: level !== 'info',
    });
  }

  // Unbooked things coming up within a week.
  for (const e of trip.events) {
    if (!e.booking || ts.checked(e.booking) || e.startD < now) continue;
    const item = trip.itemById[e.booking];
    if (!item || item.optional) continue;
    const days = (e.startD - t) / 864e5;
    if (days > 7) continue;
    const key = `book:${e.booking}`;
    if (snoozed(key)) continue;
    alerts.push({
      key, level: days < 1 ? 'warn' : 'info', icon: '🎟️', title: `Not booked yet: ${item.title}`,
      text: `Needed ${relTime(e.startD - t)}${item.price ? ` · ${item.price}` : ''}.`, url: item.url, snoozable: true,
      action: { label: 'Booked ✓', do: 'check', id: e.booking },
    });
  }

  for (const n of trip.nudges) {
    if (t < new Date(n.from) || t > new Date(n.until)) continue;
    if (n.unlessChecked && ts.checked(n.unlessChecked)) continue;
    if (n.onlyIfChecked && !ts.checked(n.onlyIfChecked)) continue;
    const key = `nudge:${n.id}`;
    if (snoozed(key)) continue;
    alerts.push({
      key, level: 'info', icon: '💡', title: n.title, text: n.text, url: n.url, snoozable: true,
      snoozeHours: n.snoozeHours, action: n.unlessChecked ? { label: 'Done ✓', do: 'check', id: n.unlessChecked } : null,
    });
  }

  const usesHotel = trip.events.some((e) => e.place === 'hotel' && e.endD > now);
  if (usesHotel && resolvePlace(trip, 'hotel').missing && !snoozed('hotel-missing')) {
    alerts.push({ key: 'hotel-missing', level: 'info', icon: '🛏️', title: 'Where are you staying?', text: 'Set your hotel in Settings so the map can guide you back.', go: 'settings', snoozable: true, snoozeHours: 24 });
  }

  const order = { urgent: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  /* ---------- check-ins for things that already happened ---------- */
  const checkins = [];
  for (const e of trip.events) {
    if (!TRACKED_KINDS.has(e.kind) || !open(e) || e.endD > now) continue;
    if (snoozed(`checkin:${e.id}`)) continue;
    const places = eventPlaces(trip, e).filter(hasCoords);
    const seen = places.filter((p) => visitedDuring(p.id, e));
    const missed = e.stops?.length ? places.filter((p) => !seen.includes(p)) : [];
    checkins.push({ event: e, seen, missed });
  }

  /* ---------- tips for where I am / what I'm doing ---------- */
  let tips = null;
  if (here && (here.tips || here.url)) tips = { place: here, reason: "You're here" };
  else if (current) {
    const p = target && current.stops?.includes(target.id) ? target : eventPlace(trip, current);
    if (p?.tips) tips = { place: p, event: current, reason: 'Current activity' };
  }
  if (!tips && target?.tips) tips = { place: target, reason: targetReason };

  return {
    now, today, todayEvents, current, next, target, targetReason, targetDist, atTarget, here,
    alerts, checkins, tips, inTrip, nearCity, pos,
  };
}

// Update visit log for every known place within its geofence.
export function recordVisits(trip, ts, pos, t = Date.now()) {
  if (!pos || pos.acc > 100) return;
  for (const [id, p] of Object.entries(trip.places)) {
    if (distance(pos, p) <= (p.radius || 70) + Math.min(pos.acc || 0, 40)) ts.markVisit(id, t);
  }
  const hotel = resolvePlace(trip, 'hotel');
  if (hasCoords(hotel) && distance(pos, hotel) <= 60 + Math.min(pos.acc || 0, 40)) ts.markVisit('hotel', t);
}
