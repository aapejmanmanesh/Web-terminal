// Streaming processes run by the broker (sftp-server, ssh -s sftp, tar …).
// A Proc is a small duplex handle: setSink() receives stdout, write() feeds
// stdin, and wait() resolves once with { code, signal, stderr, error }.
import { EventEmitter } from 'node:events';
import { newId } from './security.js';

export class Proc extends EventEmitter {
  constructor(procs, id) {
    super();
    this.procs = procs;
    this.id = id;
    this.exited = null;
    this.paused = false;
    this.sink = null;
    this.early = [];
  }
  // Sets the stdout consumer; output that arrived earlier is replayed first.
  setSink(fn) {
    this.sink = fn;
    const early = this.early;
    this.early = null;
    for (const b of early) fn(b);
  }
  write(buf) {
    if (!this.exited) this.procs.app.broker.write(this.id, buf);
  }
  end() {
    if (!this.exited) this.procs.app.broker.send({ op: 'procEnd', id: this.id });
  }
  kill() {
    if (!this.exited) this.procs.app.broker.send({ op: 'procKill', id: this.id });
  }
  pause() {
    if (this.paused || this.exited) return;
    this.paused = true;
    this.procs.app.broker.send({ op: 'procPause', id: this.id });
  }
  resume() {
    if (!this.paused || this.exited) return;
    this.paused = false;
    this.procs.app.broker.send({ op: 'procResume', id: this.id });
  }
  // Resolves with the exit record once the process has ended.
  wait() {
    if (this.exited) return Promise.resolve(this.exited);
    return new Promise((resolve) => this.once('exit', resolve));
  }
}

export class Procs {
  constructor(app) {
    this.app = app;
    this.map = new Map();
  }

  has(id) {
    return this.map.has(id);
  }

  // req: { user, argv, env?, files?, cwd? } as for broker spawn.
  async start(req) {
    const id = 'P' + newId(16);
    const p = new Proc(this, id);
    this.map.set(id, p);
    try {
      await this.app.broker.call({ op: 'procStart', id, user: req.user, argv: req.argv, env: req.env, files: req.files, cwd: req.cwd });
    } catch (e) {
      this.map.delete(id);
      throw e;
    }
    return p;
  }

  onData(id, bytes) {
    const p = this.map.get(id);
    if (!p) return;
    if (p.sink) p.sink(bytes);
    else p.early.push(bytes);
  }

  onExit(ev) {
    const p = this.map.get(ev.id);
    if (!p) return;
    this.map.delete(ev.id);
    p.exited = { code: ev.code, signal: ev.signal, stderr: ev.stderr || '', error: ev.error || null };
    p.emit('exit', p.exited);
  }

  onBrokerDown() {
    for (const [id, p] of this.map) {
      this.map.delete(id);
      p.exited = { code: null, signal: null, stderr: '', error: 'Terminal service connection lost' };
      p.emit('exit', p.exited);
    }
  }
}
