# Namma Metro Live — optional API

The map does not need this. Deploy it only if you want:

- **feedback** stored durably and visible from `/admin.html` on any device
  (without it, feedback queues in the sender's browser and offers a `mailto:` fallback)
- **traffic stats** — views, live sessions, surges, referrers, countries, devices

Stack: one Cloudflare Worker + one D1 (SQLite) database. Both sit inside the free tier for
anything short of serious traffic — 100k Worker requests/day and 5 GB of D1 storage.

---

## Deploy

```bash
cd api
npx wrangler login

# 1. database
npx wrangler d1 create namma-metro
#    → copy the printed database_id into wrangler.toml
npx wrangler d1 execute namma-metro --remote --file=./schema.sql

# 2. admin credentials  (nothing is written to disk or to git)
node ../tools/hash-password.mjs
#    → prints ADMIN_PW and SESSION_SECRET; paste each when prompted below
npx wrangler secret put ADMIN_USER          # e.g. aahil
npx wrangler secret put ADMIN_PW
npx wrangler secret put SESSION_SECRET

# 3. ship it
npx wrangler deploy
```

Then in `public/js/config.js`:

```js
export const API_BASE = 'https://namma-metro-api.<your-subdomain>.workers.dev';
```

…and redeploy the site. Check it worked:

```bash
curl https://namma-metro-api.<you>.workers.dev/api/health
# {"ok":true,"adminConfigured":true,"emailConfigured":false,...}
```

Finally, tighten CORS in `wrangler.toml`:

```toml
ALLOWED_ORIGINS = "https://your-site.pages.dev,http://localhost:5173"
```

---

## Optional: email forwarding

Feedback is always stored in D1 and shown in the dashboard. If you also want it in your
inbox, add a [Resend](https://resend.com) key (free tier: 3,000 emails/month):

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM       # must be a verified sender, e.g. feedback@yourdomain.dev
npx wrangler secret put MAIL_TO         # where you want it delivered
```

Email failures never fail the request — the message is already safely in D1.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/api/health` | — | liveness + which features are configured |
| `POST` | `/api/event` | — | anonymous `view` / `ping` / `action` / `leave` beacon |
| `POST` | `/api/feedback` | — | store a message, optionally email it |
| `POST` | `/api/admin/login` | — | username + password → 12 h bearer token |
| `GET`  | `/api/admin/stats?days=14` | Bearer | totals, daily series, hourly profile, surge, referrers, countries, devices, actions |
| `GET`  | `/api/admin/feedback?limit=50` | Bearer | feedback list |
| `POST` | `/api/admin/feedback/read` | Bearer | mark read / unread |

Rate limits (fixed window, per hashed client): events 240 / 5 min · feedback 8 / hour ·
login 6 / 15 min.

---

## Security model

- **The password never reaches the browser.** It is stored only as
  `iterations:salt:hash` (PBKDF2-SHA256) in a Cloudflare secret. `tools/browser-check.mjs`
  asserts on every run that neither the password nor the hash appears in any client file.
- **Constant-time comparison** for both the username and the derived key, and both halves
  are always evaluated so timing cannot reveal which one failed.
- **Sessions are HMAC-signed tokens**, not cookies — no CSRF surface. 12-hour expiry,
  held in `sessionStorage` so they die with the tab.
- **Errors are generic.** Internal failures log server-side and return
  `{"error":"internal error"}` with no stack trace.

### On the iteration count

`hash-password.mjs` defaults to **10,000** PBKDF2 iterations (~2 ms). That is lower than
you would choose for a public password database, and it is deliberate: the Workers free plan
allows roughly 10 ms of CPU per request, and exceeding it makes login fail outright.

The trade-off is bounded because the derivation only ever runs server-side on a rate-limited
endpoint, and the hash is only reachable by breaching Cloudflare's secret store — at which
point the session secret is gone too. **Use a long password.** On the Workers paid plan
(30 s CPU), regenerate properly:

```bash
node ../tools/hash-password.mjs --iterations 210000
```

---

## Privacy

No IP addresses are stored. Cloudflare provides `CF-IPCountry` at the edge and that
two-letter code is the only location signal kept. Rate-limit keys use a salted SHA-256 of
the IP and are never written alongside event rows. Session ids are random and ephemeral.
`DNT` / `Sec-GPC` are honoured client-side before a beacon is ever sent.

---

## Local development

```bash
npx wrangler dev --local          # D1 runs against a local SQLite file
```

Point `API_BASE` at `http://127.0.0.1:8787` in `public/js/config.js` while testing.

The auth and routing logic is unit-tested without a Cloudflare runtime — the Worker uses
only WebCrypto and standard globals, so `node tools/test-api.mjs` exercises it against a
stubbed D1.
