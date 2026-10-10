// Utilitaires partagés par les routeurs : nettoyage et validation des entrées, sérialisation publique, wrapper async.
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
export const arr = (v, max = 10) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map((s) => clean(s, 160)).filter(Boolean).slice(0, max);
// Vue publique d'un utilisateur : jamais de mot de passe, d'identifiants Stripe, d'adresse IP ni de session.
export const publicUser = (u) => ({
  id: u.id, email: u.email, role: u.role, plan: u.plan, billing: u.billing,
  subscription_status: u.subscription_status, subscription_ends_at: u.subscription_ends_at, billing_mode: u.billing_mode,
  mandate_signed_at: u.mandate_signed_at, mandate_name: u.mandate_name, mandate_version: u.mandate_version, mandate_revoked_at: u.mandate_revoked_at, created_at: u.created_at,
});
const parseList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
export const parseProfile = (p) => ({ ...p, emails: parseList(p.emails), phones: parseList(p.phones), addresses: parseList(p.addresses), aliases: parseList(p.aliases) });
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- Validation des entrées ---------- */
// Erreur HTTP « exposable » : le gestionnaire global renvoie son message tel quel (statut < 500).
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.expose = true; }
}
export const isPlainObject = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) && !Array.isArray(v);
// Identifiant de ressource (UUID, jeton, id numérique) : chaîne courte sans caractère exotique.
export const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
// Chaîne optionnelle : absente → '', autre type que chaîne → 400, trop longue → 400. Retourne la valeur nettoyée.
export const str = (v, name, max = 200) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `Champ « ${name} » invalide.`);
  if (v.length > max) throw new HttpError(400, `Champ « ${name} » trop long (${max} caractères maximum).`);
  return v.trim();
};
// Liste optionnelle de chaînes courtes (tableau ou chaîne séparée par virgules / retours à la ligne).
export const strList = (v, name, max = 10, itemMax = 160) => {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    if (v.length > 200 || v.some((s) => typeof s !== 'string' && typeof s !== 'number')) throw new HttpError(400, `Champ « ${name} » invalide.`);
    return arr(v.map(String), max).map((s) => s.slice(0, itemMax));
  }
  if (typeof v !== 'string') throw new HttpError(400, `Champ « ${name} » invalide.`);
  if (v.length > 4000) throw new HttpError(400, `Champ « ${name} » trop long.`);
  return arr(v, max).map((s) => s.slice(0, itemMax));
};
// Valeur parmi une liste blanche (ou absente).
export const oneOf = (v, allowed, name) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(400, `Champ « ${name} » invalide.`);
  return v;
};
