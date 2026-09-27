#!/usr/bin/env node
// Re-names edited chunks of the prebuilt web UI (app/web/dist/assets).
//
// Asset files are content-hashed and cached forever by browsers and the
// service worker, so a chunk that was edited in place must get a new name.
// This renames the given chunks plus every chunk that (transitively) imports
// them, rewrites the references, regenerates the .br/.gz variants and
// updates the HTML pages.
//
//   node scripts/rehash-assets.mjs c-XXXXXXXX.js [...]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/web/dist');
const ASSETS = path.join(DIST, 'assets');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const hashName = (name, data) => {
  const h = crypto.createHash('sha256').update(data).digest();
  let n = 0n;
  for (const b of h.subarray(0, 5)) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += B32[Number((n >> BigInt(i * 5)) & 31n)];
  return name.replace(/-[A-Z0-9]{8}\.js$/, `-${out}.js`);
};
const refsOf = (src) => new Set([...src.matchAll(/["']\.\/([\w-]+\.js)["']/g)].map((m) => m[1]));

const chunks = fs.readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const src = new Map(chunks.map((f) => [f, fs.readFileSync(path.join(ASSETS, f), 'utf8')]));
const importers = new Map(chunks.map((f) => [f, []]));
for (const [f, s] of src) for (const r of refsOf(s)) if (importers.has(r)) importers.get(r).push(f);

// Everything that has to change: the edited chunks and all their importers.
const dirty = new Set();
const visit = (f) => {
  if (!src.has(f)) throw new Error(`no such chunk: ${f}`);
  if (dirty.has(f)) return;
  dirty.add(f);
  for (const i of importers.get(f)) visit(i);
};
for (const f of process.argv.slice(2)) visit(f);
if (!dirty.size) { console.log('usage: node scripts/rehash-assets.mjs <chunk.js> ...'); process.exit(1); }

// Rename dependencies before their importers so each hash covers final content.
const renamed = new Map();
const done = new Set();
const order = [];
const place = (f, stack = new Set()) => {
  if (done.has(f)) return;
  if (stack.has(f)) throw new Error(`import cycle through ${f}`);
  stack.add(f);
  for (const r of refsOf(src.get(f))) if (dirty.has(r)) place(r, stack);
  stack.delete(f);
  done.add(f);
  order.push(f);
};
for (const f of dirty) place(f);

for (const f of order) {
  let s = src.get(f);
  for (const [a, b] of renamed) s = s.split(`./${a}`).join(`./${b}`);
  const next = hashName(f, s);
  for (const ext of ['', '.br', '.gz']) fs.rmSync(path.join(ASSETS, f + ext), { force: true });
  const data = Buffer.from(s);
  fs.writeFileSync(path.join(ASSETS, next), data);
  fs.writeFileSync(path.join(ASSETS, next + '.br'), zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }));
  fs.writeFileSync(path.join(ASSETS, next + '.gz'), zlib.gzipSync(data, { level: 9 }));
  renamed.set(f, next);
  console.log(`${f} -> ${next}`);
}

for (const page of fs.readdirSync(DIST).filter((f) => f.endsWith('.html'))) {
  const file = path.join(DIST, page);
  let s = fs.readFileSync(file, 'utf8');
  const before = s;
  for (const [a, b] of renamed) s = s.split(`/assets/${a}`).join(`/assets/${b}`);
  if (s !== before) { fs.writeFileSync(file, s); console.log(`updated ${page}`); }
}
