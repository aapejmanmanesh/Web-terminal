// Shared configuration loader. Values come from /etc/webterm/config.json
// (or $WEBTERM_CONFIG) merged over these defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const defaults = {
  dataDir: '/var/lib/webterm',
  brokerSocket: '/run/webterm/broker.sock',
  ideRunDir: '/run/webterm-ide',
  serviceUser: 'webterm',
  serviceGroup: 'webterm',
  usersGroup: 'webterm-users',
  sshUser: 'webterm-ssh',
  sshHome: '/var/lib/webterm-ssh',
  listen: { host: '0.0.0.0', port: 8443 },
  tls: { cert: '/etc/webterm/tls/cert.pem', key: '/etc/webterm/tls/key.pem' },
  trustProxy: false,
  hsts: false,
  allowedOrigins: [],
  sessionDays: 30,
  scrollback: 10000,
  maxTerminalsPerUser: 60,
  codeServer: '/usr/bin/code-server',
  setpriv: '/usr/bin/setpriv',
  ssh: '/usr/bin/ssh',
  sshKeygen: '/usr/bin/ssh-keygen',
  sshCopyId: '/usr/bin/ssh-copy-id',
  ping: '/usr/bin/ping',
  sftpServer: '/usr/lib/openssh/sftp-server',
  hostname: os.hostname(),
};

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') out[k] = merge(a[k], v);
    else out[k] = v;
  }
  return out;
}

export function loadConfig() {
  const file = process.env.WEBTERM_CONFIG || '/etc/webterm/config.json';
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = merge(defaults, user);
  cfg.appDir = APP_DIR;
  cfg.wtExec = path.join(APP_DIR, 'bin/wt-exec');
  cfg.askpass = path.join(APP_DIR, 'bin/wt-askpass');
  cfg.sshRunDir = path.join(cfg.sshHome, 'run');
  cfg.configFile = file;
  return cfg;
}
