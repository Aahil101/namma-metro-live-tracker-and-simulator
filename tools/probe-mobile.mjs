/**
 * probe-mobile.mjs — measure the phone layout and report overlaps.
 *
 *   node tools/probe-mobile.mjs [url] [width] [height]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/';
const W = Number(process.argv[3] || 412);
const H = Number(process.argv[4] || 915);
const PORT = 9355;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BROWSER = CANDIDATES.find((p) => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mmt-probe-'));

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--hide-scrollbars',
  `--window-size=${W},${H}`, `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  const myId = ++id;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res, rej) => {
    pending.set(myId, { res, rej });
    setTimeout(() => { if (pending.delete(myId)) rej(new Error(method + ' timeout')); }, 40000);
  });
}

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(250);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not up */ }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });

  await send(ws, 'Page.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: true,
  });
  await send(ws, 'Page.navigate', { url: URL_TO_TEST });

  for (let i = 0; i < 80; i++) {
    await sleep(400);
    const r = await send(ws, 'Runtime.evaluate', {
      expression: 'Boolean(window.__metro && window.__metro.metro && window.__metro.metro.ready)',
      returnByValue: true,
    }).catch(() => null);
    if (r?.result?.value) break;
  }
  await sleep(2500);

  const r = await send(ws, 'Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => {
      const box = (sel) => {
        const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
        if (!el) return null;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
        const r = el.getBoundingClientRect();
        return { t: Math.round(r.top), l: Math.round(r.left), b: Math.round(r.bottom), r: Math.round(r.right),
                 w: Math.round(r.width), h: Math.round(r.height) };
      };

      const named = {
        brand: '.brand', clockbox: '.clockbox', topbarRight: '.topbar-right',
        topbar: '.topbar', sidebar: '#sidebar', timebar: '.timebar',
      };
      const boxes = {};
      for (const [k, s] of Object.entries(named)) boxes[k] = box(s);

      const cards = [...document.querySelectorAll('.card[data-collapsible]')].map((c) => ({
        title: c.querySelector('h2')?.textContent?.trim(),
        folded: c.classList.contains('is-folded'),
        box: box(c),
        bodyDisplay: getComputedStyle(c.querySelector('.card-body')).display,
      }));

      const hits = (a, b) => a && b && !(a.r <= b.l + 1 || a.l >= b.r - 1 || a.b <= b.t + 1 || a.t >= b.b - 1);
      const clashes = [];
      for (const [x, y] of [['brand','clockbox'], ['clockbox','topbarRight'], ['brand','topbarRight'],
                            ['topbar','sidebar'], ['sidebar','timebar']]) {
        if (hits(boxes[x], boxes[y])) clashes.push(x + ' / ' + y);
      }

      const offscreen = [...document.querySelectorAll('.topbar *, .card, .freq-chip')]
        .filter(el => { const b = box(el); return b && (b.r > window.innerWidth + 1 || b.l < -1); })
        .map(el => (el.className || el.tagName) + ': ' + (el.textContent || '').trim().slice(0, 24));

      return { vw: window.innerWidth, vh: window.innerHeight, boxes, cards, clashes,
               offscreen: [...new Set(offscreen)].slice(0, 8),
               topbarH: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
               mobileFirst: document.body.classList.contains('mobile-first-load') };
    })()`,
  });

  const d = r.result.value;
  console.log(`viewport ${d.vw}x${d.vh}   --topbar-h: ${d.topbarH}   mobile-first-load: ${d.mobileFirst}\n`);
  console.log('element boxes (top, left, bottom, right  |  w x h):');
  for (const [k, b] of Object.entries(d.boxes)) {
    console.log(b ? `  ${k.padEnd(13)} ${String(b.t).padStart(4)},${String(b.l).padStart(4)} -> ${String(b.b).padStart(4)},${String(b.r).padStart(4)}   ${b.w}x${b.h}`
                  : `  ${k.padEnd(13)} (not rendered)`);
  }
  console.log('\ncollapsible cards:');
  for (const c of d.cards) {
    console.log(`  "${c.title}"  folded=${c.folded}  body=${c.bodyDisplay}  `
      + (c.box ? `box ${c.box.t}->${c.box.b} (h ${c.box.h})` : 'NOT VISIBLE'));
  }
  console.log(`\noverlaps: ${d.clashes.length ? d.clashes.join(', ') : 'none'}`);
  console.log(`offscreen: ${d.offscreen.length ? '\n  ' + d.offscreen.join('\n  ') : 'none'}`);
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locks */ }
}
