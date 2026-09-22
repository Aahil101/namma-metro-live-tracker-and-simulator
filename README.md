<div align="center">

# Namma Metro Live

**Every Bengaluru metro train, moving on a map, right now.**

A real-clock simulation of the entire Namma Metro network — Purple, Green and Yellow lines —
with per-train speed, next-stop countdowns, live station departure boards, and shareable
codes so you can watch a friend's train.

No build step · no npm dependencies · no backend required · no API keys

[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-2ea44f?style=flat-square)](#tech-stack)
[![tests](https://img.shields.io/badge/tests-360%20passing-2ea44f?style=flat-square)](#tests)
[![build step](https://img.shields.io/badge/build%20step-none-4da3ff?style=flat-square)](#why-no-framework)
[![payload](https://img.shields.io/badge/payload-1.45%20MB-4da3ff?style=flat-square)](#performance-budget)
[![data](https://img.shields.io/badge/timetable-BMRCL%20GTFS-8C2877?style=flat-square)](#where-the-data-comes-from)
[![licence](https://img.shields.io/badge/licence-MIT-blue?style=flat-square)](#license)

[Quick start](#quick-start) · [Tech stack](#tech-stack) · [How "live" works](#how-live-works-honestly) · [System design](#system-design) · [Data pipeline](#where-the-data-comes-from) · [Deploy](#deploy-it-free) · [Tests](#tests)

![overview](docs/overview.png)

</div>

---

## Why this exists

Namma Metro has no public real-time feed. If you want to know where the trains actually are,
your options are the station display or guessing. This project takes the timetable BMRCL
does publish, runs it against the real Bengaluru clock, and draws the result on the actual
track alignment — so what you see is *where the trains are supposed to be this second*,
not a generic animation.

It is also a demonstration that a genuinely rich, interactive, data-heavy web app does not
need a framework, a bundler, or a node_modules folder.

| | |
|---|---|
| **Live fleet** | 40–65 trains in motion at peak, interpolated along real OpenStreetMap track geometry at 60 fps |
| **Tap a train** | speed, distance covered, next stop, and a strip map of every remaining station with the train sliding down it live |
| **Tap a station** | the next ~16 arrivals split by direction, counting down |
| **Share a train** | a code like `MTR-4K7P-2XQ8`, or a link — the recipient sees that train ringed and labelled while the rest of the fleet fades back |
| **Peak / off-peak** | current headway per line, plus a frequency-by-time-of-day table derived from the timetable itself |
| **Time travel** | play / pause, slow motion to 0.25×, fast-forward to 32×, or any custom rate up to 240× — displayed as a signed notch (`−2` … `0` … `+6`) beside the multiplier |
| **Light & dark** | full theme swap including the basemap; line colours darken so the Yellow Line stays legible on a pale map |
| **Shrink mode** | fold every panel out to the edges for a full-bleed map, leaving two corner chips that keep the live train count and clock |
| **Live viewers** | a "N watching" pill when the optional API is deployed — hidden rather than faked without it |
| **Feedback** | in-app form, stored server-side and optionally emailed, readable from a private dashboard |

<table>
<tr>
<td width="50%"><img src="docs/train-panel.png" alt="Train detail panel with live strip map"><br><em>Tap a train: speed, ETA, and a live strip map</em></td>
<td width="50%"><img src="docs/tracking.png" alt="Tracking a shared train"><br><em>Tracking a friend's train — the rest of the fleet fades</em></td>
</tr>
<tr>
<td><img src="docs/light.png" alt="Light theme"><br><em>Light theme on the standard basemap</em></td>
<td><img src="docs/mobile.png" alt="Mobile layout"><br><em>Phone layout</em></td>
</tr>
</table>

---

## Quick start

Needs **Node 20+**. There is nothing to install — no `npm install`, no lockfile, no bundler.

```bash
git clone <your-fork-url> && cd mymetrotracker
node tools/serve.mjs          # -> http://localhost:5173
```

That's it. `public/` is already a deployable site.

---

## How "live" works, honestly

**BMRCL publishes no public real-time feed.** There is no GTFS-Realtime endpoint for Namma
Metro, so no website — including this one — can show true GPS positions of these trains.
Anything claiming otherwise is either guessing or lying.

What this does instead:

1. **Resolves today's service pattern.** BMRCL operates four distinct timetables:
   `weekday` (Tue–Sat), `monday`, `sunday`, and `holiday`. Public holidays are resolved
   from the GTFS calendar exceptions, so Gandhi Jayanti runs the holiday timetable
   automatically.
2. **Advances it with the real Asia/Kolkata clock**, second by second. Open the site from
   London and you still see the trains running in Bengaluru now — the timezone is resolved
   with `Intl.DateTimeFormat`, never from the visitor's machine.
3. **Interpolates each train between its scheduled calls** along the real track polyline
   from OpenStreetMap, using an accelerate–cruise–brake velocity profile rather than a
   linear tween. A linear ramp reads as obviously fake; real trains leave a platform slowly
   and coast into the next one.
4. **Includes the short-loop turnback services** — Baiyappanahalli, Garudacharpalya,
   Peenya Industry, Yelachenahalli, MG Road. 13 of the 19 stopping patterns are short loops,
   and leaving them out would show a network that runs more sparsely than it does.
5. **Keeps tracking trains past midnight.** A run that departed at 23:55 is still out on the
   line at 00:20, so the engine evaluates both today's and yesterday's service day.

### Known limits

- **Intermediate station times are modelled.** BMRCL publishes terminal times only. Times
  between termini are derived from stop spacing, dwell time and average speed. Expect a
  minute or two of drift against the train in front of you.
- **Delays cannot be detected.** During a disruption the map is confidently wrong.
- **Don't use it to catch your last train.**

The schedule layer is isolated behind the `Simulation` class. If BMRCL ever opens a
GTFS-Realtime feed, it can be substituted without touching the map or the UI.

---

## Where the data comes from

| What | Source | Notes |
|---|---|---|
| Timetables, stations, fares | **BMRCL**, via the unofficial [`Vonter/bmrcl-gtfs`](https://github.com/Vonter/bmrcl-gtfs) dataset | Feed version `20260817`, valid to Aug 2027 |
| Track geometry, coordinates | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL) | Real viaduct and tunnel curves, not straight hops |
| Basemap tiles | [OpenFreeMap](https://openfreemap.org) | Free, no API key, no signup |
| Map renderer | [MapLibre GL JS](https://maplibre.org) 5.24.0 | Vendored into `public/vendor/`, no runtime CDN |

The build cross-checks against published figures and matches them: **83 stations**,
Purple 37 (Whitefield ↔ Challaghatta, 43.4 km / 80 min), Green 32 (Madavara ↔ Silk
Institute, 33.1 km), Yellow 16 (RV Road ↔ Bommasandra, 18.0 km).

### The compression step

`stop_times.txt` is 5.4 MB — 88,906 rows across 3,279 trips. Shipping that to a browser
would be absurd. `tools/build-data.mjs` notices that thousands of trips share a handful of
distinct *(stopping pattern + relative timings)* signatures and deduplicates them:

```
3,279 trips  -->  19 stopping patterns
                  each trip becomes [patternIndex, departureSecond]

5.4 MB stop_times.txt  -->  48 KB schedule.json     (112x smaller)
```

Positions come from `shape_dist_traveled`, which GTFS provides in both `stop_times` and
`shapes`. Converting "this train is 12.84 km along the Purple Line" into a coordinate is a
binary search plus one interpolation — which is why the whole fleet costs **0.11 ms per
frame** to simulate and push to the GPU.

### Refreshing the timetable

```bash
node tools/fetch-gtfs.mjs     # download + unzip upstream GTFS (dependency-free ZIP reader)
node tools/build-data.mjs     # regenerate public/data/*.json
node tools/test-sim.mjs       # 82 assertions against the rebuilt data
```

---

## Tech stack

Deliberately small. The whole thing is ES modules served as static files — there is no
bundler, no transpiler, no `node_modules`, and nothing fetched from a CDN at runtime.

### Frontend

| Layer | Choice | Why |
|---|---|---|
| Language | **Vanilla ES2022 modules** | Native `import`/`export` in every target browser. No build step means what you edit is what ships and what you debug. |
| Rendering | **MapLibre GL JS 5.24** (WebGL, vendored) | GPU-composited vector tiles. The fleet is one GeoJSON source rewritten per frame — see [why](#why-one-geojson-source-not-markers). |
| Basemap | **OpenFreeMap** vector tiles | Free, no API key, no signup, no rate limit. Dark and Liberty styles for the two themes. |
| Geometry | **OpenStreetMap** polylines via GTFS `shapes` | Trains follow the real viaduct curve, not a straight line between stations. |
| UI | Hand-written DOM + a 20-line keyed reconciler | The panels refresh 4×/s; a virtual DOM would add weight for nothing. |
| Charts | Inline SVG, hand-rolled | No chart library to audit or update. ~80 lines for grouped bars, single bars and bar lists. |
| Styling | **CSS custom properties**, one stylesheet | Both themes are a token swap — no duplicated rules, no CSS-in-JS. |
| State | A single plain object + rAF loop | The only real state is "what time is it"; everything else derives from it. |
| Icons | Canvas-drawn at runtime, inline SVG | Train symbols are generated per line colour per theme. No sprite sheet, no icon font. |
| Storage | `sessionStorage` / `localStorage` | Theme choice, offline feedback queue, admin token. No cookies. |

### Backend — optional

The map needs no server. This exists only for durable feedback and traffic stats.

| Layer | Choice | Why |
|---|---|---|
| Compute | **Cloudflare Workers** | Free tier covers 100k req/day. Runs at the edge, cold start ~0 ms. |
| Database | **Cloudflare D1** (SQLite) | Free 5 GB. Two fact tables and one counter table is all this needs. |
| Auth | **WebCrypto** PBKDF2-SHA256 + HMAC tokens | No auth library. Password is a Cloudflare secret; tokens are signed, not stored. |
| Email | **Resend** (optional) | Forwards feedback to an inbox. Failure never fails the request. |
| Rate limiting | Fixed window in D1 | Per hashed client, no IP retained. |

### Data pipeline — build time

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 20+**, standard library only | `fetch`, `zlib`, `fs`. The ZIP reader is ~60 lines rather than a dependency. |
| Source | BMRCL timetables + OpenStreetMap, via GTFS | See [data pipeline](#where-the-data-comes-from). |
| Output | Three JSON files, 179 KB total | 112× smaller than the upstream feed. |

### Tooling & testing

| Layer | Choice | Why |
|---|---|---|
| Unit / integration | Plain Node scripts | 133 assertions, zero framework. `node tools/test-sim.mjs`. |
| End-to-end | **Chrome DevTools Protocol** over Node's built-in `WebSocket` | 160 assertions in a real browser with no Playwright or Puppeteer download. |
| Dev server | ~60 lines of `node:http` | Path-traversal guarded, correct MIME types. |
| CI | GitHub Actions | Runs all four suites, then publishes. No install step, so it finishes in seconds. |
| Hosting | Any static host | Netlify · Vercel · Cloudflare Pages · GitHub Pages. Configs for all four are committed. |

---

## System design

```
  BUILD TIME                                        node, no dependencies
  ----------------------------------------------------------------------
    BMRCL timetables --+
    OpenStreetMap    --+--> fetch-gtfs.mjs --> build-data.mjs
                             5.4 MB of GTFS       179 KB of JSON
                                                        |
                                    committed artefacts |
                                                        v
  BROWSER                                        ES modules, no bundler
  ----------------------------------------------------------------------
    clock.js            IST wall clock + GTFS calendar
        |               -> which service_id runs today
        v
    simulation.js       THE ENGINE
        |                 trainsAt(t)    active trips, via binary search
        |                 resolve()      accel / cruise / brake profile
        |                 boardFor()     station departure boards
        |                 headwayNow()   live headway, peak classification
        |
        v   Train[]  lon, lat, bearing, speed, ETA, dwell, progress
        |
        +--> geometry.js    along-track km -> lon/lat + stable bearing
        +--> map-view.js    MapLibre scene; 1 GeoJSON source per frame
        +--> ui.js          panels, strip map, boards, share dialog
        |
    theme.js   sharecode.js   analytics.js   feedback.js   visits.js
        |
        |   optional - only for feedback and traffic stats
        v
  CLOUDFLARE WORKER + D1                                          api/
  ----------------------------------------------------------------------
    POST /api/event           anonymous view / ping / action beacons
    POST /api/feedback        -> D1, optional Resend email forward
    GET  /api/live            {live, views24} for the "watching" pill
    POST /api/admin/login     PBKDF2 verify -> 12 h HMAC session token
    GET  /api/admin/stats     traffic, surges, referrers, countries
```

### Design decisions worth explaining

<a name="why-no-framework"></a>
**Why no framework.** The hot path is "move 60 symbols, 60 times a second." A virtual DOM is
the wrong tool: MapLibre already owns the pixels, and the panels only need updating four
times a second. `ui.js` uses a 20-line keyed reconciler so a row you are hovering doesn't
flicker while its countdown ticks. Total client JS: ~90 KB unminified, including the app,
the simulation engine and every panel.

**Why the real clock, not an accumulator.** In live mode the time source is
`istNow()` every frame, not `t += dt`. Background the tab for ten minutes and on return the
trains are exactly where they should be, with no catch-up animation and no drift. Simulated
mode switches to an accumulator, which is what makes 32× playback possible.

<a name="why-one-geojson-source-not-markers"></a>
**Why one GeoJSON source instead of markers.** 60 DOM markers means 60 elements being
transformed per frame and a layout cost that scales with the fleet. One `setData()` call
re-uploads a single small buffer and lets the GPU do the work.

**Why the vendored UMD MapLibre build.** MapLibre v6 ships as three ESM chunks plus a
module worker, which is fragile to host statically. The v5 UMD bundle is one self-contained
file with its worker inlined as a blob — so there is no runtime CDN dependency, no
integrity to verify at load, and the site keeps working if unpkg is down.

**Why the strip map moves every frame but the text doesn't.** The marker position is a
single `style.top` write per frame (cheap, and it's the thing that reads as "live"). Station
countdowns re-render four times a second, which is imperceptibly different from 60 and a
fraction of the cost.

**Why the theme swap rebuilds the whole scene.** `map.setStyle()` discards every custom
source, layer and image. Rather than patch paint properties one by one and risk drift
between themes, `_buildScene()` is idempotent and simply runs again — the camera is
preserved and the fleet is repainted in the same tick, so there is no blank frame.

### Data model

Three JSON files, loaded once at boot.

```
network.json   118 KB   lines[]     id, name, colour, ordered station ids
                        stations{}  id -> { code, name, lat, lon, lines[] }
                        shapes{}    id -> { coords: [lon,lat,...], dist: [km,...] }
                                    two flat arrays, not objects -- small and
                                    fast to binary-search

schedule.json   48 KB   patterns[]  19 entries: line, direction, headsign,
                                    stops[], arr[], dep[], dist[], runtime
                                    (offsets in seconds from that run's own
                                    departure, so patterns are reusable)
                        departures{} service_id -> [[patternIdx, startSec], ...]
                                    3,279 trips in 48 KB
                        services[]  GTFS calendar
                        exceptions[] public holidays

meta.json       12 KB   feed version, validity window, per-service headway bands
```

A single train at time *t* is therefore `(patternIdx, startSec)` plus arithmetic — no
per-train state is stored or mutated anywhere. That is what makes scrubbing, pausing and
32× playback fall out for free: there is nothing to rewind.

### What happens in one frame

```
  requestAnimationFrame
    |
    +-- istNow()                  Intl -> seconds since IST midnight
    +-- serviceFor(date)          cached; recomputed only on a date change
    |
    +-- sim.trainsAt(t, contexts) binary-search departures for
    |     |                       start in (t - maxRuntime, t]
    |     +-- resolve() per train
    |           |
    |           +-- locate the current stop pair (binary search on dep[])
    |           +-- trapezoidal profile -> distance fraction
    |           +-- pointAtDistance()  -> lon, lat, bearing
    |           +-- speed, ETA, dwell, progress
    |
    +-- metro.renderTrains()      build ~60 features, one setData()
    +-- ui.updateStripLive()      one style.top write
    |
    +-- every 100 ms   clock, peak badge, headway chips, tracked chip
    +-- every 250 ms   train list, station board, train panel
```

<a name="performance-budget"></a>
### Performance budget

Measured, not estimated. Simulation numbers are from `tools/test-sim.mjs`; the frame cost is
measured in-browser by `tools/browser-check.mjs`.

| Metric | Value | Note |
|---|---:|---|
| Simulate a full 65-train fleet | **0.04 ms** | binary search + interpolation, no allocation |
| Simulate **and** push GeoJSON | **0.11 ms** | leaves 16.5 ms of the frame budget free |
| Peak concurrent trains | **65** | weekday 09:40, all three lines |
| Schedule payload | **48 KB** | from 5.4 MB of `stop_times.txt` |
| Total deployed payload | **1.45 MB** | 1.03 MB of that is vendored MapLibre |
| Client JS (ours, unminified) | **~92 KB** | app + engine + every panel |
| Cold boot to first train | **< 1 s** | three JSON fetches, then render |
| Geometry accuracy | **70 m worst case** | furthest a station sits from its interpolated point |
| Traced vs declared track length | **0.03%** | 33.10 km traced vs 33.11 km declared |

### Scaling notes

The design is bounded by the size of the network, not by traffic. Positions are computed on
each visitor's device, so the hosting cost is a static file transfer no matter how many
people are watching — the same 1.45 MB serves 10 users or 10 million, cacheable at the edge
forever. Adding the Pink and Blue lines when they open means re-running the build script;
nothing in the engine is hard-coded to three lines. The only server-side component is the
optional feedback/stats Worker, and its write volume is one row per pageview.

### File map

```
public/                  <- the deployable site; everything below is optional tooling
  index.html  app.css
  admin.html  admin.css
  js/
    main.js              bootstrap + rAF loop, real-clock time source
    simulation.js        timetable -> live positions, headways, peak analysis
    geometry.js          along-track distance -> lon/lat + stable bearing
    clock.js             IST handling, GTFS calendar resolution
    map-view.js          MapLibre scene; rebuildable for theme swaps
    ui.js                panels, strip map, boards, playback, share, feedback
    theme.js             dark/light tokens + per-theme map palette
    sharecode.js         Crockford base32 run codes with a check character
    analytics.js         anonymous beacons (no-op without an API)
    feedback.js          submit + offline queue + mailto fallback
    visits.js            local visit history; live-viewer poll when an API exists
    admin.js             dashboard; hand-rolled SVG charts
    config.js            <- the one file you edit after deploying the API
  data/                  built artefacts, committed (the site needs them)
  vendor/                MapLibre GL JS
api/                     optional Cloudflare Worker + D1 schema
tools/
  fetch-gtfs.mjs         download + unzip upstream feed (no dependencies)
  build-data.mjs         GTFS -> compact JSON
  verify.mjs             data integrity report
  test-sim.mjs           82 engine assertions
  test-api.mjs           51 Worker auth / routing assertions
  browser-check.mjs      178 end-to-end assertions in real Chrome over CDP
  screenshot.mjs         capture the running app
  hash-password.mjs      derive the admin secret
  serve.mjs              static dev server
```

---

## Sharing a train

Select the train you're on, press **share this train**, and you get a code:

```
MTR-4K7P-2XQ8
```

Read it out, message it, or send the link (`?train=MTR4K7P2XQ8`). Whoever enters it sees
that exact train ringed and labelled while every other train fades to 22% opacity.

The code packs three things into 38 bits — the service day, the stopping pattern, and the
second the run left its origin — rendered in **Crockford base32** (no `I`, `L`, `O` or `U`,
so `1`/`I` and `0`/`O` can't be confused) with a positional check character. **96% of
single-character typos are rejected** rather than silently pointing at the wrong train.
Decoding accepts any case and any punctuation.

Nothing is uploaded. The code is self-contained: no account, no server, no record of who
shared what.

---

## Admin dashboard

`/admin.html` — live sessions, views, traffic surges, referrers, countries, devices, and
every piece of feedback received.

![admin](docs/admin.png)

### An honest note on security

A static site cannot verify a password. Anything in client-side JavaScript is readable by
everyone, and this repository is public — so the credentials in `config.js` **are public**.
That is an accepted trade-off, bounded by two rules the code enforces:

- **Without a backend**, the dashboard has nothing private to show. There is no traffic data
  to leak: the figures are that visitor's *own* browser history from `localStorage`, and
  concurrent users are left blank rather than invented. The gate is a convenience, and both
  the page and `config.js` say so in those words.
- **With the API deployed**, `config.js` is ignored entirely. Login goes to the Worker, where
  the password lives only as a PBKDF2-SHA256 Cloudflare secret — rate limited to 6 attempts
  per 15 minutes, compared in constant time, returning a 12-hour HMAC-signed token held in
  `sessionStorage` rather than a cookie, so there is no CSRF surface.

**If you fork this, use a different password for `ADMIN_PW` than the one in `config.js`.**
The local gate is a throwaway; the Worker secret is the real credential. `tools/preflight.mjs`
prints that reminder on every run, and fails the build outright if a plaintext password,
PBKDF2 secret, API key, cloud token or private key appears anywhere in the payload.

### Privacy

No cookies. No fingerprinting. No third-party scripts. No IP addresses stored — Cloudflare
provides a two-letter country at the edge and that is the only location signal retained.
Session ids are random, live in `sessionStorage`, and die with the tab. `DNT` and
`Sec-GPC` are honoured without asking.

---

## Deploy it free

The publish directory is **`public/`**. The site works fully without the API.

**Netlify** — drag `public/` onto [app.netlify.com/drop](https://app.netlify.com/drop).
For a persistent site, connect the repo; `netlify.toml` already sets the publish directory
and cache headers.

**Vercel**
```bash
npx vercel --prod         # output directory: public
```

**Cloudflare Pages** — build command: none · output directory: `public`

**GitHub Pages** — push to `main`. `.github/workflows/deploy.yml` runs the engine and API
test suites, then publishes `public/`. Enable it once under
*Settings → Pages → Source: GitHub Actions*.

### Optional: the API (for feedback + stats)

```bash
cd api
npx wrangler login
npx wrangler d1 create namma-metro            # paste the id into wrangler.toml
npx wrangler d1 execute namma-metro --remote --file=./schema.sql

node ../tools/hash-password.mjs               # prints ADMIN_PW + SESSION_SECRET
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PW
npx wrangler secret put SESSION_SECRET

npx wrangler deploy
```

Then set `API_BASE` in `public/js/config.js` to the Worker URL and redeploy the site.
Email forwarding is optional — add `RESEND_API_KEY`, `MAIL_FROM` and `MAIL_TO` secrets.

Tighten `ALLOWED_ORIGINS` in `wrangler.toml` to your site's origin once you know it.

---

## Tests

360 assertions, no test framework, nothing to install.

```bash
node tools/test-sim.mjs        #  82  engine: geometry, continuity, boards, share codes
node tools/test-api.mjs        #  51  Worker: PBKDF2, tokens, routing, input clamping
node tools/preflight.mjs       #  40  deploy readiness + secret scan
node tools/browser-check.mjs   # 178  end-to-end in real headless Chrome
node tools/verify.mjs          #      data integrity report
```

`browser-check.mjs` drives Chrome over the DevTools Protocol using Node's **built-in**
WebSocket — no Playwright, no Puppeteer, no download. It asserts that trains actually
advance along their lines, that the strip-map marker slides forward, that share codes
round-trip through the real UI, that deep links start tracking, that the theme swap rebuilds
every map layer and darkens the Yellow Line, that no overlay is visible when it should be
hidden, that no element overflows its container, that no two pieces of fixed chrome overlap,
that the admin password is absent from the client bundle, and that the console is clean.

Things the browser suite has caught that unit tests could not:

- `.modal { display: grid }` silently overriding the `hidden` attribute, so two dialogs
  rendered on top of the map at load
- inline `<span>`s not stacking, so sidebar rows spilled onto the map
- a `text-font` stack OpenFreeMap doesn't host, 404-ing every glyph range
- MapLibre's zoom buttons and the OSM attribution buried under the time bar

Sample engine output:

```
PASS  traced length matches shape_dist_traveled   traced 33.10 km vs 33.11 km
PASS  stop distances place trains at their stations   worst 70 m at RV Road
PASS  a train never moves backwards along the line
PASS  peak speed is physically plausible   76 km/h
PASS  over 90% of single-character typos are rejected   96.1% caught
PASS  a full fleet resolves fast enough for 60 fps   0.04 ms/frame
```

---

## Keyboard

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` `→` | jump 5 minutes |
| `+` `−` | faster / slower — steps the ladder 0.25× · 0.5× · 1× · 1.5× · 2× · 4× · 8× · 16× · 32× |
| `0` | back to real time |
| `X` | custom speed box |
| `Z` | shrink panels to the corners |
| `L` | back to live |
| `T` | toggle theme |
| `S` | share & track |
| `F` | send feedback |
| `R` | reset view |
| `Esc` | close panels |

---

## Contributing

Spotted a wrong timing? The in-app feedback button sends it straight to me, or open an issue.
Bug reports with the run code from the share dialog are especially useful — they pin down
exactly which train you were looking at.

## License

Code: **MIT**. The underlying transit data keeps its own licence — BMRCL timetables and
OpenStreetMap geometry (ODbL). Not affiliated with or endorsed by BMRCL.
