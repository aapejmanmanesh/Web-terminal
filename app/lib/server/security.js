// Password hashing, tokens and secret encryption.
import crypto from 'node:crypto';
import fs from 'node:fs';

// scrypt, memory-hard (64 MiB). Format: scrypt$N$r$p$salt$hash
const N = 1 << 16;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFC'), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

export async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password).normalize('NFC'), Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return stored ? crypto.timingSafeEqual(key, expected) : false;
}

export const dummyVerify = (password) => verifyPassword(password, null);

export function passwordProblem(pw) {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 256) return 'Password is too long';
  return null;
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (len = 12) => crypto.randomBytes(len).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, len).padEnd(len, '0');

// ------------------------------------------------------------ secrets vault
// AES-256-GCM with a 32-byte master key kept in a file only the service can read.
export class Vault {
  constructor(file) {
    this.file = file;
    if (!fs.existsSync(file)) {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, crypto.randomBytes(32).toString('base64'));
      fs.closeSync(fd);
    }
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('master key must be 32 bytes');
    this.key = key;
  }
  seal(plain, aad = 'webterm-secret-v1') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const enc = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }
  open(sealed, aad = 'webterm-secret-v1') {
    const raw = Buffer.from(String(sealed).replace(/^v1:/, ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
}

// ------------------------------------------------------------ login throttling
// Per-IP and per-account failure counters with temporary blocks.
export class Throttle {
  constructor({ max, windowMs, blockMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.map = new Map();
    setInterval(() => this.sweep(), 60_000).unref();
  }
  blockedFor(key) {
    const e = this.map.get(key);
    if (!e || !e.until) return 0;
    const left = e.until - Date.now();
    return left > 0 ? left : 0;
  }
  fail(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || now - e.first > this.windowMs) e = { first: now, count: 0, until: 0, strikes: e ? e.strikes : 0 };
    e.count++;
    if (e.count >= this.max) {
      e.strikes = (e.strikes || 0) + 1;
      e.until = now + this.blockMs * Math.min(8, 2 ** (e.strikes - 1));
      e.count = 0;
      e.first = now;
    }
    this.map.set(key, e);
    return e.until > now;
  }
  success(key) {
    this.map.delete(key);
  }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if ((!e.until || e.until < now) && now - e.first > this.windowMs * 4) this.map.delete(k);
  }
}
