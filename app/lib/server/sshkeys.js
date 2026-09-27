// SSH key generation/import using ssh-keygen in a private temp directory.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bad } from './http.js';

function run(bin, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: { PATH: '/usr/bin:/bin', ...env }, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

async function withTmp(app, fn) {
  const dir = fs.mkdtempSync(path.join(app.tmpDir, 'k-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function describe(app, pubFile) {
  const out = await run(app.cfg.sshKeygen, ['-l', '-f', pubFile]);
  const m = /(SHA256:[A-Za-z0-9+/=]+)/.exec(out);
  return m ? m[1] : out.trim().split(' ')[1] || '';
}

export async function generateKey(app, comment) {
  return withTmp(app, async (dir) => {
    const f = path.join(dir, 'id');
    await run(app.cfg.sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', f]);
    const privateKey = fs.readFileSync(f, 'utf8');
    const publicKey = fs.readFileSync(f + '.pub', 'utf8').trim();
    return { privateKey, publicKey, fingerprint: await describe(app, f + '.pub') };
  });
}

export async function importKey(app, pem, passphrase, comment) {
  if (typeof pem !== 'string' || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem) || pem.length > 20000) {
    throw bad('Paste a private key (OpenSSH or PEM format)');
  }
  return withTmp(app, async (dir) => {
    const f = path.join(dir, 'id');
    const text = pem.replace(/\r\n/g, '\n').trim() + '\n';
    fs.writeFileSync(f, text, { mode: 0o600 });
    if (passphrase) {
      // Remove the passphrase; the old one is supplied through askpass so it
      // never appears on a command line.
      const pp = path.join(dir, 'pp');
      fs.writeFileSync(pp, passphrase, { mode: 0o600 });
      try {
        await run(app.cfg.sshKeygen, ['-q', '-p', '-N', '', '-f', f], { SSH_ASKPASS: app.cfg.askpass, SSH_ASKPASS_REQUIRE: 'force', WT_ASKPASS_FILE: pp, DISPLAY: ':0' });
      } catch {
        throw bad('Could not unlock the key — check the passphrase');
      }
    }
    let publicKey;
    try {
      publicKey = (await run(app.cfg.sshKeygen, ['-y', '-f', f], { SSH_ASKPASS_REQUIRE: 'never' })).trim();
    } catch {
      throw bad(passphrase ? 'Invalid private key' : 'Invalid private key (if it has a passphrase, enter it)');
    }
    fs.writeFileSync(f + '.pub', publicKey + ' ' + comment + '\n');
    return {
      privateKey: fs.readFileSync(f, 'utf8'),
      publicKey: publicKey.split(' ').slice(0, 2).join(' ') + ' ' + comment,
      fingerprint: await describe(app, f + '.pub'),
    };
  });
}

export const randomSuffix = () => crypto.randomBytes(3).toString('hex');
