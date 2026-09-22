/**
 * test-api.mjs — exercise the Worker's auth and helper logic under Node.
 *
 * The Worker uses only WebCrypto and standard globals, which Node 20+ provides,
 * so the security-critical parts can be tested without a Cloudflare runtime.
 * What is NOT covered here is D1 (that needs `wrangler dev`), so the routing
 * layer is checked separately with a stub database below.
 *
 *   node tools/test-api.mjs
 */

import crypto from 'node:crypto';
import worker, {
  pbkdf2, timingSafeEqual, istParts, deviceFromWidth, mintToken, verifyToken, unb64,
} from '../api/src/index.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`);

/* ------------------------------------------------------------------ */
section('password hashing (hash-password.mjs ↔ worker)');

const PASSWORD = 'aahil@14231423';
const ITER = 10000;   // must match DEFAULT_ITERATIONS in tools/hash-password.mjs

// exactly what tools/hash-password.mjs produces
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(PASSWORD, salt, ITER, 32, 'sha256');
const ADMIN_PW = `${ITER}:${salt.toString('base64')}:${hash.toString('base64')}`;
console.log(`  ADMIN_PW = ${ADMIN_PW.slice(0, 28)}…  (${ADMIN_PW.length} chars)`);

// what the worker does on login
const [itStr, saltB64, hashB64] = ADMIN_PW.split(':');
const derived = await pbkdf2(PASSWORD, unb64(saltB64), Number(itStr), unb64(hashB64).length);

ok(timingSafeEqual(new Uint8Array(derived), unb64(hashB64)),
  'the worker re-derives the same hash as the generator');

const wrong = await pbkdf2('aahil@14231424', unb64(saltB64), Number(itStr), 32);
ok(!timingSafeEqual(new Uint8Array(wrong), unb64(hashB64)),
  'a one-character-different password does not verify');

const empty = await pbkdf2('', unb64(saltB64), Number(itStr), 32);
ok(!timingSafeEqual(new Uint8Array(empty), unb64(hashB64)), 'an empty password does not verify');

ok(!ADMIN_PW.includes(PASSWORD), 'the stored secret does not contain the plaintext');
ok(unb64(hashB64).length === 32, 'derived key is 256 bits');

// two runs must salt differently
const salt2 = crypto.randomBytes(16);
const hash2 = crypto.pbkdf2Sync(PASSWORD, salt2, ITER, 32, 'sha256');
ok(hash2.toString('base64') !== hash.toString('base64'),
  'the same password hashes differently with a fresh salt');

// timing sanity: Cloudflare's free plan allows ~10 ms CPU per request
const t0 = performance.now();
await pbkdf2(PASSWORD, unb64(saltB64), ITER, 32);
const ms = performance.now() - t0;
console.log(`  derivation takes ${ms.toFixed(1)} ms at ${ITER} iterations`);
ok(ms < 10, 'derivation fits the Workers free-plan CPU budget', `${ms.toFixed(1)} ms`);

/* ------------------------------------------------------------------ */
section('timingSafeEqual');

const A = new Uint8Array([1, 2, 3, 4]);
ok(timingSafeEqual(A, new Uint8Array([1, 2, 3, 4])), 'equal arrays compare equal');
ok(!timingSafeEqual(A, new Uint8Array([1, 2, 3, 5])), 'differing last byte compares unequal');
ok(!timingSafeEqual(A, new Uint8Array([1, 2, 3])), 'different lengths compare unequal');

/* ------------------------------------------------------------------ */
section('session tokens');

const env = { SESSION_SECRET: crypto.randomBytes(32).toString('base64') };
const token = await mintToken(env, 'aahil');
console.log(`  token = ${token.slice(0, 34)}…  (${token.length} chars)`);

const decoded = await verifyToken(env, token);
ok(decoded?.u === 'aahil', 'a freshly minted token verifies', JSON.stringify(decoded));
ok(decoded.exp > Math.floor(Date.now() / 1000), 'token carries a future expiry');
ok(decoded.exp - Math.floor(Date.now() / 1000) <= 12 * 3600 + 5, 'expiry is at most 12 hours');

ok(await verifyToken(env, token.slice(0, -2) + 'xy') === null, 'a tampered signature is rejected');
ok(await verifyToken({ SESSION_SECRET: 'different-secret' }, token) === null,
  'a token signed with another secret is rejected');
ok(await verifyToken(env, 'garbage') === null, 'garbage is rejected');
ok(await verifyToken(env, '') === null, 'an empty token is rejected');

// tamper with the payload, keep the old signature
const [body, sig] = token.split('.');
const evil = Buffer.from(JSON.stringify({ u: 'attacker', exp: 9e9 })).toString('base64url');
ok(await verifyToken(env, `${evil}.${sig}`) === null, 'a swapped payload is rejected');

// expired token
const expired = await (async () => {
  const p = Buffer.from(JSON.stringify({ u: 'aahil', exp: 1 })).toString('base64url');
  const { createHmac } = crypto;
  const s = createHmac('sha256', Buffer.from(env.SESSION_SECRET))
    .update(p).digest('base64url');
  return `${p}.${s}`;
})();
ok(await verifyToken(env, expired) === null, 'an expired token is rejected');

/* ------------------------------------------------------------------ */
section('helpers');

const feb = istParts(Math.floor(Date.UTC(2026, 8, 22, 18, 45, 0) / 1000)); // 00:15 IST next day
console.log(`  2026-09-22 18:45 UTC → IST day ${feb.day} hour ${feb.hour}`);
ok(feb.day === '2026-09-23' && feb.hour === 0, 'IST bucketing crosses midnight correctly');

const noon = istParts(Math.floor(Date.UTC(2026, 8, 22, 6, 30, 0) / 1000));
ok(noon.day === '2026-09-22' && noon.hour === 12, 'IST offset is +5:30', `${noon.day} ${noon.hour}h`);

ok(deviceFromWidth(390) === 'mobile', 'a phone width is mobile');
ok(deviceFromWidth(820) === 'tablet', 'a tablet width is tablet');
ok(deviceFromWidth(1600) === 'desktop', 'a desktop width is desktop');
ok(deviceFromWidth(undefined) === 'unknown', 'a missing width is unknown');

/* ------------------------------------------------------------------ */
section('routing (with a stubbed D1)');

/** Minimal D1 stand-in: records SQL and returns canned rows. */
function stubDB() {
  const calls = [];
  const result = { n: 0, resets: 0, views: 0, total: 0, unread: 0 };
  const stmt = {
    bind: (...a) => { calls[calls.length - 1].bind = a; return stmt; },
    first: async () => result,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { last_row_id: 1 } }),
  };
  return {
    calls,
    prepare(sql) { calls.push({ sql }); return stmt; },
  };
}

const baseEnv = () => ({
  DB: stubDB(),
  SESSION_SECRET: env.SESSION_SECRET,
  ADMIN_USER: 'aahil',
  ADMIN_PW,
  ALLOWED_ORIGINS: '*',
});

const req = (path, opts = {}) => new Request(`https://api.test${path}`, {
  method: opts.method || 'GET',
  headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
});

// health
let e = baseEnv();
let res = await worker.fetch(req('/api/health'), e);
let js = await res.json();
console.log(`  /api/health → ${res.status} ${JSON.stringify(js).slice(0, 90)}`);
ok(res.status === 200 && js.ok === true, 'health endpoint responds');
ok(js.adminConfigured === true, 'health reports admin configured');
ok(js.emailConfigured === false, 'health reports email not configured');

// CORS preflight
res = await worker.fetch(new Request('https://api.test/api/event', { method: 'OPTIONS' }), baseEnv());
ok(res.status === 204, 'OPTIONS preflight returns 204');
ok(res.headers.get('access-control-allow-methods')?.includes('POST'), 'preflight advertises POST');

// login: correct
e = baseEnv();
res = await worker.fetch(req('/api/admin/login', { method: 'POST', body: { username: 'aahil', password: PASSWORD } }), e);
js = await res.json();
ok(res.status === 200 && typeof js.token === 'string', 'correct credentials return a token', `status ${res.status}`);
const goodToken = js.token;
ok((await verifyToken(e, goodToken))?.u === 'aahil', 'the returned token verifies');

// login: wrong password
res = await worker.fetch(req('/api/admin/login', { method: 'POST', body: { username: 'aahil', password: 'nope-nope-nope' } }), baseEnv());
ok(res.status === 401, 'wrong password is rejected with 401', `status ${res.status}`);
js = await res.json();
ok(!/password|hash|pbkdf/i.test(JSON.stringify(js).replace(/Invalid username or password\./, '')),
  'the error does not leak which half failed', JSON.stringify(js));

// login: wrong user
res = await worker.fetch(req('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } }), baseEnv());
ok(res.status === 401, 'wrong username is rejected');

// login: not configured
res = await worker.fetch(req('/api/admin/login', { method: 'POST', body: { username: 'a', password: 'b' } }),
  { ...baseEnv(), ADMIN_PW: undefined });
ok(res.status === 503, 'unconfigured admin auth returns 503, not a bypass', `status ${res.status}`);

// admin routes need a token
res = await worker.fetch(req('/api/admin/stats'), baseEnv());
ok(res.status === 401, 'stats without a token is 401');

res = await worker.fetch(req('/api/admin/stats', { headers: { authorization: 'Bearer garbage' } }), baseEnv());
ok(res.status === 401, 'stats with a bad token is 401');

res = await worker.fetch(req('/api/admin/feedback', { headers: { authorization: 'Bearer ' + goodToken } }), baseEnv());
ok(res.status === 200, 'feedback list works with a valid token', `status ${res.status}`);

// event ingest
e = baseEnv();
res = await worker.fetch(req('/api/event', { method: 'POST', body: { type: 'view', sid: 'abc', vw: 1440 } }), e);
ok(res.status === 204, 'event ingest returns 204', `status ${res.status}`);
const insert = e.DB.calls.find((c) => /INSERT INTO events/.test(c.sql));
ok(!!insert, 'an event row is inserted');
ok(insert.bind.includes('desktop'), 'device is derived from the viewport width');
ok(!insert.bind.some((v) => typeof v === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(v)),
  'no IP address is written to the events table');

res = await worker.fetch(req('/api/event', { method: 'POST', body: { type: 'evil', sid: 'abc' } }), baseEnv());
ok(res.status === 400, 'an unknown event type is rejected');

// feedback ingest
e = baseEnv();
res = await worker.fetch(req('/api/feedback', { method: 'POST', body: { kind: 'bug', message: 'Wrong timing at Hosa Road' } }), e);
ok(res.status === 201, 'feedback is accepted', `status ${res.status}`);
ok(e.DB.calls.some((c) => /INSERT INTO feedback/.test(c.sql)), 'a feedback row is inserted');

res = await worker.fetch(req('/api/feedback', { method: 'POST', body: { message: '   ' } }), baseEnv());
ok(res.status === 400, 'blank feedback is rejected');

e = baseEnv();
res = await worker.fetch(req('/api/feedback', { method: 'POST', body: { kind: 'hacker', message: 'x' } }), e);
const fbInsert = e.DB.calls.find((c) => /INSERT INTO feedback/.test(c.sql));
ok(fbInsert.bind[1] === 'idea', 'an unknown feedback kind falls back to "idea"', fbInsert.bind[1]);

// oversized message is clamped, not rejected outright
e = baseEnv();
await worker.fetch(req('/api/feedback', { method: 'POST', body: { kind: 'idea', message: 'x'.repeat(5000) } }), e);
const bigInsert = e.DB.calls.find((c) => /INSERT INTO feedback/.test(c.sql));
ok(bigInsert.bind[2].length === 2000, 'an over-long message is truncated to 2000 chars', `${bigInsert.bind[2].length}`);

// unknown route
res = await worker.fetch(req('/api/nope'), baseEnv());
ok(res.status === 404, 'unknown routes 404');

// internal errors do not leak details
res = await worker.fetch(req('/api/event', { method: 'POST', body: { type: 'view' } }), {
  ...baseEnv(),
  DB: { prepare() { throw new Error('secret db detail: table users'); } },
});
js = await res.json();
ok(res.status === 500 && js.error === 'internal error',
  'an internal error returns a generic message', JSON.stringify(js));

/* ------------------------------------------------------------------ */
console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('═'.repeat(60));
process.exit(fail ? 1 : 0);
