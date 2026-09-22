/**
 * feedback.js — user feedback capture.
 *
 * Three-tier delivery, because the site is designed to work as pure static
 * files but to light up fully when the optional API is deployed:
 *
 *   1. POST to the API (Cloudflare Worker) -> stored in D1, visible in /admin,
 *      and forwarded by email.
 *   2. If there is no API configured or it is unreachable, queue the message in
 *      localStorage so nothing is lost, and retry on the next page load.
 *   3. Always offer a mailto: fallback so a determined user can still reach me.
 *
 * Nothing here identifies a person. No cookies, no fingerprinting, no third
 * party scripts.
 */

import { API_BASE, OWNER_EMAIL } from './config.js';

const QUEUE_KEY = 'nml.fb.queue';
const MAX_QUEUE = 20;

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))); } catch { /* full/private */ }
}

/** Context that helps reproduce a report, without identifying anyone. */
export function collectContext(extra = {}) {
  return {
    ua: navigator.userAgent.slice(0, 300),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    theme: document.documentElement.getAttribute('data-theme') || 'dark',
    lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    path: location.pathname + location.search,
    ...extra,
  };
}

/**
 * @param {{kind:string, message:string, contact?:string, context?:object}} fb
 * @returns {Promise<{ok:boolean, queued:boolean, error?:string}>}
 */
export async function sendFeedback(fb) {
  const payload = {
    kind: fb.kind || 'idea',
    message: String(fb.message || '').slice(0, 2000),
    contact: String(fb.contact || '').slice(0, 160),
    context: fb.context || collectContext(),
    at: new Date().toISOString(),
  };

  if (!payload.message.trim()) return { ok: false, queued: false, error: 'empty message' };

  if (!API_BASE) {
    writeQueue([...readQueue(), payload]);
    return { ok: false, queued: true, error: 'no-api' };
  }

  try {
    const res = await fetch(`${API_BASE}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, queued: false };
  } catch (err) {
    writeQueue([...readQueue(), payload]);
    return { ok: false, queued: true, error: String(err.message || err) };
  }
}

/** Retry anything stranded by an earlier failure. Called once on load. */
export async function flushQueue() {
  if (!API_BASE) return 0;
  const q = readQueue();
  if (!q.length) return 0;

  const left = [];
  let sent = 0;
  for (const item of q) {
    try {
      const res = await fetch(`${API_BASE}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.ok) sent++; else left.push(item);
    } catch { left.push(item); }
  }
  writeQueue(left);
  return sent;
}

export function queuedCount() { return readQueue().length; }

/** mailto: fallback, pre-filled. */
export function mailtoLink(fb) {
  const ctx = fb.context || collectContext();
  const subject = `[Namma Metro Live] ${fb.kind || 'feedback'}`;
  const body = [
    fb.message || '',
    '',
    '---',
    `contact: ${fb.contact || '(none)'}`,
    `when: ${new Date().toISOString()}`,
    `theme: ${ctx.theme}   viewport: ${ctx.viewport}`,
    `ua: ${ctx.ua}`,
  ].join('\n');
  return `mailto:${OWNER_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
