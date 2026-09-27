#!/usr/bin/env bash
# Removes WebTerm. Data (users, presets, vault, layouts) is kept unless --purge is given.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo ./uninstall.sh [--purge]"; exit 1; }
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
echo "Stopping WebTerm (running terminals will end)…"
systemctl disable --now webterm.service webterm-broker.service webterm-guacd.service 2>/dev/null || true
rm -f /etc/systemd/system/webterm.service /etc/systemd/system/webterm-broker.service /etc/systemd/system/webterm-guacd.service
systemctl daemon-reload
rm -rf /opt/webterm /usr/local/sbin/webterm-admin /run/webterm /run/webterm-ide
if [ "$PURGE" = "1" ]; then
  echo "Purging data and service accounts…"
  rm -rf /var/lib/webterm /var/lib/webterm-ssh /etc/webterm
  userdel webterm 2>/dev/null || true
  userdel webterm-ssh 2>/dev/null || true
  groupdel webterm 2>/dev/null || true
  echo "Linux accounts created for WebTerm users (wt-*) were kept; remove them with: userdel -r <name>"
  echo "The webterm-users group was kept because other accounts may still be in it."
else
  echo "Kept data in /var/lib/webterm and settings in /etc/webterm (use --purge to remove)."
fi
echo "Done."
