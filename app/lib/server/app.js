// WebTerm web server: HTTPS, API, WebSocket hub and IDE proxy.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './db.js';
import { Vault } from './security.js';
import { BrokerClient } from './broker-client.js';
import { Auth } from './auth.js';
import { Hub } from './hub.js';
import { Terminals } from './terminals.js';
import { Systems } from './systems.js';
import { Plugins } from './plugins.js';
import { Ide } from './ide.js';
import { Procs } from './procs.js';
import { Files } from './files.js';
import { Desktops } from './desktop.js';
import { StaticFiles } from './static.js';
import { HttpError, readJson, sendJson } from './http.js';
import { buildRoutes } from './routes.js';

export const VERSION = '1.3.0';

export class App {
  constructor(cfg) {
    this.cfg = cfg;
    this.log = (...a) => console.log(new Date().toISOString(), ...a);
    this.secureCookies = !!cfg.tls || !!cfg.trustProxy;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    this.tmpDir = path.join(cfg.dataDir, 'tmp');
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    this.store = new Store(path.join(cfg.dataDir, 'webterm.db'));
    this.vault = new Vault(path.join(cfg.dataDir, 'master.key'));
    this.auth = new Auth(this);
    this.hub = new Hub(this);
    this.terms = new Terminals(this);
    this.systems = new Systems(this);
    this.plugins = new Plugins(this);
    this.ide = new Ide(this);
    this.procs = new Procs(this);
    this.files = new Files(this);
    this.desktops = new Desktops(this);
    this.static = new StaticFiles(path.join(cfg.appDir, 'web/dist'));
    this.router = buildRoutes(this);

    this.broker = new BrokerClient(cfg.brokerSocket, this.log);
    this.broker.on('up', (hello) => {
      this.log('broker connected');
      this.terms.onBrokerUp(hello);
      this.ide.onBrokerUp(hello);
      this.hub.onBrokerUp();
    });
    this.broker.on('down', () => {
      this.log('broker connection lost');
      this.terms.onBrokerDown();
      this.hub.onBrokerDown();
      this.procs.onBrokerDown();
    });
    this.broker.on('event', (ev) => {
      if (ev.op === 'procExit') this.procs.onExit(ev);
      else if (ev.op === 'ide') this.ide.onEvent(ev);
      else this.terms.onEvent(ev);
    });
    this.broker.on('data', (id, seq, bytes) => {
      if (this.procs.has(id)) this.procs.onData(id, bytes);
      else this.hub.onBrokerData(id, seq, bytes);
    });
    this.systems.start();
  }

  clientIp(req) {
    if (this.cfg.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf.slice(0, 64);
    }
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }

  audit(ctx, action, detail = '') {
    const { req, userId = null, username = '' } = ctx || {};
    this.store.run(
      'INSERT INTO audit (ts, user_id, username, ip, action, detail) VALUES (?,?,?,?,?,?)',
      Date.now(),
      userId,
      username,
      req ? this.clientIp(req) : '',
      action,
      String(detail || '').slice(0, 500),
    );
  }

  scheme(req) {
    if (this.cfg.tls) return 'https';
    if (this.cfg.trustProxy && req.headers['x-forwarded-proto']) return String(req.headers['x-forwarded-proto']).split(',')[0].trim();
    return 'http';
  }

  hostHeader(req) {
    if (this.cfg.trustProxy && req.headers['x-forwarded-host']) return String(req.headers['x-forwarded-host']).split(',')[0].trim();
    return String(req.headers.host || '');
  }

  originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (origin === `${this.scheme(req)}://${this.hostHeader(req)}`) return true;
    return (this.cfg.allowedOrigins || []).includes(origin);
  }

  securityHeaders(req) {
    const host = this.hostHeader(req).replace(/[^A-Za-z0-9.:[\]-]/g, '');
    const h = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self' wss://${host} ws://${host}`,
        "frame-src 'self'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    };
    if (this.cfg.hsts && this.cfg.tls) h['Strict-Transport-Security'] = 'max-age=31536000';
    return h;
  }

  onTerminalExit(row, code) {
    this.plugins.onTaskExit(row, code).catch((e) => this.log('task exit', e.message));
  }

  // ------------------------------------------------------------ request handling
  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const p = url.pathname;
    try {
      if (p === '/ide' || p.startsWith('/ide/')) return this.handleIde(req, res, url);
      const sec = this.securityHeaders(req);
      for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);
      if (p.startsWith('/api/')) return await this.handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (p === '/' || p === '/index.html') {
        if (!this.auth.resolve(req)) return this.redirect(res, '/login');
        return this.static.serve(req, res, '/index.html') || this.notBuilt(res);
      }
      if (p === '/login') {
        if (this.auth.resolve(req)) return this.redirect(res, '/');
        return this.static.serve(req, res, '/login.html') || this.notBuilt(res);
      }
      if (p === '/sw.js') return this.static.serve(req, res, p, { 'Service-Worker-Allowed': '/' }) || this.notFound(res);
      if (p.endsWith('.html')) return this.notFound(res);
      if (this.static.serve(req, res, p)) return;
      return this.notFound(res);
    } catch (e) {
      this.fail(res, e);
    }
  }

  redirect(res, to) {
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
    res.end();
  }

  notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  notBuilt(res) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frontend is not built. Run: npm run build');
  }

  fail(res, e) {
    if (res.headersSent) return res.destroy();
    // If the request body was not consumed (e.g. a rejected upload), close the
    // connection after answering instead of reading the rest of the body.
    const close = e && e.status === 413 ? true : res.req && !res.req.complete;
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) }, close ? { Connection: 'close' } : {});
    this.log('request failed', e && e.stack ? e.stack : e);
    sendJson(res, 500, { error: e && e.message && /service is not available|broker/.test(e.message) ? 'Terminal service is not available' : 'Internal error' });
  }

  async handleApi(req, res, url) {
    const m = this.router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = m;
    const opts = route.opts;
    if (req.method !== 'GET') {
      // CSRF: a custom header cannot be sent cross-site without CORS (which we never grant),
      // and SameSite=Strict keeps the cookie off cross-site requests.
      if (req.headers['x-webterm'] !== '1') throw new HttpError(403, 'Missing request header');
      if (req.headers.origin && !this.originAllowed(req)) throw new HttpError(403, 'Bad origin');
    }
    let auth = null;
    if (opts.auth !== false) {
      auth = this.auth.resolve(req);
      if (!auth) throw new HttpError(401, 'Not signed in');
      if (opts.admin && auth.user.role !== 'admin') throw new HttpError(403, 'Administrators only');
    }
    const body = req.method === 'GET' || req.method === 'DELETE' || opts.raw ? {} : await readJson(req, opts.limit || 1024 * 1024);
    const ctx = { req, res, params, body, query: url.searchParams, user: auth && auth.user, sess: auth && auth.sess, app: this };
    const out = await route.handler(ctx);
    if (out === undefined) {
      if (!res.headersSent) sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 200, out);
  }

  handleIde(req, res, url) {
    const auth = this.auth.resolve(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Not signed in');
    }
    // The IDE is framed by WebTerm itself; refuse requests initiated by other sites.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    if (url.pathname === '/ide') return this.redirect(res, '/ide/' + url.search);
    const upstreamPath = url.pathname.slice(4) + url.search;
    this.ide.proxy(req, res, auth.user, upstreamPath);
  }

  handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return socket.destroy();
    }
    const auth = this.auth.resolve(req);
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!this.originAllowed(req)) return reject(403, 'Forbidden');
    if (!auth) return reject(401, 'Unauthorized');
    if (url.pathname === '/ws') return this.hub.handleUpgrade(req, socket, head, auth);
    if (url.pathname.startsWith('/desktop/')) return this.desktops.handleUpgrade(req, socket, head, auth, url);
    if (url.pathname.startsWith('/ide/')) return this.ide.proxyUpgrade(req, socket, head, auth.user, url.pathname.slice(4) + url.search);
    reject(404, 'Not Found');
  }

  listen() {
    const { cfg } = this;
    const handler = (req, res) => this.handle(req, res);
    let server;
    if (cfg.tls && cfg.tls.cert && cfg.tls.key) {
      server = https.createServer({ cert: fs.readFileSync(cfg.tls.cert), key: fs.readFileSync(cfg.tls.key), minVersion: 'TLSv1.2' }, handler);
    } else {
      server = http.createServer(handler);
    }
    server.headersTimeout = 30_000;
    // Uploads and downloads may take long; JSON bodies have their own timeout
    // (readBody) and uploads a stall timeout.
    server.requestTimeout = 0;
    server.keepAliveTimeout = 30_000;
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    server.on('clientError', (e, socket) => socket.destroy());
    server.listen(cfg.listen.port, cfg.listen.host, () => {
      this.log(`WebTerm ${VERSION} listening on ${cfg.tls ? 'https' : 'http'}://${cfg.listen.host}:${cfg.listen.port}`);
    });
    this.server = server;
    return server;
  }
}
