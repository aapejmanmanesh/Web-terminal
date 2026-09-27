// Remote desktop gateway (VNC / RFB).
//
//   browser (noVNC) ⇄ WebSocket ⇄ this server ⇄ TCP ⇄ VNC server on the LAN
//
// The server performs the VNC authentication itself, so the password stored
// in the vault never reaches a browser: noVNC is told the desktop needs no
// authentication. An optional frame-rate cap is applied by pacing the
// client's update requests.
import net from 'node:net';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { runRdp } from './rdp.js';

const MAX_PER_USER = 8;
const CONNECT_TIMEOUT = 10_000;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const CONTINUOUS_UPDATES = -313;

// VNC authentication: DES of the challenge, keyed with the password whose
// bytes are bit-reversed. Single DES = 3DES with three equal keys (plain DES
// is not available in OpenSSL 3's default provider).
function reverseBits(b) {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    r = (r << 1) | (b & 1);
    b >>= 1;
  }
  return r;
}
export function vncAuthResponse(challenge, password) {
  const key = Buffer.alloc(8);
  const pw = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
  for (let i = 0; i < 8 && i < pw.length; i++) key[i] = reverseBits(pw[i]);
  const c = crypto.createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(challenge), c.final()]);
}

// Reads exact byte counts from a stream until detach() hands the rest over.
// Only handshakes go through it, so what it may hold is capped.
const READER_MAX = 256 * 1024;
class Reader {
  constructor(on) {
    this.buf = Buffer.alloc(0);
    this.waits = [];
    this.error = null;
    on((d) => {
      if (this.error) return;
      if (this.buf.length + d.length > READER_MAX) return this.fail(new Error('Unexpected data during the VNC handshake'));
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : Buffer.from(d);
      this.pump();
    });
  }
  pump() {
    while (this.waits.length) {
      const w = this.waits[0];
      if (this.error) {
        this.waits.shift();
        w.reject(this.error);
        continue;
      }
      if (this.buf.length < w.n) return;
      this.waits.shift();
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
  read(n) {
    return new Promise((resolve, reject) => {
      this.waits.push({ n, resolve, reject });
      this.pump();
    });
  }
  fail(e) {
    this.error = e;
    this.pump();
  }
  detach() {
    this.detached = true;
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

async function readReason(r) {
  const len = (await r.read(4)).readUInt32BE(0);
  if (!len || len > 4096) return '';
  return (await r.read(len)).toString('utf8');
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, reject) => (t = setTimeout(() => reject(new Error(msg)), ms)))]).finally(() => clearTimeout(t));
}

// Connects and authenticates to the VNC server. Resolves when the server
// waits for ClientInit, with any bytes already read after the handshake.
export async function connectVnc({ host, port, password }) {
  const sock = net.connect({ host, port });
  sock.setNoDelay(true);
  let onData = null;
  const listener = (d) => onData && onData(d);
  sock.on('data', listener);
  const r = new Reader((fn) => (onData = fn));
  const fail = (e) => r.fail(e);
  sock.on('error', (e) => fail(new Error(friendlyNetError(e))));
  sock.on('close', () => fail(new Error('The VNC server closed the connection')));
  // The whole handshake must finish in time, not only the first steps.
  const deadline = setTimeout(() => fail(new Error('The VNC server stopped answering')), 2 * CONNECT_TIMEOUT);
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', (e) => reject(new Error(friendlyNetError(e))));
      }),
      CONNECT_TIMEOUT,
      `No answer from ${host}:${port}`,
    );
    const hello = (await withTimeout(r.read(12), CONNECT_TIMEOUT, 'The VNC server did not greet')).toString('latin1');
    const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(hello);
    if (!m || Number(m[1]) !== 3) throw new Error(`${host}:${port} is not a VNC server`);
    const minor = Number(m[2]);
    const v = minor >= 8 ? 8 : minor === 7 ? 7 : 3;
    sock.write(`RFB 003.00${v}\n`);
    let types;
    if (v >= 7) {
      const n = (await r.read(1))[0];
      if (n === 0) throw new Error((await readReason(r)) || 'The VNC server refused the connection');
      types = [...(await r.read(n))];
    } else {
      const t = (await r.read(4)).readUInt32BE(0);
      if (t === 0) throw new Error((await readReason(r)) || 'The VNC server refused the connection');
      types = [t];
    }
    let chosen = types.includes(1) ? 1 : types.includes(2) ? 2 : 0;
    if (!chosen) {
      throw new Error(`Unsupported VNC security (types ${types.join(', ')}). Enable classic VNC password authentication on that machine.`);
    }
    if (chosen === 2 && !password) throw new Error('This desktop needs a VNC password — set it in the system settings');
    if (v >= 7) sock.write(Buffer.from([chosen]));
    if (chosen === 2) {
      const challenge = await r.read(16);
      sock.write(vncAuthResponse(challenge, password));
    }
    if (chosen === 2 || v >= 8) {
      const res = (await r.read(4)).readUInt32BE(0);
      if (res !== 0) {
        let reason = '';
        if (v >= 8) reason = await readReason(r).catch(() => '');
        throw new Error(chosen === 2 ? `VNC password rejected${reason ? ': ' + reason : ''}` : reason || 'VNC authentication failed');
      }
    }
    onData = null;
    sock.off('data', listener);
    sock.removeAllListeners('close');
    sock.removeAllListeners('error');
    // Errors are reported through 'close' from here on.
    sock.on('error', () => {});
    return { sock, rest: r.detach() };
  } catch (e) {
    sock.destroy();
    throw e;
  } finally {
    clearTimeout(deadline);
  }
}

function friendlyNetError(e) {
  switch (e && e.code) {
    case 'ECONNREFUSED':
      return 'Connection refused — is a VNC server running on that port?';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host unreachable — is the machine on?';
    case 'ETIMEDOUT':
      return 'Connection timed out';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Unknown host name';
    default:
      return (e && e.message) || 'Connection failed';
  }
}

// Client → server RFB messages, parsed only when a frame-rate cap is active:
// update requests are paced and continuous updates are not offered.
export class ClientPacer {
  constructor(fps, write) {
    this.interval = 1000 / fps;
    this.write = write;
    this.buf = Buffer.alloc(0);
    this.raw = false;
    this.last = 0;
    this.pending = null;
    this.timer = null;
    this.through = 0;
  }
  push(d) {
    if (this.raw) return this.write(d);
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (!b.length) return;
      if (this.through) {
        // Clipboard text: forwarded as it arrives, never buffered.
        const n = Math.min(this.through, b.length);
        this.through -= n;
        this.write(b.subarray(0, n));
        this.buf = b.subarray(n);
        continue;
      }
      if (b[0] === 6) {
        // ClientCutText: the header now, the (possibly large) text streamed.
        if (b.length < 8) return;
        this.write(b.subarray(0, 8));
        this.through = Math.abs(b.readInt32BE(4));
        this.buf = b.subarray(8);
        continue;
      }
      const len = this.length(b);
      if (len === -1) {
        // Unknown message: stop interpreting, pass everything through.
        this.raw = true;
        this.flushPending();
        this.buf = Buffer.alloc(0);
        this.write(b);
        return;
      }
      if (len === 0 || b.length < len) return;
      const msg = b.subarray(0, len);
      this.buf = b.subarray(len);
      this.handle(msg);
    }
  }
  // Total length of the message at the start of b, 0 if more bytes are needed, -1 if unknown.
  length(b) {
    switch (b[0]) {
      case 0:
        return 20;
      case 2:
        return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2);
      case 3:
        return 10;
      case 4:
        return 8;
      case 5:
        return 6;
      case 6:
        return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4));
      case 150:
        return 10;
      case 248:
        return b.length < 9 ? 0 : 9 + b[8];
      case 250:
        return 4;
      case 251:
        return b.length < 8 ? 0 : 8 + 16 * b[6];
      case 255:
        if (b.length < 2) return 0;
        return b[1] === 0 ? 12 : -1;
      default:
        return -1;
    }
  }
  handle(msg) {
    if (msg[0] === 2) {
      // Drop the continuous-updates pseudo-encoding so the server only sends
      // frames on request.
      const n = msg.readUInt16BE(2);
      const keep = [];
      for (let i = 0; i < n; i++) {
        const enc = msg.readInt32BE(4 + 4 * i);
        if (enc !== CONTINUOUS_UPDATES) keep.push(enc);
      }
      const out = Buffer.alloc(4 + 4 * keep.length);
      out[0] = 2;
      out.writeUInt16BE(keep.length, 2);
      keep.forEach((e, i) => out.writeInt32BE(e, 4 + 4 * i));
      return this.write(out);
    }
    if (msg[0] === 3) {
      const now = Date.now();
      const due = this.last + this.interval;
      if (!this.pending && now >= due) {
        this.last = now;
        return this.write(msg);
      }
      // Keep the most useful pending request (a full refresh wins).
      if (!this.pending || msg[1] === 0) this.pending = Buffer.from(msg);
      if (!this.timer) this.timer = setTimeout(() => this.flushPending(), Math.max(0, due - now));
      return;
    }
    this.write(msg);
  }
  flushPending() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.last = Date.now();
      this.write(p);
    }
  }
  dispose() {
    clearTimeout(this.timer);
  }
}

export class Desktops {
  constructor(app) {
    this.app = app;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.active = new Map(); // userId -> Set
  }

  // proto: 'vnc' or 'rdp' (each has its own port; access is shared).
  canUse(user, system, proto = 'vnc') {
    const port = system ? (proto === 'rdp' ? system.rdp_port : system.vnc_port) : null;
    return !!(user && !user.disabled && port && (user.role === 'admin' || system.vnc_access === 'all'));
  }

  // What a stream is connected to; a change to any of it ends the stream.
  targetOf(system, proto) {
    return proto === 'rdp'
      ? [system.address, system.rdp_port, system.rdp_user || null, system.rdp_domain || null, system.rdp_secret || null].join('\n')
      : [system.address, system.vnc_port, system.vnc_secret || null].join('\n');
  }

  // Whether a live stream is still allowed: signed in, still permitted, and
  // the system still points at the same desktop with the same credentials.
  allowed(c) {
    if (!this.app.auth.sessionAlive(c.sessId)) return false;
    const user = this.app.store.get('SELECT * FROM users WHERE id = ?', c.userId);
    const sys = this.app.store.get('SELECT * FROM systems WHERE id = ?', c.systemId);
    if (!this.canUse(user, sys, c.proto)) return false;
    return this.targetOf(sys, c.proto) === c.target;
  }

  // Registers a live stream: per-user limit bookkeeping, keep-alive pings and
  // periodic permission checks. `teardown` closes the protocol side.
  track(ws, auth, system, proto, teardown) {
    const user = auth.user;
    const set = this.active.get(user.id) || new Set();
    this.active.set(user.id, set);
    const conn = { ws, closed: false, proto, userId: user.id, sessId: auth.sess.id, systemId: system.id, target: this.targetOf(system, proto) };
    set.add(conn);
    conn.cleanup = () => {
      if (conn.closed) return;
      conn.closed = true;
      set.delete(conn);
      clearInterval(conn.heartbeat);
      try {
        teardown();
      } catch {}
      try {
        ws.close();
      } catch {}
    };
    ws.on('close', conn.cleanup);
    ws.on('error', conn.cleanup);
    let alive = true;
    ws.on('pong', () => (alive = true));
    conn.heartbeat = setInterval(() => {
      if (!alive || !this.allowed(conn)) return conn.cleanup();
      alive = false;
      try {
        ws.ping();
      } catch {}
    }, 30_000);
    return conn;
  }

  // Ends streams that are no longer allowed (after users or systems change).
  recheck(filter = () => true) {
    for (const set of this.active.values()) for (const c of [...set]) if (filter(c) && !this.allowed(c)) c.cleanup();
  }

  count(userId) {
    return (this.active.get(userId) || new Set()).size;
  }

  // WebSocket upgrade for /desktop/<systemId>?fps=N (VNC) and
  // /desktop/<systemId>/rdp?w=&h=&dpi=… (RDP through guacd).
  handleUpgrade(req, socket, head, auth, url) {
    const m = /^\/desktop\/(\d{1,9})(\/rdp)?$/.exec(url.pathname);
    const system = m ? this.app.store.get('SELECT * FROM systems WHERE id = ?', Number(m[1])) : null;
    const proto = m && m[2] ? 'rdp' : 'vnc';
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!system) return reject(404, 'Not Found');
    if (!this.canUse(auth.user, system, proto)) return reject(403, 'Forbidden');
    if (this.count(auth.user.id) >= MAX_PER_USER) return reject(429, 'Too Many Requests');
    if (proto === 'rdp') return this.wss.handleUpgrade(req, socket, head, (ws) => runRdp(this, ws, auth, system, url.searchParams));
    const fps = Math.max(0, Math.min(120, Number(url.searchParams.get('fps')) || 0));
    this.wss.handleUpgrade(req, socket, head, (ws) => this.run(ws, auth, system, fps));
  }

  async run(ws, auth, system, fps) {
    const user = auth.user;
    const backendP = connectVnc({
      host: system.address,
      port: system.vnc_port,
      password: system.vnc_secret ? this.app.vault.open(system.vnc_secret) : null,
    });
    backendP.catch(() => {});
    const conn = this.track(ws, auth, system, 'vnc', () => {
      if (conn.pacer) conn.pacer.dispose();
      // A desktop connection still being set up is closed once it is ready.
      if (conn.backend) conn.backend.destroy();
      else backendP.then((b) => b.sock.destroy(), () => {});
    });
    conn.backend = null;
    const cleanup = conn.cleanup;

    // Browser-side handshake: we play a VNC server that needs no password.
    const client = new Reader((fn) => ws.on('message', (d) => !client.detached && fn(Buffer.isBuffer(d) ? d : Buffer.from(d))));
    try {
      ws.send(Buffer.from('RFB 003.008\n'));
      const cv = (await withTimeout(client.read(12), 15_000, 'client timeout')).toString('latin1');
      const cm = /^RFB 003\.00(\d)\n$/.exec(cv);
      if (!cm) throw new Error('bad client');
      const cminor = Number(cm[1]);
      let backend;
      try {
        backend = await backendP;
      } catch (e) {
        const reason = Buffer.from(String(e.message || e).slice(0, 300));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(reason.length);
        if (cminor >= 7) ws.send(Buffer.concat([Buffer.from([0]), len, reason]));
        else ws.send(Buffer.concat([Buffer.alloc(4), len, reason]));
        this.app.audit({ userId: user.id, username: user.username }, 'desktop.fail', `${system.name}: ${e.message}`);
        setTimeout(cleanup, 500);
        return;
      }
      conn.backend = backend.sock;
      if (conn.closed) return backend.sock.destroy();
      // The desktop may go away while the browser is still negotiating.
      conn.earlyClose = () => cleanup();
      backend.sock.once('close', conn.earlyClose);
      if (cminor >= 7) {
        ws.send(Buffer.from([1, 1]));
        const choice = (await client.read(1))[0];
        if (choice !== 1) throw new Error('bad security choice');
        if (cminor >= 8) ws.send(Buffer.alloc(4));
      } else {
        const t = Buffer.alloc(4);
        t.writeUInt32BE(1);
        ws.send(t);
      }
      // ClientInit (the "shared" flag) goes straight through; only later
      // messages may be paced.
      const clientInit = await withTimeout(client.read(1), 15_000, 'client timeout');
      if (conn.closed) return;
      backend.sock.write(clientInit);
      this.app.audit({ userId: user.id, username: user.username }, 'desktop.connect', `${system.name} (${system.address}:${system.vnc_port})${fps ? ` ${fps} fps` : ''}`);
      this.pipe(conn, client.detach(), backend, fps);
    } catch {
      cleanup();
    }
  }

  pipe(conn, clientRest, backend, fps) {
    const { ws } = conn;
    const sock = backend.sock;
    // Backpressure towards the desktop: stop reading from the browser while
    // the desktop is not taking data.
    let wsPaused = false;
    const toServer = (d) => {
      if (sock.destroyed) return;
      sock.write(d);
      if (!wsPaused && sock.writableLength > HIGH_WATER) {
        wsPaused = true;
        ws.pause();
        sock.once('drain', () => {
          wsPaused = false;
          ws.resume();
        });
      }
    };
    conn.pacer = fps ? new ClientPacer(fps, toServer) : null;
    const fromClient = (d) => (conn.pacer ? conn.pacer.push(d) : toServer(d));
    ws.on('message', (d) => fromClient(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    if (clientRest.length) fromClient(clientRest);
    let paused = false;
    const toClient = (d) => {
      if (ws.readyState !== 1) return;
      ws.send(d, () => {
        if (paused && ws.bufferedAmount < LOW_WATER) {
          paused = false;
          sock.resume();
        }
      });
      if (!paused && ws.bufferedAmount > HIGH_WATER) {
        paused = true;
        sock.pause();
      }
    };
    if (backend.rest.length) toClient(backend.rest);
    sock.on('data', toClient);
    const end = () => {
      if (!conn.closed) {
        try {
          ws.close(1000, 'Remote desktop closed the connection');
        } catch {}
      }
    };
    sock.off('close', conn.earlyClose);
    sock.on('close', end);
  }

  // Disconnects a user's sessions (signed out, disabled, deleted).
  dropUser(userId) {
    for (const c of [...(this.active.get(userId) || [])]) c.cleanup();
  }
}
