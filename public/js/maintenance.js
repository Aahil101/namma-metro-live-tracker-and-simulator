/**
 * maintenance.js — temporary speed restrictions and engineering works.
 *
 * BMRCL does not publish these in any machine-readable form, so they are listed
 * here by hand with the date they were observed and a source note. Each entry
 * caps the speed a train may use over a stretch of track; the simulation
 * redistributes time within the affected segments so the train visibly crawls
 * through the restriction, and the map draws a hazard overlay on that stretch.
 *
 * IMPORTANT — what this does and does not claim:
 *
 * The published timetable is left alone. If BMRCL has already padded the
 * schedule for the works, the train still keeps its booked arrival and simply
 * moves unevenly between stations (slow through the restriction, normal either
 * side), which is what actually happens on the ground. If the restriction is
 * too severe to fit the booked time, `extraDelaySec` lets you add a known,
 * explicit delay — it defaults to 0 rather than inventing a number.
 *
 * Remove an entry once the works finish, or set `until` and it expires itself.
 */

/**
 * @typedef {object} Restriction
 * @property {string}  id
 * @property {string}  line          route id: PURPLE | GREEN | YELLOW
 * @property {string}  from          station id at one end
 * @property {string}  to            station id at the other end
 * @property {number}  maxSpeedKmh   permitted speed over the stretch
 * @property {number}  extraDelaySec added to each affected segment (0 = keep the timetable)
 * @property {string}  label         short text drawn on the map
 * @property {string}  reason        longer explanation for the train panel
 * @property {string}  since         ISO date first observed
 * @property {string} [until]        ISO date it expires (optional)
 * @property {string}  source        how this was learned
 */

/** @type {Restriction[]} */
export const RESTRICTIONS = [
  {
    id: 'grn-rvr-jyn-2026-09',
    line: 'GREEN',
    from: 'RVR',            // Rashtreeya Vidyalaya Road
    to: 'JYN',              // Jayanagar
    maxSpeedKmh: 25,
    extraDelaySec: 0,
    label: 'MAINTENANCE',
    reason: 'Bridge works between RV Road and Jayanagar — temporary speed restriction.',
    since: '2026-09-24',
    source: 'Observed on site; not published by BMRCL in machine-readable form.',
  },
];

/**
 * Today's date in IST, as YYYY-MM-DD.
 *
 * Must not use toISOString(), which is UTC: between 00:00 and 05:30 IST that
 * returns yesterday, so a restriction starting today would not activate until
 * the morning.
 */
function istDate(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}

/** Restrictions in force at a given date (default: now, in IST). */
export function activeRestrictions(date = new Date()) {
  const today = istDate(date);
  return RESTRICTIONS.filter((r) => r.since <= today && (!r.until || r.until >= today));
}

/**
 * Index restrictions by the station pair they sit between, in both directions,
 * so the simulation can ask "is the hop I'm on restricted?" with one lookup.
 * @returns {Map<string, Restriction>} key `LINE|fromStation|toStation`
 */
export function buildRestrictionIndex(date = new Date()) {
  const index = new Map();
  for (const r of activeRestrictions(date)) {
    index.set(`${r.line}|${r.from}|${r.to}`, r);
    index.set(`${r.line}|${r.to}|${r.from}`, r);
  }
  return index;
}

/**
 * Geometry of each restricted stretch, for drawing the hazard overlay.
 * Resolved against the line's longest pattern so the coordinates follow the
 * real track rather than a straight line between the two stations.
 *
 * @returns {Array<{restriction: Restriction, coords: number[][], midpoint: number[]}>}
 */
export function restrictionGeometry(network, schedule, date = new Date()) {
  const out = [];

  for (const r of activeRestrictions(date)) {
    // the longest pattern on that line covers every station
    const pat = schedule.patterns
      .filter((p) => p.line === r.line)
      .sort((a, b) => b.stops.length - a.stops.length)[0];
    if (!pat) continue;

    const iA = pat.stops.indexOf(r.from);
    const iB = pat.stops.indexOf(r.to);
    if (iA < 0 || iB < 0) continue;

    const lo = Math.min(iA, iB);
    const hi = Math.max(iA, iB);
    const kmFrom = pat.dist[lo];
    const kmTo = pat.dist[hi];

    const shape = network.shapes[pat.shape];
    if (!shape) continue;

    // collect the shape vertices that fall inside the stretch
    const coords = [];
    for (let i = 0; i < shape.dist.length; i++) {
      if (shape.dist[i] >= kmFrom && shape.dist[i] <= kmTo) {
        coords.push([shape.coords[i * 2], shape.coords[i * 2 + 1]]);
      }
    }
    if (coords.length < 2) continue;

    out.push({
      restriction: r,
      coords,
      midpoint: coords[Math.floor(coords.length / 2)],
      kmFrom,
      kmTo,
      lengthKm: kmTo - kmFrom,
    });
  }

  return out;
}
