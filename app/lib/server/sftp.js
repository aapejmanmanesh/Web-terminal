// Minimal SFTP v3 client (draft-ietf-secsh-filexfer-02) speaking to an
// OpenSSH sftp-server over a Proc stream — either a local sftp-server running
// as the user's Linux account, or `ssh -s … sftp` for remote hosts.
// Requests are pipelined; responses are matched by request id.

const T = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10,
  OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18,
  READLINK: 19, SYMLINK: 20, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105, EXTENDED: 200, EXTENDED_REPLY: 201,
};
export const FX = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5, NO_CONNECTION: 6, CONNECTION_LOST: 7, OP_UNSUPPORTED: 8 };
export const OPEN = { READ: 0x1, WRITE: 0x2, APPEND: 0x4, CREAT: 0x8, TRUNC: 0x10, EXCL: 0x20 };
const A = { SIZE: 0x1, UIDGID: 0x2, PERMISSIONS: 0x4, ACMODTIME: 0x8, EXTENDED: 0x80000000 };
const MAX_PACKET = 1024 * 1024 + 1024;

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

export class SftpError extends Error {
  constructor(code, message) {
    super(message || 'SFTP error');
    this.code = code;
  }
}

class Writer {
  constructor(type, id) {
    this.parts = [];
    this.len = 0;
    this.u8(type);
    if (id !== undefined) this.u32(id);
  }
  push(b) {
    this.parts.push(b);
    this.len += b.length;
  }
  u8(v) {
    this.push(Buffer.from([v & 0xff]));
  }
  u32(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(v >>> 0);
    this.push(b);
  }
  u64(v) {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(v))));
    this.push(b);
  }
  string(s) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
    this.u32(b.length);
    this.push(b);
  }
  attrs(a = {}) {
    let flags = 0;
    if (a.size != null) flags |= A.SIZE;
    if (a.uid != null && a.gid != null) flags |= A.UIDGID;
    if (a.mode != null) flags |= A.PERMISSIONS;
    if (a.atime != null && a.mtime != null) flags |= A.ACMODTIME;
    this.u32(flags);
    if (flags & A.SIZE) this.u64(a.size);
    if (flags & A.UIDGID) {
      this.u32(a.uid);
      this.u32(a.gid);
    }
    if (flags & A.PERMISSIONS) this.u32(a.mode);
    if (flags & A.ACMODTIME) {
      this.u32(a.atime);
      this.u32(a.mtime);
    }
  }
  packet() {
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32BE(this.len);
    return Buffer.concat([head, ...this.parts], this.len + 4);
  }
}

class Reader {
  constructor(buf, pos = 0) {
    this.b = buf;
    this.p = pos;
  }
  need(n) {
    if (this.p + n > this.b.length) throw new SftpError(FX.BAD_MESSAGE, 'Truncated SFTP packet');
  }
  u8() {
    this.need(1);
    return this.b[this.p++];
  }
  u32() {
    this.need(4);
    const v = this.b.readUInt32BE(this.p);
    this.p += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.b.readBigUInt64BE(this.p);
    this.p += 8;
    return Number(v);
  }
  bytes() {
    const n = this.u32();
    this.need(n);
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  str() {
    return this.bytes().toString('utf8');
  }
  attrs() {
    const flags = this.u32();
    const a = {};
    if (flags & A.SIZE) a.size = this.u64();
    if (flags & A.UIDGID) {
      a.uid = this.u32();
      a.gid = this.u32();
    }
    if (flags & A.PERMISSIONS) a.mode = this.u32();
    if (flags & A.ACMODTIME) {
      a.atime = this.u32();
      a.mtime = this.u32();
    }
    if (flags & A.EXTENDED) {
      const n = this.u32();
      for (let i = 0; i < n; i++) {
        this.bytes();
        this.bytes();
      }
    }
    return a;
  }
}

export const isDir = (a) => a && a.mode != null && (a.mode & S_IFMT) === S_IFDIR;
export const isFile = (a) => a && a.mode != null && (a.mode & S_IFMT) === S_IFREG;
export const isLink = (a) => a && a.mode != null && (a.mode & S_IFMT) === S_IFLNK;

export class Sftp {
  constructor(proc) {
    this.proc = proc;
    this.chunks = [];
    this.have = 0;
    this.nextId = 1;
    this.reqs = new Map();
    this.closed = false;
    this.ext = {};
    this.version = 0;
    this.onVersion = null;
    this.limits = { maxRead: 64 * 1024, maxWrite: 64 * 1024 };
    proc.setSink((d) => this.onData(d));
    proc.wait().then((e) => this.onExit(e));
  }

  // Performs the INIT/VERSION handshake. Rejects with the process' stderr if it
  // dies first (e.g. ssh authentication or host key failures).
  init(timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onVersion = null;
        reject(new SftpError(FX.NO_CONNECTION, 'Connection timed out'));
        this.close();
      }, timeoutMs);
      this.onVersion = (err) => {
        clearTimeout(timer);
        this.onVersion = null;
        if (err) reject(err);
        else resolve(this);
      };
      const w = new Writer(T.INIT);
      w.u32(3);
      this.proc.write(w.packet());
    }).then(async () => {
      if (this.ext['limits@openssh.com']) {
        try {
          const r = await this.extended('limits@openssh.com', () => {});
          r.u64(); // max packet
          const maxRead = r.u64();
          const maxWrite = r.u64();
          if (maxRead) this.limits.maxRead = Math.min(maxRead, 256 * 1024);
          if (maxWrite) this.limits.maxWrite = Math.min(maxWrite, 256 * 1024);
        } catch {}
      }
      return this;
    });
  }

  onData(d) {
    this.chunks.push(d);
    this.have += d.length;
    while (this.have >= 4) {
      const head = this.chunks[0].length >= 4 ? this.chunks[0] : Buffer.concat(this.chunks);
      const len = head.readUInt32BE(0);
      if (len > MAX_PACKET || len < 1) {
        this.fail(new SftpError(FX.BAD_MESSAGE, 'Invalid SFTP packet'));
        return;
      }
      if (this.have < len + 4) return;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      const pkt = all.subarray(4, len + 4);
      const rest = all.subarray(len + 4);
      this.chunks = rest.length ? [rest] : [];
      this.have = rest.length;
      try {
        this.onPacket(pkt);
      } catch (e) {
        this.fail(e instanceof SftpError ? e : new SftpError(FX.BAD_MESSAGE, e.message));
        return;
      }
    }
  }

  onPacket(pkt) {
    const r = new Reader(pkt);
    const type = r.u8();
    if (type === T.VERSION) {
      this.version = r.u32();
      while (r.p < pkt.length) {
        const name = r.str();
        const data = r.str();
        this.ext[name] = data;
      }
      if (this.onVersion) this.onVersion(null);
      return;
    }
    const id = r.u32();
    const q = this.reqs.get(id);
    if (!q) return;
    this.reqs.delete(id);
    if (type === T.STATUS) {
      const code = r.u32();
      let msg = '';
      try {
        msg = r.str();
      } catch {}
      if (code === FX.OK) q.resolve({ type, r: null });
      else if (code === FX.EOF) q.resolve({ type, r: null, eof: true });
      else q.reject(new SftpError(code, statusMessage(code, msg)));
      return;
    }
    q.resolve({ type, r });
  }

  onExit(e) {
    const why = connectionMessage(e && e.stderr, e && e.error);
    this.fail(new SftpError(FX.CONNECTION_LOST, why));
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = err;
    if (this.onVersion) this.onVersion(err);
    for (const q of this.reqs.values()) q.reject(err);
    this.reqs.clear();
    this.proc.kill();
    if (this.onClose) this.onClose(err);
  }

  close() {
    if (this.closed) return;
    this.proc.end();
    const p = this.proc;
    setTimeout(() => p.kill(), 2000).unref();
    this.fail(new SftpError(FX.CONNECTION_LOST, 'Connection closed'));
  }

  request(type, fill) {
    if (this.closed) return Promise.reject(this.closeReason || new SftpError(FX.CONNECTION_LOST, 'Connection closed'));
    const id = this.nextId;
    this.nextId = (this.nextId + 1) >>> 0 || 1;
    const w = new Writer(type, id);
    if (fill) fill(w);
    return new Promise((resolve, reject) => {
      this.reqs.set(id, { resolve, reject });
      this.proc.write(w.packet());
    });
  }

  get inflight() {
    return this.reqs.size;
  }

  expect(res, type) {
    if (res.type !== type || !res.r) throw new SftpError(FX.BAD_MESSAGE, 'Unexpected SFTP response');
    return res.r;
  }

  async extended(name, fill) {
    const res = await this.request(T.EXTENDED, (w) => {
      w.string(name);
      fill(w);
    });
    return res.r ? res.r : null;
  }

  // ------------------------------------------------------------ operations
  async realpath(p) {
    const r = this.expect(await this.request(T.REALPATH, (w) => w.string(p)), T.NAME);
    if (r.u32() < 1) throw new SftpError(FX.FAILURE, 'realpath failed');
    return r.str();
  }
  async stat(p) {
    return this.expect(await this.request(T.STAT, (w) => w.string(p)), T.ATTRS).attrs();
  }
  async lstat(p) {
    return this.expect(await this.request(T.LSTAT, (w) => w.string(p)), T.ATTRS).attrs();
  }
  // lstat that returns null instead of throwing when the path does not exist.
  async exists(p) {
    try {
      return await this.lstat(p);
    } catch (e) {
      if (e.code === FX.NO_SUCH_FILE) return null;
      throw e;
    }
  }
  async fstat(h) {
    return this.expect(await this.request(T.FSTAT, (w) => w.string(h)), T.ATTRS).attrs();
  }
  async open(p, flags, attrs = {}) {
    return this.expect(
      await this.request(T.OPEN, (w) => {
        w.string(p);
        w.u32(flags);
        w.attrs(attrs);
      }),
      T.HANDLE,
    ).bytes();
  }
  async closeHandle(h) {
    await this.request(T.CLOSE, (w) => w.string(h));
  }
  // Resolves with a Buffer, or null at end of file.
  async read(h, offset, len) {
    const res = await this.request(T.READ, (w) => {
      w.string(h);
      w.u64(offset);
      w.u32(len);
    });
    if (res.eof) return null;
    return Buffer.from(this.expect(res, T.DATA).bytes());
  }
  async write(h, offset, data) {
    await this.request(T.WRITE, (w) => {
      w.string(h);
      w.u64(offset);
      w.string(data);
    });
  }
  async opendir(p) {
    return this.expect(await this.request(T.OPENDIR, (w) => w.string(p)), T.HANDLE).bytes();
  }
  // Resolves with [{ name, longname, attrs }] or null when done.
  async readdir(h) {
    const res = await this.request(T.READDIR, (w) => w.string(h));
    if (res.eof) return null;
    const r = this.expect(res, T.NAME);
    const n = r.u32();
    const out = [];
    for (let i = 0; i < n; i++) out.push({ name: r.str(), longname: r.str(), attrs: r.attrs() });
    return out;
  }
  async readdirAll(p, max = Infinity) {
    const h = await this.opendir(p);
    const out = [];
    let truncated = false;
    try {
      for (;;) {
        const batch = await this.readdir(h);
        if (!batch) break;
        for (const e of batch) if (e.name !== '.' && e.name !== '..') out.push(e);
        if (out.length >= max) {
          truncated = true;
          break;
        }
      }
    } finally {
      this.closeHandle(h).catch(() => {});
    }
    if (truncated) out.length = max;
    return { entries: out, truncated };
  }
  async mkdir(p, attrs = {}) {
    await this.request(T.MKDIR, (w) => {
      w.string(p);
      w.attrs(attrs);
    });
  }
  async rmdir(p) {
    await this.request(T.RMDIR, (w) => w.string(p));
  }
  async remove(p) {
    await this.request(T.REMOVE, (w) => w.string(p));
  }
  async setstat(p, attrs) {
    await this.request(T.SETSTAT, (w) => {
      w.string(p);
      w.attrs(attrs);
    });
  }
  // Plain RENAME fails when the target exists; overwrite uses posix-rename.
  async rename(from, to, overwrite = false) {
    if (overwrite && this.ext['posix-rename@openssh.com'] !== undefined) {
      await this.extended('posix-rename@openssh.com', (w) => {
        w.string(from);
        w.string(to);
      });
      return;
    }
    if (overwrite) {
      const cur = await this.exists(to);
      if (cur && !isDir(cur)) await this.remove(to);
    }
    await this.request(T.RENAME, (w) => {
      w.string(from);
      w.string(to);
    });
  }
  async readlink(p) {
    const r = this.expect(await this.request(T.READLINK, (w) => w.string(p)), T.NAME);
    if (r.u32() < 1) throw new SftpError(FX.FAILURE, 'readlink failed');
    return r.str();
  }
  // OpenSSH swaps the argument order relative to the draft: target first.
  async symlink(target, linkPath) {
    await this.request(T.SYMLINK, (w) => {
      w.string(target);
      w.string(linkPath);
    });
  }
}

function statusMessage(code, msg) {
  switch (code) {
    case FX.NO_SUCH_FILE:
      return 'No such file or folder';
    case FX.PERMISSION_DENIED:
      return 'Permission denied';
    case FX.OP_UNSUPPORTED:
      return 'Operation not supported by this server';
    case FX.FAILURE:
      return msg && msg !== 'Failure' ? msg : 'Operation failed';
    default:
      return msg || 'SFTP error';
  }
}

// Turns ssh/sftp-server stderr into a short human message.
export function connectionMessage(stderr, error) {
  const text = String(stderr || '');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) {
    return 'Host key changed or not trusted — an administrator can reset it with "Forget pinned host key".';
  }
  if (/Permission denied \(/i.test(text)) return 'Authentication failed (the credential was rejected by the host).';
  if (/subsystem request failed|sftp.*not found|No such file.*sftp/i.test(text)) return 'SFTP is not available on this host.';
  if (/Connection refused/i.test(text)) return 'Connection refused.';
  if (/timed out/i.test(text)) return 'Connection timed out.';
  if (/Could not resolve hostname/i.test(text)) return 'Could not resolve the host name.';
  if (/No route to host|Network is unreachable/i.test(text)) return 'Host is unreachable.';
  const line = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (line) return line.slice(0, 200);
  return error ? String(error).slice(0, 200) : 'Connection closed';
}
