// IDE: a per-user code-server instance listening on a private unix socket,
// reverse-proxied under /ide/ behind WebTerm's own login.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { HttpError } from './http.js';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export class Ide {
  constructor(app) {
    this.app = app;
    this.running = new Map();
  }

  available() {
    return fs.existsSync(this.app.cfg.codeServer);
  }

  onBrokerUp(hello) {
    this.running = new Map((hello.ides || []).map((r) => [r.user, r.socket]));
  }

  onEvent(ev) {
    if (ev.op !== 'ide') return;
    if (!ev.running) this.running.delete(ev.user);
    for (const u of this.app.store.all('SELECT id FROM users WHERE linux_user = ?', ev.user)) {
      this.app.hub.emitUser(u.id, { t: 'ide', running: !!ev.running });
    }
  }

  status(user) {
    return { available: this.available(), allowed: !!(user.allow_ide && user.linux_user), running: this.running.has(user.linux_user) };
  }

  async start(user) {
    if (!user.allow_ide || !user.linux_user) throw new HttpError(403, 'The IDE is disabled for your account');
    if (!this.available()) throw new HttpError(400, 'code-server is not installed on this server');
    const r = await this.app.broker.call({ op: 'ideStart', user: user.linux_user }, 45000);
    this.running.set(user.linux_user, r.socket);
    return this.status(user);
  }

  async stop(user) {
    if (!user.linux_user) return this.status(user);
    await this.app.broker.call({ op: 'ideStop', user: user.linux_user });
    this.running.delete(user.linux_user);
    return this.status(user);
  }

  socketFor(user) {
    if (!user.allow_ide || !user.linux_user) return null;
    return this.running.get(user.linux_user) || null;
  }

  upstreamHeaders(req) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k)) continue;
      if (k === 'cookie') {
        // Never hand WebTerm's session cookie to the IDE process.
        const kept = String(v)
          .split(';')
          .filter((c) => !/^\s*(__Host-wt|wt)=/.test(c))
          .join(';')
          .trim();
        if (kept) h.cookie = kept;
        continue;
      }
      h[k] = v;
    }
    return h;
  }

  proxy(req, res, user, path) {
    const socketPath = this.socketFor(user);
    if (!socketPath) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><body style="background:#0b0f14;color:#8b97a6;font:14px monospace;padding:40px">The IDE is not running. Start it from the IDE panel.</body>');
      return;
    }
    const up = http.request(
      { socketPath, path, method: req.method, headers: this.upstreamHeaders(req) },
      (ur) => {
        const headers = {};
        for (const [k, v] of Object.entries(ur.headers)) {
          if (HOP.has(k)) continue;
          if (k === 'location' && typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) headers[k] = '/ide' + v;
          else headers[k] = v;
        }
        headers['x-frame-options'] = 'SAMEORIGIN';
        res.writeHead(ur.statusCode || 502, headers);
        ur.pipe(res);
      },
    );
    up.on('error', (e) => {
      this.app.log('ide proxy error', e.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('IDE is not reachable');
      } else res.destroy();
    });
    req.pipe(up);
  }

  proxyUpgrade(req, socket, head, user, path) {
    const socketPath = this.socketFor(user);
    if (!socketPath) return socket.destroy();
    const up = net.connect(socketPath, () => {
      const lines = [`${req.method} ${path} HTTP/1.1`];
      const h = this.upstreamHeaders(req);
      h.connection = 'Upgrade';
      h.upgrade = req.headers.upgrade;
      for (const [k, v] of Object.entries(h)) {
        for (const vv of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${vv}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const kill = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', kill);
    socket.on('error', kill);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  }
}
