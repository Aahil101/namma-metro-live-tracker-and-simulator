/**
 * diagnose-timing.mjs — investigate a reported timing discrepancy.
 *
 *   node tools/diagnose-timing.mjs "Beratena" 09:00
 */

import fs from 'node:fs';
import path from 'node:path';
import { Simulation } from '../public/js/simulation.js';
import { hhmm } from '../public/js/clock.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', f), 'utf8'));
const network = read('network.json');
const schedule = read('schedule.json');
const sim = new Simulation(network, schedule);

const query = (process.argv[2] || 'Beratena').toLowerCase();
const around = process.argv[3] || '09:00';
const [qh, qm] = around.split(':').map(Number);
const T = qh * 3600 + qm * 60;

const hhmmss = (s) => {
  const x = Math.round(s);
  return `${String(Math.floor(x / 3600) % 24).padStart(2, '0')}:${String(Math.floor(x / 60) % 60).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

/* ------------------------------------------------------------------ */
const match = Object.values(network.stations).filter((s) => s.name.toLowerCase().includes(query));
console.log(`stations matching "${query}":`);
for (const s of match) console.log(`  ${s.id.padEnd(6)} ${s.code.padEnd(6)} ${s.name}  lines=${s.lines.join(',')}`);
if (!match.length) process.exit(1);
const st = match[0];

/* ------------------------------------------------------------------ */
console.log(`\n=== scheduled calls at ${st.name} around ${around} (weekday) ===`);
console.log('    dir  pattern            arrival     departure   dwell   headsign');

const calls = sim.callsByStation.get(st.id) || [];
const starts = sim.startsByPattern.weekday;
const rows = [];
for (const [pi, si] of calls) {
  const p = schedule.patterns[pi];
  for (const start of (starts.get(pi) || [])) {
    const arr = start + p.arr[si];
    const dep = start + p.dep[si];
    if (Math.abs(arr - T) > 20 * 60) continue;
    rows.push({ pi, si, p, start, arr, dep });
  }
}
rows.sort((a, b) => a.arr - b.arr);
for (const r of rows) {
  console.log(`    ${r.p.dir}    #${String(r.pi).padStart(2)} ${String(r.p.stops.length).padStart(2)} stops   `
    + `${hhmmss(r.arr)}   ${hhmmss(r.dep)}   ${String(Math.round(r.dep - r.arr)).padStart(3)}s   -> ${r.p.to}`);
}

/* ------------------------------------------------------------------ */
console.log(`\n=== how "${around}-ish" renders in the UI ===`);
const sample = rows.find((r) => r.arr >= T - 120) || rows[0];
if (sample) {
  console.log(`  raw arrival   : ${hhmmss(sample.arr)}   (${sample.arr}s)`);
  console.log(`  raw departure : ${hhmmss(sample.dep)}   (${sample.dep}s)`);
  console.log(`  hhmm(arr)     : ${hhmm(sample.arr)}      <- what the departure board prints today`);
  console.log(`  hhmm(dep)     : ${hhmm(sample.dep)}`);
  console.log(`  round(arr)    : ${hhmm(Math.round(sample.arr / 60) * 60)}   <- if rounded to nearest minute`);
  const frac = sample.arr % 60;
  console.log(`  seconds part of arrival: ${frac}s  => flooring ${frac >= 30 ? 'LOSES ' + frac + 's (shows a minute early-looking value)' : 'is close to the minute'}`);
}

/* ------------------------------------------------------------------ */
console.log('\n=== modelled inter-station times on this line (are they plausible?) ===');
const line = network.lines.find((l) => st.lines.includes(l.id));
const full = schedule.patterns
  .filter((p) => p.line === line.id && p.stops.length === line.stations.length)
  .sort((a, b) => a.dir - b.dir)[0];

console.log(`  ${line.name} Line, direction ${full.dir}, ${full.stops.length} stops, runtime ${(full.runtime / 60).toFixed(1)} min`);
console.log('    from -> to                                     km    run     dwell   implied km/h');
let totalKm = 0, totalRun = 0, totalDwell = 0;
for (let i = 0; i < full.stops.length - 1; i++) {
  const km = full.dist[i + 1] - full.dist[i];
  const run = full.arr[i + 1] - full.dep[i];
  const dwell = full.dep[i] - full.arr[i];
  totalKm += km; totalRun += run; totalDwell += dwell;
  const kmh = run > 0 ? (km / run) * 3600 : 0;
  const a = network.stations[full.stops[i]].name.slice(0, 22);
  const b = network.stations[full.stops[i + 1]].name.slice(0, 22);
  const flag = st.id === full.stops[i] || st.id === full.stops[i + 1] ? '  <<<' : '';
  console.log(`    ${a.padEnd(23)}-> ${b.padEnd(23)} ${km.toFixed(2).padStart(5)} ${String(run).padStart(4)}s  ${String(dwell).padStart(4)}s  ${kmh.toFixed(1).padStart(6)}${flag}`);
}
console.log(`    ${'TOTAL'.padEnd(49)} ${totalKm.toFixed(2).padStart(5)} ${String(totalRun).padStart(4)}s  ${String(totalDwell).padStart(4)}s  `
  + `${((totalKm / totalRun) * 3600).toFixed(1).padStart(6)} avg moving`);
console.log(`    end-to-end including dwells: ${((totalKm / (totalRun + totalDwell)) * 3600).toFixed(1)} km/h`);

/* ------------------------------------------------------------------ */
console.log('\n=== where the cumulative error comes from ===');
console.log('  BMRCL publishes terminal times only. Intermediate times in this feed are');
console.log('  modelled from stop spacing, an assumed dwell and an assumed speed, so the');
console.log('  error accumulates with distance from the terminus.');
const idxInFull = full.stops.indexOf(st.id);
console.log(`\n  ${st.name} is stop ${idxInFull + 1} of ${full.stops.length} in direction ${full.dir}`);
console.log(`  ${full.dist[idxInFull].toFixed(2)} km from the origin, `
  + `${(full.arr[idxInFull] / 60).toFixed(1)} min into the run`);
const dwellAvg = totalDwell / (full.stops.length - 1);
console.log(`  average modelled dwell: ${dwellAvg.toFixed(1)}s across ${full.stops.length - 1} stops`);
console.log(`  a 2s-per-stop dwell error by here would be ${(idxInFull * 2 / 60).toFixed(1)} min of drift`);
