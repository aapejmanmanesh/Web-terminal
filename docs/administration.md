# Administration

Administrators see the **shield** icon in the left rail (**Administration**) with three sections:
**Users**, **Vault & hosts** and **Audit log**.

- [Users](#users)
- [Vault & hosts](#vault--hosts)
- [Systems](#systems)
- [Audit log](#audit-log)
- [Command line: webterm-admin](#command-line-webterm-admin)
- [Configuration file](#configuration-file)
- [Backup and restore](#backup-and-restore)

## Users

There is no public sign-up. Only administrators create accounts. The Users page shows totals (users,
online now, terminals running, failed sign-ins in the last 24 h) and one row per user with role, Linux
account, credentials, running terminals, last sign-in and status.

### Creating a user

**Create user** asks for:

| Field | Meaning |
|---|---|
| Username | 2–32 characters: letters, digits, `.`, `_`, `-` |
| Role | **user** or **admin**. Admins manage users, the Vault, hosts and systems, and see the audit log. |
| Password | At least 10 characters. **Generate** creates a strong one. Give it to the user; they can change it in Settings. |
| Terminals run as | **Create a new Linux account** (`wt-<name>`, recommended): an isolated home directory. **Use an existing Linux account**: map the user to an account that already exists, such as your own. **No local shell**: SSH hosts only, no shell or files on the WebTerm server. |
| Allow the IDE | Access to code-server (needs a Linux account) |
| Shared SSH credentials this user may use | Which Vault credentials the user can connect with |

Linux accounts used by WebTerm are added to the `webterm-users` group. The broker refuses to start anything as
root, as a system account (uid < 1000), or as an account outside that group.

### Managing a user

Click a user's row to change their role, terminal limit (default 40), IDE access and credentials, or to:

- **Reset password**: sets a new password and signs the user out everywhere.
- **Sign out everywhere**: ends all their browser sessions. **Their terminals keep running.**
- **Delete user**: stops their terminals and removes their presets. The Linux account and its files are
  kept, but the account is removed from `webterm-users`, so WebTerm can no longer use it. Delete it with
  `sudo userdel -r wt-<name>` if you don't need it.

## Vault & hosts

The Vault holds SSH credentials that users connect with **without ever seeing them**. Private keys and
passwords are encrypted with AES-256-GCM using `/var/lib/webterm/master.key`, and can't be viewed or downloaded
after they are stored. SSH connections that use them run as the separate `webterm-ssh` system account.

### Credentials

- **Generate key**: a new ed25519 key pair is created on the server. Choose a name and which users may use it.
- **Import key**: paste an existing private key (OpenSSH or PEM).
- **Add password**: for hosts that only allow password login.
- **Copy public key**: to add it to `~/.ssh/authorized_keys` on a host yourself.
- **Access**: which users may use the credential. Administrators always can.

### Hosts

**Add host**: name, address, SSH user, port and credential. Each host row has:

- **Test**: connects and runs `uname`, showing the result.
- **Install key on host (asks host password once)**: opens a terminal running `ssh-copy-id` with the credential's
  public key. Type the host user's password once. Afterwards the key is used.
- **Forget pinned host key**: WebTerm pins each host's SSH fingerprint on the first connection and blocks
  connections if it changes. After reinstalling a host, use this to accept its new key.
- **Edit…** / **Delete host**

Users see the hosts whose credential they're allowed to use, in their **SSH hosts** panel, file browser and presets.

## Systems

Administrators add machines in the **Systems** panel with **+**, and edit them by clicking their row:

| Field | Meaning |
|---|---|
| Name, IP / host | What to show and what to ping |
| MAC | For Wake-on-LAN (`3c:7c:3f:a1:22:9e`) |
| Broadcast | Where to send Wake-on-LAN packets. Default: `255.255.255.255` and the address's `x.x.x.255`. Use `host:port` for a specific port. |
| Ping every (s) | 5–3600 seconds (default 30) |
| VNC port / password | Remote desktop of the physical screen, e.g. `5900`. VNC uses only the first 8 characters of the password. |
| RDP port / user / password / domain | Remote desktop session with sound, e.g. `3389` |
| All users may connect | Otherwise only administrators can open the remote desktop |

Machines are pinged with ICMP. If ICMP isn't permitted, WebTerm falls back to TCP probes on ports 22, 80,
443, 445 and 3389. Remote desktop passwords are stored encrypted in the Vault and never sent to browsers.
Setting up the machines is described in [Remote desktop](remote-desktop.md).

## Audit log

The audit log records sign-ins and failed sign-ins (with address), password changes, user and credential
changes, host and system changes, SSH key installs, remote desktop connections, file downloads, plugin actions
and command-line administration, newest first.

## Command line: webterm-admin

Run as root on the server:

```bash
sudo webterm-admin list-users
sudo webterm-admin reset-password <username>                  # asks for the new password twice
sudo webterm-admin create-admin <username> --linux-user <account> [--create-linux]
```

- `create-admin` creates an administrator, or turns an existing user into an administrator with a new password
  and signs them out. `--linux-user` is the Linux account their terminals run as (not root). Add
  `--create-linux` to create that account.
- The password can also be given in the `WEBTERM_PASSWORD` environment variable, or piped on stdin.

**Locked out?** `sudo webterm-admin reset-password <admin>` always works on the server.

## Configuration file

`/etc/webterm/config.json` (readable by root and the `webterm` group). Only set what you want to change. Missing
keys use the defaults below. After editing, run `sudo systemctl restart webterm`. Settings marked **B** are also read
by the broker; changing them needs `sudo systemctl restart webterm-broker`, **which ends all running terminals**.

| Key | Default | Meaning |
|---|---|---|
| `listen` | `{ "host": "0.0.0.0", "port": 8443 }` | Address and port of the web server |
| `tls` | `{ "cert": "/etc/webterm/tls/cert.pem", "key": "/etc/webterm/tls/key.pem" }` | Certificate WebTerm serves itself. `null` = plain HTTP (only behind a reverse proxy). |
| `trustProxy` | `false` | Trust `X-Forwarded-For/-Proto/-Host` from a reverse proxy (set in domain mode) |
| `allowedOrigins` | `[]` | Extra origins allowed for WebSockets and API calls, e.g. `["https://term.example.com"]` |
| `hsts` | `false` | Send HSTS when WebTerm serves TLS itself (nginx sends it in domain mode) |
| `hostname` | the machine's short host name | Name shown in the top bar and prompts |
| `sessionDays` | `30` | How long "Keep me signed in" lasts (sliding) |
| `scrollback` | `10000` | **B** Lines kept per terminal on the server |
| `maxTerminalsPerUser` | `60` | Upper limit for the per-user terminal limit |
| `codeServer` | `/usr/bin/code-server` | **B** Path to code-server (set by the installer) |
| `sftpServer` | `/usr/lib/openssh/sftp-server` | Path to OpenSSH's sftp-server |
| `guacd` | `{ "host": "127.0.0.1", "port": 4822 }` | Where the RDP proxy listens |
| `dataDir` | `/var/lib/webterm` | Database, master key, temporary files |
| `usersGroup` | `webterm-users` | **B** Group of Linux accounts WebTerm may use |
| `serviceUser` / `serviceGroup` | `webterm` | **B** Account of the web server |
| `sshUser` / `sshHome` | `webterm-ssh` / `/var/lib/webterm-ssh` | **B** Account that runs Vault SSH connections |
| `brokerSocket` | `/run/webterm/broker.sock` | **B** Socket between web server and broker |
| `ssh`, `sshKeygen`, `sshCopyId`, `ping`, `setpriv` | `/usr/bin/…` | Paths to system tools |

Example: listen on port 443 directly with your own certificate:

```json
{
  "listen": { "host": "0.0.0.0", "port": 443 },
  "tls": { "cert": "/etc/webterm/tls/cert.pem", "key": "/etc/webterm/tls/key.pem" },
  "hostname": "lab-server"
}
```

(To use a port below 1024, re-run the installer with `PORT=443` so the service gets the needed capability.)

## Backup and restore

Back up these together. The master key is needed to decrypt the Vault:

```bash
sudo systemctl stop webterm
sudo tar -czf webterm-backup-$(date +%F).tar.gz /var/lib/webterm /etc/webterm /var/lib/webterm-ssh
sudo systemctl start webterm
```

Terminals keep running while the web server is stopped for the backup.

To restore on a new server, install WebTerm first (any administrator name; it will be replaced), then:

```bash
sudo systemctl stop webterm webterm-broker
sudo tar -xzf webterm-backup-2026-01-31.tar.gz -C /
sudo systemctl start webterm-broker webterm
```

Users' Linux accounts (`wt-*`) and home directories aren't part of this backup. Recreate or copy them
as usual. Their accounts must exist and be members of `webterm-users`.
