/**
 * sharecode.js — short human-typeable codes that identify one specific train run.
 *
 * A run is uniquely pinned down by three things:
 *   • which service day it belongs to   (so a code is unambiguous across days)
 *   • which trip pattern it follows     (route + direction + stopping pattern)
 *   • what second it left its origin
 *
 * Those pack into 34 bits, which Crockford base32 renders as 7 characters plus
 * a check character — short enough to read out over the phone:
 *
 *     MTR-4K7P-2XQ8
 *
 * Crockford's alphabet omits I, L, O and U, so "1" vs "I" and "0" vs "O" can't
 * be confused, and decoding accepts either case plus any punctuation.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));
// tolerate the classic look-alikes on input
for (const [wrong, right] of [['I', '1'], ['L', '1'], ['O', '0'], ['U', 'V']]) {
  DECODE.set(wrong, DECODE.get(right));
}

const EPOCH = Date.UTC(2024, 0, 1); // day 0 of the code space
const DAY_MS = 86400000;
const PREFIX = 'MTR';

/** YYYYMMDD -> whole days since 2024-01-01 */
function dayIndex(dateKey) {
  const y = +dateKey.slice(0, 4), m = +dateKey.slice(4, 6), d = +dateKey.slice(6, 8);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
}

/** inverse of dayIndex */
function dayKey(idx) {
  const t = new Date(EPOCH + idx * DAY_MS);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

function base32(value, chars) {
  let out = '';
  for (let i = chars - 1; i >= 0; i--) {
    out += ALPHABET[Math.floor(value / 32 ** i) % 32];
  }
  return out;
}

/**
 * @param {{patternIdx:number, start:number, dateKey:string}} run
 * @returns {string} e.g. "MTR-4K7P-2XQ8"
 */
export function encodeRun({ patternIdx, start, dateKey }) {
  const day = dayIndex(dateKey);
  if (day < 0 || day > 8191) throw new Error('date out of code range');
  if (patternIdx < 0 || patternIdx > 255) throw new Error('pattern out of range');

  // day(13) | pattern(8) | start seconds(17)  -> 38 bits, exact in a double
  const value = day * 256 * 131072 + patternIdx * 131072 + Math.round(start);
  const body = base32(value, 8);
  const check = ALPHABET[checksum(body)];
  const s = body + check;
  return `${PREFIX}-${s.slice(0, 4)}-${s.slice(4, 9)}`;
}

/**
 * @param {string} code
 * @returns {{patternIdx:number, start:number, dateKey:string}|null}
 */
export function decodeRun(code) {
  if (!code) return null;
  // strip the prefix, whitespace and any separators the user pasted
  let s = String(code).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (s.length !== 9) return null;

  const body = s.slice(0, 8);
  const check = s[8];
  for (const ch of body + check) if (!DECODE.has(ch)) return null;
  if (checksum(body) !== DECODE.get(check)) return null;

  let value = 0;
  for (const ch of body) value = value * 32 + DECODE.get(ch);

  const start = value % 131072;
  const patternIdx = Math.floor(value / 131072) % 256;
  const day = Math.floor(value / (131072 * 256));

  if (start > 100000 || day > 8191) return null;
  return { patternIdx, start, dateKey: dayKey(day) };
}

/** Simple positional checksum — catches single-character typos and swaps. */
function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += (DECODE.get(body[i]) + 1) * (i + 2);
  return sum % 32;
}

/** Pretty display grouping, for echoing a code the user typed. */
export function formatCode(code) {
  const s = String(code).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^MTR/, '');
  return `${PREFIX}-${s.slice(0, 4)}-${s.slice(4, 9)}`;
}

/** Shareable deep link for a run. */
export function shareUrl(code) {
  const u = new URL(window.location.href);
  u.hash = '';
  u.search = `?train=${encodeURIComponent(code.replace(/-/g, ''))}`;
  return u.toString();
}

/** Read a code out of ?train= on load. */
export function codeFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const raw = p.get('train') || p.get('t');
  return raw ? formatCode(raw) : null;
}
