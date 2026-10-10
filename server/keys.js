// Clés d’activation : un abonnement offert sans paiement (à des proches, à des partenaires).
// Format OUBLI-XXXX-XXXX-XXXX : 12 caractères en base32 de Crockford (sans I, L, O ni U), tirés un à un avec
// crypto.randomInt, soit 60 bits. Seule l’empreinte SHA-256 de la forme normalisée est stockée, avec les 4 derniers
// caractères (hint) pour reconnaître une clé : la clé en clair n’apparaît qu’une fois, dans la réponse de création de
// l’administration, et n’est jamais écrite en base, dans l’audit, dans le journal ni dans la console.
import crypto from 'node:crypto';
import { q, now, addDays, logEvent, tx } from './db.js';
import { PLANS } from './billing.js';
import { launchProfile, tick, subscriptionActive } from './scheduler.js';
import { HttpError, publicUser } from './util.js';

export const KEY_PREFIX = 'OUBLI';
export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // base32 de Crockford
export const KEY_LIMITS = { count: 100, days: 730, uses: 1000, note: 120 };
const BODY = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const NB = '\u00a0';
export const longDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/* ---------- Format ---------- */
export function generateKey() {
  let s = '';
  for (let i = 0; i < 12; i += 1) s += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  return `${KEY_PREFIX}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
// Saisie tolérante : casse indifférente, espaces et tirets ignorés, préfixe facultatif, O lu 0, I et L lus 1.
// Retourne la forme normalisée OUBLI-XXXX-XXXX-XXXX, ou null si la saisie ne peut pas être une clé.
export function normalizeKey(input) {
  if (typeof input !== 'string' || input.length > 80) return null;
  let s = input.toUpperCase().replace(/[\s\-_.\u2010-\u2015\u2212]/g, '');
  if (s.length === 12 + KEY_PREFIX.length && s.startsWith(KEY_PREFIX)) s = s.slice(KEY_PREFIX.length);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return BODY.test(s) ? `${KEY_PREFIX}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` : null;
}
export const hashKey = (normalized) => crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');

/* ---------- Statut d’une clé ---------- */
// Par ordre de priorité : révoquée, utilisée (toutes ses activations consommées), expirée, active. Les quatre
// conditions SQL sont exclusives ; celles qui comparent une date attendent « maintenant » en paramètre (dated).
export const KEY_STATUS_SQL = {
  revoked: { sql: 'k.revoked_at IS NOT NULL', dated: false },
  used: { sql: 'k.revoked_at IS NULL AND k.uses >= k.max_uses', dated: false },
  expired: { sql: 'k.revoked_at IS NULL AND k.uses < k.max_uses AND k.expires_at IS NOT NULL AND k.expires_at <= ?', dated: true },
  active: { sql: 'k.revoked_at IS NULL AND k.uses < k.max_uses AND (k.expires_at IS NULL OR k.expires_at > ?)', dated: true },
};
export function keyStatus(k, at = now()) {
  if (k.revoked_at) return 'revoked';
  if (k.uses >= k.max_uses) return 'used';
  if (k.expires_at && k.expires_at <= at) return 'expired';
  return 'active';
}
// Compteurs par statut, et abonnements offerts par clé en cours (vue d’ensemble de l’administration).
export function keyCounts(at = now()) {
  const sum = (s) => `COALESCE(SUM(CASE WHEN ${s.sql} THEN 1 ELSE 0 END), 0)`;
  const r = q.get(`SELECT COUNT(*) AS all_n, ${sum(KEY_STATUS_SQL.active)} AS active, ${sum(KEY_STATUS_SQL.used)} AS used, ${sum(KEY_STATUS_SQL.expired)} AS expired, ${sum(KEY_STATUS_SQL.revoked)} AS revoked FROM activation_keys k`, at, at);
  return { all: r.all_n, active: r.active, used: r.used, expired: r.expired, revoked: r.revoked };
}
export const keySubscriptions = (at = now()) => q.get(`SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND billing_mode = 'key' AND subscription_status = 'active' AND subscription_ends_at > ?`, at).c;

/* ---------- Création par lot (administration) ---------- */
const intIn = (v, min, max) => {
  const n = typeof v === 'string' && /^\s*\d{1,7}\s*$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
// Valide la demande de création : nombre de clés, offre, durée, utilisations par clé, date limite facultative, note.
export function parseKeyBatch(body) {
  const count = intIn(body.count ?? 1, 1, KEY_LIMITS.count);
  if (count === null) throw new HttpError(400, `Nombre de clés invalide${NB}: de 1 à ${KEY_LIMITS.count} par lot.`);
  const plan = typeof body.plan === 'string' && Object.hasOwn(PLANS, body.plan) ? body.plan : null;
  if (!plan) throw new HttpError(400, `Offre inconnue${NB}: ${Object.keys(PLANS).join(' ou ')}.`);
  const days = intIn(body.days, 1, KEY_LIMITS.days);
  if (days === null) throw new HttpError(400, `Durée invalide${NB}: de 1 à ${KEY_LIMITS.days} jours.`);
  const maxUses = intIn(body.max_uses ?? 1, 1, KEY_LIMITS.uses);
  if (maxUses === null) throw new HttpError(400, `Nombre d’utilisations invalide${NB}: de 1 à ${KEY_LIMITS.uses} par clé.`);
  let expiresAt = null;
  if (body.expires_at !== undefined && body.expires_at !== null && body.expires_at !== '') {
    const v = typeof body.expires_at === 'string' ? body.expires_at.trim() : '';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(v);   // un jour : la clé s’active jusqu’à sa fin (UTC)
    const d = new Date(day ? `${v}T23:59:59.999Z` : v.length <= 40 ? v : '');
    if (!v || Number.isNaN(d.getTime()) || (day && d.toISOString().slice(0, 10) !== v)) throw new HttpError(400, `Date limite invalide${NB}: AAAA-MM-JJ.`);
    expiresAt = d.toISOString();
    if (expiresAt <= now()) throw new HttpError(400, 'La date limite doit être dans le futur.');
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new HttpError(400, 'Note invalide.');
  const note = String(body.note ?? '').trim();
  if (note.length > KEY_LIMITS.note) throw new HttpError(400, `Note trop longue${NB}: ${KEY_LIMITS.note} caractères au plus.`);
  return { count, plan, days, max_uses: maxUses, expires_at: expiresAt, note: note || null };
}
// Crée un lot de clés dans une seule transaction. Retourne les clés en clair : c’est la seule fois où elles existent.
export function createKeys(opts, adminId) {
  const batch = crypto.randomBytes(4).toString('hex').toUpperCase();
  const at = now();
  const keys = tx(() => {
    const out = [];
    while (out.length < opts.count) {
      const key = generateKey(), hash = hashKey(key);
      if (q.get('SELECT 1 FROM activation_keys WHERE key_hash = ?', hash)) continue;   // collision (2⁻⁶⁰) : nouveau tirage
      const r = q.run('INSERT INTO activation_keys (key_hash, hint, plan, days, max_uses, expires_at, note, batch, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        hash, key.slice(-4), opts.plan, opts.days, opts.max_uses, opts.expires_at, opts.note, batch, adminId, at);
      out.push({ id: Number(r.lastInsertRowid), key, hint: key.slice(-4) });
    }
    return out;
  });
  return { batch, created_at: at, plan: opts.plan, days: opts.days, max_uses: opts.max_uses, expires_at: opts.expires_at, note: opts.note, keys };
}
// Révocation : plus aucune activation possible. Les abonnements déjà accordés vont à leur terme (modifiables depuis la
// fiche du compte).
export function revokeKey(id, adminId) {
  const k = q.get('SELECT * FROM activation_keys WHERE id = ?', id);
  if (!k) throw new HttpError(404, 'Clé introuvable.');
  if (k.revoked_at) throw new HttpError(409, 'Cette clé est déjà révoquée.');
  q.run('UPDATE activation_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', now(), adminId, k.id);
  return q.get('SELECT * FROM activation_keys WHERE id = ?', k.id);
}

/* ---------- Activation par l’abonné ---------- */
// Un abonnement payé (carte ou simulé), un paiement en attente ou un abonnement activé par l’équipe n’est jamais
// remplacé par une clé : l’abonné saurait mal ce qu’il paie encore. Retourne le message de refus, ou null.
export function redeemRefusal(u) {
  const active = u.subscription_status === 'active';
  if (active && u.billing_mode === 'stripe') return `Votre abonnement est payé par carte${NB}: résiliez-le d’abord sur la page Abonnement${NB}; la clé prendra le relais à la fin de la période déjà payée.`;
  if (active && u.billing_mode === 'simulated') return `Un abonnement simulé est déjà actif sur ce compte${NB}: résiliez-le d’abord sur la page Abonnement, puis activez la clé.`;
  if (u.subscription_status === 'past_due' && u.billing_mode === 'stripe') return `Un paiement par carte est en attente de régularisation${NB}: mettez à jour votre moyen de paiement ou écrivez au support avant d’activer une clé.`;
  if (active && u.billing_mode !== 'key') return `Votre abonnement a été activé par l’équipe Oubli${NB}: aucune clé n’est nécessaire.`;
  return null;
}
// « Résilier » ne s’applique pas à un abonnement offert : aucun paiement à arrêter, aucun renouvellement, une date de
// fin déjà fixée. Une fin immédiate détruirait les jours offerts sans retour possible (la clé ne resservirait pas) ;
// pour arrêter les envois, la révocation du mandat suffit et reste réversible.
export function cancelRefusal(u) {
  if (u.billing_mode !== 'key' || !subscriptionActive(u)) return null;
  return `Votre abonnement est offert par une clé d’activation${NB}: il n’y a rien à résilier, il s’arrête de lui-même le ${longDate(u.subscription_ends_at)}. Pour suspendre les demandes dès maintenant, révoquez le mandat depuis votre dossier.`;
}

const ERR = {
  format: `Clé invalide${NB}: elle se présente sous la forme ${['OUBLI', 'XXXX', 'XXXX', 'XXXX'].join('\u2011')}.`,   // traits d’union insécables
  unknown: `Clé inconnue${NB}: vérifiez qu’elle a été recopiée sans erreur.`,
  mine: 'Vous avez déjà activé cette clé sur ce compte.',
  revoked: `Cette clé a été révoquée${NB}: elle ne peut plus être utilisée.`,
  used: `Cette clé a déjà été utilisée${NB}: elle ne peut plus servir.`,
};
// Active une clé pour le compte : abonnement 'active', billing_mode 'key', offre de la clé, fin = max(maintenant, fin de
// l’accès en cours) + durée. L’accès en cours est un abonnement par clé actif (cumul) ou un abonnement résilié dont la
// période payée court encore : la clé prend alors le relais à la fin de cette période, sans la raccourcir.
// L’incrément de uses, l’enregistrement de l’activation et la mise à jour du compte forment une seule transaction ;
// l’incrément est conditionnel (uses < max_uses) et la base refuse tout dépassement (CHECK).
// Erreurs : 400 saisie impossible, 404 clé inconnue, 409 abonnement en cours incompatible (l’abonné peut agir puis
// réessayer), 410 clé devenue inutilisable (révoquée, expirée, épuisée ou déjà activée par ce compte).
export function redeemKey(userId, input) {
  const before = q.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', userId);
  if (!before) throw new HttpError(404, 'Compte introuvable.');
  const refusal = redeemRefusal(before);
  if (refusal) throw new HttpError(409, refusal);
  const key = normalizeKey(input);
  if (!key) throw new HttpError(400, ERR.format);
  const k = q.get('SELECT * FROM activation_keys WHERE key_hash = ?', hashKey(key));
  if (!k) throw new HttpError(404, ERR.unknown);
  if (q.get('SELECT 1 FROM key_redemptions WHERE key_id = ? AND user_id = ?', k.id, userId)) throw new HttpError(410, ERR.mine);
  const at = now();
  const status = keyStatus(k, at);
  if (status === 'revoked') throw new HttpError(410, ERR.revoked);
  if (status === 'used') throw new HttpError(410, ERR.used);
  if (status === 'expired') throw new HttpError(410, `Cette clé a expiré le ${longDate(k.expires_at)}${NB}: elle ne peut plus être utilisée.`);

  const done = tx(() => {
    const inc = q.run('UPDATE activation_keys SET uses = uses + 1 WHERE id = ? AND revoked_at IS NULL AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)', k.id, at);
    if (!inc.changes) throw new HttpError(410, ERR.used);
    const u = q.get('SELECT * FROM users WHERE id = ?', userId);
    const again = redeemRefusal(u);
    if (again) throw new HttpError(409, again);
    const keyRunning = u.billing_mode === 'key' && u.subscription_status === 'active' && u.subscription_ends_at > at;
    const paidRunning = u.subscription_status === 'canceled' && u.subscription_ends_at > at;
    const base = keyRunning || paidRunning ? u.subscription_ends_at : at;
    const ends = addDays(base, k.days);
    // Une clé Famille fait passer à l’offre Famille ; une clé Individuel ne retire pas l’offre Famille en cours.
    const plan = k.plan === 'famille' || ((keyRunning || paidRunning) && u.plan === 'famille') ? 'famille' : k.plan;
    try {
      q.run('INSERT INTO key_redemptions (key_id, user_id, redeemed_at, ends_at) VALUES (?, ?, ?, ?)', k.id, userId, at, ends);
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(410, ERR.mine);
      throw e;
    }
    q.run(`UPDATE users SET subscription_status = 'active', billing_mode = 'key', plan = ?, billing = NULL, subscription_ends_at = ? WHERE id = ?`, plan, ends, userId);
    logEvent(userId, 'account', `Abonnement ${PLANS[plan]?.name || plan} ${keyRunning ? 'prolongé' : 'activé'} par clé jusqu’au ${longDate(ends)}.`);
    return { plan, ends, extended: keyRunning };
  });

  // Comme après un paiement : les demandes des profils complets partent (mandat signé requis), puis un passage du
  // planificateur envoie aussi ce qui attendait en file.
  const user = q.get('SELECT * FROM users WHERE id = ?', userId);
  let launched = 0;
  for (const p of q.all('SELECT * FROM profiles WHERE user_id = ?', userId)) launched += launchProfile(user, p).created || 0;
  setTimeout(() => { tick(); }, 10);
  return { user: publicUser(user), plan: done.plan, ends_at: done.ends, days: k.days, extended: done.extended, launched };
}

// Clés utilisées par un compte (fiche de l’administration) : indice seulement.
export const keysOfUser = (userId) => q.all(`SELECT k.id AS key_id, k.hint, k.plan, k.days, k.note, k.batch, k.revoked_at, kr.redeemed_at, kr.ends_at
  FROM key_redemptions kr JOIN activation_keys k ON k.id = kr.key_id WHERE kr.user_id = ? ORDER BY kr.id DESC LIMIT 20`, userId);
