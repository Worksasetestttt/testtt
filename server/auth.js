// Authentification : mots de passe scrypt (asynchrones), sessions en base, cookie signé HMAC,
// verrouillage par compte, limitation de débit en mémoire avec nettoyage périodique.
import crypto from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';
import { q, now, db, ensureColumn } from './db.js';

const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || (PROD ? '' : 'dev-secret-change-me');
if (PROD && SECRET.length < 32) {
  console.error('[auth] SESSION_SECRET est obligatoire en production et doit faire au moins 32 caractères (ex. : openssl rand -hex 32). Arrêt.');
  process.exit(1);
}
// En production : préfixe __Host- (cookie lié à l'hôte, Secure, Path=/, sans Domain).
const COOKIE = PROD ? '__Host-oubli_sid' : 'oubli_sid';
const SESSION_DAYS = 30;          // durée de vie absolue d'une session
const IDLE_DAYS = 14;             // expiration après inactivité (glissante)
const REFRESH_MS = 60 * 60000;    // la date d'expiration n'est prolongée qu'une fois par heure au plus
const MAX_SESSIONS = 10;          // sessions simultanées par compte (les plus anciennes sont révoquées)

/* ---------- Schéma complémentaire (idempotent) ---------- */
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)');
const sessionCols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
if (!sessionCols.has('ip')) db.exec('ALTER TABLE sessions ADD COLUMN ip TEXT');
if (!sessionCols.has('last_seen_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
// Accès support : session ouverte par un administrateur sur le compte d'un abonné (lecture seule, voir index.js).
ensureColumn('sessions', 'impersonator_id', 'TEXT');
ensureColumn('sessions', 'return_session_id', 'TEXT');
// Suspension d'un compte par l'administration (date de fin facultative).
ensureColumn('users', 'suspended_at', 'TEXT');
ensureColumn('users', 'suspended_until', 'TEXT');
ensureColumn('users', 'suspended_reason', 'TEXT');
ensureColumn('users', 'email_verified_at', 'TEXT');   // boîte prouvée : lien de confirmation ou réinitialisation par e-mail
// Adresses (nom@domaine) et domaines (@domaine) refusés à l'inscription.
db.exec('CREATE TABLE IF NOT EXISTS blocked_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL UNIQUE, reason TEXT, created_by TEXT, created_at TEXT NOT NULL)');

/* ---------- Mots de passe ---------- */
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export async function hashPassword(password) {
  const pw = String(password ?? '');
  if (!pw.length || pw.length > PASSWORD_MAX) throw new RangeError(`Mot de passe de longueur invalide (1 à ${PASSWORD_MAX} caractères).`);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(pw, salt, KEYLEN, SCRYPT);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const pw = String(password ?? '');
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash || !pw.length || pw.length > PASSWORD_MAX) return false;
  const ref = Buffer.from(hash, 'hex');
  const test = await scrypt(pw, salt, KEYLEN, SCRYPT);
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}
// Haché « leurre » : une connexion sur un e-mail inconnu coûte le même temps qu'une vérification réelle
// (pas d'oracle temporel sur l'existence d'un compte).
let decoy = null;
hashPassword(crypto.randomBytes(16).toString('hex')).then((h) => { decoy = h; }).catch(() => {});
export async function verifyDecoy(password) { if (decoy) await verifyPassword(password, decoy); return false; }

const COMMON = new Set(`password passwords motdepasse mot2passe motdepass passw0rd password1 password12 password123 motdepasse1 motdepasse12 motdepasse123
123456 1234567 12345678 123456789 1234567890 12345678910 0123456789 0987654321 1234567891 azerty azertyuiop azerty123 azertyui qwerty qwertyuiop qwerty123
iloveyou jetaime jetaime123 admin administrator administrateur welcome bienvenue letmein abc123 abcdefghij abcdefghijk abcdef abcd1234 secret soleil bonjour
chocolat doudou marseille football dragon monkey shadow master sunshine princess superman batman trustno1 oubli changeme default`.split(/\s+/));
// Retourne un message d'erreur si le mot de passe est refusé, sinon null.
export function passwordProblem(password, email = '') {
  if (typeof password !== 'string') return 'Mot de passe invalide.';
  if (password.length < PASSWORD_MIN) return `Le mot de passe doit faire au moins ${PASSWORD_MIN} caractères.`;
  if (password.length > PASSWORD_MAX) return `Le mot de passe ne peut pas dépasser ${PASSWORD_MAX} caractères.`;
  const lower = password.toLowerCase();
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, '');
  const repeated = (lower + lower).indexOf(lower, 1) !== lower.length; // motif court répété (abcabcabcabc)
  if (new Set(lower).size < 4 || repeated || /^\d+$/.test(lower) || COMMON.has(lower) || COMMON.has(core)) return 'Ce mot de passe est trop simple ou trop courant\u00a0: choisissez-en un plus original.';
  const address = String(email || '').toLowerCase().trim();
  const local = address.split('@')[0];
  const parts = [local, ...local.split(/[._+-]+/)].filter((p) => p.length >= 3);
  if (address && parts.some((p) => lower.includes(p))) return 'Le mot de passe ne doit pas contenir votre adresse e-mail.';
  return null;
}

/* ---------- Cookie et sessions ---------- */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
// Jeton d'un lien d'e-mail utilisable sans session (désinscription du rapport mensuel…) : HMAC de « but:valeur » avec
// SESSION_SECRET. Il ne sert qu'à ce but et ne vaut plus si le secret change.
export const linkToken = (purpose, value) => sign(`${purpose}:${value}`);
export function checkLinkToken(purpose, value, token) {
  const ref = Buffer.from(linkToken(purpose, String(value))), test = Buffer.from(String(token ?? ''));
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;
function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { continue; }
    if (!(k in out)) out[k] = v;
  }
  return out;
}
const cookieValue = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`;
const expiryFor = (createdMs, nowMs) => new Date(Math.min(createdMs + SESSION_DAYS * 86400000, nowMs + IDLE_DAYS * 86400000)).toISOString();

export function createSession(res, user, req) {
  const id = crypto.randomBytes(24).toString('base64url');
  const created = now();
  q.run('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, user.id, created, expiryFor(Date.now(), Date.now()), String(req.headers['user-agent'] || '').slice(0, 200), String(req.ip || '').slice(0, 64), created);
  q.run('DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)', user.id, user.id, MAX_SESSIONS);
  res.setHeader('Set-Cookie', cookieValue(`${id}.${sign(id)}`, SESSION_DAYS * 86400));
  return id;
}
/* ---------- Accès support (un administrateur consulte le compte d'un abonné) ---------- */
export const SUPPORT_MINUTES = 30;
// Ouvre une session de 30 minutes sur le compte cible ; la session de l'administrateur est conservée pour le retour.
export function startImpersonation(res, target, req) {
  const id = crypto.randomBytes(24).toString('base64url'), created = now();
  const expires = new Date(Date.now() + SUPPORT_MINUTES * 60000).toISOString();
  q.run('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip, last_seen_at, impersonator_id, return_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, target.id, created, expires, String(req.headers['user-agent'] || '').slice(0, 200), String(req.ip || '').slice(0, 64), created, req.user.id, req.sessionId);
  res.setHeader('Set-Cookie', cookieValue(`${id}.${sign(id)}`, SUPPORT_MINUTES * 60));
  return { expires_at: expires };
}
// Ferme l'accès support et rend sa session à l'administrateur si elle est encore valide.
export function endImpersonation(req, res) {
  const s = q.get('SELECT impersonator_id, return_session_id FROM sessions WHERE id = ?', req.sessionId);
  q.run('DELETE FROM sessions WHERE id = ?', req.sessionId);
  req.sessionId = null;
  const back = s?.return_session_id ? q.get('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND impersonator_id IS NULL AND expires_at > ?', s.return_session_id, s.impersonator_id, now()) : null;
  res.setHeader('Set-Cookie', back ? cookieValue(`${back.id}.${sign(back.id)}`, SESSION_DAYS * 86400) : cookieValue('', 0));
  return { admin: !!back };
}

/* ---------- Suspension et liste de blocage ---------- */
export const isSuspended = (u) => !!(u && u.suspended_at && (!u.suspended_until || u.suspended_until > now()));
export function isBlockedEmail(email) {
  const e = String(email ?? '').toLowerCase().trim(), at = e.lastIndexOf('@');
  return at > 0 && !!q.get('SELECT 1 FROM blocked_emails WHERE pattern = ? OR pattern = ?', e, e.slice(at));
}

export function destroySession(req, res) {
  if (req.sessionId) q.run('DELETE FROM sessions WHERE id = ?', req.sessionId);
  req.sessionId = null;
  res.setHeader('Set-Cookie', cookieValue('', 0));
}
// Révoque toutes les sessions d'un compte sauf (optionnellement) celle en cours. Retourne le nombre révoqué.
export function destroyOtherSessions(userId, keepId = null) {
  return Number(q.run('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, keepId).changes || 0);
}
export function purgeExpiredSessions() {
  const limit = new Date(Date.now() - SESSION_DAYS * 86400000).toISOString();
  return Number(q.run('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?', now(), limit).changes || 0);
}
purgeExpiredSessions();
setInterval(() => { try { purgeExpiredSessions(); } catch (e) { console.error('[auth] purge des sessions :', e.message); } }, 60 * 60000).unref();

// Un cookie absent, malformé ou falsifié donne simplement un visiteur anonyme (jamais d'erreur 500).
export function attachUser(req, _res, next) {
  req.user = null; req.sessionId = null; req.impersonator = null;
  try {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return next();
    const dot = raw.indexOf('.');
    if (dot < 0) return next();
    const id = raw.slice(0, dot), sig = raw.slice(dot + 1);
    if (!ID_RE.test(id) || !SIG_RE.test(sig)) return next();
    const given = Buffer.from(sig), expected = Buffer.from(sign(id));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return next();
    const nowIso = now(), nowMs = Date.now();
    const s = q.get('SELECT * FROM sessions WHERE id = ? AND expires_at > ?', id, nowIso);
    if (!s) return next();
    const createdMs = Date.parse(s.created_at);
    if (!(createdMs + SESSION_DAYS * 86400000 > nowMs)) { q.run('DELETE FROM sessions WHERE id = ?', id); return next(); }
    const u = q.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', s.user_id);
    if (!u) { q.run('DELETE FROM sessions WHERE id = ?', id); return next(); }
    let imp = null;
    if (s.impersonator_id) {
      // L'accès support cesse dès que l'administrateur perd son rôle ; il n'est jamais prolongé.
      imp = q.get(`SELECT id, email FROM users WHERE id = ? AND role = 'admin' AND deleted_at IS NULL`, s.impersonator_id);
      if (!imp) { q.run('DELETE FROM sessions WHERE id = ?', id); return next(); }
    } else if (isSuspended(u)) { q.run('DELETE FROM sessions WHERE id = ?', id); return next(); }
    req.user = u; req.sessionId = id; req.impersonator = imp; req.sessionExpiresAt = s.expires_at;
    const seen = Date.parse(s.last_seen_at || s.created_at);
    if (!imp && !(seen + REFRESH_MS > nowMs)) q.run('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?', expiryFor(createdMs, nowMs), nowIso, id);
  } catch (e) {
    console.error('[auth] cookie ignoré :', e.message);
    req.user = null; req.sessionId = null;
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

/* ---------- Administrateurs ---------- */
export const isAdminEmail = (email) => (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(String(email ?? '').toLowerCase());
// Promotion automatique si l'adresse figure dans ADMIN_EMAILS ; jamais de rétrogradation automatique.
// En production (ou ADMIN_EMAIL_VERIFICATION=on), seulement une fois la boîte prouvée : lien de confirmation (account.js)
// ou réinitialisation du mot de passe par e-mail. Sinon, quiconque inscrit le premier une adresse listée mais pas encore
// utilisée (ou libérée par la suppression d'un compte) deviendrait administrateur.
export const ADMIN_VERIFY = process.env.ADMIN_EMAIL_VERIFICATION ? process.env.ADMIN_EMAIL_VERIFICATION === 'on' : PROD;
export const adminPending = (user) => !!(user && user.role !== 'admin' && ADMIN_VERIFY && !user.email_verified_at && isAdminEmail(user.email));
export function promoteIfAdmin(user) {
  if (user && user.role !== 'admin' && isAdminEmail(user.email) && (!ADMIN_VERIFY || user.email_verified_at)) {
    q.run(`UPDATE users SET role = 'admin' WHERE id = ?`, user.id);
    user.role = 'admin';
  }
  return user;
}

/* ---------- Verrouillage par compte et limitation de débit (mémoire) ---------- */
const fmtWait = (s) => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : s > 1 ? `${s} secondes` : '1 seconde');
// Supprime les entrées les plus anciennes (les Map conservent l'ordre d'insertion) : jamais de vidage global.
function evictOldest(map, count) { let i = 0; for (const k of map.keys()) { if (i++ >= count) break; map.delete(k); } }

const LOCK_MAX = 10, LOCK_WINDOW_MS = 15 * 60000;
const failures = new Map(); // empreinte de l'e-mail → { n, first, until }
const lockKey = (email) => crypto.createHash('sha256').update(String(email ?? '').toLowerCase().trim()).digest('base64url');
// Secondes restantes de verrouillage pour ce compte (0 si libre).
export function loginLockRemaining(email) {
  const f = failures.get(lockKey(email));
  if (!f || !f.until) return 0;
  return f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
export function noteLoginFailure(email) {
  const k = lockKey(email), t = Date.now();
  let f = failures.get(k);
  if (!f || t - f.first > LOCK_WINDOW_MS) f = { n: 0, first: t, until: 0 };
  f.n += 1;
  if (f.n >= LOCK_MAX) f.until = t + LOCK_WINDOW_MS;
  failures.delete(k); failures.set(k, f);
  if (failures.size > 20000) evictOldest(failures, 2000);
  return f;
}
export function clearLoginFailures(email) { failures.delete(lockKey(email)); }

const buckets = new Map(); // « METHOD route|ip » → { n, reset }
// Clé de route : le motif Express (req.route.path), sinon le chemin. Express ignore la casse et la barre finale du chemin ;
// la clé aussi, sinon chaque écriture (/api/Contact, /API/contact/…) aurait son propre compteur et le plafond tomberait.
const routeKey = (req) => `${req.method} ${`${req.baseUrl}${req.route ? req.route.path : req.path}`.toLowerCase().replace(/\/+$/, '')}`;
// Client compté : l'adresse IPv4 (éventuellement mappée ::ffff:a.b.c.d), ou le préfixe /64 d'une adresse IPv6 : un hôte IPv6
// dispose d'ordinaire d'un /64 entier et changerait sinon d'adresse à chaque requête.
function clientKey(ip) {
  const s = String(ip || '').toLowerCase();
  if (net.isIP(s) !== 6) return s;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [], t = rest ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length - (rest.includes('.') ? 1 : 0))).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
// by(req) : clé de comptage à la place du client (ex. empreinte de l'adresse visée, quelle que soit l'IP de l'appelant).
export function rateLimit({ windowMs = 15 * 60000, max = 30, name, by } = {}) {
  return (req, res, next) => {
    const key = `${name || routeKey(req)}|${by ? by(req) : clientKey(req.ip)}`;
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || t >= b.reset) b = { n: 0, reset: t + windowMs };
    b.n += 1;
    buckets.delete(key); buckets.set(key, b);
    if (buckets.size > 50000) evictOldest(buckets, 5000);
    if (b.n > max) {
      const wait = Math.max(1, Math.ceil((b.reset - t) / 1000));
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${fmtWait(wait)}.` });
    }
    next();
  };
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (t >= b.reset) buckets.delete(k);
  for (const [k, f] of failures) if (t - f.first > LOCK_WINDOW_MS && f.until <= t) failures.delete(k);
}, 60000).unref();

export { fmtWait };
