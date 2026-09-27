#!/usr/bin/env node
// WebTerm administration CLI (run as root).
//   webterm-admin create-admin <username> --linux-user <account> [--create-linux]   (password on stdin)
//   webterm-admin reset-password <username>                                         (password on stdin)
//   webterm-admin list-users
// Database work is done as the service account so file ownership stays correct.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../lib/common/config.js';

const cfg = loadConfig();
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const flag = (name) => args.includes(name);
const die = (msg) => {
  console.error('error: ' + msg);
  process.exit(1);
};

async function readPassword(prompt) {
  if (process.env.WEBTERM_PASSWORD) return process.env.WEBTERM_PASSWORD;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.includes(prompt)) process.stdout.write(s);
  };
  const a = await new Promise((r) => rl.question(prompt, r));
  process.stdout.write('\n');
  const b = await new Promise((r) => rl.question('Repeat: ', r));
  process.stdout.write('\n');
  rl.close();
  if (a !== b) die('passwords do not match');
  return a;
}

function asService(extraEnv) {
  // Re-run this script as the service user for database access.
  const node = process.execPath;
  const r = spawnSync(
    cfg.setpriv,
    ['--reuid', cfg.serviceUser, '--regid', cfg.serviceGroup, '--init-groups', '--', node, '--disable-warning=ExperimentalWarning', process.argv[1], ...args],
    { stdio: 'inherit', env: { ...process.env, ...extraEnv, WEBTERM_ADMIN_STAGE: 'db' } },
  );
  process.exit(r.status ?? 1);
}

async function dbStage() {
  const { Store } = await import('../lib/server/db.js');
  const { hashPassword, passwordProblem } = await import('../lib/server/security.js');
  const store = new Store(path.join(cfg.dataDir, 'webterm.db'));
  const now = Date.now();
  if (cmd === 'list-users') {
    for (const u of store.all('SELECT username, role, linux_user, disabled FROM users ORDER BY id')) {
      console.log(`${u.username.padEnd(20)} ${u.role.padEnd(6)} ${String(u.linux_user || '-').padEnd(16)} ${u.disabled ? 'disabled' : ''}`);
    }
    return;
  }
  const username = args[1];
  const pw = process.env.WEBTERM_PASSWORD;
  const problem = passwordProblem(pw);
  if (problem) die(problem);
  const hash = await hashPassword(pw);
  if (cmd === 'create-admin') {
    const linux = process.env.WEBTERM_LINUX_USER;
    const existing = store.get('SELECT * FROM users WHERE username = ?', username);
    if (existing) {
      store.run("UPDATE users SET pw = ?, role = 'admin', disabled = 0, linux_user = ?, allow_local = 1, allow_ide = 1 WHERE id = ?", hash, linux, existing.id);
      store.run('DELETE FROM auth_sessions WHERE user_id = ?', existing.id);
      console.log(`Updated administrator ${username}`);
    } else {
      store.run("INSERT INTO users (username, pw, role, linux_user, allow_local, allow_ide, created_at) VALUES (?,?, 'admin', ?, 1, 1, ?)", username, hash, linux, now);
      console.log(`Created administrator ${username}`);
    }
    store.run('INSERT INTO audit (ts, username, action, detail) VALUES (?,?,?,?)', now, 'cli', 'user.create-admin', username);
  } else if (cmd === 'reset-password') {
    const u = store.get('SELECT * FROM users WHERE username = ?', username);
    if (!u) die(`no such user ${username}`);
    store.run('UPDATE users SET pw = ?, disabled = 0 WHERE id = ?', hash, u.id);
    store.run('DELETE FROM auth_sessions WHERE user_id = ?', u.id);
    store.run('INSERT INTO audit (ts, username, action, detail) VALUES (?,?,?,?)', now, 'cli', 'user.password', username);
    console.log(`Password reset for ${username}`);
  }
  store.close();
}

async function main() {
  if (process.env.WEBTERM_ADMIN_STAGE === 'db') return dbStage();
  if (!cmd || !['create-admin', 'reset-password', 'list-users'].includes(cmd)) {
    console.log('usage:\n  webterm-admin create-admin <username> --linux-user <account> [--create-linux]\n  webterm-admin reset-password <username>\n  webterm-admin list-users');
    process.exit(cmd ? 1 : 0);
  }
  if (process.getuid() !== 0) die('run as root (sudo)');
  if (cmd === 'list-users') return asService({});
  const username = args[1];
  if (!username || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(username)) die('invalid username');
  const env = {};
  if (cmd === 'create-admin') {
    const linux = opt('--linux-user');
    if (!linux || !/^[a-z_][a-z0-9_-]{0,31}$/.test(linux) || ['root', cfg.serviceUser, cfg.sshUser].includes(linux)) die('--linux-user <account> is required (not root)');
    let exists = true;
    try {
      execFileSync('id', ['-u', linux], { stdio: 'ignore' });
    } catch {
      exists = false;
    }
    if (!exists) {
      if (!flag('--create-linux')) die(`Linux account ${linux} does not exist (add --create-linux to create it)`);
      execFileSync('useradd', ['--create-home', '--shell', '/bin/bash', linux], { stdio: 'inherit' });
    }
    const uid = Number(execFileSync('id', ['-u', linux], { encoding: 'utf8' }).trim());
    if (uid < 1000) die(`${linux} is a system account`);
    execFileSync('gpasswd', ['--add', linux, cfg.usersGroup], { stdio: 'ignore' });
    env.WEBTERM_LINUX_USER = linux;
  }
  env.WEBTERM_PASSWORD = await readPassword('Password: ');
  asService(env);
}

main().catch((e) => die(e.message));
