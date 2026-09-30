// Settings: map provider, hotel, terminal, tracking, notifications,
// "try it before the trip" simulation, and data import / export.
import { settings, track, tripOverride, exportLocal, importLocal, clearLocal } from '../store.js';
import { geo, resetRecorder } from '../geo.js';
import { validateTrip } from '../trip.js';
import { esc, fmtDate, fmtTime, toLocalInput, fromLocalInput, download } from '../util.js';
import { icon, toast } from '../ui.js';
import { geocode } from '../services.js';
import { makeDemoTrack } from './timeline.js';

export function createSettingsView(root, ctx) {
  const { trip, ts } = ctx;
  const tz = trip.timezone;
  let geoResults = null;

  async function render() {
    const s = settings.get();
    const n = await track.count().catch(() => 0);
    const notif = 'Notification' in window ? Notification.permission : 'unsupported';
    const now = ctx.now();
    root.innerHTML = `<div class="page">
      <header class="page-head"><h1>Settings</h1><p class="muted">Everything is stored on this device only.</p></header>

      <section class="card">
        <h3>🌓 Appearance</h3>
        <div class="seg">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button data-theme-pick="${v}" class="${(s.theme || 'auto') === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <p class="muted small">Auto follows your phone's setting.</p>
      </section>

      <section class="card">
        <h3>${icon('map')} Map</h3>
        <p class="muted small">Add a Google Maps JavaScript API key to use Google's flat 2D map. Without one, the app uses OpenStreetMap, which needs no key.
          Restrict the key to your GitHub Pages domain in the <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Google Cloud console</a>.</p>
        <form class="row-form" data-form="gmaps">
          <input name="key" type="password" placeholder="Google Maps API key" value="${esc(s.gmapsKey)}" autocomplete="off">
          <button class="btn small primary">Save</button>
        </form>
        <div class="muted small">Now using: <b>${s.gmapsKey ? 'Google Maps' : 'OpenStreetMap'}</b></div>
      </section>

      <section class="card">
        <h3>🛏️ Your hotel</h3>
        ${!s.hotel?.lat && trip.hotel?.lat ? `<div class="callout ok"><div><b>${esc(trip.hotel.name)}</b><br><span class="small muted">${esc(trip.hotel.address || '')}</span><br><span class="small muted">From your trip plan. Search below only if it changes.</span></div></div>` : ''}
        ${s.hotel?.lat ? `<div class="callout ok"><div><b>${esc(s.hotel.name || 'Hotel')}</b><br><span class="small muted">${esc(s.hotel.address || `${s.hotel.lat.toFixed(5)}, ${s.hotel.lng.toFixed(5)}`)}</span></div>
          <button class="icon-btn subtle" data-act="hotel-clear" aria-label="Clear hotel">${icon('trash')}</button></div>` : trip.hotel?.lat ? '' : '<p class="muted small">Used for "back to the hotel", checkout and lunch-nearby reminders.</p>'}
        <form class="row-form" data-form="hotel-search">
          <input name="q" placeholder="Hotel name or address" value="">
          <button class="btn small">Search</button>
        </form>
        ${geoResults ? `<div class="geo-results">${geoResults.length ? geoResults.map((r, i) => `<button class="place-row" data-geo="${i}"><span class="grow small">${esc(r.name)}</span>${icon('chevron')}</button>`).join('') : '<div class="muted small">No results. Try a shorter address.</div>'}</div>` : ''}
        <div class="btn-row tight">
          <button class="btn small ghost" data-act="hotel-here">${icon('locate')} Use my location</button>
          <button class="btn small ghost" data-act="hotel-pick">${icon('pin')} Tap on map</button>
        </div>
      </section>

      <section class="card">
        <h3>✈️ Departure terminal</h3>
        <div class="seg">${Object.keys(trip.terminals || {}).map((t) => `<button data-terminal="${t}" class="${s.terminal === t ? 'on' : ''}">${t}</button>`).join('')}</div>
        <p class="muted small">Decides the Aerobús line (A1/A2) and where the airport pin goes. ${ts.checked('terminal') ? '✓ Confirmed.' : 'Not confirmed yet.'}</p>
      </section>

      <section class="card">
        <h3>${icon('route')} Live tracking</h3>
        ${toggle('tracking', 'Record my route', 'Saves your GPS trail so you can replay each day and place photos later.', s.tracking)}
        ${toggle('wakeLock', 'Keep screen awake', 'Browsers pause GPS when the screen locks. Keeping it awake gives a complete route, at a battery cost.', s.wakeLock)}
        <div class="toggle-row">
          <div><b>Notifications</b><div class="muted small">Heads-ups for reservations and transfers while the app is open. Status: ${notif}.</div></div>
          <button class="btn small" data-act="notif" ${notif === 'unsupported' ? 'disabled' : ''}>${s.notifications && notif === 'granted' ? 'On ✓' : 'Enable'}</button>
        </div>
        <div class="muted small">${n} points recorded · GPS: ${geo.error ? esc(geo.error) : geo.watching ? 'active' : 'idle'}</div>
        <p class="callout small">${icon('info')} <span>Web apps can't track in the background. For a full-day route keep the app open. Adding it to your home screen (Share → Add to Home Screen) helps.</span></p>
      </section>

      <section class="card">
        <h3>🧪 Try it before the trip</h3>
        <p class="muted small">Pretend it's a different time or place to see the live guide in action.</p>
        <form class="row-form" data-form="sim-time">
          <label>Time (${esc(tz)}) <input type="datetime-local" name="t" value="${toLocalInput(now, tz)}"></label>
          <button class="btn small">Set</button>
          ${s.simOffset ? '<button type="button" class="btn small ghost" data-act="sim-time-clear">Use real time</button>' : ''}
        </form>
        <div class="chip-scroll">${trip.events.filter((e) => e.kind !== 'logistics').map((e) => `<button class="chip-btn" data-jump="${e.id}">${esc(fmtDate(e.startD, tz, { weekday: 'short' }))} ${fmtTime(e.startD, tz)} · ${esc(e.title.replace(/^Free roam: /, ''))}</button>`).join('')}</div>
        <div class="btn-row tight">
          <button class="btn small ghost" data-act="sim-pick">${icon('pin')} ${s.simLocation ? 'Move fake location' : 'Fake my location'}</button>
          ${s.simLocation ? '<button class="btn small ghost" data-act="sim-loc-clear">Use real GPS</button>' : ''}
          <button class="btn small ghost" data-act="demo">Load demo route (${esc(trip.days[0]?.name || 'day 1')})</button>
        </div>
        ${s.simOffset ? `<div class="muted small">Simulated time: ${esc(fmtDate(now, tz))} ${fmtTime(now, tz)}</div>` : ''}
      </section>

      <section class="card">
        <h3>🗺️ Trip</h3>
        <p class="muted small">Loaded: <b>${esc(trip.title)}</b> (${esc(trip.id)})${tripOverride.get() ? ' · imported' : ''}. Use the same JSON format for your next trip.</p>
        <div class="btn-row tight">
          <button class="btn small" data-act="trip-export">${icon('download')} Trip JSON</button>
          <label class="btn small">${icon('upload')} Import trip<input type="file" accept=".json,application/json" data-file="trip" hidden></label>
          ${tripOverride.get() ? '<button class="btn small ghost" data-act="trip-reset">Back to bundled trip</button>' : ''}
        </div>
      </section>

      <section class="card">
        <h3>💾 Your data</h3>
        <div class="btn-row tight">
          <button class="btn small" data-act="backup">${icon('download')} Full backup</button>
          <label class="btn small">${icon('upload')} Restore<input type="file" accept=".json,application/json" data-file="backup" hidden></label>
          <button class="btn small danger" data-act="wipe">Erase everything</button>
        </div>
      </section>
      <p class="fineprint">Triparw · works offline · no server, no accounts</p>
    </div>`;
  }

  const toggle = (key, title, desc, on) => `<label class="toggle-row">
    <div><b>${title}</b><div class="muted small">${desc}</div></div>
    <input type="checkbox" class="switch" data-toggle="${key}" ${on ? 'checked' : ''}></label>`;

  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.toggle) {
      settings.set({ [t.dataset.toggle]: t.checked });
      if (t.dataset.toggle === 'tracking' && t.checked) geo.start();
      return;
    }
    if (t.dataset.file === 'trip') {
      try {
        const json = JSON.parse(await t.files[0].text());
        const errs = validateTrip(json);
        if (errs.length) return toast(`Invalid trip: ${errs.slice(0, 2).join('; ')}`);
        tripOverride.set(json);
        location.reload();
      } catch (err) { toast(`Could not read file: ${err.message}`); }
    }
    if (t.dataset.file === 'backup') {
      try {
        const data = JSON.parse(await t.files[0].text());
        importLocal(data.local);
        if (data.points?.length) await track.bulkAdd(data.points);
        location.reload();
      } catch (err) { toast(`Could not restore: ${err.message}`); }
    }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    switch (f.dataset.form) {
      case 'gmaps':
        settings.set({ gmapsKey: f.key.value.trim() });
        toast('Saved. Reloading map…');
        setTimeout(() => location.reload(), 600);
        break;
      case 'hotel-search':
        if (!f.q.value.trim()) return;
        try { geoResults = await geocode(f.q.value.trim(), trip.center); } catch { toast('Search failed. Are you online?'); geoResults = null; }
        geoResults = geoResults && Object.assign(geoResults, { query: f.q.value.trim() });
        render();
        break;
      case 'sim-time': {
        const d = fromLocalInput(f.t.value, tz);
        if (d) { settings.set({ simOffset: d.getTime() - Date.now() }); toast('Time travel engaged 🕰️'); render(); }
        break;
      }
    }
  });

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-terminal],[data-geo],[data-jump],[data-theme-pick]');
    if (!t) return;
    if (t.dataset.themePick) {
      // No reload: a reload would create new (billable) Google map loads.
      settings.set({ theme: t.dataset.themePick });
      return;
    }
    if (t.dataset.terminal) {
      settings.set({ terminal: t.dataset.terminal });
      ts.toggle('terminal', true);
      return render();
    }
    if (t.dataset.geo) {
      const r = geoResults[+t.dataset.geo];
      settings.set({ hotel: { name: geoResults.query || r.name.split(',')[0], address: r.name, lat: r.lat, lng: r.lng } });
      geoResults = null;
      toast('Hotel saved');
      return render();
    }
    if (t.dataset.jump) {
      const ev = trip.eventById[t.dataset.jump];
      settings.set({ simOffset: ev.startD.getTime() - 20 * 60000 - Date.now() });
      toast(`Jumped to 20 min before ${ev.title}`);
      return ctx.go('live');
    }
    switch (t.dataset.act) {
      case 'hotel-clear': settings.set({ hotel: null }); render(); break;
      case 'hotel-here': {
        const p = geo.pos;
        if (!p) { geo.start(); return toast('No location yet. Try again in a moment.'); }
        settings.set({ hotel: { ...(settings.get().hotel || {}), name: settings.get().hotel?.name || 'Hotel', lat: p.lat, lng: p.lng } });
        toast('Hotel set to your current location');
        render();
        break;
      }
      case 'hotel-pick': ctx.pickOnMap('hotel'); break;
      case 'sim-pick': ctx.pickOnMap('sim'); break;
      case 'sim-loc-clear': settings.set({ simLocation: null }); render(); break;
      case 'sim-time-clear': settings.set({ simOffset: 0 }); render(); break;
      case 'demo': {
        const pts = makeDemoTrack(trip);
        await track.bulkAdd(pts);
        resetRecorder();
        toast(`Added ${pts.length} demo points. See Timeline.`);
        ctx.go('timeline');
        break;
      }
      case 'notif': {
        if (!('Notification' in window)) return;
        const p = await Notification.requestPermission();
        settings.set({ notifications: p === 'granted' });
        toast(p === 'granted' ? 'Notifications on' : 'Notifications blocked in browser settings');
        render();
        break;
      }
      case 'trip-export': download(`${trip.id}.json`, JSON.stringify(stripTrip(trip), null, 2)); break;
      case 'trip-reset': tripOverride.clear(); location.reload(); break;
      case 'backup': {
        const points = await track.all();
        download(`triparw-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, local: exportLocal(), points }));
        break;
      }
      case 'wipe':
        if (!confirm('Erase all checklists, settings and recorded routes on this device?')) return;
        clearLocal();
        await track.clear();
        location.reload();
        break;
    }
  });

  return { show: render, update: () => {} };
}

// Drop runtime-only fields before exporting a trip config.
function stripTrip(trip) {
  const { events, eventById, itemById, start, end, ...rest } = trip;
  rest.days = trip.days.map((d) => ({ ...d, events: d.events.map(({ startD, endD, index, day, ...e }) => e) }));
  return rest;
}
