#!/usr/bin/env bash
# Builds the WebTerm release archive: dist/webterm-<version>.tar.xz
#
# The archive is what users install from. Next to the repository files it
# contains a Node.js runtime (node/) and the server's production dependencies
# with node-pty already compiled (app/node_modules), so installing on x86_64
# needs no compiler and no download of Node.js.
#
#   ./scripts/make-release.sh
#
# Requires: Linux x86_64, bash, curl, tar, xz, Node.js 22 with npm, and a C++
# toolchain + python3 (to compile node-pty).
# Optional environment:
#   NODE_TARBALL=/path/node-v22.x.y-linux-x64.tar.xz   use this Node.js instead of downloading one
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/app/package.json').version")"
NAME="webterm-$VERSION"
OUT="$ROOT/dist"
STAGE="$OUT/$NAME"

step() { printf '\e[1;32m▶\e[0m %s\n' "$*"; }
die() { printf '\e[1;31m✗ %s\e[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "Build the release on Linux x86_64"
[ -f "$ROOT/app/web/dist/index.html" ] || die "app/web/dist is missing"
[ -f "$ROOT/guacd/guacamole-server-1.6.1.tar.gz" ] || die "guacd/guacamole-server-1.6.1.tar.gz is missing"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a===22&&b>=13?0:1)' || die "Node.js 22.13 or newer (22.x) is required to build"

step "Staging $NAME"
rm -rf "$STAGE" "$OUT/$NAME.tar.xz"
mkdir -p "$STAGE"
for f in app install.sh uninstall.sh nginx-webterm.conf remote-desktop guacd LICENSE README.md README.fa.md docs; do
  [ -e "$ROOT/$f" ] && cp -a "$ROOT/$f" "$STAGE/"
done
rm -rf "$STAGE/app/node_modules"

step "Installing production dependencies (compiles node-pty)"
(cd "$STAGE/app" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
(cd "$STAGE/app" && node -e "require('node-pty'); require('ws'); require('@xterm/headless')") || die "dependencies do not load"

step "Adding the Node.js runtime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -n "${NODE_TARBALL:-}" ]; then
  cp "$NODE_TARBALL" "$TMP/node.tar.xz"
else
  # Same major version as the one node-pty was just compiled against.
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  base="https://nodejs.org/dist/latest-v$MAJOR.x"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | awk '$2 ~ /linux-x64\.tar\.xz$/ {print $2; exit}')"
  [ -n "$file" ] || die "Could not reach nodejs.org"
  sum="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$file" '$2==f {print $1}')"
  curl -fsSL "$base/$file" -o "$TMP/node.tar.xz"
  echo "$sum  $TMP/node.tar.xz" | sha256sum -c --quiet || die "Node.js checksum mismatch"
fi
mkdir -p "$TMP/node" "$STAGE/node/bin"
tar -xJf "$TMP/node.tar.xz" -C "$TMP/node" --strip-components=1
cp "$TMP/node/bin/node" "$STAGE/node/bin/node"
cp "$TMP/node/LICENSE" "$STAGE/node/LICENSE"
"$STAGE/node/bin/node" -e "process.chdir('$STAGE/app'); require('$STAGE/app/node_modules/node-pty')" || die "bundled Node.js cannot load node-pty"

step "Packing $NAME.tar.xz"
chmod 0755 "$STAGE/install.sh" "$STAGE/uninstall.sh" "$STAGE/app/bin/"*
tar --owner=0 --group=0 --numeric-owner --sort=name -C "$OUT" -cf - "$NAME" | xz -T0 -9 > "$OUT/$NAME.tar.xz"
rm -rf "$STAGE"
(cd "$OUT" && sha256sum "$NAME.tar.xz" > "$NAME.tar.xz.sha256")
step "Done: dist/$NAME.tar.xz ($(du -h "$OUT/$NAME.tar.xz" | cut -f1))"
cat "$OUT/$NAME.tar.xz.sha256"
