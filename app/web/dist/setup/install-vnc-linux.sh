#!/usr/bin/env bash
# WebTerm remote desktop — server setup for Linux desktops (x11vnc).
#
# Shares this machine's real screen for WebTerm's "Screen" windows: the login
# screen right after boot, and the desktop once someone has logged in. Starts
# with the machine; only the WebTerm server needs to be able to reach it.
#
#   sudo bash install-vnc-linux.sh                 install or update (asks a few questions)
#   sudo bash install-vnc-linux.sh --uninstall     remove it again
#
# Unattended: --allow <WebTerm server IP> --port <port> --password-file <file> --yes
set -euo pipefail
export LC_ALL=C

PORT=5900
ALLOW=""
PW_IN=""
YES=0
MODE=install
CONF_DIR=/etc/webterm-vnc
LIB_DIR=/usr/local/lib/webterm-vnc
UNIT=/etc/systemd/system/webterm-vnc.service
NEED_REBOOT=0

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
    --password-file) PW_IN=${2:-}; shift ;;
    --yes | -y) YES=1 ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
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

# Networks this machine is on (for "allow the local network"), as a.b.c.d/n.
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

# ------------------------------------------------------------------ firewall
firewall() { # add|remove <source> <port>
  local op=$1 src=$2 port=$3
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    if [ "$op" = add ]; then
      ufw allow proto tcp from "$src" to any port "$port" comment 'WebTerm VNC' >/dev/null && say "firewall (ufw): allowed $src → port $port"
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

firewall_sources() { # the sources the saved config opened
  if [ -n "${1:-}" ]; then echo "$1"; else local_networks; fi
}

# ------------------------------------------------------------------ uninstall
if [ "$MODE" = uninstall ]; then
  say "removing WebTerm remote desktop"
  systemctl disable --now webterm-vnc.service >/dev/null 2>&1 || true
  if [ -r "$CONF_DIR/config" ]; then
    OLD_PORT=$(sed -n 's/^PORT=//p' "$CONF_DIR/config")
    OLD_ALLOW=$(sed -n 's/^ALLOW=//p' "$CONF_DIR/config")
    if valid_port "${OLD_PORT:-x}"; then
      for s in $(firewall_sources "$OLD_ALLOW"); do firewall remove "$s" "$OLD_PORT"; done
    fi
  fi
  rm -f "$UNIT"
  rm -rf "$LIB_DIR" "$CONF_DIR"
  systemctl daemon-reload
  for f in /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
    [ -f "$f.webterm-backup" ] && echo "note: Wayland was turned off for the login screen; to undo: sudo cp $f.webterm-backup $f && reboot"
  done
  say "done (the x11vnc package itself was left installed)"
  exit 0
fi

# ------------------------------------------------------------------ questions
ask() { # ask <prompt> <default> → REPLY
  REPLY=""
  if [ "$YES" -eq 0 ] && [ -t 0 ]; then read -r -p "$1" REPLY || true; fi
  [ -n "$REPLY" ] || REPLY=$2
}

echo
echo "WebTerm remote desktop setup (x11vnc)"
echo "Shares this screen with your WebTerm server — the login screen after boot and the desktop after login."
echo

if [ -z "$ALLOW" ] && [ -r "$CONF_DIR/config" ]; then ALLOW=$(sed -n 's/^ALLOW=//p' "$CONF_DIR/config"); fi
while :; do
  ask "WebTerm server IP address${ALLOW:+ [$ALLOW]} (Enter = allow the whole local network): " "$ALLOW"
  ALLOW=$REPLY
  [ -z "$ALLOW" ] || valid_ipv4 "$ALLOW" && break
  echo "  that is not an IPv4 address (example: 192.168.1.10)"
  ALLOW=""
  [ "$YES" -eq 0 ] && [ -t 0 ] || die "invalid --allow address"
done
while :; do
  ask "VNC port [$PORT]: " "$PORT"
  valid_port "$REPLY" && PORT=$REPLY && break
  echo "  enter a number between 1 and 65535"
  [ "$YES" -eq 0 ] && [ -t 0 ] || die "invalid --port"
done

PW=""
GENERATED=0
if [ -n "$PW_IN" ]; then
  [ -r "$PW_IN" ] || die "cannot read $PW_IN"
  IFS= read -r PW <"$PW_IN" || true
elif [ "$YES" -eq 0 ] && [ -t 0 ]; then
  while :; do
    IFS= read -r -s -p "VNC password (up to 8 characters; Enter = generate one): " PW || true
    echo
    [ -z "$PW" ] && break
    IFS= read -r -s -p "Repeat the password: " PW2 || true
    echo
    [ "$PW" = "$PW2" ] && break
    echo "  the two entries differ — try again"
  done
fi
if [ -z "$PW" ]; then
  PW=$(LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom 2>/dev/null | head -c 8 || true)
  GENERATED=1
fi
[[ $PW =~ ^[[:print:]]+$ ]] || die "the password may only contain printable characters"
if [ ${#PW} -gt 8 ]; then
  PW=${PW:0:8}
  warn "VNC uses only the first 8 characters — the password is: $PW"
fi

# ------------------------------------------------------------------ packages
if ! command -v x11vnc >/dev/null; then
  say "installing x11vnc"
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq x11vnc
  elif command -v dnf >/dev/null; then
    dnf install -y x11vnc || die "x11vnc is not in your repositories (on RHEL/Alma/Rocky enable EPEL first)"
  elif command -v pacman >/dev/null; then
    pacman -Sy --noconfirm --needed x11vnc
  elif command -v zypper >/dev/null; then
    zypper --non-interactive install x11vnc
  else
    die "install the x11vnc package with your package manager, then run this again"
  fi
fi
command -v x11vnc >/dev/null || die "x11vnc did not install"

# ------------------------------------------------------------------ login screen on X11
# x11vnc shares X11 displays. GNOME's login screen uses Wayland by default, so
# it is switched to X11 (sessions started from it follow). Other display
# managers (LightDM, SDDM with an X11 session) already work.
DM=""
if [ "$(systemctl show -p LoadState --value display-manager.service 2>/dev/null || true)" = loaded ]; then
  DM=$(systemctl show -p Id --value display-manager.service 2>/dev/null || true)
fi
case "$DM" in
  gdm*.service)
    ls /usr/share/xsessions/*.desktop >/dev/null 2>&1 ||
      die "this GNOME has no X11 session any more (GNOME 49 or newer), which x11vnc needs; use NoMachine or GNOME Remote Desktop here instead"
    GDM_CONF=""
    for f in /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
      if [ -d "${f%/*}" ]; then GDM_CONF=$f; break; fi
    done
    [ -n "$GDM_CONF" ] || die "could not find GDM's custom.conf"
    [ -f "$GDM_CONF" ] || printf '[daemon]\n' >"$GDM_CONF"
    if ! grep -Eq '^[[:space:]]*WaylandEnable[[:space:]]*=[[:space:]]*false' "$GDM_CONF"; then
      [ -f "$GDM_CONF.webterm-backup" ] || cp -a "$GDM_CONF" "$GDM_CONF.webterm-backup"
      if grep -Eq '^[#[:space:]]*WaylandEnable[[:space:]]*=' "$GDM_CONF"; then
        sed -i -E 's/^[#[:space:]]*WaylandEnable[[:space:]]*=.*/WaylandEnable=false/' "$GDM_CONF"
      elif grep -q '^\[daemon\]' "$GDM_CONF"; then
        sed -i '/^\[daemon\]/a WaylandEnable=false' "$GDM_CONF"
      else
        printf '\n[daemon]\nWaylandEnable=false\n' >>"$GDM_CONF"
      fi
      say "login screen switched to X11 ($GDM_CONF; backup: $GDM_CONF.webterm-backup)"
      NEED_REBOOT=1
    fi
    ;;
  "") warn "no display manager found — x11vnc will share an X11 desktop once one is running" ;;
  *) : ;;
esac

# ------------------------------------------------------------------ files
OLD_ALLOW=""
OLD_PORT=""
if [ -r "$CONF_DIR/config" ]; then
  OLD_ALLOW=$(sed -n 's/^ALLOW=//p' "$CONF_DIR/config")
  OLD_PORT=$(sed -n 's/^PORT=//p' "$CONF_DIR/config")
fi
install -d -m 755 "$CONF_DIR" "$LIB_DIR"
(
  umask 077
  printf '%s\n' "$PW" >"$CONF_DIR/password.new"
)
mv -f "$CONF_DIR/password.new" "$CONF_DIR/password"
printf 'PORT=%s\nALLOW=%s\n' "$PORT" "$ALLOW" >"$CONF_DIR/config"
chmod 644 "$CONF_DIR/config"

cat >"$LIB_DIR/run.sh" <<'RUN'
#!/bin/bash
# WebTerm remote desktop: runs x11vnc on whatever is on this machine's screen
# right now (the login screen or the logged-in desktop) and follows it when
# that changes. Started by webterm-vnc.service.
set -u
PORT=5900
ALLOW=""
[ -r /etc/webterm-vnc/config ] && . /etc/webterm-vnc/config
[[ $PORT =~ ^[0-9]{1,5}$ ]] || PORT=5900
[[ $ALLOW =~ ^[0-9.,]*$ ]] || ALLOW=""

# Without a WebTerm server address, accept only this machine's own networks
# (as x11vnc address prefixes, e.g. "192.168.1.").
lan_prefixes() {
  local cidr ip len a b c out=""
  while read -r cidr; do
    ip=${cidr%/*}
    len=${cidr#*/}
    IFS=. read -r a b c _ <<<"$ip"
    if [ "$len" -ge 24 ]; then out="$out,$a.$b.$c."
    elif [ "$len" -ge 16 ]; then out="$out,$a.$b."
    elif [ "$len" -ge 8 ]; then out="$out,$a."
    fi
  done < <(ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}')
  out=${out#,}
  echo "${out:-127.0.0.1}"
}

# User id of the session on the monitor (the login screen's or the user's).
active_uid() {
  local s
  s=$(loginctl show-seat seat0 -p ActiveSession --value 2>/dev/null) || return 0
  [ -n "$s" ] && loginctl show-session "$s" -p User --value 2>/dev/null
  return 0
}

# Prints "<display> <auth file>" for the X server on the active virtual
# terminal (the one on the monitor).
find_x() {
  local vt pid a i disp auth onvt sock owner auid first="" count=0
  local -a args
  vt=$(cat /sys/class/tty/tty0/active 2>/dev/null || true)
  vt=${vt#tty}
  auid=$(active_uid)
  for pid in $({ pgrep -x Xorg; pgrep -x X; pgrep -f '^/usr/(lib|libexec)/xorg/Xorg( |$)'; pgrep -f '^/usr/libexec/Xorg( |$)'; } 2>/dev/null | sort -un); do
    [ -r "/proc/$pid/cmdline" ] || continue
    # Only X servers run by root or by the session on the monitor count
    # (anyone can start a process called Xorg).
    owner=$(stat -c %u "/proc/$pid" 2>/dev/null) || continue
    if [ "$owner" != 0 ]; then
      if [ -n "$auid" ]; then [ "$owner" = "$auid" ] || continue
      else [ "$owner" -lt 1000 ] || continue
      fi
    fi
    mapfile -d '' args <"/proc/$pid/cmdline" 2>/dev/null || continue
    disp=""
    auth=""
    onvt=""
    for ((i = 1; i < ${#args[@]}; i++)); do
      a=${args[i]}
      case "$a" in
        :[0-9]*) disp=$a ;;
        vt[0-9]*) [ -n "$vt" ] && [ "${a#vt}" = "$vt" ] && onvt=1 ;;
        -auth) auth=${args[i + 1]:-} ;;
      esac
    done
    if [ -z "$disp" ]; then # started with -displayfd: look up its socket
      sock=$(ss -xlpn 2>/dev/null | grep -F "pid=$pid," | grep -o '/tmp/\.X11-unix/X[0-9]*' | head -n 1)
      [ -n "$sock" ] && disp=":${sock##*X}"
    fi
    [ -n "$disp" ] || continue
    [ -n "$auth" ] && [ -r "$auth" ] || auth=guess
    if [ -n "$onvt" ]; then
      echo "$disp $auth"
      return 0
    fi
    count=$((count + 1))
    [ -z "$first" ] && first="$disp $auth"
  done
  # A single X server without a VT argument: that is the screen.
  [ "$count" -eq 1 ] && echo "$first"
  return 0
}

pid=""
cur=""
fails=0
disp=""
auth=""
allow=""
stop_vnc() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  pid=""
}
trap 'stop_vnc; exit 0' TERM INT

while :; do
  want=$(find_x)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null
    pid=""
    fails=$((fails + 1))
  fi
  if [ "$want" != "$cur" ] || { [ -z "$pid" ] && [ -n "$want" ]; }; then
    [ "$want" != "$cur" ] && fails=0
    stop_vnc
    cur=$want
    if [ -n "$want" ]; then
      read -r disp auth <<<"$want"
      allow=${ALLOW:-$(lan_prefixes)}
      echo "sharing display $disp (clients from $allow)"
      x11vnc -display "$disp" -auth "$auth" -rfbport "$PORT" -passwdfile /etc/webterm-vnc/password \
        -allow "$allow" -forever -shared -repeat -xkb -noxdamage -nowf -noscr \
        -xrandr newfbsize -wait 10 -defer 10 -nossl -quiet &
      pid=$!
    else
      echo "no X11 screen right now (Wayland session or text console?) — waiting"
    fi
  fi
  # Back off while x11vnc keeps failing on the same screen.
  delay=2
  [ "$fails" -gt 2 ] && delay=$((fails > 15 ? 30 : fails * 2))
  sleep "$delay" &
  wait $! 2>/dev/null
done
RUN
chmod 755 "$LIB_DIR/run.sh"

cat >"$UNIT" <<'UNITFILE'
[Unit]
Description=WebTerm remote desktop (x11vnc on the login screen and the active desktop)
After=display-manager.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/lib/webterm-vnc/run.sh
Restart=always
RestartSec=3
KillMode=control-group

[Install]
WantedBy=graphical.target
UNITFILE

# ------------------------------------------------------------------ firewall + start
if valid_port "${OLD_PORT:-x}" && { [ "$OLD_PORT" != "$PORT" ] || [ "$OLD_ALLOW" != "$ALLOW" ]; }; then
  for s in $(firewall_sources "$OLD_ALLOW"); do firewall remove "$s" "$OLD_PORT"; done
fi
for s in $(firewall_sources "$ALLOW"); do firewall add "$s" "$PORT"; done

systemctl daemon-reload
systemctl enable webterm-vnc.service >/dev/null 2>&1
systemctl restart webterm-vnc.service

LISTENING=0
if [ "$NEED_REBOOT" -eq 0 ]; then
  for _ in $(seq 1 20); do
    if ss -ltn 2>/dev/null | grep -Eq "[:.]${PORT}[[:space:]]"; then
      LISTENING=1
      break
    fi
    sleep 0.5
  done
fi

IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | paste -sd ' ' - || true)
echo
say "installed — starts with the machine (service: webterm-vnc)"
if [ "$NEED_REBOOT" -eq 1 ]; then
  echo "   Reboot once so the login screen starts on X11:  sudo reboot"
elif [ "$LISTENING" -eq 0 ]; then
  warn "not sharing yet — no X11 screen is on the monitor right now. Log out or reboot; details: journalctl -u webterm-vnc"
fi
echo
echo "   In WebTerm: Systems → this machine → edit:"
[ -n "$IPS" ] || IPS="<this machine's IP address>"
echo "     IP / host     : $IPS"
echo "     VNC port      : $PORT"
if [ "$GENERATED" -eq 1 ]; then
  echo "     VNC password  : $PW"
else
  echo "     VNC password  : the one you just entered"
fi
echo "   then use the Screen button."
if [ -z "$ALLOW" ]; then
  echo "   (Accepting connections from this machine's local network. Run this again with your WebTerm server's IP to allow only it.)"
fi
echo
