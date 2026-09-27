// Author credit shown at the bottom of every WebTerm page.
//
// The credit is added by the server to each HTML page it serves (so it does
// not depend on the built frontend), is drawn inside a closed shadow root with
// inline !important styles (so page CSS cannot hide it) and is restored by a
// watchdog if it is removed or altered at runtime.
//
// Removing or altering this credit is not permitted by the WebTerm license.

export const CREDIT = Object.freeze({
  text: 'Built by',
  name: 'APA',
  url: 'https://github.com/aapejmanmanesh',
});

// Height of the credit bar; the app area is shrunk by the same amount.
const BAR = 22;

export const CREDIT_SCRIPT_PATH = '/credit.js';

export const CREDIT_SCRIPT = `// WebTerm author credit — see LICENSE.
(() => {
  'use strict';
  const TEXT = ${JSON.stringify(CREDIT.text)};
  const NAME = ${JSON.stringify(CREDIT.name)};
  const URL = ${JSON.stringify(CREDIT.url)};
  const BAR = ${BAR};
  const H = 'calc(' + BAR + 'px + env(safe-area-inset-bottom, 0px))';
  const HOST_STYLE = [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'height:' + H, 'margin:0', 'padding:0', 'display:block',
    'visibility:visible', 'opacity:1', 'z-index:2147483000', 'transform:none', 'filter:none', 'clip-path:none',
    'pointer-events:auto', 'background:#0a0d12', 'border:0', 'border-top:1px solid #1f2733', 'box-sizing:border-box',
  ].map((d) => d + ' !important').join(';');
  const APP_HEIGHT = 'height:calc(100% - ' + H + ') !important';
  const CSS =
    ':host{all:initial}' +
    '.bar{box-sizing:border-box;height:' + (BAR - 1) + 'px;display:flex;align-items:center;justify-content:center;gap:5px;' +
    'font:11px/1 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8b97a6;letter-spacing:.2px;' +
    'user-select:none;-webkit-user-select:none}' +
    'a{color:#3ddc97;text-decoration:none;font-weight:700}' +
    'a:hover,a:focus-visible{color:#7df0be;text-decoration:underline;outline:none}';
  let host = null;
  let link = null;
  let hostCss = null;
  let appCss = null;
  let watchedBody = null;

  function build() {
    host = document.createElement('wt-credit');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'contentinfo');
    const label = document.createElement('span');
    label.textContent = TEXT;
    link = document.createElement('a');
    link.href = URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = NAME;
    link.title = URL;
    bar.append(label, link);
    root.append(style, bar);
    hostCss = null;
    hostObserver.observe(host, { attributes: true });
  }

  // Browsers normalise style text, so compare against what they gave back last
  // time instead of the source string; this keeps the watchdog from re-triggering itself.
  function applyStyle() {
    for (const a of Array.from(host.attributes)) if (a.name !== 'style') host.removeAttribute(a.name);
    if (hostCss === null || host.style.cssText !== hostCss) {
      host.style.cssText = HOST_STYLE;
      hostCss = host.style.cssText;
    }
  }

  function reserveSpace() {
    const app = document.getElementById('app');
    if (!app) return;
    if (appCss === null || app.style.cssText !== appCss) {
      app.style.cssText = app.style.cssText.replace(/(^|;)\\s*height\\s*:[^;]*/g, '') + ';' + APP_HEIGHT;
      appCss = app.style.cssText;
    }
  }

  function intact() {
    if (!host || !host.isConnected || host.parentNode !== document.body) return false;
    if (link.textContent !== NAME || link.getAttribute('href') !== URL || link.target !== '_blank') return false;
    const cs = getComputedStyle(host);
    return cs.display !== 'none' && cs.visibility === 'visible' && cs.opacity === '1' && host.offsetHeight >= BAR - 1;
  }

  function ensure() {
    const body = document.body;
    if (!body) return;
    if (body !== watchedBody) {
      watchedBody = body;
      bodyObserver.observe(body, { childList: true });
    }
    if (host && host.parentNode === body) applyStyle();
    if (!intact()) {
      if (host) host.remove();
      build();
      body.appendChild(host);
      applyStyle();
    }
    reserveSpace();
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      ensure();
    });
  };
  const hostObserver = new MutationObserver(schedule);
  const bodyObserver = new MutationObserver(schedule);

  const start = () => {
    bodyObserver.observe(document.documentElement, { childList: true });
    ensure();
    setInterval(ensure, 1500);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
`;

const TAG = `<script src="${CREDIT_SCRIPT_PATH}" defer></script>`;
const NOSCRIPT = `<noscript><p style="position:fixed;left:0;right:0;bottom:0;margin:0;padding:4px;text-align:center;font:11px monospace;background:#0a0d12;color:#8b97a6">${CREDIT.text} <a href="${CREDIT.url}" style="color:#3ddc97">${CREDIT.name}</a></p></noscript>`;

// Adds the credit to an HTML document (idempotent).
export function withCredit(html) {
  let s = String(html);
  if (s.includes(TAG)) return s;
  s = s.includes('</head>') ? s.replace('</head>', TAG + '\n</head>') : TAG + s;
  s = s.includes('</body>') ? s.replace('</body>', NOSCRIPT + '\n</body>') : s + NOSCRIPT;
  return s;
}
