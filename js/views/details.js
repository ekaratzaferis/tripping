// Detail sheets shared by the Live and Plan views: an event, and a place
// (the "tips" overlay: things not to miss, good to know, directions).
import { resolvePlace, eventPlaces, hasCoords } from '../trip.js';
import { esc, cat, fmtDate, fmtTime, fmtDist, distance, directionsUrl, travelEstimate, fmtDuration } from '../util.js';
import { icon, modal, toast } from '../ui.js';

// Booking numbers (locators, confirmations): big, tap to copy.
export function refsHtml(refs) {
  if (!refs?.length) return '';
  return `<div class="refs">${refs.map((r) => `<button class="ref" data-copy="${esc(r.value)}" title="Tap to copy">
    <small>${esc(r.label)}</small><b>${esc(r.value)}</b></button>`).join('')}</div>`;
}

export function wireCopy(el) {
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast(b.dataset.copy); }
  });
}

export const KIND_LABEL = {
  fixed: 'Fixed · booked or timed', free: 'Free roam', transfer: 'Transfer', logistics: 'Logistics', meal: 'Food',
};

function tipsHtml(place) {
  const t = place.tips || {};
  let html = '';
  if (t.dontMiss?.length) {
    html += `<h4 class="tips-h">Don't miss</h4><ol class="tips-list must">${t.dontMiss.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`;
  }
  if (t.goodToKnow?.length) {
    html += `<h4 class="tips-h">Good to know</h4><ul class="tips-list">${t.goodToKnow.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }
  return html;
}

export function openPlace(ctx, placeOrId, { reason } = {}) {
  const place = typeof placeOrId === 'string' ? resolvePlace(ctx.trip, placeOrId) : placeOrId;
  if (!place) return;
  const c = cat(place.category);
  const pos = ctx.state?.pos;
  const d = pos && hasCoords(place) ? distance(pos, place) : null;
  const eta = d != null && d < 60000 ? travelEstimate(d) : null;
  const isTarget = ctx.ts.target()?.placeId === place.id;
  const body = tipsHtml(place);
  modal(`
    <div class="sheet-head" style="--accent:${c.color}">
      <div class="sheet-emoji">${c.emoji}</div>
      <div>
        <div class="eyebrow">${esc(reason || c.label)}</div>
        <h2>${esc(place.name)}</h2>
        ${place.address ? `<div class="muted small">${esc(place.address)}</div>` : ''}
        ${d != null ? `<div class="chip-row"><span class="chip">${icon('pin')} ${fmtDist(d)}</span>${eta ? `<span class="chip">${icon('clock')} ~${fmtDuration(eta.mins)} ${eta.mode === 'walk' ? 'walk' : 'by metro/taxi'}</span>` : ''}</div>` : ''}
      </div>
    </div>
    ${refsHtml(place.refs)}
    ${body || `<p class="muted">No tips saved for this place yet. Wander and enjoy.</p>`}
    ${place.missing ? `<p class="callout">Set your hotel's location in Settings to navigate here.</p>` : ''}
    <div class="btn-row">
      ${hasCoords(place) ? `<button class="btn primary" data-act="target">${icon('nav')} ${isTarget ? 'Stop guiding' : 'Guide me here'}</button>
      <a class="btn" href="${directionsUrl(place)}" target="_blank" rel="noopener">${icon('external')} Google Maps</a>` : ''}
      ${place.phone ? `<a class="btn ghost" href="tel:${esc(place.phone.replace(/\s+/g, ''))}">${icon('phone')} Call</a>` : ''}
      ${place.url ? `<a class="btn ghost" href="${esc(place.url)}" target="_blank" rel="noopener">${icon('info')} Website</a>` : ''}
    </div>`, {
    cls: 'place-sheet',
    onMount(el, close) {
      wireCopy(el);
      el.querySelector('[data-act="target"]')?.addEventListener('click', () => {
        ctx.ts.setTarget(isTarget ? null : place.id);
        close();
        if (!isTarget) ctx.go('live');
      });
    },
  });
}

export function openEvent(ctx, eventId) {
  const { trip, ts } = ctx;
  const e = trip.eventById[eventId];
  if (!e) return;
  const tz = trip.timezone;
  const status = ts.status(e.id);
  const places = eventPlaces(trip, e);
  const booking = e.booking ? trip.itemById[e.booking] : null;
  const booked = booking && ts.checked(booking.id);
  const visits = ts.visits();

  modal(`
    <div class="event-head kind-${e.kind}">
      <div class="eyebrow">${esc(fmtDate(e.startD, tz, { weekday: 'long', day: 'numeric', month: 'long' }))} · ${esc(e.label || fmtTime(e.startD, tz))}</div>
      <h2>${esc(e.title)}</h2>
      <div class="chip-row">
        <span class="chip kind">${esc(KIND_LABEL[e.kind] || e.kind)}</span>
        ${e.optional ? '<span class="chip">Optional</span>' : ''}
        ${booking ? `<span class="chip ${booked ? 'ok' : 'bad'}">${booked ? '✓ Booked' : '✗ Not booked yet'}</span>` : ''}
        ${status ? `<span class="chip ${status === 'done' ? 'ok' : ''}">${status === 'done' ? '✓ Done' : 'Skipped'}</span>` : ''}
      </div>
    </div>
    ${refsHtml(e.refs)}
    ${e.description ? `<p class="lead">${esc(e.description)}</p>` : ''}
    ${places.length ? `<h4 class="tips-h">${e.stops?.length ? 'Stops' : 'Where'}</h4>
      <div class="place-list">${places.map((p) => {
        const c = cat(p.category);
        const v = visits[p.id];
        const seen = v && v.last >= e.startD - 18e5 && v.first <= +e.endD + 18e5;
        return `<button class="place-row" data-place="${esc(p.id)}">
          <span class="place-emoji" style="--accent:${c.color}">${c.emoji}</span>
          <span class="grow"><b>${esc(p.name)}</b><small>${p.missing ? 'Location not set' : esc(c.label)}${seen ? ` · visited ${fmtTime(new Date(v.first), tz)}` : ''}</small></span>
          ${seen ? '<span class="tick">✓</span>' : icon('chevron')}
        </button>`;
      }).join('')}</div>` : ''}
    ${booking ? `<div class="callout">${icon('ticket')} <div><b>${esc(booking.title)}</b>${booking.price ? ` · ${esc(booking.price)}` : ''}<br><span class="muted small">${esc(booking.note || '')}</span>
      <div class="btn-row tight">${booking.url ? `<a class="btn small" href="${esc(booking.url)}" target="_blank" rel="noopener">${icon('external')} Book</a>` : ''}
      <button class="btn small ${booked ? 'ghost' : 'primary'}" data-act="book">${booked ? 'Mark not booked' : 'Mark booked'}</button></div></div></div>` : ''}
    <div class="btn-row">
      <button class="btn ${status === 'done' ? 'ghost' : 'primary'}" data-status="${status === 'done' ? '' : 'done'}">${icon('check')} ${status === 'done' ? 'Undo done' : 'Mark done'}</button>
      <button class="btn" data-status="${status === 'skipped' ? '' : 'skipped'}">${status === 'skipped' ? 'Unskip' : 'Skip it'}</button>
      ${places.some(hasCoords) ? `<button class="btn ghost" data-act="map">${icon('map')} On the map</button>` : ''}
    </div>`, {
    onMount(el, close) {
      wireCopy(el);
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b || b.dataset.copy) return;
        if (b.dataset.place) { openPlace(ctx, b.dataset.place, { reason: e.title }); return; }
        if (b.dataset.status !== undefined) { ts.setStatus(e.id, b.dataset.status || null); close(); return; }
        if (b.dataset.act === 'book') { ts.toggle(booking.id); openEvent(ctx, eventId); return; }
        if (b.dataset.act === 'map') {
          const first = places.find(hasCoords);
          ts.setTarget(first.id);
          close();
          ctx.go('live');
        }
      });
    },
  });
}
