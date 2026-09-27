// HTTP API.
import { Router, HttpError, bad, forbidden, notFound, str, int, bool, oneOf, sendJson } from './http.js';
import { passwordProblem, hashPassword, verifyPassword } from './security.js';
import { safeJson } from './auth.js';
import { validColor, COLORS } from './terminals.js';
import { MAC_RE, HOST_RE } from './systems.js';
import { ADDRESS_RE, SSH_USER_RE, sshArgv, credFiles } from './ssh.js';
import { generateKey, importKey } from './sshkeys.js';
import { VERSION } from './app.js';
import { fileRoutes } from './files.js';
import os from 'node:os';

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
const LINUX_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const INPUT_RE = /\$\{input:([A-Za-z0-9_-]{1,32})\}/g;
const OPEN_AS = ['right', 'down', 'tab', 'float', 'hidden'];

// This server's LAN IPv4 addresses (admins see them in the remote desktop setup hint).
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  return out.slice(0, 4);
}

export function buildRoutes(app) {
  const r = new Router();
  const { store } = app;
  const actor = (ctx) => ({ req: ctx.req, userId: ctx.user ? ctx.user.id : null, username: ctx.user ? ctx.user.username : '' });

  // ================================================================ auth
  r.post(
    '/api/login',
    async (ctx) => {
      const { token, user, remember } = await app.auth.login(ctx.req, ctx.body);
      sendJson(ctx.res, 200, { ok: true, user: app.auth.publicUser(user) }, { 'Set-Cookie': app.auth.cookieHeader(token, remember) });
    },
    { auth: false, limit: 4096 },
  );

  r.post('/api/logout', async (ctx) => {
    app.audit(actor(ctx), 'logout');
    app.auth.logout(ctx.sess.id);
    sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': app.auth.clearCookieHeader() });
  });

  r.get('/api/bootstrap', (ctx) => {
    const u = ctx.user;
    ensureWorkspace(u.id);
    return {
      me: app.auth.publicUser(u),
      server: { hostname: app.cfg.hostname, version: VERSION, ide: app.ide.status(u), broker: app.broker.up, lan: u.role === 'admin' ? lanAddresses() : [] },
      terminals: app.terms.list(u),
      workspaces: listWorkspaces(u.id),
      presets: listPresets(u),
      hosts: listHosts(u),
      systems: app.systems.list(u.role === 'admin'),
    };
  });

  r.put(
    '/api/me/password',
    async (ctx) => {
      const { current, next } = ctx.body;
      if (typeof current !== 'string' || !(await verifyPassword(current, ctx.user.pw))) throw bad('Current password is incorrect');
      const p = passwordProblem(next);
      if (p) throw bad(p);
      await app.auth.setPassword(ctx.user.id, next);
      app.auth.revokeUser(ctx.user.id, ctx.sess.id);
      app.audit(actor(ctx), 'password.change');
    },
    { limit: 4096 },
  );

  r.put('/api/me/settings', (ctx) => {
    const s = cleanSettings(ctx.body.settings);
    store.run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), ctx.user.id);
    return { settings: s };
  });

  r.put('/api/me/ui', (ctx) => {
    const ui = ctx.body.ui;
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) throw bad('Invalid UI state');
    const json = JSON.stringify(ui);
    if (json.length > 16384) throw bad('UI state too large');
    store.run('UPDATE users SET ui = ? WHERE id = ?', json, ctx.user.id);
  });

  r.get('/api/me/devices', (ctx) => ({
    devices: store
      .all('SELECT id, created_at, last_seen, expires_at, persistent, ip, ua FROM auth_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC', ctx.user.id, Date.now())
      .map((d) => ({ id: d.id, createdAt: d.created_at, lastSeen: d.last_seen, ip: d.ip, ua: d.ua, current: d.id === ctx.sess.id })),
  }));

  r.del('/api/me/devices/:id', (ctx) => {
    const id = int(ctx.params.id, { name: 'id' });
    const d = store.get('SELECT id FROM auth_sessions WHERE id = ? AND user_id = ?', id, ctx.user.id);
    if (!d) throw notFound();
    app.auth.logout(id);
    app.audit(actor(ctx), 'device.signout', `session ${id}`);
  });

  // ================================================================ terminals
  r.get('/api/terminals', (ctx) => ({ terminals: app.terms.list(ctx.user) }));

  r.post('/api/terminals', async (ctx) => {
    const b = ctx.body;
    const kind = oneOf(b.kind, ['local', 'ssh'], 'kind');
    const hostId = kind === 'ssh' ? int(b.hostId, { name: 'host' }) : null;
    const term = await app.terms.create(ctx.user, {
      kind,
      hostId,
      cwd: str(b.cwd, { name: 'Directory', max: 1024, optional: true, re: /^[^\n\r]*$/, trim: false }),
      name: str(b.name, { name: 'Name', max: 80, optional: true }),
      cols: b.cols,
      rows: b.rows,
    });
    app.audit(actor(ctx), 'terminal.create', kind === 'ssh' ? `ssh ${term.hostName}` : 'local');
    return { term };
  });

  r.patch('/api/terminals/:id', (ctx) => ({ term: app.terms.update(ctx.user, ctx.params.id, ctx.body) }));

  r.post('/api/terminals/:id/restart', async (ctx) => ({ term: await app.terms.restart(ctx.user, ctx.params.id, { cols: ctx.body.cols, rows: ctx.body.rows }) }));

  r.del('/api/terminals/:id', async (ctx) => {
    await app.terms.kill(ctx.user, ctx.params.id);
  });

  // ================================================================ workspaces
  function ensureWorkspace(userId) {
    const n = store.get('SELECT COUNT(*) AS n FROM workspaces WHERE user_id = ?', userId).n;
    if (!n) store.run('INSERT INTO workspaces (user_id, name, pos, layout, updated_at) VALUES (?,?,?,?,?)', userId, 'main', 0, null, Date.now());
  }
  function listWorkspaces(userId) {
    return store
      .all('SELECT * FROM workspaces WHERE user_id = ? ORDER BY pos, id', userId)
      .map((w) => ({ id: w.id, name: w.name, pos: w.pos, layout: w.layout ? safeJson(w.layout, null) : null, updatedAt: w.updated_at }));
  }
  const ownWs = (ctx) => {
    const w = store.get('SELECT * FROM workspaces WHERE id = ? AND user_id = ?', int(ctx.params.id, { name: 'id' }), ctx.user.id);
    if (!w) throw notFound('Workspace not found');
    return w;
  };

  r.get('/api/workspaces', (ctx) => ({ workspaces: listWorkspaces(ctx.user.id) }));

  r.post('/api/workspaces', (ctx) => {
    const name = str(ctx.body.name, { name: 'Name', min: 1, max: 40 });
    const n = store.get('SELECT COUNT(*) AS n, COALESCE(MAX(pos), -1) AS p FROM workspaces WHERE user_id = ?', ctx.user.id);
    if (n.n >= 20) throw bad('Too many workspaces');
    const res = store.run('INSERT INTO workspaces (user_id, name, pos, layout, updated_at) VALUES (?,?,?,?,?)', ctx.user.id, name, n.p + 1, null, Date.now());
    return { workspace: listWorkspaces(ctx.user.id).find((w) => w.id === Number(res.lastInsertRowid)) };
  });

  r.patch('/api/workspaces/:id', (ctx) => {
    const w = ownWs(ctx);
    if (ctx.body.name !== undefined) store.run('UPDATE workspaces SET name = ? WHERE id = ?', str(ctx.body.name, { name: 'Name', min: 1, max: 40 }), w.id);
    if (ctx.body.pos !== undefined) store.run('UPDATE workspaces SET pos = ? WHERE id = ?', int(ctx.body.pos, { name: 'pos', min: 0, max: 1000 }), w.id);
    return { workspaces: listWorkspaces(ctx.user.id) };
  });

  r.put(
    '/api/workspaces/:id/layout',
    (ctx) => {
      const w = ownWs(ctx);
      const layout = ctx.body.layout;
      if (layout !== null && (typeof layout !== 'object' || Array.isArray(layout))) throw bad('Invalid layout');
      store.run('UPDATE workspaces SET layout = ?, updated_at = ? WHERE id = ?', layout ? JSON.stringify(layout) : null, Date.now(), w.id);
    },
    { limit: 1024 * 1024 },
  );

  r.del('/api/workspaces/:id', (ctx) => {
    const w = ownWs(ctx);
    const n = store.get('SELECT COUNT(*) AS n FROM workspaces WHERE user_id = ?', ctx.user.id).n;
    if (n <= 1) throw bad('You need at least one workspace');
    store.run('DELETE FROM workspaces WHERE id = ?', w.id);
    return { workspaces: listWorkspaces(ctx.user.id) };
  });

  // ================================================================ presets
  function presetToClient(p) {
    const host = p.host_id ? store.get('SELECT name FROM hosts WHERE id = ?', p.host_id) : null;
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      hostId: p.host_id,
      hostName: host ? host.name : null,
      cwd: p.cwd || '',
      commands: p.commands,
      remoteTmux: !!p.remote_tmux,
      openAs: p.open_as,
      color: p.color,
      notify: !!p.notify,
      shared: p.owner_id === null,
      mine: true,
      inputs: presetInputs(p),
      updatedAt: p.updated_at,
    };
  }
  function presetInputs(p) {
    const names = new Set();
    for (const s of [p.commands || '', p.cwd || '']) for (const m of s.matchAll(INPUT_RE)) names.add(m[1]);
    return [...names];
  }
  function listPresets(u) {
    return store
      .all('SELECT * FROM presets WHERE owner_id = ? OR owner_id IS NULL ORDER BY owner_id IS NULL, name COLLATE NOCASE', u.id)
      .map((p) => ({ ...presetToClient(p), mine: p.owner_id === u.id, editable: p.owner_id === u.id || u.role === 'admin' }));
  }
  function presetInput(ctx, existing) {
    const b = ctx.body;
    const kind = oneOf(b.kind, ['local', 'ssh'], 'Type');
    const out = {
      name: str(b.name, { name: 'Name', min: 1, max: 60 }),
      kind,
      host_id: null,
      cwd: str(b.cwd, { name: 'Working directory', max: 300, optional: true, re: /^[^\n\r]*$/ }),
      commands: str(b.commands, { name: 'Commands', max: 8000, trim: false }) || '',
      remote_tmux: kind === 'ssh' && bool(b.remoteTmux) ? 1 : 0,
      open_as: oneOf(b.openAs || 'right', OPEN_AS, 'Open as'),
      color: validColor(b.color || 'green') || 'green',
      notify: bool(b.notify) ? 1 : 0,
      shared: bool(b.shared),
    };
    if (kind === 'ssh') {
      out.host_id = int(b.hostId, { name: 'Host' });
      app.terms.accessibleHost(ctx.user, out.host_id);
    } else if (!ctx.user.allow_local || !ctx.user.linux_user) {
      throw bad('Local shells are disabled for your account');
    }
    if (out.shared && ctx.user.role !== 'admin') throw forbidden('Only administrators can share presets');
    if (existing && existing.owner_id === null && ctx.user.role !== 'admin') throw forbidden('Only administrators can edit shared presets');
    return out;
  }
  const findPreset = (ctx) => {
    const p = store.get('SELECT * FROM presets WHERE id = ?', int(ctx.params.id, { name: 'id' }));
    if (!p || (p.owner_id !== null && p.owner_id !== ctx.user.id)) throw notFound('Preset not found');
    return p;
  };

  r.get('/api/presets', (ctx) => ({ presets: listPresets(ctx.user) }));

  r.post('/api/presets', (ctx) => {
    const p = presetInput(ctx, null);
    const n = store.get('SELECT COUNT(*) AS n FROM presets WHERE owner_id = ?', ctx.user.id).n;
    if (n >= 200) throw bad('Too many presets');
    const res = store.run(
      'INSERT INTO presets (owner_id, name, kind, host_id, cwd, commands, remote_tmux, open_as, color, notify, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      p.shared ? null : ctx.user.id,
      p.name,
      p.kind,
      p.host_id,
      p.cwd,
      p.commands,
      p.remote_tmux,
      p.open_as,
      p.color,
      p.notify,
      ctx.user.id,
      Date.now(),
    );
    return { presets: listPresets(ctx.user), id: Number(res.lastInsertRowid) };
  });

  r.put('/api/presets/:id', (ctx) => {
    const cur = findPreset(ctx);
    const p = presetInput(ctx, cur);
    const owner = ctx.user.role === 'admin' ? (p.shared ? null : cur.owner_id ?? ctx.user.id) : cur.owner_id;
    store.run(
      'UPDATE presets SET owner_id = ?, name = ?, kind = ?, host_id = ?, cwd = ?, commands = ?, remote_tmux = ?, open_as = ?, color = ?, notify = ?, updated_at = ? WHERE id = ?',
      owner,
      p.name,
      p.kind,
      p.host_id,
      p.cwd,
      p.commands,
      p.remote_tmux,
      p.open_as,
      p.color,
      p.notify,
      Date.now(),
      cur.id,
    );
    return { presets: listPresets(ctx.user) };
  });

  r.del('/api/presets/:id', (ctx) => {
    const p = findPreset(ctx);
    if (p.owner_id === null && ctx.user.role !== 'admin') throw forbidden('Only administrators can delete shared presets');
    store.run('DELETE FROM presets WHERE id = ?', p.id);
    return { presets: listPresets(ctx.user) };
  });

  r.post('/api/presets/:id/run', async (ctx) => {
    const p = findPreset(ctx);
    const inputs = ctx.body.inputs && typeof ctx.body.inputs === 'object' ? ctx.body.inputs : {};
    const needed = presetInputs(p);
    const missing = needed.filter((n) => typeof inputs[n] !== 'string');
    if (missing.length) throw new HttpError(400, 'Values required', { inputs: missing });
    const fill = (s) =>
      (s || '').replace(INPUT_RE, (_, n) => {
        const v = String(inputs[n]);
        if (/[\r\n]/.test(v) || v.length > 500) throw bad(`Invalid value for ${n}`);
        return v;
      });
    const lines = fill(p.commands)
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.length);
    const term = await app.terms.create(ctx.user, {
      kind: p.kind,
      hostId: p.host_id,
      presetId: p.id,
      name: p.name,
      color: p.color,
      notify: !!p.notify,
      cwd: fill(p.cwd) || null,
      startup: lines.length ? lines.map((l) => l + '\r').join('') : null,
      remoteTmux: !!p.remote_tmux,
      cols: ctx.body.cols,
      rows: ctx.body.rows,
    });
    app.audit(actor(ctx), 'preset.run', p.name);
    return { term, openAs: p.open_as };
  });

  // ================================================================ hosts
  function hostToClient(h) {
    const cred = h.cred_id ? store.get('SELECT id, name, type FROM creds WHERE id = ?', h.cred_id) : null;
    return { id: h.id, name: h.name, address: h.address, port: h.port, username: h.username, credId: h.cred_id, credName: cred ? cred.name : null, credType: cred ? cred.type : null };
  }
  function listHosts(u) {
    const rows =
      u.role === 'admin'
        ? store.all('SELECT * FROM hosts ORDER BY name COLLATE NOCASE')
        : store.all('SELECT h.* FROM hosts h JOIN cred_access a ON a.cred_id = h.cred_id WHERE a.user_id = ? ORDER BY h.name COLLATE NOCASE', u.id);
    return rows.map(hostToClient);
  }
  function hostInput(b) {
    const credId = b.credId === null || b.credId === undefined || b.credId === '' ? null : int(b.credId, { name: 'Credential' });
    if (credId && !store.get('SELECT id FROM creds WHERE id = ?', credId)) throw bad('Unknown credential');
    return {
      name: str(b.name, { name: 'Name', min: 1, max: 40, re: /^[^\n\r]+$/ }),
      address: str(b.address, { name: 'Address', min: 1, max: 253, re: ADDRESS_RE }),
      port: int(b.port ?? 22, { name: 'Port', min: 1, max: 65535 }),
      username: str(b.username, { name: 'User', min: 1, max: 64, re: SSH_USER_RE }),
      credId,
    };
  }
  const findHost = (ctx) => {
    const h = store.get('SELECT * FROM hosts WHERE id = ?', int(ctx.params.id, { name: 'id' }));
    if (!h) throw notFound('Host not found');
    return h;
  };

  r.get('/api/hosts', (ctx) => ({ hosts: listHosts(ctx.user) }));

  r.post(
    '/api/hosts',
    (ctx) => {
      const h = hostInput(ctx.body);
      if (store.get('SELECT id FROM hosts WHERE name = ?', h.name)) throw bad('A host with this name exists');
      store.run('INSERT INTO hosts (name, address, port, username, cred_id, created_at) VALUES (?,?,?,?,?,?)', h.name, h.address, h.port, h.username, h.credId, Date.now());
      app.audit(actor(ctx), 'host.create', `${h.name} ${h.username}@${h.address}:${h.port}`);
      broadcastHosts();
      return { hosts: listHosts(ctx.user) };
    },
    { admin: true },
  );

  r.put(
    '/api/hosts/:id',
    (ctx) => {
      const cur = findHost(ctx);
      const h = hostInput(ctx.body);
      const clash = store.get('SELECT id FROM hosts WHERE name = ? AND id != ?', h.name, cur.id);
      if (clash) throw bad('A host with this name exists');
      store.run('UPDATE hosts SET name = ?, address = ?, port = ?, username = ?, cred_id = ? WHERE id = ?', h.name, h.address, h.port, h.username, h.credId, cur.id);
      app.audit(actor(ctx), 'host.update', h.name);
      broadcastHosts();
      return { hosts: listHosts(ctx.user) };
    },
    { admin: true },
  );

  r.del(
    '/api/hosts/:id',
    (ctx) => {
      const h = findHost(ctx);
      store.run('DELETE FROM hosts WHERE id = ?', h.id);
      store.run("DELETE FROM plugin_state WHERE target = ?", 'host:' + h.id);
      app.audit(actor(ctx), 'host.delete', h.name);
      broadcastHosts();
      return { hosts: listHosts(ctx.user) };
    },
    { admin: true },
  );

  r.post('/api/hosts/:id/test', async (ctx) => {
    const h = findHost(ctx);
    const { host, cred } = app.terms.accessibleHost(ctx.user, h.id);
    const argv = sshArgv(app, host, cred, { tty: false, batch: true, remoteCommand: 'echo WEBTERM_OK; uname -snr' });
    const { files, env } = credFiles(app, cred);
    const res = await app.broker.call({ op: 'exec', user: app.cfg.sshUser, argv, files, env, timeout: 25 }, 30000);
    const ok = res.code === 0 && res.stdout.includes('WEBTERM_OK');
    return { ok, output: (ok ? res.stdout.replace('WEBTERM_OK', '').trim() : (res.stderr || res.stdout || `exit code ${res.code}`).trim()).slice(0, 600) };
  });

  r.post(
    '/api/hosts/:id/forget-key',
    async (ctx) => {
      const h = findHost(ctx);
      const target = h.port === 22 ? h.address : `[${h.address}]:${h.port}`;
      await app.broker.call({ op: 'exec', user: app.cfg.sshUser, argv: [app.cfg.sshKeygen, '-R', target, '-f', `${app.cfg.sshHome}/known_hosts`], timeout: 10 });
      app.audit(actor(ctx), 'host.forget-key', h.name);
    },
    { admin: true },
  );

  r.post(
    '/api/hosts/:id/install-key',
    async (ctx) => {
      const h = findHost(ctx);
      const term = await app.terms.create(ctx.user, { kind: 'task', hostId: h.id, name: `Install key · ${h.name}`, color: 'amber', task: { type: 'install-key' } });
      app.audit(actor(ctx), 'host.install-key', h.name);
      return { term };
    },
    { admin: true },
  );

  function broadcastHosts() {
    for (const u of store.all('SELECT * FROM users')) app.hub.emitUser(u.id, { t: 'hosts', hosts: listHosts(u) });
  }

  // ================================================================ credentials (vault)
  function credToClient(c) {
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      publicKey: c.public_key,
      fingerprint: c.fingerprint,
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at,
      lastUsedBy: c.last_used_by,
      access: store.all('SELECT user_id FROM cred_access WHERE cred_id = ?', c.id).map((a) => a.user_id),
      hosts: store.all('SELECT name FROM hosts WHERE cred_id = ? ORDER BY name', c.id).map((h) => h.name),
    };
  }
  const listCreds = () => store.all('SELECT * FROM creds ORDER BY name COLLATE NOCASE').map(credToClient);
  function setAccess(credId, ids) {
    if (!Array.isArray(ids)) return;
    store.tx(() => {
      store.run('DELETE FROM cred_access WHERE cred_id = ?', credId);
      for (const id of ids) {
        const uid = int(id, { name: 'user' });
        if (store.get('SELECT id FROM users WHERE id = ?', uid)) store.run('INSERT OR IGNORE INTO cred_access (cred_id, user_id) VALUES (?,?)', credId, uid);
      }
    });
  }

  r.get('/api/creds', () => ({ creds: listCreds() }), { admin: true });

  r.post(
    '/api/creds',
    async (ctx) => {
      const b = ctx.body;
      const name = str(b.name, { name: 'Name', min: 1, max: 40, re: /^[A-Za-z0-9._ -]+$/ });
      if (store.get('SELECT id FROM creds WHERE name = ?', name)) throw bad('A credential with this name exists');
      const type = oneOf(b.type, ['key', 'password'], 'Type');
      let secret;
      let pub = null;
      let fp = null;
      if (type === 'key') {
        const k = bool(b.generate) ? await generateKey(app, `webterm:${name}`) : await importKey(app, b.privateKey, typeof b.passphrase === 'string' ? b.passphrase : '', `webterm:${name}`);
        secret = k.privateKey;
        pub = k.publicKey;
        fp = k.fingerprint;
      } else {
        if (typeof b.password !== 'string' || !b.password.length || b.password.length > 500) throw bad('Password is required');
        secret = b.password;
      }
      const res = store.run(
        'INSERT INTO creds (name, type, public_key, fingerprint, secret, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
        name,
        type,
        pub,
        fp,
        app.vault.seal(secret),
        ctx.user.id,
        Date.now(),
      );
      const id = Number(res.lastInsertRowid);
      setAccess(id, b.access || []);
      app.audit(actor(ctx), 'cred.create', `${name} (${type})`);
      broadcastHosts();
      return { creds: listCreds(), id };
    },
    { admin: true, limit: 64 * 1024 },
  );

  r.put(
    '/api/creds/:id',
    async (ctx) => {
      const c = store.get('SELECT * FROM creds WHERE id = ?', int(ctx.params.id, { name: 'id' }));
      if (!c) throw notFound();
      const b = ctx.body;
      if (b.name !== undefined) {
        const name = str(b.name, { name: 'Name', min: 1, max: 40, re: /^[A-Za-z0-9._ -]+$/ });
        if (store.get('SELECT id FROM creds WHERE name = ? AND id != ?', name, c.id)) throw bad('A credential with this name exists');
        store.run('UPDATE creds SET name = ? WHERE id = ?', name, c.id);
      }
      if (c.type === 'password' && typeof b.password === 'string' && b.password.length) {
        if (b.password.length > 500) throw bad('Password is too long');
        store.run('UPDATE creds SET secret = ? WHERE id = ?', app.vault.seal(b.password), c.id);
      }
      if (b.access !== undefined) setAccess(c.id, b.access);
      app.audit(actor(ctx), 'cred.update', c.name);
      broadcastHosts();
      return { creds: listCreds() };
    },
    { admin: true, limit: 64 * 1024 },
  );

  r.del(
    '/api/creds/:id',
    (ctx) => {
      const c = store.get('SELECT * FROM creds WHERE id = ?', int(ctx.params.id, { name: 'id' }));
      if (!c) throw notFound();
      store.run('DELETE FROM creds WHERE id = ?', c.id);
      app.audit(actor(ctx), 'cred.delete', c.name);
      broadcastHosts();
      return { creds: listCreds(), hosts: listHosts(ctx.user) };
    },
    { admin: true },
  );

  // ================================================================ systems
  function systemInput(b) {
    const mac = str(b.mac, { name: 'MAC', max: 17, optional: true });
    if (mac && !MAC_RE.test(mac)) throw bad('MAC address looks invalid (use aa:bb:cc:dd:ee:ff)');
    const bc = str(b.broadcast, { name: 'Broadcast', max: 21, optional: true });
    if (bc && !/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(bc)) throw bad('Broadcast must look like 192.168.1.255 or 192.168.1.255:9');
    return {
      name: str(b.name, { name: 'Name', min: 1, max: 40 }),
      address: str(b.address, { name: 'Address', min: 1, max: 253, re: HOST_RE }),
      mac: mac ? mac.toLowerCase().replace(/-/g, ':') : null,
      broadcast: bc || null,
      interval: int(b.interval ?? 30, { name: 'Interval', min: 5, max: 3600 }),
      vncPort: b.vncPort === null || b.vncPort === undefined || b.vncPort === '' ? null : int(b.vncPort, { name: 'VNC port', min: 1, max: 65535 }),
      vncAccess: b.vncAccess === undefined ? 'admins' : oneOf(b.vncAccess, ['admins', 'all'], 'VNC access'),
      rdpPort: b.rdpPort === null || b.rdpPort === undefined || b.rdpPort === '' ? null : int(b.rdpPort, { name: 'RDP port', min: 1, max: 65535 }),
      rdpUser: str(b.rdpUser, { name: 'RDP user', max: 128, optional: true }) || null,
      rdpDomain: str(b.rdpDomain, { name: 'RDP domain', max: 128, optional: true }) || null,
    };
  }
  // Write-only RDP password: undefined keeps it, '' clears it.
  function rdpSecret(b, cur) {
    if (b.rdpPassword === undefined || b.rdpPassword === null) return cur ? cur.rdp_secret : null;
    const pw = str(b.rdpPassword, { name: 'RDP password', max: 256, trim: false });
    return pw ? app.vault.seal(pw) : null;
  }
  // Write-only VNC password: undefined keeps it, '' clears it.
  function vncSecret(b, cur) {
    if (b.vncPassword === undefined || b.vncPassword === null) return cur ? cur.vnc_secret : null;
    const pw = str(b.vncPassword, { name: 'VNC password', max: 64, trim: false });
    return pw ? app.vault.seal(pw) : null;
  }
  const findSystem = (ctx) => {
    const s = store.get('SELECT * FROM systems WHERE id = ?', int(ctx.params.id, { name: 'id' }));
    if (!s) throw notFound('System not found');
    return s;
  };

  r.get('/api/systems', (ctx) => ({ systems: app.systems.list(ctx.user.role === 'admin') }));

  r.post(
    '/api/systems',
    (ctx) => {
      const s = systemInput(ctx.body);
      if (store.get('SELECT COUNT(*) AS n FROM systems').n >= 100) throw bad('Too many systems');
      const res = store.run(
        'INSERT INTO systems (name, address, mac, broadcast, interval, vnc_port, vnc_secret, vnc_access, rdp_port, rdp_user, rdp_domain, rdp_secret, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        s.name,
        s.address,
        s.mac,
        s.broadcast,
        s.interval,
        s.vncPort,
        vncSecret(ctx.body, null),
        s.vncAccess,
        s.rdpPort,
        s.rdpUser,
        s.rdpDomain,
        rdpSecret(ctx.body, null),
        Date.now(),
      );
      app.systems.schedule({ id: Number(res.lastInsertRowid), ...s }, 100);
      app.audit(actor(ctx), 'system.create', s.name);
      app.systems.emitSoon();
      return { systems: app.systems.list(true) };
    },
    { admin: true },
  );

  r.put(
    '/api/systems/:id',
    (ctx) => {
      const cur = findSystem(ctx);
      const s = systemInput(ctx.body);
      store.run(
        'UPDATE systems SET name = ?, address = ?, mac = ?, broadcast = ?, interval = ?, vnc_port = ?, vnc_secret = ?, vnc_access = ?, rdp_port = ?, rdp_user = ?, rdp_domain = ?, rdp_secret = ? WHERE id = ?',
        s.name,
        s.address,
        s.mac,
        s.broadcast,
        s.interval,
        s.vncPort,
        vncSecret(ctx.body, cur),
        s.vncAccess,
        s.rdpPort,
        s.rdpUser,
        s.rdpDomain,
        rdpSecret(ctx.body, cur),
        cur.id,
      );
      if (cur.address !== s.address) app.systems.state.delete(cur.id);
      app.desktops.recheck((c) => c.systemId === cur.id);
      app.systems.schedule({ id: cur.id, ...s }, 100);
      app.audit(actor(ctx), 'system.update', s.name);
      app.systems.emitSoon();
      return { systems: app.systems.list(true) };
    },
    { admin: true },
  );

  r.del(
    '/api/systems/:id',
    (ctx) => {
      const s = findSystem(ctx);
      store.run('DELETE FROM systems WHERE id = ?', s.id);
      app.desktops.recheck((c) => c.systemId === s.id);
      app.systems.unschedule(s.id);
      app.audit(actor(ctx), 'system.delete', s.name);
      app.systems.emitSoon();
      return { systems: app.systems.list(true) };
    },
    { admin: true },
  );

  r.post('/api/systems/:id/wake', async (ctx) => {
    const s = findSystem(ctx);
    const res = await app.systems.wake(s.id);
    app.audit(actor(ctx), 'system.wake', `${s.name} (${s.mac})`);
    return { ...res, systems: app.systems.list(ctx.user.role === 'admin') };
  });

  // ================================================================ plugins
  function pluginView(u, target) {
    const st = app.plugins.state(u, target);
    return app.plugins.all(u).map((p) => ({
      key: p.key,
      name: p.name,
      desc: p.desc,
      custom: p.custom,
      id: p.id || null,
      bin: p.bin || null,
      config: p.config || null,
      url: p.url || null,
      installed: !!(st[p.key] && st[p.key].installed),
      enabled: !!(st[p.key] && st[p.key].enabled),
    }));
  }

  r.get('/api/plugins', (ctx) => {
    const targets = app.plugins.targets(ctx.user);
    const target = ctx.query.get('target') || (targets[0] && targets[0].id) || null;
    return { targets, target, plugins: target ? pluginView(ctx.user, target) : [] };
  });

  r.post('/api/plugins/check', async (ctx) => {
    const target = str(ctx.body.target, { name: 'Target', min: 1, max: 40 });
    await app.plugins.check(ctx.user, target);
    return { plugins: pluginView(ctx.user, target) };
  });

  r.post('/api/plugins/install', async (ctx) => {
    const term = await app.plugins.runInstall(ctx.user, str(ctx.body.plugin, { name: 'Plugin', min: 1, max: 20 }), str(ctx.body.target, { name: 'Target', min: 1, max: 40 }));
    app.audit(actor(ctx), 'plugin.install', `${ctx.body.plugin} → ${ctx.body.target}`);
    return { term };
  });

  r.post('/api/plugins/remove', async (ctx) => {
    const term = await app.plugins.runInstall(ctx.user, str(ctx.body.plugin, { name: 'Plugin', min: 1, max: 20 }), str(ctx.body.target, { name: 'Target', min: 1, max: 40 }), { uninstall: true });
    return { term };
  });

  r.post('/api/plugins/toggle', async (ctx) => {
    const target = str(ctx.body.target, { name: 'Target', min: 1, max: 40 });
    const key = str(ctx.body.plugin, { name: 'Plugin', min: 1, max: 20 });
    app.plugins.get(ctx.user, key);
    app.plugins.target(ctx.user, target);
    const enabled = bool(ctx.body.enabled);
    const prev = app.plugins.state(ctx.user, target)[key];
    app.plugins.setState(ctx.user, target, key, { installed: true, enabled });
    try {
      await app.plugins.apply(ctx.user, target);
    } catch (e) {
      app.plugins.setState(ctx.user, target, key, prev || { installed: true, enabled: !enabled });
      throw e;
    }
    return { plugins: pluginView(ctx.user, target) };
  });

  r.post('/api/plugins/config', async (ctx) => {
    const p = app.plugins.get(ctx.user, str(ctx.body.plugin, { name: 'Plugin', min: 1, max: 20 }));
    if (!p.config) throw bad('This plugin has no config file');
    const t = app.plugins.target(ctx.user, str(ctx.body.target, { name: 'Target', min: 1, max: 40 }));
    const file = p.config.replace(/^~\//, '$HOME/');
    const script = `f="${file}"; mkdir -p "$(dirname "$f")"; [ -f "$f" ] || touch "$f"; exec "\${EDITOR:-$(command -v nano || command -v vim || echo vi)}" "$f"`;
    const opts = { name: `${p.name} config · ${t.kind === 'local' ? 'local' : t.name}`, color: 'purple', script };
    const term = t.kind === 'local' ? await app.terms.create(ctx.user, { kind: 'local', ...opts }) : await app.terms.create(ctx.user, { kind: 'ssh', hostId: t.hostId, ...opts });
    return { term };
  });

  r.post('/api/plugins/custom', (ctx) => {
    const b = ctx.body;
    const bin = str(b.bin, { name: 'Command name', max: 64, optional: true, re: /^[A-Za-z0-9._+-]+$/ });
    const n = store.get('SELECT COUNT(*) AS n FROM custom_plugins WHERE user_id = ?', ctx.user.id).n;
    if (n >= 30) throw bad('Too many custom plugins');
    store.run(
      'INSERT INTO custom_plugins (user_id, name, bin, install, init_bash, init_zsh, created_at) VALUES (?,?,?,?,?,?,?)',
      ctx.user.id,
      str(b.name, { name: 'Name', min: 1, max: 40 }),
      bin,
      str(b.install, { name: 'Install command', min: 1, max: 4000, trim: false }),
      str(b.initBash, { name: 'Bash init', max: 1000, optional: true, trim: false }),
      str(b.initZsh, { name: 'Zsh init', max: 1000, optional: true, trim: false }),
      Date.now(),
    );
    const target = typeof b.target === 'string' ? b.target : null;
    return { plugins: target ? pluginView(ctx.user, target) : [] };
  });

  r.del('/api/plugins/custom/:id', (ctx) => {
    const id = int(ctx.params.id, { name: 'id' });
    const c = store.get('SELECT * FROM custom_plugins WHERE id = ? AND user_id = ?', id, ctx.user.id);
    if (!c) throw notFound();
    store.run('DELETE FROM custom_plugins WHERE id = ?', id);
    store.run('DELETE FROM plugin_state WHERE user_id = ? AND plugin = ?', ctx.user.id, 'c' + id);
  });

  // ================================================================ IDE
  r.get('/api/ide', (ctx) => app.ide.status(ctx.user));
  r.post('/api/ide/start', async (ctx) => {
    const s = await app.ide.start(ctx.user);
    app.audit(actor(ctx), 'ide.start');
    return s;
  });
  r.post('/api/ide/stop', async (ctx) => app.ide.stop(ctx.user));

  // ================================================================ admin
  function userToClient(u, online) {
    const t = store.get('SELECT COUNT(*) AS n, SUM(CASE WHEN ended_at IS NULL AND lost = 0 THEN 1 ELSE 0 END) AS alive FROM terminals WHERE user_id = ?', u.id);
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      linuxUser: u.linux_user,
      disabled: !!u.disabled,
      allowLocal: !!u.allow_local,
      allowIde: !!u.allow_ide,
      maxTerms: u.max_terms,
      createdAt: u.created_at,
      lastLogin: u.last_login,
      lastIp: u.last_ip,
      online: online.has(u.id),
      terminals: { total: t.n, alive: t.alive || 0 },
      credIds: store.all('SELECT cred_id FROM cred_access WHERE user_id = ?', u.id).map((c) => c.cred_id),
    };
  }
  const listUsers = () => {
    const online = app.hub.onlineUserIds();
    return store.all('SELECT * FROM users ORDER BY role, username COLLATE NOCASE').map((u) => userToClient(u, online));
  };
  const findUser = (ctx) => {
    const u = store.get('SELECT * FROM users WHERE id = ?', int(ctx.params.id, { name: 'id' }));
    if (!u) throw notFound('User not found');
    return u;
  };
  const enabledAdmins = () => store.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;
  function setUserCreds(userId, ids) {
    if (!Array.isArray(ids)) return;
    store.tx(() => {
      store.run('DELETE FROM cred_access WHERE user_id = ?', userId);
      for (const id of ids) {
        const cid = int(id, { name: 'credential' });
        if (store.get('SELECT id FROM creds WHERE id = ?', cid)) store.run('INSERT OR IGNORE INTO cred_access (cred_id, user_id) VALUES (?,?)', cid, userId);
      }
    });
  }

  r.get(
    '/api/admin/overview',
    () => {
      const users = listUsers();
      return {
        users,
        stats: {
          users: users.length,
          online: users.filter((u) => u.online).length,
          terminals: [...app.terms.live.values()].filter((l) => l.alive).length,
          failedLogins: store.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'login.fail' AND ts > ?", Date.now() - 86400_000).n,
        },
        creds: store.all('SELECT id, name, type FROM creds ORDER BY name COLLATE NOCASE'),
        ideAvailable: app.ide.available(),
      };
    },
    { admin: true },
  );

  r.get('/api/admin/accounts', async () => ({ accounts: (await app.broker.call({ op: 'accounts' })).accounts }), { admin: true });

  r.post(
    '/api/admin/users',
    async (ctx) => {
      const b = ctx.body;
      const username = str(b.username, { name: 'Username', min: 2, max: 32, re: USERNAME_RE });
      if (store.get('SELECT id FROM users WHERE username = ?', username)) throw bad('This username is taken');
      const p = passwordProblem(b.password);
      if (p) throw bad(p);
      const role = oneOf(b.role || 'user', ['admin', 'user'], 'Role');
      const mode = oneOf(b.linuxMode || 'create', ['create', 'existing', 'none'], 'Linux account');
      let linux = null;
      if (mode === 'create') {
        linux = ('wt-' + username.toLowerCase().replace(/[^a-z0-9_-]/g, '-')).slice(0, 32);
        await app.broker.call({ op: 'ensureUser', name: linux, create: true });
      } else if (mode === 'existing') {
        linux = str(b.linuxUser, { name: 'Linux account', min: 1, max: 32, re: LINUX_RE });
        await app.broker.call({ op: 'ensureUser', name: linux, create: false });
      }
      const res = store.run(
        'INSERT INTO users (username, pw, role, linux_user, allow_local, allow_ide, max_terms, created_at) VALUES (?,?,?,?,?,?,?,?)',
        username,
        await hashPassword(b.password),
        role,
        linux,
        linux && (b.allowLocal === undefined || bool(b.allowLocal)) ? 1 : 0,
        linux && (b.allowIde === undefined || bool(b.allowIde)) ? 1 : 0,
        int(b.maxTerms ?? 40, { name: 'Max terminals', min: 1, max: app.cfg.maxTerminalsPerUser }),
        Date.now(),
      );
      const id = Number(res.lastInsertRowid);
      setUserCreds(id, b.credIds || []);
      app.audit(actor(ctx), 'user.create', `${username} (${role}${linux ? ', linux ' + linux : ''})`);
      return { users: listUsers() };
    },
    { admin: true, limit: 8192 },
  );

  r.patch(
    '/api/admin/users/:id',
    async (ctx) => {
      const u = findUser(ctx);
      const b = ctx.body;
      const self = u.id === ctx.user.id;
      const sets = [];
      if (b.role !== undefined) {
        const role = oneOf(b.role, ['admin', 'user'], 'Role');
        if (self && role !== 'admin') throw bad('You cannot remove your own admin role');
        if (u.role === 'admin' && role !== 'admin' && enabledAdmins() <= 1) throw bad('At least one administrator is required');
        sets.push(['role', role]);
      }
      if (b.disabled !== undefined) {
        const d = bool(b.disabled);
        if (self && d) throw bad('You cannot disable your own account');
        if (d && u.role === 'admin' && !u.disabled && enabledAdmins() <= 1) throw bad('At least one administrator is required');
        sets.push(['disabled', d ? 1 : 0]);
      }
      if (b.allowLocal !== undefined) sets.push(['allow_local', bool(b.allowLocal) && u.linux_user ? 1 : 0]);
      if (b.allowIde !== undefined) sets.push(['allow_ide', bool(b.allowIde) && u.linux_user ? 1 : 0]);
      if (b.maxTerms !== undefined) sets.push(['max_terms', int(b.maxTerms, { name: 'Max terminals', min: 1, max: app.cfg.maxTerminalsPerUser })]);
      for (const [k, v] of sets) store.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, u.id);
      if (b.credIds !== undefined) setUserCreds(u.id, b.credIds);
      const after = store.get('SELECT * FROM users WHERE id = ?', u.id);
      if (after.disabled && !u.disabled) {
        app.auth.revokeUser(u.id);
        app.files.dropUser(u.id);
        app.desktops.dropUser(u.id);
        if (u.linux_user) app.ide.stop(after).catch(() => {});
      }
      if (after.linux_user !== u.linux_user || after.allow_local !== u.allow_local || b.credIds !== undefined) app.files.dropUser(u.id);
      if (after.role !== u.role) app.desktops.recheck((c) => c.userId === u.id);
      if (!after.allow_ide && u.allow_ide && u.linux_user) app.ide.stop(after).catch(() => {});
      app.audit(actor(ctx), 'user.update', `${u.username}: ${Object.keys(b).join(', ')}`);
      broadcastHosts();
      return { users: listUsers() };
    },
    { admin: true },
  );

  r.post(
    '/api/admin/users/:id/password',
    async (ctx) => {
      const u = findUser(ctx);
      const p = passwordProblem(ctx.body.password);
      if (p) throw bad(p);
      await app.auth.setPassword(u.id, ctx.body.password);
      app.auth.revokeUser(u.id, u.id === ctx.user.id ? ctx.sess.id : null);
      app.audit(actor(ctx), 'user.password', u.username);
    },
    { admin: true, limit: 4096 },
  );

  r.del(
    '/api/admin/users/:id/sessions',
    (ctx) => {
      const u = findUser(ctx);
      app.auth.revokeUser(u.id, u.id === ctx.user.id ? ctx.sess.id : null);
      app.audit(actor(ctx), 'user.signout', u.username);
      return { users: listUsers() };
    },
    { admin: true },
  );

  r.del(
    '/api/admin/users/:id',
    async (ctx) => {
      const u = findUser(ctx);
      if (u.id === ctx.user.id) throw bad('You cannot delete your own account');
      if (u.role === 'admin' && enabledAdmins() <= 1 && !u.disabled) throw bad('At least one administrator is required');
      for (const t of store.all('SELECT * FROM terminals WHERE user_id = ?', u.id)) await app.terms.destroy(t);
      app.auth.revokeUser(u.id);
      app.files.dropUser(u.id);
      app.desktops.dropUser(u.id);
      if (u.linux_user) {
        await app.ide.stop(u).catch(() => {});
        const others = store.get('SELECT COUNT(*) AS n FROM users WHERE linux_user = ? AND id != ?', u.linux_user, u.id).n;
        if (!others) await app.broker.call({ op: 'unlinkUser', name: u.linux_user }).catch(() => {});
      }
      store.run('DELETE FROM users WHERE id = ?', u.id);
      app.audit(actor(ctx), 'user.delete', u.username);
      return { users: listUsers() };
    },
    { admin: true },
  );

  r.get(
    '/api/admin/audit',
    (ctx) => {
      const limit = Math.min(Number(ctx.query.get('limit')) || 100, 500);
      const before = Number(ctx.query.get('before')) || Number.MAX_SAFE_INTEGER;
      const q = (ctx.query.get('q') || '').slice(0, 60);
      const rows = q
        ? store.all("SELECT * FROM audit WHERE id < ? AND (action LIKE ? OR username LIKE ? OR detail LIKE ?) ORDER BY id DESC LIMIT ?", before, `%${q}%`, `%${q}%`, `%${q}%`, limit)
        : store.all('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?', before, limit);
      return { entries: rows.map((a) => ({ id: a.id, ts: a.ts, username: a.username, ip: a.ip, action: a.action, detail: a.detail })) };
    },
    { admin: true },
  );

  // ================================================================ files
  fileRoutes(r, app);

  return r;
}

// Terminal appearance settings: only known keys with sane values are kept.
const THEMES = ['phosphor', 'dracula', 'nord', 'solarized', 'onedark', 'github', 'light', 'custom'];
export function cleanSettings(s) {
  if (!s || typeof s !== 'object') throw bad('Invalid settings');
  const out = {};
  const num = (k, lo, hi) => {
    const n = Number(s[k]);
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, n));
  };
  if (THEMES.includes(s.theme)) out.theme = s.theme;
  if (typeof s.fontFamily === 'string' && /^[A-Za-z0-9 ,'"._-]{1,120}$/.test(s.fontFamily)) out.fontFamily = s.fontFamily;
  num('fontSize', 8, 32);
  num('lineHeight', 1, 2);
  num('scrollback', 500, 50000);
  num('mobileFontSize', 8, 24);
  if (['block', 'bar', 'underline'].includes(s.cursorStyle)) out.cursorStyle = s.cursorStyle;
  for (const k of ['cursorBlink', 'webgl', 'copyOnSelect', 'rightClickPaste', 'bell', 'confirmClose']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (s.customTheme && typeof s.customTheme === 'object') {
    const ct = {};
    for (const [k, v] of Object.entries(s.customTheme)) {
      if (/^[a-zA-Z]{2,24}$/.test(k) && typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ct[k] = v;
    }
    out.customTheme = ct;
  }
  return out;
}

export { COLORS };
