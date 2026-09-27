// Minimal HTTP toolkit: router, JSON bodies, cookies, errors.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (msg) => new HttpError(400, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) {
    this.add('GET', p, h, o);
  }
  post(p, h, o) {
    this.add('POST', p, h, o);
  }
  put(p, h, o) {
    this.add('PUT', p, h, o);
  }
  patch(p, h, o) {
    this.add('PATCH', p, h, o);
  }
  del(p, h, o) {
    this.add('DELETE', p, h, o);
  }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch {
        return null;
      }
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function readBody(req, limit = 1024 * 1024, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    const timer = setTimeout(() => {
      reject(new HttpError(408, 'Request timeout'));
      req.destroy();
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('data', (c) => {
      size += c.length;
      if (over) {
        // Keep draining so a 413 can be delivered, but cut off abusive uploads.
        if (size > limit * 8) req.destroy();
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export async function readJson(req, limit) {
  const ct = String(req.headers['content-type'] || '');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw bad('Invalid JSON');
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {}
    out[k] = v;
  }
  return out;
}

export function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

// ------------------------------------------------------------ validation
export function str(v, { name = 'value', min = 0, max = 200, re = null, trim = true, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    if (min > 0) throw bad(`${name} is required`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  const s = trim ? v.trim() : v;
  if (s.length < min) throw bad(`${name} is too short`);
  if (s.length > max) throw bad(`${name} is too long`);
  if (re && !re.test(s)) throw bad(`${name} is invalid`);
  if (/[\u0000]/.test(s)) throw bad(`${name} is invalid`);
  return s;
}

export function int(v, { name = 'value', min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw bad(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} is invalid`);
  return n;
}

export const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

export function oneOf(v, list, name = 'value') {
  if (!list.includes(v)) throw bad(`${name} is invalid`);
  return v;
}
