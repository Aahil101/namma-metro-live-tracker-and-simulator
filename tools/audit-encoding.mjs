/**
 * audit-encoding.mjs — find text mangled by a UTF-8 → cp1252 → UTF-8 round trip.
 *
 * Symptom: an em dash turns into a three-character sequence beginning with a
 * circumflex-a, a middot gains a capital-A-circumflex in front of it, and so on.
 * It happens when a tool reads UTF-8 bytes using the Windows ANSI codepage and
 * writes the result back out as UTF-8. The file stays *valid* UTF-8, so a plain
 * replacement-character check misses it entirely.
 *
 * (The examples above are described rather than written literally, so that this
 * file does not flag itself.)
 *
 * Detection: a lead byte in the C2–F4 range followed by continuation bytes,
 * where reversing the cp1252 decode yields a legitimate UTF-8 character.
 *
 *   node tools/audit-encoding.mjs            # report
 *   node tools/audit-encoding.mjs --fix      # repair in place
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = process.argv.includes('--fix');

/** cp1252 code points for bytes 0x80–0x9F (where it differs from latin-1). */
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/** Char -> the cp1252 byte it would have been decoded from, or null. */
function toCp1252Byte(ch) {
  const c = ch.codePointAt(0);
  if (c <= 0xff && !(c >= 0x80 && c <= 0x9f)) return c; // latin-1 range is identity
  if (CP1252_HIGH[c] !== undefined) return CP1252_HIGH[c];
  return null;
}

const CONT = '[\\u0080-\\u00FF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E'
  + '\\u0192\\u02C6\\u02DC\\u2013\\u2014\\u2018\\u2019\\u201A\\u201C\\u201D\\u201E'
  + '\\u2020\\u2021\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122]';
// a UTF-8 lead byte 0xC2–0xF4 shows up as Â–ô after a cp1252 misread
const MOJIBAKE = new RegExp(`[\\u00C2-\\u00F4]${CONT}{1,3}`, 'g');

const dec = new TextDecoder('utf-8', { fatal: false });

function repair(text) {
  let hits = 0;
  const out = text.replace(MOJIBAKE, (m) => {
    const bytes = [];
    for (const ch of m) {
      const b = toCp1252Byte(ch);
      if (b === null) return m;
      bytes.push(b);
    }
    const decoded = dec.decode(new Uint8Array(bytes));
    // only accept a clean decode that actually shortened the run
    if (decoded.includes('\uFFFD') || decoded.length >= m.length) return m;
    hits++;
    return decoded;
  });
  return { out, hits };
}

const TEXT_EXT = /\.(md|css|js|mjs|html|json|txt|yml|yaml|toml|sql)$/i;
const SKIP = /node_modules|[\\/]_data[\\/]|[\\/]\.git[\\/]|vendor[\\/]maplibre/;

const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p + path.sep)) continue;
    if (e.isDirectory()) walk(p, acc);
    else if (TEXT_EXT.test(e.name)) acc.push(p);
  }
  return acc;
};

const files = walk(ROOT);
let totalHits = 0, damaged = 0, asciiOnly = 0;

console.log(`scanning ${files.length} text files…\n`);

for (const f of files) {
  const raw = fs.readFileSync(f);
  const text = raw.toString('utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');

  const replacement = (text.match(/\uFFFD/g) || []).length;
  const { out, hits } = repair(text);

  // detect the other failure mode: non-ASCII silently flattened to '?'
  const suspiciousQ = (text.match(/\?{2,}|[A-Za-z]\?[A-Za-z]/g) || []).length;

  if (hits || replacement) {
    damaged++;
    totalHits += hits;
    console.log(`  DAMAGED  ${rel}`);
    if (replacement) console.log(`             ${replacement} replacement char(s) U+FFFD`);
    if (hits) {
      console.log(`             ${hits} mojibake sequence(s)`);
      // show a couple of examples
      const ex = [...text.matchAll(MOJIBAKE)].slice(0, 3).map((m) => {
        const r = repair(m[0]);
        return `"${m[0]}" → "${r.out}"`;
      });
      console.log(`             e.g. ${ex.join('  ')}`);
    }
    if (FIX) {
      fs.writeFileSync(f, out, 'utf8');
      console.log(`             FIXED`);
    }
  } else if (!/[^\x00-\x7F]/.test(text)) {
    asciiOnly++;
  }
}

console.log(`\n${'═'.repeat(58)}`);
if (damaged === 0) {
  console.log(`  clean — no mojibake in ${files.length} files (${asciiOnly} are pure ASCII)`);
} else {
  console.log(`  ${damaged} file(s) damaged, ${totalHits} sequence(s)${FIX ? ' — repaired' : ''}`);
  if (!FIX) console.log('  re-run with --fix to repair');
}
console.log('═'.repeat(58));
process.exit(!FIX && damaged ? 1 : 0);
