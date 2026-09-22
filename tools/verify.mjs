import fs from 'node:fs';
const n = JSON.parse(fs.readFileSync('public/data/network.json', 'utf8'));
const s = JSON.parse(fs.readFileSync('public/data/schedule.json', 'utf8'));

console.log('=== interchange / duplicate-name check ===');
for (const id of n.interchanges) {
  const st = n.stations[id];
  console.log(`${id.padEnd(6)} ${st.name.padEnd(34)} lines=${st.lines.join(',')}`);
}
const byName = {};
for (const st of Object.values(n.stations)) (byName[st.name] ||= []).push(st);
for (const [name, arr] of Object.entries(byName)) {
  if (arr.length > 1) console.log(`DUPLICATE NAME: ${name} -> ${arr.map((a) => a.id + '[' + a.lines + ']').join(' ')}`);
}

console.log('\n=== line station counts, and whether shared stations appear in both lists ===');
for (const l of n.lines) {
  console.log(`${l.name}: ${l.stations.length} -> ${l.stations.map((i) => n.stations[i].code).join(' ')}`);
}
const total = Object.keys(n.stations).length;
const sum = n.lines.reduce((a, l) => a + l.stations.length, 0);
console.log(`\nunique stations=${total}  sum of line lists=${sum}  overlap=${sum - total}`);

console.log('\n=== patterns ===');
for (const [i, p] of s.patterns.entries()) {
  console.log(
    `#${String(i).padStart(2)} ${p.line.padEnd(6)} dir${p.dir} ${String(p.stops.length).padStart(2)}st ` +
    `${(p.runtime / 60).toFixed(0).padStart(3)}min ${p.dist[p.dist.length - 1].toFixed(1).padStart(5)}km ` +
    `shape=${p.shape.padEnd(6)} ${n.stations[p.stops[0]].code}->${n.stations[p.stops[p.stops.length - 1]].code} to="${p.to}"`
  );
}

console.log('\n=== shape vs stop distance sanity (must cover the stop range) ===');
let bad = 0;
for (const p of s.patterns) {
  const sh = n.shapes[p.shape];
  if (!sh) { console.log(`MISSING SHAPE ${p.shape}`); bad++; continue; }
  const shMax = sh.dist[sh.dist.length - 1];
  const stMax = p.dist[p.dist.length - 1];
  const nondecreasing = p.dist.every((d, i) => i === 0 || d >= p.dist[i - 1]);
  if (!nondecreasing || stMax > shMax + 0.35) {
    console.log(`SUSPECT ${p.shape}: stopMax=${stMax} shapeMax=${shMax} monotonic=${nondecreasing}`);
    bad++;
  }
}
console.log(bad === 0 ? 'all patterns map cleanly onto their shape' : `${bad} suspect pattern(s)`);

console.log('\n=== trips per service ===');
for (const [k, v] of Object.entries(s.departures)) {
  const times = v.map((d) => d[1]);
  const f = (x) => `${String(Math.floor(x / 3600)).padStart(2, '0')}:${String(Math.floor(x / 60) % 60).padStart(2, '0')}`;
  console.log(`${k.padEnd(8)} ${String(v.length).padStart(4)} trips  window ${f(Math.min(...times))} - ${f(Math.max(...times))}`);
}

// how many trains are simultaneously in motion at a given clock time?
console.log('\n=== concurrent trains in motion (weekday) ===');
for (const hhmm of ['05:15', '06:30', '08:45', '11:00', '13:00', '18:00', '21:00', '23:30', '00:30']) {
  const [h, m] = hhmm.split(':').map(Number);
  let t = h * 3600 + m * 60;
  if (h < 4) t += 86400; // past-midnight services are encoded as 24:xx+
  const counts = {};
  for (const [pi, start] of s.departures.weekday) {
    const p = s.patterns[pi];
    if (t >= start && t <= start + p.runtime) counts[p.line] = (counts[p.line] || 0) + 1;
  }
  const tot = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${hhmm}  total=${String(tot).padStart(3)}  ${JSON.stringify(counts)}`);
}
