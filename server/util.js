// Utilitaires partagés par les routeurs : nettoyage des entrées, sérialisation publique, wrapper async.
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
export const arr = (v, max = 10) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map((s) => clean(s, 160)).filter(Boolean).slice(0, max);
export const publicUser = (u) => ({
  id: u.id, email: u.email, role: u.role, plan: u.plan, billing: u.billing,
  subscription_status: u.subscription_status, subscription_ends_at: u.subscription_ends_at, billing_mode: u.billing_mode,
  mandate_signed_at: u.mandate_signed_at, mandate_name: u.mandate_name, mandate_version: u.mandate_version, mandate_revoked_at: u.mandate_revoked_at, created_at: u.created_at,
});
const parseList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
export const parseProfile = (p) => ({ ...p, emails: parseList(p.emails), phones: parseList(p.phones), addresses: parseList(p.addresses), aliases: parseList(p.aliases) });
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
