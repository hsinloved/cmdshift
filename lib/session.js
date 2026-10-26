// Stateless sessions: the session object is AES-256-GCM encrypted into a
// cookie, so logins survive restarts/redeploys and work across instances.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const COOKIE = 'sid';
const MAX_AGE_S = 30 * 24 * 3600;

export function sessionKey(secret) {
  return createHash('sha256').update(secret).digest();
}

export function seal(key, data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(key, value) {
  try {
    const buf = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    const data = JSON.parse(json);
    return data && typeof data === 'object' && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

/**
 * Loads the session for a request. Any change made to it during the request
 * is written back as a cookie when the response headers are sent.
 */
export function loadSession(key, req, res, { secure }) {
  const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie || '')?.[1];
  const session = (raw && unseal(key, raw)) || { exp: Date.now() + MAX_AGE_S * 1000 };
  const before = JSON.stringify(session);

  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (JSON.stringify(session) !== before) {
      session.exp = Date.now() + MAX_AGE_S * 1000;
      res.setHeader('Set-Cookie', `${COOKIE}=${seal(key, session)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`);
    }
    return writeHead.apply(this, args);
  };
  return session;
}
