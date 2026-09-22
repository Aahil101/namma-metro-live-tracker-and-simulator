/**
 * screenshot.mjs — capture the running app via the DevTools Protocol.
 *
 *   node tools/screenshot.mjs [url] [outfile] [--wait ms] [--eval "js"]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const URL_TO_SHOT = positional[0] || 'http://localhost:5173/';
const OUT = path.resolve(positional[1] || '_data/shot.png');
const WAIT = Number(flag('wait', 14000));
const EVAL = flag('eval', null);
const W = Number(flag('width', 1600));
const H = Number(flag('height', 950));
const PORT = 9342;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const BROWSER = CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) { console.error('no Chrome/Edge found'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mmt-shot-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox',
  '--hide-scrollbars', '--disable-dev-shm-usage',
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
    setTimeout(() => { if (pending.delete(myId)) rej(new Error(`${method} timeout`)); }, 40000);
  });
}

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(250);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not yet */ }
  }
  if (!page) throw new Error('no debuggable page');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });

  await send(ws, 'Page.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await send(ws, 'Page.navigate', { url: URL_TO_SHOT });

  // wait for the app to report itself ready, then let tiles settle
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    const r = await send(ws, 'Runtime.evaluate', {
      expression: 'Boolean(window.__metro && window.__metro.metro && window.__metro.metro.ready)',
      returnByValue: true,
    }).catch(() => null);
    if (r?.result?.value) break;
  }
  await sleep(WAIT);

  if (EVAL) {
    // wrap so the completion value is a string — returning a Map or DOM node
    // blows up CDP's returnByValue serialisation
    const r = await send(ws, 'Runtime.evaluate', {
      expression: `(async () => { ${EVAL}; return 'ok'; })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    await sleep(3000);
  }

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
} catch (err) {
  console.error('screenshot failed:', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locks */ }
}
