# Development

## Repository layout

```text
install.sh                  installer / upgrader (run as root)
uninstall.sh                removes WebTerm (--purge also deletes data)
nginx-webterm.conf          nginx site template used in domain mode
remote-desktop/             VNC / RDP setup scripts for the machines you connect to
guacd/                      Apache Guacamole server source (built on install for RDP)
app/
  package.json              server dependencies (node-pty, ws, @xterm/headless, …)
  bin/
    webterm-server.mjs      web server entry point      (systemd: webterm)
    webterm-broker.mjs      broker entry point          (systemd: webterm-broker)
    webterm-admin.mjs       command-line administration (/usr/local/sbin/webterm-admin)
    wt-exec, wt-askpass     helpers run as the target user
  lib/
    common/                 configuration loader, broker frame protocol
    broker/broker.js        privileged process owner (terminals, sftp, ssh, IDE)
    server/                 web server: HTTP API, WebSocket hub, auth, files, SSH, systems,
                            remote desktop (VNC / RDP), IDE proxy, plugins, static files
      credit.js             the "Built by APA" credit added to every page
  web/dist/                 the built web interface (served as-is)
scripts/
  make-release.sh           builds dist/webterm-<version>.tar.xz
  rehash-assets.mjs         renames edited web UI chunks to new content hashes
docs/                       documentation
```

## Running from a checkout

The server needs Linux, Node.js 22.13+ and root for the broker. The simplest way to try changes is a VM:

```bash
sudo ./install.sh          # installs from the working tree
# after changing server code:
sudo cp -a app/lib app/bin /opt/webterm/app/ && sudo systemctl restart webterm
# after changing the broker (ends running terminals):
sudo systemctl restart webterm-broker
```

## The web interface

`app/web/dist` contains the built web interface (ES modules, CSS, fonts, icons, the service worker). It's served
as-is: no build step is needed to install or run WebTerm.

Files in `dist/assets/` have content-hashed names and are cached forever by browsers and the service worker.
If you edit one in place, give it and every chunk that imports it a new name:

```bash
node scripts/rehash-assets.mjs c-XXXXXXXX.js
```

The script renames the chunk and all its importers, rewrites the references, regenerates the `.br` / `.gz`
files and updates `index.html`.

The HTML pages don't need precompressed files. The server adds the author credit to each page at startup and
compresses the result itself.

## Building a release

On Linux x86_64 with Node.js 22, a C++ toolchain and python3:

```bash
./scripts/make-release.sh
# → dist/webterm-<version>.tar.xz and .sha256
```

The archive contains the repository files, a Node.js 22 runtime (`node/`) and the production dependencies with
`node-pty` compiled (`app/node_modules`), so installing it on x86_64 needs no compiler and no Node.js download.
The version comes from `app/package.json`; also update `VERSION` in `app/lib/server/app.js` and `CHANGELOG.md`.

### GitHub releases

`.github/workflows/release.yml` builds the archive on GitHub Actions and attaches it to a release:

1. Bump the version (`app/package.json`, `app/package-lock.json`, `app/lib/server/app.js`), update the changelog, and push.
2. On GitHub: **Releases → Draft a new release**, create a tag like `v1.3.1`, and publish.
3. The workflow builds `webterm-1.3.1.tar.xz` (+ `.sha256`) and uploads them to the release.

It can also be started by hand (**Actions → Release → Run workflow**) to build the archive as a downloadable artifact.

## Author credit

`app/lib/server/credit.js` adds the "Built by APA" credit, linking to https://github.com/aapejmanmanesh, to every
page the server serves. The [license](../LICENSE) requires it to stay visible on every page of the interface,
in WebTerm and in works derived from it.
