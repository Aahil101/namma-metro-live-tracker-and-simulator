/**
 * config.js — the one file you edit after deploying the optional API.
 *
 * The site is fully functional with API_BASE empty: the map, the trains, the
 * share codes and the strip map are all client-side. What the API adds is
 * (a) durable feedback storage + email forwarding and (b) the traffic numbers
 * behind /admin.html.
 *
 * Leave API_BASE as '' and:
 *   - feedback falls back to a localStorage queue plus a mailto: link
 *   - /admin.html runs in local mode and says so plainly
 *
 * Set it to your deployed Worker origin (no trailing slash), e.g.
 *   export const API_BASE = 'https://namma-metro-api.<you>.workers.dev';
 *
 * Same-origin deployments (Worker and site on one domain) can use ''
 * with API_SAME_ORIGIN = true instead.
 */

export const API_SAME_ORIGIN = false;

export const API_BASE = API_SAME_ORIGIN ? location.origin : '';

/** Where the mailto: fallback sends feedback. */
export const OWNER_EMAIL = 'heworld2046@gmail.com';

/** Send anonymous pageview / heartbeat beacons when the API is configured. */
export const ANALYTICS_ENABLED = true;

/**
 * Local-mode gate for /admin.html — COSMETIC ONLY.
 *
 * When API_BASE is empty there is no server to authenticate against, so this
 * check exists purely so the dashboard behaves the way you expect while
 * developing: your username and password open it, a wrong one doesn't.
 *
 * It is NOT security. Anyone can read this file, and anyone determined can
 * brute-force a SHA-256 digest. It is safe only because local mode has nothing
 * to protect: it shows feedback queued in the visitor's *own* browser and
 * nothing else — no traffic data, no other people's messages.
 *
 * Real authentication happens in the Worker (api/), where the password lives as
 * a PBKDF2 secret that never reaches a browser. Once API_BASE is set, this
 * constant is ignored entirely.
 *
 * Regenerate with:
 *   node -e "console.log(require('crypto').createHash('sha256').update('USER:PASS:nml-local-v1').digest('hex'))"
 */
export const LOCAL_ADMIN = {
  user: 'aahil',
  digest: 'c09ed8d1f40648160e59d23528fa4409f724a4fdf7221c57adeb8a7da8c4b528',
};
