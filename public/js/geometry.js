/**
 * geometry.js — placing a train on real track geometry.
 *
 * Each GTFS shape arrives as two parallel arrays:
 *   coords: [lon0, lat0, lon1, lat1, …]   (flat, GeoJSON order)
 *   dist:   [0, 0.094, 0.136, …]          cumulative kilometres
 *
 * stop_times carries `shape_dist_traveled` in the same units, so converting a
 * "train is 12.84 km along the line" into a coordinate is a binary search plus
 * one linear interpolation. Because the polylines come from OpenStreetMap, the
 * result follows the actual curve of the viaduct/tunnel rather than a straight
 * hop between stations.
 */

const DEG = 180 / Math.PI;

/** Minimum along-track separation (km) used when computing heading, so that
 *  very short polyline segments don't produce jittery bearings. */
const BEARING_WINDOW_KM = 0.05;

/**
 * @param {{coords:number[], dist:number[]}} shape
 * @param {number} km distance along the shape
 * @returns {{lon:number, lat:number, bearing:number}}
 */
export function pointAtDistance(shape, km) {
  const { coords, dist } = shape;
  const last = dist.length - 1;

  if (last < 1) return { lon: coords[0], lat: coords[1], bearing: 0 };

  if (km <= dist[0]) {
    return { lon: coords[0], lat: coords[1], bearing: bearingAround(shape, 0, dist[0]) };
  }
  if (km >= dist[last]) {
    return { lon: coords[last * 2], lat: coords[last * 2 + 1], bearing: bearingAround(shape, last - 1, dist[last]) };
  }

  const i = segmentIndex(dist, km);
  const d0 = dist[i], d1 = dist[i + 1];
  const f = d1 > d0 ? (km - d0) / (d1 - d0) : 0;

  const x0 = coords[i * 2], y0 = coords[i * 2 + 1];
  const x1 = coords[i * 2 + 2], y1 = coords[i * 2 + 3];

  return {
    lon: x0 + (x1 - x0) * f,
    lat: y0 + (y1 - y0) * f,
    bearing: bearingAround(shape, i, km),
  };
}

/** Last index `i` with dist[i] <= km (and i <= len-2). */
function segmentIndex(dist, km) {
  let lo = 0, hi = dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= km) lo = mid; else hi = mid;
  }
  return Math.min(lo, dist.length - 2);
}

/**
 * Heading in degrees clockwise from north, measured over a window of track
 * around `km` rather than a single (possibly 5-metre) segment.
 */
function bearingAround(shape, i, km) {
  const { coords, dist } = shape;
  const last = dist.length - 1;

  let a = i;
  while (a > 0 && dist[i] - dist[a] < BEARING_WINDOW_KM) a--;
  let b = Math.min(i + 1, last);
  while (b < last && dist[b] - dist[i] < BEARING_WINDOW_KM) b++;

  return bearing(coords[a * 2], coords[a * 2 + 1], coords[b * 2], coords[b * 2 + 1]);
}

/** Degrees clockwise from north, for a MapLibre `icon-rotate` in map alignment. */
export function bearing(lon1, lat1, lon2, lat2) {
  const midLat = ((lat1 + lat2) / 2) / DEG;
  const dx = (lon2 - lon1) * Math.cos(midLat);
  const dy = lat2 - lat1;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dx, dy) * DEG + 360) % 360;
}

/** Great-circle distance in kilometres (haversine). */
export function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371.0088;
  const dLat = (lat2 - lat1) / DEG;
  const dLon = (lon2 - lon1) / DEG;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 / DEG) * Math.cos(lat2 / DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Slice a shape between two along-track distances, for drawing a sub-route. */
export function sliceShape(shape, fromKm, toKm) {
  const { coords, dist } = shape;
  const out = [];
  const start = pointAtDistance(shape, fromKm);
  out.push([start.lon, start.lat]);
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] > fromKm && dist[i] < toKm) out.push([coords[i * 2], coords[i * 2 + 1]]);
  }
  const end = pointAtDistance(shape, toKm);
  out.push([end.lon, end.lat]);
  return out;
}
