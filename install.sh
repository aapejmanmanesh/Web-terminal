#!/usr/bin/env bash
# WebTerm installer for Ubuntu 22.04 / 24.04 (also Debian 12).
#
#   sudo ./install.sh                 # install or upgrade
#
# Behind nginx on your own (sub)domain — recommended:
#   sudo DOMAIN=term.example.com EMAIL=you@example.com ./install.sh
#     installs/configures nginx, gets a Let's Encrypt certificate, and keeps
#     WebTerm itself on 127.0.0.1:8080 (only nginx can reach it).
#
# Optional environment variables:
#   DOMAIN=term.example.com           serve through nginx on this domain (HTTPS)
#   EMAIL=you@example.com             Let's Encrypt account e-mail (DOMAIN mode)
#   CERTBOT=1                         get a Let's Encrypt certificate (0 = don't)
#   NGINX=1                           write the nginx site (0 = print it only)
#   PORT=8443                         HTTPS port (direct mode) / 8080 local port (DOMAIN mode)
#   ADMIN_USER=<name>                 first administrator (asked for on first install if empty)
#   ADMIN_PASS=...                    its password (asked for on first install if empty)
#   ADMIN_LINUX=<account>             Linux account the admin's terminals run as
#                                     (default: the user who ran sudo)
#   WITH_IDE=1                        also install code-server for the IDE (0 to skip)
#   TLS_CERT=/path TLS_KEY=/path      use your own certificate instead of a self-signed one
#   RESTART_BROKER=1                  on upgrade, restart the terminal broker without asking
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX=/opt/webterm
DATA=/var/lib/webterm
SSH_HOME=/var/lib/webterm-ssh
ETC=/etc/webterm
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
CERTBOT="${CERTBOT:-1}"
NGINX="${NGINX:-1}"
# Upgrading: keep the domain (nginx mode) and port of the existing install.
if [ -f "$ETC/config.json" ]; then
  if [ -z "$DOMAIN" ] && grep -Eq '"trustProxy": *true' "$ETC/config.json"; then
    DOMAIN=$(grep -o '"https://[^"/:]*' "$ETC/config.json" | head -n 1 | cut -c10- || true)
  fi
  [ -n "${PORT:-}" ] || PORT=$(grep -Eo '"port": *[0-9]+' "$ETC/config.json" | head -n 1 | grep -Eo '[0-9]+$' || true)
fi
if [ -n "$DOMAIN" ]; then PORT="${PORT:-8080}"; else PORT="${PORT:-8443}"; fi
ADMIN_USER="${ADMIN_USER:-}"
ADMIN_PASS="${ADMIN_PASS:-}"
ADMIN_LINUX="${ADMIN_LINUX:-${SUDO_USER:-}}"
WITH_IDE="${WITH_IDE:-1}"

c_green=$'\e[1;32m'; c_amber=$'\e[1;33m'; c_red=$'\e[1;31m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
step() { printf '%s▶%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_amber" "$c_off" "$*"; }
die() { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo ./install.sh"
command -v systemctl >/dev/null || die "systemd is required"
[ -f "$HERE/app/package.json" ] || die "Run this script from the extracted WebTerm release folder"
[ -f "$HERE/app/web/dist/index.html" ] || die "The release is missing the built web UI (app/web/dist)"
if [ -n "$DOMAIN" ]; then
  echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' || die "DOMAIN must be a host name like term.example.com"
fi
ARCH="$(uname -m)"

FRESH=1
[ -f "$DATA/webterm.db" ] && FRESH=0

# ---------------------------------------------------------------- administrator (asked up front)
# The first administrator is chosen by whoever installs WebTerm; there is no
# built-in default account. Questions are read from the terminal, so this also
# works when the script itself arrives on stdin (curl ... | sudo bash).
if [ "$FRESH" = "1" ]; then
  TTY=""
  { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null && TTY=/dev/tty
  ask() { # $1 prompt  $2 variable  [$3 = secret]
    [ -n "$TTY" ] || die "No terminal to ask on. Set ADMIN_USER and ADMIN_PASS, e.g.: sudo ADMIN_USER=admin ADMIN_PASS='...' ./install.sh"
    if [ "${3:-}" = "secret" ]; then read -r -s -p "$1" "$2" <"$TTY"; echo >&2; else read -r -p "$1" "$2" <"$TTY"; fi
  }
  valid_user() { echo "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'; }
  echo
  printf '%sCreate the WebTerm administrator account%s
' "$c_green" "$c_off"
  if [ -n "$ADMIN_USER" ]; then
    valid_user "$ADMIN_USER" || die "ADMIN_USER must be 2-32 characters: letters, digits, '.', '_' or '-'"
  else
    while :; do
      ask "  Administrator username: " ADMIN_USER
      valid_user "$ADMIN_USER" && break
      warn "Use 2-32 characters: letters, digits, '.', '_' or '-' (starting with a letter or digit)."
    done
  fi
  if [ -n "$ADMIN_PASS" ]; then
    [ "${#ADMIN_PASS}" -ge 10 ] || die "ADMIN_PASS must be at least 10 characters"
  else
    while :; do
      ask "  Password for $ADMIN_USER (at least 10 characters): " ADMIN_PASS secret
      if [ "${#ADMIN_PASS}" -lt 10 ]; then warn "The password must be at least 10 characters."; continue; fi
      ask "  Repeat the password: " ADMIN_PASS2 secret
      [ "$ADMIN_PASS" = "$ADMIN_PASS2" ] && break
      warn "The passwords do not match; try again."
    done
    unset ADMIN_PASS2
  fi
  echo
fi

# ---------------------------------------------------------------- packages
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssl openssh-client openssh-sftp-server util-linux iputils-ping tmux git xz-utils tar gzip >/dev/null
if [ -n "$DOMAIN" ] && [ "$NGINX" = "1" ]; then
  apt-get install -y -qq nginx >/dev/null
  [ "$CERTBOT" = "1" ] && ! command -v certbot >/dev/null && { apt-get install -y -qq certbot >/dev/null || warn "certbot could not be installed"; }
fi
command -v setpriv >/dev/null || die "setpriv (util-linux) is missing"
SFTP_SERVER=""
for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do
  [ -x "$p" ] && { SFTP_SERVER="$p"; break; }
done
[ -n "$SFTP_SERVER" ] || warn "sftp-server was not found; the file browser will only work for SSH hosts"

# ---------------------------------------------------------------- node runtime
download_node() { # $1 destination folder
  local NARCH base file sum tmp
  case "$ARCH" in x86_64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;; *) die "Unsupported CPU: $ARCH" ;; esac
  base=https://nodejs.org/dist/latest-v22.x
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$NARCH.tar.xz" '$2 ~ a {print $2; exit}')
  [ -n "$file" ] || die "Could not reach nodejs.org"
  sum=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$file" '$2==f {print $1}')
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  echo "$sum  $tmp/$file" | sha256sum -c --quiet || die "Node.js checksum mismatch"
  rm -rf "$1" && mkdir -p "$1"
  tar -xJf "$tmp/$file" -C "$1" --strip-components=1
  rm -rf "$tmp"
}
NODE="$PREFIX/node/bin/node"
if [ -d "$HERE/node" ] && [ "$ARCH" = "x86_64" ]; then
  step "Installing the bundled Node.js runtime"
  rm -rf "$PREFIX/node.new" && mkdir -p "$PREFIX"
  cp -a "$HERE/node" "$PREFIX/node.new"
  rm -rf "$PREFIX/node" && mv "$PREFIX/node.new" "$PREFIX/node"
elif [ ! -x "$NODE" ] || ! "$NODE" -e 'process.exit(+process.versions.node.split(".")[0]>=22 && +process.versions.node.split(".")[1]>=13 ? 0 : 1)'; then
  step "Downloading Node.js 22 for $ARCH"
  download_node "$PREFIX/node"
fi
"$NODE" --version >/dev/null || die "Node.js runtime is not working"

# ---------------------------------------------------------------- accounts
step "Creating service accounts"
getent group webterm >/dev/null || groupadd --system webterm
getent passwd webterm >/dev/null || useradd --system --gid webterm --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin webterm
getent group webterm-users >/dev/null || groupadd --system webterm-users
getent passwd webterm-ssh >/dev/null || useradd --system --user-group --home-dir "$SSH_HOME" --create-home --shell /bin/sh webterm-ssh
passwd -l webterm-ssh >/dev/null 2>&1 || true
install -d -m 0700 -o webterm -g webterm "$DATA"
install -d -m 0700 -o webterm-ssh -g webterm-ssh "$SSH_HOME" "$SSH_HOME/.ssh"
install -d -m 0750 -o root -g webterm "$ETC"

# ---------------------------------------------------------------- application
step "Installing WebTerm to $PREFIX/app"
BROKER_BEFORE=""
[ -f "$PREFIX/app/lib/broker/broker.js" ] && BROKER_BEFORE=$(cat "$PREFIX/app/lib/broker/broker.js" "$PREFIX/app/lib/common/"*.js 2>/dev/null | sha256sum)
rm -rf "$PREFIX/app.new"
mkdir -p "$PREFIX/app.new"
cp -a "$HERE/app/." "$PREFIX/app.new/"
if [ ! -d "$PREFIX/app.new/node_modules/node-pty" ] || ! (cd "$PREFIX/app.new" && "$NODE" -e "require('node-pty')" 2>/dev/null); then
  step "Building native modules (first time can take a minute)"
  apt-get install -y -qq build-essential python3 >/dev/null
  # The bundled runtime ships without npm/headers; fetch a full Node.js to build with.
  BUILD_NODE="$PREFIX/node"
  if [ ! -x "$BUILD_NODE/bin/npm" ] || [ ! -d "$BUILD_NODE/include/node" ]; then BUILD_NODE="$(mktemp -d)/node"; download_node "$BUILD_NODE"; fi
  rm -rf "$PREFIX/app.new/node_modules"
  (cd "$PREFIX/app.new" && npm_config_nodedir="$BUILD_NODE" PATH="$BUILD_NODE/bin:$PATH" "$BUILD_NODE/bin/npm" ci --omit=dev --no-audit --no-fund --loglevel=error)
  (cd "$PREFIX/app.new" && "$NODE" -e "require('node-pty')") || die "node-pty failed to build"
fi
chown -R root:root "$PREFIX/app.new"
chmod -R go-w "$PREFIX/app.new"
chmod 0755 "$PREFIX/app.new/bin/"*
rm -rf "$PREFIX/app.old"
[ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
mv "$PREFIX/app.new" "$PREFIX/app"
rm -rf "$PREFIX/app.old"
BROKER_AFTER=$(cat "$PREFIX/app/lib/broker/broker.js" "$PREFIX/app/lib/common/"*.js | sha256sum)

cat > /usr/local/sbin/webterm-admin <<EOF
#!/bin/sh
exec "$NODE" --disable-warning=ExperimentalWarning "$PREFIX/app/bin/webterm-admin.mjs" "\$@"
EOF
chmod 0755 /usr/local/sbin/webterm-admin

# ---------------------------------------------------------------- TLS
HOST="$(hostname -f 2>/dev/null || hostname)"
if [ -n "$DOMAIN" ]; then
  : # nginx terminates TLS (see below)
elif [ -n "${TLS_CERT:-}" ] && [ -n "${TLS_KEY:-}" ]; then
  step "Using the provided certificate"
  install -d -m 0750 -o root -g webterm "$ETC/tls"
  install -m 0644 -o root -g webterm "$TLS_CERT" "$ETC/tls/cert.pem"
  install -m 0640 -o root -g webterm "$TLS_KEY" "$ETC/tls/key.pem"
elif [ ! -f "$ETC/tls/cert.pem" ]; then
  step "Creating a self-signed TLS certificate"
  install -d -m 0750 -o root -g webterm "$ETC/tls"
  SAN="DNS:$HOST,DNS:localhost,IP:127.0.0.1"
  for ip in $(hostname -I 2>/dev/null); do case "$ip" in *:*) SAN="$SAN,IP:$ip" ;; *) SAN="$SAN,IP:$ip" ;; esac; done
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=$HOST/O=WebTerm" -addext "subjectAltName=$SAN" -addext "keyUsage=digitalSignature" -addext "extendedKeyUsage=serverAuth" \
    -keyout "$ETC/tls/key.pem" -out "$ETC/tls/cert.pem" 2>/dev/null
  chown root:webterm "$ETC/tls/key.pem" "$ETC/tls/cert.pem"
  chmod 0640 "$ETC/tls/key.pem"
  chmod 0644 "$ETC/tls/cert.pem"
fi

# ---------------------------------------------------------------- config
if [ ! -f "$ETC/config.json" ]; then
  step "Writing $ETC/config.json"
  cat > "$ETC/config.json" <<EOF
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "tls": { "cert": "$ETC/tls/cert.pem", "key": "$ETC/tls/key.pem" },
  "hostname": "$(hostname -s)"
}
EOF
fi
# Keep settings you changed; only set what this install mode requires.
WT_DOMAIN="$DOMAIN" WT_PORT="$PORT" WT_SFTP="$SFTP_SERVER" WT_HOSTNAME="$(hostname -s)" "$NODE" -e "
  const fs = require('fs'); const f = '$ETC/config.json';
  const c = JSON.parse(fs.readFileSync(f, 'utf8')); const e = process.env;
  if (e.WT_DOMAIN) {
    c.listen = { host: '127.0.0.1', port: Number(e.WT_PORT) };
    c.tls = null;
    c.trustProxy = true;
    const o = 'https://' + e.WT_DOMAIN;
    c.allowedOrigins = Array.from(new Set([...(c.allowedOrigins || []), o]));
  }
  if (e.WT_SFTP && e.WT_SFTP !== '/usr/lib/openssh/sftp-server') c.sftpServer = e.WT_SFTP;
  if (!c.hostname) c.hostname = e.WT_HOSTNAME;
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');"
chown root:webterm "$ETC/config.json"
chmod 0640 "$ETC/config.json"
PORT=$("$NODE" -e "console.log(require('$ETC/config.json').listen.port)")
DIRECT_TLS=$("$NODE" -e "const c=require('$ETC/config.json'); console.log(c.tls && c.tls.cert ? 1 : 0)")

# ---------------------------------------------------------------- systemd
step "Installing systemd services"
CAPS=""
if [ "$PORT" -lt 1024 ]; then CAPS=$'CapabilityBoundingSet=CAP_NET_BIND_SERVICE\nAmbientCapabilities=CAP_NET_BIND_SERVICE'; else CAPS=$'CapabilityBoundingSet=\nAmbientCapabilities='; fi
cat > /etc/systemd/system/webterm-broker.service <<EOF
[Unit]
Description=WebTerm broker (owns terminal sessions; keep running)
After=network.target

[Service]
Type=simple
ExecStart=$NODE --disable-warning=ExperimentalWarning $PREFIX/app/bin/webterm-broker.mjs
Restart=on-failure
RestartSec=2
TasksMax=infinity
LimitNOFILE=1048576
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/webterm.service <<EOF
[Unit]
Description=WebTerm web server
After=network-online.target webterm-broker.service
Wants=network-online.target webterm-broker.service

[Service]
Type=simple
User=webterm
Group=webterm
ExecStart=$NODE --disable-warning=ExperimentalWarning $PREFIX/app/bin/webterm-server.mjs
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=$DATA
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
$CAPS

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

# ---------------------------------------------------------------- IDE
if [ "$WITH_IDE" = "1" ] && ! command -v code-server >/dev/null; then
  step "Installing code-server (IDE)"
  if curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=/usr/local >/tmp/webterm-code-server.log 2>&1 \
     || curl -fsSL https://code-server.dev/install.sh | sh >>/tmp/webterm-code-server.log 2>&1; then
    systemctl disable --now "code-server@*" >/dev/null 2>&1 || true
  else
    warn "code-server could not be installed (see /tmp/webterm-code-server.log). WebTerm works without the IDE; re-run later with WITH_IDE=1."
  fi
fi
CS=$(command -v code-server || true)
if [ -n "$CS" ]; then
  "$NODE" -e "
    const fs=require('fs'); const f='$ETC/config.json'; const c=JSON.parse(fs.readFileSync(f,'utf8'));
    if (c.codeServer !== '$CS') { c.codeServer='$CS'; fs.writeFileSync(f, JSON.stringify(c,null,2)+'\n'); }"
fi

# ---------------------------------------------------------------- RDP (guacd)
# Remote desktops over RDP go through guacd (Apache Guacamole's proxy daemon),
# built once from the bundled source and listening on 127.0.0.1 only.
GUACD_VERSION=1.6.1
GUACD_PREFIX="$PREFIX/guacd"
GUACD_SRC="$HERE/guacd/guacamole-server-$GUACD_VERSION.tar.gz"
guacd_version() { LD_LIBRARY_PATH="$GUACD_PREFIX/lib" "$GUACD_PREFIX/sbin/guacd" -v 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true; }
pkg_available() { [ -n "$(apt-cache policy "$1" 2>/dev/null | sed -n 's/^ *Candidate: //p' | grep -v '(none)')" ]; }
if [ "${WITH_RDP:-1}" = "1" ] && [ "$(guacd_version)" != "$GUACD_VERSION" ]; then
  if [ ! -f "$GUACD_SRC" ]; then
    warn "RDP support skipped: $GUACD_SRC is missing from the release"
  else
    step "Building RDP support (guacd $GUACD_VERSION, first time takes a few minutes)"
    FREERDP=freerdp3-dev
    pkg_available freerdp3-dev || FREERDP=freerdp2-dev
    JPEG=libjpeg-turbo8-dev
    pkg_available libjpeg-turbo8-dev || JPEG=libjpeg-dev
    GLOG=/tmp/webterm-guacd-build.log
    BUILD_DIR=$(mktemp -d)
    if apt-get install -y -qq build-essential pkg-config libcairo2-dev "$JPEG" libpng-dev uuid-dev libssl-dev libwebp-dev "$FREERDP" >"$GLOG" 2>&1 &&
      tar -xzf "$GUACD_SRC" -C "$BUILD_DIR" >>"$GLOG" 2>&1 &&
      (cd "$BUILD_DIR/guacamole-server-$GUACD_VERSION" &&
        CFLAGS="-O2 -Wno-error=deprecated-declarations" ./configure --prefix="$GUACD_PREFIX" --disable-guacenc --disable-guaclog \
          --without-ssh --without-telnet --without-vnc --without-websockets &&
        make -j"$(nproc)" && make install) >>"$GLOG" 2>&1 &&
      [ "$(guacd_version)" = "$GUACD_VERSION" ]; then
      step "RDP support installed"
    else
      warn "RDP support could not be built (see $GLOG). WebTerm works without it; VNC is unaffected."
    fi
    rm -rf "$BUILD_DIR"
  fi
fi
if [ -x "$GUACD_PREFIX/sbin/guacd" ]; then
  cat > /etc/systemd/system/webterm-guacd.service <<GUACD
[Unit]
Description=WebTerm RDP proxy (guacd)
After=network.target

[Service]
Type=simple
ExecStart=$GUACD_PREFIX/sbin/guacd -f -b 127.0.0.1 -l 4822 -L warning
Environment=LD_LIBRARY_PATH=$GUACD_PREFIX/lib
Environment=HOME=/var/lib/webterm-guacd
DynamicUser=yes
StateDirectory=webterm-guacd
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
GUACD
  systemctl daemon-reload
  systemctl enable webterm-guacd.service >/dev/null 2>&1 || true
  systemctl restart webterm-guacd.service || warn "guacd did not start: journalctl -u webterm-guacd"
fi

# ---------------------------------------------------------------- firewall
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [ -n "$DOMAIN" ]; then
    step "Allowing HTTP/HTTPS (80, 443) in ufw"
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
  else
    step "Allowing port $PORT in ufw"
    ufw allow "$PORT/tcp" >/dev/null
  fi
fi

# ---------------------------------------------------------------- start
step "Starting services"
systemctl enable webterm-broker.service webterm.service >/dev/null 2>&1
if ! systemctl is-active --quiet webterm-broker.service; then
  systemctl start webterm-broker.service
elif [ "$BROKER_BEFORE" != "$BROKER_AFTER" ]; then
  warn "The terminal broker was updated. Restarting it ends all running terminals."
  if [ "${RESTART_BROKER:-ask}" = "1" ]; then systemctl restart webterm-broker.service
  elif [ -t 0 ]; then
    read -r -p "Restart the broker now? [y/N] " a
    case "$a" in [yY]*) systemctl restart webterm-broker.service ;; *) warn "Kept the old broker running; it will switch at the next reboot." ;; esac
  else
    warn "Kept the old broker running; run 'systemctl restart webterm-broker' when convenient."
  fi
fi
for i in $(seq 1 50); do [ -S /run/webterm/broker.sock ] && break; sleep 0.1; done
[ -S /run/webterm/broker.sock ] || die "The broker did not start: journalctl -u webterm-broker"
systemctl restart webterm.service

# ---------------------------------------------------------------- administrator
if [ "$FRESH" = "1" ]; then
  step "Creating administrator $ADMIN_USER"
  CREATE_LINUX=""
  if [ -z "$ADMIN_LINUX" ] || [ "$ADMIN_LINUX" = "root" ]; then
    ADMIN_LINUX="wt-$(echo "$ADMIN_USER" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_\n-' '-')"
    CREATE_LINUX="--create-linux"
  fi
  for i in $(seq 1 50); do [ -f "$DATA/webterm.db" ] && break; sleep 0.1; done
  WEBTERM_PASSWORD="$ADMIN_PASS" /usr/local/sbin/webterm-admin create-admin "$ADMIN_USER" --linux-user "$ADMIN_LINUX" $CREATE_LINUX
  unset ADMIN_PASS
fi

# ---------------------------------------------------------------- nginx (DOMAIN mode)
nginx_site() { # $1 cert  $2 key  $3 output file
  # "listen 443 ssl http2" works on every nginx Ubuntu ships (1.18–1.24; newer ones only warn).
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" -e "s|__CERT__|$1|g" -e "s|__KEY__|$2|g" -e "s|__HTTP2__|http2|g" \
    "$HERE/nginx-webterm.conf" > "$3"
  # Hosts with IPv6 disabled cannot bind [::] — drop those listen lines.
  [ -e /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' "$3"
}
if [ -n "$DOMAIN" ]; then
  if [ "$NGINX" != "1" ]; then
    nginx_site "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$ETC/nginx-webterm.conf"
    step "nginx was not configured (NGINX=0). Site file for your nginx: $ETC/nginx-webterm.conf"
  else
    step "Configuring nginx for https://$DOMAIN"
    command -v nginx >/dev/null || die "nginx is not installed"
    if [ -d /etc/nginx/sites-available ]; then SITE=/etc/nginx/sites-available/webterm.conf; LINK=/etc/nginx/sites-enabled/webterm.conf
    else SITE=/etc/nginx/conf.d/webterm.conf; LINK=""; fi
    install -d -m 0755 /var/www/webterm-acme
    CERT=""; KEY=""
    if [ -n "${TLS_CERT:-}" ] && [ -n "${TLS_KEY:-}" ]; then
      install -d -m 0750 "$ETC/tls"
      install -m 0644 "$TLS_CERT" "$ETC/tls/$DOMAIN.crt"; install -m 0600 "$TLS_KEY" "$ETC/tls/$DOMAIN.key"
      CERT="$ETC/tls/$DOMAIN.crt"; KEY="$ETC/tls/$DOMAIN.key"
    elif [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
      CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
    fi
    if [ -z "$CERT" ]; then
      # Temporary certificate so nginx can start and answer the ACME challenge.
      install -d -m 0750 "$ETC/tls"
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj "/CN=$DOMAIN" \
        -addext "subjectAltName=DNS:$DOMAIN" -keyout "$ETC/tls/$DOMAIN.selfsigned.key" -out "$ETC/tls/$DOMAIN.selfsigned.crt" 2>/dev/null
      chmod 0600 "$ETC/tls/$DOMAIN.selfsigned.key"
      CERT="$ETC/tls/$DOMAIN.selfsigned.crt"; KEY="$ETC/tls/$DOMAIN.selfsigned.key"
      SELF=1
    fi
    nginx_site "$CERT" "$KEY" "$SITE"
    [ -n "$LINK" ] && ln -sf "$SITE" "$LINK"
    nginx -t >/tmp/webterm-nginx-test.log 2>&1 || { cat /tmp/webterm-nginx-test.log; die "nginx configuration test failed (see above)"; }
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    if [ "${SELF:-0}" = "1" ] && [ "$CERTBOT" = "1" ] && command -v certbot >/dev/null; then
      step "Requesting a Let's Encrypt certificate for $DOMAIN"
      if [ -n "$EMAIL" ]; then ACCT=(--email "$EMAIL"); else ACCT=(--register-unsafely-without-email); fi
      if certbot certonly --webroot -w /var/www/webterm-acme -d "$DOMAIN" --non-interactive --agree-tos "${ACCT[@]}" \
           --deploy-hook "systemctl reload nginx" >/tmp/webterm-certbot.log 2>&1; then
        nginx_site "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$SITE"
        nginx -t >/dev/null 2>&1 && systemctl reload nginx
        SELF=0
      else
        warn "Let's Encrypt failed (see /tmp/webterm-certbot.log). Check that $DOMAIN points to this server and port 80 is reachable,"
        warn "then run:  sudo certbot certonly --webroot -w /var/www/webterm-acme -d $DOMAIN --deploy-hook 'systemctl reload nginx'"
        warn "and re-run this installer. Until then nginx uses a temporary self-signed certificate."
      fi
    elif [ "${SELF:-0}" = "1" ]; then
      warn "Using a temporary self-signed certificate. Provide TLS_CERT/TLS_KEY or enable CERTBOT=1 for a trusted one."
    fi
  fi
fi

sleep 1
systemctl is-active --quiet webterm.service || die "The web server did not start: journalctl -u webterm"
echo
printf '%s✓ WebTerm is running.%s\n\n' "$c_green" "$c_off"
if [ -n "$DOMAIN" ]; then
  echo "   https://$DOMAIN"
  echo "   ${c_dim}(WebTerm listens on 127.0.0.1:$PORT; nginx serves it on 443)${c_off}"
elif [ "$DIRECT_TLS" = "1" ]; then
  FP=$(openssl x509 -in "$ETC/tls/cert.pem" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  for ip in $(hostname -I 2>/dev/null); do case "$ip" in *:*) ;; *) echo "   https://$ip:$PORT" ;; esac; done
  echo "   https://$HOST:$PORT"
  echo
  echo "   ${c_dim}Certificate SHA-256: $FP${c_off}"
else
  echo "   http://127.0.0.1:$PORT (behind your reverse proxy)"
fi
[ "$FRESH" = "1" ] && echo "   Sign in as $ADMIN_USER (terminals run as Linux user $ADMIN_LINUX)."
echo "   Logs: journalctl -u webterm -u webterm-broker -f"
