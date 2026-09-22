/**
 * build-data.mjs
 * -----------------------------------------------------------------------------
 * Converts the unofficial BMRCL GTFS feed (github.com/Vonter/bmrcl-gtfs) into a
 * compact JSON bundle the browser app can load quickly.
 *
 * Output: public/data/network.json      (lines, stations, track geometry)
 *         public/data/schedule.json     (trip patterns + per-service departures)
 *         public/data/meta.json         (headway bands, first/last train, stats)
 *
 * Run:  bun tools/build-data.mjs   (or: node tools/build-data.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GTFS = path.join(ROOT, '_data', 'gtfs');
const OUT = path.join(ROOT, 'public', 'data');

// ---------------------------------------------------------------------------
// Minimal CSV reader (GTFS is RFC4180: quoted fields may contain commas)
// ---------------------------------------------------------------------------
function parseCsv(file) {
  const text = fs.readFileSync(path.join(GTFS, file), 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift();
  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = r[i] ?? '';
    return o;
  });
}

/** "25:13:00" -> seconds after midnight (values > 86400 mean past-midnight service) */
const toSec = (hms) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

const round = (n, p) => Math.round(n * 10 ** p) / 10 ** p;

console.log('reading GTFS…');
const routes = parseCsv('routes.txt');
const stops = parseCsv('stops.txt');
const trips = parseCsv('trips.txt');
const shapes = parseCsv('shapes.txt');
const stopTimes = parseCsv('stop_times.txt');
const calendar = parseCsv('calendar.txt');
const calendarDates = parseCsv('calendar_dates.txt');
const transfers = parseCsv('transfers.txt');

console.log(`  routes=${routes.length} stops=${stops.length} trips=${trips.length} stop_times=${stopTimes.length}`);

// ---------------------------------------------------------------------------
// 1. Stations.  GTFS models each station as a parent + one child per platform.
//    The app only cares about the parent station; platform stops are folded in.
// ---------------------------------------------------------------------------
const parents = stops.filter((s) => s.location_type === '1');
const platformToParent = new Map();
for (const s of stops) {
  if (s.location_type === '' && s.parent_station) platformToParent.set(s.stop_id, s.parent_station);
}
// A handful of stops may have no parent (single-platform); treat them as their own station.
for (const s of stops) {
  if (!platformToParent.has(s.stop_id) && s.location_type === '') platformToParent.set(s.stop_id, s.stop_id);
}

const stationById = new Map();
for (const p of parents) {
  stationById.set(p.stop_id, {
    id: p.stop_id,
    code: p.stop_code || p.stop_id,
    name: p.stop_name,
    lat: round(Number(p.stop_lat), 6),
    lon: round(Number(p.stop_lon), 6),
    lines: new Set(),
  });
}

// ---------------------------------------------------------------------------
// 2. Shapes -> polylines.  shape_dist_traveled is in km and matches the
//    shape_dist_traveled in stop_times, which is what lets us place a train
//    exactly on the track between two stations.
// ---------------------------------------------------------------------------
const shapeById = new Map();
for (const r of shapes) {
  let sh = shapeById.get(r.shape_id);
  if (!sh) { sh = []; shapeById.set(r.shape_id, sh); }
  sh.push([Number(r.shape_pt_sequence), Number(r.shape_pt_lat), Number(r.shape_pt_lon), Number(r.shape_dist_traveled)]);
}
for (const [id, pts] of shapeById) {
  pts.sort((a, b) => a[0] - b[0]);
  shapeById.set(id, {
    // flat arrays keep the JSON small and are fast to binary-search at runtime
    coords: pts.flatMap((p) => [round(p[2], 5), round(p[1], 5)]), // [lon,lat,...] = GeoJSON order
    dist: pts.map((p) => round(p[3], 4)),
  });
}

// ---------------------------------------------------------------------------
// 3. stop_times -> per-trip stop sequence
// ---------------------------------------------------------------------------
const stByTrip = new Map();
for (const st of stopTimes) {
  let arr = stByTrip.get(st.trip_id);
  if (!arr) { arr = []; stByTrip.set(st.trip_id, arr); }
  arr.push({
    seq: Number(st.stop_sequence),
    station: platformToParent.get(st.stop_id) || st.stop_id,
    platform: st.stop_id,
    arr: toSec(st.arrival_time),
    dep: toSec(st.departure_time),
    dist: Number(st.shape_dist_traveled || 0),
  });
}
for (const arr of stByTrip.values()) arr.sort((a, b) => a.seq - b.seq);

// ---------------------------------------------------------------------------
// 4. Build the canonical ordered station list per line.
//    Use the longest end-to-end trip in direction 0 as the reference order.
// ---------------------------------------------------------------------------
const lineOrder = new Map();
for (const route of routes) {
  let best = null;
  for (const t of trips) {
    if (t.route_id !== route.route_id || t.direction_id !== '0') continue;
    const st = stByTrip.get(t.trip_id);
    if (st && (!best || st.length > best.length)) best = st;
  }
  if (!best) continue;
  lineOrder.set(route.route_id, best.map((s) => s.station));
  for (const s of best) stationById.get(s)?.lines.add(route.route_id);
}
// direction-1 trips can reach stations a direction-0 trip never does; make sure
// every station that any trip serves is tagged with its line.
for (const t of trips) {
  for (const s of stByTrip.get(t.trip_id) || []) stationById.get(s.station)?.lines.add(t.route_id);
}

// ---------------------------------------------------------------------------
// 5. Trip patterns.  Thousands of trips share a handful of distinct
//    (stop sequence + relative timing) patterns, so dedupe them and store each
//    trip as [patternIndex, startSecond]. Shrinks the payload by ~50x.
// ---------------------------------------------------------------------------
const patternIndex = new Map();
const patterns = [];
/** serviceId -> array of [patternIdx, startSec] */
const departures = {};

const usedShapes = new Set();

for (const t of trips) {
  const st = stByTrip.get(t.trip_id);
  if (!st || st.length < 2) continue;

  const start = st[0].dep;
  const key = [
    t.route_id,
    t.direction_id,
    t.shape_id,
    t.trip_headsign,
    st.map((s) => `${s.station}:${s.arr - start}:${s.dep - start}:${round(s.dist, 3)}`).join('|'),
  ].join('~');

  let pi = patternIndex.get(key);
  if (pi === undefined) {
    pi = patterns.length;
    patternIndex.set(key, pi);
    usedShapes.add(t.shape_id);
    patterns.push({
      line: t.route_id,
      dir: Number(t.direction_id),
      shape: t.shape_id,
      to: t.trip_headsign,
      // station ids, and offsets in seconds from the trip's own departure
      stops: st.map((s) => s.station),
      arr: st.map((s) => s.arr - start),
      dep: st.map((s) => s.dep - start),
      dist: st.map((s) => round(s.dist, 4)),
      // total run time, handy for the UI
      runtime: st[st.length - 1].arr - start,
    });
  }

  (departures[t.service_id] ||= []).push([pi, start]);
}

for (const k of Object.keys(departures)) departures[k].sort((a, b) => a[1] - b[1]);

console.log(`  patterns=${patterns.length} (from ${trips.length} trips)`);
for (const [svc, deps] of Object.entries(departures)) console.log(`  service ${svc}: ${deps.length} trips`);

// ---------------------------------------------------------------------------
// 6. Calendar -> which service runs on a given date
// ---------------------------------------------------------------------------
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const services = calendar.map((c) => ({
  id: c.service_id,
  days: DOW.map((d) => c[d] === '1'),
  start: c.start_date,
  end: c.end_date,
}));
const exceptions = calendarDates.map((c) => ({
  service: c.service_id,
  date: c.date,
  type: Number(c.exception_type), // 1 = added, 2 = removed
}));

// ---------------------------------------------------------------------------
// 7. Derive real headway bands from the schedule itself.
//    More trustworthy than press-reported "peak = 3 min" numbers because it is
//    computed from the published timetable BMRCL actually operates.
// ---------------------------------------------------------------------------
function headwayBands(serviceId, lineId, dirId) {
  const deps = (departures[serviceId] || [])
    .filter(([pi]) => patterns[pi].line === lineId && patterns[pi].dir === dirId)
    .map(([, s]) => s)
    .sort((a, b) => a - b);
  if (deps.length < 3) return [];

  // gap between consecutive departures from the terminus end of the line
  const gaps = [];
  for (let i = 1; i < deps.length; i++) gaps.push({ at: deps[i - 1], gap: deps[i] - deps[i - 1] });

  // collapse into bands of similar headway (tolerance 60s), ignoring blips
  const bands = [];
  for (const g of gaps) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.gap - g.gap) <= 60) {
      last.to = g.at + g.gap;
      last.n++;
      last.gap = Math.round((last.gap * (last.n - 1) + g.gap) / last.n);
    } else {
      bands.push({ from: g.at, to: g.at + g.gap, gap: g.gap, n: 1 });
    }
  }
  return bands
    .filter((b) => b.n >= 2)
    .map((b) => ({ from: b.from, to: b.to, headway: b.gap, trips: b.n }));
}

const meta = {
  generated: new Date().toISOString(),
  feed: parseCsv('feed_info.txt')[0],
  source: {
    gtfs: 'https://github.com/Vonter/bmrcl-gtfs',
    upstream: 'BMRCL published timetables + OpenStreetMap geometry',
    note: 'Schedule-derived positions. BMRCL publishes no public real-time (GTFS-RT) feed.',
  },
  services: {},
};

for (const svc of Object.keys(departures)) {
  meta.services[svc] = {};
  for (const route of routes) {
    const deps = departures[svc].filter(([pi]) => patterns[pi].line === route.route_id);
    if (!deps.length) continue;
    const starts = deps.map(([, s]) => s);
    meta.services[svc][route.route_id] = {
      trips: deps.length,
      firstTrain: Math.min(...starts),
      lastTrain: Math.max(...starts),
      bands: { 0: headwayBands(svc, route.route_id, 0), 1: headwayBands(svc, route.route_id, 1) },
    };
  }
}

// ---------------------------------------------------------------------------
// 8. Interchanges
// ---------------------------------------------------------------------------
for (const st of stationById.values()) st.lines = [...st.lines];
const interchanges = [...stationById.values()].filter((s) => s.lines.length > 1).map((s) => s.id);

// ---------------------------------------------------------------------------
// 9. Write output
// ---------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });

const network = {
  lines: routes.map((r) => ({
    id: r.route_id,
    name: r.route_short_name,
    longName: r.route_long_name,
    color: '#' + r.route_color,
    textColor: '#' + (r.route_text_color || 'FFFFFF'),
    desc: r.route_desc,
    stations: lineOrder.get(r.route_id) || [],
  })),
  stations: Object.fromEntries([...stationById].map(([id, s]) => [id, s])),
  interchanges,
  shapes: Object.fromEntries([...usedShapes].map((id) => [id, shapeById.get(id)])),
};

const schedule = { patterns, departures, services, exceptions };

const write = (name, obj) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  console.log(`  wrote ${name}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
};

write('network.json', network);
write('schedule.json', schedule);
write('meta.json', meta);

// ---------------------------------------------------------------------------
// Console summary so we can eyeball correctness
// ---------------------------------------------------------------------------
const fmt = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
console.log('\n=== network summary ===');
for (const l of network.lines) {
  const sts = l.stations;
  console.log(`${l.name.padEnd(7)} ${String(sts.length).padStart(2)} stations  ${stationById.get(sts[0]).name} <-> ${stationById.get(sts[sts.length - 1]).name}`);
  const m = meta.services.weekday?.[l.id];
  if (m) {
    console.log(`        weekday: ${m.trips} trips, first ${fmt(m.firstTrain)}, last ${fmt(m.lastTrain)}`);
    const peak = m.bands[0].reduce((a, b) => (b.headway < a.headway ? b : a), { headway: 1e9 });
    if (peak.headway < 1e9) console.log(`        tightest headway dir0: ${(peak.headway / 60).toFixed(1)} min around ${fmt(peak.from)}`);
  }
}
console.log(`\ninterchanges: ${interchanges.map((i) => stationById.get(i).name).join(', ')}`);
console.log(`total stations: ${stationById.size}`);
