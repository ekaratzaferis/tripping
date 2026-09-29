# Triparw — live trip guide

A static, offline-capable web app that turns a trip plan into a live guide:
itinerary, prebook and packing checklists, a live map that points you at the
next thing, reminders and check-ins, tips for wherever you are, and a recorded
route you can replay later to find where a photo was taken.

No build step, no server, no accounts. Everything is stored on your device.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly from disk won't work, because ES modules need http.)

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick `main` and `/ (root)`.
3. Open `https://<you>.github.io/<repo>/` on your phone and **Add to Home Screen**.

> `Barcelona_Trip_Plan.pdf` is listed in `.gitignore`, so it stays on your machine.

## Maps

- **Without a key:** MapLibre + OpenFreeMap vector tiles (free, no key), repainted with Google Maps' colours.
- **With a key:** real Google Maps (flat 2D roadmap). Paste a *Maps JavaScript API* key in **Settings → Map**.
  Restrict the key to your Pages domain (HTTP referrer `https://<you>.github.io/*`) and set a daily quota cap.
  Google bills per *map load*: the app creates at most 2 per page open, and panning, zooming and GPS updates are free,
  so a trip stays far inside the 10K/month free tier. Maps are never recreated (theme changes restyle them in place),
  and after 250 Google map loads in a day the app switches to the free map until the next day.

## What's where

| Tab | What it does |
| --- | --- |
| **Live** | Map with you (blue dot + heading) and the place you're heading to, a dashed line to it, today's route, a "now / next" card, leave-by alerts for reservations and transfers, nudges, a 💡 tips overlay for where you are, and a sheet with *Today*, *Nearby* (guide sights + live OSM search for coffee, bars, pharmacies, toilets, ATMs, metro) and *Check-in* ("did you do X?", missed stops). |
| **Plan** | Day-by-day itinerary (dark = fixed, dashed = free roam), guide, budget, links, emergency number. |
| **Lists** | *Prebook* and *Pack*. Tick to cross out, add your own items, remove or restore. Saved in localStorage. |
| **Timeline** | Replay any day's route, scrub through time, drop photos (JPEG/RAW EXIF) or type a time to see where you were, and export GPX for Lightroom or exiftool. |
| **Settings** | Map key, hotel (search, current location or tap on map), departure terminal, tracking, notifications, keep screen awake, **time/location simulation** to try it before the trip, trip import/export, full backup/restore. |

## Storage

- `localStorage` (`triparw:*`): settings, checklist ticks and custom items, event statuses, visits, snoozes.
- `IndexedDB` (`triparw` → `points`): the GPS track (thinned: ≥15 m moved or every 5 min, accuracy ≤80 m).
- Service worker: app shell and visited map tiles are cached for offline use.

## Limitations

- **No background tracking.** Browsers pause GPS when the screen locks or the app is backgrounded.
  Turn on *Keep screen awake* for a complete route, and carry a power bank.
- Notifications only fire while the app is open (no push server).
- Travel times are straight-line estimates, not routing. "Directions" opens Google Maps for real routing.

## Using it for another trip

The whole trip is one JSON file: [`data/barcelona-2026.json`](data/barcelona-2026.json). Either
import a new one in **Settings → Trip**, or add a file under `data/` and open `?trip=data/other.json`.

```jsonc
{
  "id": "barcelona-2026",            // storage namespace
  "title": "Barcelona", "timezone": "Europe/Madrid",
  "center": { "lat": 41.3874, "lng": 2.1686 },
  "terminals": { "T1": "airport-t1", "T2": "airport-t2" },   // what the "airport" place resolves to
  "places": {
    "picasso": {
      "name": "Museu Picasso", "category": "museum",   // museum|landmark|church|park|viewpoint|market|food|square|street|beach|transport|airport|neighbourhood
      "lat": 41.3852, "lng": 2.1809, "radius": 90,      // radius = "you're here" geofence (m)
      "url": "https://…", "tips": { "dontMiss": ["…"], "goodToKnow": ["…"] }
    }
  },
  "days": [{ "date": "2026-10-09", "name": "Friday", "theme": "…", "events": [{
    "id": "fri-picasso", "label": "16:00",
    "start": "2026-10-09T16:00:00+02:00", "end": "2026-10-09T17:30:00+02:00",
    "kind": "fixed",                   // fixed | free | transfer | meal | logistics
    "title": "Picasso Museum", "description": "…",
    "place": "picasso",                // or "hotel" / "airport" (resolved from Settings)
    "stops": ["…"],                    // free-roam spots, visited automatically by geofence
    "booking": "picasso",              // checklist item id: warns if unbooked
    "alert": true, "leadMinutes": 180, // leave-by warnings
    "optional": false
  }]}],
  "checklists": [{ "id": "prebook", "title": "Prebook", "icon": "ticket", "groups": [
    { "id": "book-now", "title": "Book now", "tone": "urgent", "items": [
      { "id": "picasso", "title": "Picasso Museum", "price": "€14", "url": "…", "note": "…", "event": "fri-picasso" }
    ]}
  ]}],
  "nudges": [{ "id": "…", "title": "…", "text": "…", "from": "ISO", "until": "ISO",
               "unlessChecked": "item-id", "onlyIfChecked": "item-id", "snoozeHours": 12 }],
  "budget": { "rows": [{ "item": "…", "cost": "…", "note": "…" }], "total": { … } },
  "guide": [{ "title": "…", "text": "…" }],
  "links": [{ "label": "…", "url": "…" }],
  "emergency": "112"
}
```

Tip: give an LLM your plan PDF plus this schema and the Barcelona file as an example, and ask it to produce the JSON.
Double-check the coordinates it returns.

## Code map

```
index.html            shell (tabs + views)
css/app.css           all styles (light + dark)
js/app.js             bootstrap, router, recompute loop, notifications, wake lock
js/engine.js          current/next event, target, alerts, check-ins, tips
js/trip.js            load/validate trip JSON, resolve hotel/airport
js/geo.js             GPS watch + track recording + simulated location
js/map.js             Google Maps / MapLibre adapter with shared HTML markers
js/store.js           localStorage + IndexedDB
js/services.js        weather (Open-Meteo), nearby (Overpass), geocoding (Nominatim)
js/exif.js            EXIF capture time/GPS reader (JPEG + TIFF-based RAW)
js/views/*.js         live, plan, lists, timeline, settings, detail sheets
sw.js                 offline cache
```
