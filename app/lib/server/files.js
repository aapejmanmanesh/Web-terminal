// File browser backend.
//
// Every file operation runs with the same identity as the user's terminals:
//   - "local": an sftp-server process running as the user's Linux account
//     (spawned by the broker through setpriv), so Linux permissions apply;
//   - "host:<id>": `ssh -s … sftp` run as the SSH runner account with the
//     shared credential, exactly like an SSH terminal to that host.
// Bulk operations (delete, copy, move) run as background jobs whose progress
// is pushed to the user's browsers over the WebSocket.
import path from 'node:path';
import crypto from 'node:crypto';
import { newId } from './security.js';
import { HttpError, bad, forbidden, notFound, oneOf } from './http.js';
import { Sftp, SftpError, FX, OPEN, isDir, isFile, isLink, S_IFMT, S_IFDIR, S_IFREG, S_IFLNK } from './sftp.js';
import { sshArgv, credFiles, remoteShCommand } from './ssh.js';

const P = path.posix;
const IDLE_MS = 3 * 60_000;
const MAX_LIST = 20_000;
const MAX_ITEMS = 1000;
const MAX_WALK = 200_000;
const READ_WINDOW = 16;
const WRITE_WINDOW = 16;
const EDIT_MAX = 2 * 1024 * 1024;
const MAX_JOBS = 6;
const MAX_ARCHIVES = 4; // folder downloads running at once, per user
const JOB_KEEP_MS = 10 * 60_000;
const UPLOAD_STALL_MS = 120_000;

// ------------------------------------------------------------ helpers
export function httpError(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof SftpError) {
    switch (e.code) {
      case FX.NO_SUCH_FILE:
        return new HttpError(404, e.message);
      case FX.PERMISSION_DENIED:
        return new HttpError(403, e.message);
      case FX.CONNECTION_LOST:
      case FX.NO_CONNECTION:
        return new HttpError(502, e.message);
      default:
        return new HttpError(400, e.message);
    }
  }
  return e;
}

function checkPath(p, name = 'Path') {
  if (typeof p !== 'string' || !p.length) throw bad(`${name} is required`);
  if (p.length > 4096 || p.includes('\0')) throw bad(`${name} is invalid`);
  return p;
}

export function checkName(n) {
  if (typeof n !== 'string' || !n.length) throw bad('Name is required');
  if (Buffer.byteLength(n) > 255 || n.includes('/') || n.includes('\0') || n === '.' || n === '..') throw bad('Name is invalid');
  return n;
}

// Path for something being created or renamed: its last segment, as sent,
// must be a plain name (".." or "a/.." are not silently normalised away).
function newPath(raw, home, what = 'Path') {
  checkPath(raw, what);
  checkName(P.basename(raw.replace(/\/+$/, '')));
  return absPath(raw, home);
}

// Expands "~", makes relative paths relative to home, and normalises.
export function absPath(p, home) {
  if (p === undefined || p === null || p === '' || p === '~') return home;
  checkPath(p);
  if (p.startsWith('~/')) p = home + p.slice(1);
  else if (!p.startsWith('/')) p = home + '/' + p;
  const n = P.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

function permString(mode) {
  const m = mode || 0;
  const t = (m & S_IFMT) === S_IFDIR ? 'd' : (m & S_IFMT) === S_IFLNK ? 'l' : '-';
  const r = (bit, c) => (m & bit ? c : '-');
  const x = (bit, special, lower, upper) => (m & special ? (m & bit ? lower : upper) : m & bit ? 'x' : '-');
  return (
    t +
    r(0o400, 'r') + r(0o200, 'w') + x(0o100, 0o4000, 's', 'S') +
    r(0o040, 'r') + r(0o020, 'w') + x(0o010, 0o2000, 's', 'S') +
    r(0o004, 'r') + r(0o002, 'w') + x(0o001, 0o1000, 't', 'T')
  );
}

function entryInfo(e) {
  const a = e.attrs || {};
  const fmt = (a.mode || 0) & S_IFMT;
  const link = fmt === S_IFLNK;
  const type = fmt === S_IFDIR ? 'dir' : fmt === S_IFREG ? 'file' : link ? 'link' : 'other';
  const m = /^\S+\s+\d+\s+(\S+)\s+(\S+)/.exec(e.longname || '');
  return {
    name: e.name,
    type,
    link,
    size: a.size ?? 0,
    mtime: (a.mtime ?? 0) * 1000,
    mode: (a.mode ?? 0) & 0o7777,
    perms: permString(a.mode),
    owner: m ? m[1] : String(a.uid ?? ''),
    group: m ? m[2] : String(a.gid ?? ''),
  };
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      await fn(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function splitExt(name) {
  const m = /(\.tar\.(?:gz|xz|bz2|zst))$/i.exec(name);
  if (m && m.index > 0) return [name.slice(0, m.index), m[1]];
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

async function uniqueName(s, dir, name, style, taken = new Set()) {
  const [stem, ext] = splitExt(name);
  for (let i = 1; i < 1000; i++) {
    const label = style === 'copy' ? (i === 1 ? ' (copy)' : ` (copy ${i})`) : ` (${i})`;
    const cand = stem + label + ext;
    if (taken.has(cand)) continue;
    if (!(await s.exists(P.join(dir, cand)))) {
      taken.add(cand);
      return P.join(dir, cand);
    }
  }
  throw bad('Could not find a free name');
}

export function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_') || 'download';
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// Splits argument groups into batches whose command line stays well below
// the kernel's single-argument limit (the remote command is one argument).
function batches(groups, maxBytes = 96 * 1024) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const g of groups) {
    const n = g.reduce((a, s) => a + Buffer.byteLength(s) * 2 + 4, 0);
    if (cur.length && size + n > maxBytes) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(...g);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Reads `size` bytes from an open handle with pipelined requests and hands
// each chunk to sink() in order. sink may return false to stop early.
async function readPipelined(s, h, size, sink) {
  const max = s.limits.maxRead;
  const q = [];
  let next = 0;
  let pos = 0;
  const req = (off, len) => {
    const p = s.read(h, off, len);
    p.catch(() => {});
    return { off, len, p };
  };
  const issue = () => {
    while (q.length < READ_WINDOW && next < size) {
      const len = Math.min(max, size - next);
      q.push(req(next, len));
      next += len;
    }
  };
  issue();
  while (q.length) {
    const it = q.shift();
    const buf = await it.p;
    if (!buf || !buf.length) break;
    if (buf.length > it.len) throw new SftpError(FX.BAD_MESSAGE, 'Unexpected read size');
    pos += buf.length;
    if (buf.length < it.len) q.unshift(req(it.off + buf.length, it.len - buf.length));
    if ((await sink(buf)) === false) break;
    issue();
  }
  return pos;
}

const DELETE_SCRIPT = 'for p in "$@"; do if rm -rf -- "$p"; then echo ok; else echo fail; fi; done';
const TRANSFER_SCRIPT = [
  'mode=$1; shift',
  'while [ $# -ge 2 ]; do',
  '  s=$1; d=$2; shift 2',
  '  if [ -d "$s" ] && [ ! -L "$s" ] && [ -d "$d" ] && [ ! -L "$d" ]; then',
  '    if cp -a -- "$s"/. "$d"/; then',
  '      if [ "$mode" = move ]; then rm -rf -- "$s"; fi',
  '      echo ok',
  '    else echo fail; fi',
  '    continue',
  '  fi',
  '  if [ -e "$d" ] || [ -L "$d" ]; then rm -rf -- "$d" || { echo fail; continue; }; fi',
  '  if [ "$mode" = move ]; then mv -f -- "$s" "$d"; else cp -a -- "$s" "$d"; fi && echo ok || echo fail',
  'done',
].join('\n');
const TAR_SCRIPT = 'cd -- "$1" || exit 3; shift; tar -cf - -- "$@" | gzip -1';

// ------------------------------------------------------------ jobs
class Job {
  constructor(files, user, kind, title) {
    this.files = files;
    this.id = newId(10);
    this.userId = user.id;
    this.kind = kind;
    this.title = title;
    this.state = 'running';
    this.total = 0;
    this.done = 0;
    this.bytesTotal = 0;
    this.bytesDone = 0;
    this.current = '';
    this.error = null;
    this.errors = [];
    this.affects = [];
    this.started = Date.now();
    this.ended = null;
    this.cancelled = false;
    this.procs = new Set();
    this.lastEmit = 0;
    this.emitTimer = null;
  }
  pub() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      state: this.state,
      total: this.total,
      done: this.done,
      bytesTotal: this.bytesTotal,
      bytesDone: this.bytesDone,
      current: this.current,
      error: this.error,
      errors: this.errors.slice(0, 20),
      errorCount: this.errors.length,
      affects: this.affects,
      started: this.started,
      ended: this.ended,
    };
  }
  emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 300) {
      if (!this.emitTimer) this.emitTimer = setTimeout(() => this.emit(true), 300 - (now - this.lastEmit));
      return;
    }
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.lastEmit = now;
    this.files.app.hub.emitUser(this.userId, { t: 'job', job: this.pub() });
  }
  fail(msg) {
    this.errors.push(String(msg).slice(0, 300));
  }
}

// ------------------------------------------------------------ service
export class Files {
  constructor(app) {
    this.app = app;
    this.conns = new Map();
    this.jobs = new Map();
    this.archives = new Map(); // userId -> folder downloads running
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  // Locations the user may browse.
  targets(user) {
    const out = [];
    if (user.allow_local && user.linux_user) out.push({ id: 'local', kind: 'local', name: this.app.cfg.hostname, user: user.linux_user });
    const { store } = this.app;
    const hosts =
      user.role === 'admin'
        ? store.all('SELECT * FROM hosts ORDER BY name COLLATE NOCASE')
        : store.all('SELECT h.* FROM hosts h JOIN cred_access a ON a.cred_id = h.cred_id WHERE a.user_id = ? ORDER BY h.name COLLATE NOCASE', user.id);
    for (const h of hosts) {
      if (!h.cred_id) continue;
      out.push({ id: `host:${h.id}`, kind: 'ssh', name: h.name, user: h.username, address: h.address });
    }
    return out;
  }

  resolve(user, target) {
    if (target === 'local') {
      if (!user.allow_local || !user.linux_user) throw forbidden('Local files are not available for your account');
      return { key: `${user.id}|local|${user.linux_user}`, id: 'local', kind: 'local', label: this.app.cfg.hostname, user };
    }
    const m = /^host:(\d{1,12})$/.exec(String(target || ''));
    if (!m) throw bad('Unknown location');
    const { host, cred } = this.app.terms.accessibleHost(user, Number(m[1]));
    if (!cred) throw bad(`Host "${host.name}" has no credential assigned`);
    const credTag = crypto.createHash('sha256').update(String(cred.secret)).digest('hex').slice(0, 12);
    return {
      key: `${user.id}|host:${host.id}|${host.username}@${host.address}:${host.port}|${cred.id}:${credTag}`,
      id: `host:${host.id}`,
      kind: 'ssh',
      host,
      cred,
      label: host.name,
      user,
    };
  }

  async procRequest(t, argvLocal, remoteCommand, subsystem = null) {
    const cfg = this.app.cfg;
    if (t.kind === 'local') return { user: t.user.linux_user, argv: argvLocal };
    const argv = sshArgv(this.app, t.host, t.cred, { tty: false, batch: true, remoteCommand, subsystem });
    const { files, env } = credFiles(this.app, t.cred);
    this.app.store.run('UPDATE creds SET last_used_at = ?, last_used_by = ? WHERE id = ?', Date.now(), t.user.username, t.cred.id);
    return { user: cfg.sshUser, argv, env, files, cwd: cfg.sshHome };
  }

  async conn(user, target) {
    const t = this.resolve(user, target);
    let c = this.conns.get(t.key);
    if (c && c.sftp && c.sftp.closed) {
      this.conns.delete(t.key);
      c = null;
    }
    if (!c) {
      const rec = { key: t.key, t, refs: 0, lastUse: Date.now(), sftp: null, home: '' };
      rec.ready = (async () => {
        const proc = await this.app.procs.start(await this.procRequest(t, [this.app.cfg.sftpServer], null, 'sftp'));
        const sftp = new Sftp(proc);
        sftp.onClose = () => {
          if (this.conns.get(t.key) === rec) this.conns.delete(t.key);
        };
        await sftp.init();
        rec.sftp = sftp;
        rec.home = await sftp.realpath('.');
        return rec;
      })();
      rec.ready.catch(() => {
        if (this.conns.get(t.key) === rec) this.conns.delete(t.key);
      });
      this.conns.set(t.key, rec);
      c = rec;
    }
    try {
      await c.ready;
    } catch (e) {
      throw httpError(e);
    }
    c.t = t;
    c.lastUse = Date.now();
    return c;
  }

  async use(user, target, fn) {
    const c = await this.conn(user, target);
    c.refs++;
    try {
      return await fn(c);
    } catch (e) {
      throw httpError(e);
    } finally {
      c.refs--;
      c.lastUse = Date.now();
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, c] of this.conns) {
      if (c.sftp && c.refs <= 0 && now - c.lastUse > IDLE_MS) {
        this.conns.delete(key);
        c.sftp.close();
      }
    }
  }

  // Closes a user's cached connections (account disabled, deleted or changed).
  dropUser(userId) {
    for (const [key, c] of this.conns) {
      if (key.startsWith(`${userId}|`)) {
        this.conns.delete(key);
        if (c.sftp) c.sftp.close();
      }
    }
    for (const j of this.jobs.values()) {
      if (j.userId === userId && j.state === 'running') {
        j.cancelled = true;
        for (const p of j.procs) p.kill();
      }
    }
  }

  closeAll() {
    for (const c of this.conns.values()) if (c.sftp) c.sftp.close();
    this.conns.clear();
  }

  // Runs `sh -c script sh args…` on the target and feeds stdout lines to onLine.
  async runScript(job, t, script, args, onLine) {
    const proc = await this.app.procs.start(await this.procRequest(t, ['/bin/sh', '-c', script, 'sh', ...args], remoteShCommand(script, args)));
    if (job) job.procs.add(proc);
    let rest = '';
    proc.setSink((d) => {
      const text = rest + d.toString('utf8');
      const lines = text.split('\n');
      rest = lines.pop();
      if (onLine) for (const l of lines) onLine(l);
    });
    const ex = await proc.wait();
    if (job) job.procs.delete(proc);
    if (rest && onLine) onLine(rest);
    return ex;
  }

  // ------------------------------------------------------------ simple ops
  list(user, target, p) {
    return this.use(user, target, async (c) => {
      const s = c.sftp;
      const dir = absPath(p, c.home);
      const st = await s.stat(dir);
      if (!isDir(st)) throw bad('Not a folder');
      const { entries, truncated } = await s.readdirAll(dir, MAX_LIST);
      const out = entries.map(entryInfo);
      const links = out.filter((e) => e.link).slice(0, 2000);
      await pool(links, 16, async (e) => {
        try {
          const a = await s.stat(P.join(dir, e.name));
          e.type = isDir(a) ? 'dir' : isFile(a) ? 'file' : 'other';
          if (isFile(a)) e.size = a.size ?? e.size;
        } catch {
          e.broken = true;
        }
      });
      return { target: c.t.id, path: dir, home: c.home, entries: out, truncated };
    });
  }

  stat(user, target, p) {
    return this.use(user, target, async (c) => {
      const abs = absPath(p, c.home);
      const a = await c.sftp.stat(abs);
      return { path: abs, home: c.home, type: isDir(a) ? 'dir' : isFile(a) ? 'file' : 'other', size: a.size ?? 0, mtime: (a.mtime ?? 0) * 1000, mode: (a.mode ?? 0) & 0o7777 };
    });
  }

  mkdir(user, target, p) {
    return this.use(user, target, async (c) => {
      const abs = newPath(p, c.home);
      if (await c.sftp.exists(abs)) throw new HttpError(409, 'A file or folder with that name already exists');
      await c.sftp.mkdir(abs);
      return { path: abs };
    });
  }

  createFile(user, target, p) {
    return this.use(user, target, async (c) => {
      const abs = newPath(p, c.home);
      if (await c.sftp.exists(abs)) throw new HttpError(409, 'A file or folder with that name already exists');
      const h = await c.sftp.open(abs, OPEN.WRITE | OPEN.CREAT | OPEN.EXCL, {});
      await c.sftp.closeHandle(h);
      return { path: abs };
    });
  }

  rename(user, target, from, to) {
    return this.use(user, target, async (c) => {
      const a = absPath(checkPath(from, 'Source'), c.home);
      const b = newPath(to, c.home, 'Destination');
      if (a === '/' || a === c.home) throw bad('This folder cannot be renamed here');
      if (a === b) return { path: b };
      if (b.startsWith(a + '/')) throw bad('Cannot move a folder into itself');
      if (await c.sftp.exists(b)) throw new HttpError(409, 'A file or folder with that name already exists');
      await c.sftp.rename(a, b);
      return { path: b };
    });
  }

  chmod(user, target, p, mode) {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw bad('Invalid permissions');
    return this.use(user, target, async (c) => {
      const abs = absPath(checkPath(p), c.home);
      await c.sftp.setstat(abs, { mode });
      const a = await c.sftp.lstat(abs);
      return { path: abs, mode: (a.mode ?? 0) & 0o7777, perms: permString(a.mode) };
    });
  }

  // Text content for the built-in editor.
  read(user, target, p) {
    return this.use(user, target, async (c) => {
      const s = c.sftp;
      const abs = absPath(checkPath(p), c.home);
      const st = await s.stat(abs);
      if (isDir(st)) throw bad('This is a folder');
      if (!isFile(st)) throw bad('Not a regular file');
      if ((st.size || 0) > EDIT_MAX) throw new HttpError(413, 'File is too large to edit here (limit 2 MB) — download it instead.');
      const h = await s.open(abs, OPEN.READ);
      const parts = [];
      try {
        await readPipelined(s, h, st.size || 0, (b) => {
          parts.push(b);
        });
      } finally {
        s.closeHandle(h).catch(() => {});
      }
      const buf = Buffer.concat(parts);
      let binary = buf.subarray(0, 8192).includes(0);
      let content = '';
      if (!binary) {
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch {
          binary = true;
        }
      }
      return { path: abs, size: buf.length, mtime: (st.mtime ?? 0) * 1000, mode: (st.mode ?? 0) & 0o7777, binary, content: binary ? '' : content };
    });
  }

  async mkdirp(s, dir) {
    const st = await s.exists(dir);
    if (st) {
      if (isDir(st) || (isLink(st) && isDir(await s.stat(dir).catch(() => null)))) return;
      throw new HttpError(409, `${dir} is not a folder`);
    }
    const parent = P.dirname(dir);
    if (parent !== dir) await this.mkdirp(s, parent);
    try {
      await s.mkdir(dir);
    } catch (e) {
      const again = await s.exists(dir);
      if (!again || !isDir(again)) throw e;
    }
  }

  // ------------------------------------------------------------ upload
  // Streams the raw request body into <dir>/.<name>.wtpart-* and renames it
  // into place when complete, so readers never see half-written files.
  async upload(ctx) {
    const { user, req, query } = ctx;
    const target = query.get('target');
    const conflict = oneOf(query.get('conflict') || 'fail', ['fail', 'overwrite', 'rename'], 'conflict');
    const mkdirs = query.get('mkdirs') === '1';
    const ifMtime = query.get('ifMtime') ? Number(query.get('ifMtime')) : null;
    const rawPath = checkPath(query.get('path'));
    return this.use(user, target, async (c) => {
      const s = c.sftp;
      let dest = newPath(rawPath, c.home);
      const dir = P.dirname(dest);
      if (mkdirs) await this.mkdirp(s, dir);
      else {
        const d = await s.stat(dir).catch(() => null);
        if (!d || !isDir(d)) throw notFound('Destination folder not found');
      }
      const cur = await s.exists(dest);
      let mode = 0o644;
      if (cur) {
        const target = isLink(cur) ? await s.stat(dest).catch(() => null) : cur;
        if (target && isDir(target)) throw new HttpError(409, 'A folder with this name already exists', { exists: true, folder: true });
        if (conflict === 'fail') throw new HttpError(409, 'A file with this name already exists', { exists: true });
        if (conflict === 'rename') dest = await uniqueName(s, dir, P.basename(dest), 'upload');
        else {
          if (ifMtime && target && (target.mtime ?? 0) * 1000 !== ifMtime) {
            throw new HttpError(409, 'The file was changed on disk after you opened it', { changed: true });
          }
          if (isLink(cur)) dest = P.resolve(dir, await s.readlink(dest));
          if (target) mode = (target.mode ?? 0o644) & 0o7777;
        }
      }
      const tmp = P.join(P.dirname(dest), `.${P.basename(dest).slice(0, 80)}.wtpart-${newId(6)}`);
      const h = await s.open(tmp, OPEN.WRITE | OPEN.CREAT | OPEN.EXCL, { mode: 0o600 });
      let open = true;
      let ok = false;
      try {
        const size = await this.pipeRequest(req, s, h);
        await s.closeHandle(h);
        open = false;
        await s.setstat(tmp, { mode });
        await s.rename(tmp, dest, conflict === 'overwrite');
        ok = true;
        this.app.audit({ req, userId: user.id, username: user.username }, 'files.upload', `${c.t.label}:${dest} (${size} bytes)`);
        const st = await s.stat(dest).catch(() => null);
        return { path: dest, name: P.basename(dest), size, mtime: st && st.mtime != null ? st.mtime * 1000 : null };
      } finally {
        if (!ok) {
          if (open) await s.closeHandle(h).catch(() => {});
          await s.remove(tmp).catch(() => {});
        }
      }
    });
  }

  pipeRequest(req, s, h) {
    return new Promise((resolve, reject) => {
      const max = s.limits.maxWrite;
      let offset = 0;
      let inflight = 0;
      let ended = false;
      let done = false;
      let stall = null;
      const expected = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(stall);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('close', onClose);
        req.off('error', onErr);
        if (err) {
          req.resume();
          reject(err);
        } else resolve(offset);
      };
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          finish(new HttpError(408, 'Upload stalled'));
          req.destroy();
        }, UPLOAD_STALL_MS);
      };
      const check = () => {
        if (!ended || inflight) return;
        if (expected !== null && Number.isFinite(expected) && expected !== offset) finish(new HttpError(400, 'Upload incomplete'));
        else finish();
      };
      const onData = (chunk) => {
        arm();
        for (let i = 0; i < chunk.length; i += max) {
          const part = chunk.subarray(i, i + max);
          const off = offset;
          offset += part.length;
          inflight++;
          s.write(h, off, part).then(
            () => {
              inflight--;
              if (!done && req.isPaused() && inflight < WRITE_WINDOW / 2) req.resume();
              check();
            },
            (e) => {
              inflight--;
              finish(e);
            },
          );
        }
        if (inflight >= WRITE_WINDOW) req.pause();
      };
      const onEnd = () => {
        ended = true;
        check();
      };
      const onClose = () => {
        if (!req.complete) finish(new HttpError(400, 'Upload aborted'));
      };
      const onErr = (e) => finish(e);
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('close', onClose);
      req.on('error', onErr);
      arm();
    });
  }

  // ------------------------------------------------------------ download
  async download(ctx) {
    const { user, query, req, res } = ctx;
    const target = query.get('target');
    const paths = query.getAll('path');
    if (!paths.length) throw bad('Path is required');
    if (paths.length > MAX_ITEMS) throw bad('Too many items');
    paths.forEach((p) => checkPath(p));
    return this.use(user, target, async (c) => {
      const s = c.sftp;
      const abs = [...new Set(paths.map((p) => absPath(p, c.home)))];
      if (abs.length === 1) {
        const st = await s.stat(abs[0]);
        if (isFile(st)) {
          this.app.audit({ req, userId: user.id, username: user.username }, 'files.download', `${c.t.label}:${abs[0]}`);
          return this.sendFile(req, res, s, abs[0], st);
        }
        if (!isDir(st)) throw bad('Not a regular file or folder');
      }
      const dir = P.dirname(abs[0]);
      if (abs.some((p) => p === '/' || P.dirname(p) !== dir)) throw bad('Items must be in the same folder');
      const names = abs.map((p) => P.basename(p));
      for (const n of names) {
        if (!(await s.exists(P.join(dir, n)))) throw notFound(`${n} not found`);
      }
      const base = abs.length === 1 ? names[0] : P.basename(dir) || 'files';
      this.app.audit({ req, userId: user.id, username: user.username }, 'files.download', `${c.t.label}:${dir} [${names.join(', ').slice(0, 300)}] as archive`);
      const running = this.archives.get(user.id) || 0;
      if (running >= MAX_ARCHIVES) throw new HttpError(429, 'Too many folder downloads are running — wait for one to finish.');
      this.archives.set(user.id, running + 1);
      try {
        return await this.sendArchive(req, res, c.t, dir, names, base);
      } finally {
        const n = (this.archives.get(user.id) || 1) - 1;
        if (n > 0) this.archives.set(user.id, n);
        else this.archives.delete(user.id);
      }
    });
  }

  async sendFile(req, res, s, p, st) {
    const size = st.size || 0;
    const h = await s.open(p, OPEN.READ);
    let aborted = false;
    res.on('close', () => {
      if (!res.writableFinished) aborted = true;
    });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': disposition(P.basename(p)),
      'Cache-Control': 'no-store',
    });
    try {
      const sent = await readPipelined(s, h, size, async (buf) => {
        if (aborted) return false;
        if (!res.write(buf)) {
          await new Promise((r) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              r();
            };
            res.on('drain', done);
            res.on('close', done);
          });
        }
        return !aborted;
      });
      if (aborted) return;
      if (sent !== size) res.destroy();
      else res.end();
    } catch (e) {
      res.destroy();
      if (!aborted) this.app.log('download failed', p, e.message);
    } finally {
      s.closeHandle(h).catch(() => {});
    }
  }

  async sendArchive(req, res, t, dir, names, base) {
    const proc = await this.app.procs.start(await this.procRequest(t, ['/bin/sh', '-c', TAR_SCRIPT, 'sh', dir, ...names], remoteShCommand(TAR_SCRIPT, [dir, ...names])));
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': disposition(`${base}.tar.gz`),
      'Cache-Control': 'no-store',
    });
    let aborted = false;
    res.on('drain', () => proc.resume());
    res.on('close', () => {
      if (!res.writableFinished) {
        aborted = true;
        proc.kill();
      }
    });
    proc.setSink((d) => {
      if (aborted) return;
      if (!res.write(d)) proc.pause();
    });
    const ex = await proc.wait();
    if (aborted) return;
    if (ex.code === 0) res.end();
    else {
      this.app.log('archive failed', dir, ex.code, (ex.stderr || ex.error || '').slice(-300));
      res.destroy();
    }
  }

  // ------------------------------------------------------------ jobs
  listJobs(user) {
    return [...this.jobs.values()].filter((j) => j.userId === user.id).map((j) => j.pub());
  }

  cancelJob(user, id) {
    const j = this.jobs.get(id);
    if (!j || j.userId !== user.id) throw notFound('Job not found');
    if (j.state === 'running') {
      j.cancelled = true;
      for (const p of j.procs) p.kill();
    } else {
      this.jobs.delete(id);
    }
  }

  startJob(user, kind, title, fn) {
    const running = [...this.jobs.values()].filter((j) => j.userId === user.id && j.state === 'running').length;
    if (running >= MAX_JOBS) throw new HttpError(429, 'Too many file operations are running — wait for some to finish.');
    const job = new Job(this, user, kind, title);
    this.jobs.set(job.id, job);
    job.emit(true);
    (async () => {
      try {
        await fn(job);
        job.state = job.cancelled ? 'cancelled' : job.errors.length ? 'error' : 'done';
        if (job.state === 'error' && !job.error) job.error = job.errors.length === 1 ? job.errors[0] : `${job.errors.length} items failed`;
      } catch (e) {
        const he = httpError(e);
        job.state = job.cancelled ? 'cancelled' : 'error';
        job.error = he && he.message ? he.message : String(e);
        if (!(he instanceof HttpError)) this.app.log('file job failed', e && e.stack ? e.stack : e);
      }
      job.ended = Date.now();
      job.current = '';
      job.emit(true);
      setTimeout(() => {
        if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
      }, JOB_KEEP_MS).unref();
    })();
    return job.pub();
  }

  async remove(ctx) {
    const { user, body } = ctx;
    const paths = body.paths;
    if (!Array.isArray(paths) || !paths.length) throw bad('Nothing to delete');
    if (paths.length > MAX_ITEMS) throw bad('Too many items');
    const c = await this.conn(user, body.target);
    const abs = [...new Set(paths.map((p) => absPath(checkPath(p), c.home)))];
    for (const p of abs) if (p === '/' || p === c.home) throw bad(`Refusing to delete ${p}`);
    const t = c.t;
    const title = abs.length === 1 ? `Delete ${P.basename(abs[0])}` : `Delete ${abs.length} items`;
    this.app.audit({ req: ctx.req, userId: user.id, username: user.username }, 'files.delete', `${t.label}: ${abs.join(', ').slice(0, 400)}`);
    return this.startJob(user, 'delete', title, async (job) => {
      job.total = abs.length;
      job.affects = [...new Set(abs.map((p) => P.dirname(p)))].map((dir) => ({ target: t.id, dir }));
      let reason = '';
      for (const args of batches(abs.map((p) => [p]))) {
        if (job.cancelled) break;
        let i = abs.indexOf(args[0]);
        const ex = await this.runScript(job, t, DELETE_SCRIPT, args, (line) => {
          if (line !== 'ok') job.fail(`Could not delete ${abs[i]}`);
          job.done++;
          job.current = abs[i] ? P.basename(abs[i]) : '';
          i++;
          job.emit();
        });
        if (ex.code !== 0 && !job.cancelled) throw new HttpError(502, lastLine(ex.stderr) || 'Delete failed');
        reason = lastLine(ex.stderr) || reason;
      }
      if (job.errors.length) job.error = job.errors.length === 1 ? reason.replace(/^rm: /, '') || job.errors[0] : `${job.errors.length} items could not be deleted`;
    });
  }

  async transfer(ctx) {
    const { user, body } = ctx;
    const mode = oneOf(body.mode, ['copy', 'move'], 'mode');
    const conflict = oneOf(body.conflict || 'rename', ['overwrite', 'rename', 'skip'], 'conflict');
    const from = body.from || {};
    const to = body.to || {};
    if (!Array.isArray(from.paths) || !from.paths.length) throw bad('Nothing to transfer');
    if (from.paths.length > MAX_ITEMS) throw bad('Too many items');
    const src = await this.conn(user, from.target);
    const dst = await this.conn(user, to.target);
    src.refs++;
    dst.refs++;
    let plan;
    try {
      plan = await this.planTransfer(src, dst, from.paths, to.dir, mode, conflict);
    } catch (e) {
      src.refs--;
      dst.refs--;
      throw httpError(e);
    }
    const { items, dstDir, skipped } = plan;
    if (!items.length) {
      src.refs--;
      dst.refs--;
      return { job: null, skipped };
    }
    const same = src.key === dst.key;
    const verb = mode === 'copy' ? 'Copy' : 'Move';
    const title = `${verb} ${items.length === 1 ? P.basename(items[0].src) : `${items.length} items`} → ${dst.t.label}:${dstDir}`;
    this.app.audit({ req: ctx.req, userId: user.id, username: user.username }, `files.${mode}`, `${src.t.label}:${items.map((i) => i.src).join(', ').slice(0, 300)} -> ${dst.t.label}:${dstDir}`);
    let job;
    try {
      job = this.startJob(user, mode, title, async (j) => {
        try {
          j.total = items.length;
          j.affects = [{ target: dst.t.id, dir: dstDir }];
          if (mode === 'move') for (const d of new Set(items.map((i) => P.dirname(i.src)))) j.affects.push({ target: src.t.id, dir: d });
          if (same) await this.sameTargetTransfer(j, src.t, items, mode);
          else await this.crossTransfer(j, src, dst, items, mode);
        } finally {
          src.refs--;
          dst.refs--;
        }
      });
    } catch (e) {
      src.refs--;
      dst.refs--;
      throw e;
    }
    return { job, skipped };
  }

  async planTransfer(src, dst, paths, dir, mode, conflict) {
    const same = src.key === dst.key;
    const dstDir = absPath(checkPath(dir || '~', 'Destination'), dst.home);
    const dstat = await dst.sftp.stat(dstDir);
    if (!isDir(dstat)) throw bad('Destination is not a folder');
    const items = [];
    const skipped = [];
    const taken = new Set();
    for (const raw of [...new Set(paths.map((p) => absPath(checkPath(p), src.home)))]) {
      if (raw === '/') throw bad('Cannot transfer the root folder');
      await src.sftp.lstat(raw);
      const name = P.basename(raw);
      if (same && (dstDir === raw || dstDir.startsWith(raw + '/'))) throw bad(`Cannot ${mode} "${name}" into itself`);
      let dest = P.join(dstDir, name);
      let overwrite = false;
      if (same && dest === raw) {
        if (mode === 'move') {
          skipped.push(name);
          continue;
        }
        dest = await uniqueName(dst.sftp, dstDir, name, 'copy', taken);
      } else if (taken.has(name) || (await dst.sftp.exists(dest))) {
        if (conflict === 'skip') {
          skipped.push(name);
          continue;
        }
        if (conflict === 'rename') dest = await uniqueName(dst.sftp, dstDir, name, 'copy', taken);
        else overwrite = true;
      }
      taken.add(P.basename(dest));
      items.push({ src: raw, dst: dest, overwrite });
    }
    return { items, dstDir, skipped };
  }

  async sameTargetTransfer(job, t, items, mode) {
    const groups = items.map((i) => [i.src, i.dst]);
    let idx = 0;
    let reason = '';
    for (const args of batches(groups)) {
      if (job.cancelled) break;
      const ex = await this.runScript(job, t, TRANSFER_SCRIPT, [mode, ...args], (line) => {
        const it = items[idx++];
        if (line !== 'ok' && it) job.fail(`Could not ${mode} ${it.src}`);
        job.done++;
        job.current = it ? P.basename(it.src) : '';
        job.emit();
      });
      if (ex.code !== 0 && !job.cancelled) throw new HttpError(502, lastLine(ex.stderr) || `${mode} failed`);
      reason = lastLine(ex.stderr) || reason;
    }
    if (job.errors.length === 1 && reason) job.error = reason.replace(/^(cp|mv|rm): /, '');
  }

  async crossTransfer(job, src, dst, items, mode) {
    const ss = src.sftp;
    const ds = dst.sftp;
    // Pre-scan so progress can be shown in bytes.
    const plan = [];
    for (let i = 0; i < items.length; i++) {
      if (job.cancelled) return;
      job.current = `Scanning ${P.basename(items[i].src)}`;
      job.emit();
      await this.walk(ss, items[i], i, plan, job);
    }
    job.bytesTotal = plan.reduce((a, e) => a + (e.type === 'file' ? e.size : 0), 0);
    job.emit();
    const failed = new Set();
    const remaining = new Array(items.length).fill(0);
    for (const e of plan) remaining[e.item]++;
    const finishEntry = (e) => {
      if (--remaining[e.item] === 0) {
        job.done++;
        job.emit();
      }
    };
    for (const e of plan) {
      if (job.cancelled) break;
      if (failed.has(e.item)) {
        finishEntry(e);
        continue;
      }
      job.current = P.basename(e.src);
      try {
        if (e.type === 'dir') await this.ensureDir(dst, e.dst);
        else if (e.type === 'link') {
          const target = await ss.readlink(e.src);
          await this.clearPath(dst, e.dst);
          await ds.symlink(target, e.dst);
        } else if (e.type === 'file') await this.copyFile(job, ss, dst, e);
      } catch (err) {
        if (job.cancelled) break;
        failed.add(e.item);
        const he = httpError(err);
        job.fail(`${e.src}: ${he.message || err}`);
      }
      finishEntry(e);
    }
    if (job.cancelled || mode !== 'move') return;
    const done = items.filter((_, i) => !failed.has(i)).map((i) => i.src);
    if (!done.length) return;
    job.current = 'Removing originals';
    job.emit();
    for (const args of batches(done.map((p) => [p]))) {
      const ex = await this.runScript(job, src.t, DELETE_SCRIPT, args, (line) => {
        if (line !== 'ok') job.fail('Copied, but could not remove an original');
      });
      if (ex.code !== 0) job.fail(lastLine(ex.stderr) || 'Could not remove originals');
    }
  }

  async walk(s, item, index, plan, job) {
    const stack = [{ src: item.src, dst: item.dst, attrs: await s.lstat(item.src) }];
    while (stack.length) {
      if (job.cancelled) return;
      const n = stack.pop();
      const a = n.attrs || {};
      const fmt = (a.mode || 0) & S_IFMT;
      if (fmt === S_IFLNK) plan.push({ type: 'link', src: n.src, dst: n.dst, item: index });
      else if (fmt === S_IFDIR) {
        plan.push({ type: 'dir', src: n.src, dst: n.dst, item: index });
        const { entries } = await s.readdirAll(n.src, MAX_WALK);
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          stack.push({ src: P.join(n.src, e.name), dst: P.join(n.dst, e.name), attrs: e.attrs });
        }
      } else if (fmt === S_IFREG) {
        plan.push({ type: 'file', src: n.src, dst: n.dst, item: index, size: a.size || 0, mode: (a.mode || 0o644) & 0o7777, atime: a.atime, mtime: a.mtime });
      } else job.fail(`Skipped special file ${n.src}`);
      if (plan.length > MAX_WALK) throw bad('Too many files for the browser — use a terminal (e.g. rsync) for this transfer.');
    }
  }

  // Removes whatever is at p (file, link or whole folder) on the target.
  async clearPath(c, p) {
    const cur = await c.sftp.exists(p);
    if (!cur) return;
    if (isDir(cur)) {
      const ex = await this.runScript(null, c.t, DELETE_SCRIPT, [p]);
      if (ex.code !== 0) throw new HttpError(502, lastLine(ex.stderr) || `Could not replace ${p}`);
    } else await c.sftp.remove(p);
  }

  async ensureDir(c, p) {
    const cur = await c.sftp.exists(p);
    if (cur && isDir(cur)) return;
    if (cur) await c.sftp.remove(p);
    await c.sftp.mkdir(p);
  }

  async copyFile(job, ss, dst, e) {
    const ds = dst.sftp;
    const rh = await ss.open(e.src, OPEN.READ);
    let wh = null;
    try {
      const cur = await ds.exists(e.dst);
      if (cur && isDir(cur)) await this.clearPath(dst, e.dst);
      wh = await ds.open(e.dst, OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC, { mode: 0o600 });
      let off = 0;
      let werr = null;
      const writes = new Set();
      await readPipelined(ss, rh, e.size, async (buf) => {
        if (job.cancelled || werr) return false;
        const p = ds.write(wh, off, buf).then(
          () => {
            writes.delete(p);
            job.bytesDone += buf.length;
            job.emit();
          },
          (err) => {
            writes.delete(p);
            werr = werr || err;
          },
        );
        writes.add(p);
        off += buf.length;
        while (writes.size >= WRITE_WINDOW && !werr) await Promise.race(writes);
        return !werr;
      });
      await Promise.all(writes);
      if (werr) throw werr;
      if (job.cancelled) throw new Error('Cancelled');
      const h = wh;
      wh = null;
      await ds.closeHandle(h);
      const attrs = { mode: e.mode };
      if (e.mtime != null) Object.assign(attrs, { atime: e.atime ?? e.mtime, mtime: e.mtime });
      await ds.setstat(e.dst, attrs).catch(() => {});
    } catch (err) {
      if (wh) await ds.closeHandle(wh).catch(() => {});
      await ds.remove(e.dst).catch(() => {});
      throw err;
    } finally {
      ss.closeHandle(rh).catch(() => {});
    }
  }
}

function lastLine(text) {
  return (
    String(text || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop() || ''
  ).slice(0, 200);
}

// ------------------------------------------------------------ routes
export function fileRoutes(r, app) {
  const f = app.files;
  r.get('/api/files/targets', (ctx) => ({ targets: f.targets(ctx.user) }));
  r.get('/api/files/list', (ctx) => f.list(ctx.user, ctx.query.get('target'), ctx.query.get('path')));
  r.get('/api/files/stat', (ctx) => f.stat(ctx.user, ctx.query.get('target'), ctx.query.get('path')));
  r.get('/api/files/read', (ctx) => f.read(ctx.user, ctx.query.get('target'), ctx.query.get('path')));
  r.get('/api/files/download', async (ctx) => {
    await f.download(ctx);
  });
  r.put('/api/files/upload', (ctx) => f.upload(ctx), { raw: true });
  r.post('/api/files/mkdir', (ctx) => f.mkdir(ctx.user, ctx.body.target, ctx.body.path));
  r.post('/api/files/create', (ctx) => f.createFile(ctx.user, ctx.body.target, ctx.body.path));
  r.post('/api/files/rename', (ctx) => f.rename(ctx.user, ctx.body.target, ctx.body.from, ctx.body.to));
  r.post('/api/files/chmod', (ctx) => f.chmod(ctx.user, ctx.body.target, ctx.body.path, ctx.body.mode));
  r.post('/api/files/delete', async (ctx) => ({ job: await f.remove(ctx) }));
  r.post('/api/files/transfer', (ctx) => f.transfer(ctx));
  r.get('/api/files/jobs', (ctx) => ({ jobs: f.listJobs(ctx.user) }));
  r.del('/api/files/jobs/:id', (ctx) => {
    f.cancelJob(ctx.user, ctx.params.id);
  });
}
