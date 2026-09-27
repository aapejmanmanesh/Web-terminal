# Changelog

## 1.3.1

### Installer
- **No built-in administrator any more.** The first administrator's name and password are asked for during
  installation (or taken from `ADMIN_USER` / `ADMIN_PASS`), with validation and password confirmation.
- **HTTPS setup on install:** choose a free Let's Encrypt certificate for your domain, your own certificate
  files, or a self-signed certificate. `sudo ./install.sh --https` changes it later.
  - The domain is checked against the server's IP addresses before requesting a certificate.
  - Own certificates are checked: readable PEM files, key matches certificate, not expired.
  - If Let's Encrypt can't issue the certificate yet, WebTerm starts with a temporary one and
    `webterm-cert.timer` retries every hour, switching nginx over automatically once it's issued
    (`sudo webterm-cert` retries right away).
  - `TLS_SELF_SIGNED=1` for unattended self-signed installs. The Let's Encrypt e-mail is remembered.
- nginx on servers without IPv6: the stock default site (listening on `[::]:80`) no longer breaks the setup.
- RDP (guacd) builds with newer compilers and FreeRDP versions.
- The final summary shows which certificate is in use and how to change it. `--help` shows the options.
- `uninstall.sh` also removes the nginx site and the certificate retry timer.

### Fixes
- **Systems:** typing into the add / edit form was lost every few seconds while ping results arrived.
- **Files:** the automatic refresh closed the path bar while you were typing a path.
- **Systems:** a machine that was already up kept showing "waking…" for 5 minutes after Wake was pressed.
- **Presets:** the "In background" option of "Open as" was cut off.
- **Mobile:** the bottom navigation labels were hidden behind the footer.

### Other
- "Built by APA" credit with a link to the author's GitHub on every page.
- Release archives are built with `scripts/make-release.sh` (and on GitHub Actions for releases).
- Documentation in `docs/`.

## 1.3.0

- Initial version: persistent terminals, workspaces, presets, SSH hosts with a shared Vault,
  file browser for the server and SSH hosts, code-server IDE, systems with ping and Wake-on-LAN,
  VNC and RDP remote desktops, shell plugins, mobile interface.
