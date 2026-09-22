/**
 * fetch-gtfs.mjs — refresh the upstream BMRCL GTFS feed.
 *
 * Downloads the feed and unpacks it into _data/gtfs/ so build-data.mjs can run.
 * Includes a tiny ZIP reader (node:zlib + the central directory) to avoid
 * pulling in a dependency for one file.
 *
 *   node tools/fetch-gtfs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FEED = 'https://github.com/Vonter/bmrcl-gtfs/raw/main/gtfs/bmrcl.zip';
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, '_data');
const OUT = path.join(DATA, 'gtfs');

/* ------------------------------ zip reading ----------------------------- */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function unzip(buf) {
  // locate the End Of Central Directory record (scan back over the comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no EOCD record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // the local header repeats the name/extra, so skip past it to the data
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    files.push({
      name,
      data: method === 0 ? raw : zlib.inflateRawSync(raw),
    });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* --------------------------------- run ---------------------------------- */

fs.mkdirSync(DATA, { recursive: true });

console.log(`fetching ${FEED}`);
const res = await fetch(FEED, { redirect: 'follow' });
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(path.join(DATA, 'bmrcl.zip'), buf);
console.log(`  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const files = unzip(buf);
for (const f of files) {
  if (f.name.endsWith('/')) continue;
  const dest = path.join(OUT, path.basename(f.name));
  fs.writeFileSync(dest, f.data);
}
console.log(`  extracted ${files.length} tables to _data/gtfs`);

// surface the feed validity window so a stale feed is obvious
const info = path.join(OUT, 'feed_info.txt');
if (fs.existsSync(info)) {
  const [head, row] = fs.readFileSync(info, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  const vals = row.split(',');
  const get = (k) => vals[cols.indexOf(k)];
  console.log(`  feed version ${get('feed_version')} valid ${get('feed_start_date')} → ${get('feed_end_date')}`);
}

console.log('\nnow run:  node tools/build-data.mjs');
