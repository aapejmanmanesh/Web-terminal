# Troubleshooting

## Where to look

```bash
sudo systemctl status webterm webterm-broker webterm-guacd
sudo journalctl -u webterm -u webterm-broker -f          # live logs
sudo journalctl -u webterm --since "10 min ago"
sudo tail -50 /var/log/webterm-cert.log                  # Let's Encrypt (domain mode)
sudo nginx -t && sudo tail -50 /var/log/nginx/error.log  # nginx (domain mode)
```

Installer logs: `/tmp/webterm-code-server.log` (IDE), `/tmp/webterm-guacd-build.log` (RDP),
`/tmp/webterm-nginx-test.log` (nginx).

## Installation

| Problem | Fix |
|---|---|
| `No terminal to ask on. Set ADMIN_USER and ADMIN_PASS` | The installer runs without a terminal (CI, cloud-init). Pass `ADMIN_USER` / `ADMIN_PASS` (and `DOMAIN`, `TLS_CERT` or `TLS_SELF_SIGNED=1`). |
| `systemd is required` | Containers without systemd aren't supported. Use a VM or a full server. |
| `node-pty failed to build` | Needs `build-essential` and `python3`, and internet access to nodejs.org to get the headers. Check the output above the error. |
| `code-server could not be installed` | WebTerm works without the IDE. Check network access to `code-server.dev` / GitHub, then run the installer again. |
| `RDP support could not be built` | Everything except RDP works. See `/tmp/webterm-guacd-build.log`. On distributions without FreeRDP 2/3 dev packages, RDP isn't available. |
| `The web server did not start` | `journalctl -u webterm -n 50`. Most often a broken `/etc/webterm/config.json` (invalid JSON) or a port already in use. |
| Let's Encrypt / nginx problems | See [HTTPS → Troubleshooting](https.md#troubleshooting). |

## Signing in

| Problem | Fix |
|---|---|
| Forgot the administrator password | `sudo webterm-admin reset-password <name>` |
| `Too many attempts. Try again in N min.` | Wait, or restart the web server (`sudo systemctl restart webterm`) to clear the counters. Terminals keep running. |
| Signed out right after signing in | Clock or cookies: the browser must accept cookies, and in direct mode you must use `https://`. Behind your own proxy, make sure `X-Forwarded-Proto: https` is sent and `trustProxy` is set. |
| `Bad origin` / WebSocket 403 | You open WebTerm under a name that isn't its own (another domain, a proxy that rewrites `Host`). Add the address to `allowedOrigins` in `/etc/webterm/config.json`. |

## Terminals

| Problem | Fix |
|---|---|
| Status bar says **terminal service offline** | The broker isn't running: `sudo systemctl status webterm-broker`, then `sudo systemctl start webterm-broker`. |
| Status bar says **reconnecting…** | The browser lost its connection. It reconnects by itself. Behind a proxy, check that WebSockets and long timeouts are allowed. |
| New terminal fails with `… is not in webterm-users` | The user's Linux account isn't in the group: `sudo gpasswd -a <account> webterm-users`. |
| `… is a system account` | Users can't be mapped to accounts with uid < 1000. Create a normal account for them. |
| Text looks garbled or blurry | Settings → turn off **GPU rendering (WebGL)**. |
| Paste with right-click doesn't work | Browsers only allow it with a trusted certificate (not self-signed). Use `Ctrl+Shift+V`. |
| Terminals were gone after a reboot | Terminals survive browser closes and WebTerm restarts, but not a reboot of the server. Use tmux inside, or presets with *Protect against network drops* on SSH hosts. |

## SSH hosts

| Problem | Fix |
|---|---|
| `Host key verification failed` / host blocked | The host's key changed (reinstalled machine, or an attack). If it's expected: Administration → Vault & hosts → host menu → **Forget pinned host key**. |
| `Permission denied (publickey)` | The key isn't installed on the host. Use **Install key on host**, or add the public key to `~/.ssh/authorized_keys` of the host user. |
| Host missing in a user's panel | The user isn't allowed to use the host's credential. Edit the credential's **Access**, or the user. |

## Files

| Problem | Fix |
|---|---|
| `Permission denied` | File operations run as the user's Linux account; fix permissions on the server as you normally would. |
| File browser for the server is missing | The user has *No local shell*, or `sftp-server` isn't installed: `sudo apt install openssh-sftp-server`. |
| Large uploads stop behind a proxy | The proxy must not limit or buffer request bodies (`client_max_body_size 0; proxy_request_buffering off;` in nginx). |

## Systems

| Problem | Fix |
|---|---|
| Everything shows **down** | ICMP may be blocked. WebTerm falls back to TCP probes (ports 22, 80, 443, 445, 3389). A machine that answers none of them looks down. |
| Wake-on-LAN doesn't wake the machine | Enable WoL in the BIOS / UEFI and the network adapter; the WebTerm server must be in the same network (broadcast), or set the **Broadcast** field to the right subnet's broadcast address. |
| Remote desktop problems | See [Remote desktop → Troubleshooting](remote-desktop.md#troubleshooting). |

## Still stuck?

Open an issue on [GitHub](https://github.com/aapejmanmanesh/Web-terminal/issues) with your OS version, the WebTerm
version (`grep '"version"' /opt/webterm/app/package.json`) and the relevant log lines.
Remove passwords and host names you don't want to share.
