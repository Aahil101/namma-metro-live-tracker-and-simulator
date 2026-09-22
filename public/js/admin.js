/**
 * admin.js — private dashboard.
 *
 * Authentication happens entirely on the server. This file never contains, and
 * never sees, the password hash: it POSTs the credentials once, receives a
 * short-lived HMAC-signed token, and sends that as a Bearer header. The token
 * is held in sessionStorage so it dies with the tab.
 *
 * If no API is configured (config.js API_BASE === ''), the page says so and
 * falls back to showing feedback queued locally in this browser — which is
 * honest about the fact that a static site cannot count visitors on its own.
 *
 * Charts are hand-rolled SVG. No chart library, no CDN, nothing to audit.
 */

import { API_BASE, OWNER_EMAIL } from './config.js';
import { initialTheme, applyTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'nml.admin.token';
const REFRESH_MS = 20_000;

applyTheme(initialTheme());

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = new Intl.NumberFormat('en-IN');
const num = (n) => nf.format(Number(n) || 0);

const IST = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

let token = null;
let refreshTimer = null;
let currentFeedback = [];
let fbFilter = 'all';

/* ------------------------------------------------------------------ *
 *  API plumbing
 * ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (auth && token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) { signOut('Session expired — sign in again.'); throw new Error('unauthorised'); }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------------------------------------------ *
 *  Gate
 * ------------------------------------------------------------------ */

function showGateNote() {
  const note = $('gate-note');
  if (!API_BASE) {
    note.innerHTML =
      'No API is configured, so there are no server-side stats to show. ' +
      'Deploy <code>api/</code> and set <code>API_BASE</code> in <code>public/js/config.js</code>. ' +
      'Until then you can still sign in to read feedback queued in this browser.';
  } else {
    note.innerHTML = `Credentials are verified by the Worker at <code>${esc(new URL(API_BASE).host)}</code>. ` +
      'Nothing sensitive is stored in this page.';
  }
}

async function signIn(username, password) {
  const msg = $('gate-msg');

  // Local mode: no server to verify against, so be explicit rather than
  // pretending to authenticate in client-side JavaScript.
  if (!API_BASE) {
    msg.className = 'share-msg warn';
    msg.textContent = 'Local mode — showing only feedback queued in this browser.';
    setTimeout(() => enterDashboard(true), 700);
    return;
  }

  msg.className = 'share-msg';
  msg.textContent = 'Checking…';
  $('gate-go').disabled = true;

  try {
    const res = await api('/api/admin/login', {
      method: 'POST', auth: false, body: { username, password },
    });
    token = res.token;
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
    msg.className = 'share-msg ok';
    msg.textContent = 'Welcome back.';
    enterDashboard(false);
  } catch (err) {
    msg.className = 'share-msg bad';
    msg.textContent = err.message === 'Failed to fetch'
      ? 'Could not reach the API. Is the Worker deployed and ALLOWED_ORIGINS set?'
      : err.message;
  } finally {
    $('gate-go').disabled = false;
  }
}

function signOut(reason) {
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  clearInterval(refreshTimer);
  $('dash').hidden = true;
  $('gate').hidden = false;
  if (reason) {
    $('gate-msg').className = 'share-msg warn';
    $('gate-msg').textContent = reason;
  }
}

function enterDashboard(localMode) {
  $('gate').hidden = true;
  $('dash').hidden = false;

  const banner = $('adm-banner');
  if (localMode) {
    banner.hidden = false;
    banner.innerHTML =
      '<strong>Local mode.</strong> A static site cannot count its own visitors — there is no server ' +
      'to record them. Traffic numbers stay empty until you deploy <code>api/</code> (Cloudflare Worker + D1, ' +
      'free tier) and point <code>API_BASE</code> at it. Feedback below is whatever this browser queued offline.';
    renderLocalFeedback();
    renderStats(null);
    return;
  }

  banner.hidden = true;
  refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

/* ------------------------------------------------------------------ *
 *  Data refresh
 * ------------------------------------------------------------------ */

async function refresh() {
  const days = Number($('adm-range').value) || 14;
  try {
    const [stats, fb] = await Promise.all([
      api(`/api/admin/stats?days=${days}`),
      api('/api/admin/feedback?limit=200'),
    ]);
    currentFeedback = fb.items || [];
    renderStats(stats);
    renderFeedback();
    $('adm-updated').textContent = `updated ${IST.format(new Date())} IST`;
    $('adm-banner').hidden = true;
  } catch (err) {
    if (err.message === 'unauthorised') return;
    const banner = $('adm-banner');
    banner.hidden = false;
    banner.className = 'adm-banner bad';
    banner.innerHTML = `<strong>Could not load stats.</strong> ${esc(err.message)}`;
  }
}

/* ------------------------------------------------------------------ *
 *  Rendering — KPIs
 * ------------------------------------------------------------------ */

function renderStats(s) {
  if (!s) {
    for (const id of ['kpi-live', 'kpi-views24', 'kpi-views', 'kpi-surge', 'kpi-fb']) $(id).textContent = '—';
    $('kpi-sess24').textContent = 'needs the API';
    $('kpi-sess').textContent = 'needs the API';
    $('kpi-surge-sub').textContent = 'needs the API';
    $('kpi-fb-sub').textContent = `${currentFeedback.length} queued locally`;
    emptyChart('chart-days', 'No server-side data.\nDeploy api/ to see traffic over time.');
    emptyChart('chart-hours', 'No data yet.');
    for (const id of ['list-devices', 'list-refs', 'list-countries', 'list-actions']) {
      $(id).innerHTML = '<div class="bl-empty">Needs the API.</div>';
    }
    return;
  }

  const t = s.totals;
  $('kpi-live').textContent = num(t.liveNow);
  $('kpi-views24').textContent = num(t.views24);
  $('kpi-sess24').textContent = `${num(t.sessions24)} unique sessions`;
  $('kpi-views').textContent = num(t.views);
  $('kpi-sess').textContent = `${num(t.sessions)} unique · ${s.rangeDays} d`;

  const surge = s.surge || {};
  const card = $('kpi-surge-card');
  card.classList.toggle('is-surge', !!surge.active);
  $('kpi-surge').textContent = surge.active ? 'YES' : (surge.ratio != null ? `${surge.ratio}×` : '—');
  $('kpi-surge-sub').textContent = surge.active
    ? `${num(surge.last15)} views in 15 min (baseline ${surge.baseline15})`
    : `${num(surge.last15)} views in the last 15 min`;

  const fb = s.feedback || {};
  $('kpi-fb').textContent = num(fb.total);
  $('kpi-fb-sub').textContent = fb.unread ? `${num(fb.unread)} unread` : 'all read';
  $('kpi-fb').closest('.kpi').classList.toggle('has-unread', fb.unread > 0);

  $('chart-legend').innerHTML =
    '<span><i style="background:var(--accent)"></i>views</span>' +
    '<span><i style="background:var(--live)"></i>sessions</span>';

  groupedBars('chart-days', s.byDay || [], 'day', ['views', 'sessions'],
    (d) => d.slice(5).replace('-', '/'));
  singleBars('chart-hours', (s.byHour || []).map((h) => ({ k: `${String(h.hour).padStart(2, '0')}`, n: h.views })));

  barList('list-devices', (s.devices || []).map((d) => ({ label: d.device, n: d.n })));
  barList('list-refs', (s.referrers || []).map((r) => ({ label: r.ref, n: r.n })));
  barList('list-countries', (s.countries || []).map((c) => ({ label: flag(c.country) + ' ' + c.country, n: c.n })));
  barList('list-actions', (s.actions || []).map((a) => ({ label: a.action, n: a.n })));
}

function flag(cc) {
  if (!cc || cc.length !== 2 || cc === '??') return '🏳️';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/* ------------------------------------------------------------------ *
 *  Rendering — charts (hand-rolled SVG)
 * ------------------------------------------------------------------ */

function emptyChart(id, text) {
  $(id).innerHTML = `<div class="chart-empty">${esc(text).replace(/\n/g, '<br>')}</div>`;
}

/** Two series side by side, one group per row. */
function groupedBars(id, rows, keyField, series, fmtLabel = (x) => x) {
  if (!rows.length) return emptyChart(id, 'Nothing recorded yet.');

  const W = 900, H = 190, padL = 34, padR = 8, padT = 10, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s]) || 0)));
  const step = iw / rows.length;
  const bw = Math.max(2, (step - 4) / series.length);

  const ticks = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    const y = padT + ih - f * ih;
    return `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>` +
           `<text class="ax" x="${padL - 6}" y="${y + 3}" text-anchor="end">${v}</text>`;
  }).join('');

  const bars = rows.map((r, i) => series.map((s, si) => {
    const v = Number(r[s]) || 0;
    const h = (v / max) * ih;
    const x = padL + i * step + 2 + si * bw;
    return `<rect class="bar-${si === 0 ? 'a' : 'b'}" x="${x.toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" ` +
           `width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="1.5">` +
           `<title>${esc(r[keyField])} · ${s}: ${v}</title></rect>`;
  }).join('')).join('');

  const everyN = Math.ceil(rows.length / 12);
  const labels = rows.map((r, i) => i % everyN === 0
    ? `<text class="ax" x="${(padL + i * step + step / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(fmtLabel(r[keyField]))}</text>`
    : '').join('');

  $(id).innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${ticks}${bars}${labels}</svg>`;
}

/** One series, e.g. the 24-hour profile. */
function singleBars(id, rows) {
  if (!rows.length) return emptyChart(id, 'Nothing recorded yet.');

  const W = 480, H = 150, padL = 28, padR = 6, padT = 8, padB = 20;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const step = iw / rows.length;
  const bw = Math.max(2, step - 3);

  const ticks = [0, 1].map((f) => {
    const y = padT + ih - f * ih;
    return `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>` +
           `<text class="ax" x="${padL - 5}" y="${y + 3}" text-anchor="end">${Math.round(max * f)}</text>`;
  }).join('');

  const bars = rows.map((r, i) => {
    const h = (r.n / max) * ih;
    return `<rect class="bar-a" x="${(padL + i * step + 1.5).toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" ` +
           `width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="1.5">` +
           `<title>${esc(r.k)}:00 — ${r.n} views</title></rect>`;
  }).join('');

  const labels = rows.map((r, i) => i % 3 === 0
    ? `<text class="ax" x="${(padL + i * step + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(r.k)}</text>`
    : '').join('');

  $(id).innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${ticks}${bars}${labels}</svg>`;
}

function barList(id, rows) {
  const host = $(id);
  if (!rows.length) { host.innerHTML = '<div class="bl-empty">Nothing yet.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.n), 1);
  host.innerHTML = rows.map((r) => `
    <div class="bl-row">
      <span class="bl-label">
        <span class="bl-fill" style="width:${((r.n / max) * 100).toFixed(1)}%"></span>
        <span class="bl-text">${esc(r.label)}</span>
      </span>
      <span class="bl-n">${num(r.n)}</span>
    </div>`).join('');
}

/* ------------------------------------------------------------------ *
 *  Rendering — feedback
 * ------------------------------------------------------------------ */

function renderFeedback() {
  const host = $('fb-list');
  let items = currentFeedback;
  if (fbFilter === 'unread') items = items.filter((i) => !i.is_read);
  else if (fbFilter !== 'all') items = items.filter((i) => i.kind === fbFilter);

  if (!items.length) {
    host.innerHTML = `<div class="fb-empty">Nothing here yet.<br>
      Feedback sent from the map appears within a few seconds.</div>`;
    return;
  }

  host.innerHTML = items.map((i) => {
    let ctx = '';
    try {
      const parsed = typeof i.context === 'string' ? JSON.parse(i.context) : (i.context || {});
      if (Object.keys(parsed).length) ctx = `<div class="fb-ctx">${esc(JSON.stringify(parsed, null, 2))}</div>`;
    } catch { /* keep it out rather than render garbage */ }

    const contact = i.contact
      ? `<span class="fb-contact">reply to <a href="mailto:${esc(i.contact)}">${esc(i.contact)}</a></span>`
      : '<span>no contact given</span>';

    return `<article class="fb-item ${i.is_read ? '' : 'unread'}" data-id="${i.id}">
      <div class="fb-item-head">
        <span class="fb-kind-tag ${esc(i.kind)}">${esc(i.kind)}</span>
        <span class="fb-when">${esc(IST.format(new Date(i.ts * 1000)))} IST</span>
        ${i.country ? `<span class="fb-flag">${flag(i.country)} ${esc(i.country)}</span>` : ''}
        ${i.emailed ? '<span class="fb-flag">✉ forwarded</span>' : ''}
        <span class="fb-item-actions">
          <button class="btn btn-sm" data-act="toggle" data-id="${i.id}">
            ${i.is_read ? 'mark unread' : 'mark read'}
          </button>
        </span>
      </div>
      <div class="fb-body">${esc(i.message)}</div>
      <div class="fb-meta">${contact}<span>#${i.id}</span></div>
      ${ctx}
    </article>`;
  }).join('');
}

function renderLocalFeedback() {
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem('nml.fb.queue') || '[]'); } catch { /* ignore */ }
  currentFeedback = queue.map((q, idx) => ({
    id: `local-${idx + 1}`,
    ts: Math.floor(new Date(q.at || Date.now()).getTime() / 1000),
    kind: q.kind || 'idea',
    message: q.message || '',
    contact: q.contact || null,
    context: q.context || {},
    country: null,
    is_read: 0,
    emailed: 0,
  }));
  renderFeedback();
  if (!currentFeedback.length) {
    $('fb-list').innerHTML = `<div class="fb-empty">
      No feedback queued in this browser.<br>
      Once the API is deployed, everything sent from any device shows up here.<br>
      Direct email still works: <a href="mailto:${OWNER_EMAIL}">${OWNER_EMAIL}</a>
    </div>`;
  }
}

/* ------------------------------------------------------------------ *
 *  Wiring
 * ------------------------------------------------------------------ */

$('gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  signIn($('gu').value.trim(), $('gp').value);
});

$('adm-logout').addEventListener('click', () => signOut('Signed out.'));
$('adm-refresh').addEventListener('click', () => refresh());
$('adm-range').addEventListener('change', () => refresh());

$('fb-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  fbFilter = b.dataset.f;
  for (const c of $('fb-filter').children) c.classList.toggle('is-on', c === b);
  renderFeedback();
});

$('fb-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act="toggle"]');
  if (!b) return;
  const id = b.dataset.id;
  const item = currentFeedback.find((i) => String(i.id) === String(id));
  if (!item) return;

  if (String(id).startsWith('local-')) { item.is_read = item.is_read ? 0 : 1; renderFeedback(); return; }

  b.disabled = true;
  try {
    await api('/api/admin/feedback/read', { method: 'POST', body: { id: Number(id), read: !item.is_read } });
    item.is_read = item.is_read ? 0 : 1;
    renderFeedback();
  } catch (err) {
    b.disabled = false;
    b.textContent = err.message.slice(0, 24);
  }
});

// pause polling while the tab is hidden, resume immediately on return
document.addEventListener('visibilitychange', () => {
  if (!token) return;
  if (document.visibilityState === 'visible') { refresh(); }
});

/* ------------------------------ boot ------------------------------ */

showGateNote();

try {
  const saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved && API_BASE) { token = saved; enterDashboard(false); }
} catch { /* ignore */ }

window.__admin = { api, refresh, renderStats, renderFeedback, signOut, get token() { return token; } };
