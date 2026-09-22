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
  ok(/^\d\d:\d\d:\d\d$/.test(snap.clock), 'clock is rendering IST', snap.clock);
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
    out.afterPause = { live: s.live, paused: s.paused, read: document.getElementById('speed-read').textContent,
                       bodyPaused: document.body.classList.contains('is-paused') };
    const t0 = s.simTime;
    return new Promise(res => setTimeout(() => {
      out.frozen = Math.abs(s.simTime - t0) < 0.5;
      m.ui.togglePlay();                     // resume
      out.afterResume = { paused: s.paused, read: document.getElementById('speed-read').textContent };
      res(out);
    }, 900));
  `);
  console.log(`  pause → ${JSON.stringify(play.afterPause)}`);
  ok(play.afterPause.paused === true, 'play/pause pauses the simulation');
  ok(play.afterPause.live === false, 'pausing drops out of live mode');
  ok(play.afterPause.read === 'paused', 'readout says "paused"', play.afterPause.read);
  ok(play.afterPause.bodyPaused, 'is-paused class drives the play icon');
  ok(play.frozen, 'the clock does not advance while paused');
  ok(play.afterResume.paused === false, 'pressing again resumes');

  const rates = await cdp.eval(`
    const m = window.__metro, s = m.state;
    const seen = [];
    const read = () => document.getElementById('speed-read').textContent;
    // walk to the bottom first
    for (let i = 0; i < 6; i++) m.ui.stepRate(-1);
    seen.push([s.speed, read(), document.getElementById('btn-slower').disabled]);
    for (let i = 0; i < 5; i++) { m.ui.stepRate(+1); seen.push([s.speed, read(), document.getElementById('btn-faster').disabled]); }
    return { seen, live: s.live };
  `);
  console.log(`  rate ladder: ${rates.seen.map((r) => r[1]).join(' → ')}`);
  const ladder = rates.seen.map((r) => r[0]);
  ok(ladder[0] === 1 && rates.seen[0][2] === true, 'slower is disabled at 1×');
  ok(JSON.stringify([...new Set(ladder)]) === JSON.stringify([1, 1.5, 2, 4]),
    'rate ladder is exactly 1× / 1.5× / 2× / 4×', JSON.stringify([...new Set(ladder)]));
  ok(rates.seen[rates.seen.length - 1][2] === true, 'faster is disabled at 4×');
  ok(rates.live === false, 'running faster than real time leaves live mode');

  const rateEffect = await cdp.eval(`
    const m = window.__metro, s = m.state;
    s.live = false; s.paused = false; s.speed = 4; s.simTime = 12 * 3600;
    const t0 = s.simTime;
    return new Promise(res => setTimeout(() => res(s.simTime - t0), 1000));
  `);
  console.log(`  at 4× the clock advanced ${rateEffect.toFixed(1)} s in 1 s of wall time`);
  ok(rateEffect > 2.5 && rateEffect < 6, 'the rate multiplier actually scales the clock',
    `${rateEffect.toFixed(1)}×`);

  await cdp.eval(`window.__metro.ui.setLive(true); return 'ok';`);
  const backLive = await cdp.eval(`
    const s = window.__metro.state;
    return { live: s.live, speed: s.speed, paused: s.paused, read: document.getElementById('speed-read').textContent };
  `);
  ok(backLive.live && backLive.speed === 1 && !backLive.paused, 'GO LIVE resets rate and unpauses');
  ok(backLive.read === '1×', 'readout returns to 1×', backLive.read);

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
  ok(adm?.gateVisible && adm?.dashHidden, 'the dashboard is gated behind a login');
  ok(adm?.hasPasswordField, 'the password field is type=password');
  ok(/noindex/.test(adm?.robots || ''), 'admin page is noindex', adm?.robots);
  ok(/No API is configured/i.test(adm?.note || ''), 'gate explains local mode honestly');

  // the critical security property: no credential material in the client bundle
  const secrets = await cdp.eval(`
    const urls = ['./js/admin.js', './js/config.js', './js/feedback.js', './js/analytics.js'];
    const out = {};
    for (const u of urls) out[u] = await (await fetch(u)).text();
    const all = Object.values(out).join('\\n');
    return {
      hasPassword: /aahil@1423/.test(all),
      hasHash: /pbkdf2|ADMIN_PW|SESSION_SECRET/i.test(all),
      mentionsOwnerEmail: /heworld2046/.test(all),
      bytes: all.length,
    };
  `);
  console.log(`  scanned ${secrets.bytes} bytes of client JS`);
  ok(!secrets.hasPassword, 'the admin password does not appear anywhere in client JS');
  ok(!secrets.hasHash, 'no password hash or session secret in client JS');
  ok(secrets.mentionsOwnerEmail, 'the mailto fallback address is present (expected, not a secret)');

  // local mode sign-in shows the queued feedback rather than pretending to auth
  const local = await cdp.eval(`
    localStorage.setItem('nml.fb.queue', JSON.stringify([
      { kind: 'bug', message: 'Test report one', contact: '', context: { theme: 'dark' }, at: new Date().toISOString() },
      { kind: 'idea', message: 'Test idea two', contact: 'x@y.z', context: {}, at: new Date().toISOString() }
    ]));
    document.getElementById('gu').value = 'aahil';
    document.getElementById('gp').value = 'aahil@14231423';
    document.getElementById('gate-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 1400));
    return {
      dashShown: !document.getElementById('dash').hidden,
      banner: document.getElementById('adm-banner').textContent.trim().slice(0, 120),
      bannerShown: !document.getElementById('adm-banner').hidden,
      fbItems: document.querySelectorAll('.fb-item').length,
      kpis: [...document.querySelectorAll('.kpi-v')].map(e => e.textContent),
      charts: [...document.querySelectorAll('.chart')].map(e => e.textContent.trim().slice(0, 30)),
      kinds: [...document.querySelectorAll('.fb-kind-tag')].map(e => e.textContent.trim()),
    };
  `);
  console.log(`  local mode: ${local.fbItems} queued items, KPIs ${JSON.stringify(local.kpis)}`);
  ok(local.dashShown, 'local mode opens the dashboard');
  ok(local.bannerShown && /Local mode/i.test(local.banner), 'a banner states it is local mode', local.banner.slice(0, 60));
  ok(local.fbItems === 2, 'queued feedback is listed', `${local.fbItems}`);
  ok(local.kinds.includes('bug') && local.kinds.includes('idea'), 'feedback kinds are tagged');
  ok(local.kpis.every((v) => v === '—'), 'traffic KPIs stay blank rather than showing fake numbers');
  ok(local.charts.some((c) => /Deploy api|No server-side/i.test(c)), 'charts explain why they are empty');

  // filters and read toggle
  const inter = await cdp.eval(`
    document.querySelector('#fb-filter [data-f="bug"]').click();
    const afterBug = document.querySelectorAll('.fb-item').length;
    document.querySelector('#fb-filter [data-f="all"]').click();
    const afterAll = document.querySelectorAll('.fb-item').length;
    const first = document.querySelector('.fb-item');
    const wasUnread = first.classList.contains('unread');
    first.querySelector('[data-act="toggle"]').click();
    await new Promise(r => setTimeout(r, 200));
    const nowUnread = document.querySelector('.fb-item').classList.contains('unread');
    return { afterBug, afterAll, wasUnread, nowUnread };
  `);
  ok(inter.afterBug === 1 && inter.afterAll === 2, 'kind filter works', `${inter.afterBug} / ${inter.afterAll}`);
  ok(inter.wasUnread && !inter.nowUnread, 'mark-as-read toggles');

  const signedOut = await cdp.eval(`
    document.getElementById('adm-logout').click();
    await new Promise(r => setTimeout(r, 200));
    return { gate: getComputedStyle(document.getElementById('gate')).display !== 'none',
             dashHidden: document.getElementById('dash').hidden };
  `);
  ok(signedOut.gate && signedOut.dashHidden, 'sign out returns to the gate');

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
