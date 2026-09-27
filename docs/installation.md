# Installation

- [Requirements](#requirements)
- [Install](#install)
- [Installer options](#installer-options)
- [What the installer does](#what-the-installer-does)
- [Files, services and accounts](#files-services-and-accounts)
- [Upgrade](#upgrade)
- [Uninstall](#uninstall)

## Requirements

| | |
|---|---|
| Operating system | Ubuntu 22.04 or 24.04, Debian 12. Other systemd + apt distributions may work. |
| CPU | x86_64 (everything is bundled in the release) or arm64 (Node.js is downloaded and the terminal module is compiled during install) |
| Memory | 1 GB is enough for a few users. Add ~0.5–1 GB per concurrent IDE (code-server) user. |
| Access | `root` (run the installer with `sudo`) |
| Network | Outbound HTTPS during install (apt, and optionally Let's Encrypt, code-server, Node.js on arm64) |
| Ports | **80 + 443** when served on a domain with Let's Encrypt, otherwise **8443** (configurable) |

## Install

1. Download `webterm-<version>.tar.xz` from the
   [Releases page](https://github.com/aapejmanmanesh/Web-terminal/releases) and unpack it on the server:

   ```bash
   tar -xJf webterm-1.3.1.tar.xz
   cd webterm-1.3.1
   sudo ./install.sh
   ```

   Optionally verify the download first: `sha256sum -c webterm-1.3.1.tar.xz.sha256`.

2. Answer the questions (fresh installs only):

   - **Administrator username and password.** There is no built-in account. You choose the first
     administrator's name. The password needs at least 10 characters and is typed twice.
   - **HTTPS certificate.** Let's Encrypt for your domain, your own certificate files, or
     self-signed. See [HTTPS](https.md).

3. Open the address the installer prints and sign in.

The questions are read from the terminal, so they also work when the script is piped
(`curl … | sudo bash`). Without a terminal, set `ADMIN_USER` and `ADMIN_PASS` (and optionally the HTTPS
variables below); otherwise the installer stops and tells you what to set.

### Installing from a Git clone

```bash
git clone https://github.com/aapejmanmanesh/Web-terminal.git
cd Web-terminal
sudo ./install.sh
```

A clone doesn't contain the Node.js runtime or the compiled terminal module (`node-pty`), so the
installer downloads Node.js 22 from nodejs.org, installs `build-essential` and `python3`, and compiles
the module. This takes a minute or two longer than installing from a release.

## Installer options

```text
sudo ./install.sh             install, or upgrade an existing installation
sudo ./install.sh --https     upgrade and choose the HTTPS certificate again
sudo ./install.sh --help      show the built-in help
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_USER` | *(asked)* | First administrator's user name (2–32 characters: letters, digits, `.`, `_`, `-`). Only used on a fresh install. |
| `ADMIN_PASS` | *(asked)* | Its password (10+ characters) |
| `ADMIN_LINUX` | the user who ran `sudo` | Linux account the administrator's terminals run as. If empty or `root`, a new account `wt-<username>` is created. |
| `DOMAIN` | *(asked)* | Serve WebTerm through nginx on this domain (HTTPS on 443). Skips the HTTPS question. |
| `EMAIL` | *(asked)* | E-mail address for Let's Encrypt expiry notices |
| `CERTBOT` | `1` | `0` = don't request a Let's Encrypt certificate in domain mode |
| `NGINX` | `1` | `0` = don't configure nginx; the site file is written to `/etc/webterm/nginx-webterm.conf` for you to include in your own web server |
| `TLS_CERT`, `TLS_KEY` | | Your own PEM certificate (full chain) and private key. With `DOMAIN`: used by nginx. Without: WebTerm serves them itself on `PORT`. |
| `TLS_SELF_SIGNED` | | `1` = use a self-signed certificate without asking |
| `PORT` | `8443` (direct) / `8080` (domain mode, local only) | Port WebTerm listens on |
| `WITH_IDE` | `1` | `0` = don't install code-server (the IDE) |
| `WITH_RDP` | `1` | `0` = don't build RDP support (guacd) |
| `RESTART_BROKER` | *(ask)* | `1` = on upgrade, restart the terminal broker without asking if it changed |

Examples:

```bash
# Unattended, Let's Encrypt on a domain
sudo ADMIN_USER=alice ADMIN_PASS='correct horse battery' \
     DOMAIN=term.example.com EMAIL=admin@example.com ./install.sh

# Unattended, own certificate served directly on port 443
sudo ADMIN_USER=alice ADMIN_PASS='correct horse battery' \
     TLS_CERT=/root/certs/fullchain.pem TLS_KEY=/root/certs/privkey.pem PORT=443 ./install.sh

# No IDE, no RDP, self-signed on the default port
sudo WITH_IDE=0 WITH_RDP=0 ./install.sh
```

## What the installer does

1. Asks for the administrator and HTTPS setup (fresh installs, or `--https`).
2. Installs system packages: `ca-certificates curl openssl openssh-client openssh-sftp-server util-linux iputils-ping tmux git xz-utils`,
   plus `nginx` and `certbot` in domain mode.
3. Installs the Node.js 22 runtime to `/opt/webterm/node` (bundled on x86_64, downloaded and checksum-verified otherwise).
4. Creates the service accounts (`webterm`, `webterm-ssh`) and the `webterm-users` group.
5. Copies the application to `/opt/webterm/app` (atomically, so a failed upgrade leaves the old version working)
   and compiles `node-pty` if the bundled build doesn't fit this machine.
6. Creates `/etc/webterm/config.json` and the TLS certificate (self-signed, or yours).
7. Installs the systemd services `webterm-broker` and `webterm`.
8. Installs code-server for the IDE (unless `WITH_IDE=0`). If the download fails, WebTerm works without the IDE.
9. Builds guacd 1.6.1 (RDP support) from the bundled source into `/opt/webterm/guacd` and installs
   `webterm-guacd` (unless `WITH_RDP=0`). If the build fails, everything except RDP works.
10. Opens the needed ports in `ufw` if it's active.
11. Starts the services and creates the administrator.
12. In domain mode: writes the nginx site, requests the Let's Encrypt certificate and sets up automatic retries if needed.
13. Prints the address, the certificate in use, and where the logs are.

## Files, services and accounts

| Path | Contents |
|---|---|
| `/opt/webterm/app` | The application (server, broker, admin tool, web UI) |
| `/opt/webterm/node` | Node.js runtime |
| `/opt/webterm/guacd` | RDP proxy (guacd), if built |
| `/etc/webterm/config.json` | Configuration, see [Administration → Configuration file](administration.md#configuration-file) |
| `/etc/webterm/tls/` | Certificates (self-signed, your own, or the temporary one used before Let's Encrypt succeeds) |
| `/var/lib/webterm/webterm.db` | Database: users, sessions, presets, hosts, systems, audit log (SQLite) |
| `/var/lib/webterm/master.key` | Key that encrypts the Vault's secrets. **Back it up together with the database.** |
| `/var/lib/webterm-ssh/` | Home of the SSH runner account: pinned host keys (`known_hosts`) |
| `/run/webterm/broker.sock` | Socket between web server and broker (root:webterm, 0660) |
| `/usr/local/sbin/webterm-admin` | Command-line administration, see [Administration](administration.md#command-line-webterm-admin) |
| `/usr/local/sbin/webterm-cert` | Domain mode: gets the Let's Encrypt certificate and switches nginx to it |
| `/etc/nginx/sites-available/webterm.conf` | Domain mode: the nginx site |

| systemd unit | Runs as | Purpose |
|---|---|---|
| `webterm-broker.service` | root | Owns all terminal processes; starts them as the users' Linux accounts |
| `webterm.service` | `webterm` | Web server, API, WebSockets (sandboxed: read-only system, private /tmp, no new privileges) |
| `webterm-guacd.service` | dynamic user | RDP proxy on 127.0.0.1:4822 |
| `webterm-cert.timer` | root | Domain mode, only while Let's Encrypt hasn't issued the certificate yet: retries hourly |

| Account / group | Purpose |
|---|---|
| `webterm` (system user) | Runs the web server |
| `webterm-ssh` (system user) | Runs SSH connections that use shared Vault credentials, so users never see the private keys |
| `webterm-users` (group) | Linux accounts WebTerm may start shells as. The broker refuses any account outside this group. |
| `wt-<name>` | Linux accounts created for WebTerm users (optional; you can map users to existing accounts) |

Logs:

```bash
journalctl -u webterm -u webterm-broker -f      # web server and broker
journalctl -u webterm-guacd                     # RDP proxy
cat /var/log/webterm-cert.log                   # Let's Encrypt attempts (domain mode)
```

## Upgrade

Download and unpack the new release, then run the installer again:

```bash
tar -xJf webterm-1.3.2.tar.xz && cd webterm-1.3.2
sudo ./install.sh
```

- Nothing is asked. Users, sessions, presets, the vault, systems and settings are kept.
- The domain, port and certificate setup are kept. To change them, add `--https`.
- The web server restarts, and browsers reconnect by themselves within seconds.
- Terminals keep running. Only if the **broker** changed in the new version do you see
  `The terminal broker was updated. Restarting it ends all running terminals.` and are asked whether to restart it
  now. If you say no, the new broker takes over at the next reboot. Use `RESTART_BROKER=1` to answer yes in unattended upgrades.

## Uninstall

```bash
sudo ./uninstall.sh            # remove the program, services and nginx site; keep data
sudo ./uninstall.sh --purge    # also delete /var/lib/webterm, /etc/webterm and the service accounts
```

Kept in both cases:

- Linux accounts created for WebTerm users (`wt-*`) and their home directories. Remove them with `sudo userdel -r wt-<name>`.
- The `webterm-users` group
- Installed packages (nginx, certbot, tmux, …) and Let's Encrypt certificates in `/etc/letsencrypt`
- code-server (`/usr/local/bin/code-server`)
