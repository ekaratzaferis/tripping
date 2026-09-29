// Map adapter with one small API over two providers:
//  • Google Maps (flat 2D roadmap) when an API key is set in Settings.
//  • Otherwise MapLibre GL + OpenFreeMap vector tiles (free, no key), repainted
//    with Google Maps' palette so it looks and reads the same.
// Markers are plain HTML so both providers look identical.
import { settings } from './store.js';
import { bus, esc, cat } from './util.js';

const dark = () => {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === 'dark' : !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
};

let googlePromise;
function loadGoogle(key) {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  return (googlePromise ||= new Promise((resolve, reject) => {
    window.__triparwGmReady = () => resolve(window.google.maps);
    window.gm_authFailure = () => bus.emit('toast', 'Google Maps rejected the API key. Check it in Settings.');
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__triparwGmReady`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.append(s);
    setTimeout(() => reject(new Error('Google Maps timed out')), 15000);
  }));
}

// Safety net on top of Google's own quotas: after this many Google map loads
// in a day (on this device) we switch to the free map until tomorrow.
const DAILY_GOOGLE_LOADS = 250;
function takeGoogleLoad() {
  const today = new Date().toISOString().slice(0, 10);
  let c;
  try { c = JSON.parse(localStorage.getItem('triparw:gmLoads') || '{}'); } catch { c = {}; }
  if (c.day !== today) c = { day: today, n: 0 };
  if (c.n >= DAILY_GOOGLE_LOADS) return false;
  c.n++;
  try { localStorage.setItem('triparw:gmLoads', JSON.stringify(c)); } catch { /* ignore */ }
  return true;
}

export async function createMap(el, opts) {
  const key = settings.get().gmapsKey?.trim();
  if (key && !takeGoogleLoad()) {
    bus.emit('toast', 'Daily Google Maps limit reached, using the free map until tomorrow.');
  } else if (key) {
    try {
      return skipUnchanged(googleMap(await loadGoogle(key), el, opts));
    } catch (e) {
      console.warn(e);
      bus.emit('toast', 'Google Maps unavailable, using the free map instead.');
    }
  }
  return skipUnchanged(await vectorMap(el, opts));
}

// Every map created on the page. Google bills per map *created*, so we never
// recreate one: theme changes restyle these in place.
const liveMaps = [];
export function restyleMaps() {
  liveMaps.forEach((m) => m.setTheme?.());
}

// Views redraw on every GPS tick. Recreating identical markers would drop a
// tap that lands mid-redraw, so only touch a layer when its content changed.
function skipUnchanged(api) {
  const last = {};
  const same = (k, v) => { if (last[k] === v) return true; last[k] = v; return false; };
  const { setMarkers, setLines } = api;
  api.setMarkers = (name, items) => {
    if (!same(`m:${name}`, JSON.stringify(items.map((i) => [i.lat, i.lng, i.html, i.z, i.title])))) setMarkers(name, items);
  };
  api.setLines = (name, segs) => {
    if (!same(`l:${name}`, JSON.stringify(segs))) setLines(name, segs);
  };
  liveMaps.push(api);
  return api;
}

/* ---------- marker HTML ---------- */
export function userHtml() {
  return `<div class="mk-me"><div class="mk-me-halo"></div><div class="mk-me-heading"></div><div class="mk-me-dot"></div></div>`;
}
export function pinHtml({ category, label, active, done, small, emoji }) {
  const c = cat(category);
  const cls = ['mk-pin', active && 'is-active', done && 'is-done', small && 'is-small'].filter(Boolean).join(' ');
  return `<div class="${cls}" style="--pin:${c.color}">
    <div class="mk-pin-body"><span>${esc(emoji || label || c.emoji)}</span></div>
    ${active ? '<div class="mk-pin-pulse"></div>' : ''}
  </div>`;
}
export function dotHtml(color, text = '') {
  return `<div class="mk-dot" style="--dot:${color}">${esc(text)}</div>`;
}

function applyHeading(root, heading) {
  const h = root?.querySelector?.('.mk-me-heading');
  if (!h) return;
  h.style.display = heading == null ? 'none' : 'block';
  if (heading != null) h.style.transform = `translate(-50%, -100%) rotate(${heading}deg)`;
}

const padObj = (pad) => (typeof pad === 'number' ? { top: pad, right: pad, bottom: pad, left: pad } : pad);

/* ---------- Google-like palette for the vector fallback ---------- */
const PALETTE = {
  light: {
    land: '#F1F3F4', park: '#C3ECD2', wood: '#B8E3C6', water: '#9CC0F9', waterLabel: '#3E73C4',
    sand: '#F6EFD9', hospital: '#FCE8E6', school: '#EEF0F4', airport: '#E8EAED',
    building: '#E6E7EA', buildingLine: '#D9DBDF',
    road: '#FFFFFF', roadCase: '#DADCE0', major: '#FFFFFF', majorCase: '#D2D5DA',
    motorway: '#FDE293', motorwayCase: '#F2C94C', path: '#D5D8DC', rail: '#BDC1C6',
    label: '#5F6368', placeLabel: '#3C4043', halo: '#FFFFFF', boundary: '#9AA0A6',
  },
  dark: {
    land: '#1F2430', park: '#1F3A2C', wood: '#1C3428', water: '#17324D', waterLabel: '#7FA7D9',
    sand: '#2A2A26', hospital: '#2E2428', school: '#252A36', airport: '#262C38',
    building: '#2A303C', buildingLine: '#323948',
    road: '#3A4150', roadCase: '#2A303C', major: '#485062', majorCase: '#2F3544',
    motorway: '#6B5A2E', motorwayCase: '#554722', path: '#3A4150', rail: '#4A5160',
    label: '#AEB4BE', placeLabel: '#D5D9E0', halo: '#1F2430', boundary: '#5F6673',
  },
};

let styleCache;
async function googleLikeStyle() {
  const mode = dark() ? 'dark' : 'light';
  if (styleCache?.mode === mode) return structuredClone(styleCache.style);
  const style = await (await fetch('https://tiles.openfreemap.org/styles/liberty')).json();
  const c = PALETTE[mode];
  const setPaint = (l, k, v) => { if (v !== undefined) (l.paint ||= {})[k] = v; };
  const setText = (l, color, halo = c.halo) => {
    setPaint(l, 'text-color', color);
    setPaint(l, 'text-halo-color', halo);
    setPaint(l, 'text-halo-width', 1.4);
  };

  style.layers = style.layers.filter((l) => l.type !== 'fill-extrusion' && l.id !== 'natural_earth' && !/^poi_r20$|shield/.test(l.id));
  for (const l of style.layers) {
    const id = l.id;
    if (id === 'background') setPaint(l, 'background-color', c.land);
    else if (id === 'park') { setPaint(l, 'fill-color', c.park); setPaint(l, 'fill-opacity', 1); }
    else if (id === 'park_outline') l.layout = { ...l.layout, visibility: 'none' };
    else if (id === 'landcover_wood' || id === 'landcover_grass') { setPaint(l, 'fill-color', c.wood); setPaint(l, 'fill-opacity', 0.9); }
    else if (id === 'landuse_residential') setPaint(l, 'fill-opacity', 0);
    else if (id === 'landuse_hospital') setPaint(l, 'fill-color', c.hospital);
    else if (id === 'landuse_school') setPaint(l, 'fill-color', c.school);
    else if (id === 'landuse_pitch' || id === 'landuse_track') setPaint(l, 'fill-color', c.park);
    else if (id === 'landuse_cemetery') setPaint(l, 'fill-color', c.wood);
    else if (id === 'landcover_sand') setPaint(l, 'fill-color', c.sand);
    else if (id === 'water') setPaint(l, 'fill-color', c.water);
    else if (id.startsWith('waterway') && l.type === 'line') setPaint(l, 'line-color', c.water);
    else if (id === 'aeroway_fill') setPaint(l, 'fill-color', c.airport);
    else if (id.startsWith('aeroway') && l.type === 'line') setPaint(l, 'line-color', c.major);
    else if (id === 'building') { setPaint(l, 'fill-color', c.building); setPaint(l, 'fill-outline-color', c.buildingLine); }
    else if (l['source-layer'] === 'transportation' && l.type === 'line') {
      const casing = id.includes('casing');
      if (/rail/.test(id)) setPaint(l, 'line-color', c.rail);
      else if (/path_pedestrian/.test(id)) setPaint(l, 'line-color', casing ? c.roadCase : c.path);
      else if (/motorway/.test(id)) setPaint(l, 'line-color', casing ? c.motorwayCase : c.motorway);
      else if (/trunk_primary|secondary_tertiary/.test(id)) setPaint(l, 'line-color', casing ? c.majorCase : c.major);
      else setPaint(l, 'line-color', casing ? c.roadCase : c.road);
    } else if (id === 'road_area_pattern') l.layout = { ...l.layout, visibility: 'none' };
    else if (id.startsWith('boundary')) setPaint(l, 'line-color', c.boundary);
    else if (l.type === 'symbol') {
      if (id.startsWith('water') ) setText(l, c.waterLabel);
      else if (id.startsWith('label_')) setText(l, c.placeLabel);
      else setText(l, c.label);
      if (id.startsWith('poi')) setPaint(l, 'icon-opacity', 0.75);
    }
  }
  styleCache = { mode, style };
  return structuredClone(style);
}

const FALLBACK_STYLE = () => ({
  version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': PALETTE[dark() ? 'dark' : 'light'].land } }],
});

function circlePolygon(p, radius) {
  const pts = [];
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.cos((p.lat * Math.PI) / 180));
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push([p.lng + dLng * Math.cos(a), p.lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
}

/* ---------- MapLibre (free vector fallback) ---------- */
async function vectorMap(el, { center, zoom = 14, onClick, onUserMove }) {
  const ml = window.maplibregl;
  let style;
  try {
    style = await googleLikeStyle();
  } catch {
    style = FALLBACK_STYLE();
    bus.emit('toast', 'Map tiles unavailable offline for this area.');
  }
  const map = new ml.Map({
    container: el, style, center: [center.lng, center.lat], zoom,
    pitch: 0, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  await new Promise((r) => { map.once('load', r); setTimeout(r, 8000); });

  map.on('dragstart', (e) => { if (e.originalEvent) onUserMove?.(); });
  map.on('click', (e) => onClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));

  const empty = { type: 'FeatureCollection', features: [] };
  const lineLayers = new Set();
  function ensureLineLayer(name) {
    if (lineLayers.has(name) || !map.isStyleLoaded()) return lineLayers.has(name);
    map.addSource(`l-${name}`, { type: 'geojson', data: empty });
    const paint = { 'line-color': ['get', 'color'], 'line-width': ['get', 'weight'], 'line-opacity': ['get', 'opacity'] };
    map.addLayer({ id: `l-${name}`, type: 'line', source: `l-${name}`, filter: ['!', ['get', 'dashed']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint });
    map.addLayer({ id: `l-${name}-dash`, type: 'line', source: `l-${name}`, filter: ['get', 'dashed'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { ...paint, 'line-dasharray': [0.1, 2.2] } });
    lineLayers.add(name);
    return true;
  }
  if (map.isStyleLoaded()) {
    map.addSource('me-acc', { type: 'geojson', data: empty });
    map.addLayer({ id: 'me-acc', type: 'fill', source: 'me-acc', paint: { 'fill-color': '#1A73E8', 'fill-opacity': 0.12, 'fill-outline-color': '#1A73E8' } });
  }

  const markers = {};
  const makeMarker = (it) => {
    const node = document.createElement('div');
    node.className = 'mk-wrap';
    node.innerHTML = it.html;
    node.style.zIndex = String(10 + (it.z || 0));
    if (it.title) node.title = it.title;
    if (it.onClick) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => { e.stopPropagation(); it.onClick(); });
    }
    return new ml.Marker({ element: node, anchor: 'top-left' }).setLngLat([it.lng, it.lat]).addTo(map);
  };
  let me;

  return {
    kind: 'maplibre',
    async setTheme() {
      try {
        const next = await googleLikeStyle();
        for (const l of next.layers) {
          if (!map.getLayer(l.id)) continue;
          for (const [k, v] of Object.entries(l.paint || {})) map.setPaintProperty(l.id, k, v);
        }
      } catch { /* offline: keep current colours */ }
    },
    setUser(p) {
      if (!p) { me?.remove(); me = null; map.getSource('me-acc')?.setData(empty); return; }
      if (!me) me = makeMarker({ ...p, html: userHtml(), z: 2000 });
      else me.setLngLat([p.lng, p.lat]);
      applyHeading(me.getElement(), p.heading);
      map.getSource('me-acc')?.setData({ type: 'FeatureCollection', features: p.acc ? [circlePolygon(p, p.acc)] : [] });
    },
    setMarkers(name, items) {
      (markers[name] || []).forEach((m) => m.remove());
      markers[name] = items.map(makeMarker);
    },
    setLines(name, segments) {
      if (!ensureLineLayer(name)) return;
      map.getSource(`l-${name}`).setData({
        type: 'FeatureCollection',
        features: segments.filter((s) => s.points.length > 1).map(({ points, color = '#1A73E8', weight = 4, opacity = 0.9, dashed = false }) => ({
          type: 'Feature', properties: { color, weight, opacity, dashed: !!dashed },
          geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
        })),
      });
    },
    fit(points, pad = 60) {
      points = points.filter(Boolean);
      if (!points.length) return;
      if (points.length === 1) return map.easeTo({ center: [points[0].lng, points[0].lat], zoom: 16, duration: 600 });
      const lngs = points.map((p) => p.lng);
      const lats = points.map((p) => p.lat);
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: padObj(pad), maxZoom: 17, duration: 600 });
    },
    panTo(p, zoom) {
      map.easeTo({ center: [p.lng, p.lat], ...(zoom ? { zoom } : {}), duration: 500 });
    },
    contains(p) {
      return map.getBounds().contains([p.lng, p.lat]);
    },
    resize: () => map.resize(),
  };
}

/* ---------- Google Maps ---------- */
// Standard Google look, just without shop/business pins competing with ours.
const GOOGLE_STYLE = [{ featureType: 'poi.business', stylers: [{ visibility: 'off' }] }];
const GOOGLE_DARK = [
  ...GOOGLE_STYLE,
  { elementType: 'geometry', stylers: [{ color: '#1F2430' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#AEB4BE' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1F2430' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#3A4150' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#6B5A2E' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17324D' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1F3A2C' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2A303C' }] },
];

function googleMap(gm, el, { center, zoom = 14, onClick, onUserMove }) {
  const map = new gm.Map(el, {
    center, zoom, mapTypeId: 'roadmap', tilt: 0, heading: 0, disableDefaultUI: true,
    clickableIcons: false, gestureHandling: 'greedy', styles: dark() ? GOOGLE_DARK : GOOGLE_STYLE, keyboardShortcuts: false,
  });
  map.addListener('dragstart', () => onUserMove?.());
  map.addListener('click', (e) => onClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() }));

  class Html extends gm.OverlayView {
    constructor(pos, html, z, onClickFn, title) {
      super();
      this.pos = pos;
      this.div = document.createElement('div');
      this.div.className = 'mk-wrap';
      this.div.style.position = 'absolute';
      this.div.style.zIndex = String(1000 + (z || 0));
      this.div.innerHTML = html;
      if (title) this.div.title = title;
      if (onClickFn) {
        gm.OverlayView.preventMapHitsAndGesturesFrom(this.div);
        this.div.style.cursor = 'pointer';
        this.div.addEventListener('click', (e) => { e.stopPropagation(); onClickFn(); });
      }
    }
    onAdd() { this.getPanes().overlayMouseTarget.appendChild(this.div); }
    draw() {
      const pt = this.getProjection()?.fromLatLngToDivPixel(new gm.LatLng(this.pos.lat, this.pos.lng));
      if (pt) { this.div.style.left = `${pt.x}px`; this.div.style.top = `${pt.y}px`; }
    }
    onRemove() { this.div.remove(); }
    setPos(p) { this.pos = p; this.draw(); }
  }

  const layers = {};
  const clear = (name) => { (layers[name] || []).forEach((o) => o.setMap(null)); layers[name] = []; };
  let me, acc;

  return {
    kind: 'google',
    setTheme: () => map.setOptions({ styles: dark() ? GOOGLE_DARK : GOOGLE_STYLE }),
    setUser(p) {
      if (!p) { me?.setMap(null); acc?.setMap(null); me = acc = null; return; }
      if (!me) {
        acc = new gm.Circle({ map, center: p, radius: p.acc || 0, strokeColor: '#1A73E8', strokeWeight: 1, fillColor: '#1A73E8', fillOpacity: 0.12, clickable: false });
        me = new Html(p, userHtml(), 2000);
        me.setMap(map);
      } else {
        me.setPos(p);
        acc.setCenter(p);
        acc.setRadius(p.acc || 0);
      }
      applyHeading(me.div, p.heading);
    },
    setMarkers(name, items) {
      clear(name);
      for (const it of items) {
        const m = new Html({ lat: it.lat, lng: it.lng }, it.html, it.z, it.onClick, it.title);
        m.setMap(map);
        layers[name].push(m);
      }
    },
    setLines(name, segments) {
      clear(name);
      for (const { points, color = '#1A73E8', weight = 4, opacity = 0.9, dashed } of segments) {
        if (points.length < 2) continue;
        const line = new gm.Polyline({
          map, path: points.map((p) => ({ lat: p.lat, lng: p.lng })), clickable: false,
          strokeColor: color, strokeWeight: weight, strokeOpacity: dashed ? 0 : opacity,
          icons: dashed ? [{ icon: { path: gm.SymbolPath.CIRCLE, fillColor: color, fillOpacity: opacity, strokeOpacity: 0, scale: weight / 1.6 }, offset: '0', repeat: '12px' }] : undefined,
        });
        layers[name].push(line);
      }
    },
    fit(points, pad = 60) {
      points = points.filter(Boolean);
      if (!points.length) return;
      if (points.length === 1) { map.setCenter(points[0]); map.setZoom(16); return; }
      const b = new gm.LatLngBounds();
      points.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
      map.fitBounds(b, padObj(pad));
      gm.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 17) map.setZoom(17); });
    },
    panTo(p, zoom) {
      if (zoom) map.setZoom(zoom);
      map.panTo({ lat: p.lat, lng: p.lng });
    },
    contains(p) {
      const b = map.getBounds();
      return b ? b.contains({ lat: p.lat, lng: p.lng }) : false;
    },
    resize: () => gm.event.trigger(map, 'resize'),
  };
}
