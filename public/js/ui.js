/**
 * ui.js — every panel that isn't the map.
 *
 * Lists are updated by key rather than re-rendered, so a row you are hovering
 * or have selected does not flicker while its countdown ticks down.
 */

import { hhmm, hhmmss, countdown, shortCountdown, minutes } from './clock.js';
import { WINDOWS } from './simulation.js';
import { pickText, esc } from './map-view.js';
import { encodeRun, decodeRun, formatCode, shareUrl } from './sharecode.js';
import { applyTheme } from './theme.js';
import { sendFeedback, mailtoLink } from './feedback.js';
import { liveUsers } from './visits.js';
import { API_BASE } from './config.js';

const $ = (id) => document.getElementById(id);

/**
 * Playback ladder. Index 2 (1×) is real time; everything below it is slow
 * motion, everything above is fast-forward. The UI reports position on this
 * ladder as a signed notch — 1× is `0`, 4× is `+3`, 0.25× is `−2` — which is
 * easier to reason about at a glance than a bare multiplier.
 */
export const RATES = [0.25, 0.5, 1, 1.5, 2, 4, 8, 16, 32];
const BASE = RATES.indexOf(1);

/** Hard limits for a hand-typed speed. */
export const MIN_RATE = 0.05;
export const MAX_RATE = 240;

/** Nearest ladder index to an arbitrary speed, measured in log space. */
function nearestIndex(v) {
  let best = BASE, bestD = Infinity;
  RATES.forEach((r, i) => {
    const d = Math.abs(Math.log(v / r));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/**
 * Ladder index to move to for a ±1 step. Works for off-ladder speeds too: a
 * custom 7.5× stepped up lands on 8×, stepped down lands on 4×.
 */
function stepIndex(cur, delta) {
  if (delta > 0) {
    const next = RATES.findIndex((r) => r > cur + 1e-9);
    return next === -1 ? RATES.length - 1 : next;
  }
  let prev = -1;
  for (let i = 0; i < RATES.length; i++) if (RATES[i] < cur - 1e-9) prev = i;
  return prev === -1 ? 0 : prev;
}

/** "0.25×", "1×", "1.5×", "7.5×", "32×" */
export function formatRate(v) {
  const n = Number(v);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${s}×`;
}

/**
 * Signed notch label. Exact ladder values give "+3" / "0" / "−2"; a custom
 * value gets a "~" so it is clear it sits between notches.
 */
export function rateNotch(v) {
  const exact = RATES.findIndex((r) => Math.abs(r - v) < 1e-9);
  const idx = exact >= 0 ? exact : nearestIndex(v);
  const n = idx - BASE;
  const sign = n > 0 ? '+' : n < 0 ? '\u2212' : '';
  return `${exact >= 0 ? '' : '~'}${sign}${Math.abs(n)}`;
}

/** Reconcile a container's children against `items` without a full re-render. */
function keyedList(container, items, { key, create, update }) {
  const existing = container._keyed || (container._keyed = new Map());
  const wanted = new Set();

  for (const item of items) {
    const k = key(item);
    wanted.add(k);
    let el = existing.get(k);
    if (!el) {
      el = create(item);
      existing.set(k, el);
      container.appendChild(el);
    }
    update(el, item);
  }

  for (const [k, el] of existing) {
    if (!wanted.has(k)) { el.remove(); existing.delete(k); }
  }

  // put them in the right order (cheap for the ~80 nodes we deal with)
  let prev = null;
  for (const item of items) {
    const el = existing.get(key(item));
    const shouldFollow = prev ? prev.nextSibling : container.firstChild;
    if (el !== shouldFollow) container.insertBefore(el, shouldFollow);
    prev = el;
  }
}

export class UI {
  /**
   * @param {import('./simulation.js').Simulation} sim
   * @param {import('./map-view.js').MetroMap} metro
   * @param {object} state shared mutable app state (see main.js)
   */
  constructor(sim, metro, state, meta) {
    this.sim = sim;
    this.metro = metro;
    this.state = state;
    this.meta = meta;
    this.lastBoardKey = '';

    // strip-map bookkeeping
    this.stripTrainId = null;
    this.stripCalls = [];
    this.stripRowEls = [];
    this.stripRowH = 30;
    this.stripUserScrolledAt = 0;

    this._buildLineList();
    this._wire();
    this._buildModal();
  }

  /* ------------------------------------------------------------------ *
   *  Static construction
   * ------------------------------------------------------------------ */

  _buildLineList() {
    const host = $('line-list');
    host.innerHTML = '';
    this.lineRows = new Map();

    for (const line of this.sim.lines) {
      const first = this.sim.stations[line.stations[0]];
      const last = this.sim.stations[line.stations[line.stations.length - 1]];

      const row = document.createElement('div');
      row.className = 'line-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'switch');
      row.setAttribute('aria-checked', 'true');
      row.innerHTML =
        `<span class="line-swatch" style="background:${this.metro.lineColor(line.id)}"></span>` +
        `<span class="line-info">` +
          `<span class="line-name">${esc(line.name)} Line</span>` +
          `<span class="line-sub">${esc(first.name)} ↔ ${esc(last.name)} · ${line.stations.length} stations</span>` +
        `</span>` +
        `<span class="line-count"><span data-count>0</span><small>running</small></span>`;

      const toggle = () => {
        const on = this.state.lines.has(line.id);
        if (on) this.state.lines.delete(line.id); else this.state.lines.add(line.id);
        row.classList.toggle('off', on);
        row.setAttribute('aria-checked', String(!on));
        this.metro.setLineVisible(line.id, !on);
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

      host.appendChild(row);
      this.lineRows.set(line.id, row);
    }
  }

  _wire() {
    const s = this.state;

    $('btn-live').addEventListener('click', () => this.setLive(!s.live));

    const slider = $('time-slider');
    slider.addEventListener('input', (e) => {
      s.live = false;
      s.simTime = Number(e.target.value);
      this._reflectLive();
    });
    // while the thumb is held, stop the loop from writing the value back
    for (const ev of ['pointerdown', 'keydown']) slider.addEventListener(ev, () => { s.sliderDragging = true; });
    for (const ev of ['pointerup', 'pointercancel', 'blur', 'keyup']) slider.addEventListener(ev, () => { s.sliderDragging = false; });

    /* ---- playback ---- */
    $('btn-rewind').addEventListener('click', () => this.nudge(-300));
    $('btn-forward').addEventListener('click', () => this.nudge(300));
    $('btn-play').addEventListener('click', () => this.togglePlay());
    $('btn-slower').addEventListener('click', () => this.stepRate(-1));
    $('btn-faster').addEventListener('click', () => this.stepRate(+1));

    $('speed-read').addEventListener('click', (e) => { e.stopPropagation(); this.toggleCustom(); });

    $('sc-presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      this.setRate(Number(b.dataset.v));
      this.toggleCustom(false);
    });

    $('sc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = Number($('speed-input').value);
      if (!Number.isFinite(v) || v <= 0) { $('speed-input').select(); return; }
      this.setRate(v);
      this.toggleCustom(false);
    });

    // a wheel over the readout is a natural way to scrub the rate
    $('speed-read').addEventListener('wheel', (e) => {
      e.preventDefault();
      this.stepRate(e.deltaY < 0 ? +1 : -1);
    }, { passive: false });

    document.addEventListener('click', (e) => {
      if (!$('speed-custom').hidden && !e.target.closest('.playbar')) this.toggleCustom(false);
    });

    /* ---- theme ---- */
    $('btn-theme').addEventListener('click', () => this.toggleTheme());

    /* ---- shrink / focus mode ---- */
    $('btn-shrink').addEventListener('click', () => this.setShrunk(!this.state.shrunk));
    $('chip-panels').addEventListener('click', () => this.setShrunk(false));
    $('chip-time').addEventListener('click', () => this.setShrunk(false));

    /* ---- per-card collapse ---- */
    for (const card of document.querySelectorAll('.card[data-collapsible]')) {
      const btn = card.querySelector('.card-fold');
      if (!btn) continue;
      btn.textContent = '\u2013';                       // en dash = collapse
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const folded = card.classList.toggle('is-folded');
        btn.textContent = folded ? '+' : '\u2013';
        btn.title = folded ? 'Expand' : 'Collapse';
        btn.setAttribute('aria-expanded', String(!folded));
      });
    }

    /* ---- feedback ---- */
    $('btn-feedback').addEventListener('click', () => this.openFeedback());
    $('fb-close').addEventListener('click', () => { $('fb-modal').hidden = true; });
    $('fb-modal').addEventListener('click', (e) => { if (e.target === $('fb-modal')) $('fb-modal').hidden = true; });
    $('fb-msg').addEventListener('input', (e) => {
      $('fb-count').textContent = `${e.target.value.length} / 2000`;
      this._syncMailto();
    });
    $('fb-form').addEventListener('submit', (e) => { e.preventDefault(); this.submitFeedback(); });

    document.querySelector('.seg[role="tablist"]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sort]');
      if (!btn) return;
      s.sort = btn.dataset.sort;
      for (const b of btn.parentElement.children) b.classList.toggle('is-on', b === btn);
      $('train-list')._keyed?.clear();
      $('train-list').innerHTML = '';
    });

    $('train-search').addEventListener('input', (e) => { s.filter = e.target.value.trim().toLowerCase(); });

    $('btn-all-lines').addEventListener('click', () => {
      for (const line of this.sim.lines) {
        s.lines.add(line.id);
        this.metro.setLineVisible(line.id, true);
        const row = this.lineRows.get(line.id);
        row.classList.remove('off');
        row.setAttribute('aria-checked', 'true');
      }
    });

    $('btn-panel').addEventListener('click', () => $('sidebar').classList.toggle('hidden'));
    $('sp-close').addEventListener('click', () => this.closeStation());

    /* ---- train detail panel ---- */
    $('tp-close').addEventListener('click', () => this.closeTrain());

    $('tp-follow').addEventListener('click', () => {
      const on = !!s.followId;
      if (on) { s.followId = null; this.metro.setFollow(null); }
      else if (s.selectedTrainId) { s.followId = s.selectedTrainId; this.metro.setFollow(s.selectedTrainId); }
      this._reflectFollowBtn();
    });

    $('tp-share').addEventListener('click', () => this.openShare());

    // let the user scroll the strip map without the auto-follow fighting them
    const strip = $('tp-strip');
    for (const ev of ['wheel', 'touchstart', 'pointerdown']) {
      strip.addEventListener(ev, () => { this.stripUserScrolledAt = performance.now(); }, { passive: true });
    }

    /* ---- share / track ---- */
    $('btn-share').addEventListener('click', () => this.openShare());
    $('share-close').addEventListener('click', () => { $('share-modal').hidden = true; });
    $('share-modal').addEventListener('click', (e) => { if (e.target === $('share-modal')) $('share-modal').hidden = true; });

    $('share-copy').addEventListener('click', (e) => this._copy($('share-code').textContent, e.target, 'copy code'));
    $('share-link').addEventListener('click', (e) => this._copy(shareUrl($('share-code').textContent), e.target, 'copy link'));

    $('share-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.trackCode($('share-in').value);
    });
    $('share-in').addEventListener('input', (e) => {
      // keep the field tidy as they type / paste
      const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^MTR/, '').slice(0, 9);
      e.target.value = raw.length > 4 ? `MTR-${raw.slice(0, 4)}-${raw.slice(4)}` : (raw ? `MTR-${raw}` : '');
      $('share-msg').textContent = '';
    });

    $('tc-stop').addEventListener('click', () => this.stopTracking());
    $('tc-goto').addEventListener('click', () => {
      const t = s.trackedTrainId ? s.trainsById.get(s.trackedTrainId) : null;
      if (t) { this.selectTrain(t.id, true); }
    });

    const openModal = () => { $('modal').hidden = false; };
    $('btn-info').addEventListener('click', openModal);
    $('note-more').addEventListener('click', openModal);
    $('modal-close').addEventListener('click', () => { $('modal').hidden = true; });
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('speed-custom').hidden) this.toggleCustom(false);
        else if (!$('fb-modal').hidden) $('fb-modal').hidden = true;
        else if (!$('share-modal').hidden) $('share-modal').hidden = true;
        else if (!$('modal').hidden) $('modal').hidden = true;
        else if (!$('train-panel').hidden) this.closeTrain();
        else if (!$('station-panel').hidden) this.closeStation();
        else if (s.tracked) this.stopTracking();
      }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); this.nudge(-300); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.nudge(300); }

      // + / − step the playback rate; , / . are aliases for keyboards where
      // + needs a modifier
      if (e.key === '+' || e.key === '=' || e.key === '.' || e.key === '>') this.stepRate(+1);
      if (e.key === '-' || e.key === '_' || e.key === ',' || e.key === '<') this.stepRate(-1);
      if (e.key === '0') this.resetRate();

      const k = e.key.toLowerCase();
      if (k === 'l') this.setLive(!s.live);
      if (k === 'r') this.metro.resetView();
      if (k === 's') this.openShare();
      if (k === 't') this.toggleTheme();
      if (k === 'f') this.openFeedback();
      if (k === 'x') this.toggleCustom();
      if (k === 'z') this.setShrunk(!s.shrunk);
    });

    // clicks on the map
    this.metro.on('station', (id) => this.openStation(id));
    this.metro.on('train', (id) => this.selectTrain(id, true));
    this.metro.on('userPan', () => this.stopFollow(true));
  }

  /* ------------------------------------------------------------------ *
   *  Mode controls
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   *  Mode controls: live / paused / playback rate
   * ------------------------------------------------------------------ */

  setLive(live) {
    const s = this.state;
    s.live = live;
    if (live) { s.speed = 1; s.paused = false; }
    this._reflectLive();
  }

  /** Space / the play button. Pausing while live drops out of live mode. */
  togglePlay() {
    const s = this.state;
    if (s.live) {
      // leave live and freeze at the current second
      s.live = false;
      s.paused = true;
    } else {
      s.paused = !s.paused;
    }
    this._reflectLive();
  }

  /** Move one notch along the ladder. Leaving 1× leaves live mode. */
  stepRate(delta) {
    const s = this.state;
    const cur = s.live ? 1 : s.speed;
    this.setRate(RATES[stepIndex(cur, delta)]);
  }

  /** Set an exact rate, from the ladder or hand-typed. */
  setRate(v) {
    const s = this.state;
    const n = Number(v);
    // clamp anything finite (including 0 and negatives) into range; only
    // genuinely unusable input falls back to real time
    const rate = Number.isFinite(n) ? Math.min(MAX_RATE, Math.max(MIN_RATE, n)) : 1;
    s.speed = rate;
    s.paused = false;
    // only real time can be "live"; anything else is a simulation
    if (Math.abs(rate - 1) > 1e-9) s.live = false;
    this._reflectLive();
  }

  /** Back to real time and live. */
  resetRate() { this.setLive(true); }

  nudge(deltaSec) {
    const s = this.state;
    s.live = false;
    s.simTime = (s.simTime + deltaSec + 86400) % 86400;
    this._reflectLive();
  }

  /* ---- custom speed popover ---- */

  toggleCustom(force) {
    const pop = $('speed-custom');
    const open = force !== undefined ? force : pop.hidden;
    pop.hidden = !open;
    $('speed-read').setAttribute('aria-expanded', String(open));
    if (open) {
      $('speed-input').value = this.state.live ? 1 : this.state.speed;
      this._renderPresets();
      setTimeout(() => $('speed-input').select(), 40);
    }
  }

  _renderPresets() {
    const host = $('sc-presets');
    const cur = this.state.live ? 1 : this.state.speed;
    host.innerHTML = RATES.map((r) => {
      const on = Math.abs(r - cur) < 1e-9 ? ' is-on' : '';
      return `<button type="button" class="sc-preset${on}" data-v="${r}">${formatRate(r)}</button>`;
    }).join('');
  }

  _reflectLive() {
    const s = this.state;
    const live = s.live;
    const rate = live ? 1 : s.speed;

    $('btn-live').classList.toggle('is-live', live);
    document.body.classList.toggle('is-live-mode', live);
    document.body.classList.toggle('is-paused', s.paused);
    $('btn-live').querySelector('span:last-child').textContent = live ? 'LIVE' : 'GO LIVE';

    $('speed-notch').textContent = rateNotch(rate);
    $('speed-mult').textContent = s.paused ? 'paused' : formatRate(rate);

    const read = $('speed-read');
    const exact = RATES.some((r) => Math.abs(r - rate) < 1e-9);
    read.classList.toggle('is-custom', !exact);
    read.classList.toggle('is-fast', rate > 1 + 1e-9);
    read.classList.toggle('is-slow', rate < 1 - 1e-9);
    read.title = exact
      ? `${formatRate(rate)} — click for a custom speed`
      : `custom ${formatRate(rate)} — click to change`;

    $('btn-slower').disabled = rate <= RATES[0] + 1e-9;
    $('btn-faster').disabled = rate >= RATES[RATES.length - 1] - 1e-9;

    $('btn-play').setAttribute('aria-pressed', String(!s.paused));
    $('btn-play').title = s.paused ? 'Play (Space)' : 'Pause (Space)';

    if (!$('speed-custom').hidden) this._renderPresets();
  }

  /* ------------------------------------------------------------------ *
   *  Shrink / focus mode
   * ------------------------------------------------------------------ */

  /**
   * Fold every panel out to the edges so the map has the whole viewport, and
   * leave two corner chips to bring them back. Persisted, because someone who
   * wants a clean map usually wants it every time.
   */
  setShrunk(on) {
    this.state.shrunk = on;
    document.body.classList.toggle('is-shrunk', on);
    $('shrunk-bar').hidden = !on;
    $('btn-shrink').setAttribute('aria-pressed', String(on));
    $('btn-shrink').title = on ? 'Restore panels (Z)' : 'Shrink panels to the corners (Z)';
    try { localStorage.setItem('nml.shrunk', on ? '1' : '0'); } catch { /* ignore */ }
    // the map's own size did not change, but its usable area did
    setTimeout(() => this.metro.map.resize(), 320);
  }

  /* ------------------------------------------------------------------ *
   *  Live viewer count
   * ------------------------------------------------------------------ */

  /**
   * Show how many people are on the site right now. This genuinely requires the
   * API — a browser cannot see other visitors — so with no backend the pill
   * stays hidden rather than showing an invented number.
   */
  async pollLiveUsers() {
    const box = $('live-users');
    const data = await liveUsers();
    if (!data || typeof data.live !== 'number') { box.hidden = true; return; }
    box.hidden = false;
    $('lu-count').textContent = String(data.live);
    box.title = `${data.live} viewing now · ${data.views24 ?? '?'} views in 24 h`;
  }

  startLiveUsers() {
    if (!API_BASE) return;              // nothing to poll
    this.pollLiveUsers();
    setInterval(() => {
      if (document.visibilityState === 'visible') this.pollLiveUsers();
    }, 30_000);
  }

  /* ------------------------------------------------------------------ *
   *  Theme
   * ------------------------------------------------------------------ */

  toggleTheme() { this.setTheme(this.state.theme === 'light' ? 'dark' : 'light'); }

  setTheme(id) {
    if (id === this.state.theme) return;
    this.state.theme = id;
    applyTheme(id);
    // rebuilding the map scene is async; repaint the DOM bits that carry
    // inline line colours once it lands
    this.metro.setTheme(id).then(() => this.refreshThemeColors());
    this.refreshThemeColors();
  }

  /** Re-apply inline colours that came from the previous palette. */
  refreshThemeColors() {
    for (const [id, row] of this.lineRows) {
      row.querySelector('.line-swatch').style.background = this.metro.lineColor(id);
    }
    // the open panels redraw themselves on the next tick; the strip rail and
    // any pills need an explicit nudge
    const sel = this.state.selectedTrainId ? this.state.trainsById.get(this.state.selectedTrainId) : null;
    if (sel) { this.stripTrainId = null; this.updateTrainPanel(sel); }
    if (this.state.selectedStation) this.openStation(this.state.selectedStation);
    this.lastBoardKey = '';
    $('freq-strip')._keyed?.clear();
    $('freq-strip').innerHTML = '';
    this._buildModal();
  }

  /** Keep <body> classes in sync with which detail panel is open (mobile CSS
   *  needs this: the sidebar precedes the panels, so a sibling selector can't
   *  reach it). */
  _reflectPanels() {
    document.body.classList.toggle('panel-train', !$('train-panel').hidden);
    document.body.classList.toggle('panel-station', !$('station-panel').hidden);
  }

  selectTrain(id, fly = false) {
    const s = this.state;
    s.selectedTrainId = id;
    s.followId = id;
    this.metro.selectTrain(id);
    this.metro.setFollow(id);

    // the two right-hand panels share a slot
    if (!$('station-panel').hidden) this.closeStation();
    $('train-panel').hidden = false;
    this._reflectPanels();

    // force a rebuild of the strip map for the new train
    this.stripTrainId = null;
    this.stripUserScrolledAt = 0;
    this._reflectFollowBtn();

    const t = s.trainsById?.get(id);
    if (t) {
      this.updateTrainPanel(t);
      if (fly) this.metro.flyToTrain(t);
    }
  }

  closeTrain() {
    const s = this.state;
    s.selectedTrainId = null;
    s.followId = null;
    this.metro.selectTrain(null);
    this.metro.setFollow(null);
    $('train-panel').hidden = true;
    this.stripTrainId = null;
    this._reflectPanels();
  }

  /** Called when a followed train terminates, or when the user pans away. */
  stopFollow(keepSelection = false) {
    this.state.followId = null;
    this.metro.setFollow(null);
    this._reflectFollowBtn();
    if (!keepSelection) this.closeTrain();
  }

  _reflectFollowBtn() {
    const on = !!this.state.followId;
    const b = $('tp-follow');
    b.classList.toggle('is-on', on);
    b.textContent = on ? '⌖ following' : '⌖ follow';
  }

  openStation(id) {
    this.state.selectedStation = id;
    this.lastBoardKey = '';
    if (!$('train-panel').hidden) this.closeTrain();
    $('station-panel').hidden = false;
    this._reflectPanels();
    $('sp-board')._keyed?.clear();
    $('sp-board').innerHTML = '';

    const st = this.sim.stations[id];
    $('sp-name').textContent = st.name;
    $('sp-meta').innerHTML = st.lines.map((l) => {
      const line = this.sim.lineById.get(l);
      const c = this.metro.lineColor(l);
      return `<span class="pill" style="background:${c};color:${pickText(c)}">${line.name}</span>`;
    }).join('') + `<span>${esc(st.code)}</span>`;

    this.metro.flyToStation(id);
  }

  closeStation() {
    this.state.selectedStation = null;
    $('station-panel').hidden = true;
    this._reflectPanels();
  }

  /* ------------------------------------------------------------------ *
   *  Share & track a friend's train
   * ------------------------------------------------------------------ */

  openShare() {
    const s = this.state;
    const train = s.selectedTrainId ? s.trainsById.get(s.selectedTrainId) : null;

    if (train) {
      let code = null;
      try { code = encodeRun({ patternIdx: train.patternIdx, start: train.start, dateKey: train.dateKey }); }
      catch { code = null; }

      if (code) {
        $('share-none').hidden = true;
        $('share-have').hidden = false;
        $('share-code').textContent = code;
        const line = this.sim.lineById.get(train.line);
        const lc = this.metro.lineColor(train.line);
        $('share-for').innerHTML =
          `<span class="pill" style="background:${lc};color:${pickText(lc)}">${line.name}</span> ` +
          `${esc(this.sim.stations[train.origin]?.name)} → ${esc(train.headsign)}, ` +
          `departed ${hhmm(train.startAbs)}`;
      }
    } else {
      $('share-none').hidden = false;
      $('share-have').hidden = true;
    }

    $('share-msg').textContent = '';
    $('share-modal').hidden = false;
    setTimeout(() => { if (!train) $('share-in').focus(); }, 60);
  }

  async _copy(text, btn, restore) {
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'copied ✓';
    } catch {
      // clipboard API needs a secure context; fall back to a selectable prompt
      window.prompt('Copy this:', text);
      btn.textContent = label;
      return;
    }
    setTimeout(() => { btn.textContent = restore || label; }, 1600);
  }

  /** Validate a pasted code and start tracking it. */
  trackCode(raw) {
    const msg = $('share-msg');
    const run = decodeRun(raw);

    if (!run) {
      msg.className = 'share-msg bad';
      msg.textContent = 'That code isn\'t valid — check for a mistyped character.';
      return false;
    }
    const pattern = this.sim.patterns[run.patternIdx];
    if (!pattern) {
      msg.className = 'share-msg bad';
      msg.textContent = 'That code refers to a service this map doesn\'t know about.';
      return false;
    }

    this.state.tracked = { ...run, code: formatCode(raw) };
    this.state.trackedTrainId = null;

    const line = this.sim.lineById.get(pattern.line);
    msg.className = 'share-msg ok';
    msg.innerHTML =
      `Tracking the ${line.name} Line run to <strong>${esc(pattern.to)}</strong> ` +
      `that left ${esc(this.sim.stations[pattern.stops[0]]?.name)} at ${hhmm(run.start)}.`;

    $('tracking-chip').hidden = false;
    $('tc-label').textContent = this.state.tracked.code;
    setTimeout(() => { $('share-modal').hidden = true; }, 900);
    return true;
  }

  stopTracking() {
    this.state.tracked = null;
    this.state.trackedTrainId = null;
    this.metro.setTracked(null, null);
    $('tracking-chip').hidden = true;
    $('tp-tracked').hidden = true;
  }

  /**
   * Resolve the tracked code against the live fleet. Called each tick from the
   * loop, because the train only exists while it is actually running.
   */
  updateTracking(trains, t) {
    const s = this.state;
    if (!s.tracked) return;

    const { patternIdx, start, dateKey, code } = s.tracked;
    const hit = trains.find((x) => x.patternIdx === patternIdx && x.start === start && x.dateKey === dateKey);

    const where = $('tc-where');

    if (hit) {
      s.trackedTrainId = hit.id;
      this.metro.setTracked(hit.id, code);
      where.textContent = hit.status === 'moving'
        ? `nearing ${this.sim.stations[hit.nextStation]?.name ?? '—'} · ${shortCountdown(hit.etaNext)}`
        : hit.status === 'dwelling'
          ? `at ${this.sim.stations[hit.atStation]?.name ?? '—'}`
          : `arrived ${this.sim.stations[hit.atStation]?.name ?? '—'}`;
      $('tp-tracked').hidden = s.selectedTrainId !== hit.id;
      return;
    }

    // not running: say something useful instead of silently showing nothing
    s.trackedTrainId = null;
    this.metro.setTracked(null, null);
    const pattern = this.sim.patterns[patternIdx];
    const endRel = this.sim.endRel[patternIdx];

    if (dateKey !== s.todayKey && dateKey !== s.yesterdayKey) {
      where.textContent = `that run was on ${dateKey.slice(6, 8)}/${dateKey.slice(4, 6)} — not today`;
    } else if (t < start) {
      where.textContent = `departs ${hhmm(start)} · in ${countdown(start - t)}`;
    } else {
      where.textContent = `finished at ${hhmm(start + endRel)} (${esc(pattern.to)})`;
    }
    $('tp-tracked').hidden = true;
  }

  /* ------------------------------------------------------------------ *
   *  Per-tick updates
   * ------------------------------------------------------------------ */

  updateHeader(ist, displaySec, serviceId, peak, trainCount) {
    $('clock').textContent = hhmmss(displaySec);
    $('clock-date').textContent = this.state.live ? ist.pretty : `${ist.pretty} · simulated`;

    const svcLabel = { weekday: 'Tue–Sat', monday: 'Monday', sunday: 'Sunday', holiday: 'Public holiday' };
    const badge = $('service-badge');
    badge.textContent = svcLabel[serviceId] || serviceId || 'no service';
    badge.className = 'badge';

    const pb = $('peak-badge');
    pb.textContent = peak.label;
    pb.className = `badge ${peak.kind}`;

    $('stat-trains').textContent = trainCount;

    // corner chips mirror the header while shrunk
    if (this.state.shrunk) {
      $('chip-count').textContent = trainCount;
      $('chip-clock').textContent = hhmm(displaySec);
    }

    if (!this.state.sliderDragging) $('time-slider').value = Math.floor(displaySec % 86400);
  }

  updateLineCounts(trains) {
    const counts = new Map();
    for (const t of trains) counts.set(t.line, (counts.get(t.line) || 0) + 1);
    for (const [id, row] of this.lineRows) {
      row.querySelector('[data-count]').textContent = counts.get(id) || 0;
    }
  }

  updateTrainList(trains, now) {
    const s = this.state;
    const sim = this.sim;

    let items = trains.filter((t) => s.lines.has(t.line));

    if (s.filter) {
      const q = s.filter;
      items = items.filter((t) => {
        const next = t.nextStation ? sim.stations[t.nextStation]?.name : '';
        const at = t.atStation ? sim.stations[t.atStation]?.name : '';
        return (
          t.headsign.toLowerCase().includes(q) ||
          (next && next.toLowerCase().includes(q)) ||
          (at && at.toLowerCase().includes(q)) ||
          t.run.toLowerCase().includes(q) ||
          sim.stations[t.origin]?.name.toLowerCase().includes(q)
        );
      });
    }

    const lineOrder = new Map(sim.lines.map((l, i) => [l.id, i]));
    if (s.sort === 'eta') {
      items.sort((a, b) => a.etaNext - b.etaNext || a.run.localeCompare(b.run));
    } else {
      items.sort((a, b) =>
        lineOrder.get(a.line) - lineOrder.get(b.line) ||
        a.dir - b.dir ||
        a.start - b.start);
    }

    const host = $('train-list');

    if (!items.length) {
      host._keyed?.clear();
      host.innerHTML = `<div class="empty">${trains.length
        ? 'No trains match this filter.'
        : 'No trains in service at this time.<br>Namma Metro runs roughly 05:00–00:00.'}</div>`;
      return;
    }
    if (host.querySelector('.empty')) host.innerHTML = '';

    // interleave group headers when grouping by line
    const rows = [];
    let lastLine = null;
    for (const t of items) {
      if (s.sort === 'line' && t.line !== lastLine) {
        lastLine = t.line;
        const line = sim.lineById.get(t.line);
        rows.push({ _group: true, id: `g:${t.line}`, label: `${line.name} Line`, count: items.filter((x) => x.line === t.line).length });
      }
      rows.push(t);
    }

    keyedList(host, rows, {
      key: (r) => r.id,
      create: (r) => {
        if (r._group) {
          const el = document.createElement('div');
          el.className = 'group-label';
          return el;
        }
        const el = document.createElement('div');
        el.className = 'train-row';
        el.setAttribute('role', 'listitem');
        el.innerHTML =
          `<span class="train-bar"></span>` +
          `<span class="train-mid"><span class="train-dest"></span><span class="train-where"></span></span>` +
          `<span class="train-eta"><span data-eta></span><small data-etak></small></span>`;
        el.addEventListener('click', () => {
          this.selectTrain(r.id, true);
        });
        return el;
      },
      update: (el, r) => {
        if (r._group) {
          el.textContent = `${r.label} — ${r.count}`;
          return;
        }
        el.querySelector('.train-bar').style.background = this.metro.lineColor(r.line);
        el.querySelector('.train-dest').innerHTML =
          `${esc(sim.stations[r.origin]?.name || '')}<span class="arrow">→</span>${esc(r.headsign)}`;

        const where = el.querySelector('.train-where');
        if (r.status === 'moving') {
          where.innerHTML = `approaching ${esc(sim.stations[r.nextStation]?.name || '—')} · ${Math.round(r.speedKmh)} km/h`;
        } else if (r.status === 'dwelling') {
          where.innerHTML = `<span class="at">at ${esc(sim.stations[r.atStation]?.name || '—')}</span> · doors open`;
        } else {
          where.innerHTML = `<span class="at">terminated</span> at ${esc(sim.stations[r.atStation]?.name || '—')}`;
        }

        const eta = el.querySelector('[data-eta]');
        const etak = el.querySelector('[data-etak]');
        if (r.nextStation) {
          eta.textContent = shortCountdown(r.etaNext);
          etak.textContent = 'to next';
        } else {
          eta.textContent = '—';
          etak.textContent = 'end';
        }
        el.classList.toggle('is-sel', r.id === this.state.selectedTrainId);
      },
    });
  }

  updateStationBoard(t, contexts) {
    const id = this.state.selectedStation;
    if (!id) return;

    const board = this.sim.boardFor(id, t, contexts, 16);
    const host = $('sp-board');

    if (!board.length) {
      host._keyed?.clear();
      host.innerHTML = '<div class="empty">No more trains scheduled from this station today.</div>';
      return;
    }
    if (host.querySelector('.empty')) host.innerHTML = '';

    // group by destination direction, preserving soonest-first order
    const rows = [];
    const seenDir = new Set();
    for (const r of board) {
      const dirKey = `${r.line}:${r.dir}`;
      if (!seenDir.has(dirKey)) {
        seenDir.add(dirKey);
        const line = this.sim.lineById.get(r.line);
        const term = this.sim.stations[line.stations[r.dir === 0 ? line.stations.length - 1 : 0]];
        rows.push({ _group: true, id: `g:${dirKey}`, label: `${line.name} Line · towards ${term?.name ?? r.headsign}` });
      }
      rows.push(r);
    }

    keyedList(host, rows, {
      key: (r) => r.id ?? r.trainId,
      create: (r) => {
        if (r._group) {
          const el = document.createElement('div');
          el.className = 'dep-dir';
          return el;
        }
        const el = document.createElement('div');
        el.className = 'dep-row';
        el.innerHTML =
          `<span class="dep-bar"></span>` +
          `<span><span class="dep-to"></span><span class="dep-note"></span></span>` +
          `<span class="dep-clock"></span>` +
          `<span class="dep-in"></span>`;
        el.addEventListener('click', () => this.selectTrain(r.trainId, true));
        return el;
      },
      update: (el, r) => {
        if (r._group) { el.textContent = r.label; return; }
        el.querySelector('.dep-bar').style.background = this.metro.lineColor(r.line);
        el.querySelector('.dep-to').textContent = r.terminates ? `${r.headsign} (terminates)` : r.headsign;
        el.querySelector('.dep-note').textContent = r.terminates
          ? `arrives from ${this.sim.stations[r.origin]?.name ?? ''}`
          : `${r.stopsToEnd} stop${r.stopsToEnd === 1 ? '' : 's'} to ${this.sim.stations[r.destination]?.name ?? ''}`;
        el.querySelector('.dep-clock').textContent = hhmm(r.arrAbs);
        const inEl = el.querySelector('.dep-in');
        inEl.textContent = r.waitSec <= 20 ? 'now' : shortCountdown(r.waitSec);
        inEl.classList.toggle('now', r.waitSec <= 60);
        el.classList.toggle('imminent', r.waitSec <= 45);
      },
    });
  }

  updateFreqStrip(service, t, peak) {
    const host = $('freq-strip');
    const items = this.sim.lines.map((line) => {
      const hw = service ? this.sim.headwayNow(service, line.id, t) : null;
      return { line, hw };
    });

    keyedList(host, items, {
      key: (i) => i.line.id,
      create: () => {
        const el = document.createElement('div');
        el.className = 'freq-chip';
        el.innerHTML = `<span class="fc-dot"></span><span class="fc-name"></span><span class="fc-val"></span><span class="fc-k"></span>`;
        return el;
      },
      update: (el, { line, hw }) => {
        el.querySelector('.fc-dot').style.background = this.metro.lineColor(line.id);
        el.querySelector('.fc-name').textContent = line.name;
        el.querySelector('.fc-val').textContent = hw == null ? '—' : `${minutes(hw)} min`;
        el.querySelector('.fc-k').textContent = hw == null ? 'no service' : 'between trains';
        el.classList.toggle('dim', hw == null || !this.state.lines.has(line.id));
      },
    });
  }

  /* ------------------------------------------------------------------ *
   *  Train detail panel + live strip map
   * ------------------------------------------------------------------ */

  /** Text + numbers. Called a few times a second. */
  updateTrainPanel(train) {
    if (!train) {
      if (this.state.selectedTrainId) return; // loop will clean up
      $('train-panel').hidden = true;
      return;
    }
    const sim = this.sim;
    const line = sim.lineById.get(train.line);

    const badge = $('tp-line');
    badge.textContent = `${line.name} Line`;
    const lc = this.metro.lineColor(train.line);
    badge.style.background = lc;
    badge.style.color = pickText(lc);

    $('tp-run').textContent = `run ${train.run}`;
    $('tp-loop').hidden = !train.isShortLoop;

    $('tp-route').textContent =
      `${sim.stations[train.origin]?.name} → ${sim.stations[train.destination]?.name}`;

    const statusEl = $('tp-status');
    if (train.status === 'moving') {
      statusEl.innerHTML = `departed ${hhmm(train.startAbs)} · ${train.distKm.toFixed(1)} of ${train.totalKm.toFixed(1)} km · <span class="hl">en route</span>`;
    } else if (train.status === 'dwelling') {
      statusEl.innerHTML = `<span class="hl">at ${esc(sim.stations[train.atStation]?.name ?? '')}</span> · doors close in ${countdown(train.dwellLeft)}`;
    } else {
      statusEl.innerHTML = `<span class="hl">terminated</span> at ${esc(sim.stations[train.atStation]?.name ?? '')}`;
    }

    // speed + gauge (Namma Metro trains are limited to 80 km/h)
    $('tp-speed').textContent = train.status === 'moving' ? `${Math.round(train.speedKmh)} km/h` : '0 km/h';
    $('tp-gauge-bar').style.width = `${Math.min(100, (train.speedKmh / 80) * 100).toFixed(0)}%`;
    $('tp-gauge-bar').style.background = train.status === 'moving' ? 'var(--live)' : 'var(--txt-3)';

    $('tp-next').textContent = train.nextStation
      ? sim.stations[train.nextStation]?.name ?? '—'
      : 'end of run';
    $('tp-eta').textContent = train.nextStation ? countdown(train.etaNext) : '—';

    // ---- strip map ----
    if (this.stripTrainId !== train.id) this._buildStrip(train);
    this._refreshStripText(train);

    const remaining = this.stripCalls.length - 1 - Math.floor(train.stopPos);
    $('tp-remaining').textContent = train.nextStation
      ? `${remaining} to go · arrives ${hhmm(this.stripCalls[this.stripCalls.length - 1].arr)}`
      : 'journey complete';
  }

  /** Build one row per station call. Runs once when the selection changes. */
  _buildStrip(train) {
    const sim = this.sim;
    const line = sim.lineById.get(train.line);
    const calls = sim.callsFor(train, 100);

    this.stripCalls = calls;
    this.stripTrainId = train.id;

    const host = $('strip-stops');
    host.innerHTML = '';
    this.stripRowEls = calls.map((c, i) => {
      const st = sim.stations[c.station];
      const el = document.createElement('div');
      el.className = 'strip-stop';
      const isTerminus = i === calls.length - 1;
      if (st.lines.length > 1) el.classList.add('interchange');
      if (isTerminus) el.classList.add('terminus');
      el.innerHTML =
        `<span class="ss-dot"></span>` +
        `<span class="ss-name">${esc(st.name)}</span>` +
        (st.lines.length > 1 ? `<span class="ss-badge">interchange</span>` : '') +
        `<span class="ss-time">${hhmm(c.arr)}</span>` +
        `<span class="ss-in"></span>`;
      el.addEventListener('click', () => this.openStation(c.station));
      host.appendChild(el);
      return el;
    });

    // colour the rail to match the line
    $('strip-done').style.background = this.metro.lineColor(train.line);
    const rail = document.querySelector('.strip-rail');
    if (rail) rail.style.background = 'rgba(255,255,255,.13)';

    // measure the real row height once so the marker maths stays honest
    if (this.stripRowEls.length) {
      const h = this.stripRowEls[0].getBoundingClientRect().height;
      if (h > 4) this.stripRowH = h;
    }
    this.stripUserScrolledAt = 0;
  }

  /** Per-stop countdowns and past/next classes. A few times a second. */
  _refreshStripText(train) {
    const now = train.startAbs + train.rel;
    const cur = Math.floor(train.stopPos);

    for (let i = 0; i < this.stripRowEls.length; i++) {
      const el = this.stripRowEls[i];
      const c = this.stripCalls[i];
      const passed = i < cur || (i === cur && train.status !== 'moving' && i !== this.stripRowEls.length - 1);
      const isNext = i === train.nextIdx;

      el.classList.toggle('past', i < cur);
      el.classList.toggle('done', passed);
      el.classList.toggle('next', isNext);

      const inEl = el.querySelector('.ss-in');
      const wait = c.arr - now;
      if (i < cur) inEl.textContent = '';
      else if (i === cur && train.status !== 'moving') inEl.textContent = 'here';
      else inEl.textContent = wait <= 0 ? 'now' : shortCountdown(wait);
    }
  }

  /**
   * Slide the marker down the rail. Called every animation frame, which is what
   * makes the strip map read as live rather than as a refreshing table.
   */
  updateStripLive(train) {
    if (!train || this.stripTrainId !== train.id || !this.stripRowEls.length) return;

    const h = this.stripRowH;
    const top = train.stopPos * h + h / 2;

    $('strip-train').style.top = `${top}px`;
    $('strip-done').style.height = `${Math.max(0, top - h / 2)}px`;

    // keep the train in view unless the user has just scrolled by hand
    const box = $('tp-strip');
    if (performance.now() - this.stripUserScrolledAt > 5000) {
      const target = top - box.clientHeight * 0.4;
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      box.scrollTop = Math.max(0, Math.min(max, target));
    }
  }

  /* ------------------------------------------------------------------ *
   *  Feedback
   * ------------------------------------------------------------------ */

  openFeedback() {
    $('fb-msg-out').textContent = '';
    $('fb-msg-out').className = 'share-msg';
    $('fb-send').disabled = false;
    $('fb-send').textContent = 'send feedback';
    this._syncMailto();
    $('fb-modal').hidden = false;
    setTimeout(() => $('fb-msg').focus(), 60);
  }

  _currentFeedback() {
    const kind = document.querySelector('input[name="kind"]:checked')?.value || 'idea';
    return {
      kind,
      message: $('fb-msg').value,
      contact: $('fb-contact').value,
      context: {
        ...(this.state.live ? { mode: 'live' } : { mode: 'simulated', at: hhmmss(this.state.simTime) }),
        theme: this.state.theme,
        service: this.state.serviceId,
        trains: this.state.trainsById?.size ?? 0,
      },
    };
  }

  _syncMailto() {
    $('fb-mailto').href = mailtoLink(this._currentFeedback());
  }

  async submitFeedback() {
    const out = $('fb-msg-out');
    const fb = this._currentFeedback();

    if (!fb.message.trim()) {
      out.className = 'share-msg bad';
      out.textContent = 'Please write a message first.';
      return;
    }

    $('fb-send').disabled = true;
    $('fb-send').textContent = 'sending…';

    const res = await sendFeedback(fb);

    if (res.ok) {
      out.className = 'share-msg ok';
      out.textContent = 'Thank you — that went straight through. I read every one of these.';
      $('fb-msg').value = '';
      $('fb-count').textContent = '0 / 2000';
      $('fb-send').textContent = 'sent ✓';
      setTimeout(() => { $('fb-modal').hidden = true; }, 1800);
      return;
    }

    $('fb-send').disabled = false;
    $('fb-send').textContent = 'try again';

    if (res.error === 'no-api') {
      out.className = 'share-msg warn';
      out.innerHTML = 'Saved in this browser — the feedback server isn\'t deployed yet. ' +
        'Use <strong>“or email it instead”</strong> to send it right now.';
    } else {
      out.className = 'share-msg warn';
      out.innerHTML = `Couldn't reach the server (${esc(res.error)}), so I've kept your message ` +
        'in this browser and will retry. You can also email it directly.';
    }
  }

  /* ------------------------------------------------------------------ *
   *  Info modal
   * ------------------------------------------------------------------ */

  _buildModal() {
    const sim = this.sim;
    const service = this.state.serviceId || 'weekday';
    const table = sim.windowTable(service);

    const spanRows = sim.lines.map((line) => {
      const sp = sim.serviceSpan(service, line.id);
      const first = sim.stations[line.stations[0]];
      const last = sim.stations[line.stations[line.stations.length - 1]];
      const lc = this.metro.lineColor(line.id);
      return `<tr>
        <td><span class="pill" style="background:${lc};color:${pickText(lc)}">${line.name}</span></td>
        <td>${esc(first.name)} ↔ ${esc(last.name)}</td>
        <td class="num">${line.stations.length}</td>
        <td class="num">${sp ? hhmm(sp.first) : '—'}</td>
        <td class="num">${sp ? hhmm(sp.last) : '—'}</td>
        <td class="num">${sp ? sp.trips : '—'}</td>
      </tr>`;
    }).join('');

    const freqRows = WINDOWS.map((w) => {
      const cells = sim.lines.map((line) => {
        const cell = table[line.id]?.find((x) => x.id === w.id);
        return `<td class="num">${cell?.headway ? `${minutes(cell.headway)} min` : '—'}</td>`;
      }).join('');
      return `<tr><td>${w.label}${w.peak ? ' <strong>·peak</strong>' : ''}</td>
        <td class="num">${hhmm(w.from)}–${hhmm(w.to)}</td>${cells}</tr>`;
    }).join('');

    const feed = this.meta?.feed || {};

    $('modal-body').innerHTML = `
      <h3>What you're looking at</h3>
      <p>Every marker is one Namma Metro train that, according to BMRCL's operating
      timetable, is out on the network <strong>at this exact second</strong>. Positions are
      interpolated along the real track alignment from OpenStreetMap, using each
      train's scheduled arrival and departure at every station it calls at, with an
      accelerate–cruise–brake profile between stops.</p>

      <h3>Is this actually real-time?</h3>
      <p>It is real-clock, not real-sensor. BMRCL does <strong>not</strong> publish a public
      real-time feed (no GTFS-Realtime endpoint), so no website can show true GPS
      positions of Namma Metro trains. What this tracker does instead is run the
      published timetable against the live Bengaluru clock, including the correct
      service pattern for today and the short-loop turnback services.</p>
      <ul>
        <li>Station-to-station timings are <strong>modelled</strong> from stop spacing, dwell time and
        average speed — BMRCL publishes only terminal times, not intermediate ones.</li>
        <li>Expect a discrepancy of a minute or two versus the train in front of you,
        and more during a disruption, since delays cannot be detected.</li>
        <li>The engine is fed by a swappable schedule layer, so if BMRCL ever opens a
        GTFS-Realtime feed it can be plugged in without rewriting the map.</li>
      </ul>

      <h3>Network &amp; service span <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--txt-3)">(${esc(service)} timetable)</span></h3>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Line</th><th>Route</th><th>Stns</th><th>First</th><th>Last</th><th>Trips/day</th></tr></thead>
        <tbody>${spanRows}</tbody>
      </table></div>

      <h3>Frequency by time of day</h3>
      <p>Median gap between trains in one direction, measured from the timetable itself
      rather than quoted from a press release.</p>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Period</th><th>Window</th>${sim.lines.map((l) => `<th>${l.name}</th>`).join('')}</tr></thead>
        <tbody>${freqRows}</tbody>
      </table></div>

      <h3>Controls</h3>
      <ul>
        <li>Click any <strong>train</strong> to open its live panel: speed, countdown to the next
        station, and a strip map of every remaining stop with the train sliding down it.</li>
        <li>Click any <strong>station</strong> for a live departure board.</li>
        <li>Drag the bottom slider to scrub through the day, or press <code>L</code> to jump back to live.</li>
        <li><code>S</code> opens share &amp; track, <code>R</code> resets the view, <code>Esc</code> closes panels.</li>
      </ul>

      <h3>Tracking a friend's train</h3>
      <p>Select the train you're on and press <strong>share this train</strong>. You get a short code
      like <code>MTR-4K7P-2XQ8</code> — read it out, message it, or send the link. Whoever
      enters it sees that exact train ringed and labelled while every other train
      fades back, so they can watch how far apart you are.</p>
      <p>The code encodes the service day, the stopping pattern and the second the run
      left its origin, with a check character so a mistyped letter is rejected rather
      than silently pointing at the wrong train. Nothing is uploaded — the code is
      self-contained, so there is no account, no server and no tracking of you.</p>

      <h3>Data &amp; credits</h3>
      <p>Timetable and station data: <strong>${esc(feed.feed_publisher_name || 'BMRCL')}</strong>,
      via the unofficial <a href="https://github.com/Vonter/bmrcl-gtfs" target="_blank" rel="noopener">Vonter/bmrcl-gtfs</a>
      dataset (feed version <code>${esc(feed.feed_version || '—')}</code>).
      Track geometry and station coordinates from
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors.
      Basemap tiles by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>.
      Rendering with <a href="https://maplibre.org" target="_blank" rel="noopener">MapLibre GL JS</a>.</p>
      <p style="color:var(--txt-3);font-size:.8rem">Not affiliated with or endorsed by BMRCL. Do not rely on this
      for catching your last train.</p>
    `;
  }
}

/** One-line status used in map hover popups. */
export function describeTrain(sim, t) {
  if (t.status === 'moving') {
    return `approaching ${sim.stations[t.nextStation]?.name ?? '—'} · ${countdown(t.etaNext)} · ${Math.round(t.speedKmh)} km/h`;
  }
  if (t.status === 'dwelling') {
    return `at ${sim.stations[t.atStation]?.name ?? '—'} · departs in ${countdown(t.dwellLeft)}`;
  }
  return `terminated at ${sim.stations[t.atStation]?.name ?? '—'}`;
}
