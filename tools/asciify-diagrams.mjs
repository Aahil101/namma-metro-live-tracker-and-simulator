/**
 * asciify-diagrams.mjs — force every fenced code block in the README to ASCII.
 *
 * Box-drawing characters and typographic punctuation look nice but are fragile
 * inside code blocks: any tool that mishandles encoding destroys them, they
 * depend on font coverage, and the damage is invisible in a diff. This README
 * was corrupted twice that way. ASCII renders identically in every font,
 * terminal and editor, and cannot be broken by an encoding round trip.
 *
 * Prose outside code fences keeps its typography, where a stray character is
 * obvious and harmless.
 *
 *   node tools/asciify-diagrams.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '..', 'README.md');

/** Non-ASCII -> ASCII, for use inside code fences only. */
const MAP = new Map(Object.entries({
  // box drawing
  '\u2500': '-', '\u2501': '=', '\u2502': '|', '\u2503': '|',
  '\u250C': '+', '\u2510': '+', '\u2514': '+', '\u2518': '+',
  '\u251C': '+', '\u2524': '+', '\u252C': '+', '\u2534': '+', '\u253C': '+',
  '\u2550': '=', '\u2551': '|',
  '\u2554': '+', '\u2557': '+', '\u255A': '+', '\u255D': '+',
  '\u2560': '+', '\u2563': '+', '\u2566': '+', '\u2569': '+', '\u256C': '+',
  // arrows and markers
  '\u25B6': '>', '\u25BA': '>', '\u25BC': 'v', '\u25C0': '<',
  '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u21B3': '\\_',
  // punctuation
  '\u2014': '--', '\u2013': '-', '\u2026': '...',
  '\u00D7': 'x', '\u00B7': '*', '\u00A0': ' ',
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
}));

/** How many non-ASCII characters remain inside fences. Exported for check-readme. */
export function countNonAscii(text) {
  let fence = false, n = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('```')) { fence = !fence; continue; }
    if (fence) for (const ch of l) if (ch.codePointAt(0) > 0x7e) n++;
  }
  return n;
}

/** Rewrite every fenced block to ASCII. Returns how many characters changed. */
export function asciifyFences(md) {
  let inFence = false;
  let changed = 0;
  const unmapped = new Set();

  const out = md.split('\n').map((line) => {
    if (line.startsWith('```')) { inFence = !inFence; return line; }
    if (!inFence) return line;

    let result = '';
    for (const ch of line) {
      if (ch.codePointAt(0) <= 0x7e) { result += ch; continue; }
      const repl = MAP.get(ch);
      if (repl !== undefined) { result += repl; changed++; }
      else { result += '?'; changed++; unmapped.add('U+' + ch.codePointAt(0).toString(16).toUpperCase()); }
    }
    return result;
  }).join('\n');

  return { out, changed, unmapped: [...unmapped] };
}

/* ------------------------------------------------------------------ *
 *  CLI — only when run directly, so check-readme.mjs can import the
 *  helpers without rewriting the file as a side effect
 * ------------------------------------------------------------------ */

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const md = fs.readFileSync(FILE, 'utf8');
  const { out, changed, unmapped } = asciifyFences(md);
  if (unmapped.length) console.warn(`  unmapped characters: ${unmapped.join(', ')}`);
  fs.writeFileSync(FILE, out, 'utf8');
  console.log(`replaced ${changed} non-ASCII character(s) inside code fences`);
  console.log(`remaining: ${countNonAscii(fs.readFileSync(FILE, 'utf8'))}`);
}
