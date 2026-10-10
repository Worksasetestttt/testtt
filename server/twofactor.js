// Double authentification (TOTP, RFC 6238) : disponible pour tout compte, obligatoire pour l'administration en
// production (ADMIN_REQUIRE_2FA). Règles :
// - la clé (160 bits) est chiffrée en base (AES-256-GCM, IV aléatoire, clé dérivée de SESSION_SECRET par HKDF, chiffré
//   lié au compte) : une copie de la base seule ne suffit pas. Elle n'est montrée qu'à la mise en place, jamais après ;
// - mise en place en deux temps : mot de passe → clé et lien otpauth://, puis premier code ; elle crée 10 codes de
//   secours à usage unique, montrés une seule fois, dont seule l'empreinte SHA-256 est gardée (60 bits chacun) ;
// - anti-rejeu : un code n'est accepté que s'il est plus récent que le dernier accepté (last_step) ;
// - connexion : un mot de passe correct ne donne qu'un jeton de 5 minutes (empreinte en base, 5 essais, usage unique)
//   pour l'étape « code » (routes.js) ; les codes faux comptent dans le verrouillage de connexion (auth.js) et dans un
//   plafond propre à la seconde étape, par compte ;
// - désactivation et renouvellement des codes de secours : mot de passe et code obligatoires.
import express from 'express';
import crypto from 'node:crypto';
import { db, q, now, tx, logEvent } from './db.js';
import { verifyPassword, requireAuth, rateLimit, deriveKey, destroyOtherSessions, failureLock, fmtWait } from './auth.js';
import { base32Encode, matchTotp, normalizeTotp, STEP_SECONDS, DIGITS } from './totp.js';
import { wrap } from './util.js';

const PROD = process.env.NODE_ENV === 'production';
const NBSP = ' ';
// Administration réservée aux comptes protégés : active par défaut en production, inactive sinon (comme ADMIN_VERIFY).
export const ADMIN_REQUIRE_2FA = process.env.ADMIN_REQUIRE_2FA ? process.env.ADMIN_REQUIRE_2FA === 'on' : PROD;
const ISSUER = 'Oubli';
const RECOVERY_COUNT = 10;
const CHALLENGE_TTL_MS = 5 * 60000, CHALLENGE_TRIES = 5, CHALLENGES_PER_USER = 5;
const PENDING_TTL_MS = 24 * 3600000;   // mise en place commencée mais jamais confirmée : clé oubliée au bout d'un jour

/* ---------- Schéma (idempotent) ---------- */
// user_totp.enabled_at NULL : mise en place commencée, pas encore confirmée par un premier code.
// Suppression d'un compte (adresse anonymisée, deleted_at) : clé, codes et jetons effacés par le déclencheur.
db.exec(`
CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  enabled_at TEXT,
  last_step INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_totp_recovery_user ON totp_recovery_codes(user_id, code_hash);
CREATE TABLE IF NOT EXISTS login_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_challenges_user ON login_challenges(user_id);
CREATE TRIGGER IF NOT EXISTS trg_users_deleted_twofactor AFTER UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM user_totp WHERE user_id = NEW.id;
  DELETE FROM totp_recovery_codes WHERE user_id = NEW.id;
  DELETE FROM login_challenges WHERE user_id = NEW.id;
END;
`);
const purge = () => {
  q.run('DELETE FROM login_challenges WHERE expires_at <= ?', now());
  q.run('DELETE FROM user_totp WHERE enabled_at IS NULL AND created_at <= ?', new Date(Date.now() - PENDING_TTL_MS).toISOString());
};
purge();
setInterval(() => { try { purge(); } catch (e) { console.error('[2fa] ménage :', e.message); } }, 10 * 60000).unref();

/* ---------- Clé chiffrée ---------- */
// Format v1.<iv>.<étiquette>.<chiffré> (base64url) ; données associées « totp:<id du compte> » : un chiffré recopié sur
// un autre compte ne se déchiffre pas.
const KEY = deriveKey('totp-secret:v1');
function seal(userId, raw) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(`totp:${userId}`));
  const ct = Buffer.concat([c.update(raw), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
function unseal(userId, sealed) {
  try {
    const [v, iv, tag, ct] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAAD(Buffer.from(`totp:${userId}`));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  } catch {
    // SESSION_SECRET changé depuis la mise en place (ou base altérée) : seuls les codes de secours fonctionnent encore.
    console.error(`[2fa] clé de double authentification illisible pour le compte ${userId} (SESSION_SECRET changé ?)`);
    return null;
  }
}
export const otpauthUri = (email, secret) => `otpauth://totp/${ISSUER}:${encodeURIComponent(email)}?secret=${secret}&issuer=${ISSUER}`;

/* ---------- Codes de secours ---------- */
// 12 caractères en base32 de Crockford (sans I, L, O ni U), tirés un à un : 60 bits, affichés XXXX-XXXX-XXXX.
// Saisie tolérante comme pour les clés d'activation : casse, espaces et tirets ignorés, O lu 0, I et L lus 1.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
function newRecoveryCode() {
  let s = '';
  for (let i = 0; i < 12; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
function normalizeRecovery(input) {
  if (typeof input !== 'string' || input.length > 40) return null;
  const s = input.toUpperCase().replace(/[\s\-_.‐-―−  ]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return RECOVERY_RE.test(s) ? s : null;
}
const recoveryHash = (userId, normalized) => crypto.createHash('sha256').update(`${userId}:${normalized}`).digest('hex');
function newRecoveryCodes() {
  const set = new Set();
  while (set.size < RECOVERY_COUNT) set.add(newRecoveryCode());
  return [...set];
}
// À appeler dans une transaction : les nouveaux codes remplacent tous les précédents.
function storeRecoveryCodes(userId, codes, at) {
  q.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', userId);
  for (const c of codes) q.run('INSERT INTO totp_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)', userId, recoveryHash(userId, normalizeRecovery(c)), at);
}
const recoveryRemaining = (userId) => q.get('SELECT COUNT(*) AS c FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).c;

/* ---------- État ---------- */
export const twoFactorEnabled = (userId) => !!q.get('SELECT 1 FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL', userId);
export function twoFactorStatus(user) {
  const row = q.get('SELECT enabled_at FROM user_totp WHERE user_id = ?', user.id);
  const enabled = !!row?.enabled_at;
  return {
    enabled, pending: !!row && !enabled, enabled_at: row?.enabled_at || null,
    recovery_remaining: enabled ? recoveryRemaining(user.id) : 0, recovery_total: RECOVERY_COUNT,
    admin_required: ADMIN_REQUIRE_2FA && user.role === 'admin',
  };
}

/* ---------- Vérification d'un second facteur ---------- */
// Code de l'application (6 chiffres) ou code de secours. Consommation atomique : un code ne passe qu'une fois, même
// envoyé deux fois en même temps. Retourne { ok, method, remaining }.
export function checkSecondFactor(userId, input) {
  const row = q.get('SELECT secret_enc, last_step FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL', userId);
  if (!row) return { ok: false };
  if (normalizeTotp(input)) {
    const key = unseal(userId, row.secret_enc);
    const s = key ? matchTotp(key, input, row.last_step) : null;
    if (s === null || !Number(q.run('UPDATE user_totp SET last_step = ? WHERE user_id = ? AND last_step < ?', s, userId, s).changes)) return { ok: false };
    return { ok: true, method: 'totp' };
  }
  const code = normalizeRecovery(input);
  if (!code || !Number(q.run('UPDATE totp_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', now(), userId, recoveryHash(userId, code)).changes)) return { ok: false };
  return { ok: true, method: 'recovery', remaining: recoveryRemaining(userId) };
}
// Plafond propre à la seconde étape : 20 codes faux en 15 minutes pour un compte, tous clients confondus (connexion,
// désactivation, renouvellement), bloquent les essais de code de ce compte pendant 15 minutes. Seul qui connaît le mot
// de passe atteint cette étape : ce blocage ne peut pas être déclenché par un tiers quelconque.
export const SECOND_FACTOR_MAX = 20;
const secondFactorFailures = failureLock({ max: SECOND_FACTOR_MAX, size: 10000 });
export const secondFactorLockRemaining = (userId) => secondFactorFailures.remaining(userId);
export const noteSecondFactorFailure = (userId) => { secondFactorFailures.note(userId); };
export const clearSecondFactorFailures = (userId) => { secondFactorFailures.clear(userId); };

/* ---------- Jetons de l'étape « code » (connexion) ---------- */
// Jeton de 256 bits remis après un mot de passe correct, à renvoyer avec le code : seule son empreinte est stockée ;
// 5 minutes, 5 essais, usage unique ; 5 jetons ouverts au plus par compte. Aucune session n'existe avant le code.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export function createLoginChallenge(userId) {
  const token = crypto.randomBytes(32).toString('base64url'), t = Date.now();
  const at = new Date(t).toISOString(), expires_at = new Date(t + CHALLENGE_TTL_MS).toISOString();
  tx(() => {
    q.run('DELETE FROM login_challenges WHERE expires_at <= ?', at);
    q.run('INSERT INTO login_challenges (token_hash, user_id, attempts, created_at, expires_at) VALUES (?, ?, 0, ?, ?)', sha256(token), userId, at, expires_at);
    q.run('DELETE FROM login_challenges WHERE user_id = ? AND id NOT IN (SELECT id FROM login_challenges WHERE user_id = ? ORDER BY id DESC LIMIT ?)', userId, userId, CHALLENGES_PER_USER);
  });
  return { challenge: token, expires_at };
}
export function findLoginChallenge(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = q.get('SELECT * FROM login_challenges WHERE token_hash = ?', sha256(token));
  if (row && !(row.expires_at > now())) { q.run('DELETE FROM login_challenges WHERE id = ?', row.id); return null; }
  return row || null;
}
// Code faux : un essai de moins ; au dernier, le jeton est détruit. Retourne le nombre d'essais restants.
export function failLoginChallenge(row) {
  const r = q.get('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? RETURNING attempts', row.id);
  if (!r || r.attempts >= CHALLENGE_TRIES) { q.run('DELETE FROM login_challenges WHERE id = ?', row.id); return 0; }
  return CHALLENGE_TRIES - r.attempts;
}
// Code juste : le jeton est consommé (false s'il l'a déjà été).
export const useLoginChallenge = (row) => !!Number(q.run('DELETE FROM login_challenges WHERE id = ?', row.id).changes);
// Mot de passe changé, double authentification activée ou désactivée : les jetons en cours ne valent plus.
export const dropLoginChallenges = (userId) => { q.run('DELETE FROM login_challenges WHERE user_id = ?', userId); };

/* ---------- Administration ---------- */
// Après requireAuth et requireAdmin (routes.js) : un administrateur sans double authentification active reçoit un
// refus dédié (code two_factor_required), que le panel transforme en invitation à l'activer. Un accès support ouvre la
// session de l'abonné (jamais celle d'un administrateur) : requireAdmin l'a déjà refusé.
export function requireAdminTwoFactor(req, res, next) {
  if (!ADMIN_REQUIRE_2FA || twoFactorEnabled(req.user.id)) return next();
  res.status(403).json({ error: `L’administration exige la double authentification${NBSP}: activez-la dans vos paramètres.`, code: 'two_factor_required' });
}

/* ---------- Routes de l'abonné (montées par routes.js) ---------- */
// Écritures refusées pendant un accès support par la garde de lecture seule (index.js).
export const twofactor = express.Router();
const bad = (res, msg, status = 400, extra = {}) => res.status(status).json({ error: msg, ...extra });
const tooMany = (res, seconds) => { res.setHeader('Retry-After', String(seconds)); return bad(res, `Trop de tentatives. Réessayez dans ${fmtWait(seconds)}.`, 429); };
const ALREADY = 'La double authentification est déjà active.';
const NOT_ENABLED = 'La double authentification n’est pas active.';
const CODE_INVALID = `Code incorrect ou déjà utilisé${NBSP}: saisissez le code affiché en ce moment par l’application, ou un code de secours.`;

twofactor.get('/auth/2fa', requireAuth, (req, res) => res.json(twoFactorStatus(req.user)));

// Étape 1 : mot de passe (une session volée ne suffit pas à imposer sa propre clé au titulaire), puis clé de
// configuration et lien otpauth://. Une nouvelle demande remplace une clé pas encore confirmée.
twofactor.post('/auth/2fa/setup', requireAuth, rateLimit({ max: 10 }), wrap(async (req, res) => {
  const u = req.user;
  if (twoFactorEnabled(u.id)) return bad(res, ALREADY, 409);
  if (typeof req.body.password !== 'string' || !(await verifyPassword(req.body.password, u.password_hash))) return bad(res, 'Mot de passe incorrect.');
  const raw = crypto.randomBytes(20);
  q.run(`INSERT INTO user_totp (user_id, secret_enc, enabled_at, last_step, created_at) VALUES (?, ?, NULL, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, last_step = 0, created_at = excluded.created_at WHERE user_totp.enabled_at IS NULL`, u.id, seal(u.id, raw), now());
  if (twoFactorEnabled(u.id)) return bad(res, ALREADY, 409);   // activée entre-temps depuis un autre onglet
  const secret = base32Encode(raw);
  res.json({ secret, otpauth: otpauthUri(u.email, secret), digits: DIGITS, period: STEP_SECONDS });
}));

// Étape 2 : premier code. Active la protection, crée les codes de secours (réponse unique) et ferme les autres sessions,
// ouvertes sans code.
twofactor.post('/auth/2fa/enable', requireAuth, rateLimit({ max: 10 }), (req, res) => {
  const u = req.user;
  const row = q.get('SELECT * FROM user_totp WHERE user_id = ?', u.id);
  if (row?.enabled_at) return bad(res, ALREADY, 409);
  if (!row) return bad(res, 'Commencez par afficher la clé de configuration.', 400, { code: 'no_setup' });
  const key = unseal(u.id, row.secret_enc);
  const s = key ? matchTotp(key, req.body.code, row.last_step) : null;
  if (s === null) return bad(res, `Code incorrect${NBSP}: vérifiez que l’heure de votre téléphone est à jour, puis saisissez le code affiché.`, 400, { code: 'invalid_code' });
  const at = now(), codes = newRecoveryCodes();
  const done = tx(() => {
    if (!Number(q.run('UPDATE user_totp SET enabled_at = ?, last_step = ? WHERE user_id = ? AND enabled_at IS NULL AND secret_enc = ?', at, s, u.id, row.secret_enc).changes)) return false;
    storeRecoveryCodes(u.id, codes, at);
    return true;
  });
  if (!done) return bad(res, `La clé a changé entre-temps${NBSP}: recommencez la mise en place.`, 409);
  const signedOut = destroyOtherSessions(u.id, req.sessionId);
  dropLoginChallenges(u.id);
  const others = signedOut > 1 ? `${signedOut}${NBSP}autres appareils déconnectés` : signedOut ? 'un autre appareil déconnecté' : '';
  logEvent(u.id, 'account', `Double authentification activée${NBSP}: un code est demandé à chaque connexion${others ? `${NBSP}; ${others}` : ''}.`);
  res.json({ ok: true, enabled_at: at, recovery_codes: codes, signed_out: signedOut });
});

// Mot de passe et code (de l'application ou de secours) : désactivation et renouvellement des codes de secours.
async function confirmIdentity(req, res) {
  const { password, code } = req.body;
  if (typeof password !== 'string' || !password || typeof code !== 'string' || !code.trim()) { bad(res, 'Saisissez votre mot de passe et un code de vérification.'); return null; }
  const locked = secondFactorLockRemaining(req.user.id);
  if (locked) { tooMany(res, locked); return null; }
  if (!(await verifyPassword(password, req.user.password_hash))) { bad(res, 'Mot de passe incorrect.'); return null; }
  const r = checkSecondFactor(req.user.id, code);
  if (!r.ok) { noteSecondFactorFailure(req.user.id); bad(res, CODE_INVALID, 400, { code: 'invalid_code' }); return null; }
  return r;
}
twofactor.post('/auth/2fa/disable', requireAuth, rateLimit({ max: 10 }), wrap(async (req, res) => {
  const u = req.user;
  if (!twoFactorEnabled(u.id)) return bad(res, NOT_ENABLED, 409);
  if (!(await confirmIdentity(req, res))) return;
  tx(() => {
    q.run('DELETE FROM user_totp WHERE user_id = ?', u.id);
    q.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', u.id);
  });
  dropLoginChallenges(u.id);
  logEvent(u.id, 'account', `Double authentification désactivée${NBSP}: le mot de passe suffit de nouveau pour se connecter.`);
  res.json({ ok: true });
}));
twofactor.post('/auth/2fa/recovery', requireAuth, rateLimit({ max: 10 }), wrap(async (req, res) => {
  const u = req.user;
  if (!twoFactorEnabled(u.id)) return bad(res, NOT_ENABLED, 409);
  if (!(await confirmIdentity(req, res))) return;
  const codes = newRecoveryCodes();
  tx(() => storeRecoveryCodes(u.id, codes, now()));
  logEvent(u.id, 'account', `Nouveaux codes de secours générés${NBSP}: les précédents ne fonctionnent plus.`);
  res.json({ ok: true, recovery_codes: codes });
}));
