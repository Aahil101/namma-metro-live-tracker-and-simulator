/**
 * analytics.js — minimal, privacy-respecting traffic beacons.
 *
 * Feeds the numbers on /admin.html. Deliberately tiny in scope:
 *
 *   • one "view" event when the page loads
 *   • a "ping" every 60 s while the tab is visible, so concurrent users and
 *     session length can be derived
 *   • one "action" event for a handful of named interactions
 *
 * What is NOT collected: no cookies, no localStorage identifier that survives
 * the tab, no IP stored (the Worker keeps only a country code), no canvas or
 * font fingerprinting, no third-party scripts. The session id is random, lives
 * in sessionStorage, and dies with the tab.
 *
 * Every call is a no-op when API_BASE is empty, so the static site works
 * unchanged without a backend.
 */

import { API_BASE, ANALYTICS_ENABLED } from './config.js';

const ENABLED = ANALYTICS_ENABLED && !!API_BASE;
const PING_MS = 60_000;

const SESSION_KEY = 'nml.sid';

function sessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 36);
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return 'anon';
  }
}

/** Honour Do Not Track / Global Privacy Control without being asked twice. */
function optedOut() {
  return navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true;
}

let started = false;
let pingTimer = null;

function post(type, payload = {}) {
  if (!ENABLED || optedOut()) return;
  const body = JSON.stringify({
    type,
    sid: sessionId(),
    ref: document.referrer ? new URL(document.referrer).hostname.slice(0, 120) : '',
    path: location.pathname,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    vw: window.innerWidth,
    ...payload,
  });

  // sendBeacon survives page unload; fetch is the fallback
  const url = `${API_BASE}/api/event`;
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
  } catch { /* fall through */ }
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
    .catch(() => { /* analytics must never break the app */ });
}

export function startAnalytics() {
  if (started || !ENABLED) return;
  started = true;

  post('view');

  const schedule = () => {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (document.visibilityState === 'visible') post('ping');
    }, PING_MS);
  };
  schedule();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') post('ping');
  });

  window.addEventListener('pagehide', () => post('leave'), { once: true });
}

/** Named interaction, e.g. track('share_created'). */
export function track(action, extra = {}) {
  post('action', { action: String(action).slice(0, 40), ...extra });
}

export const analyticsEnabled = ENABLED;
