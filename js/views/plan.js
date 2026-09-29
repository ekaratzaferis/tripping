// Plan view: day-by-day itinerary (fixed = dark, free roam = light), plus the
// guide, budget and useful links from the trip config.
import { resolvePlace } from '../trip.js';
import { esc, cat, fmtTime } from '../util.js';
import { icon, mosaicUrl } from '../ui.js';
import { openEvent, openPlace, KIND_LABEL } from './details.js';
import { activeDayKey } from '../engine.js';

export function createPlanView(root, ctx) {
  const { trip, ts } = ctx;
  const tz = trip.timezone;
  let day = null;

  function render() {
    const now = ctx.now();
    day ||= activeDayKey(trip, now);
    const d = trip.days.find((x) => x.date === day) || trip.days[0];
    const scroll = root.scrollTop;
    root.innerHTML = `
      <header class="hero" style="--mosaic:${mosaicUrl({ seed: 11 })}">
        <div class="hero-inner">
          <div class="eyebrow light">${esc(trip.kicker || '')}</div>
          <h1>${esc(trip.title)}</h1>
          <p>${esc(trip.subtitle || '')}</p>
          <div class="hero-facts">${(trip.facts || []).slice(0, 3).map((f) => `<span>${esc(f)}</span>`).join('')}</div>
        </div>
      </header>
      <div class="page">
        <div class="day-tabs" role="tablist">${trip.days.map((x) => {
          const [, , dd] = x.date.split('-');
          const done = x.events.filter((e) => ts.status(e.id)).length;
          return `<button class="day-tab ${x.date === d.date ? 'on' : ''}" data-day="${x.date}">
            <span class="dow">${esc(x.name.slice(0, 3))}</span><span class="dnum">${+dd}</span>
            <span class="dprog"><i style="width:${(done / Math.max(1, x.events.length)) * 100}%"></i></span></button>`;
        }).join('')}</div>

        <div class="day-head">
          <h2>${esc(d.name)}</h2>
          <p>${esc(d.theme || '')}</p>
        </div>

        <div class="timeline">${d.events.map((e) => eventCard(e, now)).join('')}</div>

        <div class="legend"><span class="lg fixed"></span> Fixed: booked or timed, keep these <span class="lg free"></span> Free roam: suggestions, follow your mood</div>

        ${guideHtml()}
      </div>`;
    root.scrollTop = scroll;
  }

  function eventCard(e, now) {
    const st = ts.status(e.id);
    const isNow = e.startD <= now && now < e.endD;
    const booking = e.booking ? trip.itemById[e.booking] : null;
    const booked = booking && ts.checked(booking.id);
    const place = resolvePlace(trip, e.place);
    const stops = (e.stops || []).filter((id) => id !== e.place).map((id) => resolvePlace(trip, id)).filter(Boolean);
    return `<article class="ev kind-${e.kind} st-${st || 'open'} ${isNow ? 'is-now' : ''}" data-event="${e.id}" tabindex="0">
      <div class="ev-time">${esc(e.label || fmtTime(e.startD, tz))}</div>
      <div class="ev-card">
        <div class="ev-top">
          <span class="ev-kind">${esc(KIND_LABEL[e.kind] || e.kind)}${e.optional ? ' · optional' : ''}</span>
          ${isNow ? '<span class="now-tag">Now</span>' : ''}
          ${st === 'done' ? '<span class="st-tag ok">✓ Done</span>' : st === 'skipped' ? '<span class="st-tag">Skipped</span>' : ''}
        </div>
        <h3>${esc(e.title)}</h3>
        ${e.description ? `<p>${esc(e.description)}</p>` : ''}
        <div class="ev-foot">
          ${place && !stops.length ? `<button class="place-chip" data-place="${esc(place.id)}">${cat(place.category).emoji} ${esc(place.name)}</button>` : ''}
          ${stops.map((p) => `<button class="place-chip" data-place="${esc(p.id)}">${cat(p.category).emoji} ${esc(p.name)}</button>`).join('')}
          ${booking ? bookChip(booking, booked) : ''}
        </div>
      </div>
    </article>`;
  }

  function bookChip(item, booked) {
    const onSite = item.tone === 'calm';
    const label = booked ? (onSite ? 'Sorted' : 'Booked') : onSite ? 'Buy there' : 'Not booked';
    return `<span class="book-chip ${booked ? 'ok' : onSite ? 'todo' : 'bad'}">${icon('ticket')} ${label}</span>`;
  }

  function guideHtml() {
    const b = trip.budget;
    return `
      <section class="block">
        <h2 class="block-h">Live like a local</h2>
        <div class="guide-grid">${trip.guide.map((g, i) => `
          <div class="guide-card" style="--tile:${['#DA121A', '#004D98', '#FCDD09', '#A50044', '#0098D8', '#111114'][i % 6]}">
            <h4>${esc(g.title)}</h4><p>${esc(g.text)}</p></div>`).join('')}</div>
      </section>
      ${b ? `<section class="block">
        <h2 class="block-h">Rough ticket budget <small>per person</small></h2>
        <div class="budget">${b.rows.map((r) => `<div class="b-row"><span>${esc(r.item)}<small>${esc(r.note || '')}</small></span><b>${esc(r.cost)}</b></div>`).join('')}
        ${b.total ? `<div class="b-row total"><span>${esc(b.total.item)}<small>${esc(b.total.note || '')}</small></span><b>${esc(b.total.cost)}</b></div>` : ''}</div>
      </section>` : ''}
      <section class="block">
        <h2 class="block-h">Useful links</h2>
        <div class="links">${trip.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${icon('external')} ${esc(l.label)} <small>${esc(l.url.replace(/^https?:\/\//, ''))}</small></a>`).join('')}
        ${trip.emergency ? `<a class="sos" href="tel:${esc(trip.emergency)}">${icon('phone')} Emergencies <b>${esc(trip.emergency)}</b></a>` : ''}</div>
      </section>
      <p class="fineprint">${esc((trip.facts || []).slice(3).join(' · '))}</p>`;
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-day],[data-place],[data-event]');
    if (!t) return;
    if (t.dataset.day) { day = t.dataset.day; render(); root.querySelector('.day-head')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    if (t.dataset.place) { e.stopPropagation(); openPlace(ctx, t.dataset.place); return; }
    if (t.dataset.event) openEvent(ctx, t.dataset.event);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset?.event) openEvent(ctx, e.target.dataset.event);
  });

  return { show: render, update: render };
}
