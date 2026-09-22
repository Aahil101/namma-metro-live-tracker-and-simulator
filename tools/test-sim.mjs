/**
 * test-sim.mjs — headless checks on the simulation engine.
 *
 * The browser modules are plain ES modules with no DOM dependency (except
 * map-view.js, which is not imported here), so they can be exercised directly.
 *
 *   node tools/test-sim.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Simulation } from '../public/js/simulation.js';
import { pointAtDistance, haversine } from '../public/js/geometry.js';
import { istNow, previousDay, serviceFor, hhmm } from '../public/js/clock.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', f), 'utf8'));

const network = read('network.json');
const schedule = read('schedule.json');
const sim = new Simulation(network, schedule);

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);

/* ------------------------------------------------------------------ */
section('clock & calendar');

const ist = istNow();
console.log(`  IST now: ${ist.pretty} ${hhmm(ist.sec)} (dateKey ${ist.dateKey}, dow ${ist.dow})`);
const svc = serviceFor(ist.dateKey, ist.dow, schedule);
console.log(`  resolved service: ${svc}`);
ok(svc !== null, 'a service resolves for today');

const prev = previousDay(ist);
ok(prev.dateKey < ist.dateKey || prev.dateKey.slice(0, 6) !== ist.dateKey.slice(0, 6),
  'previousDay goes back a day', `${prev.dateKey}`);

// every day of the coming fortnight must resolve to exactly one service
let allDaysOk = true;
const seenSvc = new Set();
for (let i = 0; i < 14; i++) {
  const d = new Date(Date.UTC(ist.y, ist.mo - 1, ist.d + i));
  const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const s = serviceFor(key, d.getUTCDay(), schedule);
  if (!s) { allDaysOk = false; console.log(`    no service for ${key}`); }
  else seenSvc.add(s);
}
ok(allDaysOk, 'every date in the next 14 days resolves', `services seen: ${[...seenSvc].join(', ')}`);

/* ------------------------------------------------------------------ */
section('geometry');

const anyPattern = schedule.patterns.find((p) => p.stops.length > 30);
const shape = network.shapes[anyPattern.shape];
const endKm = shape.dist[shape.dist.length - 1];

const a = pointAtDistance(shape, 0);
const b = pointAtDistance(shape, endKm);
ok(Math.abs(a.lon - shape.coords[0]) < 1e-9, 'distance 0 lands on the first vertex');
ok(Math.abs(b.lon - shape.coords[shape.coords.length - 2]) < 1e-9, 'max distance lands on the last vertex');

// walking the shape in small steps must never jump backwards or teleport
let monotonic = true, maxJump = 0, cursor = a;
for (let km = 0; km <= endKm; km += 0.02) {
  const p = pointAtDistance(shape, km);
  const jump = haversine(cursor.lon, cursor.lat, p.lon, p.lat);
  if (jump > maxJump) maxJump = jump;
  if (jump > 0.12) monotonic = false;
  cursor = p;
}
ok(monotonic, 'stepping 20 m along the shape never teleports', `max step ${(maxJump * 1000).toFixed(0)} m`);

// interpolated length should be close to the declared shape length
let walked = 0; cursor = pointAtDistance(shape, 0);
for (let km = 0.01; km <= endKm; km += 0.01) {
  const p = pointAtDistance(shape, km);
  walked += haversine(cursor.lon, cursor.lat, p.lon, p.lat);
  cursor = p;
}
ok(Math.abs(walked - endKm) / endKm < 0.02,
  'traced length matches shape_dist_traveled', `traced ${walked.toFixed(2)} km vs ${endKm.toFixed(2)} km`);

// every station must sit close to its own line's polyline
let worstOffset = 0, worstName = '';
for (const pat of schedule.patterns) {
  const sh = network.shapes[pat.shape];
  pat.stops.forEach((sid, i) => {
    const st = network.stations[sid];
    const p = pointAtDistance(sh, pat.dist[i]);
    const off = haversine(st.lon, st.lat, p.lon, p.lat);
    if (off > worstOffset) { worstOffset = off; worstName = st.name; }
  });
}
ok(worstOffset < 0.25, 'stop distances place trains at their stations',
  `worst ${Math.round(worstOffset * 1000)} m at ${worstName}`);

/* ------------------------------------------------------------------ */
section('simulation — continuity');

const testSvc = 'weekday';
const contexts = [{ service: testSvc, offset: 0 }, { service: testSvc, offset: 86400 }];

// Track one long train run second-by-second and assert physical plausibility.
const deps = schedule.departures[testSvc];
const longIdx = deps.findIndex(([pi]) => schedule.patterns[pi].stops.length === 37);
const [lpi, lstart] = deps[longIdx];
const lpat = schedule.patterns[lpi];

let last = null, jumps = 0, maxStep = 0, maxSpeed = 0, backwards = 0, stops = new Set();
for (let s = 0; s <= lpat.runtime; s++) {
  const tr = sim.resolve(lpi, lstart, lstart + s, { service: testSvc, offset: 0 });
  if (!tr) { jumps++; continue; }
  if (last) {
    const step = haversine(last.lon, last.lat, tr.lon, tr.lat);
    if (step > maxStep) maxStep = step;
    if (tr.distKm < last.distKm - 1e-6) backwards++;
  }
  if (tr.speedKmh > maxSpeed) maxSpeed = tr.speedKmh;
  if (tr.status === 'dwelling') stops.add(tr.atStation);
  last = tr;
}
ok(jumps === 0, 'train resolves for every second of its run');
ok(backwards === 0, 'a train never moves backwards along the line');
ok(maxStep < 0.06, 'one-second movement stays under 60 m', `max ${(maxStep * 1000).toFixed(0)} m/s`);
ok(maxSpeed > 25 && maxSpeed < 95, 'peak speed is physically plausible', `${maxSpeed.toFixed(0)} km/h`);
ok(stops.size >= lpat.stops.length - 2, 'train is seen dwelling at essentially every station',
  `${stops.size}/${lpat.stops.length}`);

// endpoints
const atStart = sim.resolve(lpi, lstart, lstart, { service: testSvc, offset: 0 });
const atEnd = sim.resolve(lpi, lstart, lstart + lpat.runtime, { service: testSvc, offset: 0 });
const originSt = network.stations[lpat.stops[0]];
ok(haversine(atStart.lon, atStart.lat, originSt.lon, originSt.lat) < 0.1,
  'at t=0 the train sits on its origin platform', originSt.name);
ok(atStart.prevStation === lpat.stops[0] && atStart.distKm === 0, 'origin is reported as the previous stop');
ok(atEnd.status === 'arrived' && atEnd.atStation === lpat.stops[lpat.stops.length - 1],
  'ends at its destination', network.stations[atEnd.atStation].name);
ok(sim.resolve(lpi, lstart, lstart - 1, { service: testSvc, offset: 0 }) === null, 'not running before departure');
// the feed models a dwell at the terminus, so a train lingers briefly after arrival
const endRel = sim.endRel[lpi];
ok(endRel > lpat.runtime, 'terminus dwell is modelled', `${endRel - lpat.runtime}s in the platform`);
ok(sim.resolve(lpi, lstart, lstart + endRel, { service: testSvc, offset: 0 })?.status === 'arrived',
  'still shown standing at the terminus during its dwell');
ok(sim.resolve(lpi, lstart, lstart + endRel + 1, { service: testSvc, offset: 0 }) === null,
  'gone once the terminus dwell ends');

/* ------------------------------------------------------------------ */
section('simulation — fleet through the day');

let peakFleet = 0, peakAt = 0, zeroGaps = [];
for (let s = 0; s < 86400; s += 60) {
  const n = sim.trainsAt(s, contexts).length;
  if (n > peakFleet) { peakFleet = n; peakAt = s; }
  if (n === 0) zeroGaps.push(s);
}
console.log(`  peak fleet ${peakFleet} trains at ${hhmm(peakAt)}`);
ok(peakFleet > 35 && peakFleet < 140, 'peak fleet size is realistic', `${peakFleet} trains`);

const firstZeroRun = zeroGaps.length ? `${hhmm(zeroGaps[0])}–${hhmm(zeroGaps[zeroGaps.length - 1])}` : 'none';
ok(zeroGaps.length > 120 && zeroGaps.length < 380,
  'there is a nightly shutdown window', `${zeroGaps.length} quiet minutes, e.g. ${firstZeroRun}`);

// no duplicate ids in a single snapshot
const snap = sim.trainsAt(18 * 3600, contexts);
ok(new Set(snap.map((t) => t.id)).size === snap.length, 'train ids are unique within a snapshot');
ok(snap.every((t) => Number.isFinite(t.lon) && Number.isFinite(t.lat)), 'every train has finite coordinates');
ok(snap.every((t) => t.lat > 12.6 && t.lat < 13.3 && t.lon > 77.3 && t.lon < 77.9),
  'every train is inside the Bengaluru bounding box');

const byLine = {};
for (const t of snap) byLine[t.line] = (byLine[t.line] || 0) + 1;
console.log(`  18:00 snapshot: ${JSON.stringify(byLine)}`);
ok(Object.keys(byLine).length === 3, 'all three lines have trains running at 18:00');

// both directions present
ok(new Set(snap.map((t) => `${t.line}${t.dir}`)).size === 6, 'both directions run on all three lines');

/* ------------------------------------------------------------------ */
section('past-midnight rollover');

const lateCtx = [
  { service: testSvc, offset: 0 },
  { service: testSvc, offset: 86400 },
];
const at0015 = sim.trainsAt(15 * 60, lateCtx);
console.log(`  00:15 → ${at0015.length} trains still finishing their run`);
ok(at0015.length > 0, 'trains that departed before midnight are still tracked');
ok(at0015.every((t) => t.startAbs < 0 || t.startAbs > 80000),
  'those trains report a pre-midnight departure time',
  at0015.length ? `e.g. ${hhmm(at0015[0].startAbs)}` : '');

/* ------------------------------------------------------------------ */
section('station departure boards');

const testStations = ['KGWA', 'RVR', 'MAGR', 'BMSD', 'APTS', 'WHTM'];
for (const sid of testStations) {
  const board = sim.boardFor(sid, 18 * 3600, contexts, 10);
  const st = network.stations[sid];
  const waits = board.map((r) => Math.round(r.waitSec / 60));
  console.log(`  ${st.name.padEnd(36)} ${String(board.length).padStart(2)} upcoming  next in ${waits.slice(0, 5).join(', ')} min`);
  ok(board.length > 0, `board has entries for ${st.name}`);
  ok(board.every((r, i) => i === 0 || r.waitSec >= board[i - 1].waitSec), `board sorted for ${st.name}`);
  ok(new Set(board.map((r) => r.trainId)).size === board.length, `no duplicate trains for ${st.name}`);
  ok(board.every((r) => st.lines.includes(r.line)), `board only lists lines serving ${st.name}`);
}

// an interchange must show both of its lines
const kgwa = sim.boardFor('KGWA', 18 * 3600, contexts, 20);
ok(new Set(kgwa.map((r) => r.line)).size === 2, 'Majestic board shows both Purple and Green');
const rvr = sim.boardFor('RVR', 18 * 3600, contexts, 20);
ok(new Set(rvr.map((r) => r.line)).size === 2, 'RV Road board shows both Green and Yellow');

/* ------------------------------------------------------------------ */
section('frequency & peak analysis');

for (const svcId of Object.keys(schedule.departures)) {
  const table = sim.windowTable(svcId);
  console.log(`\n  ${svcId}:`);
  for (const line of network.lines) {
    const cells = table[line.id].map((w) => `${w.label.split(' ')[0]}=${w.headway ? (w.headway / 60).toFixed(1) : '—'}`);
    console.log(`    ${line.name.padEnd(7)} ${cells.join('  ')}`);
  }
}

const hw18 = sim.headwayNow('weekday', 'PURPLE', 18 * 3600);
const hw14 = sim.headwayNow('weekday', 'PURPLE', 14 * 3600);
console.log(`\n  Purple headway  18:00 = ${(hw18 / 60).toFixed(1)} min   14:00 = ${(hw14 / 60).toFixed(1)} min`);
ok(hw18 !== null && hw18 > 100 && hw18 < 700, 'evening peak headway in a sane range');
ok(hw18 <= hw14, 'peak headway is tighter than midday');
ok(sim.headwayNow('weekday', 'PURPLE', 3 * 3600) === null, 'no headway reported at 03:00');

const peakNow = sim.peakState('weekday', 18 * 3600);
const midday = sim.peakState('weekday', 14 * 3600);
const night = sim.peakState('weekday', 3 * 3600);
console.log(`  peakState 18:00=${peakNow.kind}(${peakNow.now}/${peakNow.peak})  14:00=${midday.kind}  03:00=${night.kind}`);
ok(peakNow.kind === 'peak', '18:00 classified as peak');
ok(night.kind === 'closed', '03:00 classified as closed');

/* ------------------------------------------------------------------ */
section('short-loop / turnback services');

const loops = schedule.patterns.filter((p) => {
  const line = network.lines.find((l) => l.id === p.line);
  return p.stops.length < line.stations.length;
});
console.log(`  ${loops.length} short-loop patterns:`);
for (const p of loops.slice(0, 8)) {
  console.log(`    ${p.line.padEnd(6)} ${network.stations[p.stops[0]].name} → ${p.to} (${p.stops.length} stops)`);
}
ok(loops.length > 0, 'short-loop turnback services are represented');

const loopTrains = snap.filter((t) => t.isShortLoop);
ok(loopTrains.length > 0, 'short-loop trains appear in a live snapshot', `${loopTrains.length} of ${snap.length}`);

/* ------------------------------------------------------------------ */
section('share codes');

const { encodeRun, decodeRun, formatCode } = await import('../public/js/sharecode.js');

const sampleRuns = [];
for (const [pi, st] of schedule.departures.weekday.slice(0, 40)) {
  sampleRuns.push({ patternIdx: pi, start: st, dateKey: '20260922' });
}
sampleRuns.push({ patternIdx: 0, start: 0, dateKey: '20240101' });
sampleRuns.push({ patternIdx: schedule.patterns.length - 1, start: 86399, dateKey: '20301231' });

let roundTrip = true, codeSet = new Set();
for (const r of sampleRuns) {
  const code = encodeRun(r);
  codeSet.add(code);
  const back = decodeRun(code);
  if (!back || back.patternIdx !== r.patternIdx || back.start !== r.start || back.dateKey !== r.dateKey) {
    roundTrip = false;
    console.log(`    mismatch ${JSON.stringify(r)} -> ${code} -> ${JSON.stringify(back)}`);
  }
}
console.log(`  example code: ${encodeRun(sampleRuns[5])}  (pattern ${sampleRuns[5].patternIdx}, start ${hhmm(sampleRuns[5].start)})`);
ok(roundTrip, 'every sample run survives encode -> decode', `${sampleRuns.length} runs`);
ok(codeSet.size === sampleRuns.length, 'codes are unique per run');
ok([...codeSet].every((c) => /^MTR-[0-9A-Z]{4}-[0-9A-Z]{5}$/.test(c)), 'codes match the MTR-XXXX-XXXXX shape');

// input tolerance
const canonical = encodeRun(sampleRuns[3]);
const messy = canonical.toLowerCase().replace(/-/g, ' ');
ok(JSON.stringify(decodeRun(messy)) === JSON.stringify(decodeRun(canonical)),
  'lowercase and re-spaced input still decodes');
ok(JSON.stringify(decodeRun(canonical.replace(/-/g, ''))) === JSON.stringify(decodeRun(canonical)),
  'code without separators decodes');

// corruption must be rejected, not silently mis-decoded
let caught = 0, slipped = 0;
const body = canonical.replace(/[^0-9A-Z]/g, '').replace(/^MTR/, '');
for (let i = 0; i < body.length; i++) {
  for (const ch of '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
    if (ch === body[i]) continue;
    const bad = 'MTR' + body.slice(0, i) + ch + body.slice(i + 1);
    const d = decodeRun(bad);
    if (d === null) caught++;
    else slipped++;
  }
}
console.log(`  single-character typos: ${caught} rejected, ${slipped} accepted (${(100 * caught / (caught + slipped)).toFixed(1)}% caught)`);
ok(caught / (caught + slipped) > 0.9, 'over 90% of single-character typos are rejected');

ok(decodeRun('') === null, 'empty input rejected');
ok(decodeRun('hello') === null, 'garbage input rejected');
ok(decodeRun('MTR-1234') === null, 'short code rejected');
ok(formatCode('mtr4k7p2xq8') === 'MTR-4K7P-2XQ8', 'formatCode normalises user input', formatCode('mtr4k7p2xq8'));

/* ------------------------------------------------------------------ */
section('tracking a shared run against the live fleet');

const trackCtx = [
  { service: 'weekday', offset: 0, dateKey: '20260922' },
  { service: 'weekday', offset: 86400, dateKey: '20260921' },
];
const fleet = sim.trainsAt(18 * 3600, trackCtx);
ok(fleet.every((t) => t.dateKey), 'every live train carries its service date');

const victim = fleet[Math.floor(fleet.length / 2)];
const vCode = encodeRun({ patternIdx: victim.patternIdx, start: victim.start, dateKey: victim.dateKey });
const vBack = decodeRun(vCode);
const found = fleet.filter((t) =>
  t.patternIdx === vBack.patternIdx && t.start === vBack.start && t.dateKey === vBack.dateKey);
console.log(`  shared ${victim.run} (${sim.stations[victim.origin].name} → ${victim.headsign}) as ${vCode}`);
ok(found.length === 1, 'a shared code resolves to exactly one live train');
ok(found[0].id === victim.id, 'and it is the same train that was shared');

// resolving the same code later in the run must still find it
const later = sim.trainsAt(18 * 3600 + 420, trackCtx)
  .filter((t) => t.patternIdx === vBack.patternIdx && t.start === vBack.start && t.dateKey === vBack.dateKey);
ok(later.length === 1, 'the code still resolves seven minutes later',
  later.length ? `now near ${sim.stations[later[0].nextStation ?? later[0].atStation]?.name}` : '');

/* ------------------------------------------------------------------ */
section('strip-map geometry');

const stripTrain = fleet.find((t) => t.status === 'moving' && t.stopCount > 10);
const stripCalls = sim.callsFor(stripTrain, 100);
ok(stripCalls.length === stripTrain.stopCount, 'callsFor returns every scheduled call',
  `${stripCalls.length} calls`);
ok(stripCalls.every((c, i) => i === 0 || c.arr >= stripCalls[i - 1].arr), 'calls are in time order');

// stopPos must advance smoothly from 0 to the last index across the whole run
let posMono = true, lastPos = -1, maxPosJump = 0;
for (let s = 0; s <= sim.endRel[stripTrain.patternIdx]; s += 1) {
  const tr = sim.resolve(stripTrain.patternIdx, stripTrain.start, stripTrain.start + s,
    { service: 'weekday', offset: 0, dateKey: '20260922' });
  if (!tr) continue;
  if (tr.stopPos < lastPos - 1e-9) posMono = false;
  if (lastPos >= 0) maxPosJump = Math.max(maxPosJump, tr.stopPos - lastPos);
  lastPos = tr.stopPos;
}
ok(posMono, 'strip-map position never goes backwards');
ok(maxPosJump < 0.06, 'strip-map position advances smoothly', `max ${maxPosJump.toFixed(4)} stops/sec`);
ok(Math.abs(lastPos - (stripTrain.stopCount - 1)) < 1e-6,
  'strip-map position ends exactly on the final stop', `${lastPos} of ${stripTrain.stopCount - 1}`);

/* ------------------------------------------------------------------ */
section('performance');

const t0 = performance.now();
let iterations = 0;
for (let i = 0; i < 600; i++) { sim.trainsAt(18 * 3600 + i * 0.016, contexts); iterations++; }
const ms = (performance.now() - t0) / iterations;
console.log(`  ${ms.toFixed(3)} ms per frame of simulation (${(1000 / ms).toFixed(0)} fps headroom)`);
ok(ms < 4, 'a full fleet resolves fast enough for 60 fps', `${ms.toFixed(2)} ms/frame`);

/* ------------------------------------------------------------------ */
console.log(`\n${'═'.repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('═'.repeat(62));
process.exit(fail ? 1 : 0);
