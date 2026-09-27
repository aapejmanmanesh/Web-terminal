// Machine status (ping) and Wake-on-LAN.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { bad } from './http.js';

export const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
export const HOST_RE = /^(?!-)[A-Za-z0-9._:-]{1,253}$/;
const HISTORY = 24;

export class Systems {
  constructor(app) {
    this.app = app;
    this.state = new Map();
    this.timers = new Map();
    this.emitTimer = null;
    this.pingBroken = false;
  }

  start() {
    for (const s of this.app.store.all('SELECT * FROM systems')) this.schedule(s, 500);
  }

  schedule(s, delay) {
    clearTimeout(this.timers.get(s.id));
    this.timers.set(
      s.id,
      setTimeout(() => this.check(s.id), delay ?? s.interval * 1000),
    );
  }

  unschedule(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.state.delete(id);
  }

  async check(id) {
    const s = this.app.store.get('SELECT * FROM systems WHERE id = ?', id);
    if (!s) return this.unschedule(id);
    const res = await this.probe(s.address);
    const st = this.state.get(id) || { up: null, since: Date.now(), rtt: null, history: [], checkedAt: 0, wakeAt: 0 };
    const now = Date.now();
    if (st.up !== res.up) st.since = now;
    // A machine that answers is awake, whether or not it was down before.
    if (res.up && st.wakeAt) st.wakeAt = 0;
    st.up = res.up;
    st.rtt = res.rtt;
    st.checkedAt = now;
    st.history.push(res.up ? res.rtt ?? 0 : null);
    if (st.history.length > HISTORY) st.history.shift();
    if (st.wakeAt && now - st.wakeAt > 5 * 60_000) st.wakeAt = 0;
    this.state.set(id, st);
    this.emitSoon();
    // Check more often while waiting for a machine to wake.
    this.schedule(s, st.wakeAt ? 5000 : s.interval * 1000);
  }

  probe(address) {
    if (!HOST_RE.test(address)) return Promise.resolve({ up: false, rtt: null });
    return this.pingBroken ? this.tcpProbe(address) : this.ping(address);
  }

  ping(address) {
    return new Promise((resolve) => {
      const p = spawn(this.app.cfg.ping, ['-n', '-c', '1', '-W', '2', address], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => p.kill('SIGKILL'), 5000);
      p.on('error', () => {
        clearTimeout(t);
        this.pingBroken = true;
        resolve(this.tcpProbe(address));
      });
      p.on('close', (code) => {
        clearTimeout(t);
        if (/Operation not permitted|permission denied|socket:/i.test(err) && code !== 0 && !/time=/.test(out)) {
          this.app.log('ping unavailable, falling back to TCP probes:', err.trim());
          this.pingBroken = true;
          resolve(this.tcpProbe(address));
          return;
        }
        const m = /time[=<]([\d.]+)\s*ms/.exec(out);
        resolve({ up: code === 0, rtt: m ? Number(m[1]) : null });
      });
    });
  }

  // Fallback when ICMP is not permitted: a machine that answers on any common
  // port (or actively refuses the connection) is up.
  tcpProbe(address) {
    const ports = [22, 80, 443, 445, 3389];
    const t0 = process.hrtime.bigint();
    return new Promise((resolve) => {
      let pending = ports.length;
      let done = false;
      const finish = (up) => {
        if (done) return;
        done = true;
        resolve({ up, rtt: up ? Number(process.hrtime.bigint() - t0) / 1e6 : null });
      };
      for (const port of ports) {
        const sock = net.connect({ host: address, port, timeout: 2000 });
        sock.on('connect', () => {
          sock.destroy();
          finish(true);
        });
        sock.on('error', (e) => {
          sock.destroy();
          if (e.code === 'ECONNREFUSED') finish(true);
          else if (--pending === 0) finish(false);
        });
        sock.on('timeout', () => {
          sock.destroy();
          if (--pending === 0) finish(false);
        });
      }
    });
  }

  // `admin` adds the RDP account name (only administrators edit systems).
  toClient(s, admin = false) {
    const st = this.state.get(s.id);
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      mac: s.mac,
      broadcast: s.broadcast,
      interval: s.interval,
      up: st ? st.up : null,
      since: st ? st.since : null,
      rtt: st ? st.rtt : null,
      history: st ? st.history : [],
      checkedAt: st ? st.checkedAt : null,
      waking: !!(st && st.wakeAt),
      wakeAt: st ? st.wakeAt : 0,
      vnc: s.vnc_port ? { port: s.vnc_port, access: s.vnc_access || 'admins', hasPassword: !!s.vnc_secret } : null,
      rdp: s.rdp_port
        ? { port: s.rdp_port, access: s.vnc_access || 'admins', hasPassword: !!s.rdp_secret, hasUser: !!s.rdp_user, ...(admin ? { user: s.rdp_user || '', domain: s.rdp_domain || '' } : {}) }
        : null,
    };
  }

  list(admin = false) {
    return this.app.store.all('SELECT * FROM systems ORDER BY name COLLATE NOCASE').map((s) => this.toClient(s, admin));
  }

  emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.app.hub.emitAll({ t: 'sys', systems: this.list() });
    }, 300);
  }

  async wake(id) {
    const s = this.app.store.get('SELECT * FROM systems WHERE id = ?', id);
    if (!s) throw bad('Unknown system');
    if (!s.mac || !MAC_RE.test(s.mac)) throw bad('This system has no MAC address');
    const mac = Buffer.from(s.mac.replace(/[:-]/g, ''), 'hex');
    const packet = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let i = 0; i < 16; i++) mac.copy(packet, 6 + i * 6);
    const targets = new Set(['255.255.255.255']);
    if (s.broadcast) targets.add(s.broadcast);
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(s.address)) targets.add(s.address.replace(/\.\d+$/, '.255'));
    await new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', (e) => {
        sock.close();
        reject(e);
      });
      sock.bind(0, () => {
        sock.setBroadcast(true);
        let left = targets.size * 3 * 2;
        const sent = () => {
          if (--left === 0) {
            sock.close();
            resolve();
          }
        };
        for (let round = 0; round < 3; round++) {
          setTimeout(() => {
            for (const t of targets) {
              const [host, port] = t.includes(':') ? t.split(':') : [t, null];
              for (const p of port ? [Number(port), Number(port)] : [9, 7]) sock.send(packet, p, host, sent);
            }
          }, round * 150);
        }
      });
    });
    const st = this.state.get(s.id) || { up: null, since: Date.now(), rtt: null, history: [], checkedAt: 0 };
    st.wakeAt = Date.now();
    this.state.set(s.id, st);
    this.schedule(s, 3000);
    this.emitSoon();
    return { targets: [...targets] };
  }
}
