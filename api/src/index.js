/**
 * Namma Metro Live — optional API (Cloudflare Worker + D1)
 * =============================================================================
 *
 * The map itself needs no backend. This Worker exists for two things the
 * browser cannot do on its own:
 *
 *   1. durable feedback storage (+ optional email forwarding)
 *   2. traffic numbers for the private /admin dashboard
 *
 * SECURITY NOTES
 * --------------
 * The admin password is NEVER shipped to the browser. It lives only as a
 * Cloudflare secret, stored as a PBKDF2-SHA256 derivation:
 *
 *     wrangler secret put ADMIN_USER
 *     wrangler secret put ADMIN_PW           # "iterations:saltB64:hashB64"
 *     wrangler secret put SESSION_SECRET     # 32+ random bytes, base64
 *
 * Generate ADMIN_PW with:  node tools/hash-password.mjs
 *
 * Login is rate limited to 6 attempts per 15 minutes per client, the comparison
 * is constant time, and the session is a short-lived HMAC-signed token — not a
 * cookie, so there is no CSRF surface.
 *
 * PRIVACY
 * -------
 * No IP address is written to the database. Cloudflare hands us a two-letter
 * country at the edge and that is the only location signal retained. Rate-limit
 * keys use a salted hash of the IP that is never stored alongside event rows.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'access-control-allow-origin': ok && origin ? origin : (allowed.includes('*') ? '*' : ''),
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

const json = (data, status, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

const bad = (msg, status, extra) => json({ error: msg }, status, extra);

const enc = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Timing-safe comparison of two equal-length byte arrays. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iterations, bytes = 32) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, bytes * 8);
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(data));
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** IST calendar parts for a unix-seconds timestamp. */
function istParts(tsSec) {
  const d = new Date(tsSec * 1000 + IST_OFFSET_MS);
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
  };
}

function deviceFromWidth(vw) {
  const w = Number(vw) || 0;
  if (w === 0) return 'unknown';
  if (w < 640) return 'mobile';
  if (w < 1024) return 'tablet';
  return 'desktop';
}

/**
 * Fixed-window rate limiter backed by D1.
 * @returns {Promise<boolean>} true when the caller is within budget
 */
async function allow(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT n, resets FROM rate WHERE k = ?').bind(key).first();

  if (!row || row.resets <= now) {
    await env.DB.prepare(
      'INSERT INTO rate (k, n, resets) VALUES (?, 1, ?) ' +
      'ON CONFLICT(k) DO UPDATE SET n = 1, resets = excluded.resets',
    ).bind(key, now + windowSec).run();
    return true;
  }
  if (row.n >= limit) return false;
  await env.DB.prepare('UPDATE rate SET n = n + 1 WHERE k = ?').bind(key).run();
  return true;
}

/** Stable, non-reversible client key for rate limiting. Never stored on rows. */
async function clientKey(env, request, scope) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  return `${scope}:${(await sha256Hex(ip + '|' + (env.SESSION_SECRET || 'salt'))).slice(0, 24)}`;
}

/* ------------------------------------------------------------------------- */
/* sessions                                                                  */
/* ------------------------------------------------------------------------- */

const SESSION_TTL_SEC = 12 * 3600;

async function mintToken(env, user) {
  const payload = { u: user, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(env.SESSION_SECRET, body));
  return `${body}.${sig}`;
}

async function verifyToken(env, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(await hmac(env.SESSION_SECRET, body));
  if (!timingSafeEqual(enc.encode(sig), enc.encode(expected))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireAdmin(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return verifyToken(env, token);
}

/* ------------------------------------------------------------------------- */
/* routes                                                                    */
/* ------------------------------------------------------------------------- */

async function handleEvent(env, request) {
  if (!await allow(env, await clientKey(env, request, 'ev'), 240, 300)) {
    return bad('rate limited', 429);
  }

  let b;
  try { b = await request.json(); } catch { return bad('invalid json', 400); }

  const type = String(b.type || '').slice(0, 12);
  if (!['view', 'ping', 'action', 'leave'].includes(type)) return bad('bad type', 400);

  const ts = Math.floor(Date.now() / 1000);
  const { day, hour } = istParts(ts);

  await env.DB.prepare(
    `INSERT INTO events (ts, day, hour, type, sid, action, path, ref, country, tz, vw, device)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    ts, day, hour, type,
    String(b.sid || 'anon').slice(0, 40),
    b.action ? String(b.action).slice(0, 40) : null,
    String(b.path || '/').slice(0, 120),
    String(b.ref || '').slice(0, 120) || null,
    request.headers.get('CF-IPCountry') || null,
    String(b.tz || '').slice(0, 60) || null,
    Number(b.vw) || null,
    deviceFromWidth(b.vw),
  ).run();

  return new Response(null, { status: 204 });
}

async function handleFeedback(env, request) {
  if (!await allow(env, await clientKey(env, request, 'fb'), 8, 3600)) {
    return bad('Too many messages in a short time — try again later.', 429);
  }

  let b;
  try { b = await request.json(); } catch { return bad('invalid json', 400); }

  const message = String(b.message || '').trim().slice(0, 2000);
  if (!message) return bad('message is required', 400);

  const kind = ['bug', 'data', 'idea', 'praise'].includes(b.kind) ? b.kind : 'idea';
  const ts = Math.floor(Date.now() / 1000);

  const res = await env.DB.prepare(
    `INSERT INTO feedback (ts, kind, message, contact, context, country)
     VALUES (?,?,?,?,?,?)`,
  ).bind(
    ts, kind, message,
    String(b.contact || '').slice(0, 160) || null,
    JSON.stringify(b.context || {}).slice(0, 2000),
    request.headers.get('CF-IPCountry') || null,
  ).run();

  const id = res.meta?.last_row_id;

  // best-effort email forward; never fails the request
  if (env.RESEND_API_KEY && env.MAIL_TO && env.MAIL_FROM) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [env.MAIL_TO],
          subject: `[Namma Metro Live] ${kind} #${id}`,
          text: [
            message,
            '',
            '--- context ---',
            `kind:    ${kind}`,
            `contact: ${b.contact || '(none)'}`,
            `country: ${request.headers.get('CF-IPCountry') || '?'}`,
            `when:    ${new Date(ts * 1000).toISOString()}`,
            JSON.stringify(b.context || {}, null, 2),
          ].join('\n'),
        }),
      });
      if (r.ok) {
        await env.DB.prepare('UPDATE feedback SET emailed = 1 WHERE id = ?').bind(id).run();
      }
    } catch { /* stored in D1 regardless; the dashboard is the source of truth */ }
  }

  return json({ ok: true, id }, 201);
}

async function handleLogin(env, request) {
  const key = await clientKey(env, request, 'login');
  if (!await allow(env, key, 6, 900)) {
    return bad('Too many attempts. Wait 15 minutes.', 429);
  }
  if (!env.ADMIN_USER || !env.ADMIN_PW || !env.SESSION_SECRET) {
    return bad('Admin auth is not configured on the server.', 503);
  }

  let b;
  try { b = await request.json(); } catch { return bad('invalid json', 400); }

  const user = String(b.username || '');
  const pass = String(b.password || '');

  // ADMIN_PW format: iterations:saltB64:hashB64
  const [itStr, saltB64, hashB64] = String(env.ADMIN_PW).split(':');
  const iterations = Number(itStr);
  if (!iterations || !saltB64 || !hashB64) return bad('ADMIN_PW is malformed', 503);

  const derived = await pbkdf2(pass, unb64(saltB64), iterations, unb64(hashB64).length);

  const userOk = timingSafeEqual(enc.encode(user), enc.encode(env.ADMIN_USER));
  const passOk = timingSafeEqual(new Uint8Array(derived), unb64(hashB64));

  // evaluate both regardless, so timing does not reveal which half failed
  if (!(userOk && passOk)) return bad('Invalid username or password.', 401);

  return json({ ok: true, token: await mintToken(env, user), expiresIn: SESSION_TTL_SEC }, 200);
}

/**
 * Public, unauthenticated: how many distinct sessions pinged in the last five
 * minutes. Fuels the "N watching" pill on the map. Deliberately returns only
 * two aggregate integers — nothing about who, where, or what they looked at.
 */
async function handleLive(env) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT sid) AS live FROM events WHERE ts >= ?`,
  ).bind(now - 300).first();
  const day = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE type='view' AND ts >= ?`,
  ).bind(now - 86400).first();

  return json({ live: row?.live || 0, views24: day?.n || 0 }, 200, {
    // brief caching keeps this cheap under a traffic spike
    'cache-control': 'public, max-age=20',
  });
}

async function handleStats(env, request, url) {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 14));
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;

  const q = (sql, ...bind) => env.DB.prepare(sql).bind(...bind);

  const [
    totals, live, byDay, byHour, refs, countries, devices, actions, recentBurst, priorRate, fbCounts,
  ] = await Promise.all([
    q(`SELECT
         COUNT(*) FILTER (WHERE type='view')                      AS views,
         COUNT(DISTINCT sid)                                      AS sessions,
         COUNT(*) FILTER (WHERE type='view' AND ts >= ?)          AS views24,
         COUNT(DISTINCT CASE WHEN ts >= ? THEN sid END)           AS sessions24
       FROM events WHERE ts >= ?`, now - 86400, now - 86400, since).first(),

    q(`SELECT COUNT(DISTINCT sid) AS n FROM events WHERE ts >= ?`, now - 300).first(),

    q(`SELECT day,
              COUNT(*) FILTER (WHERE type='view') AS views,
              COUNT(DISTINCT sid)                 AS sessions
       FROM events WHERE ts >= ? GROUP BY day ORDER BY day`, since).all(),

    q(`SELECT hour,
              COUNT(*) FILTER (WHERE type='view') AS views
       FROM events WHERE ts >= ? GROUP BY hour ORDER BY hour`, now - 7 * 86400).all(),

    q(`SELECT COALESCE(ref,'(direct)') AS ref, COUNT(*) AS n
       FROM events WHERE type='view' AND ts >= ?
       GROUP BY ref ORDER BY n DESC LIMIT 12`, since).all(),

    q(`SELECT COALESCE(country,'??') AS country, COUNT(DISTINCT sid) AS n
       FROM events WHERE ts >= ? GROUP BY country ORDER BY n DESC LIMIT 12`, since).all(),

    q(`SELECT COALESCE(device,'unknown') AS device, COUNT(DISTINCT sid) AS n
       FROM events WHERE ts >= ? GROUP BY device ORDER BY n DESC`, since).all(),

    q(`SELECT action, COUNT(*) AS n FROM events
       WHERE type='action' AND action IS NOT NULL AND ts >= ?
       GROUP BY action ORDER BY n DESC LIMIT 15`, since).all(),

    // surge detection: views in the last 15 min vs the preceding 6 hours
    q(`SELECT COUNT(*) AS n FROM events WHERE type='view' AND ts >= ?`, now - 900).first(),
    q(`SELECT COUNT(*) AS n FROM events WHERE type='view' AND ts >= ? AND ts < ?`,
      now - 6 * 3600 - 900, now - 900).first(),

    q(`SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE is_read = 0) AS unread
       FROM feedback`).first(),
  ]);

  const last15 = recentBurst?.n || 0;
  const baseline15 = ((priorRate?.n || 0) / 24) || 0; // 6 h split into 15-min buckets
  const surgeRatio = baseline15 > 0 ? last15 / baseline15 : (last15 > 0 ? Infinity : 0);

  return json({
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    totals: {
      views: totals?.views || 0,
      sessions: totals?.sessions || 0,
      views24: totals?.views24 || 0,
      sessions24: totals?.sessions24 || 0,
      liveNow: live?.n || 0,
    },
    surge: {
      last15,
      baseline15: Number(baseline15.toFixed(2)),
      ratio: surgeRatio === Infinity ? null : Number(surgeRatio.toFixed(2)),
      active: last15 >= 10 && (surgeRatio === Infinity || surgeRatio >= 3),
    },
    byDay: byDay?.results || [],
    byHour: byHour?.results || [],
    referrers: refs?.results || [],
    countries: countries?.results || [],
    devices: devices?.results || [],
    actions: actions?.results || [],
    feedback: { total: fbCounts?.total || 0, unread: fbCounts?.unread || 0 },
  }, 200);
}

async function handleFeedbackList(env, url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const rows = await env.DB.prepare(
    `SELECT id, ts, kind, message, contact, context, country, is_read, emailed
     FROM feedback ORDER BY ts DESC LIMIT ?`,
  ).bind(limit).all();
  return json({ items: rows?.results || [] }, 200);
}

async function handleFeedbackRead(env, request) {
  let b;
  try { b = await request.json(); } catch { return bad('invalid json', 400); }
  const id = Number(b.id);
  if (!id) return bad('id required', 400);
  await env.DB.prepare('UPDATE feedback SET is_read = ? WHERE id = ?')
    .bind(b.read === false ? 0 : 1, id).run();
  return json({ ok: true }, 200);
}

/* ------------------------------------------------------------------------- */
/* entry                                                                     */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* exported for tools/test-api.mjs — pure functions, no bindings needed       */
/* ------------------------------------------------------------------------- */

export {
  pbkdf2, hmac, timingSafeEqual, istParts, deviceFromWidth,
  mintToken, verifyToken, b64url, unb64,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(env, request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const send = (res) => {
      for (const [k, v] of Object.entries(headers)) if (v) res.headers.set(k, v);
      return res;
    };

    try {
      const p = url.pathname;

      if (p === '/api/health') {
        return send(json({
          ok: true,
          adminConfigured: Boolean(env.ADMIN_USER && env.ADMIN_PW && env.SESSION_SECRET),
          emailConfigured: Boolean(env.RESEND_API_KEY && env.MAIL_TO),
          time: new Date().toISOString(),
        }, 200));
      }

      if (p === '/api/event' && request.method === 'POST') return send(await handleEvent(env, request));
      if (p === '/api/live' && request.method === 'GET') return send(await handleLive(env));
      if (p === '/api/feedback' && request.method === 'POST') return send(await handleFeedback(env, request));
      if (p === '/api/admin/login' && request.method === 'POST') return send(await handleLogin(env, request));

      // everything below needs a valid session
      if (p.startsWith('/api/admin/')) {
        const session = await requireAdmin(env, request);
        if (!session) return send(bad('unauthorised', 401));

        if (p === '/api/admin/stats') return send(await handleStats(env, request, url));
        if (p === '/api/admin/feedback' && request.method === 'GET') return send(await handleFeedbackList(env, url));
        if (p === '/api/admin/feedback/read' && request.method === 'POST') return send(await handleFeedbackRead(env, request));
      }

      return send(bad('not found', 404));
    } catch (err) {
      // never leak a stack trace to the client
      console.error('worker error', err);
      return send(bad('internal error', 500));
    }
  },
};
