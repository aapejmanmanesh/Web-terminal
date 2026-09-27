# HTTPS

WebTerm is always served over HTTPS. The installer offers three ways to get a certificate:

| | Option | Address | Browser warning | Renewal |
|---|---|---|---|---|
| 1 | **Let's Encrypt** (recommended) | `https://term.example.com` | No | Automatic |
| 2 | **Your own certificate** | `https://term.example.com` or `https://<host>:8443` | No (if issued by a trusted CA) | You replace it |
| 3 | **Self-signed** | `https://<server-ip>:8443` | Yes, the first time | Valid for 10 years |

On a fresh install the installer asks which one you want. To change it later:

```bash
cd webterm-<version>          # the unpacked release (or your git clone)
sudo ./install.sh --https
```

- [Option 1: Let's Encrypt](#option-1-lets-encrypt)
- [Option 2: Your own certificate](#option-2-your-own-certificate)
- [Option 3: Self-signed](#option-3-self-signed)
- [Unattended installs](#unattended-installs)
- [Troubleshooting](#troubleshooting)

---

## Option 1: Let's Encrypt

### Before you start

1. **A domain name** that you control, for example `term.example.com`. A subdomain of a domain you already
   own works well.
2. **A DNS A record** pointing that name to the server's public IPv4 address. At your DNS provider:

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | A | `term` | `203.0.113.10` *(your server's public IP)* | 300 |

   Check it from the server with `getent hosts term.example.com`; it should print your server's IP.
   Find the public IP with `curl -4 https://api.ipify.org`.
3. **Ports 80 and 443 reachable from the internet.** Let's Encrypt connects to port 80 to verify the domain.
   In cloud providers, allow them in the security group / firewall. The installer opens them in `ufw` if it's active.

### What you're asked

```text
HTTPS certificate
  1) Automatic: a free Let's Encrypt certificate for your domain (recommended).
  ...
  Choose 1, 2 or 3 [3]: 1
  Domain name (e.g. term.example.com): term.example.com
  E-mail for certificate expiry notices (optional, Enter to skip): admin@example.com
```

The installer checks that the domain resolves to this server. If it doesn't (yet), it tells you where the
name points and asks whether to continue anyway.

### What happens

1. nginx is installed and configured for your domain. WebTerm itself listens only on `127.0.0.1:8080`,
   so it can be reached only through nginx.
2. nginx starts with a temporary self-signed certificate so it can answer the Let's Encrypt challenge on port 80.
3. `certbot` requests the certificate (HTTP-01 challenge via `/var/www/webterm-acme`).
4. On success nginx switches to the Let's Encrypt certificate. HTTP is redirected to HTTPS, and HSTS is enabled.

**Renewals are automatic.** Ubuntu's certbot package installs `certbot.timer`, which renews certificates
before they expire and reloads nginx afterwards. Test it with `sudo certbot renew --dry-run`.

### If the certificate can't be issued yet

Common reasons are DNS that hasn't propagated, port 80 blocked by a firewall, or a typo in the domain.
WebTerm doesn't give up:

- It starts anyway with the temporary certificate (browsers show a warning in the meantime).
- `webterm-cert.timer` **retries every hour automatically**. As soon as the certificate is issued, nginx
  switches to it and the timer turns itself off. Nothing needs to be re-run.
- To retry right away after fixing DNS or the firewall:

  ```bash
  sudo webterm-cert
  ```

- Attempts are logged to `/var/log/webterm-cert.log`.

Let's Encrypt limits failed validations to 5 per hour per domain, so the hourly retry stays safely below that.

---

## Option 2: Your own certificate

Use this if your organization issues certificates, or you already have one (for example a wildcard certificate).

You need two PEM files:

- the **certificate with its full chain** (your certificate first, then the intermediate certificates), and
- the **private key**, not password-protected.

```text
  Choose 1, 2 or 3 [3]: 2
  Certificate file (PEM, full chain): /root/certs/fullchain.pem
  Private key file (PEM): /root/certs/privkey.pem
  Domain the certificate is for, served by nginx on port 443 (Enter = serve WebTerm directly on port 8443): term.example.com
```

The installer checks that both files are readable, that they are PEM, and that the key belongs to the
certificate. It warns if the certificate has already expired.

- **With a domain:** nginx serves WebTerm on port 443 with your certificate (files are copied to `/etc/webterm/tls/`).
- **Without a domain:** WebTerm serves the certificate itself on port 8443 (or `PORT`).

**Renewing:** when you get a new certificate, run the installer again with the new files:

```bash
sudo TLS_CERT=/root/certs/fullchain.pem TLS_KEY=/root/certs/privkey.pem ./install.sh
```

---

## Option 3: Self-signed

Nothing to prepare. WebTerm creates its own certificate (valid for 10 years, for the host name and all of
the server's IP addresses) and listens on port 8443:

```text
https://203.0.113.10:8443
```

Browsers warn that the certificate isn't trusted. Continue once per browser. To be sure you're talking to
your own server, compare the certificate's SHA-256 fingerprint in the browser with the one the installer printed:

```bash
sudo openssl x509 -in /etc/webterm/tls/cert.pem -noout -fingerprint -sha256
```

Note: browsers only allow some features in a trusted context. With a self-signed certificate, "Right-click to
paste" and installing WebTerm as an app may not be available. Everything else works.

To switch to a trusted certificate later: `sudo ./install.sh --https`, then choose option 1 or 2.

---

## Unattended installs

Set the answers as environment variables, and the installer asks nothing:

```bash
# Let's Encrypt
sudo ADMIN_USER=alice ADMIN_PASS='…' DOMAIN=term.example.com EMAIL=admin@example.com ./install.sh

# Own certificate behind nginx
sudo ADMIN_USER=alice ADMIN_PASS='…' DOMAIN=term.example.com \
     TLS_CERT=/root/certs/fullchain.pem TLS_KEY=/root/certs/privkey.pem ./install.sh

# Own certificate, served directly by WebTerm on port 443
sudo ADMIN_USER=alice ADMIN_PASS='…' TLS_CERT=/root/certs/fullchain.pem TLS_KEY=/root/certs/privkey.pem PORT=443 ./install.sh

# Self-signed
sudo ADMIN_USER=alice ADMIN_PASS='…' TLS_SELF_SIGNED=1 ./install.sh
```

### Behind your own reverse proxy

If another web server (Apache, Caddy, Traefik, an existing nginx…) should handle TLS:

```bash
sudo DOMAIN=term.example.com NGINX=0 CERTBOT=0 ./install.sh
```

WebTerm then listens on `http://127.0.0.1:8080` and trusts `X-Forwarded-*` headers. A ready-made nginx
site is written to `/etc/webterm/nginx-webterm.conf`. Whatever proxy you use must pass WebSockets
(`Upgrade`/`Connection` headers), must not buffer requests or responses (uploads and downloads are streamed),
and needs long read timeouts, since terminals stay connected for hours.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `… does not resolve` during install | Create the DNS A record and wait a few minutes, or continue anyway and let the hourly retry pick it up. |
| `… points to X, but this server's public IP is Y` | The A record points somewhere else (old server, CDN proxy). Fix the record. With Cloudflare, set the record to "DNS only" while the certificate is issued. |
| Browser still warns after installing with Let's Encrypt | The certificate isn't issued yet. Check `sudo tail -50 /var/log/webterm-cert.log`, fix the cause, then run `sudo webterm-cert`. |
| `Timeout during connect (likely firewall problem)` in the log | Port 80 isn't reachable from the internet. Open it in the cloud firewall / security group. |
| `too many failed authorizations recently` | Let's Encrypt's rate limit. Wait an hour; the timer retries by itself. |
| nginx fails with `socket() [::]:80 failed (97: Address family not supported)` | IPv6 is disabled on the server. The installer handles this by disabling nginx's stock default site; re-run the installer if you edited nginx by hand. |
| Port 80/443 already used by another web server | Stop it, or use [your own reverse proxy](#behind-your-own-reverse-proxy) with `NGINX=0`. |
| `The private key does not belong to the certificate` | You picked the key of a different certificate. Check with `openssl x509 -noout -modulus -in cert.pem | openssl md5` vs `openssl rsa -noout -modulus -in key.pem | openssl md5` (RSA keys). |
