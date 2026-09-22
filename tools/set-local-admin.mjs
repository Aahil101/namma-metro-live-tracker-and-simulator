/**
 * set-local-admin.mjs — write the LOCAL_ADMIN digest in public/js/config.js.
 *
 * This is the no-backend gate only. It is deliberately weak and the config file
 * says so; see the comment block there. The real admin password is a Cloudflare
 * secret and never passes through this script.
 *
 *   node tools/set-local-admin.mjs <username> <password>
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const [user, pass] = process.argv.slice(2);
if (!user || !pass) {
  console.error('usage: node tools/set-local-admin.mjs <username> <password>');
  process.exit(1);
}

const FILE = path.resolve(import.meta.dirname, '..', 'public', 'js', 'config.js');
const digest = crypto.createHash('sha256').update(`${user}:${pass}:nml-local-v1`).digest('hex');

let src = fs.readFileSync(FILE, 'utf8');
const before = src;

src = src.replace(/user: '[^']*'/, `user: '${user}'`);
src = src.replace(/digest: '[0-9a-f]{64}'/, `digest: '${digest}'`);

if (src === before) {
  console.error('nothing replaced — is the LOCAL_ADMIN block present?');
  process.exit(1);
}

fs.writeFileSync(FILE, src, 'utf8');

// verify, and make sure the plaintext did not leak into the file
const written = fs.readFileSync(FILE, 'utf8');
const okDigest = written.includes(digest);
const noPlaintext = !written.includes(pass);

console.log(`user    : ${user}`);
console.log(`digest  : ${digest}`);
console.log(`in file : ${okDigest}`);
console.log(`plaintext absent: ${noPlaintext}`);
process.exit(okDigest && noPlaintext ? 0 : 1);
