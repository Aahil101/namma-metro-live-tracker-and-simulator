/**
 * observations.js — user-reported arrivals, and the corrections derived from them.
 *
 * WHY THIS EXISTS
 *
 * BMRCL publishes terminal times only. Every intermediate station time in the
 * feed is *modelled* from stop spacing, an assumed dwell and an assumed speed,
 * so the error grows with distance from the terminus. Measured at Beratena
 * Agrahara (stop 6 of 16 on the Yellow Line), the feed says 09:02:46 while the
 * train actually arrived around 09:01 — the model runs roughly 1.5–2 minutes
 * late by that point. That is a modelling limitation, not stale data: the feed
 * is the newest upstream publishes.
 *
 * The only way to correct it is ground truth. When you tap "already arrived?"
 * on a train, that is a measurement, and this module turns it into a correction:
 *
 *   offset = observedTime - scheduledArrivalTime        (negative = running early)
 *
 * The offset is applied three ways, in decreasing confidence:
 *
 *   1. that exact train run, for the rest of its journey        (exact)
 *   2. other trains on the same line + direction, as the median
 *      of recent observations                                    (inferred)
 *   3. nothing at all, if there are no observations              (schedule only)
 *
 * Everything lives in localStorage, in this browser, and expires. Nothing is
 * uploaded. A correction is always labelled in the UI so a reading derived from
 * your own report is never mistaken for the published timetable.
 */

const KEY = 'nml.observations';

/** Observations older than this stop influencing anything (6 hours). */
const TTL_SEC = 6 * 3600;

/** Cap a correction to something physically plausible. */
const MAX_OFFSET_SEC = 15 * 60;

/**
 * @typedef {object} Observation
 * @property {string} trainId      simulation train id
 * @property {number} patternIdx
 * @property {number} start        the run's departure second (service-day)
 * @property {string} dateKey      service day, YYYYMMDD
 * @property {string} line
 * @property {number} dir
 * @property {string} station      station id the user marked as reached
 * @property {number} stopIdx      index of that station in the pattern
 * @property {number} scheduledArr absolute seconds (today-relative)
 * @property {number} observedAt   absolute seconds (today-relative)
 * @property {number} offset       observedAt - scheduledArr, clamped
 * @property {number} ts           unix ms, for expiry
 */

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-200))); } catch { /* full/private */ }
}

/** Drop anything past its useful life. */
function prune(list, nowMs = Date.now()) {
  return list.filter((o) => nowMs - o.ts < TTL_SEC * 1000);
}

export function allObservations() {
  const list = prune(readAll());
  return list;
}

export function clearObservations() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function removeObservation(ts) {
  writeAll(prune(readAll()).filter((o) => o.ts !== ts));
}

/**
 * Record that a train had already reached `station` at `observedAt`.
 *
 * @param {object} train     a resolved train from Simulation
 * @param {object} pattern   schedule.patterns[train.patternIdx]
 * @param {number} stopIdx   index in the pattern of the station reached
 * @param {number} observedAt seconds since IST midnight, today-relative
 * @returns {Observation}
 */
export function markArrived(train, pattern, stopIdx, observedAt) {
  const scheduledArr = train.startAbs + pattern.arr[stopIdx];
  let offset = observedAt - scheduledArr;
  offset = Math.max(-MAX_OFFSET_SEC, Math.min(MAX_OFFSET_SEC, offset));

  const obs = {
    trainId: train.id,
    patternIdx: train.patternIdx,
    start: train.start,
    dateKey: train.dateKey,
    line: train.line,
    dir: train.dir,
    station: pattern.stops[stopIdx],
    stopIdx,
    scheduledArr,
    observedAt,
    offset,
    ts: Date.now(),
  };

  // one observation per train per station; a re-mark replaces the old one
  const list = prune(readAll()).filter(
    (o) => !(o.trainId === obs.trainId && o.station === obs.station),
  );
  list.push(obs);
  writeAll(list);
  return obs;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Build the lookup the simulation consults on every frame.
 *
 * @returns {{
 *   byTrain: Map<string, number>,
 *   byLineDir: Map<string, number>,
 *   count: number,
 *   latest: Observation|null
 * }}
 */
export function buildCorrections(nowMs = Date.now()) {
  const list = prune(readAll(), nowMs);

  /** exact, per-run corrections — the most recent observation for each run wins */
  const byTrain = new Map();
  for (const o of list.sort((a, b) => a.ts - b.ts)) byTrain.set(o.trainId, o.offset);

  /** inferred, per line+direction — median of that group's observations */
  const groups = new Map();
  for (const o of list) {
    const k = `${o.line}|${o.dir}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o.offset);
  }
  const byLineDir = new Map();
  for (const [k, offsets] of groups) byLineDir.set(k, Math.round(median(offsets)));

  return {
    byTrain,
    byLineDir,
    count: list.length,
    latest: list.length ? list.reduce((a, b) => (a.ts > b.ts ? a : b)) : null,
  };
}

/**
 * Turn the corrections into the shape Simulation wants: a function from a
 * candidate run to a shift in seconds.
 */
export function offsetResolver(corrections) {
  if (!corrections || (!corrections.byTrain.size && !corrections.byLineDir.size)) return null;

  return function offsetFor(trainId, line, dir) {
    const exact = corrections.byTrain.get(trainId);
    if (exact !== undefined) return { offset: exact, kind: 'exact' };
    const inferred = corrections.byLineDir.get(`${line}|${dir}`);
    if (inferred !== undefined && inferred !== 0) return { offset: inferred, kind: 'inferred' };
    return null;
  };
}

/** Human summary for the red notice strip. */
export function describeCorrections(corrections) {
  if (!corrections || !corrections.count) return null;
  const groups = [...corrections.byLineDir.entries()];
  const worst = groups.reduce(
    (a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a),
    groups[0] || ['', 0],
  );
  const sec = worst[1];
  const sign = sec < 0 ? 'ahead of' : 'behind';
  const mmss = `${Math.floor(Math.abs(sec) / 60)}m ${String(Math.abs(sec) % 60).padStart(2, '0')}s`;
  return {
    count: corrections.count,
    seconds: sec,
    text: sec === 0
      ? `${corrections.count} report${corrections.count === 1 ? '' : 's'} from you — no net shift`
      : `Shifted by your ${corrections.count} report${corrections.count === 1 ? '' : 's'}: running ${mmss} ${sign} the timetable`,
  };
}

/** Export for filing upstream as a manual timetable correction. */
export function exportObservations() {
  const list = allObservations();
  const hhmmss = (s) => {
    const x = Math.round(((s % 86400) + 86400) % 86400);
    return [Math.floor(x / 3600), Math.floor(x / 60) % 60, x % 60]
      .map((n) => String(n).padStart(2, '0')).join(':');
  };
  return {
    note: 'Observed arrival times vs the modelled GTFS times. Suitable for filing '
      + 'as a manual correction upstream at github.com/Vonter/bmrcl-gtfs.',
    generated: new Date().toISOString(),
    observations: list.map((o) => ({
      line: o.line,
      direction: o.dir,
      station: o.station,
      serviceDay: o.dateKey,
      runDepartedAt: hhmmss(o.start),
      scheduledArrival: hhmmss(o.scheduledArr),
      observedArrival: hhmmss(o.observedAt),
      offsetSeconds: o.offset,
    })),
  };
}
