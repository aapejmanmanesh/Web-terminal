// WebTerm broker — the only privileged component (runs as root).
//
// It owns every terminal process so terminals survive browser closes, logouts
// and restarts of the (unprivileged) web server. Each terminal runs as its
// owner's Linux account (setpriv drops uid/gid and initialises supplementary
// groups) and is mirrored into a headless xterm so any client can reattach and
// receive an exact snapshot of the screen and scrollback.
//
// The unix socket is 0660 root:webterm — only the web server can talk to it.
// Every request naming a Linux account is validated: never root, never a
// system account, and only members of the webterm-users group (plus the
// dedicated SSH runner account).

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import pty from 'node-pty';
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import { loadConfig } from '../common/config.js';
import { FrameReader, encodeJson, encodeData } from '../common/frame.js';

const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;
const cfg = loadConfig();
const VERSION = 1;
const NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const PARSE_HIGH = 8 * 1024 * 1024;
const PARSE_LOW = 1 * 1024 * 1024;
const FLUSH_MS = 4;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- accounts
function getent(db, key) {
  try {
    return execFileSync('getent', [db, String(key)], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function passwd(name) {
  if (!NAME_RE.test(name)) return null;
  const line = getent('passwd', name);
  if (!line) return null;
  const [n, , uid, gid, , home, shell] = line.split(':');
  return { name: n, uid: Number(uid), gid: Number(gid), home, shell: shell || '/bin/bash' };
}

function groupInfo(name) {
  const line = getent('group', name);
  if (!line) return null;
  const [n, , gid, members] = line.split(':');
  return { name: n, gid: Number(gid), members: members ? members.split(',') : [] };
}

function isGroupMember(user, group) {
  const g = groupInfo(group);
  if (!g) return false;
  return g.members.includes(user.name) || user.gid === g.gid;
}

// Returns the account if the broker may run processes as it, else throws.
function allowedUser(name) {
  const u = passwd(name);
  if (!u) throw new Error(`unknown account ${name}`);
  if (u.uid === 0 || u.name === 'root') throw new Error('refusing to run as root');
  if (u.name === cfg.serviceUser) throw new Error('refusing to run as the service account');
  if (u.name === cfg.sshUser) return u;
  if (u.uid < 1000 || u.uid >= 60000) throw new Error(`account ${name} is a system account`);
  if (!isGroupMember(u, cfg.usersGroup)) throw new Error(`account ${name} is not in ${cfg.usersGroup}`);
  return u;
}

function systemLang() {
  try {
    const m = /^LANG="?([^"\n]+)"?/m.exec(fs.readFileSync('/etc/default/locale', 'utf8'));
    if (m && /utf-?8/i.test(m[1])) return m[1];
  } catch {}
  return 'C.UTF-8';
}
const LANG = systemLang();
const ENV_EXTRA = new Set(['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'WT_ASKPASS_FILE', 'DISPLAY', 'WT_CWD']);

function buildEnv(u, extra = {}, id = '') {
  const env = {
    HOME: u.home,
    USER: u.name,
    LOGNAME: u.name,
    SHELL: u.shell,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'WebTerm',
    LANG,
  };
  if (id) env.WEBTERM_SESSION = id;
  for (const [k, v] of Object.entries(extra || {})) {
    if (ENV_EXTRA.has(k) && typeof v === 'string') env[k] = v;
  }
  return env;
}

function privArgs(u, argv) {
  return ['--reuid', String(u.uid), '--regid', String(u.gid), '--init-groups', '--', cfg.wtExec, ...argv];
}

function checkArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new Error('bad argv');
  }
  if (!argv[0].startsWith('/')) throw new Error('argv[0] must be absolute');
}

// One-time secret files (SSH keys / passwords) for the SSH runner account.
function ensureDir(dir, uid, gid, mode) {
  fs.mkdirSync(dir, { recursive: true });
  fs.chownSync(dir, uid, gid);
  fs.chmodSync(dir, mode);
}

function materialize(u, id, files) {
  const made = {};
  if (!files || !files.length) return made;
  if (u.name !== cfg.sshUser) throw new Error('secret files are only allowed for the SSH runner');
  ensureDir(cfg.sshRunDir, u.uid, u.gid, 0o700);
  for (const f of files) {
    if (!/^[a-z0-9_-]{1,32}$/.test(f.name)) throw new Error('bad file name');
    const ext = f.ext && /^[a-z]{1,5}$/.test(f.ext) ? '.' + f.ext : '';
    const p = path.join(cfg.sshRunDir, `${id}-${f.name}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    const fd = fs.openSync(p, 'wx', 0o600);
    fs.writeSync(fd, Buffer.from(f.content, 'base64'));
    fs.closeSync(fd);
    fs.chownSync(p, u.uid, u.gid);
    made[f.name] = p;
  }
  return made;
}

function substitute(list, files) {
  return list.map((s) => s.replace(/\{file:([a-z0-9_-]+)\}/g, (m, n) => files[n] ?? m));
}

function removeFiles(paths) {
  for (const p of paths) fs.rm(p, { force: true }, () => {});
}

// ---------------------------------------------------------------- sessions
const sessions = new Map();
const conns = new Set();

function broadcast(obj) {
  const buf = encodeJson(obj);
  for (const c of conns) c.send(buf);
}

class Session {
  constructor(msg, u) {
    this.id = msg.id;
    this.user = u.name;
    this.created = Date.now();
    this.alive = true;
    this.exitCode = null;
    this.signal = null;
    this.seq = 0;
    this.pending = [];
    this.flushTimer = null;
    this.parsePending = 0;
    this.paused = false;
    this.attached = new Set();
    this.title = '';
    this.lastOutputAt = 0;
    this.status = { fg: '', lastLine: '' };
    this.statusDirty = true;
    this.cols = clamp(msg.cols, 10, 500, 80);
    this.rows = clamp(msg.rows, 4, 300, 24);
    this.files = [];
    this.startup = null;

    const files = materialize(u, this.id, msg.files);
    this.files = Object.values(files);
    if (this.files.length) {
      this.fileTimer = setTimeout(() => removeFiles(this.files), clamp(msg.fileTtl, 5, 600, 90) * 1000);
    }
    const argv = substitute(msg.argv, files);
    const env = buildEnv(u, Object.fromEntries(Object.entries(msg.env || {}).map(([k, v]) => [k, substitute([String(v)], files)[0]])), this.id);
    env.WT_CWD = msg.cwd || u.home;

    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: clamp(msg.scrollback, 100, 50000, cfg.scrollback),
      allowProposedApi: true,
    });
    this.ser = new SerializeAddon();
    this.term.loadAddon(this.ser);
    this.term.onTitleChange((t) => {
      this.title = String(t).slice(0, 200);
      broadcast({ op: 'title', id: this.id, title: this.title });
    });

    this.pty = pty.spawn(cfg.setpriv, privArgs(u, argv), {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: '/',
      env,
      encoding: null,
    });
    this.pid = this.pty.pid;
    this.pty.onData((d) => this.onData(d));
    this.pty.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal));

    if (msg.startup && typeof msg.startup === 'string' && msg.startup.length) {
      this.startup = { text: msg.startup, quiet: null, deadline: setTimeout(() => this.sendStartup(), 20000) };
    }
  }

  onData(d) {
    const len = d.length;
    this.seq += len;
    this.lastOutputAt = Date.now();
    this.statusDirty = true;
    this.parsePending += len;
    this.term.write(d, () => {
      this.parsePending -= len;
      if (this.paused && this.parsePending < PARSE_LOW && this.alive) {
        this.paused = false;
        this.pty.resume();
      }
    });
    if (this.parsePending > PARSE_HIGH && !this.paused) {
      this.paused = true;
      this.pty.pause();
    }
    if (this.attached.size) {
      this.pending.push(d);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }
    if (this.startup) {
      clearTimeout(this.startup.quiet);
      this.startup.quiet = setTimeout(() => this.sendStartup(), 450);
    }
  }

  sendStartup() {
    if (!this.startup) return;
    const s = this.startup;
    this.startup = null;
    clearTimeout(s.quiet);
    clearTimeout(s.deadline);
    if (this.alive) this.pty.write(s.text);
  }

  // Sends buffered output to attached connections. seq in the frame is the
  // stream offset of the first byte, so the server can line frames up with
  // snapshots.
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending.length) return;
    const bytes = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    this.pending = [];
    const start = this.seq - bytes.length;
    const frame = encodeData(this.id, start, bytes);
    for (const c of this.attached) c.send(frame);
  }

  snapshot(conn, req, scrollback) {
    this.flush();
    const seq = this.seq;
    this.term.write('', () => {
      let data = '';
      try {
        data = this.ser.serialize({ scrollback: clamp(scrollback, 0, 50000, 1000) });
      } catch (e) {
        log('serialize failed', this.id, e.message);
      }
      conn.send(encodeJson({ op: 'res', req, ok: true, id: this.id, seq, data, cols: this.cols, rows: this.rows, ...this.info() }));
    });
  }

  resize(cols, rows) {
    cols = clamp(cols, 10, 500, this.cols);
    rows = clamp(rows, 4, 300, this.rows);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    if (this.alive) {
      try {
        this.pty.resize(cols, rows);
      } catch {}
    }
    broadcast({ op: 'size', id: this.id, cols, rows });
  }

  write(buf) {
    if (!this.alive) return;
    this.pty.write(buf);
  }

  onExit(code, signal) {
    if (this.disposed) return;
    this.flush();
    this.alive = false;
    this.exitCode = code;
    this.signal = signal || null;
    this.endedAt = Date.now();
    if (this.startup) {
      clearTimeout(this.startup.quiet);
      clearTimeout(this.startup.deadline);
      this.startup = null;
    }
    clearTimeout(this.fileTimer);
    removeFiles(this.files);
    broadcast({ op: 'exit', id: this.id, code, signal: this.signal });
  }

  readStatus() {
    let fg = '';
    if (this.alive) {
      try {
        fg = this.pty.process || '';
      } catch {}
    }
    let lastLine = '';
    try {
      const b = this.term.buffer.active;
      const end = b.baseY + b.cursorY;
      for (let i = end; i >= Math.max(0, end - 60); i--) {
        const line = b.getLine(i);
        if (!line) continue;
        const s = line.translateToString(true).trim();
        if (s) {
          lastLine = s.slice(0, 200);
          break;
        }
      }
    } catch {}
    return { fg: path.basename(fg), lastLine, alt: this.term.buffer.active.type === 'alternate' };
  }

  info() {
    return {
      id: this.id,
      user: this.user,
      pid: this.pid,
      alive: this.alive,
      exitCode: this.exitCode,
      signal: this.signal,
      created: this.created,
      endedAt: this.endedAt || null,
      title: this.title,
      cols: this.cols,
      rows: this.rows,
      lastOutputAt: this.lastOutputAt,
      ...this.status,
    };
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.fileTimer);
    if (this.startup) {
      clearTimeout(this.startup.quiet);
      clearTimeout(this.startup.deadline);
    }
    removeFiles(this.files);
    if (this.alive) {
      try {
        this.pty.kill('SIGHUP');
      } catch {}
      const pid = this.pid;
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {}
      }, 3000).unref();
    }
    this.alive = false;
    try {
      this.term.dispose();
    } catch {}
  }
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// Periodic status (foreground process + last output line) for list views.
let statusTick = 0;
setInterval(() => {
  statusTick++;
  for (const s of sessions.values()) {
    // Output marks a session dirty; live sessions are also re-checked every
    // few seconds because a silent command changes the foreground process.
    if (!s.statusDirty && !(s.alive && statusTick % 3 === 0)) continue;
    const st = s.readStatus();
    s.statusDirty = false;
    if (st.fg !== s.status.fg || st.lastLine !== s.status.lastLine || st.alt !== s.status.alt) {
      s.status = st;
      broadcast({ op: 'status', id: s.id, ...st });
    }
  }
}, 1000).unref();

// ---------------------------------------------------------------- exec
function execAs(msg) {
  return new Promise((resolve, reject) => {
    const u = allowedUser(msg.user);
    checkArgv(msg.argv);
    const tmpId = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const files = materialize(u, tmpId, msg.files);
    const argv = substitute(msg.argv, files);
    const env = buildEnv(u, Object.fromEntries(Object.entries(msg.env || {}).map(([k, v]) => [k, substitute([String(v)], files)[0]])));
    env.WT_CWD = msg.cwd || u.home;
    const child = spawnChild(cfg.setpriv, privArgs(u, argv), { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] });
    const limit = 2 * 1024 * 1024;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      if (out.length < limit) out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (err.length < limit) err += d.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), clamp(msg.timeout, 1, 900, 60) * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      removeFiles(Object.values(files));
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      removeFiles(Object.values(files));
      resolve({ code, signal, stdout: out, stderr: err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(msg.stdin ? Buffer.from(msg.stdin, 'utf8') : undefined);
  });
}

// ---------------------------------------------------------------- streaming processes
// Non-PTY processes with piped stdio (used for file access: sftp-server, ssh -s
// sftp, tar). stdout is streamed to the owning connection as data frames under
// the process id; data frames sent to that id are written to stdin. Processes
// die with the connection that started them.
const PROC_ID_RE = /^P[A-Za-z0-9_-]{6,40}$/;
const procs = new Map();

function procStart(conn, msg) {
  if (!PROC_ID_RE.test(msg.id || '')) throw new Error('bad id');
  if (procs.has(msg.id)) throw new Error('id in use');
  checkArgv(msg.argv);
  const u = allowedUser(msg.user);
  const files = materialize(u, msg.id, msg.files);
  const fileList = Object.values(files);
  const argv = substitute(msg.argv, files);
  const env = buildEnv(u, Object.fromEntries(Object.entries(msg.env || {}).map(([k, v]) => [k, substitute([String(v)], files)[0]])));
  env.WT_CWD = msg.cwd || u.home;
  const child = spawnChild(cfg.setpriv, privArgs(u, argv), { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rec = { id: msg.id, child, conn, stderr: '', files: fileList, done: false };
  procs.set(msg.id, rec);
  if (fileList.length) rec.fileTimer = setTimeout(() => removeFiles(fileList), clamp(msg.fileTtl, 5, 600, 90) * 1000);
  child.stdout.on('data', (d) => conn.send(encodeData(msg.id, 0, d)));
  child.stderr.on('data', (d) => {
    rec.stderr = (rec.stderr + d.toString('utf8')).slice(-8192);
  });
  child.stdin.on('error', () => {});
  const finish = (code, signal, error) => {
    if (rec.done) return;
    rec.done = true;
    procs.delete(msg.id);
    clearTimeout(rec.fileTimer);
    clearTimeout(rec.killTimer);
    removeFiles(fileList);
    conn.send(encodeJson({ op: 'procExit', id: msg.id, code, signal: signal || null, stderr: rec.stderr, error: error || null }));
  };
  child.on('error', (e) => finish(null, null, e.message));
  child.on('close', (code, signal) => finish(code, signal));
  return { pid: child.pid };
}

function procKill(rec) {
  if (!rec || rec.done) return;
  try {
    rec.child.kill('SIGTERM');
  } catch {}
  clearTimeout(rec.killTimer);
  rec.killTimer = setTimeout(() => {
    try {
      rec.child.kill('SIGKILL');
    } catch {}
  }, 3000);
  rec.killTimer.unref();
}

function ownProc(conn, id) {
  const rec = procs.get(id);
  return rec && rec.conn === conn ? rec : null;
}

// ---------------------------------------------------------------- accounts (root ops)
function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureUser(msg) {
  const name = String(msg.name || '');
  if (!NAME_RE.test(name)) throw new Error('invalid Linux account name');
  if (['root', cfg.serviceUser, cfg.sshUser].includes(name)) throw new Error('reserved account');
  if (!groupInfo(cfg.usersGroup)) run('groupadd', ['--system', cfg.usersGroup]);
  let u = passwd(name);
  if (!u) {
    if (!msg.create) throw new Error(`account ${name} does not exist`);
    run('useradd', ['--create-home', '--shell', '/bin/bash', '--groups', cfg.usersGroup, name]);
    u = passwd(name);
    if (!u) throw new Error('account creation failed');
    log('created account', name);
  } else {
    if (u.uid < 1000 || u.uid >= 60000) throw new Error(`${name} is a system account`);
    if (!isGroupMember(u, cfg.usersGroup)) run('gpasswd', ['--add', name, cfg.usersGroup]);
  }
  return { name: u.name, uid: u.uid, home: u.home, shell: u.shell };
}

function unlinkUser(msg) {
  const u = passwd(String(msg.name || ''));
  if (!u || u.uid < 1000) return {};
  try {
    run('gpasswd', ['--delete', u.name, cfg.usersGroup]);
  } catch {}
  return {};
}

function listAccounts() {
  const out = [];
  let text = '';
  try {
    text = execFileSync('getent', ['passwd'], { encoding: 'utf8' });
  } catch {}
  for (const line of text.split('\n')) {
    const [n, , uid, , , home, shell] = line.split(':');
    const id = Number(uid);
    if (!n || id < 1000 || id >= 60000 || /nologin|false/.test(shell || '')) continue;
    if (!NAME_RE.test(n) || [cfg.serviceUser, cfg.sshUser].includes(n)) continue;
    out.push({ name: n, uid: id, home, shell });
  }
  return out;
}

// ---------------------------------------------------------------- IDE (code-server)
const ides = new Map();
const IDE_DEFAULTS = JSON.stringify(
  {
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'editor.fontFamily': "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, monospace",
    'terminal.integrated.fontFamily': "'JetBrains Mono', monospace",
    'telemetry.telemetryLevel': 'off',
  },
  null,
  2,
);

async function ideStart(msg) {
  const u = allowedUser(msg.user);
  if (u.name === cfg.sshUser) throw new Error('not allowed');
  const cur = ides.get(u.name);
  if (cur && cur.alive) return { socket: cur.socket, running: true };
  if (!fs.existsSync(cfg.codeServer)) throw new Error('code-server is not installed');
  fs.mkdirSync(cfg.ideRunDir, { recursive: true });
  fs.chmodSync(cfg.ideRunDir, 0o711);
  const svc = groupInfo(cfg.serviceGroup);
  const dir = path.join(cfg.ideRunDir, u.name);
  ensureDir(dir, u.uid, svc ? svc.gid : u.gid, 0o2770);
  const socket = path.join(dir, 'code.sock');
  fs.rmSync(socket, { force: true });
  const args = [
    cfg.codeServer,
    '--socket', socket,
    '--socket-mode', '660',
    '--auth', 'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-workspace-trust',
    '--disable-getting-started-override',
    '--disable-proxy',
  ];
  const env = buildEnv(u, { WT_CWD: u.home });
  // First start only: dark theme and no welcome page. Written as the user
  // (never as root) so symlinks in the home folder cannot redirect the write.
  try {
    execFileSync(
      cfg.setpriv,
      privArgs(u, ['/bin/sh', '-c', 'f="$HOME/.local/share/code-server/User/settings.json"; [ -e "$f" ] || { mkdir -p "${f%/*}" && printf "%s\\n" "$1" > "$f"; }', 'sh', IDE_DEFAULTS]),
      { cwd: '/', env, stdio: 'ignore', timeout: 5000 },
    );
  } catch {}
  const child = spawnChild(cfg.setpriv, privArgs(u, args), { cwd: '/', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { child, socket, alive: true, log: [] };
  const keep = (d) => {
    rec.log.push(d.toString('utf8'));
    if (rec.log.length > 50) rec.log.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => {
    rec.alive = false;
    if (ides.get(u.name) === rec) ides.delete(u.name);
    log('code-server exited for', u.name, code);
    broadcast({ op: 'ide', user: u.name, running: false });
  });
  ides.set(u.name, rec);
  for (let i = 0; i < 300; i++) {
    if (!rec.alive) throw new Error('code-server failed to start: ' + rec.log.join('').slice(-400));
    if (fs.existsSync(socket)) {
      broadcast({ op: 'ide', user: u.name, running: true });
      return { socket, running: true };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGTERM');
  throw new Error('code-server did not start in time');
}

function ideStop(msg) {
  const rec = ides.get(String(msg.user));
  if (rec && rec.alive) rec.child.kill('SIGTERM');
  return {};
}

// ---------------------------------------------------------------- protocol
async function handle(conn, msg) {
  const { op } = msg;
  switch (op) {
    case 'hello':
      return { version: VERSION, sessions: [...sessions.values()].map((s) => s.info()), ides: [...ides.entries()].filter(([, r]) => r.alive).map(([n, r]) => ({ user: n, socket: r.socket })) };
    case 'spawn': {
      if (!ID_RE.test(msg.id || '')) throw new Error('bad id');
      checkArgv(msg.argv);
      const u = allowedUser(msg.user);
      const old = sessions.get(msg.id);
      if (old) {
        if (old.user !== u.name) throw new Error('id in use');
        old.dispose();
        sessions.delete(msg.id);
        broadcast({ op: 'gone', id: msg.id });
      }
      const s = new Session(msg, u);
      sessions.set(s.id, s);
      log('spawn', s.id, 'as', u.name, 'pid', s.pid);
      return s.info();
    }
    case 'attach': {
      const s = sessions.get(msg.id);
      if (!s) throw new Error('no such session');
      s.attached.add(conn);
      return {};
    }
    case 'detach': {
      const s = sessions.get(msg.id);
      if (s) s.attached.delete(conn);
      return {};
    }
    case 'snapshot': {
      const s = sessions.get(msg.id);
      if (!s) throw new Error('no such session');
      s.snapshot(conn, msg.req, msg.scrollback);
      return undefined; // replied asynchronously
    }
    case 'resize': {
      const s = sessions.get(msg.id);
      if (s) s.resize(msg.cols, msg.rows);
      return {};
    }
    case 'kill': {
      const s = sessions.get(msg.id);
      if (s) {
        s.dispose();
        sessions.delete(msg.id);
        broadcast({ op: 'gone', id: msg.id });
        log('kill', msg.id);
      }
      return {};
    }
    case 'signal': {
      const s = sessions.get(msg.id);
      if (s && s.alive && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(msg.signal)) {
        try {
          s.pty.kill(msg.signal);
        } catch {}
      }
      return {};
    }
    case 'list':
      return { sessions: [...sessions.values()].map((s) => s.info()) };
    case 'exec':
      return await execAs(msg);
    case 'procStart':
      return procStart(conn, msg);
    case 'procEnd': {
      const rec = ownProc(conn, msg.id);
      if (rec) rec.child.stdin.end();
      return {};
    }
    case 'procKill':
      procKill(ownProc(conn, msg.id));
      return {};
    case 'procPause': {
      const rec = ownProc(conn, msg.id);
      if (rec) rec.child.stdout.pause();
      return {};
    }
    case 'procResume': {
      const rec = ownProc(conn, msg.id);
      if (rec) rec.child.stdout.resume();
      return {};
    }
    case 'ensureUser':
      return ensureUser(msg);
    case 'unlinkUser':
      return unlinkUser(msg);
    case 'accounts':
      return { accounts: listAccounts() };
    case 'account': {
      const u = passwd(String(msg.name || ''));
      return u ? { account: { name: u.name, uid: u.uid, home: u.home, shell: u.shell, linked: isGroupMember(u, cfg.usersGroup) } } : { account: null };
    }
    case 'ideStart':
      return await ideStart(msg);
    case 'ideStop':
      return ideStop(msg);
    case 'ideStatus':
      return { running: [...ides.entries()].filter(([, r]) => r.alive).map(([n, r]) => ({ user: n, socket: r.socket })) };
    default:
      throw new Error('unknown op ' + op);
  }
}

function onConnection(sock) {
  const conn = {
    sock,
    send(buf) {
      if (!sock.destroyed) sock.write(buf);
    },
  };
  conns.add(conn);
  const reader = new FrameReader(
    (msg) => {
      const req = msg.req;
      Promise.resolve()
        .then(() => handle(conn, msg))
        .then((res) => {
          if (res !== undefined && req !== undefined) conn.send(encodeJson({ op: 'res', req, ok: true, ...res }));
        })
        .catch((e) => {
          if (req !== undefined) conn.send(encodeJson({ op: 'res', req, ok: false, error: String(e && e.message ? e.message : e) }));
        });
    },
    (id, _seq, bytes) => {
      const s = sessions.get(id);
      if (s) return s.write(bytes);
      const p = ownProc(conn, id);
      if (p && !p.done && p.child.stdin.writable) p.child.stdin.write(bytes);
    },
  );
  sock.on('data', (chunk) => {
    try {
      reader.push(chunk);
    } catch (e) {
      log('protocol error', e.message);
      sock.destroy();
    }
  });
  const drop = () => {
    conns.delete(conn);
    for (const s of sessions.values()) s.attached.delete(conn);
    for (const p of procs.values()) if (p.conn === conn) procKill(p);
  };
  sock.on('close', drop);
  sock.on('error', drop);
}

// ---------------------------------------------------------------- main
export function main() {
  if (process.getuid && process.getuid() !== 0) {
    console.error('webterm-broker must run as root');
    process.exit(1);
  }
  const sockDir = path.dirname(cfg.brokerSocket);
  const svc = groupInfo(cfg.serviceGroup);
  if (!svc) {
    console.error(`group ${cfg.serviceGroup} is missing`);
    process.exit(1);
  }
  ensureDir(sockDir, 0, svc.gid, 0o750);
  fs.rmSync(cfg.brokerSocket, { force: true });
  const ssh = passwd(cfg.sshUser);
  if (ssh) {
    ensureDir(cfg.sshHome, ssh.uid, ssh.gid, 0o700);
    ensureDir(path.join(cfg.sshHome, '.ssh'), ssh.uid, ssh.gid, 0o700);
    ensureDir(cfg.sshRunDir, ssh.uid, ssh.gid, 0o700);
    for (const f of fs.readdirSync(cfg.sshRunDir)) fs.rmSync(path.join(cfg.sshRunDir, f), { force: true });
  }
  const server = net.createServer(onConnection);
  server.listen(cfg.brokerSocket, () => {
    fs.chownSync(cfg.brokerSocket, 0, svc.gid);
    fs.chmodSync(cfg.brokerSocket, 0o660);
    log(`broker listening on ${cfg.brokerSocket}`);
  });
  const stop = () => {
    log('broker stopping');
    for (const s of sessions.values()) s.dispose();
    for (const r of ides.values()) if (r.alive) r.child.kill('SIGTERM');
    for (const p of procs.values()) procKill(p);
    server.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('uncaughtException', (e) => log('uncaught', e && e.stack ? e.stack : e));
  process.on('unhandledRejection', (e) => log('unhandled', e && e.stack ? e.stack : e));
}
