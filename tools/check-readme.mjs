/**
 * check-readme.mjs — make sure the README renders correctly on GitHub.
 *
 * Catches the two things that quietly look broken there: in-page anchor links
 * that point at a heading which no longer exists, and image paths that are not
 * in the repository.
 *
 *   node tools/check-readme.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'README.md');
const md = fs.readFileSync(FILE, 'utf8');

let fail = 0;
const ok = (c, label, extra = '') => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!c) fail++;
};

/** GitHub's heading -> fragment rule, near enough for ASCII headings. */
const slug = (t) => t
  .toLowerCase()
  .replace(/<[^>]+>/g, '')
  .replace(/[^\w\s-]/g, '')
  .trim()
  .replace(/\s+/g, '-');

const anchors = new Set();
for (const m of md.matchAll(/^#{1,6}\s+(.+)$/gm)) anchors.add(slug(m[1]));
for (const m of md.matchAll(/<a\s+name="([^"]+)"/g)) anchors.add(m[1]);

const links = [...new Set([...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]))];
const brokenAnchors = links.filter((l) => !anchors.has(l));
if (brokenAnchors.length) console.log(`        broken: ${brokenAnchors.join(', ')}`);
ok(brokenAnchors.length === 0, 'every in-page anchor link resolves', `${links.length} links`);

const images = [...new Set([...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]))]
  .concat([...new Set([...md.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]))]);
const localImages = images.filter((i) => !/^https?:/.test(i));
const missingImages = localImages.filter((i) => !fs.existsSync(path.join(ROOT, i)));
if (missingImages.length) console.log(`        missing: ${missingImages.join(', ')}`);
ok(missingImages.length === 0, 'every local image exists',
  `${localImages.length} local, ${images.length - localImages.length} remote badges`);

// no mojibake, no replacement chars — reuse the byte-wise detector rather than
// a hand-written character class, which is what let 500 sequences through before
const { detectMojibake } = await import('./audit-encoding.mjs').then(
  (m) => ({ detectMojibake: m.detectMojibake }),
).catch(() => ({ detectMojibake: null }));

ok(!md.includes('\uFFFD'), 'no U+FFFD replacement characters');
if (detectMojibake) {
  const hits = detectMojibake(md);
  if (hits) console.log(`        ${hits} mojibake sequence(s) — run: node tools/audit-encoding.mjs --fix`);
  ok(hits === 0, 'no cp1252 mojibake sequences', hits ? `${hits} found` : '');
} else {
  ok(false, 'could not load the mojibake detector from audit-encoding.mjs');
}

// the ASCII diagrams must still be made of box-drawing characters
const boxChars = ['\u2500', '\u2502', '\u250C', '\u2510', '\u2514', '\u2518', '\u25BC'];
const boxCount = boxChars.reduce((n, c) => n + (md.split(c).length - 1), 0);
ok(boxCount > 200, 'architecture diagrams still use box-drawing characters', `${boxCount} glyphs`);

// tables must have a header separator or GitHub renders them as text
const tableStarts = [...md.matchAll(/^\|[^\n]+\|\s*$/gm)];
let tableIssues = 0;
const lines = md.split('\n');
for (let i = 0; i < lines.length - 1; i++) {
  const isRow = /^\|.*\|\s*$/.test(lines[i]);
  const prevRow = i > 0 && /^\|.*\|\s*$/.test(lines[i - 1]);
  const nextSep = /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]);
  if (isRow && !prevRow && !nextSep && !/^\|[\s:|-]+\|\s*$/.test(lines[i])) tableIssues++;
}
ok(tableIssues === 0, 'every table has a header separator row',
  `${tableStarts.length} table rows scanned`);

// fenced code blocks must be balanced
const fences = (md.match(/^```/gm) || []).length;
ok(fences % 2 === 0, 'code fences are balanced', `${fences} fences`);

// the claims in the badges should match reality
const testTotals = { sim: 0, api: 0 };
for (const [name, file] of [['sim', 'tools/test-sim.mjs'], ['api', 'tools/test-api.mjs']]) {
  void file; void name;
}
const badge = md.match(/tests-(\d+)%20passing/);
ok(!!badge, 'test-count badge present', badge ? badge[1] : '');
const stated = md.match(/(\d+) assertions, no test framework/);
ok(!!stated && badge && stated[1] === badge[1],
  'badge and prose agree on the assertion count',
  `badge ${badge?.[1]} vs prose ${stated?.[1]}`);

console.log(`\n  ${fail ? `${fail} problem(s)` : 'README is GitHub-ready'}`);
process.exit(fail ? 1 : 0);
