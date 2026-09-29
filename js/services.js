// Free, key-less web services that work from a static site:
// Open-Meteo (weather) and Overpass / OpenStreetMap (nearby amenities), plus
// Nominatim for turning the hotel address into coordinates.
import { distance } from './util.js';

const WEATHER_TTL = 30 * 60000;

export async function getWeather(lat, lng, tz) {
  const key = `triparw:weather:${lat.toFixed(2)},${lng.toFixed(2)}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached && Date.now() - cached.at < WEATHER_TTL) return cached.data;
  } catch { /* ignore */ }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code,wind_speed_10m&daily=sunset,sunrise,precipitation_probability_max,temperature_2m_max,temperature_2m_min,weather_code` +
    `&timezone=${encodeURIComponent(tz)}&forecast_days=16`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather');
  const data = await res.json();
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* quota */ }
  return data;
}

export function weatherEmoji(code) {
  if (code == null) return '';
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '🌨️';
  if (code <= 82) return '🌦️';
  return '⛈️';
}

export const NEARBY_KINDS = [
  { id: 'cafe', label: 'Coffee', emoji: '☕', q: ['nwr["amenity"="cafe"]'] },
  { id: 'bar', label: 'Bars', emoji: '🍷', q: ['nwr["amenity"~"^(bar|pub)$"]'] },
  { id: 'food', label: 'Food', emoji: '🍽️', q: ['nwr["amenity"="restaurant"]'] },
  { id: 'pharmacy', label: 'Pharmacy', emoji: '💊', q: ['nwr["amenity"="pharmacy"]'] },
  { id: 'toilets', label: 'Toilets', emoji: '🚻', q: ['nwr["amenity"="toilets"]'] },
  { id: 'atm', label: 'ATM', emoji: '🏧', q: ['nwr["amenity"="atm"]', 'nwr["amenity"="bank"]["atm"="yes"]'] },
  { id: 'metro', label: 'Metro', emoji: 'Ⓜ️', q: ['nwr["railway"="station"]["station"="subway"]', 'nwr["public_transport"="station"]["subway"="yes"]'] },
];

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export async function searchNearby(kindId, pos, radius = 700) {
  const kind = NEARBY_KINDS.find((k) => k.id === kindId);
  const around = `(around:${radius},${pos.lat},${pos.lng})`;
  const body = `[out:json][timeout:20];(${kind.q.map((q) => `${q}${around};`).join('')});out center tags 80;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: body }), signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      const seen = new Set();
      return json.elements
        .map((el) => {
          const lat = el.lat ?? el.center?.lat;
          const lng = el.lon ?? el.center?.lon;
          const tags = el.tags || {};
          return {
            id: `${el.type}/${el.id}`, lat, lng, kind: kind.id, emoji: kind.emoji,
            name: tags.name || tags.brand || kind.label.replace(/s$/, ''),
            hours: tags.opening_hours, cuisine: tags.cuisine?.replace(/;/g, ', '),
            dist: distance(pos, { lat, lng }),
          };
        })
        .filter((p) => isFinite(p.lat) && !seen.has(p.name + Math.round(p.dist / 30)) && seen.add(p.name + Math.round(p.dist / 30)))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 30);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function geocode(query, near) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', addressdetails: '0' });
  if (near) params.set('viewbox', `${near.lng - 0.3},${near.lat + 0.3},${near.lng + 0.3},${near.lat - 0.3}`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Geocoding failed');
  return (await res.json()).map((r) => ({ name: r.display_name, lat: +r.lat, lng: +r.lon }));
}
