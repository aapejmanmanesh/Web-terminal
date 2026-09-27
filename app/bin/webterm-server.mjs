#!/usr/bin/env node
import { loadConfig } from '../lib/common/config.js';
import { App } from '../lib/server/app.js';

const cfg = loadConfig();
if (process.getuid && process.getuid() === 0 && !process.env.WEBTERM_ALLOW_ROOT) {
  console.error('Refusing to run the web server as root. Run it as the "webterm" service user.');
  process.exit(1);
}
const app = new App(cfg);
app.listen();
const stop = () => {
  app.log('shutting down');
  app.server.close();
  try { app.store.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('uncaughtException', (e) => app.log('uncaught', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => app.log('unhandled', e && e.stack ? e.stack : e));
