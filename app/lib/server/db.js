// SQLite storage (node:sqlite, built into Node 22 — no native addon needed).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    linux_user TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    allow_local INTEGER NOT NULL DEFAULT 1,
    allow_ide INTEGER NOT NULL DEFAULT 1,
    max_terms INTEGER NOT NULL DEFAULT 40,
    settings TEXT NOT NULL DEFAULT '{}',
    ui TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    last_ip TEXT
  );
  CREATE TABLE auth_sessions (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    persistent INTEGER NOT NULL DEFAULT 1,
    ip TEXT,
    ua TEXT
  );
  CREATE TABLE creds (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    type TEXT NOT NULL CHECK (type IN ('key','password')),
    public_key TEXT,
    fingerprint TEXT,
    secret TEXT NOT NULL,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_used_by TEXT
  );
  CREATE TABLE cred_access (
    cred_id INTEGER NOT NULL REFERENCES creds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (cred_id, user_id)
  );
  CREATE TABLE hosts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    address TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    cred_id INTEGER REFERENCES creds(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    kind TEXT NOT NULL,
    host_id INTEGER,
    preset_id INTEGER,
    spec TEXT NOT NULL,
    color TEXT,
    notify INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    lost INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX terminals_user ON terminals(user_id);
  CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    pos INTEGER NOT NULL DEFAULT 0,
    layout TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX workspaces_user ON workspaces(user_id);
  CREATE TABLE presets (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local','ssh')),
    host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
    cwd TEXT,
    commands TEXT NOT NULL DEFAULT '',
    remote_tmux INTEGER NOT NULL DEFAULT 0,
    open_as TEXT NOT NULL DEFAULT 'right',
    color TEXT NOT NULL DEFAULT 'green',
    notify INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE systems (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    mac TEXT,
    broadcast TEXT,
    interval INTEGER NOT NULL DEFAULT 30,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE plugin_state (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target TEXT NOT NULL,
    plugin TEXT NOT NULL,
    installed INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, target, plugin)
  );
  CREATE TABLE custom_plugins (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    bin TEXT,
    install TEXT NOT NULL,
    init_bash TEXT,
    init_zsh TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX audit_ts ON audit(ts);
  `,
  `
  ALTER TABLE systems ADD COLUMN vnc_port INTEGER;
  ALTER TABLE systems ADD COLUMN vnc_secret TEXT;
  ALTER TABLE systems ADD COLUMN vnc_access TEXT NOT NULL DEFAULT 'admins';
  `,
  `
  ALTER TABLE systems ADD COLUMN rdp_port INTEGER;
  ALTER TABLE systems ADD COLUMN rdp_user TEXT;
  ALTER TABLE systems ADD COLUMN rdp_domain TEXT;
  ALTER TABLE systems ADD COLUMN rdp_secret TEXT;
  `,
];

export class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.cache = new Map();
    this.migrate();
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
  get(sql, ...p) {
    return this.stmt(sql).get(...p);
  }
  all(sql, ...p) {
    return this.stmt(sql).all(...p);
  }
  run(sql, ...p) {
    return this.stmt(sql).run(...p);
  }
  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
