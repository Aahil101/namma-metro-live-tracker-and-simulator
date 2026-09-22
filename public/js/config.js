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
 *   - /admin.html shows a short explanation instead of a login form, because
 *     without a server there is nothing to authenticate against and nothing
 *     server-side to show
 *
 * Set it to your deployed Worker origin (no trailing slash), e.g.
 *   export const API_BASE = 'https://namma-metro-api.example.workers.dev';
 *
 * Same-origin deployments (Worker and site on one domain) can set
 * API_SAME_ORIGIN = true instead.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * NOTE ON CREDENTIALS
 *
 * Nothing authentication-related belongs in this file. No password, no hash,
 * no digest, not even the admin username — this repository is public, and
 * anything here is readable by anyone and offline-crackable at leisure.
 *
 * Admin login is verified exclusively by the Cloudflare Worker in api/, where
 * the credentials live as Cloudflare secrets set via `wrangler secret put` and
 * never leave the server. See api/README.md.
 *
 * tools/preflight.mjs fails the build if any credential-shaped literal appears
 * in the deployable payload.
 * ──────────────────────────────────────────────────────────────────────────
 */

export const API_SAME_ORIGIN = false;

export const API_BASE = API_SAME_ORIGIN ? location.origin : '';

/** Where the mailto: fallback sends feedback. */
export const OWNER_EMAIL = 'heworld2046@gmail.com';

/** Send anonymous pageview / heartbeat beacons when the API is configured. */
export const ANALYTICS_ENABLED = true;
