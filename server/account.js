// Fonctions de compte de l'abonné : mot de passe oublié (lien à usage unique envoyé par e-mail) et appareils connectés.
// Règles : la demande de lien répond la même chose, dans le même délai, que le compte existe ou non ; seule l'empreinte
// SHA-256 du jeton est stockée (le jeton n'existe que dans l'e-mail, masqué dans la table mails) ; un lien expire après
// une heure, ne sert qu'une fois, et un nouveau lien remplace les précédents. Une session n'est désignée hors du serveur
// que par sa poignée (empreinte tronquée), jamais par son identifiant.
import express from 'express';
import crypto from 'node:crypto';
import { db, q, now, tx, logEvent } from './db.js';
import {
  hashPassword, passwordProblem, createSession, destroySession, destroyOtherSessions, requireAuth, rateLimit,
  isSuspended, isBlockedEmail, promoteIfAdmin, adminPending, clearLoginFailures,
} from './auth.js';
import { sendMail } from './mailer.js';
import { passwordResetMail, passwordChangedMail, adminVerifyMail } from './templates.js';
import { EMAIL, str, wrap, publicUser, sessionHandle, deviceLabel } from './util.js';

export const account = express.Router();
const NBSP = ' ';
const bad = (res, msg, code = 400, extra = {}) => res.status(code).json({ error: msg, ...extra });
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ---------- Schéma (idempotent) ---------- */
// email : adresse à laquelle le lien est parti. Si l'adresse du compte change entre-temps, le lien ne vaut plus.
db.exec(`
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);
`);
// Un lien expiré reste connu 24 h (pour répondre « lien expiré » plutôt que « lien inconnu »), puis disparaît.
const purgeResets = () => q.run('DELETE FROM password_resets WHERE expires_at <= ?', new Date(Date.now() - 24 * 3600000).toISOString());
purgeResets();

/* ---------- Mot de passe oublié ---------- */
const RESET_TTL_MS = 60 * 60000;   // une heure : les e-mails et l'interface l'annoncent en toutes lettres
// Avant la réponse : uniquement des lectures, identiques que le compte existe ou non, puis une durée minimale.
// Après la réponse : l'écriture du jeton et l'envoi, qui ne peuvent donc plus rien trahir (verrou d'écriture SQLite
// occupé, serveur SMTP lent).
const FORGOT_FLOOR_MS = 300;
const NEUTRAL = 'Si un compte Oubli est associé à cette adresse, un e-mail contenant un lien de réinitialisation vient de lui être envoyé. Le lien est valable une heure.';
const addressKey = (req) => sha256(String(req.body?.email ?? '').toLowerCase().trim());

// Compte suspendu : le lien est envoyé et le mot de passe peut être changé (la suspension est temporaire et le titulaire
// de l'adresse doit pouvoir retrouver l'accès), mais aucune session n'est ouverte tant que dure la suspension.
// Compte supprimé (adresse anonymisée) ou adresse sur la liste de blocage : aucun envoi.
account.post('/auth/forgot',
  rateLimit({ windowMs: 15 * 60000, max: 10 }),                                          // par IP
  rateLimit({ windowMs: 60 * 60000, max: 3, name: 'forgot-address', by: addressKey }),    // par adresse, compte existant ou non
  wrap(async (req, res) => {
    const started = Date.now();
    const email = str(req.body.email, 'email', 160).toLowerCase();
    if (!EMAIL.test(email)) return bad(res, 'Adresse e-mail invalide.');
    const token = crypto.randomBytes(32).toString('base64url');   // tiré dans tous les cas : même travail
    const blocked = isBlockedEmail(email);
    const user = q.get('SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL', email);
    const send = !!user && !blocked;
    await sleep(Math.max(0, FORGOT_FLOOR_MS - (Date.now() - started)));
    res.json({ ok: true, message: NEUTRAL });
    setImmediate(() => {
      try {
        purgeResets();
        if (!send) return;
        const t = Date.now();
        tx(() => {
          q.run('DELETE FROM password_resets WHERE user_id = ?', user.id);   // un nouveau lien remplace les précédents
          q.run('INSERT INTO password_resets (user_id, token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
            user.id, sha256(token), user.email, new Date(t).toISOString(), new Date(t + RESET_TTL_MS).toISOString());
        });
        const m = passwordResetMail({ token });
        sendMail({ to: user.email, subject: m.subject, text: m.text, user_id: user.id, redact: [token] })
          .catch((e) => console.error('[account] lien de réinitialisation non envoyé :', e.message));
      } catch (e) { console.error('[account] lien de réinitialisation non préparé :', e.message); }
    });
  }));

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const LINK_ERRORS = {
  invalid: `Ce lien n’est pas valide ou a été remplacé par un lien plus récent${NBSP}: utilisez le dernier e-mail reçu, ou demandez un nouveau lien.`,
  expired: `Ce lien a expiré${NBSP}: il n’est valable qu’une heure. Demandez-en un nouveau.`,
  used: `Ce lien a déjà servi${NBSP}: il ne fonctionne qu’une fois. Demandez-en un nouveau si besoin.`,
};
const linkError = (res, code) => bad(res, LINK_ERRORS[code], 400, { code });

account.post('/auth/reset', rateLimit({ windowMs: 15 * 60000, max: 20 }), wrap(async (req, res) => {
  const { token, password } = req.body;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return linkError(res, 'invalid');
  if (typeof password !== 'string') return bad(res, 'Mot de passe invalide.');
  const row = q.get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(token));
  if (!row) return linkError(res, 'invalid');
  if (row.used_at) return linkError(res, 'used');
  if (!(row.expires_at > now())) return linkError(res, 'expired');
  const user = q.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', row.user_id);
  // Compte supprimé, adresse changée depuis l'envoi du lien ou bloquée : le lien ne vaut plus.
  if (!user || user.email !== row.email || isBlockedEmail(user.email)) {
    q.run('DELETE FROM password_resets WHERE id = ?', row.id);
    return linkError(res, 'invalid');
  }
  const problem = passwordProblem(password, user.email);
  if (problem) return bad(res, problem);   // le lien reste valable : l'abonné peut choisir un autre mot de passe
  const hash = await hashPassword(password);
  const at = now();
  const changed = tx(() => {
    // Usage unique, même pour deux envois simultanés : seul le premier marque le jeton.
    if (!Number(q.run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', at, row.id, at).changes)) return false;
    q.run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', hash, at, user.id);   // lien reçu : boîte prouvée
    q.run('DELETE FROM sessions WHERE user_id = ?', user.id);                                // toutes les sessions du compte
    q.run('DELETE FROM password_resets WHERE user_id = ? AND id <> ?', user.id, row.id);     // et tous ses autres jetons
    return true;
  });
  if (!changed) return linkError(res, 'used');
  clearLoginFailures(user.email);
  logEvent(user.id, 'account', `Mot de passe réinitialisé avec le lien reçu par e-mail${NBSP}; tous les appareils ont été déconnectés.`);
  setImmediate(() => {
    const m = passwordChangedMail({ changedAt: at });
    sendMail({ to: user.email, subject: m.subject, text: m.text, user_id: user.id })
      .catch((e) => console.error('[account] avis de changement de mot de passe non envoyé :', e.message));
  });
  // Ce navigateur abandonne sa session éventuelle (peut-être celle d'un autre compte) avant d'en ouvrir une nouvelle.
  if (req.sessionId) destroySession(req, res);
  if (isSuspended(user)) {
    return res.json({ ok: true, signed_in: false, suspended: true, message: `Votre mot de passe est changé, mais ce compte est suspendu${NBSP}: la connexion reste impossible pour le moment. Pour toute question, écrivez au support.` });
  }
  const updated = promoteIfAdmin(q.get('SELECT * FROM users WHERE id = ?', user.id));   // adresse prouvée : promotion possible
  createSession(res, updated, req);
  res.json({ ok: true, signed_in: true, user: publicUser(updated) });
}));

/* ---------- Confirmation de l'adresse d'un administrateur ---------- */
// Une adresse de ADMIN_EMAILS ne donne l'accès administrateur qu'une fois la boîte prouvée (auth.js, ADMIN_VERIFY) :
// lien à usage unique, valable 24 h, dont seule l'empreinte SHA-256 est stockée.
db.exec(`
CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
`);
const VERIFY_TTL_MS = 24 * 3600000;
// Envoie le lien si le compte l'attend et qu'aucun lien valable n'est déjà parti (un envoi par jour au plus, même en
// se reconnectant). Retourne true si un e-mail part.
export function sendAdminVerification(user) {
  if (!adminPending(user)) return false;
  const at = now();
  if (q.get('SELECT 1 FROM email_verifications WHERE user_id = ? AND email = ? AND used_at IS NULL AND expires_at > ?', user.id, user.email, at)) return false;
  const token = crypto.randomBytes(32).toString('base64url');
  tx(() => {
    q.run('DELETE FROM email_verifications WHERE user_id = ?', user.id);
    q.run('INSERT INTO email_verifications (user_id, token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', user.id, sha256(token), user.email, at, new Date(Date.now() + VERIFY_TTL_MS).toISOString());
  });
  const m = adminVerifyMail({ token });
  sendMail({ to: user.email, subject: m.subject, text: m.text, user_id: user.id, redact: [token] })
    .catch((e) => console.error('[account] lien de confirmation non envoyé :', e.message));
  return true;
}
const VERIFY_ERRORS = {
  invalid: `Ce lien de confirmation n’est pas valide ou a été remplacé${NBSP}: utilisez le dernier e-mail reçu.`,
  expired: `Ce lien de confirmation a expiré${NBSP}: reconnectez-vous pour en recevoir un nouveau.`,
  used: `Ce lien a déjà servi${NBSP}: votre adresse est confirmée.`,
};
const verifyError = (res, code) => bad(res, VERIFY_ERRORS[code], 400, { code });
account.post('/auth/verify', rateLimit({ windowMs: 15 * 60000, max: 20 }), (req, res) => {
  const { token } = req.body;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return verifyError(res, 'invalid');
  const row = q.get('SELECT * FROM email_verifications WHERE token_hash = ?', sha256(token));
  if (!row) return verifyError(res, 'invalid');
  if (row.used_at) return verifyError(res, 'used');
  if (!(row.expires_at > now())) return verifyError(res, 'expired');
  const user = q.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', row.user_id);
  if (!user || user.email !== row.email || isBlockedEmail(user.email)) {   // compte supprimé, adresse changée ou bloquée
    q.run('DELETE FROM email_verifications WHERE id = ?', row.id);
    return verifyError(res, 'invalid');
  }
  const at = now();
  const done = tx(() => {
    if (!Number(q.run('UPDATE email_verifications SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', at, row.id, at).changes)) return false;
    q.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', at, user.id);
    return true;
  });
  if (!done) return verifyError(res, 'used');
  const updated = promoteIfAdmin(q.get('SELECT * FROM users WHERE id = ?', user.id));
  logEvent(user.id, 'account', updated.role === 'admin' ? `Adresse confirmée${NBSP}: accès administrateur activé.` : 'Adresse e-mail confirmée.');
  res.json({ ok: true, admin: updated.role === 'admin' });
});

/* ---------- Appareils connectés ---------- */
// La dernière activité d'une session est rafraîchie au plus une fois par heure (auth.js) ; celle de la session courante
// est l'instant présent. Une session d'accès support (un administrateur consulte le compte) est signalée comme telle.
const HANDLE_RE = /^[A-Za-z0-9_-]{16}$/;
const ownSessions = (userId) => q.all('SELECT id, created_at, last_seen_at, expires_at, user_agent, impersonator_id FROM sessions WHERE user_id = ? AND expires_at > ?', userId, now());
const deviceOf = (s) => (s.impersonator_id ? 'Accès support Oubli' : deviceLabel(s.user_agent));
const publicSession = (s, currentId) => ({
  handle: sessionHandle(s.id), device: deviceOf(s), created_at: s.created_at,
  last_seen_at: s.id === currentId ? now() : s.last_seen_at || s.created_at, expires_at: s.expires_at,
  current: s.id === currentId, support: !!s.impersonator_id,
});

account.get('/sessions', requireAuth, (req, res) => {
  const sessions = ownSessions(req.user.id).map((s) => publicSession(s, req.sessionId))
    .sort((a, b) => (Number(b.current) - Number(a.current)) || b.last_seen_at.localeCompare(a.last_seen_at));
  res.json({ sessions });
});
// Les écritures ci-dessous sont refusées pendant un accès support par la garde de lecture seule (index.js).
account.delete('/sessions/:handle', requireAuth, (req, res) => {
  const h = req.params.handle;
  const s = HANDLE_RE.test(h) ? ownSessions(req.user.id).find((x) => sessionHandle(x.id) === h) : null;
  if (!s) return bad(res, `Appareil introuvable${NBSP}: il est peut-être déjà déconnecté.`, 404);
  if (s.id === req.sessionId) return bad(res, `Pour cet appareil, utilisez «${NBSP}Se déconnecter${NBSP}».`);
  q.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', s.id, req.user.id);
  logEvent(req.user.id, 'account', `Appareil déconnecté depuis les paramètres${NBSP}: ${deviceOf(s)}.`);
  res.json({ ok: true });
});
account.post('/sessions/revoke-others', requireAuth, (req, res) => {
  const revoked = destroyOtherSessions(req.user.id, req.sessionId);
  if (revoked) logEvent(req.user.id, 'account', revoked > 1 ? `${revoked}${NBSP}autres appareils déconnectés depuis les paramètres.` : 'Un autre appareil déconnecté depuis les paramètres.');
  res.json({ ok: true, revoked });
});
