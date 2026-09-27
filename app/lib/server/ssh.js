// Builds ssh invocations that run as the dedicated SSH runner account.
// Secrets never touch the command line: the broker materialises them as
// one-time files ({file:key}/{file:pw}) readable only by that account.
import { bad } from './http.js';

export const ADDRESS_RE = /^(?!-)[A-Za-z0-9._:%-]{1,253}$/;
export const SSH_USER_RE = /^(?!-)[A-Za-z0-9._@-]{1,64}$/;

export function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Expression for a directory on the remote side, honouring a leading ~.
export function remoteDir(cwd) {
  const d = (cwd || '').trim();
  if (!d || d === '~') return '"$HOME"';
  if (d.startsWith('~/')) return '"$HOME"/' + sq(d.slice(2));
  return sq(d);
}

export function credFiles(app, cred) {
  const secret = app.vault.open(cred.secret);
  if (cred.type === 'key') {
    const pem = secret.endsWith('\n') ? secret : secret + '\n';
    return { files: [{ name: 'key', content: Buffer.from(pem).toString('base64') }], env: {} };
  }
  return {
    files: [{ name: 'pw', content: Buffer.from(secret).toString('base64') }],
    env: { SSH_ASKPASS: app.cfg.askpass, SSH_ASKPASS_REQUIRE: 'force', WT_ASKPASS_FILE: '{file:pw}' },
  };
}

export function commonOpts(app) {
  const known = `${app.cfg.sshHome}/known_hosts`;
  return [
    ['StrictHostKeyChecking', 'accept-new'],
    ['UserKnownHostsFile', known],
    ['GlobalKnownHostsFile', '/dev/null'],
    ['ServerAliveInterval', '30'],
    ['ServerAliveCountMax', '4'],
    ['ConnectTimeout', '15'],
    ['ForwardAgent', 'no'],
    ['ForwardX11', 'no'],
    ['ClearAllForwardings', 'yes'],
    ['PermitLocalCommand', 'no'],
    ['ControlMaster', 'no'],
    ['ControlPath', 'none'],
    ['UpdateHostKeys', 'no'],
    ['IdentityAgent', 'none'],
    ['LogLevel', 'ERROR'],
  ];
}

export function sshArgv(app, host, cred, { tty = true, batch = false, remoteCommand = null, subsystem = null } = {}) {
  if (!cred) throw bad(`Host "${host.name}" has no credential assigned`);
  if (!ADDRESS_RE.test(host.address) || !SSH_USER_RE.test(host.username)) throw bad('Host address or user is invalid');
  const a = [app.cfg.ssh, '-F', '/dev/null', '-e', 'none', tty ? '-tt' : '-T'];
  const o = (k, v) => a.push('-o', `${k}=${v}`);
  for (const [k, v] of commonOpts(app)) o(k, v);
  if (cred.type === 'key') {
    o('IdentitiesOnly', 'yes');
    o('PasswordAuthentication', 'no');
    o('KbdInteractiveAuthentication', 'no');
    if (batch) o('BatchMode', 'yes');
    a.push('-i', '{file:key}');
  } else {
    o('PubkeyAuthentication', 'no');
    o('PreferredAuthentications', 'password,keyboard-interactive');
    o('NumberOfPasswordPrompts', '1');
  }
  if (subsystem) a.push('-s');
  a.push('-p', String(host.port), '-l', host.username, '--', host.address);
  if (subsystem) a.push(subsystem);
  else if (remoteCommand) a.push(remoteCommand);
  return a;
}

// Remote command that attaches (or creates) a tmux session so work continues
// on the remote machine even if the network drops.
export function remoteTmuxCommand(name, cwd) {
  const dir = remoteDir(cwd);
  const script =
    `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${name} -c ${dir}; ` +
    `else echo "[webterm] tmux is not installed on this host - continuing without it."; cd ${dir} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l; fi`;
  return 'sh -c ' + sq(script);
}

export function remoteCwdCommand(cwd) {
  return 'sh -c ' + sq(`cd ${remoteDir(cwd)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`);
}

// `sh -c SCRIPT sh ARG…` as one remote command line, every part single-quoted.
export function remoteShCommand(script, args = []) {
  return ['sh', '-c', sq(script), 'sh', ...args.map(sq)].join(' ');
}

// Runs a (possibly long, multi-line) bash script remotely without quoting pitfalls.
export function remoteScriptCommand(script) {
  const b64 = Buffer.from(script).toString('base64').replace(/\n/g, '');
  return 'sh -c ' + sq(`f="$HOME/.webterm-task.$$"; echo ${b64} | base64 -d > "$f" && bash "$f"; rc=$?; rm -f "$f"; exit $rc`);
}
