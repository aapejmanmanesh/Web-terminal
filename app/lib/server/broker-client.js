// Connection from the web server to the privileged broker, with automatic
// reconnect. Emits: 'up', 'down', 'event' (json), 'data' (id, seq, bytes).
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameReader, encodeJson, encodeData } from '../common/frame.js';

export class BrokerClient extends EventEmitter {
  constructor(socketPath, log) {
    super();
    this.path = socketPath;
    this.log = log;
    this.sock = null;
    this.up = false;
    this.req = 0;
    this.waits = new Map();
    this.backoff = 250;
    this.connect();
  }

  connect() {
    const sock = net.connect(this.path);
    this.sock = sock;
    const reader = new FrameReader(
      (m) => {
        if (m.op === 'res' && this.waits.has(m.req)) {
          const w = this.waits.get(m.req);
          this.waits.delete(m.req);
          clearTimeout(w.timer);
          if (m.ok) w.resolve(m);
          else w.reject(new Error(m.error || 'broker error'));
        } else if (m.op !== 'res') {
          this.emit('event', m);
        }
      },
      (id, seq, bytes) => this.emit('data', id, seq, bytes),
    );
    sock.on('connect', async () => {
      this.backoff = 250;
      try {
        const hello = await this.call({ op: 'hello' }, 10000, true);
        this.up = true;
        this.emit('up', hello);
      } catch (e) {
        this.log('broker hello failed', e.message);
        sock.destroy();
      }
    });
    sock.on('data', (c) => {
      try {
        reader.push(c);
      } catch (e) {
        this.log('broker protocol error', e.message);
        sock.destroy();
      }
    });
    const onClose = () => {
      if (this.sock !== sock) return;
      const wasUp = this.up;
      this.up = false;
      this.sock = null;
      for (const w of this.waits.values()) {
        clearTimeout(w.timer);
        w.reject(new Error('broker connection lost'));
      }
      this.waits.clear();
      if (wasUp) this.emit('down');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
    sock.on('close', onClose);
    sock.on('error', () => {});
  }

  call(msg, timeout = 30000, force = false) {
    return new Promise((resolve, reject) => {
      if (!this.sock || (!this.up && !force)) return reject(new Error('Terminal service is not available'));
      const req = ++this.req;
      const timer = setTimeout(() => {
        this.waits.delete(req);
        reject(new Error('broker timeout'));
      }, timeout);
      this.waits.set(req, { resolve, reject, timer });
      this.sock.write(encodeJson({ ...msg, req }));
    });
  }

  send(msg) {
    if (this.sock && this.up) this.sock.write(encodeJson(msg));
  }

  write(id, bytes) {
    if (this.sock && this.up) this.sock.write(encodeData(id, 0, bytes));
  }
}
