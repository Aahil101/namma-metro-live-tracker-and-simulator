/**
 * main.js — boot the app and run the animation loop.
 *
 * The loop is driven by requestAnimationFrame but its *time source* is the real
 * IST clock, not an accumulator. That distinction matters: if the tab is
 * backgrounded for ten minutes, on return the trains are exactly where they
 * should be rather than ten minutes behind.
 *
 * In simulated mode (paused, scrubbed, or running at 1.5–4×) the clock becomes
 * an accumulator instead, advancing by dt × rate.
 */

import { Simulation } from './simulation.js';
import { MetroMap } from './map-view.js';
import { UI, describeTrain } from './ui.js';
import { istNow, previousDay, serviceFor } from './clock.js';
import { codeFromUrl } from './sharecode.js';
import { initialTheme, applyTheme } from './theme.js';
import { startAnalytics, track } from './analytics.js';
import { flushQueue } from './feedback.js';
import { recordVisit } from './visits.js';

const $ = (id) => document.getElementById(id);

/** How often the DOM panels are refreshed (the map still moves every frame). */
const PANEL_MS = 250;
const HEADER_MS = 100;

const state = {
  live: true,
  paused: false,
  simTime: 0,          // used whenever live === false
  speed: 1,            // one of ui.RATES
  sort: 'line',
  filter: '',
  lines: new Set(),
  theme: 'dark',
  shrunk: false,
  selectedStation: null,
  selectedTrainId: null,
  followId: null,
  serviceId: null,
  sliderDragging: false,
  trainsById: new Map(),
  tracked: null,
  trackedTrainId: null,
  todayKey: null,
  yesterdayKey: null,
};

async function loadJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function fail(msg, err) {
  console.error(err || msg);
  const el = $('boot-msg');
  el.className = 'err';
  el.innerHTML = `${msg}<br><span style="color:var(--txt-3);font-size:.82em">${err ? String(err.message || err) : ''}</span>`;
}

async function boot() {
  // theme first, so the loading screen is already the right colour
  state.theme = initialTheme();
  applyTheme(state.theme);

  let network, schedule, meta;
  try {
    $('boot-msg').textContent = 'Loading network & timetable…';
    [network, schedule, meta] = await Promise.all([
      loadJSON('./data/network.json'),
      loadJSON('./data/schedule.json'),
      loadJSON('./data/meta.json'),
    ]);
  } catch (err) {
    return fail('Could not load the timetable data.', err);
  }

  const sim = new Simulation(network, schedule);
  for (const line of network.lines) state.lines.add(line.id);

  const ist0 = istNow();
  state.serviceId = serviceFor(ist0.dateKey, ist0.dow, schedule);
  state.simTime = ist0.sec;

  $('boot-msg').textContent = 'Drawing the network…';

  const metro = new MetroMap('map', network, schedule, state.theme);
  try {
    await metro.init();
  } catch (err) {
    return fail('The map failed to initialise.', err);
  }

  const ui = new UI(sim, metro, state, meta);
  ui.setLive(true);

  // restore the user's shrink preference
  try { if (localStorage.getItem('nml.shrunk') === '1') ui.setShrunk(true); } catch { /* ignore */ }

  // count this visit locally, and start polling the live viewer count if an API exists
  recordVisit();
  ui.startLiveUsers();

  // a shared link like ?train=MTR4K7P2XQ8 starts tracking immediately
  const linkCode = codeFromUrl();
  if (linkCode) {
    if (ui.trackCode(linkCode)) {
      $('share-modal').hidden = true;
      track('deeplink_track');
    } else {
      ui.openShare();
      $('share-in').value = linkCode;
    }
  }

  $('boot').classList.add('gone');
  setTimeout(() => { $('boot').hidden = true; }, 600);

  // optional backend: traffic beacons and any feedback stranded offline
  startAnalytics();
  flushQueue().catch(() => { /* never block the app */ });

  /* ------------------------------------------------------------------ *
   *  Animation loop
   * ------------------------------------------------------------------ */

  let lastPanel = 0;
  let lastHeader = 0;
  let lastPerf = performance.now();
  let cachedDateKey = null;
  let contexts = [];

  function rebuildContexts(ist) {
    const today = serviceFor(ist.dateKey, ist.dow, schedule);
    const prev = previousDay(ist);
    const yesterday = serviceFor(prev.dateKey, prev.dow, schedule);
    state.serviceId = today;
    state.todayKey = ist.dateKey;
    state.yesterdayKey = prev.dateKey;
    cachedDateKey = ist.dateKey;

    const ctx = [];
    if (today) ctx.push({ service: today, offset: 0, dateKey: ist.dateKey });
    // trains that left before midnight and are still running
    if (yesterday) ctx.push({ service: yesterday, offset: 86400, dateKey: prev.dateKey });
    return ctx;
  }

  function frame(perf) {
    const dt = Math.max(0, perf - lastPerf) / 1000;
    lastPerf = perf;

    const ist = istNow();
    if (ist.dateKey !== cachedDateKey) contexts = rebuildContexts(ist);

    // ---- time source -------------------------------------------------
    let t;
    if (state.live) {
      t = ist.sec;
      state.simTime = t;
    } else {
      if (!state.paused) state.simTime = (state.simTime + dt * state.speed) % 86400;
      t = state.simTime;
    }

    // ---- simulate ----------------------------------------------------
    const trains = sim.trainsAt(t, contexts);
    state.trainsById = new Map(trains.map((x) => [x.id, x]));
    const selected = state.selectedTrainId ? state.trainsById.get(state.selectedTrainId) : null;

    // a followed train eventually terminates; release the camera then
    if (state.selectedTrainId && !selected) ui.stopFollow();

    // ---- render ------------------------------------------------------
    metro.renderTrains(trains, (tr) => describeTrain(sim, tr));

    // the strip-map marker moves every frame, which is what sells it as live
    if (selected) ui.updateStripLive(selected);

    if (perf - lastHeader >= HEADER_MS) {
      lastHeader = perf;
      const peak = state.serviceId
        ? sim.peakState(state.serviceId, t)
        : { label: 'no service', kind: 'closed' };
      const visible = trains.filter((x) => state.lines.has(x.line)).length;
      ui.updateHeader(ist, t, state.serviceId, peak, visible);
      ui.updateFreqStrip(state.serviceId, t, peak);
      ui.updateTracking(trains, t);
    }

    if (perf - lastPanel >= PANEL_MS) {
      lastPanel = perf;
      ui.updateLineCounts(trains);
      ui.updateTrainList(trains, t);
      ui.updateStationBoard(t, contexts);
      if (selected) ui.updateTrainPanel(selected);
    }

    requestAnimationFrame(frame);
  }

  contexts = rebuildContexts(istNow());
  requestAnimationFrame(frame);

  // expose for debugging in the console
  window.__metro = { sim, metro, ui, state, network, schedule, meta, track };
}

boot();
