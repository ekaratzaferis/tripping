// Checklists: things to prebook and things to pack. Items come from the trip
// config; ticks, extra items and removed items live in localStorage.
import { esc, uid, fmtDate, fmtTime } from '../util.js';
import { icon, toast } from '../ui.js';
import { placesPanelHtml, wirePlacesPanel } from './places.js';

export function createListsView(root, ctx) {
  // Only touch the DOM when the markup changed, so a tap is never lost to a redraw.
  const setPage = (html) => { if (root._html === html) return false; root._html = html; root.innerHTML = html; return true; };
  const { trip, ts } = ctx;
  let listId = trip.checklists[0]?.id;
  let focusGroup = null;

  function items(list, group) {
    const hidden = ts.hidden();
    const base = (group.items || []).filter((i) => !hidden[i.id]).map((i) => ({ ...i, builtin: true }));
    const extra = ts.customItems().filter((i) => i.list === list.id && i.group === group.id && !hidden[i.id]);
    return [...base, ...extra];
  }

  function progress(list) {
    const all = list.groups.flatMap((g) => items(list, g));
    const done = all.filter((i) => ts.checked(i.id)).length;
    return { done, total: all.length };
  }

  function ring(p, size = 54) {
    const r = size / 2 - 5;
    const c = 2 * Math.PI * r;
    const f = p.total ? p.done / p.total : 0;
    return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}"/>
      <text x="50%" y="53%" dominant-baseline="middle" text-anchor="middle">${Math.round(f * 100)}%</text></svg>`;
  }

  let placeFilter = '';
  const tabsHtml = (activeId) => `<div class="seg big">${trip.checklists.map((l) => {
    const p = progress(l);
    return `<button data-list="${l.id}" class="${l.id === activeId ? 'on' : ''}">${icon(l.icon || 'list')} ${esc(l.title)} <small>${p.done}/${p.total}</small></button>`;
  }).join('')}<button data-list="places" class="${activeId === 'places' ? 'on' : ''}">${icon('pin')} Places</button></div>`;

  function renderPlaces() {
    const scroll = root.scrollTop;
    const replaced = setPage(`<div class="page">
      <header class="page-head"><h1>Lists</h1>${tabsHtml('places')}</header>
      <div id="places-panel">${placesPanelHtml(ctx, placeFilter)}</div>
    </div>`);
    // Wire only freshly created DOM, or handlers would stack up.
    if (replaced) wirePlacesPanel(root.querySelector('#places-panel'), ctx, (v) => { placeFilter = v; });
    root.scrollTop = scroll;
  }

  function render() {
    if (listId === 'places') return renderPlaces();
    const list = trip.checklists.find((l) => l.id === listId) || trip.checklists[0];
    if (!list) { root.innerHTML = '<div class="page"><p>No checklists in this trip.</p></div>'; return; }
    const scroll = root.scrollTop;
    const tz = trip.timezone;
    setPage(`<div class="page">
      <header class="page-head">
        <h1>Lists</h1>
        ${tabsHtml(list.id)}
      </header>
      <div class="list-summary">${ring(progress(list))}
        <div><b>${progress(list).done === progress(list).total ? 'All done. Nice!' : `${progress(list).total - progress(list).done} to go`}</b>
        <div class="muted small">Tap to cross out. Add your own at the bottom of each group.</div></div>
      </div>
      ${list.groups.map((g) => `
        <section class="check-group tone-${g.tone || 'calm'}">
          <h3>${esc(g.title)}${g.suggested ? ' <span class="pill">suggested</span>' : ''}</h3>
          <ul class="checks">${items(list, g).map((i) => {
            const on = ts.checked(i.id);
            const ev = i.event && trip.eventById[i.event];
            return `<li class="check ${on ? 'on' : ''}">
              <button class="check-box" data-toggle="${esc(i.id)}" aria-pressed="${on}" aria-label="Toggle ${esc(i.title)}">${icon('check')}</button>
              <div class="check-main" data-toggle="${esc(i.id)}">
                <div class="check-title">${esc(i.title)}${i.optional ? ' <span class="pill">optional</span>' : ''}${i.price ? ` <span class="price">${esc(i.price)}</span>` : ''}</div>
                ${i.note ? `<div class="check-note">${esc(i.note)}</div>` : ''}
                ${(i.refs || []).map((r) => `<button class="ref-inline" data-copy="${esc(r.value)}">${esc(r.label)}: <b>${esc(r.value)}</b></button>`).join('')}
                ${ev ? `<div class="check-for">${icon('clock')} for ${esc(fmtDate(ev.startD, tz))} ${esc(fmtTime(ev.startD, tz))}</div>` : ''}
              </div>
              <div class="check-actions">
                ${i.url ? `<a class="icon-btn" href="${esc(i.url)}" target="_blank" rel="noopener" aria-label="Open website">${icon('external')}</a>` : ''}
                <button class="icon-btn subtle" data-remove="${esc(i.id)}" aria-label="Remove">${icon('trash')}</button>
              </div>
            </li>`;
          }).join('')}</ul>
          <form class="add-item" data-group="${g.id}">
            <input name="title" placeholder="Add to ${esc(g.title.toLowerCase())}…" autocomplete="off" />
            <button class="icon-btn" aria-label="Add">${icon('plus')}</button>
          </form>
        </section>`).join('')}
      ${Object.keys(ts.hidden()).length ? `<button class="link-btn center" data-restore>Restore removed items (${Object.keys(ts.hidden()).length})</button>` : ''}
    </div>`);
    root.scrollTop = scroll;
    if (focusGroup) {
      root.querySelector(`form[data-group="${focusGroup}"] input`)?.focus();
      focusGroup = null;
    }
  }

  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) {
      navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Copied'), () => toast(c.dataset.copy));
      return;
    }
    const t = e.target.closest('[data-list],[data-toggle],[data-remove],[data-restore]');
    if (!t) return;
    if (t.dataset.list) { listId = t.dataset.list; render(); return; }
    if (t.dataset.toggle) { ts.toggle(t.dataset.toggle); if (navigator.vibrate) navigator.vibrate(8); return; }
    if (t.dataset.remove) {
      const id = t.dataset.remove;
      if (confirm('Remove this item? You can restore removed items at the bottom of the page.')) ts.removeItem(id);
      return;
    }
    if (t.dataset.restore !== undefined) ts.restoreHidden();
  });
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return;
    focusGroup = f.dataset.group;
    ts.addItem({ id: `c-${uid()}`, list: listId, group: f.dataset.group, title });
  });

  return { show: render, update: render };
}
