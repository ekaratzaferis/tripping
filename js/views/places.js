// Places of interest: list, add, edit, hide. Edits live on this device
// (trip state "placeEdits") and are merged over the trip file's places.
import { esc, cat, CATEGORY, distance, fmtDist, uid } from '../util.js';
import { icon, modal, toast } from '../ui.js';
import { geocode } from '../services.js';
import { geo } from '../geo.js';
import { openPlace } from './details.js';

const EDITABLE_CATEGORIES = Object.keys(CATEGORY).filter((c) => !['airport', 'hotel'].includes(c));

const getEdits = (ts) => ts.get('placeEdits', {});
function saveEdit(ts, id, patch) {
  const all = getEdits(ts);
  all[id] = { ...(all[id] || {}), ...patch };
  ts.set('placeEdits', all);
}
function dropEdit(ts, id) {
  const all = getEdits(ts);
  delete all[id];
  ts.set('placeEdits', all);
}

export function openPlaceEditor(ctx, id, draft) {
  const { trip, ts } = ctx;
  const isNew = !id;
  const current = id ? trip.places[id] : null;
  const original = id ? trip.basePlaces?.[id] : null;
  const d = draft || {
    name: current?.name || '', category: current?.category || 'landmark', note: current?.note || '',
    lat: current?.lat, lng: current?.lng,
  };
  let results = null;

  const render = () => `
    <div class="eyebrow">${isNew ? 'New place of interest' : 'Edit place'}</div>
    <h2>${isNew ? 'Add a place' : esc(current?.name || '')}</h2>
    <form class="place-form" autocomplete="off">
      <label>Name<input name="name" value="${esc(d.name)}" placeholder="e.g. Bar Mut" required></label>
      <label>Type<select name="category">${EDITABLE_CATEGORIES.map((c) => `<option value="${c}" ${c === d.category ? 'selected' : ''}>${cat(c).emoji} ${cat(c).label}</option>`).join('')}</select></label>
      <label>Your note<textarea name="note" rows="2" placeholder="Why go, what to order, opening hours…">${esc(d.note || '')}</textarea></label>
      <div class="loc-box">
        <div class="loc-now">${isFinite(d.lat) ? `${icon('pin')} <b>${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}</b>` : '<span class="muted">No location yet</span>'}</div>
        <div class="row-form">
          <input name="q" placeholder="Search an address or name">
          <button type="button" class="btn small" data-pe="search">Search</button>
        </div>
        ${results ? `<div class="geo-results">${results.length ? results.map((r, i) => `<button type="button" class="place-row" data-pe-pick="${i}"><span class="grow small">${esc(r.name)}</span>${icon('chevron')}</button>`).join('') : '<div class="muted small">No results.</div>'}</div>` : ''}
        <div class="btn-row tight">
          <button type="button" class="btn small ghost" data-pe="here">${icon('locate')} My location</button>
          <button type="button" class="btn small ghost" data-pe="map">${icon('pin')} Tap on map</button>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary">${icon('check')} Save</button>
        ${!isNew ? `<button type="button" class="btn danger" data-pe="delete">${icon('trash')} ${original ? 'Hide' : 'Delete'}</button>` : ''}
        ${!isNew && original && getEdits(ts)[id] ? '<button type="button" class="btn ghost" data-pe="reset">Reset to original</button>' : ''}
      </div>
    </form>`;

  modal(render(), {
    onMount(el, close) {
      const form = () => el.querySelector('form');
      const readForm = () => {
        const f = form();
        Object.assign(d, { name: f.name.value.trim(), category: f.category.value, note: f.note.value.trim() });
      };
      const rerender = () => { readForm(); el.innerHTML = render(); };

      el.addEventListener('submit', (e) => {
        e.preventDefault();
        readForm();
        if (!d.name) return toast('Give it a name');
        if (!isFinite(d.lat)) return toast('Set a location first');
        const patch = { name: d.name, category: d.category, note: d.note, lat: d.lat, lng: d.lng };
        if (isNew) saveEdit(ts, `u-${uid()}`, { ...patch, custom: true });
        else saveEdit(ts, id, original ? patch : { ...patch, custom: true });
        toast(isNew ? 'Place added' : 'Place saved');
        close();
      });

      el.addEventListener('click', async (e) => {
        const pick = e.target.closest('[data-pe-pick]');
        if (pick) {
          const r = results[+pick.dataset.pePick];
          readForm();
          Object.assign(d, { lat: r.lat, lng: r.lng, name: d.name || r.name.split(',')[0] });
          results = null;
          el.innerHTML = render();
          return;
        }
        const b = e.target.closest('[data-pe]');
        if (!b) return;
        switch (b.dataset.pe) {
          case 'search': {
            const q = form().q.value.trim() || form().name.value.trim();
            if (!q) return toast('Type an address or name');
            try { results = await geocode(q, trip.center); } catch { toast('Search failed. Are you online?'); results = null; }
            rerender();
            break;
          }
          case 'here': {
            const p = geo.pos;
            if (!p) { geo.start(); return toast('No location yet. Try again in a moment.'); }
            readForm();
            Object.assign(d, { lat: p.lat, lng: p.lng });
            el.innerHTML = render();
            break;
          }
          case 'map':
            readForm();
            close();
            ctx.pickOnMap('place', (p) => openPlaceEditor(ctx, id, { ...d, lat: p.lat, lng: p.lng }));
            break;
          case 'delete':
            if (!confirm(original ? 'Hide this place? You can restore hidden places from the Places list.' : 'Delete this place?')) return;
            if (original) saveEdit(ts, id, { hidden: true }); else dropEdit(ts, id);
            close();
            break;
          case 'reset':
            dropEdit(ts, id);
            close();
            break;
        }
      });
    },
  });
}

// The "Places" tab inside Lists.
export function placesPanelHtml(ctx, filter = '') {
  return `
    <div class="places-head">
      <input type="search" data-p-filter placeholder="Filter places…" value="${esc(filter)}">
      <button class="btn small primary" data-p-add>${icon('plus')} Add place</button>
    </div>
    <div class="places-body">${placesBodyHtml(ctx, filter)}</div>`;
}

export function placesBodyHtml(ctx, filter = '') {
  const { trip, ts } = ctx;
  const pos = ctx.state?.pos && ctx.state?.nearCity ? ctx.state.pos : null;
  const q = filter.trim().toLowerCase();
  const list = Object.entries(trip.places)
    .filter(([, p]) => p.category !== 'airport' && (!q || p.name.toLowerCase().includes(q)))
    .map(([id, p]) => ({ id, ...p, dist: pos ? distance(pos, p) : null }))
    .sort((a, b) => (pos ? a.dist - b.dist : a.name.localeCompare(b.name)));
  const hidden = Object.values(getEdits(ts)).filter((e) => e.hidden).length;
  return `
    <div class="muted small pad-b">${list.length} places${pos ? ', closest first' : ''}. They show on the map when you're within ~700 m.</div>
    <div class="checks places-list">${list.map((p) => {
      const c = cat(p.category);
      return `<div class="place-row" data-p-open="${esc(p.id)}">
        <span class="place-emoji" style="--accent:${c.color}">${c.emoji}</span>
        <span class="grow"><b>${p.must ? '⭐ ' : ''}${esc(p.name)}</b><small>${esc(c.label)}${p.dist != null ? ` · ${fmtDist(p.dist)}` : ''}${p.custom ? ' · added by you' : p.edited ? ' · edited' : ''}${p.note ? ` · ${esc(p.note.slice(0, 40))}${p.note.length > 40 ? '…' : ''}` : ''}</small></span>
        <button class="icon-btn" data-p-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">${icon('edit')}</button>
      </div>`;
    }).join('')}</div>
    ${hidden ? `<button class="link-btn center" data-p-restore>Restore hidden places (${hidden})</button>` : ''}`;
}

export function wirePlacesPanel(el, ctx, onFilter) {
  el.addEventListener('input', (e) => {
    if (!e.target.matches('[data-p-filter]')) return;
    onFilter(e.target.value);
    el.querySelector('.places-body').innerHTML = placesBodyHtml(ctx, e.target.value);
  });
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-p-add],[data-p-edit],[data-p-open],[data-p-restore]');
    if (!t) return;
    if (t.dataset.pAdd !== undefined) return openPlaceEditor(ctx, null);
    if (t.dataset.pEdit) { e.stopPropagation(); return openPlaceEditor(ctx, t.dataset.pEdit); }
    if (t.dataset.pOpen) return openPlace(ctx, t.dataset.pOpen);
    if (t.dataset.pRestore !== undefined) {
      const all = getEdits(ctx.ts);
      for (const [id, e] of Object.entries(all)) if (e.hidden) { delete e.hidden; if (!Object.keys(e).length) delete all[id]; }
      ctx.ts.set('placeEdits', all);
    }
  });
}
