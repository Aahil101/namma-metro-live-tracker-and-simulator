/**
 * visits.js — visit counting, with an honest split between what a browser can
 * know on its own and what needs a server.
 *
 * WITHOUT the API (API_BASE === ''):
 *   Only this browser's own history is available. That is genuinely useful for
 *   the owner — "I've opened it 40 times over 9 days" — but it is NOT site
 *   traffic, and the dashboard labels it as such. Concurrent-user counts are
 *   impossible and are hidden rather than faked.
 *
 * WITH the API:
 *   The Worker returns real numbers: views, unique sessions, and how many
 *   distinct sessions pinged in the last five minutes.
 *
 * Nothing here is a tracker. The local counters live in this browser only and
 * are never transmitted.
 */

import { API_BASE } from './config.js';

const KEY = 'nml.visits';
const SESSION_FLAG = 'nml.visit.counted';

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && typeof v === 'object') return v;
  } catch { /* private mode or corrupt */ }
  return { total: 0, first: null, last: null, days: {} };
}

function write(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* full */ }
}

/** Count one visit per browser session. Call once on load. */
export function recordVisit() {
  try {
    if (sessionStorage.getItem(SESSION_FLAG)) return read();
    sessionStorage.setItem(SESSION_FLAG, '1');
  } catch { /* if storage is blocked, just don't count */ }

  const v = read();
  const now = new Date();
  const day = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); // IST day

  v.total += 1;
  v.first = v.first || now.toISOString();
  v.last = now.toISOString();
  v.days[day] = (v.days[day] || 0) + 1;

  // keep a rolling 90 days so this never grows unbounded
  const keys = Object.keys(v.days).sort();
  while (keys.length > 90) delete v.days[keys.shift()];

  write(v);
  return v;
}

/** This browser's own history, shaped like the API's stats payload. */
export function localStats() {
  const v = read();
  const days = Object.entries(v.days).sort(([a], [b]) => a.localeCompare(b));
  return {
    scope: 'local',
    total: v.total,
    first: v.first,
    last: v.last,
    byDay: days.map(([day, views]) => ({ day, views, sessions: views })),
    activeDays: days.length,
  };
}

/**
 * How many people are on the site right now. Requires the API — there is no way
 * for a browser to know this alone, so it resolves to null rather than guessing.
 * @returns {Promise<{live:number, views24:number}|null>}
 */
export async function liveUsers() {
  if (!API_BASE) return null;
  try {
    const res = await fetch(`${API_BASE}/api/live`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
