// Terminal sessions: database rows + live state mirrored from the broker.
import { newId } from './security.js';
import { bad, forbidden, notFound, HttpError } from './http.js';
import { sshArgv, credFiles, remoteTmuxCommand, remoteCwdCommand, remoteScriptCommand } from './ssh.js';

const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'login', 'setpriv', 'wt-exec']);

export class Terminals {
  constructor(app) {
    this.app = app;
    this.live = new Map();
    this.accounts = new Map();
  }

  row(id) {
    return this.app.store.get('SELECT * FROM terminals WHERE id = ?', id);
  }

  owned(user, id) {
    const r = this.row(id);
    if (!r || r.user_id !== user.id) throw notFound('Terminal not found');
    return r;
  }

  toClient(r) {
    const l = this.live.get(r.id);
    const spec = JSON.parse(r.spec);
    const host = r.host_id ? this.app.store.get('SELECT name FROM hosts WHERE id = ?', r.host_id) : null;
    const alive = !!(l && l.alive);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      hostId: r.host_id,
      hostName: host ? host.name : null,
      presetId: r.preset_id,
      color: r.color,
      notify: !!r.notify,
      remoteTmux: !!spec.remoteTmux,
      task: spec.task || null,
      created: r.created_at,
      alive,
      exitCode: l ? l.exitCode : r.exit_code,
      endedAt: l ? l.endedAt : r.ended_at,
      lost: !l && !!r.lost,
      fg: l ? l.fg : '',
      idle: alive ? SHELLS.has(l.fg || 'bash') : false,
      lastLine: l ? l.lastLine : '',
      alt: l ? !!l.alt : false,
      title: l ? l.title : '',
      cols: l ? l.cols : 80,
      rows: l ? l.rows : 24,
      lastOutputAt: l ? l.lastOutputAt : 0,
    };
  }

  list(user) {
    return this.app.store.all('SELECT * FROM terminals WHERE user_id = ? ORDER BY created_at', user.id).map((r) => this.toClient(r));
  }

  push(r) {
    this.app.hub.emitUser(r.user_id, { t: 'term', term: this.toClient(r) });
  }

  // ------------------------------------------------------------ broker sync
  onBrokerUp(hello) {
    this.live.clear();
    const seen = new Set();
    for (const s of hello.sessions) {
      seen.add(s.id);
      this.live.set(s.id, { ...s });
    }
    for (const r of this.app.store.all('SELECT * FROM terminals')) {
      if (!seen.has(r.id) && !r.lost) {
        this.app.store.run('UPDATE terminals SET lost = 1, ended_at = COALESCE(ended_at, ?) WHERE id = ?', Date.now(), r.id);
        this.push(this.row(r.id));
      }
    }
    const rows = new Set(this.app.store.all('SELECT id FROM terminals').map((r) => r.id));
    for (const id of seen) {
      if (!rows.has(id)) {
        this.app.log('killing orphan session', id);
        this.app.broker.send({ op: 'kill', id });
        this.live.delete(id);
      }
    }
  }

  onBrokerDown() {
    // Keep last known state; sessions will be reconciled on reconnect.
  }

  onEvent(ev) {
    const l = this.live.get(ev.id);
    switch (ev.op) {
      case 'status':
        if (!l) return;
        {
          const wasBusy = l.alive && !SHELLS.has(l.fg || 'bash');
          Object.assign(l, { fg: ev.fg, lastLine: ev.lastLine, alt: ev.alt });
          const r = this.row(ev.id);
          if (!r) return;
          this.app.hub.emitUser(r.user_id, { t: 'status', id: ev.id, fg: ev.fg, lastLine: ev.lastLine, alt: !!ev.alt, idle: SHELLS.has(ev.fg || 'bash') });
          if (r.notify && r.kind === 'local' && wasBusy && SHELLS.has(ev.fg || 'bash')) {
            this.app.hub.emitUser(r.user_id, { t: 'notify', id: r.id, title: 'Command finished', body: this.displayName(r) });
          }
        }
        return;
      case 'title':
        if (!l) return;
        l.title = ev.title;
        {
          const r = this.row(ev.id);
          if (r) this.app.hub.emitUser(r.user_id, { t: 'title', id: ev.id, title: ev.title });
        }
        return;
      case 'size':
        if (l) Object.assign(l, { cols: ev.cols, rows: ev.rows });
        this.app.hub.toSubscribers(ev.id, { t: 'size', id: ev.id, cols: ev.cols, rows: ev.rows });
        return;
      case 'exit': {
        if (!l) return;
        Object.assign(l, { alive: false, exitCode: ev.code, endedAt: Date.now() });
        const r = this.row(ev.id);
        if (!r) return;
        this.app.store.run('UPDATE terminals SET ended_at = ?, exit_code = ? WHERE id = ?', Date.now(), ev.code, ev.id);
        this.push(this.row(ev.id));
        this.app.onTerminalExit(r, ev.code);
        if (r.notify) {
          this.app.hub.emitUser(r.user_id, { t: 'notify', id: r.id, title: ev.code === 0 ? 'Session finished' : `Session exited (code ${ev.code})`, body: this.displayName(r) });
        }
        return;
      }
      case 'gone':
        this.live.delete(ev.id);
        return;
      default:
    }
  }

  displayName(r) {
    const l = this.live.get(r.id);
    return r.name || (l && l.title) || (r.kind === 'ssh' ? 'SSH session' : 'Terminal');
  }

  // ------------------------------------------------------------ accounts
  async account(name) {
    const c = this.accounts.get(name);
    if (c && Date.now() - c.at < 60_000) return c.acc;
    const r = await this.app.broker.call({ op: 'account', name });
    if (!r.account) throw new HttpError(500, `Linux account ${name} is missing`);
    this.accounts.set(name, { acc: r.account, at: Date.now() });
    return r.account;
  }

  accessibleHost(user, hostId) {
    const host = this.app.store.get('SELECT * FROM hosts WHERE id = ?', hostId);
    if (!host) throw notFound('Host not found');
    if (user.role !== 'admin') {
      const ok = host.cred_id && this.app.store.get('SELECT 1 AS ok FROM cred_access WHERE cred_id = ? AND user_id = ?', host.cred_id, user.id);
      if (!ok) throw forbidden('You do not have access to this host');
    }
    const cred = host.cred_id ? this.app.store.get('SELECT * FROM creds WHERE id = ?', host.cred_id) : null;
    return { host, cred };
  }

  // Turns a stored spec into a broker spawn request.
  async spawnRequest(user, id, spec, { first }) {
    const cfg = this.app.cfg;
    if (spec.kind === 'local') {
      if (!user.allow_local || !user.linux_user) throw forbidden('Local shells are disabled for your account');
      const acc = await this.account(user.linux_user);
      const argv = spec.script ? ['/bin/bash', '-lc', spec.script] : [acc.shell && acc.shell.startsWith('/') ? acc.shell : '/bin/bash', '-l'];
      return {
        user: user.linux_user,
        argv,
        cwd: spec.cwd || '~',
        startup: first && spec.startup ? spec.startup : null,
      };
    }
    if (spec.kind === 'ssh') {
      const { host, cred } = this.accessibleHost(user, spec.hostId);
      let remoteCommand = null;
      if (spec.script) remoteCommand = remoteScriptCommand(spec.script);
      else if (spec.remoteTmux) remoteCommand = remoteTmuxCommand(spec.tmuxName, spec.cwd);
      else if (spec.cwd && spec.cwd !== '~') remoteCommand = remoteCwdCommand(spec.cwd);
      const argv = sshArgv(this.app, host, cred, { tty: true, remoteCommand });
      const { files, env } = credFiles(this.app, cred);
      this.app.store.run('UPDATE creds SET last_used_at = ?, last_used_by = ? WHERE id = ?', Date.now(), user.username, cred.id);
      // Startup commands run once; a remote tmux reattach must not repeat them.
      const startup = first && spec.startup ? spec.startup : null;
      return { user: cfg.sshUser, argv, env, files, cwd: cfg.sshHome, startup };
    }
    if (spec.kind === 'task') {
      // Server-defined one-off commands (e.g. installing a key on a host).
      const { host, cred } = this.accessibleHost(user, spec.hostId);
      const pub = cred && cred.public_key;
      if (!pub) throw bad('Only key credentials can be installed');
      const known = `${cfg.sshHome}/known_hosts`;
      const argv = [
        cfg.sshCopyId, '-f', '-i', '{file:pub}',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`,
        '-o', 'PubkeyAuthentication=no', '-o', 'ForwardAgent=no', '-o', 'IdentityAgent=none',
        '-p', String(host.port), `${host.username}@${host.address}`,
      ];
      return {
        user: cfg.sshUser,
        argv,
        files: [{ name: 'pub', ext: 'pub', content: Buffer.from(pub.trim() + '\n').toString('base64') }],
        cwd: cfg.sshHome,
      };
    }
    throw bad('Unknown terminal kind');
  }

  async create(user, { kind, hostId = null, presetId = null, name = null, color = null, notify = false, cwd = null, startup = null, remoteTmux = false, script = null, task = null, cols = 100, rows = 30 }) {
    const count = this.app.store.get('SELECT COUNT(*) AS n FROM terminals WHERE user_id = ?', user.id).n;
    const cap = Math.min(user.max_terms || 40, this.app.cfg.maxTerminalsPerUser);
    if (count >= cap) throw bad(`Terminal limit reached (${cap}). Close some sessions first.`);
    const id = newId(16);
    const spec = { kind, cwd: cwd || null, startup: startup || null, remoteTmux: !!remoteTmux, script: script || null, task: task || null };
    if (kind === 'ssh' || kind === 'task') spec.hostId = hostId;
    if (remoteTmux) spec.tmuxName = 'wt-' + id.slice(0, 10).toLowerCase();
    const req = await this.spawnRequest(user, id, spec, { first: true });
    const info = await this.app.broker.call({ op: 'spawn', id, cols, rows, scrollback: this.app.cfg.scrollback, ...req });
    this.live.set(id, { ...info });
    this.app.store.run(
      'INSERT INTO terminals (id, user_id, name, kind, host_id, preset_id, spec, color, notify, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      user.id,
      name,
      kind === 'task' ? 'ssh' : kind,
      hostId,
      presetId,
      JSON.stringify(spec),
      color,
      notify ? 1 : 0,
      Date.now(),
    );
    const r = this.row(id);
    this.push(r);
    return this.toClient(r);
  }

  async restart(user, id, { cols, rows } = {}) {
    const r = this.owned(user, id);
    const spec = JSON.parse(r.spec);
    const l = this.live.get(id);
    const req = await this.spawnRequest(user, id, spec, { first: !spec.remoteTmux });
    const info = await this.app.broker.call({
      op: 'spawn',
      id,
      cols: cols || (l && l.cols) || 100,
      rows: rows || (l && l.rows) || 30,
      scrollback: this.app.cfg.scrollback,
      ...req,
    });
    this.live.set(id, { ...info });
    this.app.store.run('UPDATE terminals SET ended_at = NULL, exit_code = NULL, lost = 0 WHERE id = ?', id);
    this.app.hub.resync(id);
    const row = this.row(id);
    this.push(row);
    return this.toClient(row);
  }

  async kill(user, id) {
    const r = this.owned(user, id);
    await this.destroy(r);
  }

  async destroy(r) {
    try {
      await this.app.broker.call({ op: 'kill', id: r.id });
    } catch (e) {
      if (!/not available/.test(e.message)) this.app.log('kill failed', r.id, e.message);
    }
    this.live.delete(r.id);
    this.app.store.run('DELETE FROM terminals WHERE id = ?', r.id);
    this.app.hub.dropTerminal(r.id);
    this.app.hub.emitUser(r.user_id, { t: 'term-del', id: r.id });
  }

  update(user, id, body) {
    const r = this.owned(user, id);
    if (body.name !== undefined) {
      const name = body.name === null ? null : String(body.name).trim().slice(0, 80) || null;
      this.app.store.run('UPDATE terminals SET name = ? WHERE id = ?', name, id);
    }
    if (body.color !== undefined) this.app.store.run('UPDATE terminals SET color = ? WHERE id = ?', validColor(body.color), id);
    if (body.notify !== undefined) this.app.store.run('UPDATE terminals SET notify = ? WHERE id = ?', body.notify ? 1 : 0, id);
    const row = this.row(r.id);
    this.push(row);
    return this.toClient(row);
  }
}

export const COLORS = ['green', 'amber', 'blue', 'purple', 'red', 'gray'];
export function validColor(c) {
  if (c === null) return null;
  if (!COLORS.includes(c)) throw bad('Invalid color');
  return c;
}
