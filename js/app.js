// App bootstrap: loads the trip, wires views to the router, and keeps the
// live state fresh (clock tick, GPS updates, storage changes).
import { loadTrip } from './trip.js';
import { settings, tripState, tripOverride, now } from './store.js';
import { geo } from './geo.js';
import { computeState, recordVisits } from './engine.js';
import { bus, $, $$, esc, cat } from './util.js';
import { icon, toast } from './ui.js';
import { restyleMaps } from './map.js';
import { createLiveView } from './views/live.js';
import { createPlanView } from './views/plan.js';
import { createListsView } from './views/lists.js';
import { createTimelineView } from './views/timeline.js';
import { createSettingsView } from './views/settings.js';

const TABS = [
  { id: 'live', label: 'Live', icon: 'map' },
  { id: 'plan', label: 'Plan', icon: 'calendar' },
  { id: 'lists', label: 'Lists', icon: 'list' },
  { id: 'timeline', label: 'Timeline', icon: 'route' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
];

async function main() {
  let trip;
  try {
    trip = await loadTrip();
  } catch (e) {
    $('#app').innerHTML = `<div class="page fatal"><h1>Couldn't load the trip</h1><p>${esc(e.message)}</p>
      <button class="btn primary" id="reset-trip">Reset to bundled trip</button></div>`;
    $('#reset-trip').onclick = () => { tripOverride.clear(); location.reload(); };
    return;
  }
  document.title = `${trip.title} · Triparw`;
  const ts = tripState(trip.id);
  let current = null;

  const ctx = {
    trip, ts, state: null, now, picking: null,
    go: (id) => { location.hash = `#/${id}`; },
    pickOnMap(kind) {
      ctx.picking = kind;
      ctx.go('live');
      document.body.dataset.picking = kind;
      toast(kind === 'hotel' ? 'Tap the map where your hotel is' : 'Tap the map to put yourself there', 6000);
    },
    handleMapPick(p) {
      if (!ctx.picking) return;
      if (ctx.picking === 'hotel') {
        const h = settings.get().hotel || {};
        settings.set({ hotel: { name: h.name || 'Hotel', lat: p.lat, lng: p.lng } });
        toast('Hotel location saved');
      } else {
        settings.set({ simLocation: { lat: p.lat, lng: p.lng } });
        toast('Fake location set');
      }
      ctx.picking = null;
      delete document.body.dataset.picking;
    },
  };

  const views = {
    live: createLiveView($('#view-live'), ctx),
    plan: createPlanView($('#view-plan'), ctx),
    lists: createListsView($('#view-lists'), ctx),
    timeline: createTimelineView($('#view-timeline'), ctx),
    settings: createSettingsView($('#view-settings'), ctx),
  };

  $('#tabbar').innerHTML = TABS.map((t) => `<a href="#/${t.id}" data-tab="${t.id}">${icon(t.icon)}<span>${t.label}</span><i class="badge" hidden></i></a>`).join('');

  /* ---------- state ---------- */
  let lastHere = null;
  function recompute() {
    const pos = geo.pos;
    const t = now();
    if (pos) recordVisits(trip, ts, pos, t.getTime());
    const s = computeState({ trip, ts, now: t, pos });
    ctx.state = s;

    // Arriving somewhere with tips → nudge once.
    const hereId = s.here?.id || null;
    if (hereId && hereId !== lastHere && (s.here.tips?.dontMiss?.length || s.here.tips?.goodToKnow?.length)) {
      toast(`${cat(s.here.category).emoji} You're at ${s.here.name}. Tap 💡 for tips.`, 5000);
    }
    lastHere = hereId;
    // Reached a place I asked to be guided to → stop guiding.
    const manual = ts.target();
    if (manual && s.atTarget && s.target?.id === manual.placeId) {
      toast(`Arrived at ${s.target.name} 🎉`);
      ts.setTarget(null);
      return;
    }

    notify(s);
    updateBadges(s);
    if (current === 'live') views.live.update(s);
  }

  function updateBadges(s) {
    const set = (id, n, urgent) => {
      const b = $(`#tabbar [data-tab="${id}"] .badge`);
      b.hidden = !n;
      b.textContent = n;
      b.classList.toggle('urgent', !!urgent);
    };
    const urgent = s.alerts.filter((a) => a.level !== 'info').length;
    set('live', urgent + s.checkins.length, urgent > 0);
    const prebook = trip.checklists.find((l) => l.id === 'prebook');
    const hidden = ts.hidden();
    const open = prebook ? prebook.groups.flatMap((g) => g.items).filter((i) => !i.optional && !hidden[i.id] && !ts.checked(i.id)).length : 0;
    set('lists', open);
  }

  async function notify(s) {
    const st = settings.get();
    if (!st.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
    for (const a of s.alerts) {
      if (!a.notify) continue;
      const key = `${a.key}:${a.level}`;
      if (ts.wasNotified(key)) continue;
      ts.markNotified(key);
      const opts = { body: a.text, tag: a.key, icon: 'icon.svg', badge: 'icon.svg', renotify: a.level === 'urgent' };
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) reg.showNotification(a.title, opts);
        else new Notification(a.title, opts);
      } catch { /* not allowed in this context */ }
      navigator.vibrate?.([120, 60, 120]);
    }
  }

  /* ---------- router ---------- */
  function route() {
    const id = (location.hash.replace(/^#\/?/, '') || 'live').split('?')[0];
    const next = views[id] ? id : 'live';
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${next}`));
    $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === next));
    current = next;
    document.body.dataset.view = next;
    Promise.resolve(views[next].show()).then(() => {
      if (next === 'live' && ctx.state) views.live.update(ctx.state);
    });
    if (next !== 'live') { ctx.picking = null; delete document.body.dataset.picking; }
  }
  window.addEventListener('hashchange', route);

  /* ---------- wiring ---------- */
  let rafPending = false;
  const schedule = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; recompute(); });
  };
  bus.on('position', schedule);
  bus.on('store', () => {
    schedule();
    if (current === 'plan' || current === 'lists') views[current].update();
  });
  bus.on('settings', (patch) => {
    schedule();
    if ('wakeLock' in patch) syncWakeLock();
    if ('theme' in patch) { applyTheme(patch.theme); restyleMaps(); }
    if (current === 'settings' && !('cameraOffsetMin' in patch)) views.settings.show();
  });
  bus.on('track', () => { views.live.onTrack(); views.timeline.onTrack(); });
  setInterval(schedule, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { schedule(); syncWakeLock(); }
  });

  /* ---------- theme (auto / light / dark) ---------- */
  function applyTheme(t) {
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.dataset.theme = t;
    else delete root.dataset.theme;
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    metas.forEach((m, i) => { m.content = t === 'dark' ? '#0E0F12' : t === 'light' ? '#FFFFFF' : i === 0 ? '#FFFFFF' : '#0E0F12'; });
  }

  /* ---------- screen wake lock ---------- */
  let lock = null;
  async function syncWakeLock() {
    const want = settings.get().wakeLock && document.visibilityState === 'visible';
    try {
      if (want && !lock && 'wakeLock' in navigator) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } else if (!want && lock) {
        await lock.release();
        lock = null;
      }
    } catch { lock = null; }
  }
  syncWakeLock();

  geo.start();
  recompute();
  route();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
