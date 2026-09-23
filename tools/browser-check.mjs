/**
 * browser-check.mjs — end-to-end check in a real headless Chrome.
 *
 * Drives the browser over the DevTools Protocol using Node's built-in
 * WebSocket, so there is nothing to install. It captures console output and
 * uncaught exceptions (the things a DOM dump hides) and then interrogates the
 * running app for evidence that trains are actually moving.
 *
 *   node tools/browser-check.mjs [url]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/';
const DEBUG_PORT = 9331;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const BROWSER = CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) { console.error('No Chrome/Edge found'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mmt-cdp-'));

const child = spawn(BROWSER, [
  '--headless=new',
  '--disable-gpu',
  '--enable-unsafe-swiftshader',   // software WebGL so MapLibre can render
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--mute-audio',
  '--window-size=1440,900',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let browserStderr = '';
child.stderr.on('data', (d) => { browserStderr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome never exposed a debuggable page');
}

/* ----------------------------- CDP plumbing ---------------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  /** Evaluate an expression in the page and return its value. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      // async IIFE so tests can `await` page promises directly
      expression: `(async () => { ${expr} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

/* -------------------------------- run ---------------------------------- */

const consoleMsgs = [];
const pageErrors = [];
const failedRequests = [];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      consoleMsgs.push({ level: msg.params.type, text });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') consoleMsgs.push({ level: 'error', text: `${e.text} ${e.url || ''}` });
    }
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(`${msg.params.type} ${msg.params.errorText}`);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  console.log(`\n── loading ${URL_TO_TEST} ${'─'.repeat(20)}`);
  await cdp.send('Page.navigate', { url: URL_TO_TEST });

  // wait until the app declares itself booted (or give up)
  let booted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      booted = await cdp.eval(`return !!(window.__metro && window.__metro.metro && window.__metro.metro.ready);`);
    } catch { /* page still evaluating */ }
    if (booted) break;
  }

  const bootMsg = await cdp.eval(`
    const b = document.getElementById('boot-msg');
    const boot = document.getElementById('boot');
    return { msg: b ? b.textContent : null, cls: boot ? boot.className : null, err: b ? b.className : null };
  `).catch(() => null);

  ok(booted, 'app reached a ready state', booted ? '' : `boot said: "${bootMsg?.msg}"`);
  ok(bootMsg?.cls?.includes('gone'), 'loading overlay dismissed', `class="${bootMsg?.cls}"`);
  ok(bootMsg?.err !== 'err', 'no fatal error on the boot card');

  if (!booted) {
    console.log('\n--- console output ---');
    for (const m of consoleMsgs.slice(0, 40)) console.log(`  [${m.level}] ${m.text}`);
    console.log('\n--- page errors ---');
    for (const e of pageErrors.slice(0, 20)) console.log(`  ${e}`);
    console.log('\n--- failed requests ---');
    for (const r of [...new Set(failedRequests)].slice(0, 20)) console.log(`  ${r}`);
    throw new Error('app did not boot');
  }

  /* ---------------------- state of the running app --------------------- */
  console.log(`\n── live state ${'─'.repeat(38)}`);

  // Pin the clock to evening peak. Namma Metro does not run between roughly
  // 00:30 and 05:00, so a suite that relies on the wall clock fails every night
  // for the wrong reason.
  const pinned = await cdp.eval(`
    const m = window.__metro;
    m.state.live = false;
    m.state.paused = false;
    m.state.speed = 1;
    m.state.simTime = 18 * 3600;
    await new Promise(r => setTimeout(r, 600));
    return { simTime: m.state.simTime, fleet: m.state.trainsById.size };
  `);
  console.log(`  clock pinned to 18:00 for determinism -> ${pinned.fleet} trains`);

  const snap = await cdp.eval(`
    const s = window.__metro.state;
    return {
      service: s.serviceId,
      lines: [...s.lines],
      trains: s.trainsById.size,
      clock: document.getElementById('clock').textContent,
      peak: document.getElementById('peak-badge').textContent,
      svcBadge: document.getElementById('service-badge').textContent,
      statTrains: document.getElementById('stat-trains').textContent,
      rows: document.querySelectorAll('.train-row').length,
      groups: document.querySelectorAll('.group-label').length,
      chips: document.querySelectorAll('.freq-chip').length,
      lineRows: document.querySelectorAll('.line-row').length,
      counts: [...document.querySelectorAll('[data-count]')].map(e => e.textContent),
      canvas: !!document.querySelector('.maplibregl-canvas'),
      styleLoaded: window.__metro.metro.map.isStyleLoaded(),
      mapLoaded: window.__metro.metro.map.loaded(),
      sources: Object.keys(window.__metro.metro.map.getStyle().sources),
      layers: window.__metro.metro.map.getStyle().layers.filter(l => /train|line-|station/.test(l.id)).map(l => l.id),
    };
  `);

  console.log(`  service=${snap.service}  clock=${snap.clock}  peak="${snap.peak}"  fleet=${snap.trains}`);
  console.log(`  per-line counts: ${snap.counts.join(' / ')}`);
  console.log(`  styleLoaded=${snap.styleLoaded} mapLoaded=${snap.mapLoaded} sources=${snap.sources.length}`);

  ok(snap.service, 'a service is resolved', snap.svcBadge);
  ok(/^\d\d:\d\d:\d\d$/.test(snap.clock), 'clock is rendering a time', snap.clock);
  ok(snap.trains > 10, 'a fleet of trains is live', `${snap.trains} trains`);
  ok(Number(snap.statTrains) > 10, 'header stat matches', snap.statTrains);
  ok(snap.rows > 10, 'train list is populated', `${snap.rows} rows`);
  ok(snap.groups >= 3, 'train list grouped by line', `${snap.groups}`);
  ok(snap.chips === 3, 'three frequency chips', `${snap.chips}`);
  ok(snap.lineRows === 3, 'three line toggles', `${snap.lineRows}`);
  ok(snap.counts.filter((c) => Number(c) > 0).length === 3, 'every line has running trains');
  ok(snap.canvas, 'WebGL canvas created');
  ok(snap.sources.includes('metro-lines') && snap.sources.includes('trains') && snap.sources.includes('stations'),
    'metro sources registered', snap.sources.join(','));
  for (const need of ['line-body', 'station-halo', 'station-label', 'train-icon', 'train-glow']) {
    ok(snap.layers.includes(need), `layer present: ${need}`);
  }

  /* --------- overlays must really be hidden, not just have [hidden] -------- */
  // A panel that sets `display: flex` will beat the UA rule for [hidden], so
  // check the computed style rather than trusting the attribute.
  const overlays = await cdp.eval(`
    const ids = ['modal','share-modal','station-panel','train-panel','tracking-chip','boot'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = { attr: el.hidden, display: getComputedStyle(el).display, vis: getComputedStyle(el).visibility };
    }
    return out;
  `);
  for (const [id, o] of Object.entries(overlays)) {
    if (id === 'boot') {
      ok(o.vis === 'hidden' || o.display === 'none', 'boot overlay is not covering the map',
        `display=${o.display} visibility=${o.vis}`);
    } else {
      ok(o.display === 'none', `${id} is genuinely hidden on load`, `display=${o.display}`);
    }
  }

  /* ------------------ layout: nothing may spill its container ------------- */
  console.log(`\n── layout containment ${'─'.repeat(30)}`);
  const layout = await cdp.eval(`
    const within = (child, parent, slack = 3) => {
      const a = child.getBoundingClientRect(), b = parent.getBoundingClientRect();
      return a.left >= b.left - slack && a.right <= b.right + slack
          && a.top >= b.top - slack && a.bottom <= b.bottom + slack;
    };
    // for scroll containers only horizontal containment is meaningful —
    // rows below the fold are supposed to be outside the visible box
    const withinX = (child, parent, slack = 3) => {
      const a = child.getBoundingClientRect(), b = parent.getBoundingClientRect();
      return a.left >= b.left - slack && a.right <= b.right + slack;
    };
    const sidebar = document.getElementById('sidebar');
    const lineList = document.getElementById('line-list');
    const trainList = document.getElementById('train-list');
    const lineRows = [...document.querySelectorAll('.line-row')];
    const trainRows = [...document.querySelectorAll('.train-row')].slice(0, 12);
    const vw = window.innerWidth, vh = window.innerHeight;

    const offscreen = [...document.querySelectorAll('.line-row, .train-row, .freq-chip')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.right > vw + 2 || r.left < -2; })
      .map(el => el.className + ': ' + el.textContent.trim().slice(0, 40));

    // text wider than its own box means it is visually spilling
    const overflowing = [...document.querySelectorAll('.line-row, .train-row, .dep-row')]
      .filter(el => el.scrollWidth > el.clientWidth + 2)
      .map(el => el.textContent.trim().slice(0, 44));

    const stacked = (aSel, bSel) => {
      const a = document.querySelector(aSel), b = document.querySelector(bSel);
      if (!a || !b) return false;
      return b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom - 1;
    };

    return {
      lineRowCount: lineRows.length,
      lineRowsInside: lineRows.every(r => within(r, lineList)),
      lineRowsInSidebar: lineRows.every(r => within(r, sidebar)),
      trainRowsInside: trainRows.every(r => withinX(r, trainList)),
      trainListScrolls: trainList.scrollHeight > trainList.clientHeight,
      trainListNoXScroll: trainList.scrollWidth <= trainList.clientWidth + 2,
      lineRowHeights: lineRows.map(r => Math.round(r.getBoundingClientRect().height)),
      lineListH: Math.round(lineList.getBoundingClientRect().height),
      lineCardH: Math.round(lineList.closest('.card').getBoundingClientRect().height),
      offscreen, overflowing,
      nameStacked: stacked('.line-name', '.line-sub'),
      destStacked: stacked('.train-dest', '.train-where'),
    };
  `);
  console.log(`  line rows: ${layout.lineRowCount}, heights ${layout.lineRowHeights.join('/')}, list ${layout.lineListH}px inside a ${layout.lineCardH}px card`);
  if (layout.offscreen.length) console.log(`  offscreen: ${layout.offscreen.join(' | ')}`);
  if (layout.overflowing.length) console.log(`  overflowing: ${layout.overflowing.join(' | ')}`);

  ok(layout.lineRowCount === 3, 'all three line rows exist', `${layout.lineRowCount}`);
  ok(layout.lineRowsInside, 'line rows stay inside the line list');
  ok(layout.lineRowsInSidebar, 'line rows stay inside the sidebar');
  ok(layout.trainRowsInside, 'train rows stay within the list width');
  ok(layout.trainListNoXScroll, 'train list has no horizontal scroll');
  ok(layout.offscreen.length === 0, 'nothing has escaped the viewport horizontally');
  ok(layout.overflowing.length === 0, 'no row overflows its own box');
  ok(layout.nameStacked, 'line name and route are on separate lines');
  ok(layout.destStacked, 'train route and status are on separate lines');

  // fixed chrome must not cover each other — the zoom buttons and the OSM
  // attribution were previously hidden underneath the time bar
  const overlaps = await cdp.eval(`
    const sel = {
      timebar: '.timebar',
      zoom: '.maplibregl-ctrl-group',
      attribution: '.maplibregl-ctrl-attrib',
      datanote: '.datanote',
      topbar: '.topbar',
      sidebar: '#sidebar',
    };
    const els = {};
    for (const [k, s] of Object.entries(sel)) {
      const el = document.querySelector(s);
      if (el && getComputedStyle(el).display !== 'none') els[k] = el.getBoundingClientRect();
    }
    const hits = (a, b) => !(a.right <= b.left + 1 || a.left >= b.right - 1 ||
                             a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
    const clashes = [];
    const pairs = [
      ['timebar','zoom'], ['timebar','attribution'],
      ['topbar','sidebar'], ['zoom','attribution'], ['sidebar','zoom'],
    ];
    for (const [a, b] of pairs) {
      if (els[a] && els[b] && hits(els[a], els[b])) clashes.push(a + ' / ' + b);
    }
    const inView = (r) => r.top >= -1 && r.bottom <= window.innerHeight + 1
                       && r.left >= -1 && r.right <= window.innerWidth + 1;
    const tb = document.querySelector('.timebar');
    const dn = document.querySelector('.datanote');
    return {
      clashes,
      present: Object.keys(els),
      zoomInView: els.zoom ? inView(els.zoom) : false,
      attribInView: els.attribution ? inView(els.attribution) : false,
      // the note is deliberately inside the time bar now
      noteInsideTimebar: !!(tb && dn && tb.contains(dn) && inView(dn.getBoundingClientRect())),
      freqNoWrapClash: (() => {
        const fs = document.getElementById('freq-strip');
        return fs ? fs.getBoundingClientRect().right <= dn.getBoundingClientRect().left + 1 : false;
      })(),
    };
  `);
  if (overlaps.clashes.length) console.log(`  clashes: ${overlaps.clashes.join(', ')}`);
  ok(overlaps.clashes.length === 0, 'no two pieces of fixed chrome overlap');
  ok(overlaps.zoomInView, 'zoom controls are fully on screen');
  ok(overlaps.attribInView, 'OSM/BMRCL attribution is fully visible');
  ok(overlaps.noteInsideTimebar, 'the accuracy note sits inside the time bar, fully visible');
  ok(overlaps.freqNoWrapClash, 'frequency chips and the note do not collide');

  /* ---------------------------- movement ------------------------------ */
  console.log(`\n── movement over 3 s ${'─'.repeat(31)}`);

  const before = await cdp.eval(`
    const s = window.__metro.state;
    const out = {};
    for (const [id, t] of s.trainsById) out[id] = [t.lon, t.lat, t.distKm];
    return out;
  `);
  await sleep(3000);
  const after = await cdp.eval(`
    const s = window.__metro.state;
    const out = {};
    for (const [id, t] of s.trainsById) out[id] = [t.lon, t.lat, t.distKm];
    return out;
  `);

  let moved = 0, same = 0, maxAdvance = 0;
  for (const id of Object.keys(before)) {
    if (!after[id]) continue;
    const d = after[id][2] - before[id][2];
    if (d > 0.0005) moved++; else same++;
    maxAdvance = Math.max(maxAdvance, d);
  }
  console.log(`  ${moved} trains advanced, ${same} stationary (dwelling), max ${(maxAdvance * 1000).toFixed(0)} m in 3 s`);
  ok(moved > 5, 'trains are advancing along their lines', `${moved} moving`);
  ok(maxAdvance * 1000 > 30 && maxAdvance * 1000 < 300, 'advance per 3 s is plausible',
    `${(maxAdvance * 1000).toFixed(0)} m`);

  const fps = await cdp.eval(`
    return new Promise(res => {
      let n = 0; const t0 = performance.now();
      const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
      requestAnimationFrame(tick);
    });
  `);
  // Headless uses SwiftShader (software WebGL) so raw fps says little about a
  // real GPU. What matters is that frames keep coming and that our own
  // per-frame work is negligible next to MapLibre's draw.
  const cost = await cdp.eval(`
    const m = window.__metro;
    const ctx = [{ service: m.state.serviceId, offset: 0, dateKey: m.state.todayKey }];
    const t = m.state.simTime;
    // warm up
    for (let i = 0; i < 20; i++) m.sim.trainsAt(t, ctx);
    const t0 = performance.now();
    const N = 120;
    for (let i = 0; i < N; i++) {
      const trains = m.sim.trainsAt(t + i * 0.016, ctx);
      m.metro.renderTrains(trains, () => '');
    }
    return (performance.now() - t0) / N;
  `);
  console.log(`  render loop: ~${fps} fps under software WebGL`);
  console.log(`  app cost per frame: ${cost.toFixed(2)} ms (simulate + push GeoJSON)`);
  ok(fps >= 3, 'animation loop keeps producing frames', `${fps} fps`);
  ok(cost < 8, 'our own per-frame work leaves room for 60 fps', `${cost.toFixed(2)} ms/frame`);

  /* -------------------------- interactions ---------------------------- */
  console.log(`\n── interactions ${'─'.repeat(36)}`);

  const trainPanel = await cdp.eval(`
    const m = window.__metro;
    // pick a train that is genuinely mid-journey, so the marker has room to move
    const cand = [...m.state.trainsById.values()]
      .filter(t => t.status === 'moving' && t.nextIdx !== null && t.stopCount - t.nextIdx > 4)
      .sort((a, b) => a.progress - b.progress)[0]
      || [...m.state.trainsById.values()][0];
    m.ui.selectTrain(cand.id, false);
    m.ui.updateTrainPanel(cand);
    m.ui.updateStripLive(cand);
    return {
      hidden: document.getElementById('train-panel').hidden,
      route: document.getElementById('tp-route').textContent,
      speed: document.getElementById('tp-speed').textContent,
      next: document.getElementById('tp-next').textContent,
      eta: document.getElementById('tp-eta').textContent,
      stops: document.querySelectorAll('.strip-stop').length,
      past: document.querySelectorAll('.strip-stop.past').length,
      nextMarked: document.querySelectorAll('.strip-stop.next').length,
      markerTop: document.getElementById('strip-train').style.top,
      doneH: document.getElementById('strip-done').style.height,
      remaining: document.getElementById('tp-remaining').textContent,
      gauge: document.getElementById('tp-gauge-bar').style.width,
      progress: cand.progress,
    };
  `);
  console.log(`  panel: ${trainPanel.route}`);
  console.log(`         speed=${trainPanel.speed} next=${trainPanel.next} in ${trainPanel.eta}`);
  console.log(`         strip: ${trainPanel.stops} stops (${trainPanel.past} passed), marker at ${trainPanel.markerTop}, ${trainPanel.remaining}`);
  ok(!trainPanel.hidden, 'train panel opens on select');
  ok(/→/.test(trainPanel.route), 'panel shows the route');
  ok(/km\/h/.test(trainPanel.speed), 'panel shows speed', trainPanel.speed);
  ok(trainPanel.next.length > 1, 'panel shows the next station', trainPanel.next);
  ok(trainPanel.stops > 4, 'strip map rendered its stations', `${trainPanel.stops}`);
  ok(trainPanel.nextMarked === 1, 'exactly one stop is flagged as next');
  ok(/px$/.test(trainPanel.markerTop), 'strip marker positioned', trainPanel.markerTop);
  ok(/px$/.test(trainPanel.doneH), 'travelled portion of the rail is filled', trainPanel.doneH);
  ok(/%$/.test(trainPanel.gauge), 'speed gauge has a width', trainPanel.gauge);

  // the strip marker must physically move
  const m1 = await cdp.eval(`return document.getElementById('strip-train').style.top;`);
  await sleep(2500);
  const m2 = await cdp.eval(`
    const m = window.__metro;
    const t = m.state.trainsById.get(m.state.selectedTrainId);
    if (t) m.ui.updateStripLive(t);
    return document.getElementById('strip-train').style.top;
  `);
  ok(parseFloat(m2) > parseFloat(m1), 'strip marker slides forward as the train moves', `${m1} -> ${m2}`);

  const board = await cdp.eval(`
    const m = window.__metro;
    m.ui.openStation('KGWA');
    m.ui.updateStationBoard(m.state.simTime, [
      { service: m.state.serviceId, offset: 0, dateKey: m.state.todayKey },
    ]);
    return {
      hidden: document.getElementById('station-panel').hidden,
      name: document.getElementById('sp-name').textContent,
      rows: document.querySelectorAll('.dep-row').length,
      dirs: document.querySelectorAll('.dep-dir').length,
      first: document.querySelector('.dep-row') ? document.querySelector('.dep-row').textContent : '',
    };
  `);
  console.log(`  board: ${board.name} — ${board.rows} departures in ${board.dirs} directions`);
  ok(!board.hidden, 'station board opens');
  ok(board.rows > 3, 'station board lists departures', `${board.rows}`);
  ok(board.dirs >= 2, 'departures split by direction', `${board.dirs}`);

  /* ------------------------ share / track flow ------------------------ */
  console.log(`\n── share & track ${'─'.repeat(35)}`);

  const share = await cdp.eval(`
    const m = window.__metro;
    const id = [...m.state.trainsById.keys()][3];
    m.ui.selectTrain(id, false);
    m.ui.openShare();
    const code = document.getElementById('share-code').textContent;
    const haveHidden = document.getElementById('share-have').hidden;
    // now pretend a friend pasted it
    m.ui.stopTracking();
    const accepted = m.ui.trackCode(code);
    m.ui.updateTracking([...m.state.trainsById.values()], m.state.simTime);
    return {
      code, haveHidden, accepted,
      tracked: m.state.tracked ? m.state.tracked.code : null,
      trackedTrainId: m.state.trackedTrainId,
      matchesSelected: m.state.trackedTrainId === id,
      chipHidden: document.getElementById('tracking-chip').hidden,
      chipWhere: document.getElementById('tc-where').textContent,
      mapTracked: m.metro.trackedId,
      rejectsGarbage: m.ui.trackCode('MTR-ZZZZ-ZZZZZ') === false,
    };
  `);
  console.log(`  code ${share.code} -> tracking ${share.tracked}`);
  console.log(`  chip: "${share.chipWhere}"`);
  ok(/^MTR-[0-9A-Z]{4}-[0-9A-Z]{5}$/.test(share.code), 'a share code is generated', share.code);
  ok(!share.haveHidden, 'share panel reveals the code');
  ok(share.accepted, 'the code is accepted when pasted back');
  ok(share.matchesSelected, 'the code resolves to the same train that was shared');
  ok(!share.chipHidden, 'tracking chip is shown');
  ok(share.chipWhere.length > 3, 'chip describes where the train is', share.chipWhere);
  ok(share.rejectsGarbage, 'an invalid code is rejected');

  // dimming: every other train must be flagged dim on the map
  const dim = await cdp.eval(`
    const m = window.__metro;
    m.metro.renderTrains([...m.state.trainsById.values()], () => '');
    // GeoJSONSource#serialize() is the supported way to read back what we set
    const src = (name) => {
      const s = m.metro.map.getSource(name);
      const ser = s.serialize ? s.serialize() : null;
      return (ser && ser.data) || s._data || { features: [] };
    };
    const data = src('trains');
    const tracked = src('train-tracked');
    return {
      total: data.features.length,
      dimmed: data.features.filter(f => f.properties.dim).length,
      trackedFeatures: tracked.features.length,
      label: tracked.features[0] ? tracked.features[0].properties.label : null,
    };
  `);
  console.log(`  map: ${dim.dimmed}/${dim.total} trains dimmed, tracked marker label "${dim.label}"`);
  ok(dim.trackedFeatures === 1, 'tracked train has its own highlight feature');
  ok(dim.dimmed === dim.total - 1, 'every other train is dimmed', `${dim.dimmed}/${dim.total}`);
  ok(dim.label === share.code, 'highlight is labelled with the code');

  const cleared = await cdp.eval(`
    const m = window.__metro;
    m.ui.stopTracking();
    m.metro.renderTrains([...m.state.trainsById.values()], () => '');
    const s = m.metro.map.getSource('trains');
    const ser = s.serialize ? s.serialize() : null;
    const data = (ser && ser.data) || s._data || { features: [] };
    return {
      dimmed: data.features.filter(f => f.properties.dim).length,
      chipHidden: document.getElementById('tracking-chip').hidden,
    };
  `);
  ok(cleared.dimmed === 0 && cleared.chipHidden, 'stopping tracking restores the fleet');

  /* ----------------------- deep link ---------------------------------- */
  const deepUrl = `${URL_TO_TEST.replace(/\/$/, '')}/?train=${share.code.replace(/-/g, '')}`;
  console.log(`\n── deep link ${'─'.repeat(39)}`);
  console.log(`  ${deepUrl}`);
  await cdp.send('Page.navigate', { url: deepUrl });
  let deepOk = false, deepInfo = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      deepInfo = await cdp.eval(`
        const m = window.__metro;
        if (!m || !m.metro.ready) return null;
        return {
          tracked: m.state.tracked ? m.state.tracked.code : null,
          chipHidden: document.getElementById('tracking-chip').hidden,
        };
      `);
      if (deepInfo?.tracked) { deepOk = true; break; }
    } catch { /* still booting */ }
  }
  ok(deepOk, 'a ?train= link starts tracking on load', deepInfo?.tracked || '');
  ok(deepInfo && !deepInfo.chipHidden, 'deep link shows the tracking chip');

  /* --------------------- time travel ---------------------------------- */
  console.log(`\n── time travel ${'─'.repeat(37)}`);
  const tt = await cdp.eval(`
    const m = window.__metro;
    m.state.live = false;
    m.state.simTime = 3 * 3600;   // 03:00, network shut
    return new Promise(res => setTimeout(() => res({
      night: m.state.trainsById.size,
      badge: document.getElementById('peak-badge').textContent,
      empty: document.querySelector('.train-list .empty') ? true : false,
    }), 600));
  `);
  console.log(`  03:00 -> ${tt.night} trains, badge "${tt.badge}"`);
  ok(tt.night === 0, 'no trains at 03:00');
  ok(/no service/i.test(tt.badge), 'badge reports no service', tt.badge);
  ok(tt.empty, 'list shows an empty-state message');

  const tt2 = await cdp.eval(`
    const m = window.__metro;
    m.state.simTime = 18 * 3600;
    return new Promise(res => setTimeout(() => res({
      evening: m.state.trainsById.size,
      badge: document.getElementById('peak-badge').textContent,
    }), 600));
  `);
  console.log(`  18:00 -> ${tt2.evening} trains, badge "${tt2.badge}"`);
  ok(tt2.evening > 30, 'evening peak repopulates the map', `${tt2.evening} trains`);
  ok(/peak/i.test(tt2.badge), 'badge reports peak hours', tt2.badge);

  /* ------------------------- theme switching --------------------------- */
  console.log(`\n── theming ${'─'.repeat(41)}`);

  const themeBefore = await cdp.eval(`
    const m = window.__metro;
    return {
      attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
      txt: getComputedStyle(document.body).color,
      purple: m.metro.lineColor('PURPLE'),
      yellow: m.metro.lineColor('YELLOW'),
      basemap: m.metro.t.basemap,
      hasSunIcon: getComputedStyle(document.querySelector('#btn-theme .icon-sun')).display,
    };
  `);

  await cdp.eval(`window.__metro.ui.toggleTheme(); return 'ok';`);
  // the map rebuild is async: setStyle -> styledata -> re-add every layer
  let themeAfter = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    themeAfter = await cdp.eval(`
      const m = window.__metro;
      if (!m.metro.ready) return null;
      return {
        attr: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        purple: m.metro.lineColor('PURPLE'),
        yellow: m.metro.lineColor('YELLOW'),
        basemap: m.metro.t.basemap,
        layers: m.metro.map.getStyle().layers.filter(l => /train|line-|station|scrim/.test(l.id)).map(l => l.id),
        sources: Object.keys(m.metro.map.getStyle().sources),
        trainFeatures: (() => {
          const s = m.metro.map.getSource('trains');
          const ser = s && s.serialize ? s.serialize() : null;
          return ((ser && ser.data) || s._data || { features: [] }).features.length;
        })(),
        swatch: document.querySelector('.line-swatch').style.background,
        themeColorMeta: document.querySelector('meta[name=theme-color]').getAttribute('content'),
        stored: localStorage.getItem('nml.theme'),
        sunShown: getComputedStyle(document.querySelector('#btn-theme .icon-sun')).display,
        moonShown: getComputedStyle(document.querySelector('#btn-theme .icon-moon')).display,
      };
    `);
    if (themeAfter?.attr === 'light') break;
  }

  const lum = (rgb) => {
    const m = String(rgb).match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
  };
  const hexLum = (h) => {
    const n = parseInt(String(h).replace('#', ''), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };

  console.log(`  dark : bg ${themeBefore.bg}  purple ${themeBefore.purple}  yellow ${themeBefore.yellow}`);
  console.log(`  light: bg ${themeAfter?.bg}  purple ${themeAfter?.purple}  yellow ${themeAfter?.yellow}`);
  console.log(`  basemap ${themeBefore.basemap.split('/').pop()} → ${themeAfter?.basemap.split('/').pop()}`);

  ok(themeAfter?.attr === 'light', 'data-theme switches to light');
  ok(lum(themeAfter.bg) > lum(themeBefore.bg) + 80, 'page background actually gets lighter',
    `${Math.round(lum(themeBefore.bg))} → ${Math.round(lum(themeAfter.bg))}`);
  ok(themeAfter.basemap !== themeBefore.basemap, 'basemap style URL changes');
  ok(!/dark/.test(themeAfter.basemap), 'light theme uses a non-dark basemap', themeAfter.basemap.split('/').pop());
  ok(hexLum(themeAfter.yellow) < hexLum(themeBefore.yellow) - 40,
    'Yellow Line is darkened for the light basemap',
    `${Math.round(hexLum(themeBefore.yellow))} → ${Math.round(hexLum(themeAfter.yellow))}`);
  ok(hexLum(themeAfter.purple) < hexLum(themeBefore.purple),
    'Purple Line is darkened too');
  for (const need of ['scrim', 'line-body', 'station-halo', 'station-label', 'train-icon', 'train-glow']) {
    ok(themeAfter.layers.includes(need), `layer rebuilt after theme swap: ${need}`);
  }
  ok(themeAfter.sources.includes('trains') && themeAfter.sources.includes('metro-lines'),
    'sources rebuilt after theme swap');
  ok(themeAfter.trainFeatures > 5, 'the fleet is repainted immediately after the swap',
    `${themeAfter.trainFeatures} trains`);
  ok(themeAfter.stored === 'light', 'theme choice is persisted');
  ok(themeAfter.themeColorMeta !== '#0a0d14', 'theme-color meta updated', themeAfter.themeColorMeta);
  ok(themeAfter.sunShown !== 'none' && themeAfter.moonShown === 'none', 'toggle shows the sun icon in light mode');
  ok(themeAfter.swatch && themeAfter.swatch !== '', 'line swatches recoloured', themeAfter.swatch);

  // and back again
  await cdp.eval(`window.__metro.ui.toggleTheme(); return 'ok';`);
  let backDark = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    backDark = await cdp.eval(`
      const m = window.__metro;
      if (!m.metro.ready) return null;
      return { attr: document.documentElement.getAttribute('data-theme'), purple: m.metro.lineColor('PURPLE') };
    `);
    if (backDark?.attr === 'dark') break;
  }
  ok(backDark?.attr === 'dark' && backDark.purple === themeBefore.purple, 'switching back restores the dark palette');

  /* ------------------------ playback controls -------------------------- */
  console.log(`\n── playback ${'─'.repeat(40)}`);

  const noOldSeg = await cdp.eval(`return !document.getElementById('speed-seg');`);
  ok(noOldSeg, 'the old 1× / 10× / 60× control is gone');

  const play = await cdp.eval(`
    const m = window.__metro, s = m.state, out = {};
    out.startedLive = s.live;
    m.ui.togglePlay();                       // pause from live
    out.afterPause = { live: s.live, paused: s.paused,
                       notch: document.getElementById('speed-notch').textContent,
                       mult: document.getElementById('speed-mult').textContent,
                       bodyPaused: document.body.classList.contains('is-paused') };
    const t0 = s.simTime;
    return new Promise(res => setTimeout(() => {
      out.frozen = Math.abs(s.simTime - t0) < 0.5;
      m.ui.togglePlay();                     // resume
      out.afterResume = { paused: s.paused, mult: document.getElementById('speed-mult').textContent };
      res(out);
    }, 900));
  `);
  console.log(`  pause → ${JSON.stringify(play.afterPause)}`);
  ok(play.afterPause.paused === true, 'play/pause pauses the simulation');
  ok(play.afterPause.live === false, 'pausing drops out of live mode');
  ok(play.afterPause.mult === 'paused', 'readout says "paused"', play.afterPause.mult);
  ok(play.afterPause.bodyPaused, 'is-paused class drives the play icon');
  ok(play.frozen, 'the clock does not advance while paused');
  ok(play.afterResume.paused === false, 'pressing again resumes');

  // walk the whole ladder from the bottom and record notch + multiplier
  const ladder = await cdp.eval(`
    const m = window.__metro;
    const read = () => ({
      speed: m.state.speed,
      notch: document.getElementById('speed-notch').textContent,
      mult: document.getElementById('speed-mult').textContent,
      slowerOff: document.getElementById('btn-slower').disabled,
      fasterOff: document.getElementById('btn-faster').disabled,
    });
    for (let i = 0; i < 12; i++) m.ui.stepRate(-1);   // bottom out
    const seen = [read()];
    for (let i = 0; i < 12; i++) { m.ui.stepRate(+1); seen.push(read()); }
    return seen;
  `);
  const uniq = [...new Map(ladder.map((r) => [r.speed, r])).values()];
  console.log(`  ladder: ${uniq.map((r) => `${r.notch}=${r.mult}`).join('  ')}`);

  const speeds = uniq.map((r) => r.speed);
  ok(JSON.stringify(speeds) === JSON.stringify([0.25, 0.5, 1, 1.5, 2, 4, 8, 16, 32]),
    'ladder is 0.25× … 32× including slow motion', JSON.stringify(speeds));
  const notches = uniq.map((r) => r.notch);
  ok(JSON.stringify(notches) === JSON.stringify(['\u22122', '\u22121', '0', '+1', '+2', '+3', '+4', '+5', '+6']),
    'notches read −2 … 0 … +6', notches.join(' '));
  ok(uniq.find((r) => r.speed === 1).notch === '0', 'real time is notch 0');
  ok(uniq.find((r) => r.speed === 0.25).slowerOff, 'slower disables at the bottom of the ladder');
  ok(uniq.find((r) => r.speed === 32).fasterOff, 'faster disables at the top of the ladder');
  ok(uniq.find((r) => r.speed === 0.5).mult === '0.5×', 'fractional rates format cleanly',
    uniq.find((r) => r.speed === 0.5).mult);
  ok(uniq.find((r) => r.speed === 1.5).mult === '1.5×', '1.5× formats without trailing zeros');
  ok(uniq.find((r) => r.speed === 32).mult === '32×', 'integer rates have no decimal point');

  // custom speed
  const custom = await cdp.eval(`
    const m = window.__metro;
    m.ui.toggleCustom(true);
    const openState = { hidden: document.getElementById('speed-custom').hidden,
                        presets: document.querySelectorAll('.sc-preset').length,
                        expanded: document.getElementById('speed-read').getAttribute('aria-expanded') };
    document.getElementById('speed-input').value = '7.5';
    document.getElementById('sc-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    const after = { speed: m.state.speed,
                    notch: document.getElementById('speed-notch').textContent,
                    mult: document.getElementById('speed-mult').textContent,
                    isCustom: document.getElementById('speed-read').classList.contains('is-custom'),
                    closed: document.getElementById('speed-custom').hidden };
    // stepping from a custom value must snap to the ladder
    m.ui.stepRate(+1);  const up = m.state.speed;
    m.ui.setRate(7.5);
    m.ui.stepRate(-1);  const down = m.state.speed;
    // clamping
    m.ui.setRate(9999); const hi = m.state.speed;
    m.ui.setRate(0);    const lo = m.state.speed;
    return { openState, after, up, down, hi, lo };
  `);
  console.log(`  custom 7.5× → notch ${custom.after.notch}, ${custom.after.mult}; step up ${custom.up}×, down ${custom.down}×`);
  console.log(`  clamping: 9999 → ${custom.hi}×, 0 → ${custom.lo}×`);
  ok(!custom.openState.hidden, 'the custom speed popover opens');
  ok(custom.openState.presets === 9, 'popover lists every ladder preset', `${custom.openState.presets}`);
  ok(custom.openState.expanded === 'true', 'aria-expanded is set');
  ok(custom.after.speed === 7.5, 'a hand-typed speed is applied', `${custom.after.speed}`);
  ok(custom.after.mult === '7.5×', 'custom multiplier is displayed', custom.after.mult);
  ok(custom.after.notch === '~+4', 'custom speeds show an approximate notch', custom.after.notch);
  ok(custom.after.isCustom, 'the readout is flagged as custom');
  ok(custom.after.closed, 'submitting closes the popover');
  ok(custom.up === 8 && custom.down === 4, 'stepping from a custom value snaps to the ladder',
    `up ${custom.up}, down ${custom.down}`);
  ok(custom.hi === 240, 'an absurd speed clamps to the maximum', `${custom.hi}`);
  ok(custom.lo === 0.05, 'zero clamps to the minimum', `${custom.lo}`);

  // keyboard: + / − / 0
  const keys = await cdp.eval(`
    const m = window.__metro;
    const fire = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    m.ui.setLive(true);
    fire('+'); const a = m.state.speed;
    fire('+'); const b = m.state.speed;
    fire('-'); const c = m.state.speed;
    fire('0'); const d = { speed: m.state.speed, live: m.state.live };
    return { a, b, c, d };
  `);
  console.log(`  keys: + → ${keys.a}×, + → ${keys.b}×, − → ${keys.c}×, 0 → ${keys.d.speed}× (live ${keys.d.live})`);
  ok(keys.a === 1.5 && keys.b === 2, '"+" steps the rate up');
  ok(keys.c === 1.5, '"−" steps the rate down');
  ok(keys.d.speed === 1 && keys.d.live === true, '"0" returns to real time and live');

  // the multiplier must actually scale the clock, at both extremes
  const scaling = await cdp.eval(`
    const m = window.__metro, s = m.state;
    const measure = (rate) => new Promise(res => {
      s.live = false; s.paused = false; s.speed = rate; s.simTime = 12 * 3600;
      const t0 = s.simTime;
      setTimeout(() => res((s.simTime - t0)), 1000);
    });
    const fast = await measure(32);
    const slow = await measure(0.25);
    return { fast, slow };
  `);
  console.log(`  32× advanced ${scaling.fast.toFixed(1)} s in 1 s;  0.25× advanced ${scaling.slow.toFixed(2)} s`);
  ok(scaling.fast > 20 && scaling.fast < 45, '32× advances the clock ~32× real time', `${scaling.fast.toFixed(1)}×`);
  ok(scaling.slow > 0.1 && scaling.slow < 0.5, '0.25× runs in slow motion', `${scaling.slow.toFixed(2)}×`);

  // trains must still move sanely at the top of the ladder
  const fastMotion = await cdp.eval(`
    const m = window.__metro, s = m.state;
    s.live = false; s.paused = false; s.speed = 32; s.simTime = 18 * 3600;
    await new Promise(r => setTimeout(r, 400));
    const before = new Map([...s.trainsById].map(([id, t]) => [id, t.distKm]));
    await new Promise(r => setTimeout(r, 1000));
    let moved = 0, bad = 0;
    for (const [id, t] of s.trainsById) {
      if (!before.has(id)) continue;
      const d = t.distKm - before.get(id);
      if (d > 0.01) moved++;
      if (d < -0.001) bad++;            // never reverse, even at 32×
      if (!Number.isFinite(t.lon) || !Number.isFinite(t.lat)) bad++;
    }
    s.live = true; s.speed = 1;
    return { moved, bad, fleet: s.trainsById.size };
  `);
  console.log(`  at 32×: ${fastMotion.moved} trains advanced, ${fastMotion.bad} anomalies, fleet ${fastMotion.fleet}`);
  ok(fastMotion.moved > 10, 'trains still advance at 32×', `${fastMotion.moved}`);
  ok(fastMotion.bad === 0, 'no reversals or invalid coordinates at 32×');

  await cdp.eval(`window.__metro.ui.setLive(true); return 'ok';`);
  const backLive = await cdp.eval(`
    const s = window.__metro.state;
    return { live: s.live, speed: s.speed, paused: s.paused,
             notch: document.getElementById('speed-notch').textContent,
             mult: document.getElementById('speed-mult').textContent };
  `);
  ok(backLive.live && backLive.speed === 1 && !backLive.paused, 'GO LIVE resets rate and unpauses');
  ok(backLive.notch === '0' && backLive.mult === '1×', 'readout returns to notch 0 / 1×',
    `${backLive.notch} ${backLive.mult}`);

  /* --------------------------- feedback -------------------------------- */
  console.log(`\n── feedback ${'─'.repeat(40)}`);

  const fb = await cdp.eval(`
    const m = window.__metro;
    m.ui.openFeedback();
    const visible = getComputedStyle(document.getElementById('fb-modal')).display !== 'none';
    document.getElementById('fb-msg').value = '';
    await m.ui.submitFeedback();
    const emptyMsg = document.getElementById('fb-msg-out').textContent;

    document.getElementById('fb-msg').value = 'Automated test: Hosa Road timing looks 2 min early.';
    document.getElementById('fb-msg').dispatchEvent(new Event('input'));
    const counter = document.getElementById('fb-count').textContent;
    const mailto = document.getElementById('fb-mailto').getAttribute('href');
    await m.ui.submitFeedback();
    const outMsg = document.getElementById('fb-msg-out').textContent;
    const queued = JSON.parse(localStorage.getItem('nml.fb.queue') || '[]');
    document.getElementById('fb-modal').hidden = true;
    return { visible, emptyMsg, counter, mailto, outMsg, queuedCount: queued.length,
             queuedKind: queued.length ? queued[queued.length-1].kind : null,
             hasContext: queued.length ? !!queued[queued.length-1].context : false };
  `);
  console.log(`  counter "${fb.counter}"  queued ${fb.queuedCount}`);
  console.log(`  no-api message: ${fb.outMsg.slice(0, 80)}`);
  ok(fb.visible, 'feedback dialog opens');
  ok(/write a message/i.test(fb.emptyMsg), 'empty feedback is rejected', fb.emptyMsg);
  ok(/\d+ \/ 2000/.test(fb.counter), 'character counter updates', fb.counter);
  ok(fb.mailto.startsWith('mailto:heworld2046@gmail.com'), 'mailto fallback targets the owner');
  ok(/subject=/.test(fb.mailto) && /body=/.test(fb.mailto), 'mailto is pre-filled with subject and body');
  ok(fb.queuedCount > 0, 'with no API the message is queued locally, not lost');
  ok(fb.hasContext, 'queued feedback carries reproduction context');
  ok(/saved in this browser/i.test(fb.outMsg), 'the user is told it was queued', fb.outMsg.slice(0, 60));

  /* ------------------------- admin dashboard --------------------------- */
  console.log(`\n── admin dashboard ${'─'.repeat(33)}`);

  const adminUrl = `${URL_TO_TEST.replace(/\/$/, '')}/admin.html`;
  await cdp.send('Page.navigate', { url: adminUrl });

  let admReady = false, adm = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    adm = await cdp.eval(`
      if (!window.__admin) return null;
      return {
        gateVisible: getComputedStyle(document.getElementById('gate')).display !== 'none',
        dashHidden: document.getElementById('dash').hidden,
        note: document.getElementById('gate-note').textContent.trim(),
        title: document.title,
        robots: document.querySelector('meta[name=robots]')?.getAttribute('content'),
        hasPasswordField: document.getElementById('gp')?.type === 'password',
      };
    `).catch(() => null);
    if (adm) { admReady = true; break; }
  }
  ok(admReady, 'admin page loads');
  ok(adm?.gateVisible && adm?.dashHidden, 'the dashboard is gated');
  ok(/noindex/.test(adm?.robots || ''), 'admin page is noindex', adm?.robots);
  ok(adm?.hasPasswordField, 'the password field is type=password');

  // the local gate must reject wrong credentials and accept the right ones
  const wrongPw = await cdp.eval(`
    document.getElementById('gu').value = 'nammametro';
    document.getElementById('gp').value = 'definitely-not-the-password';
    document.getElementById('gate-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 400));
    return { dashHidden: document.getElementById('dash').hidden,
             msg: document.getElementById('gate-msg').textContent };
  `);
  ok(wrongPw.dashHidden, 'a wrong password does not open the dashboard');
  ok(/invalid/i.test(wrongPw.msg), 'a wrong password reports an error', wrongPw.msg);

  const wrongUser = await cdp.eval(`
    document.getElementById('gu').value = 'admin';
    document.getElementById('gp').value = 'nammametro@14231423';
    document.getElementById('gate-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('dash').hidden;
  `);
  ok(wrongUser, 'a wrong username does not open the dashboard');

  // no plaintext password, and no server secret, in anything the browser downloads
  const secrets = await cdp.eval(`
    const urls = ['./js/admin.js', './js/config.js', './js/feedback.js', './js/analytics.js',
                  './js/visits.js', './js/main.js', './js/ui.js', './admin.html', './index.html'];
    const out = {};
    for (const u of urls) out[u] = await (await fetch(u)).text();
    const all = Object.values(out).join('\\n');
    return {
      bytes: all.length,
      plaintextPw:  /nammametro@\\d/i.test(all),
      oldPw:        /aahil@\\d/i.test(all),
      pbkdf2Secret: /\\b\\d{4,7}:[A-Za-z0-9+/]{20,}={0,2}:[A-Za-z0-9+/]{40,}={0,2}/.test(all),
      privateKey:   /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(all),
      hasDigest:    /digest:\\s*'[0-9a-f]{64}'/.test(all),
      saysNotSecurity: /not security/i.test(all),
    };
  `);
  console.log(`  scanned ${secrets.bytes} bytes of everything the browser downloads`);
  ok(!secrets.plaintextPw, 'the password never appears in plaintext');
  ok(!secrets.oldPw, 'no previously used password lingers in the payload');
  ok(!secrets.pbkdf2Secret, 'no server PBKDF2 secret in the client');
  ok(!secrets.privateKey, 'no private key in the client');
  ok(secrets.hasDigest, 'the local gate ships a digest (expected, and documented as weak)');
  ok(secrets.saysNotSecurity, 'the code states plainly that the local gate is not security');

  // correct credentials open the dashboard, showing this browser's own history
  const good = await cdp.eval(`
    localStorage.setItem('nml.visits', JSON.stringify({
      total: 12, first: '2026-09-14T04:00:00.000Z', last: new Date().toISOString(),
      days: { '2026-09-18': 2, '2026-09-19': 3, '2026-09-20': 1, '2026-09-22': 6 }
    }));
    localStorage.setItem('nml.fb.queue', JSON.stringify([
      { kind: 'bug', message: 'Test report', context: {}, at: new Date().toISOString() }
    ]));
    document.getElementById('gu').value = 'nammametro';
    document.getElementById('gp').value = 'nammametro@14231423';
    document.getElementById('gate-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 1000));
    return {
      dashShown: !document.getElementById('dash').hidden,
      banner: document.getElementById('adm-banner').textContent.replace(/\\s+/g,' ').trim(),
      views: document.getElementById('kpi-views').textContent,
      viewsSub: document.getElementById('kpi-sess').textContent,
      live: document.getElementById('kpi-live').textContent,
      liveSub: document.getElementById('kpi-live').closest('.kpi').querySelector('.kpi-sub').textContent,
      activeDays: document.getElementById('kpi-surge').textContent,
      fb: document.getElementById('kpi-fb').textContent,
      bars: document.querySelectorAll('#chart-days rect').length,
      lists: [...document.querySelectorAll('.bl-empty')].map(e => e.textContent.slice(0, 30)),
    };
  `);
  console.log(`  signed in: ${good.views} total visits, ${good.activeDays} active days, ${good.bars} chart bars`);
  ok(good.dashShown, 'correct credentials open the dashboard');
  ok(good.views === '12', 'total local visits are shown', good.views);
  ok(good.activeDays === '4', 'active-day count is derived from local history', good.activeDays);
  ok(good.fb === '1', 'queued feedback count is shown', good.fb);
  ok(good.bars >= 4, 'the visits chart renders bars', `${good.bars}`);
  ok(good.live === '\u2014' && /needs the API/i.test(good.liveSub),
    'concurrent users is blank without a backend, not invented', `${good.live} / ${good.liveSub}`);
  ok(/this browser only/i.test(good.banner), 'a banner states the figures are this browser only',
    good.banner.slice(0, 70));
  ok(good.lists.length >= 4, 'referrers/countries/devices explain they need the API');

  const signedOut = await cdp.eval(`
    document.getElementById('adm-logout').click();
    await new Promise(r => setTimeout(r, 200));
    return { gate: getComputedStyle(document.getElementById('gate')).display !== 'none',
             dashHidden: document.getElementById('dash').hidden };
  `);
  ok(signedOut.gate && signedOut.dashHidden, 'sign out returns to the gate');


  /* ------------------ maintenance & ground-truth corrections ----------- */
  console.log(`\n── maintenance restriction ${'─'.repeat(25)}`);

  // the admin checks navigated away; come back to the map before testing its UI
  await cdp.send('Page.navigate', { url: URL_TO_TEST });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const up = await cdp.eval(`return Boolean(window.__metro && window.__metro.metro && window.__metro.metro.ready);`)
      .catch(() => false);
    if (up) break;
  }
  await cdp.eval(`
    const m = window.__metro;
    localStorage.removeItem('nml.shrunk');
    m.ui.setShrunk(false);
    m.state.live = false; m.state.paused = false; m.state.simTime = 18 * 3600;
    await new Promise(r => setTimeout(r, 500));
    return 'ok';
  `);

  const maint = await cdp.eval(`
    const m = window.__metro;
    const layers = m.metro.map.getStyle().layers.map(l => l.id);
    const src = m.metro.map.getSource('maintenance');
    const ser = src && src.serialize ? src.serialize() : null;
    const data = (ser && ser.data) || src._data || { features: [] };

    // find a Green Line train inside the restriction
    m.state.simTime = 18 * 3600;
    let hit = null, scanned = 0;
    for (let t = 18 * 3600; t < 18 * 3600 + 1800 && !hit; t += 3) {
      const trains = m.sim.trainsAt(t, [{ service: m.state.serviceId, offset: 0, dateKey: m.state.todayKey }]);
      scanned++;
      hit = trains.find(x => x.restrictedNow) || null;
    }
    const tm = hit ? m.sim.timing(hit.patternIdx) : null;
    return {
      layers: ['maint-black','maint-yellow','maint-label'].filter(id => layers.includes(id)),
      sections: data.features.length,
      label: data.features[0] ? data.features[0].properties.label : null,
      dashBlack: m.metro.map.getPaintProperty('maint-black','line-dasharray'),
      dashYellow: m.metro.map.getPaintProperty('maint-yellow','line-dasharray'),
      found: !!hit,
      speed: hit ? hit.speedKmh : null,
      line: hit ? hit.line : null,
      cap: hit ? hit.restriction.maxSpeedKmh : null,
      delayed: tm ? tm.delayed : null,
    };
  `);
  console.log(`  layers ${maint.layers.join(', ')} · ${maint.sections} section(s) · label "${maint.label}"`);
  console.log(`  restricted train: ${maint.line} at ${maint.speed?.toFixed(1)} km/h (cap ${maint.cap}), run +${maint.delayed?.toFixed(0)}s`);
  ok(maint.layers.length === 3, 'all three hazard layers exist', maint.layers.join(','));
  ok(maint.sections === 1, 'one restricted section is drawn', `${maint.sections}`);
  ok(/MAINTENANCE/.test(maint.label || ''), 'the section is labelled on the map', maint.label);
  ok(/25/.test(maint.label || ''), 'the label carries the speed limit');
  ok(JSON.stringify(maint.dashBlack) === '[2,2]' && JSON.stringify(maint.dashYellow) === '[0,2,2]',
    'black and yellow dashes are complementary, so they alternate');
  ok(maint.found, 'a train is found inside the restriction');
  ok(maint.speed <= maint.cap + 0.5, 'its speed is capped at the limit', `${maint.speed?.toFixed(1)} <= ${maint.cap}`);
  ok(maint.line === 'GREEN', 'the restriction applies to the Green Line', maint.line);
  ok(maint.delayed > 30 && maint.delayed < 120, 'the run absorbs a plausible delay', `+${maint.delayed?.toFixed(0)}s`);

  console.log(`\n── ground-truth corrections ${'─'.repeat(24)}`);

  const correction = await cdp.eval(`
    const m = window.__metro;
    localStorage.removeItem('nml.observations');
    m.ui.reloadCorrections();

    m.state.simTime = 18 * 3600;
    await new Promise(r => setTimeout(r, 400));

    // pick a moving train with plenty of run left
    const train = [...m.state.trainsById.values()]
      .filter(t => t.status === 'moving' && t.nextIdx !== null && t.stopCount - t.nextIdx > 5)[0];
    m.ui.selectTrain(train.id, false);
    m.ui.updateTrainPanel(train);

    const markText = document.getElementById('tp-mark-btn').textContent.replace(/\\s+/g,' ').trim();
    const nextName = m.sim.stations[train.nextStation].name;
    const before = { km: train.distKm, eta: train.etaNext };

    // the user says it has already arrived at the next station, ~90s early
    m.state.istSec = m.state.simTime;
    m.ui.markArrivedNow();
    await new Promise(r => setTimeout(r, 700));

    const after = m.state.trainsById.get(train.id);
    const strip = document.getElementById('correction-strip');
    const adj = document.getElementById('tp-adjusted');
    return {
      markText, nextName,
      hadButton: markText.toLowerCase().includes('already arrived'),
      mentionsStation: markText.includes(nextName),
      before,
      afterKm: after ? after.distKm : null,
      adjustSec: after ? after.adjustSec : null,
      adjustKind: after ? after.adjustKind : null,
      stripShown: !strip.hidden,
      stripText: document.getElementById('cs-text').textContent,
      adjShown: !adj.hidden,
      adjText: adj.textContent.replace(/\\s+/g,' ').trim().slice(0, 150),
      stored: JSON.parse(localStorage.getItem('nml.observations') || '[]').length,
    };
  `);
  console.log(`  button: "${correction.markText}"`);
  console.log(`  after marking: offset ${correction.adjustSec}s (${correction.adjustKind}), km ${correction.before.km.toFixed(2)} -> ${correction.afterKm?.toFixed(2)}`);
  console.log(`  strip: "${correction.stripText}"`);
  ok(correction.hadButton, 'the train panel offers "already arrived?"');
  ok(correction.mentionsStation, 'the button names the next station', correction.nextName);
  ok(correction.stored === 1, 'the observation is stored', `${correction.stored}`);
  ok(correction.adjustSec !== 0 && correction.adjustSec !== null, 'the run is shifted', `${correction.adjustSec}s`);
  ok(correction.adjustKind === 'exact', 'the shift is an exact, per-run correction', correction.adjustKind);
  ok(correction.afterKm > correction.before.km, 'a train reported early is moved further along',
    `${correction.before.km.toFixed(2)} -> ${correction.afterKm?.toFixed(2)} km`);
  ok(correction.stripShown, 'a red strip warns the data is user-adjusted');
  ok(/report/i.test(correction.stripText), 'the strip explains why', correction.stripText.slice(0, 60));
  ok(correction.adjShown && /not the published timetable/i.test(correction.adjText),
    'the panel states these are not published times');

  // the correction must spread to other trains on the same line + direction
  const spread = await cdp.eval(`
    const m = window.__metro;
    const obs = JSON.parse(localStorage.getItem('nml.observations'))[0];
    const others = [...m.state.trainsById.values()]
      .filter(t => t.line === obs.line && t.dir === obs.dir && t.id !== obs.trainId);
    return {
      line: obs.line, dir: obs.dir,
      total: others.length,
      inferred: others.filter(t => t.adjustKind === 'inferred').length,
      exact: others.filter(t => t.adjustKind === 'exact').length,
      untouched: [...m.state.trainsById.values()].filter(t => t.line !== obs.line && t.adjustSec).length,
    };
  `);
  console.log(`  spread: ${spread.inferred}/${spread.total} other ${spread.line} dir${spread.dir} trains inferred`);
  ok(spread.inferred === spread.total && spread.total > 0,
    'other trains on that line and direction inherit an inferred shift', `${spread.inferred}/${spread.total}`);
  ok(spread.untouched === 0, 'trains on other lines are left on the published timetable');

  const reset = await cdp.eval(`
    const m = window.__metro;
    m.ui.resetCorrections();
    await new Promise(r => setTimeout(r, 500));
    return {
      stored: JSON.parse(localStorage.getItem('nml.observations') || '[]').length,
      stripHidden: document.getElementById('correction-strip').hidden,
      anyAdjusted: [...m.state.trainsById.values()].filter(t => t.adjustSec).length,
    };
  `);
  ok(reset.stored === 0 && reset.stripHidden && reset.anyAdjusted === 0,
    'reset clears every correction and hides the strip');

  /* ---------------------- shrink mode & folding ------------------------ */
  console.log(`\n── shrink mode ${'─'.repeat(37)}`);

  const shrink = await cdp.eval(`
    const m = window.__metro;
    const vis = (sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return cs.opacity !== '0' && cs.pointerEvents !== 'none'
        && r.right > 0 && r.left < window.innerWidth
        && r.bottom > 0 && r.top < window.innerHeight;
    };
    const before = { sidebar: vis('#sidebar'), timebar: vis('.timebar'),
                     chips: !document.getElementById('shrunk-bar').hidden };

    m.ui.setShrunk(true);
    await new Promise(r => setTimeout(r, 500));
    const after = {
      sidebar: vis('#sidebar'), timebar: vis('.timebar'),
      chips: !document.getElementById('shrunk-bar').hidden,
      bodyClass: document.body.classList.contains('is-shrunk'),
      pressed: document.getElementById('btn-shrink').getAttribute('aria-pressed'),
      stored: localStorage.getItem('nml.shrunk'),
      chipCount: document.getElementById('chip-count').textContent,
      chipClock: document.getElementById('chip-clock').textContent,
      mapVisible: !!document.querySelector('.maplibregl-canvas'),
      zoomBottom: getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-right')).bottom,
    };

    // the chip restores everything
    document.getElementById('chip-panels').click();
    await new Promise(r => setTimeout(r, 500));
    const restored = { sidebar: vis('#sidebar'), timebar: vis('.timebar'),
                       chips: !document.getElementById('shrunk-bar').hidden,
                       stored: localStorage.getItem('nml.shrunk') };
    return { before, after, restored };
  `);
  console.log(`  before: sidebar=${shrink.before.sidebar} timebar=${shrink.before.timebar}`);
  console.log(`  shrunk: sidebar=${shrink.after.sidebar} timebar=${shrink.after.timebar} chips=${shrink.after.chips}`);
  console.log(`  chips show ${shrink.after.chipCount} trains at ${shrink.after.chipClock}`);

  ok(shrink.before.sidebar && shrink.before.timebar, 'panels start visible');
  ok(!shrink.after.sidebar, 'shrink hides the sidebar');
  ok(!shrink.after.timebar, 'shrink hides the time bar');
  ok(shrink.after.chips, 'corner chips appear while shrunk');
  ok(shrink.after.bodyClass && shrink.after.pressed === 'true', 'shrink state is reflected on body and button');
  ok(shrink.after.stored === '1', 'shrink preference is persisted');
  ok(/^\d+$/.test(shrink.after.chipCount) && /^\d\d:\d\d$/.test(shrink.after.chipClock),
    'chips mirror the live train count and clock', `${shrink.after.chipCount} / ${shrink.after.chipClock}`);
  ok(shrink.after.mapVisible, 'the map is still rendering while shrunk');
  ok(shrink.after.zoomBottom === '10px', 'map controls drop to the corner when the time bar goes',
    shrink.after.zoomBottom);
  ok(shrink.restored.sidebar && shrink.restored.timebar && !shrink.restored.chips,
    'the corner chip restores every panel');
  ok(shrink.restored.stored === '0', 'restoring clears the stored preference');

  const keyZ = await cdp.eval(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const on = document.body.classList.contains('is-shrunk');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return { on, off: document.body.classList.contains('is-shrunk') };
  `);
  ok(keyZ.on && !keyZ.off, 'the Z key toggles shrink mode');

  const fold = await cdp.eval(`
    const cards = [...document.querySelectorAll('.card[data-collapsible]')];
    const btn = cards[0].querySelector('.card-fold');
    const glyphBefore = btn.textContent.trim();
    const bodyBefore = getComputedStyle(cards[0].querySelector('.card-body')).display;
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    const out = {
      cards: cards.length,
      glyphBefore,
      glyphAfter: btn.textContent.trim(),
      bodyBefore,
      bodyAfter: getComputedStyle(cards[0].querySelector('.card-body')).display,
      folded: cards[0].classList.contains('is-folded'),
      headStillVisible: cards[0].querySelector('.card-head').getBoundingClientRect().height > 0,
    };
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    out.unfolded = !cards[0].classList.contains('is-folded');
    return out;
  `);
  console.log(`  fold: ${fold.cards} collapsible cards, glyph ${fold.glyphBefore} -> ${fold.glyphAfter}`);
  ok(fold.cards === 2, 'both sidebar cards are collapsible', `${fold.cards}`);
  ok(fold.bodyBefore !== 'none' && fold.bodyAfter === 'none', 'folding hides the card body');
  ok(fold.headStillVisible, 'the card header stays visible when folded');
  ok(fold.glyphAfter === '+', 'the fold button switches to a plus', fold.glyphAfter);
  ok(fold.unfolded, 'clicking again unfolds');

  /* ---------------------- live viewer count --------------------------- */
  const lu = await cdp.eval(`
    const box = document.getElementById('live-users');
    return { hidden: box.hidden, hasApi: Boolean(window.__metro.state) && undefined === undefined };
  `);
  ok(lu.hidden, 'the "watching" pill stays hidden with no backend, rather than faking a number');

  /* ------------------------ mobile layout ------------------------------ */
  console.log(`\n── mobile layout (412x915) ${'─'.repeat(25)}`);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412, height: 915, deviceScaleFactor: 1, mobile: true,
  });
  await cdp.send('Page.navigate', { url: URL_TO_TEST });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const up = await cdp.eval(`return Boolean(window.__metro && window.__metro.metro && window.__metro.metro.ready);`)
      .catch(() => false);
    if (up) break;
  }
  await sleep(1500);

  const mob = await cdp.eval(`
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
      const r = el.getBoundingClientRect();
      return { t: r.top, l: r.left, b: r.bottom, r: r.right, w: r.width, h: r.height };
    };
    const hits = (a, b) => a && b && !(a.r <= b.l + 1 || a.l >= b.r - 1 || a.b <= b.t + 1 || a.t >= b.b - 1);

    const b = {
      brand: vis('.brand'), clock: vis('.clockbox'), right: vis('.topbar-right'),
      topbar: vis('.topbar'), sidebar: vis('#sidebar'), timebar: vis('.timebar'),
    };
    const clashes = [];
    for (const [x, y] of [['brand','clock'], ['clock','right'], ['brand','right'],
                          ['topbar','sidebar'], ['sidebar','timebar'], ['topbar','clock']]) {
      if (x === 'topbar' && y === 'clock') continue;   // the clock lives inside the bar
      if (hits(b[x], b[y])) clashes.push(x + '/' + y);
    }

    const overflow = [...document.querySelectorAll('.topbar *, .card, .freq-chip, .chip')]
      .filter(el => { const r = el.getBoundingClientRect();
                      return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); })
      .map(el => (el.className || el.tagName).toString().slice(0, 30));

    const cards = [...document.querySelectorAll('.card[data-collapsible]')].map(c => ({
      title: c.querySelector('h2')?.textContent?.trim(),
      folded: c.classList.contains('is-folded'),
      visible: c.getBoundingClientRect().height > 10,
      bodyHidden: getComputedStyle(c.querySelector('.card-body')).display === 'none',
    }));

    // tapping a header must expand it
    const head = document.querySelector('.card[data-collapsible] .card-head');
    head.click();
    await new Promise(r => setTimeout(r, 250));
    const afterTap = {
      folded: head.closest('.card').classList.contains('is-folded'),
      bodyShown: getComputedStyle(head.closest('.card').querySelector('.card-body')).display !== 'none',
    };

    const root = getComputedStyle(document.documentElement);
    return {
      clashes, overflow: [...new Set(overflow)].slice(0, 6), cards, afterTap,
      topbarVar: root.getPropertyValue('--topbar-h').trim(),
      timebarVar: root.getPropertyValue('--timebar-h').trim(),
      topbarReal: Math.round(b.topbar.h),
      timebarReal: Math.round(b.timebar.h),
      mapArea: Math.round(((b.sidebar ? b.sidebar.t : window.innerHeight) - b.topbar.b) / window.innerHeight * 100),
    };
  `);

  console.log(`  --topbar-h ${mob.topbarVar} (measured ${mob.topbarReal}px) · --timebar-h ${mob.timebarVar} (measured ${mob.timebarReal}px)`);
  console.log(`  cards: ${mob.cards.map((c) => `${c.title}=${c.folded ? 'folded' : 'open'}`).join(', ')}`);
  console.log(`  clear map height: ~${mob.mapArea}% of the viewport`);
  if (mob.clashes.length) console.log(`  clashes: ${mob.clashes.join(', ')}`);
  if (mob.overflow.length) console.log(`  overflowing: ${mob.overflow.join(' | ')}`);

  ok(mob.clashes.length === 0, 'nothing overlaps on a phone-sized viewport');
  ok(mob.overflow.length === 0, 'nothing overflows the phone viewport horizontally');
  ok(parseInt(mob.topbarVar, 10) === mob.topbarReal,
    '--topbar-h matches the measured bar', `${mob.topbarVar} vs ${mob.topbarReal}px`);
  ok(Math.abs(parseInt(mob.timebarVar, 10) - (mob.timebarReal + 10)) <= 1,
    '--timebar-h matches the measured bar', `${mob.timebarVar} vs ${mob.timebarReal}+10px`);
  ok(mob.cards.length === 2 && mob.cards.every((c) => c.visible),
    'both sidebar cards are reachable on a phone');
  ok(mob.cards.every((c) => c.bodyHidden), 'both start folded so the map is in view');
  ok(mob.mapArea > 55, 'the map gets the majority of the screen', `${mob.mapArea}%`);
  ok(!mob.afterTap.folded && mob.afterTap.bodyShown, 'tapping a card header expands it');

  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* -------------------------- console hygiene ------------------------- */
  console.log(`\n── console hygiene ${'─'.repeat(33)}`);
  const errs = consoleMsgs.filter((m) => m.level === 'error');
  const warns = consoleMsgs.filter((m) => m.level === 'warning' || m.level === 'warn');
  for (const e of errs.slice(0, 12)) console.log(`  [error] ${e.text.slice(0, 220)}`);
  for (const w of warns.slice(0, 8)) console.log(`  [warn]  ${w.text.slice(0, 220)}`);
  for (const e of pageErrors.slice(0, 8)) console.log(`  [throw] ${String(e).slice(0, 300)}`);
  ok(pageErrors.length === 0, 'no uncaught exceptions', `${pageErrors.length}`);
  ok(errs.length === 0, 'no console errors', `${errs.length}`);

} catch (err) {
  console.error(`\n  HARNESS ERROR: ${err.message}`);
  fail++;
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* windows file locks */ }
}

console.log(`\n${'═'.repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('═'.repeat(62));
process.exit(fail ? 1 : 0);
