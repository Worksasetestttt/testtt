// Authentification : mots de passe scrypt, sessions en base, cookie signé HMAC.
import crypto from 'node:crypto';
import { q, now } from './db.js';

const SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-change-me');
if (!SECRET) throw new Error('SESSION_SECRET est obligatoire en production');
const COOKIE = 'oubli_sid';
const SESSION_DAYS = 30;
const PROD = process.env.NODE_ENV === 'production';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

export function createSession(res, user, req) {
  const id = crypto.randomBytes(24).toString('base64url');
  const created = now();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  q.run('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)', id, user.id, created, expires, String(req.headers['user-agent'] || '').slice(0, 200));
  res.setHeader('Set-Cookie', `${COOKIE}=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${PROD ? '; Secure' : ''}`);
}
export function destroySession(req, res) {
  if (req.sessionId) q.run('DELETE FROM sessions WHERE id = ?', req.sessionId);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? '; Secure' : ''}`);
}

export function attachUser(req, _res, next) {
  req.user = null;
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (raw) {
    const dot = raw.lastIndexOf('.');
    const id = raw.slice(0, dot), sig = raw.slice(dot + 1);
    if (id && sig && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(id)))) {
      const s = q.get('SELECT * FROM sessions WHERE id = ? AND expires_at > ?', id, now());
      if (s) {
        const u = q.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', s.user_id);
        if (u) { req.user = u; req.sessionId = id; }
      }
    }
  }
  next();
}
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connectez-vous pour continuer.' });
  next();
}
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Accès réservé aux administrateurs.' });
  next();
}

// Limitation de débit en mémoire (par IP) pour les points d'entrée sensibles.
const buckets = new Map();
export function rateLimit({ windowMs = 15 * 60000, max = 30 } = {}) {
  return (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const t = Date.now();
    const b = buckets.get(key) || { start: t, n: 0 };
    if (t - b.start > windowMs) { b.start = t; b.n = 0; }
    b.n += 1; buckets.set(key, b);
    if (buckets.size > 50000) buckets.clear();
    if (b.n > max) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    next();
  };
}

export const isAdminEmail = (email) => (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(String(email).toLowerCase());
