/**
 * preflight.mjs — check the site is actually deployable before you push it.
 *
 * The failure mode this exists to catch: GitHub Pages project sites serve from
 * https://user.github.io/repo/, not from the domain root. Any absolute path
 * ("/js/main.js") silently 404s there while working perfectly on Netlify and
 * localhost. Same for a stray localhost URL left in a config.
 *
 *   node tools/preflight.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUB = path.join(ROOT, 'public');

let pass = 0, fail = 0, warn = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const caution = (label, extra = '') => { warn++; console.log(`  WARN  ${label}${extra ? '  ' + extra : ''}`); };
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 54 - s.length))}`);

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

const files = walk(PUB);
const rel = (p) => path.relative(PUB, p).replace(/\\/g, '/');
const textFiles = files.filter((f) => /\.(html|css|js|mjs|json|txt)$/i.test(f));

/* ------------------------------------------------------------------ */
section('required files');

for (const need of [
  'index.html', 'app.css', 'admin.html', 'admin.css',
  'js/main.js', 'js/simulation.js', 'js/geometry.js', 'js/clock.js',
  'js/map-view.js', 'js/ui.js', 'js/theme.js', 'js/sharecode.js',
  'js/analytics.js', 'js/feedback.js', 'js/config.js', 'js/admin.js',
  'data/network.json', 'data/schedule.json', 'data/meta.json',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
]) {
  ok(fs.existsSync(path.join(PUB, need)), `present: ${need}`);
}

/* ------------------------------------------------------------------ */
section('portability — must work from a subpath (GitHub Pages)');

// absolute-root references break on https://user.github.io/repo/
const absPatterns = [
  { re: /(?:src|href)\s*=\s*["']\/(?!\/)/g, what: 'absolute src/href' },
  { re: /url\(\s*["']?\/(?!\/)/g, what: 'absolute url() in CSS' },
  { re: /(?:fetch|import)\(\s*["']\/(?!\/)/g, what: 'absolute fetch/import' },
];

let absHits = [];
for (const f of textFiles) {
  if (rel(f).startsWith('vendor/')) continue;   // vendored lib, not ours
  const src = fs.readFileSync(f, 'utf8');
  for (const { re, what } of absPatterns) {
    for (const m of src.matchAll(re)) {
      absHits.push(`${rel(f)}: ${what} → ${m[0].trim()}`);
    }
  }
}
if (absHits.length) absHits.slice(0, 10).forEach((h) => console.log(`        ${h}`));
ok(absHits.length === 0, 'no root-absolute asset paths (site works from any subpath)',
  absHits.length ? `${absHits.length} found` : '');

// hardcoded localhost
const localHits = [];
for (const f of textFiles) {
  if (rel(f).startsWith('vendor/')) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1)[:\d]*/g)) {
    // a commented-out example is fine; flag only live code
    const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
    if (!/^\s*(\/\/|\*|#|<!--)/.test(line)) localHits.push(`${rel(f)}: ${m[0]}`);
  }
}
if (localHits.length) localHits.forEach((h) => console.log(`        ${h}`));
ok(localHits.length === 0, 'no live localhost URLs', localHits.length ? `${localHits.length} found` : '');

/* ------------------------------------------------------------------ */
section('module graph — every local import resolves');

const broken = [];
for (const f of textFiles.filter((f) => f.endsWith('.js'))) {
  if (rel(f).startsWith('vendor/')) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(target)) broken.push(`${rel(f)} → ${m[1]}`);
  }
}
if (broken.length) broken.forEach((b) => console.log(`        ${b}`));
ok(broken.length === 0, 'all relative imports resolve on disk', broken.length ? `${broken.length} broken` : '');

// every id referenced by getElementById exists in some HTML file
const html = ['index.html', 'admin.html']
  .map((f) => fs.readFileSync(path.join(PUB, f), 'utf8')).join('\n');
const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));

const missingIds = new Set();
for (const f of textFiles.filter((f) => f.endsWith('.js') && !rel(f).startsWith('vendor/'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
    if (!htmlIds.has(m[1])) missingIds.add(`${rel(f)} → #${m[1]}`);
  }
  // the $('x') helper used throughout
  for (const m of src.matchAll(/\$\(\s*'([a-z][a-z0-9-]{2,})'\s*\)/gi)) {
    if (!htmlIds.has(m[1])) missingIds.add(`${rel(f)} → #${m[1]}`);
  }
}
if (missingIds.size) [...missingIds].forEach((x) => console.log(`        ${x}`));
ok(missingIds.size === 0, 'every element id the JS looks up exists in the HTML',
  missingIds.size ? `${missingIds.size} missing` : `${htmlIds.size} ids declared`);

/* ------------------------------------------------------------------ */
section('data payload');

const net = JSON.parse(fs.readFileSync(path.join(PUB, 'data/network.json'), 'utf8'));
const sch = JSON.parse(fs.readFileSync(path.join(PUB, 'data/schedule.json'), 'utf8'));

ok(net.lines?.length === 3, 'three lines in network.json', `${net.lines?.length}`);
ok(Object.keys(net.stations || {}).length === 83, 'eighty-three stations',
  `${Object.keys(net.stations || {}).length}`);
ok(sch.patterns?.length === 19, 'nineteen stopping patterns', `${sch.patterns?.length}`);
ok(Object.keys(sch.departures || {}).length === 4, 'four service calendars',
  Object.keys(sch.departures || {}).join(','));

const feedEnd = JSON.parse(fs.readFileSync(path.join(PUB, 'data/meta.json'), 'utf8')).feed?.feed_end_date;
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
ok(feedEnd && feedEnd > today, 'timetable feed has not expired', `valid to ${feedEnd}`);
const daysLeft = feedEnd
  ? Math.round((Date.UTC(+feedEnd.slice(0, 4), +feedEnd.slice(4, 6) - 1, +feedEnd.slice(6, 8)) - Date.now()) / 86400000)
  : 0;
if (daysLeft < 60) caution(`feed expires in ${daysLeft} days — re-run tools/fetch-gtfs.mjs before then`);

/* ------------------------------------------------------------------ */
section('size & caching');

const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
const byDir = {};
for (const f of files) {
  const d = rel(f).includes('/') ? rel(f).split('/')[0] : '(root)';
  byDir[d] = (byDir[d] || 0) + fs.statSync(f).size;
}
for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) {
  console.log(`        ${d.padEnd(10)} ${(n / 1024).toFixed(0).padStart(6)} KB`);
}
console.log(`        ${'TOTAL'.padEnd(10)} ${(total / 1024).toFixed(0).padStart(6)} KB in ${files.length} files`);
ok(total < 4 * 1024 * 1024, 'payload comfortably under 4 MB', `${(total / 1024 / 1024).toFixed(2)} MB`);

ok(fs.existsSync(path.join(ROOT, 'netlify.toml')), 'netlify.toml present');
ok(fs.existsSync(path.join(ROOT, 'vercel.json')), 'vercel.json present');
ok(fs.existsSync(path.join(ROOT, '.github/workflows/deploy.yml')), 'GitHub Pages workflow present');

const nf = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
ok(/publish\s*=\s*"public"/.test(nf), 'netlify publishes ./public');

/* ------------------------------------------------------------------ */
section('secrets must not be in the payload');

const secretShapes = [
  { re: /aahil@1423/i, what: 'the admin password' },
  { re: /\b\d{4,7}:[A-Za-z0-9+/]{20,}={0,2}:[A-Za-z0-9+/]{40,}={0,2}/, what: 'a PBKDF2 secret' },
  { re: /(secret|session|apikey|api_key|token)\s*[:=]\s*['"`][A-Za-z0-9+/_-]{32,}={0,2}['"`]/i, what: 'a long key literal' },
  { re: /re_[A-Za-z0-9]{20,}/, what: 'a Resend API key' },
  { re: /gh[pousr]_[A-Za-z0-9]{30,}/, what: 'a GitHub token' },
];
const leaks = [];
for (const f of textFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const { re, what } of secretShapes) if (re.test(src)) leaks.push(`${rel(f)}: ${what}`);
}
if (leaks.length) leaks.forEach((l) => console.log(`        ${l}`));
ok(leaks.length === 0, 'no credential material in the deployable payload');

/* ------------------------------------------------------------------ */
section('API wiring');

const cfgRaw = fs.readFileSync(path.join(PUB, 'js/config.js'), 'utf8');
// strip comments first — this file documents the settings in prose, and the
// examples in those comments must not be mistaken for live configuration
const cfg = cfgRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const sameOrigin = /API_SAME_ORIGIN\s*=\s*true/.test(cfg);
const explicit = cfg.match(/export const API_BASE\s*=\s*['"]([^'"]+)['"]/);
if (sameOrigin || explicit) {
  console.log(`        API configured: ${sameOrigin ? 'same origin' : explicit[1]}`);
  ok(true, 'API_BASE is set — feedback and stats will persist');
} else {
  caution('API_BASE is empty — feedback queues locally and /admin shows no traffic',
    'deploy api/ then set it in public/js/config.js');
}

/* ------------------------------------------------------------------ */
console.log(`\n${'═'.repeat(58)}`);
console.log(`  ${pass} passed, ${fail} failed, ${warn} warning${warn === 1 ? '' : 's'}`);
console.log(fail ? '  NOT ready to deploy.' : '  Ready to deploy: publish directory is ./public');
console.log('═'.repeat(58));
process.exit(fail ? 1 : 0);
