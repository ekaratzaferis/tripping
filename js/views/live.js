// Live view: full-screen map with me + where I'm heading, a "now" card,
// alerts, a tips button, and a bottom sheet with Today / Nearby / Check-in.
import { createMap, pinHtml, dotHtml } from '../map.js';
import { resolvePlace, eventPlaces, hasCoords } from '../trip.js';
import { settings, track } from '../store.js';
import { geo } from '../geo.js';
import { esc, cat, fmtTime, fmtDate, fmtDist, distance, relTime, travelEstimate, fmtDuration, directionsUrl, dayKey, zonedToDate, debounce } from '../util.js';
import { icon, toast, emptyState } from '../ui.js';
import { getWeather, weatherEmoji, NEARBY_KINDS, searchNearby } from '../services.js';
import { openEvent, openPlace } from './details.js';

// Replace an element's HTML only when it changed. GPS updates arrive every
// second or so; rebuilding unchanged DOM would swallow taps mid-press.
function setHtml(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

export function createLiveView(root, ctx) {
  const { trip, ts } = ctx;
  const tz = trip.timezone;
  root.innerHTML = `
    <div class="live-map" id="live-map"></div>
    <div class="live-top">
      <div class="now-card" id="now-card"></div>
      <div class="alerts" id="alerts"></div>
    </div>
    <div class="fabs">
      <button class="fab" data-act="tips" aria-label="Tips for here">${icon('bulb')}<span class="fab-badge" hidden></span></button>
      <button class="fab" data-act="layers" aria-label="Show all places">${icon('layers')}</button>
      <button class="fab" data-act="locate" aria-label="Centre on me">${icon('locate')}</button>
    </div>
    <button class="rec-pill" data-act="rec" id="rec-pill"></button>
    <div class="sheet" id="sheet" data-state="peek">
      <div class="sheet-grab" id="sheet-grab"><div class="grabber"></div></div>
      <div class="seg" id="sheet-tabs">
        <button data-tab="today" class="on">Today</button>
        <button data-tab="nearby">Nearby</button>
        <button data-tab="checkin">Check-in <span class="count" hidden></span></button>
      </div>
      <div class="sheet-body" id="sheet-body"></div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  let map = null;
  let mapPromise = null;
  let follow = true;
  let tab = 'today';
  let nearby = { kind: null, results: null, loading: false, error: null };
  let lastTargetId = undefined;
  let initialFitDone = false;
  let hadFix = false;
  let weather = null;
  let todayTrack = [];
  let state = null;

  /* ---------- map ---------- */
  function ensureMap() {
    return (mapPromise ||= createMap($('#live-map'), {
      center: trip.center,
      zoom: 14,
      onUserMove: () => { follow = false; updateLocateBtn(); },
      onClick: (p) => ctx.handleMapPick(p),
    }).then((m) => {
      map = m;
      renderMap();
      loadTrack();
      fitSmart(true);
      return m;
    }));
  }

  function mapPad() {
    const top = ($('.live-top')?.offsetHeight || 120) + 16;
    return { top, bottom: 160, left: 36, right: 76 };
  }

  function fitSmart(force) {
    if (!map || !state) return;
    const pos = state.pos;
    const t = state.target;
    if (pos && state.nearCity) {
      if (t) map.fit([pos, t], mapPad());
      else map.panTo(pos, 16);
    } else if (force) {
      const pts = state.todayEvents.flatMap((e) => eventPlaces(trip, e)).filter(hasCoords);
      map.fit(pts.length ? pts : [trip.center], mapPad());
    }
    initialFitDone = true;
  }

  function renderMap() {
    if (!map || !state) return;
    const s = settings.get();
    const visits = ts.visits();
    const targetId = state.target?.id;
    const shown = new Set();
    const markers = [];

    state.todayEvents.forEach((e, i) => {
      const status = ts.status(e.id);
      for (const p of eventPlaces(trip, e)) {
        if (!hasCoords(p) || shown.has(p.id)) continue;
        shown.add(p.id);
        const isStop = e.stops?.includes(p.id) && e.place !== p.id;
        const visited = visits[p.id] && visits[p.id].last >= e.startD - 18e5;
        markers.push({
          ...p, z: p.id === targetId ? 500 : isStop ? 10 : 50, title: p.name,
          html: pinHtml({ category: p.category, active: p.id === targetId, done: status === 'done' || status === 'skipped' || (isStop && visited), small: isStop && p.id !== targetId }),
          onClick: () => openPlace(ctx, p, { reason: e.title }),
        });
      }
    });
    const target = state.target;
    if (target && !shown.has(target.id)) {
      shown.add(target.id);
      markers.push({ ...target, z: 500, title: target.name, html: pinHtml({ category: target.category, active: true }), onClick: () => openPlace(ctx, target, { reason: state.targetReason }) });
    }
    const hotel = resolvePlace(trip, 'hotel');
    if (hasCoords(hotel) && !shown.has('hotel')) {
      shown.add('hotel');
      markers.push({ ...hotel, z: 40, title: hotel.name, html: pinHtml({ category: 'hotel', small: true }), onClick: () => openPlace(ctx, hotel) });
    }
    map.setMarkers('plan', markers);

    const all = s.showAllPlaces
      ? Object.entries(trip.places).filter(([id]) => !shown.has(id)).map(([id, p]) => ({
        ...p, id, z: 1, title: p.name, html: pinHtml({ category: p.category, small: true }), onClick: () => openPlace(ctx, id),
      }))
      : [];
    map.setMarkers('all', all);

    map.setMarkers('nearby', (nearby.results || []).map((r) => ({
      ...r, z: 5, title: r.name, html: dotHtml('#111114', r.emoji),
      onClick: () => toast(`${r.name} · ${fmtDist(r.dist)}${r.hours ? ` · ${r.hours}` : ''}`),
    })));

    const lines = [];
    if (todayTrack.length > 1) lines.push({ points: todayTrack, color: '#A50044', weight: 4, opacity: 0.8 });
    map.setLines('track', lines);
    map.setLines('toTarget', state.pos && target && state.nearCity && !state.atTarget
      ? [{ points: [state.pos, target], color: '#1A73E8', weight: 5, opacity: 0.95, dashed: true }] : []);
    map.setUser(state.pos);
  }

  async function loadTrack() {
    const day = dayKey(ctx.now(), tz);
    const [y, m, d] = day.split('-').map(Number);
    const from = zonedToDate(y, m, d, 0, 0, 0, tz);
    todayTrack = await track.range(from.getTime(), from.getTime() + 864e5);
    renderMap();
    renderRec();
  }
  const loadTrackSoon = debounce(loadTrack, 1500);

  /* ---------- now card ---------- */
  function renderNow() {
    const s = state;
    const now = s.now;
    const sim = settings.get().simOffset || settings.get().simLocation;
    const wx = weatherChip();
    let title, sub = '', kicker = `${fmtDate(now, tz)} · ${fmtTime(now, tz)}`;
    // Calendar days in the trip's time zone, not elapsed 24h blocks.
    const dayNum = (k) => Date.UTC(...k.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
    const daysToGo = Math.round((dayNum(trip.days[0].date) - dayNum(dayKey(now, tz))) / 864e5);

    if (now < trip.start - 6 * 36e5) {
      title = daysToGo <= 0 ? `${esc(trip.title)} today!` : daysToGo === 1 ? `${esc(trip.title)} tomorrow` : `${esc(trip.title)} in ${daysToGo} days`;
      const todo = trip.checklists.find((l) => l.id === 'prebook')?.groups.flatMap((g) => g.items).filter((i) => !ts.checked(i.id) && !i.optional).length || 0;
      sub = todo ? `${todo} thing${todo === 1 ? '' : 's'} left to book` : 'Everything booked 🎉';
    } else if (now > trip.end) {
      title = 'Trip complete ✨';
      sub = 'Your routes are saved in Timeline';
    } else {
      const cur = s.current;
      title = cur ? esc(cur.title) : s.next ? `Next: ${esc(s.next.title)}` : 'Free time';
      if (cur && s.next) sub = `Then <b>${esc(s.next.title)}</b> ${relTime(s.next.startD - now)}`;
      else if (!cur && s.next) sub = `${fmtTime(s.next.startD, tz)} · ${relTime(s.next.startD - now)}`;
    }

    let heading = '';
    if (s.here) {
      heading = `<div class="now-line here"><span class="grow-line">${cat(s.here.category).emoji} You're at <b>${esc(s.here.name)}</b></span></div>`;
    } else if (s.target && s.nearCity) {
      const eta = travelEstimate(s.targetDist);
      const meta = s.targetDist != null ? ` · ${fmtDist(s.targetDist)}${eta ? ` · ${fmtDuration(eta.mins)}` : ''}` : '';
      heading = `<div class="now-line"><span class="dot-live"></span><span class="grow-line"><b>${esc(s.target.name)}</b><span class="muted">${meta}</span></span>
        ${ts.target() ? `<button class="link-btn" data-act="clear-target">clear</button>` : ''}
        ${!s.atTarget ? `<a class="go-link" href="${directionsUrl(s.target)}" target="_blank" rel="noopener">${icon('nav')} Go</a>` : ''}</div>`;
    } else if (!s.pos) {
      heading = `<div class="now-line muted"><span class="grow-line">${geo.error ? esc(geo.error) : 'Waiting for GPS…'}</span></div>`;
    } else if (!s.nearCity) {
      heading = `<div class="now-line muted"><span class="grow-line">You're ${fmtDist(distance(s.pos, trip.center))} from ${esc(trip.title)}</span></div>`;
    }

    const tipCount = (s.tips?.place.tips?.dontMiss?.length || 0) + (s.tips?.place.tips?.goodToKnow?.length || 0);
    setHtml($('#now-card'), `
      <div class="now-top"><span class="eyebrow">${kicker}${sim ? ' <span class="sim">SIM</span>' : ''}</span>${wx}</div>
      <div class="now-title">${title}</div>
      ${sub ? `<div class="now-sub">${sub}</div>` : ''}
      ${heading}`);
    root.querySelector('.fab-badge').hidden = !(s.tips && tipCount);
  }

  function weatherChip() {
    if (!weather) return '';
    const today = dayKey(state.now, tz);
    const i = weather.daily?.time?.indexOf(today) ?? -1;
    const sunset = i >= 0 ? weather.daily.sunset[i]?.slice(11, 16) : null;
    const useCurrent = Math.abs(state.now - Date.now()) < 36e5 * 3;
    const temp = useCurrent ? weather.current?.temperature_2m : i >= 0 ? weather.daily.temperature_2m_max[i] : null;
    const code = useCurrent ? weather.current?.weather_code : i >= 0 ? weather.daily.weather_code[i] : null;
    if (temp == null && !sunset) return '';
    return `<span class="wx">${temp != null ? `${weatherEmoji(code)} ${Math.round(temp)}°` : ''}${sunset ? ` · 🌇 ${sunset}` : ''}</span>`;
  }

  async function loadWeather() {
    try {
      weather = await getWeather(trip.center.lat, trip.center.lng, tz);
      if (state) renderNow();
    } catch { /* offline: no chip */ }
  }

  /* ---------- alerts ---------- */
  let alertsExpanded = false;
  function renderAlerts() {
    const list = state.alerts;
    const shown = alertsExpanded ? list : list.slice(0, 1);
    setHtml($('#alerts'), shown.map((a) => `
      <div class="alert lvl-${a.level}" data-key="${esc(a.key)}">
        <div class="alert-icon">${a.icon}</div>
        <div class="alert-main">
          <div class="alert-title">${esc(a.title)}</div>
          <div class="alert-text">${esc(a.text)}</div>
          ${a.action || a.url || a.go || a.placeId ? `<div class="alert-actions">
            ${a.action ? `<button class="btn tiny primary" data-alert-act="${a.action.do}" data-id="${esc(a.action.id)}">${esc(a.action.label)}</button>` : ''}
            ${a.placeId ? `<button class="btn tiny" data-alert-act="guide" data-id="${esc(a.placeId)}">Guide me</button>` : ''}
            ${a.url ? `<a class="btn tiny" href="${esc(a.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
            ${a.go ? `<button class="btn tiny" data-alert-act="go" data-id="${a.go}">Open ${a.go}</button>` : ''}
          </div>` : ''}
        </div>
        ${a.snoozable ? `<button class="icon-btn alert-x" data-alert-act="snooze" aria-label="Hide for now">${icon('x')}</button>` : ''}
      </div>`).join('') +
      (list.length > 1 ? `<button class="alerts-more" data-act="alerts-more">${alertsExpanded ? 'Show less' : `+${list.length - 1} more alert${list.length > 2 ? 's' : ''}`}</button>` : ''));
  }

  /* ---------- bottom sheet ---------- */
  function renderSheet() {
    const cnt = state.checkins.length;
    const c = root.querySelector('#sheet-tabs .count');
    c.hidden = !cnt;
    c.textContent = cnt;
    root.querySelectorAll('#sheet-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const body = $('#sheet-body');
    const scroll = body.scrollTop;
    if (setHtml(body, tab === 'today' ? todayHtml() : tab === 'nearby' ? nearbyHtml() : checkinHtml())) body.scrollTop = scroll;
  }

  function todayHtml() {
    const s = state;
    const day = trip.days.find((d) => d.date === s.today);
    const visits = ts.visits();
    return `<div class="sheet-day"><b>${esc(day?.name || '')}</b> <span class="muted">${esc(day?.theme || '')}</span></div>
      <div class="mini-timeline">${s.todayEvents.map((e) => {
        const st = ts.status(e.id);
        const isNow = s.current?.id === e.id;
        const past = e.endD < s.now;
        const stops = e.stops?.length ? `<div class="mini-stops">${e.stops.map((id) => {
          const p = resolvePlace(trip, id);
          if (!p) return '';
          const v = visits[id] && visits[id].last >= e.startD - 18e5 && visits[id].first <= +e.endD + 18e5;
          return `<span class="mini-stop ${v ? 'seen' : ''}" data-place="${esc(id)}">${v ? '✓' : cat(p.category).emoji} ${esc(p.name)}</span>`;
        }).join('')}</div>` : '';
        return `<button class="mini-ev kind-${e.kind} ${isNow ? 'now' : ''} ${past ? 'past' : ''} st-${st || 'open'}" data-event="${e.id}">
          <span class="mini-time">${esc(e.label || fmtTime(e.startD, tz))}</span>
          <span class="mini-dot"></span>
          <span class="mini-main"><b>${esc(e.title)}</b>${isNow ? '<em class="now-tag">Now</em>' : ''}${st ? `<em class="st-tag">${st === 'done' ? '✓ done' : 'skipped'}</em>` : ''}
          ${stops}</span>
        </button>`;
      }).join('')}</div>`;
  }

  function nearbyHtml() {
    const s = state;
    const origin = s.pos && s.nearCity ? s.pos : trip.center;
    const chips = NEARBY_KINDS.map((k) => `<button class="chip-btn ${nearby.kind === k.id ? 'on' : ''}" data-nearby="${k.id}">${k.emoji} ${k.label}</button>`).join('');
    let list;
    if (nearby.kind) {
      if (nearby.loading && !nearby.results) list = `<div class="loading">Searching OpenStreetMap…</div>`;
      else if (nearby.error) list = `<div class="callout">Couldn't search right now (${esc(nearby.error)}). Are you offline?</div>`;
      else if (!nearby.results?.length) list = emptyState('🤷', 'Nothing close by', 'Try another category or walk a bit.');
      else list = nearby.results
        .map((r) => ({ ...r, dist: s.pos && s.nearCity ? distance(s.pos, r) : r.dist }))
        .sort((a, b) => a.dist - b.dist)
        .map((r) => `
        <div class="near-row">
          <span class="place-emoji">${r.emoji}</span>
          <span class="grow"><b>${esc(r.name)}</b><small>${fmtDist(r.dist)}${r.cuisine ? ` · ${esc(r.cuisine)}` : ''}${r.hours ? ` · ${esc(r.hours)}` : ''}</small></span>
          <a class="icon-btn" href="${directionsUrl(r)}" target="_blank" rel="noopener" aria-label="Directions">${icon('nav')}</a>
        </div>`).join('');
      list = `<button class="link-btn" data-nearby="">← Back to sights near you</button>${list}`;
    } else {
      const places = Object.entries(trip.places)
        .map(([id, p]) => ({ id, ...p, dist: distance(origin, p) }))
        .filter((p) => p.category !== 'airport')
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 12);
      list = `<div class="muted small pad-b">${s.pos && s.nearCity ? 'Sights from your guide, closest first' : `Distances from the centre of ${esc(trip.title)}`}</div>` +
        places.map((p) => {
          const c = cat(p.category);
          const n = (p.tips?.dontMiss?.length || 0) + (p.tips?.goodToKnow?.length || 0);
          return `<div class="near-row" data-place="${esc(p.id)}">
            <span class="place-emoji" style="--accent:${c.color}">${c.emoji}</span>
            <span class="grow"><b>${esc(p.name)}</b><small>${fmtDist(p.dist)} · ${esc(c.label)}${n ? ` · ${n} tips` : ''}</small></span>
            <button class="icon-btn" data-guide="${esc(p.id)}" aria-label="Guide me">${icon('nav')}</button>
          </div>`;
        }).join('');
    }
    return `<div class="chip-scroll">${chips}</div>${list}`;
  }

  function checkinHtml() {
    const list = state.checkins;
    if (!list.length) return emptyState('🌞', 'All caught up', 'When an activity ends I\'ll ask whether you did it, so I can stop tracking it.');
    return list.slice().reverse().map(({ event: e, seen, missed }) => {
      const auto = seen.length ? `📍 Looks like you were there${seen[0] ? ` (${esc(seen[0].name)}, ${fmtTime(new Date(ts.visits()[seen[0].id].first), tz)})` : ''}.` : '';
      return `<div class="checkin">
        <div class="eyebrow">${esc(fmtDate(e.startD, tz))} · ${esc(e.label || fmtTime(e.startD, tz))}</div>
        <div class="checkin-q">Did you do <b>${esc(e.title)}</b>?</div>
        ${auto ? `<div class="muted small">${auto}</div>` : ''}
        ${missed.length ? `<div class="muted small">You missed: ${missed.map((p) => `<button class="mini-stop" data-guide="${esc(p.id)}">${cat(p.category).emoji} ${esc(p.name)} · go</button>`).join(' ')}</div>` : ''}
        <div class="btn-row tight">
          <button class="btn small primary" data-checkin="done" data-id="${e.id}">${icon('check')} Yes, done</button>
          <button class="btn small" data-checkin="skipped" data-id="${e.id}">Skipped it</button>
          <button class="btn small ghost" data-checkin="later" data-id="${e.id}">Ask later</button>
        </div>
      </div>`;
    }).join('');
  }

  /* ---------- sheet drag ---------- */
  const sheet = $('#sheet');
  const SNAP = { peek: () => sheet.offsetHeight - 118, half: () => sheet.offsetHeight * 0.45, full: () => 0 };
  function setSheet(stateName) {
    sheet.dataset.state = stateName;
    sheet.style.transform = `translateY(${SNAP[stateName]()}px)`;
  }
  (function dragSheet() {
    const grab = $('#sheet-grab');
    let startY, startT, moved;
    grab.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startT = SNAP[sheet.dataset.state]();
      moved = false;
      sheet.classList.add('dragging');
      grab.setPointerCapture(e.pointerId);
    });
    grab.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      sheet.style.transform = `translateY(${Math.max(0, Math.min(SNAP.peek(), startT + dy))}px)`;
    });
    const end = (e) => {
      if (startY == null) return;
      sheet.classList.remove('dragging');
      const y = startT + (e.clientY - startY);
      startY = null;
      if (!moved) return setSheet(sheet.dataset.state === 'peek' ? 'half' : 'peek');
      const best = Object.keys(SNAP).sort((a, b) => Math.abs(SNAP[a]() - y) - Math.abs(SNAP[b]() - y))[0];
      setSheet(best);
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => setSheet(sheet.dataset.state));
  })();

  /* ---------- rec pill / buttons ---------- */
  function renderRec() {
    const s = settings.get();
    const pill = $('#rec-pill');
    const on = s.tracking && geo.watching && !s.simLocation;
    pill.className = `rec-pill ${on ? 'on' : ''}`;
    setHtml(pill, on
      ? `<span class="rec-dot"></span> Recording route · ${todayTrack.length} pts today`
      : s.simLocation ? '🧪 Simulated location' : `${icon('rec')} Route recording off`);
  }
  function updateLocateBtn() {
    root.querySelector('[data-act="locate"]').classList.toggle('on', follow);
    root.querySelector('[data-act="layers"]').classList.toggle('on', !!settings.get().showAllPlaces);
  }

  // `auto` = silent refresh after walking a while: keep old results on screen, don't move the map.
  let nearbyRun = 0;
  async function runNearby(kind, { auto = false } = {}) {
    const run = ++nearbyRun;
    const origin = state.pos && state.nearCity ? state.pos : trip.center;
    nearby = auto ? { ...nearby, loading: true } : { kind, results: null, loading: !!kind, error: null, origin };
    if (!auto) { renderSheet(); renderMap(); }
    if (!kind) return;
    try {
      const results = await searchNearby(kind, origin);
      if (run !== nearbyRun) return; // user switched category meanwhile
      nearby = { kind, results, loading: false, error: null, origin };
      if (!auto && map && results.length) map.fit([origin, ...results.slice(0, 8)], mapPad());
    } catch (e) {
      if (run !== nearbyRun) return;
      nearby = auto ? { ...nearby, loading: false, origin } : { ...nearby, loading: false, error: e.message };
    }
    renderSheet();
    renderMap();
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act],[data-tab],[data-event],[data-place],[data-guide],[data-nearby],[data-checkin],[data-alert-act]');
    if (!el) return;
    const d = el.dataset;
    if (d.guide) {
      e.stopPropagation();
      ts.setTarget(d.guide);
      follow = true;
      setSheet('peek');
      return;
    }
    if (d.tab) {
      tab = d.tab;
      if (sheet.dataset.state === 'peek') setSheet('half');
      return renderSheet();
    }
    if (d.event) return openEvent(ctx, d.event);
    if (d.place) return openPlace(ctx, d.place);
    if (d.nearby !== undefined) return runNearby(d.nearby || null);
    if (d.checkin) {
      if (d.checkin === 'later') ts.snooze(`checkin:${d.id}`, ctx.now().getTime() + 2 * 36e5);
      else ts.setStatus(d.id, d.checkin);
      return;
    }
    if (d.alertAct) {
      const key = el.closest('.alert')?.dataset.key;
      const a = state.alerts.find((x) => x.key === key);
      if (d.alertAct === 'check') ts.toggle(d.id, true);
      if (d.alertAct === 'guide') { ts.setTarget(d.id); follow = true; }
      if (d.alertAct === 'go') ctx.go(d.id);
      if (d.alertAct === 'snooze') ts.snooze(key, ctx.now().getTime() + (a?.snoozeHours || 12) * 36e5);
      return;
    }
    switch (d.act) {
      case 'tips':
        if (state.tips) openPlace(ctx, state.tips.place, { reason: state.tips.reason });
        else toast('No tips for this spot. Enjoy wandering!');
        break;
      case 'layers':
        settings.set({ showAllPlaces: !settings.get().showAllPlaces });
        updateLocateBtn();
        renderMap();
        break;
      case 'locate':
        follow = true;
        updateLocateBtn();
        if (!state.pos) { geo.start(); toast(geo.error || 'Finding you…'); } else fitSmart(true);
        break;
      case 'rec':
        settings.set({ tracking: !settings.get().tracking });
        if (settings.get().tracking) geo.start();
        toast(settings.get().tracking ? 'Recording your route' : 'Route recording paused');
        renderRec();
        break;
      case 'clear-target':
        ts.setTarget(null);
        break;
      case 'alerts-more':
        alertsExpanded = !alertsExpanded;
        renderAlerts();
        break;
    }
  });

  /* ---------- lifecycle ---------- */
  loadWeather();
  setInterval(loadWeather, 30 * 60000);

  return {
    show() {
      ensureMap().then((m) => { m.resize(); });
      requestAnimationFrame(() => setSheet(sheet.dataset.state));
    },
    update(s) {
      state = s;
      if (nearby.kind && !nearby.loading && nearby.origin && s.pos && s.nearCity && distance(s.pos, nearby.origin) > 300) {
        runNearby(nearby.kind, { auto: true });
      }
      renderNow();
      renderAlerts();
      renderSheet();
      renderRec();
      updateLocateBtn();
      if (!map) return;
      renderMap();
      const tid = s.target?.id || null;
      const gotFirstFix = s.pos && s.nearCity && !hadFix;
      if (s.pos && s.nearCity) hadFix = true;
      if (!initialFitDone || (gotFirstFix && follow)) fitSmart(true);
      else if (follow && s.pos) {
        if (tid !== lastTargetId) fitSmart();
        else if (!map.contains(s.pos)) map.panTo(s.pos);
      }
      lastTargetId = tid;
    },
    onTrack: loadTrackSoon,
    reloadTrack: loadTrack,
  };
}
