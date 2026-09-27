#!/usr/bin/env bash
# WebTerm remote desktop over RDP — setup for Ubuntu / GNOME (GNOME's own
# "Remote Login", Wayland-ready: Ubuntu 24.04 and newer, GNOME 46+).
#
# After boot the machine answers RDP by itself: WebTerm shows the GNOME login
# screen, you sign in with your Ubuntu account and get your desktop with sound.
# Remote sessions run beside anyone working at the machine — they are not
# thrown out.
#
#   sudo bash install-rdp-gnome.sh                 set up or update (asks a few questions)
#   sudo bash install-rdp-gnome.sh --uninstall     turn it off again
#
# Unattended: --allow <WebTerm server IP> --port <port> --user <rdp user> --password-file <file> --yes
set -euo pipefail
export LC_ALL=C

PORT=3389
ALLOW=""
RDP_USER=""
PW_IN=""
YES=0
MODE=install
STATE=/etc/webterm-rdp.conf

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall | uninstall) MODE=uninstall ;;
    --allow) ALLOW=${2:-}; shift ;;
    --port) PORT=${2:-}; shift ;;
    --user) RDP_USER=${2:-}; shift ;;
    --password-file) PW_IN=${2:-}; shift ;;
    --yes | -y) YES=1 ;;
    -h | --help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "run it as root:  sudo bash $0"
command -v systemctl >/dev/null || die "this setup needs systemd"

valid_ipv4() {
  local ip=$1 o
  [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done
}
valid_port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

local_networks() {
  local cidr ip len a b c d n mask
  ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | while read -r cidr; do
    ip=${cidr%/*}
    len=${cidr#*/}
    IFS=. read -r a b c d <<<"$ip"
    n=$(((a << 24) | (b << 16) | (c << 8) | d))
    mask=$(((0xffffffff << (32 - len)) & 0xffffffff))
    n=$((n & mask))
    echo "$(((n >> 24) & 255)).$(((n >> 16) & 255)).$(((n >> 8) & 255)).$((n & 255))/$len"
  done | sort -u
}

firewall() { # add|remove <source> <port>
  local op=$1 src=$2 port=$3
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    if [ "$op" = add ]; then
      ufw allow proto tcp from "$src" to any port "$port" comment 'WebTerm RDP' >/dev/null && say "firewall (ufw): allowed $src → port $port"
    else
      ufw --force delete allow proto tcp from "$src" to any port "$port" >/dev/null 2>&1 || true
    fi
  fi
  if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    local rule="rule family=ipv4 source address=$src port port=$port protocol=tcp accept"
    if [ "$op" = add ]; then
      firewall-cmd -q --permanent --add-rich-rule="$rule" 2>/dev/null || true
      say "firewall (firewalld): allowed $src → port $port"
    else
      firewall-cmd -q --permanent --remove-rich-rule="$rule" 2>/dev/null || true
    fi
    firewall-cmd -q --reload 2>/dev/null || true
  fi
}
firewall_sources() { if [ -n "${1:-}" ]; then echo "$1"; else local_networks; fi; }

# ------------------------------------------------------------------ uninstall
if [ "$MODE" = uninstall ]; then
  say "turning off GNOME Remote Login (RDP)"
  if command -v grdctl >/dev/null; then
    grdctl --system rdp disable >/dev/null 2>&1 || true
    grdctl --system rdp clear-credentials >/dev/null 2>&1 || true
  fi
  systemctl disable --now gnome-remote-desktop.service >/dev/null 2>&1 || true
  if [ -r "$STATE" ]; then
    OLD_PORT=$(sed -n 's/^PORT=//p' "$STATE")
    OLD_ALLOW=$(sed -n 's/^ALLOW=//p' "$STATE")
    if valid_port "${OLD_PORT:-x}"; then
      for s in $(firewall_sources "$OLD_ALLOW"); do firewall remove "$s" "$OLD_PORT"; done
    fi
    rm -f "$STATE"
  fi
  say "done"
  exit 0
fi

# ------------------------------------------------------------------ checks
if ! command -v grdctl >/dev/null; then
  say "installing gnome-remote-desktop"
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gnome-remote-desktop
  elif command -v dnf >/dev/null; then
    dnf install -y gnome-remote-desktop
  else
    die "install the gnome-remote-desktop package, then run this again"
  fi
fi
command -v grdctl >/dev/null || die "grdctl (gnome-remote-desktop) is missing"
grdctl --help 2>&1 | grep -q -- '--system' || die "this gnome-remote-desktop has no Remote Login (needs GNOME 46 or newer)"
id gnome-remote-desktop >/dev/null 2>&1 || die "the gnome-remote-desktop system user is missing — reinstall the gnome-remote-desktop package"
command -v openssl >/dev/null || die "openssl is missing"
GRD_HOME=$(getent passwd gnome-remote-desktop | cut -d: -f6)
[ -n "$GRD_HOME" ] || GRD_HOME=/var/lib/gnome-remote-desktop

# ------------------------------------------------------------------ questions
ask() {
  REPLY=""
  if [ "$YES" -eq 0 ] && [ -t 0 ]; then read -r -p "$1" REPLY || true; fi
  [ -n "$REPLY" ] || REPLY=$2
}
echo
echo "WebTerm remote desktop setup — RDP (GNOME Remote Login)"
echo "The machine answers RDP from boot; WebTerm shows the GNOME login screen."
echo

if [ -z "$ALLOW" ] && [ -r "$STATE" ]; then ALLOW=$(sed -n 's/^ALLOW=//p' "$STATE"); fi
while :; do
  ask "WebTerm server IP address${ALLOW:+ [$ALLOW]} (Enter = allow the whole local network): " "$ALLOW"
  ALLOW=$REPLY
  [ -z "$ALLOW" ] || valid_ipv4 "$ALLOW" && break
  echo "  that is not an IPv4 address (example: 192.168.1.10)"
  ALLOW=""
  [ "$YES" -eq 0 ] && [ -t 0 ] || die "invalid --allow address"
done
while :; do
  ask "RDP port [$PORT]: " "$PORT"
  valid_port "$REPLY" && PORT=$REPLY && break
  echo "  enter a number between 1 and 65535"
  [ "$YES" -eq 0 ] && [ -t 0 ] || die "invalid --port"
done
while :; do
  ask "RDP user name (only for WebTerm → this machine, not your Ubuntu account) [${RDP_USER:-webterm}]: " "${RDP_USER:-webterm}"
  RDP_USER=$REPLY
  [[ $RDP_USER =~ ^[A-Za-z0-9._@-]{1,64}$ ]] && break
  echo "  use letters, digits and . _ @ - only"
  RDP_USER=""
  [ "$YES" -eq 0 ] && [ -t 0 ] || die "invalid --user"
done

PW=""
GENERATED=0
if [ -n "$PW_IN" ]; then
  [ -r "$PW_IN" ] || die "cannot read $PW_IN"
  IFS= read -r PW <"$PW_IN" || true
elif [ "$YES" -eq 0 ] && [ -t 0 ]; then
  while :; do
    IFS= read -r -s -p "RDP password (Enter = generate one): " PW || true
    echo
    [ -z "$PW" ] && break
    IFS= read -r -s -p "Repeat the password: " PW2 || true
    echo
    [ "$PW" = "$PW2" ] && break
    echo "  the two entries differ — try again"
  done
fi
if [ -z "$PW" ]; then
  PW=$(tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom 2>/dev/null | head -c 20 || true)
  GENERATED=1
fi
[[ $PW =~ ^[[:print:]]+$ ]] || die "the password may only contain printable characters"

# ------------------------------------------------------------------ TLS certificate
install -d -m 700 -o gnome-remote-desktop -g gnome-remote-desktop "$GRD_HOME/webterm"
CRT="$GRD_HOME/webterm/rdp-tls.crt"
KEY="$GRD_HOME/webterm/rdp-tls.key"
if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
  say "creating the RDP certificate"
  (
    umask 077
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 -subj "/CN=$(hostname)" -keyout "$KEY" -out "$CRT" >/dev/null 2>&1
  ) || die "could not create the TLS certificate"
  chown gnome-remote-desktop:gnome-remote-desktop "$CRT" "$KEY"
  chmod 600 "$KEY"
  chmod 644 "$CRT"
fi

# ------------------------------------------------------------------ configure
say "configuring GNOME Remote Login"
systemctl enable --now gnome-remote-desktop.service >/dev/null 2>&1 || true
grd() { # grd <description> <grdctl args…>
  local what=$1
  shift
  grdctl --system "$@" >/dev/null 2>&1 || die "could not $what (grdctl --system $1 $2 failed; see: journalctl -u gnome-remote-desktop)"
}
grd "set the TLS key" rdp set-tls-key "$KEY"
grd "set the TLS certificate" rdp set-tls-cert "$CRT"
if [ "$PORT" != 3389 ]; then grd "set the port" rdp set-port "$PORT"; fi
grdctl --system rdp disable-port-negotiation >/dev/null 2>&1 || true
grd "set the RDP user and password" rdp set-credentials "$RDP_USER" "$PW"
grd "enable RDP" rdp enable
systemctl restart gnome-remote-desktop.service

# ------------------------------------------------------------------ firewall
OLD_ALLOW=""
OLD_PORT=""
if [ -r "$STATE" ]; then
  OLD_ALLOW=$(sed -n 's/^ALLOW=//p' "$STATE")
  OLD_PORT=$(sed -n 's/^PORT=//p' "$STATE")
fi
if valid_port "${OLD_PORT:-x}" && { [ "$OLD_PORT" != "$PORT" ] || [ "$OLD_ALLOW" != "$ALLOW" ]; }; then
  for s in $(firewall_sources "$OLD_ALLOW"); do firewall remove "$s" "$OLD_PORT"; done
fi
for s in $(firewall_sources "$ALLOW"); do firewall add "$s" "$PORT"; done
printf 'PORT=%s\nALLOW=%s\n' "$PORT" "$ALLOW" >"$STATE"
chmod 644 "$STATE"

# ------------------------------------------------------------------ check
LISTENING=0
for _ in $(seq 1 20); do
  if ss -ltn 2>/dev/null | grep -Eq "[:.]${PORT}[[:space:]]"; then
    LISTENING=1
    break
  fi
  sleep 0.5
done

IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | paste -sd ' ' - || true)
[ -n "$IPS" ] || IPS="<this machine's IP address>"
echo
if [ "$LISTENING" -eq 1 ]; then
  say "done — GNOME Remote Login answers on port $PORT (starts with the machine)"
else
  warn "GNOME Remote Login is configured but not listening on port $PORT yet — see: journalctl -u gnome-remote-desktop"
fi
echo
echo "   In WebTerm: Systems → this machine → edit:"
echo "     IP / host     : $IPS"
echo "     RDP port      : $PORT"
echo "     RDP user      : $RDP_USER"
if [ "$GENERATED" -eq 1 ]; then
  echo "     RDP password  : $PW"
else
  echo "     RDP password  : the one you just entered"
fi
echo "   Then choose RDP on the Screen button: the GNOME login screen appears —"
echo "   sign in with your Ubuntu account."
FW=0
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then FW=1; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then FW=1; fi
if [ "$FW" -eq 0 ]; then
  echo "   (No firewall is active on this machine, so the port is reachable from the network;"
  echo "    RDP still needs the user and password above.)"
elif [ -z "$ALLOW" ]; then
  echo "   (The firewall accepts the local network. Run this again with your WebTerm server's IP to allow only it.)"
fi
echo
