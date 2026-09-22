/**
 * simulation.js — turns the published timetable into live train positions.
 *
 * There is no public real-time feed for Namma Metro, so "live" here means:
 * take the timetable BMRCL actually operates today, advance it with the real
 * Bengaluru clock, and interpolate each train between its scheduled calls. A
 * train shown pulling into Indiranagar is the train that is scheduled to be
 * pulling into Indiranagar at this exact second.
 *
 * Motion between two stations uses a trapezoidal speed profile (accelerate,
 * cruise, brake) instead of a linear ramp, because a linear ramp reads as
 * obviously fake — real trains leave a platform slowly and coast into the next.
 */

import { pointAtDistance } from './geometry.js';
import { hhmm, SEC_PER_DAY } from './clock.js';

/* ------------------------------------------------------------------ *
 *  Speed profile
 * ------------------------------------------------------------------ */

const ACCEL = 0.30;   // fraction of the run spent accelerating
const BRAKE = 0.30;   // fraction spent braking
const VPEAK = 1 / (1 - (ACCEL + BRAKE) / 2); // normalised cruise speed

/** Fraction of the distance covered after `tf` (0..1) of the running time. */
function distFraction(tf) {
  if (tf <= 0) return 0;
  if (tf >= 1) return 1;
  if (tf < ACCEL) return (0.5 * VPEAK * tf * tf) / ACCEL;
  const dAccel = 0.5 * VPEAK * ACCEL;
  if (tf < 1 - BRAKE) return dAccel + VPEAK * (tf - ACCEL);
  const u = tf - (1 - BRAKE);
  return dAccel + VPEAK * (1 - BRAKE - ACCEL) + VPEAK * u - (0.5 * VPEAK * u * u) / BRAKE;
}

/** Instantaneous speed at `tf`, as a multiple of the segment's average speed. */
function speedFraction(tf) {
  if (tf <= 0 || tf >= 1) return 0;
  if (tf < ACCEL) return (VPEAK * tf) / ACCEL;
  if (tf < 1 - BRAKE) return VPEAK;
  return VPEAK * (1 - (tf - (1 - BRAKE)) / BRAKE);
}

/* ------------------------------------------------------------------ *
 *  Small sorted-array helpers
 * ------------------------------------------------------------------ */

/** First index in `arr` (of [_, start] pairs) whose start >= target. */
function lowerBoundPair(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][1] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** First index in a plain number array whose value >= target. */
function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const LINE_ABBR = { PURPLE: 'PU', GREEN: 'GR', YELLOW: 'YL' };

/** Frequency windows used for the peak / off-peak breakdown. */
export const WINDOWS = [
  { id: 'early',   label: 'Early morning', from: 4.5 * 3600, to:  7 * 3600 },
  { id: 'ampeak',  label: 'Morning peak',  from:   7 * 3600, to: 11 * 3600, peak: true },
  { id: 'midday',  label: 'Midday',        from:  11 * 3600, to: 16 * 3600 },
  { id: 'pmpeak',  label: 'Evening peak',  from:  16 * 3600, to: 20.5 * 3600, peak: true },
  { id: 'evening', label: 'Evening',       from: 20.5 * 3600, to: 22 * 3600 },
  { id: 'late',    label: 'Late night',    from:  22 * 3600, to: 24.6 * 3600 },
];

export class Simulation {
  /**
   * @param {object} network  public/data/network.json
   * @param {object} schedule public/data/schedule.json
   */
  constructor(network, schedule) {
    this.network = network;
    this.schedule = schedule;
    this.patterns = schedule.patterns;
    this.stations = network.stations;
    this.lines = network.lines;
    this.lineById = new Map(network.lines.map((l) => [l.id, l]));

    this.maxRuntime = this.patterns.reduce((m, p) => Math.max(m, p.runtime), 0);

    /**
     * How long after departure a train is still worth drawing. The feed models
     * a dwell at the terminus (departure_time > arrival_time on the last stop),
     * so a train sits in the terminal platform for a minute or two instead of
     * blinking out the instant it arrives.
     */
    this.endRel = this.patterns.map((p) => Math.max(p.runtime, p.dep[p.dep.length - 1]));
    this.maxRuntime = Math.max(this.maxRuntime, ...this.endRel);

    /** stationId -> [[patternIdx, stopIdx], …] */
    this.callsByStation = new Map();
    this.patterns.forEach((p, pi) => {
      p.stops.forEach((sid, si) => {
        let a = this.callsByStation.get(sid);
        if (!a) { a = []; this.callsByStation.set(sid, a); }
        a.push([pi, si]);
      });
    });

    /** serviceId -> patternIdx -> sorted start times */
    this.startsByPattern = {};
    for (const [svc, deps] of Object.entries(schedule.departures)) {
      const byPat = new Map();
      for (const [pi, start] of deps) {
        let a = byPat.get(pi);
        if (!a) { a = []; byPat.set(pi, a); }
        a.push(start);
      }
      for (const a of byPat.values()) a.sort((x, y) => x - y);
      this.startsByPattern[svc] = byPat;
    }

    /** serviceId -> lineId -> dir -> sorted start times (for headway maths) */
    this.startsByLineDir = {};
    for (const [svc, deps] of Object.entries(schedule.departures)) {
      const m = {};
      for (const [pi, start] of deps) {
        const p = this.patterns[pi];
        ((m[p.line] ||= {})[p.dir] ||= []).push(start);
      }
      for (const line of Object.values(m)) for (const d of Object.values(line)) d.sort((a, b) => a - b);
      this.startsByLineDir[svc] = m;
    }

    this._profileCache = new Map();
    this._windowCache = new Map();
  }

  /* ---------------------------------------------------------------- *
   *  Live trains
   * ---------------------------------------------------------------- */

  /**
   * Every train in service at time `t`.
   *
   * @param {Array<{service:string, offset:number}>} contexts
   *   Service days to evaluate. Normally two entries: today at offset 0, and
   *   yesterday at offset 86400 — the latter catches the last few runs that
   *   departed at 23:55 and are still out on the line at 00:20.
   * @param {number} t seconds since IST midnight today
   */
  trainsAt(t, contexts) {
    const out = [];
    for (const ctx of contexts) {
      const deps = this.schedule.departures[ctx.service];
      if (!deps) continue;
      const local = t + ctx.offset;

      // Only departures in (local - maxRuntime, local] can still be running.
      const lo = lowerBoundPair(deps, local - this.maxRuntime);
      for (let k = lo; k < deps.length; k++) {
        const [pi, start] = deps[k];
        if (start > local) break;
        const train = this.resolve(pi, start, local, ctx);
        if (train) out.push(train);
      }
    }
    return out;
  }

  /** Materialise one train, or null if it isn't running at `local`. */
  resolve(pi, start, local, ctx) {
    const p = this.patterns[pi];
    const rel = local - start;
    if (rel < 0 || rel > this.endRel[pi]) return null;

    const n = p.stops.length;

    // index of the last stop this train has already departed
    let i = lowerBound(p.dep, rel);
    if (i >= n || p.dep[i] > rel) i--;
    if (i < 0) i = 0;

    let status, fromIdx, nextIdx, km, speedKmh, etaNext, dwellLeft = 0, stopPos;

    if (i >= n - 1) {
      // arrived at its final station
      status = 'arrived';
      fromIdx = n - 1;
      nextIdx = null;
      km = p.dist[n - 1];
      speedKmh = 0;
      etaNext = 0;
      stopPos = n - 1;
    } else {
      const j = i + 1;
      if (rel < p.arr[j]) {
        // running between stop i and stop j
        const t0 = p.dep[i], t1 = p.arr[j];
        const span = t1 - t0;
        const tf = span > 0 ? (rel - t0) / span : 1;
        const d0 = p.dist[i], d1 = p.dist[j];
        const df = distFraction(tf);
        status = 'moving';
        fromIdx = i;
        nextIdx = j;
        km = d0 + (d1 - d0) * df;
        speedKmh = span > 0 ? speedFraction(tf) * ((d1 - d0) / span) * 3600 : 0;
        etaNext = t1 - rel;
        stopPos = i + df;              // fractional stop index, for the strip map
      } else {
        // standing at stop j with its doors open
        fromIdx = j;
        km = p.dist[j];
        speedKmh = 0;
        dwellLeft = Math.max(0, p.dep[j] - rel);
        nextIdx = j + 1 < n ? j + 1 : null;
        // standing at the last stop means the run is over, not a normal dwell
        status = nextIdx === null ? 'arrived' : 'dwelling';
        etaNext = nextIdx !== null ? p.arr[nextIdx] - rel : 0;
        stopPos = j;
      }
    }

    const shape = this.network.shapes[p.shape];
    const pos = pointAtDistance(shape, km);

    return {
      id: `${ctx.service}|${pi}|${start}`,
      patternIdx: pi,
      start,
      startAbs: start - ctx.offset,     // in "today" seconds, for display
      service: ctx.service,
      dateKey: ctx.dateKey,             // the service day this run belongs to
      line: p.line,
      dir: p.dir,
      color: this.lineById.get(p.line)?.color || '#888',
      run: `${LINE_ABBR[p.line] || p.line.slice(0, 2)} ${hhmm(start)}`,
      headsign: p.to,
      origin: p.stops[0],
      destination: p.stops[n - 1],
      stopCount: n,
      status,
      atStation: status === 'moving' ? null : p.stops[fromIdx],
      prevStation: p.stops[Math.max(0, status === 'moving' ? fromIdx : fromIdx - 1)],
      nextStation: nextIdx !== null ? p.stops[nextIdx] : null,
      nextIdx,
      fromIdx,
      etaNext,
      dwellLeft,
      speedKmh,
      stopPos,
      distKm: km,
      totalKm: p.dist[n - 1],
      progress: p.runtime > 0 ? Math.min(1, rel / p.runtime) : 1,
      rel,
      runtime: p.runtime,
      lon: pos.lon,
      lat: pos.lat,
      bearing: pos.bearing,
      isShortLoop: n < (this.lineById.get(p.line)?.stations.length || n),
    };
  }

  /** Remaining (and recent) calls for a train, for the follow panel. */
  callsFor(train, limit = 40) {
    const p = this.patterns[train.patternIdx];
    const out = [];
    for (let i = 0; i < p.stops.length && out.length < limit; i++) {
      out.push({
        station: p.stops[i],
        name: this.stations[p.stops[i]]?.name || p.stops[i],
        arr: train.startAbs + p.arr[i],
        dep: train.startAbs + p.dep[i],
        past: p.arr[i] < train.rel - 1,
        isNext: i === train.nextIdx,
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   *  Station departure board
   * ---------------------------------------------------------------- */

  /**
   * Upcoming calls at a station, ordered by arrival time.
   * @returns {Array<{arr,dep,line,dir,headsign,destination,terminates,patternIdx,start,trainId,waitSec}>}
   */
  boardFor(stationId, t, contexts, limit = 14) {
    const calls = this.callsByStation.get(stationId);
    if (!calls) return [];
    const rows = [];

    for (const ctx of contexts) {
      const byPat = this.startsByPattern[ctx.service];
      if (!byPat) continue;
      const local = t + ctx.offset;

      for (const [pi, si] of calls) {
        const starts = byPat.get(pi);
        if (!starts) continue;
        const p = this.patterns[pi];
        const offset = p.arr[si];

        // a call is upcoming when start + offset >= local (allow 30 s of slack
        // so a train sitting at the platform right now is still listed)
        let idx = lowerBound(starts, local - offset - 30);
        for (let c = 0; c < 4 && idx < starts.length; c++, idx++) {
          const start = starts[idx];
          const arr = start + offset;
          if (arr < local - 30) { c--; continue; }
          rows.push({
            trainId: `${ctx.service}|${pi}|${start}`,
            patternIdx: pi,
            start,
            startAbs: start - ctx.offset,
            stopIdx: si,
            line: p.line,
            dir: p.dir,
            color: this.lineById.get(p.line)?.color || '#888',
            headsign: p.to,
            destination: p.stops[p.stops.length - 1],
            origin: p.stops[0],
            terminates: si === p.stops.length - 1,
            arrAbs: arr - ctx.offset,
            depAbs: start + p.dep[si] - ctx.offset,
            waitSec: arr - local,
            stopsToEnd: p.stops.length - 1 - si,
          });
        }
      }
    }

    rows.sort((a, b) => a.waitSec - b.waitSec);

    // de-duplicate: the same physical train can be matched twice across contexts
    const seen = new Set();
    return rows.filter((r) => {
      if (seen.has(r.trainId)) return false;
      seen.add(r.trainId);
      return true;
    }).slice(0, limit);
  }

  /* ---------------------------------------------------------------- *
   *  Frequency / peak analysis
   * ---------------------------------------------------------------- */

  /**
   * Headway in seconds around time `t` for a line, derived from the actual
   * spacing of trips in today's timetable. Returns null outside service hours.
   */
  headwayNow(service, lineId, t) {
    const dirs = this.startsByLineDir[service]?.[lineId];
    if (!dirs) return null;
    const perDir = [];
    for (const starts of Object.values(dirs)) {
      const h = medianGapAround(starts, t, 3);
      if (h != null) perDir.push(h);
    }
    if (!perDir.length) return null;
    return perDir.reduce((a, b) => a + b, 0) / perDir.length;
  }

  /** Median headway per line for each named window (the peak / off-peak table). */
  windowTable(service) {
    if (this._windowCache.has(service)) return this._windowCache.get(service);
    const table = {};
    for (const line of this.lines) {
      const dirs = this.startsByLineDir[service]?.[line.id];
      table[line.id] = WINDOWS.map((w) => {
        if (!dirs) return { ...w, headway: null, trips: 0 };
        const gaps = [];
        let trips = 0;
        for (const starts of Object.values(dirs)) {
          const inW = starts.filter((s) => s >= w.from && s < w.to);
          trips += inW.length;
          for (let i = 1; i < inW.length; i++) gaps.push(inW[i] - inW[i - 1]);
        }
        return { ...w, headway: gaps.length ? median(gaps) : null, trips };
      });
    }
    this._windowCache.set(service, table);
    return table;
  }

  /** Trains-in-motion for every minute of the service day (cached per service). */
  loadProfile(service) {
    if (this._profileCache.has(service)) return this._profileCache.get(service);
    const deps = this.schedule.departures[service] || [];
    const prof = new Float32Array(1500); // minutes 0 .. 25 h, covers past-midnight
    for (const [pi, start] of deps) {
      const p = this.patterns[pi];
      const a = Math.floor(start / 60);
      const b = Math.ceil((start + p.runtime) / 60);
      for (let m = a; m < b && m < prof.length; m++) prof[m]++;
    }
    let peak = 0;
    for (const v of prof) if (v > peak) peak = v;
    const res = { prof, peak };
    this._profileCache.set(service, res);
    return res;
  }

  /**
   * Peak classification for the current moment, derived from how many trains
   * the timetable puts on the network now versus the busiest minute of the day.
   */
  peakState(service, t) {
    const { prof, peak } = this.loadProfile(service);
    const m = Math.floor(t / 60);
    const now = prof[m] || 0;
    if (now === 0) return { label: 'no service', kind: 'closed', now, peak, ratio: 0 };
    const ratio = peak ? now / peak : 0;
    if (ratio >= 0.82) return { label: 'peak hours', kind: 'peak', now, peak, ratio };
    if (ratio >= 0.5) return { label: 'off-peak', kind: 'offpeak', now, peak, ratio };
    return { label: 'early / late', kind: 'offpeak', now, peak, ratio };
  }

  /** First and last departure of the day per line. */
  serviceSpan(service, lineId) {
    const dirs = this.startsByLineDir[service]?.[lineId];
    if (!dirs) return null;
    let first = Infinity, last = -Infinity, trips = 0;
    for (const starts of Object.values(dirs)) {
      if (!starts.length) continue;
      first = Math.min(first, starts[0]);
      last = Math.max(last, starts[starts.length - 1]);
      trips += starts.length;
    }
    return first === Infinity ? null : { first, last, trips };
  }
}

/* ------------------------------------------------------------------ */

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median gap between consecutive values, over the `span` gaps either side of t. */
function medianGapAround(starts, t, span) {
  if (starts.length < 2) return null;
  if (t < starts[0] - 1800 || t > starts[starts.length - 1] + 5400) return null;
  const i = lowerBound(starts, t);
  const gaps = [];
  for (let k = Math.max(1, i - span); k <= Math.min(starts.length - 1, i + span); k++) {
    gaps.push(starts[k] - starts[k - 1]);
  }
  return gaps.length ? median(gaps) : null;
}

export { SEC_PER_DAY };
