# Remote desktop

WebTerm opens the screens of your machines right inside the workspace:

| | **VNC** | **RDP** |
|---|---|---|
| What you see | The machine's **physical screen**, including the login screen right after boot | A **separate session**: you sign in and get your own desktop |
| Sound | No | Yes |
| Machines | Windows (any edition), Linux with X11 | Windows Pro / Enterprise / Education, Ubuntu 24.04+ with GNOME, any RDP server (xrdp, …) |
| Path | Browser ⇄ WebTerm ⇄ VNC server | Browser ⇄ WebTerm ⇄ guacd (on the WebTerm server) ⇄ RDP server |

The WebTerm server connects to the machine. The machine never needs to be reachable from the internet, and
the passwords stay on the WebTerm server: it performs the VNC / RDP login itself, so they never reach the browser.

- [1. Prepare the machine](#1-prepare-the-machine)
- [2. Add it to WebTerm](#2-add-it-to-webterm)
- [3. Connect](#3-connect)
- [Troubleshooting](#troubleshooting)

## 1. Prepare the machine

WebTerm ships setup scripts for common cases. Download them from **Systems → + (add or edit a system) → "Server setup"**,
or take them from the `remote-desktop/` folder of the release. Each script asks a few questions:

- **WebTerm server IP address**: only this address may connect (the firewall is set up accordingly). Press
  Enter to allow the whole local network instead. The Systems form shows your WebTerm server's LAN addresses.
- **Port**: the default is fine unless something else uses it.
- **Password** (and for RDP, a user name).

Every script can be undone with `--uninstall` (Linux) or `/uninstall` (Windows).

### Windows: VNC (all editions, including Home)

`install-vnc-windows.cmd`: right-click → **Run as administrator**.

- Installs **TightVNC Server** as a Windows service: it starts with Windows and shows the sign-in screen before
  anyone logs in. It works next to NoMachine (different port).
- If a `tightvnc-*-gpl-setup-64bit.msi` is next to the script, it's used instead of downloading one.
- Adds a firewall rule that lets only the WebTerm server in.

### Windows: RDP with sound (Pro, Enterprise, Education)

`install-rdp-windows.cmd`: right-click → **Run as administrator**.

- Turns on Windows' built-in **Remote Desktop**, with Network Level Authentication and sound.
- Restricts the firewall rule to the WebTerm server.
- In WebTerm, use a Windows account name and password as the RDP user (for Microsoft accounts, the e-mail address).
- Windows Home has no RDP server. Use VNC there.

### Linux: VNC (X11 desktops)

```bash
sudo bash install-vnc-linux.sh                  # asks a few questions
sudo bash install-vnc-linux.sh --uninstall
# unattended:
sudo bash install-vnc-linux.sh --allow 192.168.1.10 --port 5900 --password-file /root/vncpw --yes
```

- Installs **x11vnc** as a service (`webterm-vnc`) that shares the real screen: the login screen after boot,
  and the desktop once someone has logged in.
- Needs an X11 session. On Ubuntu with Wayland, the script switches the login screen to X11 (and tells you to reboot).

### Ubuntu / GNOME: RDP with sound

```bash
sudo bash install-rdp-gnome.sh                  # asks a few questions
sudo bash install-rdp-gnome.sh --uninstall
# unattended:
sudo bash install-rdp-gnome.sh --allow 192.168.1.10 --port 3389 --user webterm --password-file /root/rdppw --yes
```

- Uses GNOME's own **Remote Login** (Ubuntu 24.04+ / GNOME 46+, works with Wayland).
- After boot the machine answers RDP by itself: WebTerm shows the GNOME login screen, you sign in with your
  Ubuntu account and get your desktop with sound.
- Remote sessions run beside anyone working at the machine. They aren't thrown out.
- The RDP user name and password asked for here are only for WebTerm → this machine, not your Ubuntu account.

### Other machines

Any standard VNC server (RealVNC, TigerVNC, x11vnc, macOS Screen Sharing with a VNC password) or RDP server
(xrdp, Windows Server) works. Allow the WebTerm server's IP to reach the port.

## 2. Add it to WebTerm

As an administrator, open **Systems** and click **+** (or click an existing system to edit it):

| Field | Example |
|---|---|
| Name | `office-pc` |
| IP / host | `192.168.1.20` |
| MAC | `3c:7c:3f:a1:22:9e` *(for Wake-on-LAN, optional)* |
| VNC port / VNC password | `5900` / the password from the setup script |
| RDP port / RDP user / RDP password / Domain | `3389` / `alice` / … / *(optional)* |
| All users may connect | Off = administrators only |

Leave a port empty to turn that method off. Passwords are stored encrypted. Leave the field empty when editing
to keep the saved one, or tick *Remove the saved password*.

## 3. Connect

In the **Systems** panel, click the **screen** icon on the machine's row (right-click: floating window). If both
VNC and RDP are set up, choose one. The desktop opens as a pane you can split, tab, float or make full screen,
just like a terminal.

Toolbar: scaling (fit / match window / server resolution), quality, special keys (`Ctrl+Alt+Del`, `Alt+Tab`,
`Windows`, …), clipboard, view only, full screen, reconnect, and for RDP, sound.

Tip: Wake-on-LAN and remote desktop together let you start a machine at home or in the lab and use it
from anywhere, without exposing it to the internet.

## Troubleshooting

| Problem | Check |
|---|---|
| "Connection refused" / times out | Is the VNC / RDP service running on the machine? Does its firewall allow the **WebTerm server's** IP? Try `nc -vz <ip> <port>` on the WebTerm server. |
| VNC: authentication failed | VNC uses only the first 8 characters of the password. Re-enter the password in WebTerm. |
| RDP: "The RDP service (guacd) is not running on the WebTerm server." | Check `systemctl status webterm-guacd`. If the build failed during install, see `/tmp/webterm-guacd-build.log` and re-run the installer. |
| RDP: security negotiation failed | Windows: make sure NLA is on and the user may use Remote Desktop (member of *Remote Desktop Users* or an administrator). |
| RDP: black screen on Linux (xrdp) | Log the user out locally, or use GNOME Remote Login (`install-rdp-gnome.sh`). |
| Linux VNC shows only a black screen | The session runs on Wayland. Re-run `install-vnc-linux.sh` (it switches to X11) and reboot. |
