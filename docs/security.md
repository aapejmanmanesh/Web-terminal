# Security

WebTerm gives people shells on your servers, so it's built to keep each user inside their own Linux
permissions and to keep the internet-facing part unprivileged.

## Architecture

```text
             Internet
                │ HTTPS (TLS 1.2+)
                ▼
   nginx :443 (domain mode)  ─or─  WebTerm :8443 (direct TLS)
                │
                ▼
  webterm  (Node.js, user "webterm", systemd-sandboxed)
    • sign-in, sessions, API, WebSockets, file transfers
    • cannot start processes as other users by itself
                │ /run/webterm/broker.sock  (root:webterm 0660)
                ▼
  webterm-broker  (root, small, no network listener)
    • owns every terminal / sftp / ssh process
    • validates every request, then drops privileges with setpriv
                │
                ▼
  processes running as the user's Linux account (or webterm-ssh for Vault SSH)
```

### Privilege separation

- **The web server runs unprivileged** (`webterm` user) with `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, `PrivateDevices`, kernel / cgroup / clock protections, restricted namespaces,
  `RestrictSUIDSGID` and no capabilities, except `CAP_NET_BIND_SERVICE` when it must bind a port below 1024.
  It refuses to start as root.
- **The broker is the only privileged component.** It listens only on a unix socket that only the web server can
  reach, and for every request naming a Linux account it checks that the account:
  - isn't `root`, isn't the service account, and has a uid of 1000 or higher (no system accounts), and
  - is a member of `webterm-users` (only the dedicated `webterm-ssh` account is exempt).
- Processes start via `setpriv` with the account's uid, gid and supplementary groups. File operations use an
  `sftp-server` running as the user, so **Linux permissions apply to everything**: a user can read exactly what
  their Linux account can.

### Accounts and passwords

- No public sign-up. Only administrators create accounts. There is **no default account or password**: the
  installer asks for the first administrator.
- Passwords are hashed with **scrypt** (N=2¹⁶, r=8, p=1, 64 MiB, random salt) and need at least 10 characters.
- Unknown user names still take the same time to check (dummy hash), so user names can't be discovered by timing.
- **Sign-in throttling:** after 10 failures from one address, or 6 for one account, within 15 minutes, sign-in is
  blocked for 15 / 10 minutes, doubling on repeated blocks (up to 8×). Failed attempts are audited.
- Changing or resetting a password signs out the account's other sessions.

### Sessions and requests

- Session cookies are random 256-bit tokens, stored server-side only as SHA-256 hashes, and set with
  `HttpOnly`, `SameSite=Strict`, `Secure` and the `__Host-` prefix over HTTPS.
- Sessions expire after 12 hours (or 30 days with "Keep me signed in") of inactivity. Users can list and revoke
  their devices, and administrators can sign a user out everywhere.
- **CSRF:** every state-changing API call must carry a custom `X-WebTerm` header (impossible cross-site without
  CORS, which is never granted) and, if the browser sends an `Origin`, it must match. WebSocket upgrades
  require a matching origin.
- **Headers:** a strict Content-Security-Policy (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`,
  `object-src 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP / CORP same-origin,
  and a restrictive Permissions-Policy. HSTS in domain mode.
- The IDE is proxied under `/ide/` behind the WebTerm login and refuses cross-site requests.

### Secrets

- Vault credentials (SSH keys, SSH / VNC / RDP passwords) are encrypted with **AES-256-GCM** using a random
  32-byte master key in `/var/lib/webterm/master.key` (readable only by the service).
- Private keys and passwords are never sent to browsers and can't be viewed or downloaded after they're saved.
- SSH connections with Vault credentials run as the separate `webterm-ssh` account with per-connection temporary
  key files, so users (and their shells) can't read the keys.
- **Host keys are pinned** on the first connection. A changed host key blocks the connection until an administrator
  confirms it.
- VNC and RDP logins are done by the server (VNC authentication in WebTerm, RDP in guacd on `127.0.0.1`), so
  those passwords never reach the browser either.

### Network

- WebTerm needs no inbound ports other than HTTPS (443, or 8443 without a domain). guacd listens on
  `127.0.0.1` only. In domain mode WebTerm itself listens on `127.0.0.1` only.
- The machines you monitor or open remote desktops to are contacted from the WebTerm server. They don't need to
  be exposed to the internet, and the setup scripts limit their firewalls to the WebTerm server.

### Audit

Sign-ins (successful and failed, with address), account, credential, host and system changes, SSH key installs,
remote desktop connections, file downloads, plugin actions and command-line administration are written to the
audit log (Administration → Audit log).

## Recommendations

- Use a domain with Let's Encrypt, or your own trusted certificate, rather than self-signed, so users can't be
  trained to click through certificate warnings.
- Give users their own `wt-<name>` Linux accounts rather than sharing one. Map a user to a powerful existing
  account (one with `sudo`) only if they should have that power.
- Keep the server updated (`unattended-upgrades`), and upgrade WebTerm when new releases come out.
- Back up `/var/lib/webterm` **including `master.key`**, and keep the backup as private as the server itself.
- Consider limiting access to WebTerm by IP (firewall or nginx `allow` / `deny`) or putting it behind a VPN if
  only a known group of people uses it.

## Reporting a vulnerability

Please report security problems privately to the author via [GitHub](https://github.com/aapejmanmanesh)
rather than in a public issue.
