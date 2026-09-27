// Serves the built frontend from an in-memory index of files (no path
// traversal possible), with precompressed brotli/gzip variants.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { withCredit, CREDIT_SCRIPT, CREDIT_SCRIPT_PATH } from './credit.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const isHtml = (name) => path.extname(name).toLowerCase() === '.html';

export class StaticFiles {
  constructor(dir) {
    this.dir = dir;
    this.files = new Map();
    this.scan(dir, '');
    this.add(CREDIT_SCRIPT_PATH, Buffer.from(CREDIT_SCRIPT), '.js');
  }

  // Registers generated content, compressing it here instead of on disk.
  add(url, data, extension) {
    this.files.set(url, {
      data,
      br: zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
      gz: zlib.gzipSync(data, { level: 9 }),
      type: TYPES[extension] || 'application/octet-stream',
      etag: '"' + crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20) + '"',
      immutable: false,
    });
  }

  scan(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const url = prefix + '/' + ent.name;
      if (ent.isDirectory()) this.scan(full, url);
      else if (isHtml(ent.name)) {
        // Pages carry the author credit; their compressed variants are rebuilt from the result.
        this.add(url, Buffer.from(withCredit(fs.readFileSync(full, 'utf8'))), '.html');
      } else if (!/\.(br|gz)$/.test(ent.name)) {
        const ext = path.extname(ent.name);
        const data = fs.readFileSync(full);
        const br = fs.existsSync(full + '.br') ? fs.readFileSync(full + '.br') : null;
        const gz = fs.existsSync(full + '.gz') ? fs.readFileSync(full + '.gz') : null;
        this.files.set(url, {
          data,
          br,
          gz,
          type: TYPES[ext] || 'application/octet-stream',
          etag: '"' + crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20) + '"',
          immutable: url.startsWith('/assets/'),
        });
      }
    }
  }

  has(url) {
    return this.files.has(url);
  }

  serve(req, res, url, extraHeaders = {}) {
    const f = this.files.get(url);
    if (!f) return false;
    const headers = {
      'Content-Type': f.type,
      ETag: f.etag,
      'Cache-Control': f.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
      ...extraHeaders,
    };
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const ae = String(req.headers['accept-encoding'] || '');
    let body = f.data;
    if (f.br && /\bbr\b/.test(ae)) {
      body = f.br;
      headers['Content-Encoding'] = 'br';
    } else if (f.gz && /\bgzip\b/.test(ae)) {
      body = f.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}
