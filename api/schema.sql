-- =============================================================================
-- Namma Metro Live — D1 schema
--
-- Deliberately small. Two facts tables (events, feedback) and one counter table
-- for rate limiting. No IP addresses are stored: Cloudflare gives us a country
-- code at the edge and that is all we keep. Session ids are random, live in
-- sessionStorage, and die with the browser tab.
--
--   wrangler d1 execute namma-metro --remote --file=./schema.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,          -- unix seconds (UTC)
  day      TEXT    NOT NULL,          -- YYYY-MM-DD in IST, for daily rollups
  hour     INTEGER NOT NULL,          -- 0-23 in IST
  type     TEXT    NOT NULL,          -- view | ping | action | leave
  sid      TEXT    NOT NULL,          -- ephemeral session id
  action   TEXT,                      -- set when type = action
  path     TEXT,
  ref      TEXT,                      -- referrer hostname only
  country  TEXT,                      -- from CF-IPCountry
  tz       TEXT,
  vw       INTEGER,                   -- viewport width, for the device split
  device   TEXT                       -- mobile | tablet | desktop
);

CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_day    ON events(day);
CREATE INDEX IF NOT EXISTS idx_events_type   ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_sid_ts ON events(sid, ts);

CREATE TABLE IF NOT EXISTS feedback (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  kind     TEXT    NOT NULL,          -- bug | data | idea | praise
  message  TEXT    NOT NULL,
  contact  TEXT,
  context  TEXT,                      -- JSON blob: theme, viewport, UA, sim time
  country  TEXT,
  is_read  INTEGER NOT NULL DEFAULT 0,
  emailed  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts DESC);

-- Fixed-window rate limiting for /api/event, /api/feedback and admin login.
CREATE TABLE IF NOT EXISTS rate (
  k       TEXT    PRIMARY KEY,
  n       INTEGER NOT NULL,
  resets  INTEGER NOT NULL
);
