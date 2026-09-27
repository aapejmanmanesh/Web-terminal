// RDP remote desktops through guacd (Apache Guacamole's proxy daemon).
//
//   browser (guacamole-common-js) ⇄ WebSocket ⇄ this server ⇄ guacd ⇄ RDP host
//
// This server performs the Guacamole handshake itself, so the RDP account and
// password stored in the vault never reach a browser. Browser instructions are
// checked against a short list of input/stream opcodes before guacd sees them.
import net from 'node:net';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const HANDSHAKE_TIMEOUT = 20_000;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const MAX_PENDING = 1024 * 1024; // handshake text held while waiting for guacd
// What a browser may send: input, display size, clipboard/audio streams and
// keep-alives. (No argv, file transfer or audio input.)
const CLIENT_OPCODES = new Set(['sync', 'mouse', 'key', 'clipboard', 'blob', 'end', 'ack', 'size', 'disconnect', 'nop', 'touch']);
const SURROGATE = /[\uD800-\uDFFF]/;

// Guacamole status codes used in error instructions to the browser.
const STATUS = { SERVER_ERROR: 0x0200, UPSTREAM_ERROR: 0x0203, UPSTREAM_NOT_FOUND: 0x0207 };

// Element lengths count Unicode code points.
const cpLength = (s) => (SURROGATE.test(s) ? [...s].length : s.length);

export function encode(...elements) {
  return (
    elements
      .map((e) => {
        const s = String(e);
        return `${cpLength(s)}.${s}`;
      })
      .join(',') + ';'
  );
}

// Index just past `n` code points starting at `start`, or -1 if the string ends first.
function advance(str, start, n) {
  const end = start + n;
  if (end <= str.length && !SURROGATE.test(str.slice(start, end))) return end;
  let i = start;
  for (let k = 0; k < n; k++) {
    if (i >= str.length) return -1;
    const c = str.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return i <= str.length ? i : -1;
}

// Parses complete instructions from the start of `str`. Returns
// { list: [[opcode, ...args], …], ends, rest }: ends[i] is the offset just
// after instruction i, rest an unfinished tail. Throws on malformed input.
export function parse(str) {
  const list = [];
  const ends = [];
  let pos = 0;
  let start = 0;
  let cur = [];
  while (pos < str.length) {
    const dot = str.indexOf('.', pos);
    if (dot === -1) {
      if (str.length - pos > 10) throw new Error('bad instruction');
      break;
    }
    const lenText = str.slice(pos, dot);
    if (!/^\d{1,10}$/.test(lenText)) throw new Error('bad instruction');
    const end = advance(str, dot + 1, Number(lenText));
    if (end === -1 || end >= str.length) break; // value or terminator not here yet
    cur.push(str.slice(dot + 1, end));
    const term = str[end];
    pos = end + 1;
    if (term === ';') {
      list.push(cur);
      ends.push(pos);
      cur = [];
      start = pos;
    } else if (term !== ',') throw new Error('bad instruction');
  }
  return { list, ends, rest: str.slice(start) };
}

const int = (v, min, max, def) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

// Connection settings for the three quality choices.
function qualityArgs(q) {
  const on = { 'enable-wallpaper': 'true', 'enable-theming': 'true', 'enable-font-smoothing': 'true', 'enable-full-window-drag': 'true', 'enable-desktop-composition': 'true', 'enable-menu-animations': 'true' };
  if (q === 'best') return { ...on, 'color-depth': '24', 'force-lossless': 'true' };
  if (q === 'fast') return { 'color-depth': '16', 'enable-wallpaper': 'false', 'enable-theming': 'false', 'enable-font-smoothing': 'false', 'enable-full-window-drag': 'false', 'enable-desktop-composition': 'false', 'enable-menu-animations': 'false' };
  return { ...on, 'color-depth': '24', 'enable-menu-animations': 'false', 'enable-full-window-drag': 'false' };
}

export async function runRdp(desktops, ws, auth, system, q) {
  const app = desktops.app;
  const user = auth.user;
  const cfg = app.cfg.guacd || {};
  const width = int(q.get('w'), 320, 8192, 1280);
  const height = int(q.get('h'), 200, 8192, 800);
  const dpi = int(q.get('dpi'), 48, 480, 96);
  const quality = ['best', 'balanced', 'fast'].includes(q.get('q')) ? q.get('q') : 'balanced';
  const audio = q.get('audio') !== '0';
  const tz = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(q.get('tz') || '') ? q.get('tz') : '';

  const sock = net.connect({ host: cfg.host || '127.0.0.1', port: cfg.port || 4822 });
  sock.setNoDelay(true);
  const conn = desktops.track(ws, auth, system, 'rdp', () => sock.destroy());
  const tellBrowser = (msg, code) => {
    if (ws.readyState !== 1) return;
    ws.send(encode('', crypto.randomUUID()) + encode('error', msg, code));
    setTimeout(() => conn.cleanup(), 300);
  };

  // ---------------------------------------------------------------- guacd handshake
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let waiter = null;
  let failure = null;
  const onHandshakeData = (d) => {
    pending += decoder.write(d);
    if (pending.length > MAX_PENDING) failure = new Error('guacd sent an unexpected answer');
    if (waiter) waiter();
  };
  sock.on('data', onHandshakeData);
  sock.on('error', (e) => {
    failure = new Error(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? 'The RDP service (guacd) is not running on the WebTerm server.' : `guacd: ${e.message}`);
    if (waiter) waiter();
  });
  sock.on('close', () => {
    if (!failure) failure = new Error('guacd closed the connection');
    if (waiter) waiter();
    if (conn.piped) conn.cleanup();
  });
  // Next complete instruction from guacd.
  const next = () =>
    new Promise((resolve, reject) => {
      const check = () => {
        let parsed;
        try {
          parsed = parse(pending);
        } catch (e) {
          return reject(e);
        }
        if (parsed.list.length) {
          // Keep anything after the first instruction for later.
          pending = pending.slice(parsed.ends[0]);
          waiter = null;
          return resolve(parsed.list[0]);
        }
        if (failure) return reject(failure);
        waiter = check;
      };
      check();
    });
  const deadline = setTimeout(() => {
    failure = new Error('No answer from the RDP service (guacd)');
    if (waiter) waiter();
  }, HANDSHAKE_TIMEOUT);

  try {
    sock.write(encode('select', 'rdp'));
    const args = await next();
    if (args[0] === 'error') throw new Error(args[1] || 'guacd refused the connection');
    if (args[0] !== 'args') throw new Error('Unexpected answer from guacd');
    const values = {
      hostname: system.address,
      port: String(system.rdp_port),
      username: system.rdp_user || '',
      password: system.rdp_secret ? app.vault.open(system.rdp_secret) : '',
      domain: system.rdp_domain || '',
      security: 'any',
      'ignore-cert': 'true',
      'resize-method': 'display-update',
      width: String(width),
      height: String(height),
      dpi: String(dpi),
      'disable-audio': audio ? 'false' : 'true',
      'enable-audio-input': 'false',
      'enable-drive': 'false',
      'enable-printing': 'false',
      'disable-download': 'true',
      'disable-upload': 'true',
      'normalize-clipboard': 'preserve',
      'client-name': 'WebTerm',
      timezone: tz,
      ...qualityArgs(quality),
    };
    const reply = args.slice(1).map((name) => (/^VERSION_/.test(name) ? 'VERSION_1_5_0' : values[name] ?? ''));
    sock.write(
      encode('size', width, height, dpi) +
        (audio ? encode('audio', 'audio/L16', 'audio/L8') : encode('audio')) +
        encode('video') +
        encode('image', 'image/webp', 'image/jpeg', 'image/png') +
        (tz ? encode('timezone', tz) : '') +
        encode('name', user.username) +
        encode('connect', ...reply),
    );
    const ready = await next();
    if (ready[0] === 'error') throw new Error(ready[1] || 'guacd refused the connection');
    if (ready[0] !== 'ready') throw new Error('Unexpected answer from guacd');
  } catch (e) {
    clearTimeout(deadline);
    app.audit({ userId: user.id, username: user.username }, 'desktop.fail', `${system.name} (rdp): ${e.message}`);
    tellBrowser(e.message, /not running|No answer/.test(e.message) ? STATUS.UPSTREAM_NOT_FOUND : STATUS.SERVER_ERROR);
    return;
  }
  clearTimeout(deadline);
  if (conn.closed) return;
  app.audit({ userId: user.id, username: user.username }, 'desktop.connect', `${system.name} (rdp ${system.address}:${system.rdp_port}) ${width}x${height} ${quality}${audio ? '' : ' muted'}`);

  // ---------------------------------------------------------------- relay
  sock.off('data', onHandshakeData);
  conn.piped = true;
  let paused = false;
  const toBrowser = (text) => {
    if (!text || ws.readyState !== 1) return;
    ws.send(text, () => {
      if (paused && ws.bufferedAmount < LOW_WATER) {
        paused = false;
        sock.resume();
      }
    });
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true;
      sock.pause();
    }
  };
  // The tunnel's first instruction carries its id; then whatever guacd already sent.
  toBrowser(encode('', crypto.randomUUID()) + pending);
  pending = '';
  sock.on('data', (d) => toBrowser(decoder.write(d)));

  let wsPaused = false;
  ws.on('message', (data, isBinary) => {
    if (isBinary || conn.closed) return;
    let parsed;
    try {
      parsed = parse(data.toString('utf8'));
    } catch {
      return conn.cleanup();
    }
    if (parsed.rest) return conn.cleanup(); // browsers send whole instructions
    let out = '';
    for (const ins of parsed.list) {
      const op = ins[0];
      if (op === '') {
        // Tunnel keep-alive: answer the browser directly.
        if (ins[1] === 'ping') toBrowser(encode('', 'ping', ins[2] || ''));
        continue;
      }
      if (CLIENT_OPCODES.has(op)) out += encode(...ins);
    }
    if (!out || sock.destroyed) return;
    sock.write(out);
    if (!wsPaused && sock.writableLength > HIGH_WATER) {
      wsPaused = true;
      ws.pause();
      sock.once('drain', () => {
        wsPaused = false;
        ws.resume();
      });
    }
  });
}
