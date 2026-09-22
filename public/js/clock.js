/**
 * clock.js — Indian Standard Time handling and GTFS calendar resolution.
 *
 * Everything in the app is driven off "seconds since IST midnight". The user's
 * own machine timezone is irrelevant: someone opening this from London still
 * sees the trains that are actually running in Bengaluru right now.
 */

const IST = 'Asia/Kolkata';

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

const PRETTY = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, weekday: 'short', day: 'numeric', month: 'short',
});

const SEC_PER_DAY = 86400;

/** Wall-clock reading in Bengaluru for a given instant. */
export function istNow(date = new Date()) {
  const p = {};
  for (const part of PARTS.formatToParts(date)) p[part.type] = part.value;

  const y = +p.year, mo = +p.month, d = +p.day;
  // Some engines render midnight as "24" rather than "00".
  const hh = +p.hour % 24, mi = +p.minute, ss = +p.second;

  // Sub-second precision comes from the underlying instant — the formatter
  // truncates, so blend the millisecond remainder back in for smooth motion.
  const ms = date.getMilliseconds();

  return {
    dateKey: `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`,
    y, mo, d,
    dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), // 0 = Sunday
    sec: hh * 3600 + mi * 60 + ss + ms / 1000,
    pretty: PRETTY.format(date),
  };
}

/** The IST calendar day before `dateKey` (needed for trains still running past midnight). */
export function previousDay({ y, mo, d }) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() - 1);
  return {
    dateKey: `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`,
    dow: t.getUTCDay(),
  };
}

/**
 * Resolve which GTFS service_id runs on a date.
 *
 * BMRCL runs four distinct patterns: `weekday` (Tue–Sat), `monday`,
 * `sunday` and `holiday`. Public holidays are listed in calendar_dates.txt,
 * where they remove `weekday`/`monday` and add `holiday` for that date.
 */
export function serviceFor(dateKey, dow, { services, exceptions }) {
  const added = [];
  const removed = new Set();
  for (const ex of exceptions) {
    if (ex.date !== dateKey) continue;
    if (ex.type === 1) added.push(ex.service);
    else removed.add(ex.service);
  }
  if (added.length) return added[0]; // an explicit addition (holiday) wins

  for (const svc of services) {
    if (removed.has(svc.id)) continue;
    if (!svc.days[dow]) continue;
    if (dateKey < svc.start || dateKey > svc.end) continue;
    return svc.id;
  }
  return null;
}

export function isHolidayDate(dateKey, { exceptions }) {
  return exceptions.some((e) => e.date === dateKey && e.type === 1 && e.service === 'holiday');
}

/* ----------------------------- formatting ------------------------------ */

const p2 = (n) => String(n).padStart(2, '0');

/** 74100 -> "20:35"   (handles 24:xx+ rollover for past-midnight trips) */
export function hhmm(sec) {
  const s = ((Math.floor(sec) % SEC_PER_DAY) + SEC_PER_DAY) % SEC_PER_DAY;
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}`;
}

/** 74100 -> "20:35:00" */
export function hhmmss(sec) {
  const s = ((Math.floor(sec) % SEC_PER_DAY) + SEC_PER_DAY) % SEC_PER_DAY;
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
}

/** Countdown text: 95 -> "1m 35s", 42 -> "42s", 3700 -> "1h 01m" */
export function countdown(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${p2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${p2(Math.floor(s / 60) % 60)}m`;
}

/** Compact countdown for dense lists: "2:05", "12s" */
export function shortCountdown(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
}

export function minutes(sec) {
  const m = sec / 60;
  return (m < 10 ? m.toFixed(1) : Math.round(m).toString()).replace(/\.0$/, '');
}

export { SEC_PER_DAY };
