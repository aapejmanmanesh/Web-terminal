// WebSocket hub: one socket per browser tab, multiplexing terminal streams
// and live events. Terminal output is delivered as binary frames
// [u8 idLen][id][bytes]; everything else is JSON.
//
// Each subscription starts with a snapshot from the broker. Frames carry the
// broker's stream offset, so frames that were already part of the snapshot
// are dropped and none are lost in between. Slow clients are not allowed to
// back up memory: they are marked stale and re-synchronised with a fresh
// snapshot once their socket drains.
import { WebSocketServer } from 'ws';

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 256 * 1024;
const PENDING_CAP = 8 * 1024 * 1024;

function dataFrame(id, bytes) {
  const idb = Buffer.from(id, 'ascii');
  const head = Buffer.allocUnsafe(1 + idb.length);
  head.writeUInt8(idb.length, 0);
  idb.copy(head, 1);
  return Buffer.concat([head, bytes]);
}

export class Hub {
  constructor(app) {
    this.app = app;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
    this.clients = new Set();
    this.subsById = new Map();
    this.attached = new Set();
    setInterval(() => this.heartbeat(), 25_000).unref();
    setInterval(() => this.recoverStale(), 250).unref();
    setInterval(() => this.checkSessions(), 60_000).unref();
  }

  handleUpgrade(req, socket, head, auth) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, auth));
  }

  onConnection(ws, auth) {
    const client = { ws, user: auth.user, sessId: auth.sess.id, subs: new Map(), alive: true };
    this.clients.add(client);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.onInput(client, data);
        else this.onJson(client, JSON.parse(data.toString('utf8')));
      } catch (e) {
        this.app.log('ws message error', e.message);
      }
    });
    ws.on('close', () => this.drop(client));
    ws.on('error', () => {});
    this.send(client, { t: 'hello', broker: this.app.broker.up });
  }

  drop(client) {
    if (!this.clients.delete(client)) return;
    for (const id of client.subs.keys()) this.unsubscribe(client, id);
  }

  send(client, obj) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
  }

  emitUser(userId, obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) if (c.user.id === userId && c.ws.readyState === 1) c.ws.send(s);
  }

  emitAll(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(s);
  }

  toSubscribers(id, obj) {
    const set = this.subsById.get(id);
    if (!set) return;
    for (const c of set) this.send(c, obj);
  }

  onlineUserIds() {
    return new Set([...this.clients].map((c) => c.user.id));
  }

  kickSession(sessId) {
    for (const c of this.clients) {
      if (c.sessId === sessId) {
        this.send(c, { t: 'kick' });
        setTimeout(() => c.ws.close(4001, 'signed out'), 50);
      }
    }
  }

  kickUser(userId) {
    for (const c of this.clients) {
      if (c.user.id === userId) {
        this.send(c, { t: 'kick' });
        setTimeout(() => c.ws.close(4001, 'signed out'), 50);
      }
    }
  }

  heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {}
    }
  }

  checkSessions() {
    for (const c of this.clients) {
      if (!this.app.auth.sessionAlive(c.sessId)) {
        this.send(c, { t: 'kick' });
        c.ws.close(4001, 'session expired');
      }
    }
  }

  // ------------------------------------------------------------ client messages
  onJson(client, m) {
    switch (m.t) {
      case 'sub':
        return this.subscribe(client, String(m.id || ''), m.scrollback);
      case 'unsub':
        return this.unsubscribe(client, String(m.id || ''));
      case 'resize': {
        const id = String(m.id || '');
        if (!this.owns(client, id)) return;
        this.app.broker.send({ op: 'resize', id, cols: m.cols | 0, rows: m.rows | 0 });
        return;
      }
      case 'ping':
        return this.send(client, { t: 'pong' });
      default:
    }
  }

  owns(client, id) {
    if (client.subs.has(id)) return true;
    const r = this.app.terms.row(id);
    return !!r && r.user_id === client.user.id;
  }

  onInput(client, buf) {
    if (buf.length < 2) return;
    const n = buf.readUInt8(0);
    const id = buf.toString('ascii', 1, 1 + n);
    if (!client.subs.has(id)) return;
    this.app.broker.write(id, buf.subarray(1 + n));
  }

  subscribe(client, id, scrollback) {
    if (!this.owns(client, id)) {
      this.send(client, { t: 'snap', id, missing: true });
      return;
    }
    let sub = client.subs.get(id);
    if (!sub) {
      sub = { state: 'pending', buf: [], bufLen: 0, gen: 0, scrollback: Math.min(Math.max(scrollback | 0, 0), 50000) || 2000 };
      client.subs.set(id, sub);
      let set = this.subsById.get(id);
      if (!set) this.subsById.set(id, (set = new Set()));
      set.add(client);
    }
    this.ensureAttached(id);
    this.snapshot(client, id, sub);
  }

  unsubscribe(client, id) {
    if (!client.subs.delete(id)) return;
    const set = this.subsById.get(id);
    if (set) {
      set.delete(client);
      if (!set.size) {
        this.subsById.delete(id);
        if (this.attached.delete(id)) this.app.broker.send({ op: 'detach', id });
      }
    }
  }

  ensureAttached(id) {
    if (this.attached.has(id) || !this.app.broker.up) return;
    this.attached.add(id);
    this.app.broker.send({ op: 'attach', id });
  }

  async snapshot(client, id, sub) {
    sub.state = 'pending';
    sub.buf = [];
    sub.bufLen = 0;
    sub.overflow = false;
    const gen = ++sub.gen;
    if (!this.app.broker.up) return; // resynced when the broker returns
    let r;
    try {
      r = await this.app.broker.call({ op: 'snapshot', id, scrollback: sub.scrollback });
    } catch (e) {
      if (client.subs.get(id) !== sub || sub.gen !== gen) return;
      if (/no such session/.test(e.message)) {
        sub.state = 'missing';
        const row = this.app.terms.row(id);
        this.send(client, { t: 'snap', id, missing: true, term: row ? this.app.terms.toClient(row) : null });
      }
      return;
    }
    if (client.subs.get(id) !== sub || sub.gen !== gen) return;
    if (sub.overflow) return this.snapshot(client, id, sub);
    this.send(client, { t: 'snap', id, data: r.data, cols: r.cols, rows: r.rows, alive: r.alive, exitCode: r.exitCode });
    for (const f of sub.buf) if (f.seq >= r.seq) client.ws.send(f.frame);
    sub.buf = [];
    sub.bufLen = 0;
    sub.state = 'live';
  }

  // Re-synchronise every subscriber of a terminal (after a restart).
  resync(id) {
    const set = this.subsById.get(id);
    if (!set) return;
    this.attached.delete(id);
    this.ensureAttached(id);
    for (const c of set) {
      const sub = c.subs.get(id);
      if (sub) this.snapshot(c, id, sub);
    }
  }

  dropTerminal(id) {
    const set = this.subsById.get(id);
    if (set) for (const c of [...set]) this.unsubscribe(c, id);
    this.attached.delete(id);
  }

  // ------------------------------------------------------------ broker side
  onBrokerData(id, seq, bytes) {
    const set = this.subsById.get(id);
    if (!set) return;
    let frame = null;
    for (const c of set) {
      const sub = c.subs.get(id);
      if (!sub) continue;
      if (sub.state === 'live') {
        if (c.ws.bufferedAmount > HIGH_WATER) {
          sub.state = 'stale';
          continue;
        }
        frame = frame || dataFrame(id, bytes);
        c.ws.send(frame);
      } else if (sub.state === 'pending') {
        frame = frame || dataFrame(id, bytes);
        sub.buf.push({ seq, frame });
        sub.bufLen += bytes.length;
        if (sub.bufLen > PENDING_CAP) {
          sub.overflow = true;
          sub.buf = [];
          sub.bufLen = 0;
        }
      }
    }
  }

  recoverStale() {
    for (const c of this.clients) {
      if (c.ws.bufferedAmount > LOW_WATER) continue;
      for (const [id, sub] of c.subs) if (sub.state === 'stale') this.snapshot(c, id, sub);
    }
  }

  onBrokerUp() {
    this.attached.clear();
    this.emitAll({ t: 'broker', up: true });
    for (const [id, set] of this.subsById) {
      this.ensureAttached(id);
      for (const c of set) {
        const sub = c.subs.get(id);
        if (sub) this.snapshot(c, id, sub);
      }
    }
  }

  onBrokerDown() {
    this.attached.clear();
    for (const c of this.clients) for (const sub of c.subs.values()) sub.state = 'pending';
    this.emitAll({ t: 'broker', up: false });
  }
}
