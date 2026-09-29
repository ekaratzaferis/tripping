// Timeline: replay each day's recorded route, scrub through time, and find
// where you were when a photo was taken (from EXIF time or a typed time).
// Export GPX so photo tools (Lightroom, exiftool…) can geotag in bulk.
import { createMap, pinHtml, dotHtml } from '../map.js';
import { settings, track } from '../store.js';
import { resolvePlace, hasCoords } from '../trip.js';
import { esc, cat, distance, fmtDist, fmtTime, fmtDate, dayKey, zonedToDate, toLocalInput, fromLocalInput, download, directionsUrl, fmtDuration } from '../util.js';
import { icon, toast, emptyState } from '../ui.js';
import { readExif } from '../exif.js';

const GAP_MS = 10 * 60000;

export function positionAt(points, t) {
  if (!points.length) return null;
  if (t < points[0].t - 15 * 60000 || t > points[points.length - 1].t + 15 * 60000) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const after = points[lo];
  const before = points[lo - 1] || after;
  if (t >= after.t || before === after) return { lat: after.lat, lng: after.lng, gapMin: Math.abs(after.t - t) / 60000 };
  const f = (t - before.t) / (after.t - before.t);
  return {
    lat: before.lat + (after.lat - before.lat) * f,
    lng: before.lng + (after.lng - before.lng) * f,
    gapMin: (after.t - before.t) / 60000,
  };
}

function segments(points) {
  const segs = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && p.t - cur[cur.length - 1].t > GAP_MS) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

export function toGpx(points, name) {
  const segs = segments(points);
  const pts = (seg) => seg.map((p) => `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time>${p.acc ? `<hdop>${(p.acc / 5).toFixed(1)}</hdop>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Triparw" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name></metadata>
<trk><name>${esc(name)}</name>
${segs.map((s) => `<trkseg>\n${pts(s)}\n</trkseg>`).join('\n')}
</trk>
</gpx>`;
}

// Colour ramp through the day: morning gold → midday red → evening garnet → night blaugrana blue.
function hourColor(h) {
  const stops = [[6, [242, 169, 0]], [12, [218, 18, 26]], [17, [165, 0, 68]], [21, [0, 77, 152]], [24, [0, 46, 93]]];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (h >= stops[i][0] && h <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  const f = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (h - a[0]) / (b[0] - a[0])));
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
  return `rgb(${c.join(',')})`;
}

export function createTimelineView(root, ctx) {
  const { trip } = ctx;
  const tz = trip.timezone;
  root.innerHTML = `
    <div class="tl">
      <div class="tl-map" id="tl-map"></div>
      <div class="tl-panel">
        <div class="tl-days" id="tl-days"></div>
        <div id="tl-body"></div>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);

  let map = null;
  let mapPromise = null;
  let day = null;
  let pts = [];
  let allDays = [];
  let scrubT = null;
  let photos = []; // {name, url, t, pos, hadGps, gapMin}

  const dayRange = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    const from = zonedToDate(y, m, d, 0, 0, 0, tz).getTime();
    return [from, from + 864e5 - 1];
  };

  async function loadDays() {
    const all = await track.all();
    const keys = new Set(trip.days.map((d) => d.date));
    for (const p of all) keys.add(dayKey(new Date(p.t), tz));
    allDays = [...keys].sort();
    const counts = {};
    for (const p of all) { const k = dayKey(new Date(p.t), tz); counts[k] = (counts[k] || 0) + 1; }
    if (!day) {
      const today = dayKey(ctx.now(), tz);
      day = counts[today] ? today : allDays.filter((k) => counts[k]).pop() || trip.days[0].date;
    }
    $('#tl-days').innerHTML = allDays.map((k) => {
      const d = new Date(`${k}T12:00:00Z`);
      return `<button class="day-chip ${k === day ? 'on' : ''}" data-day="${k}">
        <b>${esc(fmtDate(d, 'UTC', { weekday: 'short' }))} ${d.getUTCDate()}</b>
        <small>${counts[k] ? `${counts[k]} pts` : 'no data'}</small></button>`;
    }).join('');
  }

  async function loadDay() {
    const [from, to] = dayRange(day);
    pts = await track.range(from, to);
    scrubT = pts.length ? pts[pts.length - 1].t : null;
    renderBody();
    renderMap(true);
  }

  function ensureMap() {
    return (mapPromise ||= createMap($('#tl-map'), { center: trip.center, zoom: 13 }).then((m) => { map = m; renderMap(true); return m; }));
  }

  function renderMap(fit) {
    if (!map || !day) return;
    const segs = [];
    for (const seg of segments(pts)) {
      // Split each continuous segment into hourly chunks for colour.
      let chunk = [seg[0]];
      let hour = +fmtTime(new Date(seg[0].t), tz).slice(0, 2);
      for (let i = 1; i < seg.length; i++) {
        chunk.push(seg[i]);
        const h = +fmtTime(new Date(seg[i].t), tz).slice(0, 2);
        if (h !== hour || i === seg.length - 1) {
          segs.push({ points: chunk, color: hourColor(+fmtTime(new Date(chunk[0].t), tz).slice(0, 2) + 0.5), weight: 5, opacity: 0.9 });
          chunk = [seg[i]];
          hour = h;
        }
      }
    }
    map.setLines('route', segs);

    const markers = [];
    if (pts.length) {
      markers.push({ ...pts[0], z: 20, html: dotHtml('#2E7D32', 'A'), title: `Start ${fmtTime(new Date(pts[0].t), tz)}` });
      markers.push({ ...pts[pts.length - 1], z: 20, html: dotHtml('#DA121A', 'B'), title: `End ${fmtTime(new Date(pts[pts.length - 1].t), tz)}` });
    }
    const tripDay = trip.days.find((d) => d.date === day);
    const seen = new Set();
    for (const e of tripDay?.events || []) {
      for (const id of [e.place, ...(e.stops || [])].filter(Boolean)) {
        const p = resolvePlace(trip, id);
        if (!hasCoords(p) || seen.has(p.id)) continue;
        seen.add(p.id);
        markers.push({ ...p, z: 5, title: p.name, html: pinHtml({ category: p.category, small: true }) });
      }
    }
    map.setMarkers('places', markers);

    const [from, to] = dayRange(day);
    map.setMarkers('photos', photos.filter((ph) => ph.pos && ph.t >= from && ph.t <= to).map((ph) => ({
      ...ph.pos, z: 30, title: ph.name,
      html: ph.url ? `<div class="mk-photo"><img src="${ph.url}" alt=""></div>` : dotHtml('#004D98', '📷'),
      onClick: () => toast(`${ph.name} · ${fmtTime(new Date(ph.t), tz)}`),
    })));

    const sp = scrubT != null ? positionAt(pts, scrubT) : null;
    map.setMarkers('scrub', sp ? [{ ...sp, z: 50, html: `<div class="mk-scrub"><span>${fmtTime(new Date(scrubT), tz)}</span></div>` }] : []);

    if (fit) {
      const fitPts = pts.length ? pts : [...seen].map((id) => resolvePlace(trip, id)).filter(hasCoords);
      map.fit(fitPts.length ? fitPts : [trip.center], { top: 40, left: 30, right: 30, bottom: 40 });
    }
  }

  function stats() {
    let dist = 0;
    for (const seg of segments(pts)) for (let i = 1; i < seg.length; i++) dist += distance(seg[i - 1], seg[i]);
    const dur = pts.length > 1 ? (pts[pts.length - 1].t - pts[0].t) / 60000 : 0;
    return { dist, dur };
  }

  function nearestPlace(p) {
    let best = null;
    let bd = Infinity;
    for (const [id, pl] of Object.entries(trip.places)) {
      const d = distance(p, pl);
      if (d < bd) { bd = d; best = { id, ...pl }; }
    }
    return best && bd < 400 ? { ...best, d: bd } : null;
  }

  function renderBody() {
    const s = stats();
    const hasPts = pts.length > 0;
    const sp = scrubT != null ? positionAt(pts, scrubT) : null;
    const near = sp && nearestPlace(sp);
    const camOff = settings.get().cameraOffsetMin || 0;
    const tripDay = trip.days.find((d) => d.date === day);
    const defaultTime = hasPts ? new Date(pts[Math.floor(pts.length / 2)].t) : zonedToDate(...day.split('-').map(Number), 12, 0, 0, tz);

    $('#tl-body').innerHTML = `
      <div class="tl-head">
        <div><h2>${esc(tripDay?.name || fmtDate(new Date(`${day}T12:00:00Z`), 'UTC', { weekday: 'long' }))} <small>${esc(fmtDate(new Date(`${day}T12:00:00Z`), 'UTC', { day: 'numeric', month: 'long' }))}</small></h2>
        ${tripDay ? `<div class="muted small">${esc(tripDay.theme)}</div>` : ''}</div>
        <div class="stats">
          <div><b>${hasPts ? fmtDist(s.dist) : '–'}</b><small>walked</small></div>
          <div><b>${hasPts ? fmtDuration(s.dur) : '–'}</b><small>tracked</small></div>
          <div><b>${pts.length}</b><small>points</small></div>
        </div>
      </div>
      ${hasPts ? `
      <div class="scrub">
        <div class="scrub-row"><span>${fmtTime(new Date(pts[0].t), tz)}</span>
          <input type="range" id="scrub" min="${pts[0].t}" max="${pts[pts.length - 1].t}" step="30000" value="${scrubT}">
          <span>${fmtTime(new Date(pts[pts.length - 1].t), tz)}</span></div>
        <div class="scrub-out">${sp ? `At <b>${fmtTime(new Date(scrubT), tz)}</b> you were ${near ? `near <b>${esc(near.name)}</b> (${fmtDist(near.d)})` : `at <b>${sp.lat.toFixed(5)}, ${sp.lng.toFixed(5)}</b>`}
          <button class="link-btn" data-copy="${sp.lat.toFixed(6)},${sp.lng.toFixed(6)}">copy coords</button>` : ''}</div>
      </div>` : emptyState('🧭', 'No route recorded for this day', 'Keep the app open (screen on or in the foreground) while you walk and your route shows up here.')}

      <section class="card photo-finder">
        <h3>${icon('camera')} Where did I take this photo?</h3>
        <p class="muted small">Drop photos (JPEG or RAW) and I'll read the capture time and look up where you were. Photos stay on your device.</p>
        <label class="drop" id="drop">
          <input type="file" id="photo-input" multiple accept="image/*,.dng,.nef,.arw,.cr2,.orf,.rw2,.pef,.srw,.tif,.tiff">
          <span>${icon('upload')} <b>Choose photos</b> or drop them here</span>
        </label>
        <div class="row-form">
          <label>Or a time <input type="datetime-local" id="find-time" value="${toLocalInput(defaultTime, tz)}"></label>
          <button class="btn small" data-act="find">Find</button>
        </div>
        <div class="row-form">
          <label title="If your camera clock is 5 minutes fast, enter 5. If it's still on home time, enter the difference in minutes.">Camera clock is ahead by
            <input type="number" id="cam-off" value="${camOff}" step="1" style="width:6em"> min</label>
        </div>
        <div id="find-out"></div>
        ${photos.length ? `<div class="photo-results">${photos.map((ph, i) => `
          <div class="photo-row ${ph.pos ? '' : 'miss'}">
            ${ph.url ? `<img src="${ph.url}" alt="">` : `<div class="ph-ph">📷</div>`}
            <div class="grow"><b>${esc(ph.name)}</b>
              <small>${ph.t ? `${esc(fmtDate(new Date(ph.t), tz))} ${fmtTime(new Date(ph.t), tz)}` : 'No capture time found'}
              ${ph.hadGps ? ' · already geotagged' : ph.pos ? ` · ±${ph.gapMin < 1 ? '<1' : Math.round(ph.gapMin)} min gap` : ph.t ? ' · no route at that time' : ''}</small>
              ${ph.pos ? `<small>${ph.pos.lat.toFixed(5)}, ${ph.pos.lng.toFixed(5)}${nearestPlace(ph.pos) ? ` · near ${esc(nearestPlace(ph.pos).name)}` : ''}</small>` : ''}</div>
            ${ph.pos ? `<button class="icon-btn" data-show-photo="${i}" aria-label="Show on map">${icon('pin')}</button>
              <a class="icon-btn" href="https://www.google.com/maps/search/?api=1&query=${ph.pos.lat},${ph.pos.lng}" target="_blank" rel="noopener" aria-label="Open in Google Maps">${icon('external')}</a>` : ''}
          </div>`).join('')}</div>
          <div class="btn-row tight"><button class="btn small" data-act="photos-csv">${icon('download')} Photo locations (CSV)</button>
          <button class="btn small ghost" data-act="photos-clear">Clear</button></div>` : ''}
      </section>

      <section class="card">
        <h3>${icon('download')} Export your route</h3>
        <p class="muted small">GPX works with Lightroom (Map → Load Tracklog), exiftool (<code>exiftool -geotag day.gpx DIR</code>), Google Earth and most photo tools.</p>
        <div class="btn-row tight">
          <button class="btn small primary" data-act="gpx-day" ${hasPts ? '' : 'disabled'}>GPX · this day</button>
          <button class="btn small" data-act="gpx-all">GPX · whole trip</button>
          <button class="btn small ghost" data-act="json-all">Backup (JSON)</button>
          <label class="btn small ghost">Import backup<input type="file" accept=".json,application/json" id="import-track" hidden></label>
        </div>
      </section>`;
  }

  async function handlePhotos(files) {
    const off = (settings.get().cameraOffsetMin || 0) * 60000;
    const out = $('#find-out');
    out.innerHTML = '<div class="loading">Reading photos…</div>';
    const all = await track.all();
    for (const f of files) {
      let ex = null;
      try { ex = await readExif(f); } catch { /* unreadable */ }
      let t = null;
      if (ex?.wallTime) {
        const w = ex.wallTime;
        const pad = (n) => String(n).padStart(2, '0');
        t = ex.offset
          ? new Date(`${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${ex.offset}`).getTime()
          : zonedToDate(w.y, w.m, w.d, w.h, w.mi, w.s, tz).getTime();
        t -= off;
      } else if (f.lastModified) {
        t = f.lastModified - off;
      }
      const hadGps = !!ex?.gps;
      const pos = hadGps ? ex.gps : t ? positionAt(all, t) : null;
      const canShow = /image\/(jpeg|png|webp|gif|avif)/.test(f.type);
      photos.push({ name: f.name, t, pos, hadGps, gapMin: pos?.gapMin ?? 0, url: canShow ? URL.createObjectURL(f) : null, fromExif: !!ex?.wallTime });
    }
    const first = photos.find((p) => p.pos && p.t);
    if (first) { day = dayKey(new Date(first.t), tz); scrubT = first.t; }
    await loadDays();
    await loadDay();
    const noTime = photos.filter((p) => !p.fromExif).length;
    if (noTime) toast(`${noTime} photo(s) had no EXIF time. Used file date instead.`);
  }

  root.addEventListener('input', (e) => {
    if (e.target.id === 'scrub') {
      scrubT = +e.target.value;
      renderMap(false);
      const sp = positionAt(pts, scrubT);
      const near = sp && nearestPlace(sp);
      root.querySelector('.scrub-out').innerHTML = sp ? `At <b>${fmtTime(new Date(scrubT), tz)}</b> you were ${near ? `near <b>${esc(near.name)}</b> (${fmtDist(near.d)})` : `at <b>${sp.lat.toFixed(5)}, ${sp.lng.toFixed(5)}</b>`}
        <button class="link-btn" data-copy="${sp.lat.toFixed(6)},${sp.lng.toFixed(6)}">copy coords</button>` : '';
    }
  });

  root.addEventListener('change', async (e) => {
    if (e.target.id === 'photo-input') handlePhotos([...e.target.files]);
    if (e.target.id === 'cam-off') settings.set({ cameraOffsetMin: +e.target.value || 0 });
    if (e.target.id === 'import-track') {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        const points = (data.points || data).filter((p) => isFinite(p.t) && isFinite(p.lat) && isFinite(p.lng));
        await track.bulkAdd(points);
        toast(`Imported ${points.length} points`);
        await loadDays();
        await loadDay();
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    }
  });

  root.addEventListener('dragover', (e) => { if (e.target.closest('#drop')) { e.preventDefault(); e.target.closest('#drop').classList.add('over'); } });
  root.addEventListener('dragleave', (e) => e.target.closest('#drop')?.classList.remove('over'));
  root.addEventListener('drop', (e) => {
    if (!e.target.closest('#drop')) return;
    e.preventDefault();
    handlePhotos([...e.dataTransfer.files]);
  });

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-day],[data-act],[data-show-photo],[data-copy]');
    if (!t) return;
    if (t.dataset.day) {
      day = t.dataset.day;
      root.querySelectorAll('.day-chip').forEach((c) => c.classList.toggle('on', c.dataset.day === day));
      return loadDay();
    }
    if (t.dataset.copy) {
      try { await navigator.clipboard.writeText(t.dataset.copy); toast('Coordinates copied'); } catch { toast(t.dataset.copy); }
      return;
    }
    if (t.dataset.showPhoto) {
      const ph = photos[+t.dataset.showPhoto];
      day = dayKey(new Date(ph.t), tz);
      scrubT = ph.t;
      await loadDays();
      await loadDay();
      map?.panTo(ph.pos, 17);
      return;
    }
    switch (t.dataset.act) {
      case 'find': {
        const d = fromLocalInput($('#find-time').value, tz);
        if (!d) return;
        const all = await track.all();
        const p = positionAt(all, d.getTime());
        const out = $('#find-out');
        if (!p) { out.innerHTML = `<div class="callout">No route recorded around ${esc(fmtDate(d, tz))} ${fmtTime(d, tz)}.</div>`; return; }
        const near = nearestPlace(p);
        day = dayKey(d, tz);
        scrubT = d.getTime();
        await loadDays();
        await loadDay();
        $('#find-out').innerHTML = `<div class="callout ok">${icon('pin')} <div>At ${fmtTime(d, tz)} you were ${near ? `near <b>${esc(near.name)}</b>` : 'here'}: <b>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</b>
          <div class="btn-row tight"><button class="btn tiny" data-copy="${p.lat.toFixed(6)},${p.lng.toFixed(6)}">Copy</button>
          <a class="btn tiny" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}">Google Maps ↗</a></div></div></div>`;
        map?.panTo(p, 17);
        break;
      }
      case 'gpx-day':
        download(`${trip.id}-${day}.gpx`, toGpx(pts, `${trip.title} ${day}`), 'application/gpx+xml');
        break;
      case 'gpx-all': {
        const all = await track.all();
        if (!all.length) return toast('No route recorded yet');
        download(`${trip.id}-all.gpx`, toGpx(all, trip.title), 'application/gpx+xml');
        break;
      }
      case 'json-all': {
        const all = await track.all();
        download(`${trip.id}-track.json`, JSON.stringify({ trip: trip.id, exported: new Date().toISOString(), points: all }));
        break;
      }
      case 'photos-csv': {
        const rows = [['file', 'time_utc', 'lat', 'lng', 'gap_min', 'source']];
        for (const p of photos) rows.push([p.name, p.t ? new Date(p.t).toISOString() : '', p.pos?.lat ?? '', p.pos?.lng ?? '', p.pos ? Math.round(p.gapMin) : '', p.hadGps ? 'exif' : p.pos ? 'route' : '']);
        download(`${trip.id}-photo-locations.csv`, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
        break;
      }
      case 'photos-clear':
        photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
        photos = [];
        renderBody();
        renderMap(false);
        break;
    }
  });

  return {
    async show() {
      await ensureMap();
      map.resize();
      await loadDays();
      await loadDay();
    },
    async onTrack() {
      if (!root.classList.contains('active') || !day) return;
      const [from, to] = dayRange(day);
      if (Date.now() < from || Date.now() > to) return;
      pts = await track.range(from, to);
      renderMap(false);
    },
  };
}

// Generates a believable walk through the first trip day, for previewing the
// timeline before you travel. Timestamps are the real trip dates.
export function makeDemoTrack(trip) {
  const day = trip.days[0];
  const route = [];
  for (const e of day.events) {
    for (const id of [e.place, ...(e.stops || [])].filter(Boolean)) {
      const p = resolvePlace(trip, id);
      if (hasCoords(p) && p.category !== 'airport') route.push({ p, start: e.startD.getTime(), end: e.endD.getTime() });
    }
  }
  if (!route.length) return [];
  const out = [];
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  let t = route[0].start;
  let cur = route[0].p;
  for (let i = 1; i < route.length; i++) {
    const next = route[i].p;
    t = Math.max(t, route[i - 1].start);
    // linger at the current place
    const linger = Math.min(40, Math.max(10, (route[i].start - t) / 60000 / 2));
    for (let k = 0; k < linger; k += 3) out.push({ t: t + k * 60000, lat: cur.lat + rnd() * 0.0006, lng: cur.lng + rnd() * 0.0006, acc: 12 });
    t += linger * 60000;
    const d = distance(cur, next);
    const steps = Math.max(2, Math.round(d / 40));
    const stepMs = (d / 1.25 / steps) * 1000;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const bend = Math.sin(f * Math.PI) * 0.0012;
      out.push({ t: Math.round(t + s * stepMs), lat: cur.lat + (next.lat - cur.lat) * f + bend * 0.4 + rnd() * 0.00015, lng: cur.lng + (next.lng - cur.lng) * f - bend * 0.3 + rnd() * 0.00015, acc: 10 });
    }
    t += steps * stepMs;
    cur = next;
  }
  return out.map((p) => ({ ...p, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), t: Math.round(p.t) }));
}
