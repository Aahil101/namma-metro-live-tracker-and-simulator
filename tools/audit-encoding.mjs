/**
 * audit-encoding.mjs — find text mangled by a UTF-8 -> cp1252 -> UTF-8 round trip.
 *
 * Symptom: a box-drawing character or an em dash turns into two or three
 * accented-looking characters. It happens when a tool reads UTF-8 bytes using
 * the Windows ANSI codepage and writes the result back out as UTF-8. The file
 * stays *valid* UTF-8, so a replacement-character check misses it entirely.
 *
 * Detection is done character by character with no regex. An earlier version of
 * this file used a hand-written character class and silently failed to match
 * three-character sequences, reporting a damaged file as clean — so there is
 * deliberately nothing to mis-escape here.
 *
 * Algorithm: walk the decoded string. Wherever a run of consecutive characters
 * can each be mapped back to the single cp1252 byte it would have been decoded
 * from, and those bytes form a valid multi-byte UTF-8 sequence that is shorter
 * than the run, the run is mojibake and the decode is the repair.
 *
 *   node tools/audit-encoding.mjs            # report
 *   node tools/audit-encoding.mjs --fix      # repair in place
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = process.argv.includes('--fix');

/** cp1252 bytes 0x80-0x9F map to these code points; elsewhere it is latin-1. */
const HIGH_TO_BYTE = new Map(Object.entries({
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
}).map(([k, v]) => [Number(k), v]));

/**
 * Bytes 0x81, 0x8D, 0x8F, 0x90 and 0x9D are undefined in cp1252. Windows
 * decoders pass them through unchanged as the matching C1 control code point,
 * so they must be treated as identity — otherwise a character like U+2510 (┐),
 * whose UTF-8 third byte is 0x90, is not recognised as mojibake.
 */
const CP1252_PASSTHROUGH = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** The cp1252 byte this character would have been decoded from, or -1. */
function cpByte(code) {
  if (code <= 0xff) {
    if (CP1252_PASSTHROUGH.has(code)) return code;
    if (code >= 0x80 && code <= 0x9f) return -1;   // cp1252 maps these elsewhere
    return code;                                    // latin-1 identity
  }
  const b = HIGH_TO_BYTE.get(code);
  return b === undefined ? -1 : b;
}

/** How many continuation bytes a UTF-8 lead byte expects, or 0 if not a lead. */
function utf8Len(b) {
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0;
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * @returns {{out: string, hits: number, samples: string[]}}
 */
function repair(text) {
  let out = '';
  let hits = 0;
  const samples = [];

  for (let i = 0; i < text.length;) {
    const lead = cpByte(text.codePointAt(i));
    const need = lead < 0 ? 0 : utf8Len(lead);

    if (need) {
      // try to gather `need` characters that map to bytes
      const bytes = [lead];
      let j = i + 1;
      let okRun = true;
      for (let k = 1; k < need; k++) {
        if (j >= text.length) { okRun = false; break; }
        const b = cpByte(text.codePointAt(j));
        // continuation bytes are 0x80-0xBF
        if (b < 0x80 || b > 0xbf) { okRun = false; break; }
        bytes.push(b);
        j += String.fromCodePoint(text.codePointAt(j)).length;
      }

      if (okRun && bytes.length === need) {
        try {
          const decoded = strictDecoder.decode(new Uint8Array(bytes));
          // a real repair always shortens the text
          if (decoded.length < j - i) {
            if (samples.length < 4) samples.push(`${JSON.stringify(text.slice(i, j))} -> ${JSON.stringify(decoded)}`);
            out += decoded;
            hits++;
            i = j;
            continue;
          }
        } catch { /* not valid UTF-8, so not mojibake */ }
      }
    }

    const ch = String.fromCodePoint(text.codePointAt(i));
    out += ch;
    i += ch.length;
  }

  return { out, hits, samples };
}

/**
 * Count mojibake sequences in a string. Exported so tools/check-readme.mjs can
 * use the same detector instead of maintaining a second, weaker one.
 */
export function detectMojibake(text) {
  return repair(text).hits;
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

/* ------------------------------------------------------------------ *
 *  CLI — only when run directly, so check-readme.mjs can import the
 *  detector without triggering a full scan
 * ------------------------------------------------------------------ */

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isCli) {
  const files = walk(ROOT);
  let totalHits = 0, damaged = 0, asciiOnly = 0;

  console.log(`scanning ${files.length} text files…\n`);

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');

    const replacement = (text.match(/\uFFFD/g) || []).length;
    const { out, hits, samples } = repair(text);

    if (hits || replacement) {
      damaged++;
      totalHits += hits;
      console.log(`  DAMAGED  ${rel}`);
      if (replacement) console.log(`             ${replacement} replacement char(s) U+FFFD`);
      if (hits) {
        console.log(`             ${hits} mojibake sequence(s)`);
        console.log(`             e.g. ${samples.join('   ')}`);
      }
      if (FIX) {
        fs.writeFileSync(f, out, 'utf8');
        const again = repair(fs.readFileSync(f, 'utf8'));
        console.log(again.hits === 0 ? '             FIXED' : `             STILL ${again.hits} — run again`);
      }
    } else if (!/[^\x00-\x7F]/.test(text)) {
      asciiOnly++;
    }
  }

  console.log(`\n${'='.repeat(58)}`);
  if (damaged === 0) {
    console.log(`  clean — no mojibake in ${files.length} files (${asciiOnly} are pure ASCII)`);
  } else {
    console.log(`  ${damaged} file(s) damaged, ${totalHits} sequence(s)${FIX ? ' — repaired' : ''}`);
    if (!FIX) console.log('  re-run with --fix to repair');
  }
  console.log('='.repeat(58));
  process.exit(!FIX && damaged ? 1 : 0);
}
