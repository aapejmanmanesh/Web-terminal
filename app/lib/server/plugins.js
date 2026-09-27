// Shell plugins: small tools that live in the user's shell (IRIS, fzf, ...).
// Installing runs in a visible terminal so progress and prompts (e.g. sudo)
// are shown. Enabling writes ~/.config/webterm/plugins.sh and a guarded
// block in ~/.bashrc / ~/.zshrc that sources it.
import { bad, notFound } from './http.js';
import { sshArgv, credFiles } from './ssh.js';

export const CATALOG = {
  iris: {
    name: 'IRIS',
    desc: 'IntelliSense-style command suggestions',
    bin: 'iris',
    install: 'curl -fsSL https://raw.githubusercontent.com/versenilvis/iris/main/scripts/install.sh | BIN_DIR="$HOME/.local/bin" sh',
    uninstall: 'rm -f "$HOME/.local/bin/iris"',
    init: { bash: 'eval "$(iris init bash)"', zsh: 'eval "$(iris init zsh)"' },
    config: '~/.config/iris/config.toml',
    url: 'https://github.com/versenilvis/IRIS',
  },
  fzf: {
    name: 'fzf',
    desc: 'Fuzzy finder · Ctrl-R history, Ctrl-T files',
    bin: 'fzf',
    install: 'if [ -d "$HOME/.fzf/.git" ]; then git -C "$HOME/.fzf" pull --ff-only; else rm -rf "$HOME/.fzf"; git clone --depth 1 https://github.com/junegunn/fzf.git "$HOME/.fzf"; fi\n"$HOME/.fzf/install" --bin',
    uninstall: 'rm -rf "$HOME/.fzf"',
    init: { bash: 'eval "$(fzf --bash)"', zsh: 'source <(fzf --zsh)' },
    url: 'https://github.com/junegunn/fzf',
  },
  zoxide: {
    name: 'zoxide',
    desc: 'Smarter cd — jump anywhere with z',
    bin: 'zoxide',
    install: 'curl -fsSL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh',
    uninstall: 'rm -f "$HOME/.local/bin/zoxide"',
    init: { bash: 'eval "$(zoxide init bash)"', zsh: 'eval "$(zoxide init zsh)"' },
    url: 'https://github.com/ajeetdsouza/zoxide',
  },
  starship: {
    name: 'Starship',
    desc: 'Fast, informative prompt',
    bin: 'starship',
    install: 'mkdir -p "$HOME/.local/bin"\ncurl -fsSL https://starship.rs/install.sh | sh -s -- -y -b "$HOME/.local/bin"',
    uninstall: 'rm -f "$HOME/.local/bin/starship"',
    init: { bash: 'eval "$(starship init bash)"', zsh: 'eval "$(starship init zsh)"' },
    config: '~/.config/starship.toml',
    url: 'https://starship.rs',
  },
};

const BIN_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const PATHS = '"$HOME/.local/bin" "$HOME/.fzf/bin" "$HOME/bin" "$HOME/go/bin" "$HOME/.cargo/bin"';

export class Plugins {
  constructor(app) {
    this.app = app;
  }

  all(user) {
    const list = Object.entries(CATALOG).map(([key, p]) => ({ key, custom: false, ...p }));
    for (const c of this.app.store.all('SELECT * FROM custom_plugins WHERE user_id = ? ORDER BY id', user.id)) {
      list.push({
        key: 'c' + c.id,
        custom: true,
        id: c.id,
        name: c.name,
        desc: 'Custom plugin',
        bin: c.bin,
        install: c.install,
        uninstall: c.bin ? `rm -f "$HOME/.local/bin/${c.bin}"` : '',
        init: { bash: c.init_bash || '', zsh: c.init_zsh || '' },
      });
    }
    return list;
  }

  get(user, key) {
    const p = this.all(user).find((x) => x.key === key);
    if (!p) throw notFound('Unknown plugin');
    return p;
  }

  targets(user) {
    const t = [];
    if (user.allow_local && user.linux_user) t.push({ id: 'local', name: `${this.app.cfg.hostname} (this server)`, kind: 'local' });
    const hosts =
      user.role === 'admin'
        ? this.app.store.all('SELECT * FROM hosts WHERE cred_id IS NOT NULL ORDER BY name COLLATE NOCASE')
        : this.app.store.all('SELECT h.* FROM hosts h JOIN cred_access a ON a.cred_id = h.cred_id WHERE a.user_id = ? ORDER BY h.name COLLATE NOCASE', user.id);
    for (const h of hosts) t.push({ id: 'host:' + h.id, name: h.name, kind: 'ssh', hostId: h.id });
    return t;
  }

  target(user, id) {
    const t = this.targets(user).find((x) => x.id === id);
    if (!t) throw bad('Unknown target');
    return t;
  }

  state(user, target) {
    const rows = this.app.store.all('SELECT * FROM plugin_state WHERE user_id = ? AND target = ?', user.id, target);
    return Object.fromEntries(rows.map((r) => [r.plugin, { installed: !!r.installed, enabled: !!r.enabled, updatedAt: r.updated_at }]));
  }

  setState(user, target, plugin, patch) {
    const cur = this.state(user, target)[plugin] || { installed: false, enabled: false };
    const next = { ...cur, ...patch };
    this.app.store.run(
      `INSERT INTO plugin_state (user_id, target, plugin, installed, enabled, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id, target, plugin) DO UPDATE SET installed = excluded.installed, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      user.id,
      target,
      plugin,
      next.installed ? 1 : 0,
      next.enabled ? 1 : 0,
      Date.now(),
    );
  }

  // Script that writes plugins.sh for the enabled plugins and hooks it into rc files.
  applyScript(user, target) {
    const st = this.state(user, target);
    const enabled = this.all(user).filter((p) => st[p.key] && st[p.key].enabled);
    const lines = (sh) =>
      enabled
        .filter((p) => p.init[sh])
        .map((p) => (p.bin && BIN_RE.test(p.bin) ? `command -v ${p.bin} >/dev/null 2>&1 && { ${p.init[sh]}; }` : p.init[sh]))
        .join('\n  ');
    const body = `# Generated by WebTerm. Manage plugins from the Plugins panel.
case $- in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
for __wt_p in ${PATHS}; do
  case ":$PATH:" in *":$__wt_p:"*) ;; *) [ -d "$__wt_p" ] && PATH="$__wt_p:$PATH" ;; esac
done
unset __wt_p
export PATH
if [ -n "$BASH_VERSION" ]; then
  ${lines('bash') || ':'}
elif [ -n "$ZSH_VERSION" ]; then
  ${lines('zsh') || ':'}
fi
`;
    return `set -e
mkdir -p "$HOME/.config/webterm"
cat > "$HOME/.config/webterm/plugins.sh" <<'__WEBTERM_EOF__'
${body}__WEBTERM_EOF__
[ -f "$HOME/.bashrc" ] || touch "$HOME/.bashrc"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  if ! grep -q '>>> webterm plugins >>>' "$rc"; then
    printf '\\n# >>> webterm plugins >>>\\n[ -f "$HOME/.config/webterm/plugins.sh" ] && . "$HOME/.config/webterm/plugins.sh"\\n# <<< webterm plugins <<<\\n' >> "$rc"
  fi
done
echo applied
`;
  }

  checkScript(user) {
    const bins = this.all(user)
      .filter((p) => p.bin && BIN_RE.test(p.bin))
      .map((p) => `${p.key}:${p.bin}`)
      .join(' ');
    return `for pair in ${bins}; do
  key="\${pair%%:*}"; bin="\${pair#*:}"
  found=
  command -v "$bin" >/dev/null 2>&1 && found=1
  for d in ${PATHS}; do [ -x "$d/$bin" ] && found=1; done
  [ -n "$found" ] && echo "$key"
done
exit 0
`;
  }

  // Runs a short non-interactive script on a target and returns stdout.
  async runScript(user, targetId, script, timeout = 30) {
    const t = this.target(user, targetId);
    if (t.kind === 'local') {
      const r = await this.app.broker.call({ op: 'exec', user: user.linux_user, argv: ['/bin/bash', '-s'], stdin: script, timeout }, (timeout + 5) * 1000);
      return r;
    }
    const { host, cred } = this.app.terms.accessibleHost(user, t.hostId);
    const argv = sshArgv(this.app, host, cred, { tty: false, batch: true, remoteCommand: 'bash -s' });
    const { files, env } = credFiles(this.app, cred);
    return this.app.broker.call({ op: 'exec', user: this.app.cfg.sshUser, argv, files, env, stdin: script, timeout }, (timeout + 5) * 1000);
  }

  async check(user, targetId) {
    const r = await this.runScript(user, targetId, this.checkScript(user), 25);
    if (r.code !== 0) throw bad((r.stderr || 'check failed').trim().slice(0, 300));
    const found = new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    const st = this.state(user, targetId);
    for (const p of this.all(user)) {
      if (!p.bin) continue;
      const installed = found.has(p.key);
      const cur = st[p.key];
      if (!cur || cur.installed !== installed) this.setState(user, targetId, p.key, { installed, enabled: installed ? (cur ? cur.enabled : false) : false });
    }
    return this.state(user, targetId);
  }

  async apply(user, targetId) {
    const r = await this.runScript(user, targetId, this.applyScript(user, targetId), 30);
    if (r.code !== 0) throw bad(('Could not update shell config: ' + (r.stderr || r.stdout)).trim().slice(0, 400));
  }

  installScript(p, { uninstall = false } = {}) {
    const action = uninstall ? 'Removing' : 'Installing';
    const cmd = uninstall ? p.uninstall || 'true' : p.install;
    return `set -o pipefail
export PATH="$HOME/.local/bin:$PATH"
printf '\\033[1;32m▶ ${action} ${p.name.replace(/[^A-Za-z0-9 ._-]/g, '')}\\033[0m\\n\\n'
set -e
${cmd}
set +e
printf '\\n\\033[1;32m✓ Done.\\033[0m This window can be closed.\\n'
`;
  }

  // Opens a terminal that installs (or removes) a plugin on a target.
  async runInstall(user, key, targetId, { uninstall = false } = {}) {
    const p = this.get(user, key);
    const t = this.target(user, targetId);
    const script = this.installScript(p, { uninstall });
    const opts = {
      name: `${uninstall ? 'Remove' : 'Install'} ${p.name} · ${t.kind === 'local' ? 'local' : t.name}`,
      color: 'purple',
      script,
      task: { type: uninstall ? 'plugin-remove' : 'plugin-install', plugin: key, target: targetId },
    };
    if (t.kind === 'local') return this.app.terms.create(user, { kind: 'local', ...opts });
    return this.app.terms.create(user, { kind: 'ssh', hostId: t.hostId, ...opts });
  }

  // Called when a task terminal exits.
  async onTaskExit(row, code) {
    const spec = JSON.parse(row.spec);
    const task = spec.task;
    if (!task || !task.type || !task.type.startsWith('plugin-')) return;
    const user = this.app.store.get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) return;
    try {
      if (task.type === 'plugin-install' && code === 0) {
        this.setState(user, task.target, task.plugin, { installed: true, enabled: true });
        await this.apply(user, task.target);
      } else if (task.type === 'plugin-remove' && code === 0) {
        this.setState(user, task.target, task.plugin, { installed: false, enabled: false });
        await this.apply(user, task.target);
      }
    } catch (e) {
      this.app.log('plugin task follow-up failed', e.message);
    }
    this.app.hub.emitUser(user.id, { t: 'plugins', target: task.target });
  }
}
