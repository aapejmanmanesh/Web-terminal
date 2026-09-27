// Accounts, login sessions and request authentication.
import { hashPassword, verifyPassword, dummyVerify, newToken, sha256, Throttle } from './security.js';
import { HttpError, parseCookies, str, bool } from './http.js';

const DAY = 86400_000;
const SHORT_SESSION = 12 * 3600_000;

export class Auth {
  constructor(app) {
    this.app = app;
    this.cookie = app.secureCookies ? '__Host-wt' : 'wt';
    this.ipThrottle = new Throttle({ max: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });
    this.userThrottle = new Throttle({ max: 6, windowMs: 15 * 60_000, blockMs: 10 * 60_000 });
    setInterval(() => this.app.store.run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now()), 3600_000).unref();
  }

  publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      linuxUser: u.linux_user,
      allowLocal: !!u.allow_local && !!u.linux_user,
      allowIde: !!u.allow_ide && !!u.linux_user,
      settings: safeJson(u.settings),
      ui: safeJson(u.ui),
    };
  }

  cookieHeader(token, persistent) {
    const parts = [`${this.cookie}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (this.app.secureCookies) parts.push('Secure');
    if (persistent) parts.push(`Max-Age=${this.app.cfg.sessionDays * 86400}`);
    return parts.join('; ');
  }

  clearCookieHeader() {
    const parts = [`${this.cookie}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (this.app.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  async login(req, body) {
    const ip = this.app.clientIp(req);
    const username = str(body.username, { name: 'Username', min: 1, max: 64 });
    const password = typeof body.password === 'string' ? body.password : '';
    const remember = body.remember === undefined ? true : bool(body.remember);
    const ukey = username.toLowerCase();
    const wait = Math.max(this.ipThrottle.blockedFor(ip), this.userThrottle.blockedFor(ukey));
    if (wait) {
      throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60000)} min.`);
    }
    const user = this.app.store.get('SELECT * FROM users WHERE username = ?', username);
    let ok = false;
    if (user && password.length <= 256) ok = await verifyPassword(password, user.pw);
    else await dummyVerify(password);
    if (!ok || user.disabled) {
      this.ipThrottle.fail(ip);
      if (user) this.userThrottle.fail(ukey);
      this.app.audit({ req, userId: user ? user.id : null, username }, 'login.fail', user && user.disabled && ok ? 'account disabled' : '');
      throw new HttpError(401, 'Invalid username or password');
    }
    this.ipThrottle.success(ip);
    this.userThrottle.success(ukey);
    const token = newToken();
    const now = Date.now();
    this.app.store.run(
      'INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen, expires_at, persistent, ip, ua) VALUES (?,?,?,?,?,?,?,?)',
      sha256(token),
      user.id,
      now,
      now,
      now + (remember ? this.app.cfg.sessionDays * DAY : SHORT_SESSION),
      remember ? 1 : 0,
      ip,
      String(req.headers['user-agent'] || '').slice(0, 300),
    );
    this.app.store.run('UPDATE users SET last_login = ?, last_ip = ? WHERE id = ?', now, ip, user.id);
    this.app.audit({ req, userId: user.id, username: user.username }, 'login', '');
    return { token, user, remember };
  }

  // Resolves the session for a request. Returns { sess, user } or null.
  resolve(req) {
    const token = parseCookies(req.headers.cookie)[this.cookie];
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const sess = this.app.store.get('SELECT * FROM auth_sessions WHERE token_hash = ?', hash);
    const now = Date.now();
    if (!sess || sess.expires_at < now) return null;
    const user = this.app.store.get('SELECT * FROM users WHERE id = ?', sess.user_id);
    if (!user || user.disabled) return null;
    if (now - sess.last_seen > 60_000) {
      const ttl = sess.persistent ? this.app.cfg.sessionDays * DAY : SHORT_SESSION;
      this.app.store.run('UPDATE auth_sessions SET last_seen = ?, expires_at = ? WHERE id = ?', now, now + ttl, sess.id);
    }
    return { sess, user, token };
  }

  sessionAlive(sessId) {
    const s = this.app.store.get('SELECT s.expires_at, u.disabled FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', sessId);
    return !!s && s.expires_at > Date.now() && !s.disabled;
  }

  logout(sessId) {
    this.app.store.run('DELETE FROM auth_sessions WHERE id = ?', sessId);
    this.app.hub.kickSession(sessId);
  }

  revokeUser(userId, exceptSessId = null) {
    const rows = this.app.store.all('SELECT id FROM auth_sessions WHERE user_id = ?', userId);
    for (const r of rows) {
      if (r.id === exceptSessId) continue;
      this.app.store.run('DELETE FROM auth_sessions WHERE id = ?', r.id);
      this.app.hub.kickSession(r.id);
    }
  }

  async setPassword(userId, password) {
    const pw = await hashPassword(password);
    this.app.store.run('UPDATE users SET pw = ? WHERE id = ?', pw, userId);
  }
}

export function safeJson(s, dflt = {}) {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : dflt;
  } catch {
    return dflt;
  }
}
