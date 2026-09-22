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
