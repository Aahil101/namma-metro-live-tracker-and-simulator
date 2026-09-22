/**
 * hash-password.mjs — derive the ADMIN_PW secret for the Worker.
 *
 * The admin password must never appear in client code, in this repository, or
 * in the Worker source. It is stored only as a PBKDF2-SHA256 derivation in a
 * Cloudflare secret, in the form:
 *
 *     iterations:saltBase64:hashBase64
 *
 * Usage (interactive, nothing is echoed to your shell history):
 *
 *     node tools/hash-password.mjs
 *
 * Or non-interactively, if you accept it landing in history:
 *
 *     node tools/hash-password.mjs "my password"
 *
 * Then:
 *     cd api && wrangler secret put ADMIN_PW      # paste the output
 *
 * Iteration count: Cloudflare Workers on the free plan allow roughly 10 ms of
 * CPU per request, and PBKDF2-SHA256 costs about 0.7 µs per iteration, so the
 * default here is 10,000 (~7 ms) to stay comfortably inside that budget.
 *
 * That is lower than you would use for a public password database, and it is a
 * deliberate, bounded trade-off:
 *   • the derivation only ever runs server-side, on a rate-limited endpoint
 *     (6 attempts per 15 minutes per client);
 *   • the hash lives in a Cloudflare secret, not in this repo or the browser,
 *     so an offline attack requires breaching Cloudflare first;
 *   • use a long password — 14+ characters makes 10k iterations irrelevant.
 *
 * On the Workers paid plan (30 s CPU) raise it properly:
 *     node tools/hash-password.mjs --iterations 210000
 */

import crypto from 'node:crypto';
import readline from 'node:readline';

const DEFAULT_ITERATIONS = 10000;

const args = process.argv.slice(2);
const flagIdx = args.indexOf('--iterations');
const ITERATIONS = flagIdx >= 0 ? Number(args[flagIdx + 1]) : DEFAULT_ITERATIONS;
const inline = args.filter((a) => !a.startsWith('--') && a !== String(ITERATIONS))[0];

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // suppress echo so the password is not visible or logged
    const onData = (ch) => {
      const s = ch.toString();
      if (s === '\n' || s === '\r' || s === '\u0004') process.stdin.removeListener('data', onData);
      else process.stdout.write('\u001b[2K\u001b[200D' + question + '*'.repeat(rl.line.length));
    };
    process.stdout.write(question);
    process.stdin.on('data', onData);
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const password = inline || await ask('Admin password: ');

if (!password || password.length < 12) {
  console.error('\nRefusing: use at least 12 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const t0 = performance.now();
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const derivMs = performance.now() - t0;

const secret = `${ITERATIONS}:${salt.toString('base64')}:${hash.toString('base64')}`;
const session = crypto.randomBytes(32).toString('base64');

const budgetWarning = derivMs > 9
  ? `\n⚠  ${derivMs.toFixed(0)} ms to derive — that may exceed the 10 ms CPU limit on the\n` +
    `   Cloudflare Workers free plan. Re-run with a lower --iterations if login 500s.`
  : `\n✓  ${derivMs.toFixed(1)} ms to derive — inside the free-plan CPU budget.`;

console.log(`
──────────────────────────────────────────────────────────────────────────
ADMIN_PW   (paste into: wrangler secret put ADMIN_PW)
──────────────────────────────────────────────────────────────────────────
${secret}

──────────────────────────────────────────────────────────────────────────
SESSION_SECRET   (paste into: wrangler secret put SESSION_SECRET)
──────────────────────────────────────────────────────────────────────────
${session}

Also set the username:
    wrangler secret put ADMIN_USER
${budgetWarning}

Neither the password nor these values should be committed anywhere.
──────────────────────────────────────────────────────────────────────────
`);
