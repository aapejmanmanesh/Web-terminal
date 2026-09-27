#!/usr/bin/env bash
# Removes WebTerm. Data (users, presets, vault, layouts) is kept unless --purge is given.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo ./uninstall.sh [--purge]"; exit 1; }
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
echo "Stopping WebTerm (running terminals will end)…"
systemctl disable --now webterm.service webterm-broker.service webterm-guacd.service webterm-cert.timer 2>/dev/null || true
rm -f /etc/systemd/system/webterm.service /etc/systemd/system/webterm-broker.service /etc/systemd/system/webterm-guacd.service \
  /etc/systemd/system/webterm-cert.service /etc/systemd/system/webterm-cert.timer
systemctl daemon-reload
rm -rf /opt/webterm /usr/local/sbin/webterm-admin /usr/local/sbin/webterm-cert /run/webterm /run/webterm-ide
# The nginx site written by the installer (Let's Encrypt certificates are kept).
if [ -e /etc/nginx/sites-enabled/webterm.conf ] || [ -e /etc/nginx/sites-available/webterm.conf ] || [ -e /etc/nginx/conf.d/webterm.conf ]; then
  echo "Removing the nginx site…"
  rm -f /etc/nginx/sites-enabled/webterm.conf /etc/nginx/sites-available/webterm.conf /etc/nginx/conf.d/webterm.conf
  if command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then systemctl reload nginx 2>/dev/null || true; fi
fi
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
