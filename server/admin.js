// Routeur d'administration (back-office) : monté sur /api/admin derrière requireAuth + requireAdmin (voir routes.js).
// Règles : toute entrée est validée, la pagination est plafonnée, les jokers LIKE sont échappés, jamais de
// password_hash ni d'identifiant de session en sortie, identifiants Stripe masqués, chaque mutation est journalisée
// dans admin_audit.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, q, now, logEvent } from './db.js';
import * as scheduler from './scheduler.js';
import { sendMail, mailMode } from './mailer.js';
import { PLANS, billingMode, cancelSubscription } from './billing.js';
import { EMAIL, clean, parseProfile, wrap } from './util.js';
import { isSuspended, isBlockedEmail, startImpersonation, SUPPORT_MINUTES } from './auth.js';
import { exportData } from './dashboard.js';
import { runDiscovery } from './sites.js';
import { runMonthlyReports } from './reports.js';
import { KEY_STATUS_SQL, keyStatus, keyCounts, keySubscriptions, parseKeyBatch, createKeys, revokeKey, keysOfUser } from './keys.js';
import { backupStatus, runBackup } from './backup.js';

const { applyOutcome, tick, launchProfile, ref, DEMO } = scheduler;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX = process.env.OUTBOX_DIR || path.join(__dirname, '..', 'data', 'outbox');
const STARTED_AT = now();
let lastManualTickAt = null;

/* ---------- Schéma propre à l'administration ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target);
CREATE TABLE IF NOT EXISTS admin_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_notes_user ON admin_notes(user_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`);
// Suivi des messages de contact (colonne additive, sans effet sur le reste de l'application).
if (!db.prepare('PRAGMA table_info(contacts)').all().some((c) => c.name === 'handled_at')) db.exec('ALTER TABLE contacts ADD COLUMN handled_at TEXT');

/* ---------- Utilitaires ---------- */
export const admin = express.Router();
admin.use((req, _res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });

const PAGE_MAX = 100;
const STATUSES = ['queued', 'sent', 'in_progress', 'action_required', 'done', 'refused', 'error'];
const OUTCOMES = ['done', 'in_progress', 'action_required', 'refused'];
const SUBS = ['none', 'active', 'past_due', 'canceled'];
const JURISDICTIONS = ['FR', 'EU', 'UK', 'US', 'CA', 'CH'];
const BASES = ['rgpd', 'ccpa', 'both'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-F0-9]{10}$/;
const INT = /^\d{1,9}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const like = (s) => '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const mask = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-4)}` : null);
const int = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const isoDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
function paging(query, def = 25) {
  const per = Math.min(PAGE_MAX, Math.max(1, int(query.per, def)));
  const page = Math.min(1000000, Math.max(1, int(query.page, 1)));
  return { per, page, offset: (page - 1) * per };
}
const pageMeta = (total, p) => ({ total, page: p.page, per: p.per, pages: Math.max(1, Math.ceil(total / p.per)) });
// Page au-delà de la dernière (lien conservé après une action qui a vidé la fin de la liste) : ramenée à la dernière.
const fit = (p, total) => { p.page = Math.min(p.page, Math.max(1, Math.ceil(total / p.per))); p.offset = (p.page - 1) * p.per; return p; };
// Journal d'audit. auditAs sert aussi hors du routeur (fin d'un accès support, routes.js).
export function auditAs(adminId, action, target, details = {}, ip = '') {
  q.run('INSERT INTO admin_audit (admin_id, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)', adminId, action, target == null ? null : String(target), JSON.stringify(details), String(ip || '').slice(0, 64), now());
}
const audit = (req, action, target, details = {}) => auditAs(req.user.id, action, target, details, req.ip);
const adminUser = (u) => ({
  id: u.id, email: u.email, role: u.role, plan: u.plan, billing: u.billing,
  subscription_status: u.subscription_status, subscription_ends_at: u.subscription_ends_at, billing_mode: u.billing_mode,
  stripe_customer: mask(u.stripe_customer_id), stripe_subscription: mask(u.stripe_subscription_id),
  mandate_signed_at: u.mandate_signed_at, mandate_name: u.mandate_name, mandate_version: u.mandate_version, mandate_revoked_at: u.mandate_revoked_at,
  created_at: u.created_at, deleted_at: u.deleted_at,
  suspended: isSuspended(u), suspended_at: u.suspended_at, suspended_until: u.suspended_until, suspended_reason: u.suspended_reason,
});
const SUSPENDED_SQL = '(u.suspended_at IS NOT NULL AND (u.suspended_until IS NULL OR u.suspended_until > ?))';
// Sessions : jamais l'identifiant brut, seulement une empreinte courte qui sert de poignée pour la fermeture.
const handleOf = (id) => crypto.createHash('sha256').update(String(id)).digest('base64url').slice(0, 16);
function device(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /node|curl|undici/i.test(s) ? 'Script' : '';
  return [br, os].filter(Boolean).join(' · ') || 'Appareil inconnu';
}
const publicSession = (s, currentId) => ({
  handle: handleOf(s.id), user_id: s.user_id, email: s.email, created_at: s.created_at, last_seen_at: s.last_seen_at || s.created_at, expires_at: s.expires_at,
  ip: s.ip, device: device(s.user_agent), user_agent: String(s.user_agent || '').slice(0, 120), support_by: s.impersonator_email || null, current: s.id === currentId,
});
const SESSION_COLS = 's.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent, a.email AS impersonator_email';
const sessionsOf = (userId, currentId) => q.all(`SELECT ${SESSION_COLS} FROM sessions s LEFT JOIN users a ON a.id = s.impersonator_id WHERE s.user_id = ? AND s.expires_at > ? ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC`, userId, now()).map((x) => publicSession(x, currentId));
const endOfDay = (v) => isoDate(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T23:59:59.000Z` : v);
const fmtDay = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const BLOCK_PATTERN = (p) => EMAIL.test(p) || (p.startsWith('@') && DOMAIN.test(p.slice(1)));
const getUser = (id) => (UUID.test(String(id)) ? q.get('SELECT * FROM users WHERE id = ?', id) : null);
function getRequest(id) {
  const s = String(id || '').replace(/^OUBLI-/i, '');
  if (UUID.test(s)) return q.get('SELECT * FROM requests WHERE id = ?', s);
  if (TOKEN.test(s.toUpperCase())) return q.get('SELECT * FROM requests WHERE token = ?', s.toUpperCase());
  return null;
}
const getBroker = (id) => (INT.test(String(id)) ? q.get('SELECT * FROM brokers WHERE id = ?', Number(id)) : null);
const statusCounts = (rows) => { const o = Object.fromEntries(STATUSES.map((s) => [s, 0])); rows.forEach((r) => { o[r.status] = r.n; }); return o; };
const reviewCount = () => q.get('SELECT COUNT(*) AS c FROM requests WHERE review_at IS NOT NULL').c;
const lastTickAt = () => (typeof scheduler.lastTickAt === 'string' ? scheduler.lastTickAt : typeof scheduler.lastTickAt === 'function' ? scheduler.lastTickAt() : null);
// Lecture automatique d'une réponse de courtier, partagée par le webhook /api/inbound (routes.js) et la qualification
// par le support. Seul le texte nouveau compte : les lignes citées (« > »), tout ce qui suit un en-tête de citation
// (« Le … a écrit : », « On … wrote: », « De : … », « -----Original Message----- ») et les intitulés de nos propres
// courriers sont ignorés. Sans cela, l'objet « Re: Demande d’effacement… », que le courrier demande de conserver,
// faisait lire toute réponse comme une confirmation. Ordre : aucune donnée détenue (rien à effacer), vérification
// demandée, refus, traitement à venir, effacement confirmé ; à défaut, accusé de réception.
const QUOTE_START = /^\s*(?:le\s.{1,200}\sa\s+écrit\s*:|on\s.{1,200}\swrote\s*:|-{2,}\s*(?:original message|message d['’]origine|forwarded message|message transféré)|_{10,}\s*$|(?:de|from)\s*:\s.*@)/i;
const OWN_SUBJECTS = /demande d['’]effacement de données personnelles|relance\s*[—–-]\s*demande d['’]effacement sans réponse|vérification de l['’]adresse de contact/gi;
const REPLY_RULES = [
  ['done', /(aucune (?:donn[ée]e|fiche|trace)|ne (?:d[ée]tenons|disposons|poss[ée]dons|conservons|traitons) (?:aucune|pas|plus)|(?:no|not any) (?:personal )?(?:data|records?|information|profiles?|listings?) (?:about|on|for|relating|regarding|matching|associated|linked)|(?:cannot|can['’]t|could not|couldn['’]t|unable to|did not|didn['’]t|do not|don['’]t) (?:find|locate)|(?:do not|don['’]t) (?:hold|have|store|process) any)/],
  ['action_required', /(v[ée]rifi(?:er|cation)\s+(?:de\s+|d['’])?(?:votre|l['’]|son|sa|leur)\s*identit|confirm(?:er|ez)?\s+(?:your|votre|l['’]|son|sa|leur|their|the)\s*identit|verify\s+(?:your|the|their|his|her)\s+identity|identity\s+verification|pi[èe]ce\s+d['’]identit|justificatif|proof\s+of\s+(?:identity|residen|address)|photo\s+id|cli(?:quer|quez)\s+sur\s+le\s+lien|click\s+(?:on\s+)?the\s+(?:link|button)|lien\s+de\s+confirmation|confirmation\s+link|formulaire\s+en\s+ligne|online\s+form|web\s+form)/],
  ['refused', /(refus|d[ée]clin|cannot|can['’]t|unable to|not able to|ne (?:pouvons|pourrons|sommes) pas|impossible de|pas en mesure|not applicable|n['’]est pas applicable|exempt)/],
  ['in_progress', /(will be (?:deleted|removed|erased|processed)|will (?:delete|remove|erase|process)|seront?\s+(?:supprim|effac|trait)|allons\s+(?:supprimer|effacer|traiter|proc[ée]der)|traiterons|supprimerons|effacerons)/],
  ['done', /(supprim(?:é|ée|és|ées)(?![a-z])|effac(?:é|ée|és|ées)(?![a-z])|retir(?:é|ée|és|ées)(?![a-z])|d[ée]sindex|d[ée]sinscri|anonymis|proc[ée]d[ée] à (?:la suppression|l['’]effacement)|suppression (?:a été|est) effectu|deleted|removed|erased|purged|anonymi[sz]ed|no longer|opted[ -]out|completed)/],
];
export const classifyReply = (text) => {
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) { if (QUOTE_START.test(line)) break; if (!/^\s*>/.test(line)) kept.push(line); }
  const t = kept.join('\n').replace(OWN_SUBJECTS, ' ').toLowerCase();
  for (const [outcome, re] of REPLY_RULES) if (re.test(t)) return outcome;
  return 'in_progress';
};
// Expéditeur d'une réponse entrante (« Service RGPD <dpo@courtier.fr> » ou « dpo@courtier.fr ») : l'adresse entre les
// derniers chevrons, sinon le champ entier ; null si ce n'est pas exactement une adresse (liste, commentaire, nom seul).
export function senderAddress(from) {
  const s = String(from ?? '').trim();
  const m = s.match(/<([^<>]*)>\s*$/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  if (!/^[^\s@<>()[\],;:"\\]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(addr)) return null;
  return addr.slice(addr.lastIndexOf('@') + 1).split('.').some((l) => !l) ? null : addr;
}
// Un effacement ou un refus ne s'applique de lui-même que s'il vient du domaine du courtier (ou d'un sous-domaine), ou
// du domaine de son adresse de contact vérifiée par l'équipe (pagesjaunes.fr répond depuis solocal.com). Ce contrôle ne
// vaut que si le fournisseur d'e-mail entrant rejette les expéditeurs usurpés (SPF, DKIM, DMARC) : « from » est
// l'expéditeur du message tel qu'il le transmet.
export function trustedSender(from, broker) {
  const addr = senderAddress(from);
  if (!addr || !broker) return false;
  const host = addr.slice(addr.lastIndexOf('@') + 1), domain = String(broker.domain || '').toLowerCase();
  if (domain && (host === domain || host.endsWith(`.${domain}`))) return true;
  const contact = broker.contact_verified === 1 ? String(broker.contact_email || '').toLowerCase() : '';
  return !!contact && host === contact.slice(contact.lastIndexOf('@') + 1);
}
// Demande « à vérifier » : réponse d'un expéditeur non reconnu, lue comme un effacement ou un refus. Interne (jamais
// montré à l'abonné) ; levé par une décision de l'équipe ou par un résultat venu du courtier lui-même.
export const flagReview = (id, outcome, from) => q.run('UPDATE requests SET review_at = ?, review_outcome = ?, review_from = ? WHERE id = ?', now(), outcome, String(from || '').slice(0, 160) || null, id);
export const clearReview = (id) => q.run('UPDATE requests SET review_at = NULL, review_outcome = NULL, review_from = NULL WHERE id = ? AND review_at IS NOT NULL', id).changes > 0;

/* ---------- Vue d'ensemble ---------- */
admin.get('/stats', (_req, res) => {
  const start = new Date(Date.now() - 13 * 86400000); start.setUTCHours(0, 0, 0, 0);
  const sinceIso = start.toISOString();
  const days = Array.from({ length: 14 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
  const byDay = (rows) => { const m = new Map(rows.map((r) => [r.day, r.n])); return days.map((day) => ({ day, n: m.get(day) || 0 })); };
  let mrr = 0;
  // Formule unique : le prix mensuel en vigueur. Un abonnement offert par clé ne rapporte rien : hors revenu.
  for (const u of q.all(`SELECT plan, billing FROM users WHERE deleted_at IS NULL AND subscription_status = 'active' AND billing_mode IS NOT 'key'`)) { const p = PLANS[u.plan]; if (p) mrr += p.monthly; }
  const requests = q.all('SELECT status, COUNT(*) AS n FROM requests GROUP BY status');
  const sentTotal = q.get('SELECT COUNT(*) AS c FROM requests WHERE sent_at IS NOT NULL').c;
  const doneTotal = q.get(`SELECT COUNT(*) AS c FROM requests WHERE status = 'done'`).c;
  const durations = q.all(`SELECT (julianday(completed_at) - julianday(sent_at)) AS d FROM requests WHERE status = 'done' AND sent_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= sent_at ORDER BY d LIMIT 5000`).map((r) => r.d);
  const n = durations.length;
  const median = n ? (n % 2 ? durations[(n - 1) / 2] : (durations[n / 2 - 1] + durations[n / 2]) / 2) : null;
  res.json({
    users: q.get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').c,
    active: q.get(`SELECT COUNT(*) AS c FROM users WHERE subscription_status = 'active'`).c,
    requests,
    mails: q.get('SELECT COUNT(*) AS c FROM mails').c,
    action_required: q.all(`SELECT r.id, r.token, b.name AS broker, u.email FROM requests r JOIN brokers b ON b.id = r.broker_id JOIN users u ON u.id = r.user_id WHERE r.status = 'action_required' ORDER BY r.created_at LIMIT 100`),
    mrr_cents: Math.round(mrr),
    past_due: q.get(`SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND subscription_status = 'past_due'`).c,
    signups_by_day: byDay(q.all('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day', sinceIso)),
    mails_by_day: byDay(q.all('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM mails WHERE created_at >= ? GROUP BY day', sinceIso)),
    requests_by_status: statusCounts(requests),
    requests_total: requests.reduce((a, r) => a + r.n, 0),
    done_rate: sentTotal ? Math.round((doneTotal / sentTotal) * 100) : null,
    median_days_to_done: median == null ? null : Math.round(median * 10) / 10,
    brokers: {
      total: q.get('SELECT COUNT(*) AS c FROM brokers').c,
      active: q.get('SELECT COUNT(*) AS c FROM brokers WHERE active = 1').c,
      verified: q.get('SELECT COUNT(*) AS c FROM brokers WHERE active = 1 AND contact_verified = 1').c,
      custom: q.get('SELECT COUNT(*) AS c FROM brokers WHERE custom = 1').c,
    },
    contacts_open: q.get('SELECT COUNT(*) AS c FROM contacts WHERE handled_at IS NULL').c,
    newsletter: q.get('SELECT COUNT(*) AS c FROM newsletter').c,
    suspended: q.get(`SELECT COUNT(*) AS c FROM users u WHERE u.deleted_at IS NULL AND ${SUSPENDED_SQL}`, now()).c,
    support_sessions: q.get('SELECT COUNT(*) AS c FROM sessions WHERE impersonator_id IS NOT NULL AND expires_at > ?', now()).c,
    review: reviewCount(),   // réponses entrantes à vérifier (badge de l'onglet)
    keys: { ...keyCounts(), subscriptions: keySubscriptions() },
    scheduler: { ...(lastTickAt() ? { last_tick_at: lastTickAt() } : {}), last_manual_tick_at: lastManualTickAt, interval_ms: Number(process.env.SCHEDULER_INTERVAL_MS || (DEMO ? 20000 : 60000)) },
    mail_mode: mailMode, billing_mode: billingMode, demo: DEMO, generated_at: now(),
  });
});

/* ---------- Comptes ---------- */
admin.get('/users', (req, res) => {
  const p = paging(req.query);
  const where = [], params = [];
  const search = clean(req.query.q, 120);
  if (search) { where.push(`(u.email LIKE ? ESCAPE '\\' OR u.id LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.user_id = u.id AND (pr.first_name || ' ' || pr.last_name) LIKE ? ESCAPE '\\'))`); params.push(like(search), like(search), like(search)); }
  const status = clean(req.query.status, 20);
  if (status === 'deleted') where.push('u.deleted_at IS NOT NULL');
  else if (status === 'admin') where.push(`u.role = 'admin' AND u.deleted_at IS NULL`);
  else if (status === 'suspended') { where.push(`u.deleted_at IS NULL AND ${SUSPENDED_SQL}`); params.push(now()); }
  else { if (SUBS.includes(status)) { where.push('u.subscription_status = ?'); params.push(status); } if (status !== 'all') where.push('u.deleted_at IS NULL'); }
  const plan = clean(req.query.plan, 20);
  if (Object.hasOwn(PLANS, plan)) { where.push('u.plan = ?'); params.push(plan); }
  const base = `FROM users u${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  const total = q.get(`SELECT COUNT(*) AS c ${base}`, ...params).c; fit(p, total);
  const rows = q.all(`SELECT u.*,
      (SELECT pr.first_name || ' ' || pr.last_name FROM profiles pr WHERE pr.user_id = u.id AND pr.is_primary = 1) AS name,
      (SELECT COUNT(*) FROM profiles pr WHERE pr.user_id = u.id) AS profiles_n,
      (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id) AS requests_n,
      (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id AND r.status = 'done') AS done_n,
      (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id AND r.status = 'action_required') AS action_required_n
    ${base} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, ...params, p.per, p.offset);
  const c = Object.fromEntries(q.all('SELECT subscription_status AS s, COUNT(*) AS n FROM users WHERE deleted_at IS NULL GROUP BY s').map((r) => [r.s, r.n]));
  res.json({
    users: rows.map((u) => ({ ...adminUser(u), name: (u.name || '').trim() || null, profiles_n: u.profiles_n, requests_n: u.requests_n, done_n: u.done_n, action_required_n: u.action_required_n })),
    ...pageMeta(total, p),
    counts: { all: q.get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').c, active: c.active || 0, past_due: c.past_due || 0, canceled: c.canceled || 0, none: c.none || 0, admin: q.get(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND deleted_at IS NULL`).c, suspended: q.get(`SELECT COUNT(*) AS c FROM users u WHERE u.deleted_at IS NULL AND ${SUSPENDED_SQL}`, now()).c, deleted: q.get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NOT NULL').c },
  });
});
admin.get('/users/:id', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return bad(res, 'Compte introuvable.', 404);
  const profiles = q.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', u.id).map(parseProfile).map((pr) => ({ ...pr, requests: statusCounts(q.all('SELECT status, COUNT(*) AS n FROM requests WHERE profile_id = ? GROUP BY status', pr.id)) }));
  res.json({
    user: adminUser(u),
    profiles,
    requests_by_status: statusCounts(q.all('SELECT status, COUNT(*) AS n FROM requests WHERE user_id = ? GROUP BY status', u.id)),
    requests: q.all(`SELECT r.id, r.token, r.status, r.cycle, r.created_at, r.sent_at, r.due_at, r.completed_at, r.note, b.name AS broker, (p.first_name || ' ' || p.last_name) AS profile FROM requests r JOIN brokers b ON b.id = r.broker_id JOIN profiles p ON p.id = r.profile_id WHERE r.user_id = ? ORDER BY CASE r.status WHEN 'action_required' THEN 0 WHEN 'refused' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 60`, u.id).map((r) => ({ ...r, ref: ref(r) })),
    events: q.all('SELECT id, type, message, request_id, profile_id, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 30', u.id),
    sessions_n: q.get('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?', u.id, now()).c,
    sessions: sessionsOf(u.id, req.sessionId),
    notes: q.all('SELECT n.id, n.body, n.created_at, a.email AS admin_email FROM admin_notes n LEFT JOIN users a ON a.id = n.admin_id WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 100', u.id),
    mails_n: q.get('SELECT COUNT(*) AS c FROM mails WHERE user_id = ?', u.id).c,
    audit: q.all('SELECT a.id, a.action, a.details, a.created_at, ad.email AS admin_email FROM admin_audit a LEFT JOIN users ad ON ad.id = a.admin_id WHERE a.target = ? ORDER BY a.id DESC LIMIT 20', u.id).map((a) => ({ ...a, details: JSON.parse(a.details || '{}') })),
    keys: keysOfUser(u.id),   // clés d’activation utilisées (indice seulement)
  });
});
admin.post('/users/:id/role', (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  const role = String(req.body.role || '');
  if (!['user', 'admin'].includes(role)) return bad(res, 'Rôle inconnu (user ou admin).');
  if (u.id === req.user.id) return bad(res, 'Vous ne pouvez pas modifier votre propre rôle.');
  if (role === 'user' && u.role === 'admin' && q.get(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND deleted_at IS NULL`).c <= 1) return bad(res, 'Il doit rester au moins un administrateur.');
  q.run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
  audit(req, 'user.role', u.id, { from: u.role, to: role });
  res.json({ user: adminUser(q.get('SELECT * FROM users WHERE id = ?', u.id)) });
});
admin.post('/users/:id/subscription', wrap(async (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  const b = req.body, status = String(b.status || '');
  if (!SUBS.includes(status)) return bad(res, 'Statut inconnu (none, active, past_due ou canceled).');
  let plan = u.plan, billing = u.billing, ends = u.subscription_ends_at;
  if (b.plan != null && b.plan !== '') { if (!Object.hasOwn(PLANS, b.plan)) return bad(res, 'Offre inconnue.'); plan = b.plan; }
  if (b.billing != null && b.billing !== '') { if (!['monthly', 'annual'].includes(b.billing)) return bad(res, 'Périodicité inconnue (monthly ou annual).'); billing = b.billing; }
  if (b.ends_at !== undefined) { if (b.ends_at === null || b.ends_at === '') ends = null; else { ends = isoDate(b.ends_at); if (!ends) return bad(res, 'Date de fin invalide.'); } }
  // Abonnement offert par clé : il reste « par clé » tant qu’une date de fin est donnée (le formulaire la pré-remplit ;
  // même jour = heure conservée) ; sans date, il devient un abonnement sans limite activé par l’équipe.
  if (u.billing_mode === 'key' && ends && u.subscription_ends_at && String(b.ends_at ?? '').slice(0, 10) === u.subscription_ends_at.slice(0, 10)) ends = u.subscription_ends_at;
  const keyed = status === 'active' && u.billing_mode === 'key' && !!ends;
  if (keyed && ends <= now()) return bad(res, 'La date de fin d’un abonnement offert par clé doit être dans le futur (videz-la pour un abonnement sans limite).');
  if (status === 'active') { if (!plan) return bad(res, 'Choisissez une offre pour activer l’abonnement.'); billing = keyed ? null : billing || 'monthly'; if (!keyed) ends = null; }
  if (status === 'none') ends = null;
  // Un abonnement payé par Stripe se résilie chez Stripe (sinon les prélèvements continueraient) ; fin = fin de période.
  let viaStripe = false;
  if (status === 'canceled' && u.billing_mode === 'stripe' && u.stripe_subscription_id && u.subscription_status !== 'canceled') {
    try { ends = (await cancelSubscription(u)).ends_at; viaStripe = true; }
    catch (e) { console.error(`[admin] résiliation Stripe impossible (${req.id}) :`, e.message); return bad(res, 'Stripe n’a pas confirmé la résiliation : rien n’a été modifié. Réessayez dans quelques instants.', 502); }
  }
  const mode = status === 'active' ? (u.billing_mode === 'stripe' ? 'stripe' : keyed ? 'key' : 'manual') : u.billing_mode;
  q.run('UPDATE users SET subscription_status = ?, plan = ?, billing = ?, subscription_ends_at = ?, billing_mode = ? WHERE id = ?', status, plan, billing, ends, mode, u.id);
  const fmt = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const msg = keyed ? `Abonnement ${PLANS[plan].name} offert par clé, jusqu’au ${fmt(ends)} (modifié par l’équipe Oubli).`
    : status === 'active' ? `Abonnement ${PLANS[plan].name} (${billing === 'annual' ? 'annuel' : 'mensuel'}) activé par l’équipe Oubli.`
    : status === 'canceled' ? `Abonnement résilié par l’équipe Oubli${ends ? ` ; accès maintenu jusqu’au ${fmt(ends)}` : ''}.`
    : status === 'past_due' ? 'Abonnement marqué « paiement en attente » par l’équipe Oubli.' : 'Abonnement retiré par l’équipe Oubli.';
  if (!viaStripe) logEvent(u.id, 'billing', msg);
  audit(req, 'user.subscription', u.id, { from: { status: u.subscription_status, plan: u.plan, billing: u.billing, ends_at: u.subscription_ends_at }, to: { status, plan, billing, ends_at: ends }, stripe: viaStripe || undefined, note: clean(b.note, 200) || undefined });
  // Abonnement (de nouveau) en cours : les courtiers ajoutés au registre entre-temps reçoivent leur demande.
  if (status === 'active' || status === 'canceled') { scheduler.requestFullScan(); setTimeout(() => tick(), 10); }
  res.json({ user: adminUser(q.get('SELECT * FROM users WHERE id = ?', u.id)) });
}));
admin.post('/users/:id/logout-all', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return bad(res, 'Compte introuvable.', 404);
  const r = u.id === req.user.id ? q.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, req.sessionId || '') : q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  audit(req, 'user.logout_all', u.id, { sessions: Number(r.changes) });
  res.json({ ok: true, sessions: Number(r.changes) });
});
admin.post('/users/:id/launch', wrap(async (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  let created = 0, reason = null;
  for (const pr of q.all('SELECT * FROM profiles WHERE user_id = ?', u.id)) { const r = launchProfile(u, pr); created += r.created; reason = reason || r.reason || null; }
  audit(req, 'user.launch', u.id, { created, reason });
  if (!created && reason) return bad(res, reason);
  setTimeout(() => tick(), 10);
  res.json({ created });
}));
/* ---------- Suspension, accès support, sessions, notes, message, adresse, export ---------- */
admin.post('/users/:id/suspend', (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  if (u.id === req.user.id) return bad(res, 'Vous ne pouvez pas suspendre votre propre compte.');
  if (u.role === 'admin') return bad(res, 'Retirez d’abord le rôle administrateur de ce compte.');
  const reason = clean(req.body.reason, 300);
  if (reason.length < 3) return bad(res, 'Indiquez le motif de la suspension (il est journalisé).');
  let until = null;
  if (req.body.until) { until = endOfDay(req.body.until); if (!until || until <= now()) return bad(res, 'La date de fin de suspension doit être dans le futur.'); }
  q.run('UPDATE users SET suspended_at = ?, suspended_until = ?, suspended_reason = ? WHERE id = ?', now(), until, reason, u.id);
  const sessions = Number(q.run('DELETE FROM sessions WHERE user_id = ?', u.id).changes || 0);
  const blocked = req.body.block_email === true && !!q.run('INSERT OR IGNORE INTO blocked_emails (pattern, reason, created_by, created_at) VALUES (?, ?, ?, ?)', u.email.toLowerCase(), `Suspension : ${reason}`, req.user.id, now()).changes;
  logEvent(u.id, 'account', `Compte suspendu par l’équipe Oubli${until ? ` jusqu’au ${fmtDay(until)}` : ''} : aucune demande ne part pendant la suspension.`);
  audit(req, 'user.suspend', u.id, { reason, until: until || undefined, sessions, blocked: blocked || undefined });
  res.json({ user: adminUser(q.get('SELECT * FROM users WHERE id = ?', u.id)), sessions });
});
admin.post('/users/:id/unsuspend', (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  if (!u.suspended_at) return bad(res, 'Ce compte n’est pas suspendu.');
  q.run('UPDATE users SET suspended_at = NULL, suspended_until = NULL, suspended_reason = NULL WHERE id = ?', u.id);
  logEvent(u.id, 'account', 'Compte réactivé par l’équipe Oubli : les demandes reprennent.');
  audit(req, 'user.unsuspend', u.id, { was: u.suspended_reason });
  scheduler.requestFullScan(); setTimeout(() => tick(), 10);   // courtiers ajoutés au registre pendant la suspension
  res.json({ user: adminUser(q.get('SELECT * FROM users WHERE id = ?', u.id)) });
});
// Accès au compte : lecture seule (index.js), 30 minutes, motif obligatoire, jamais sur un autre administrateur.
admin.post('/users/:id/impersonate', (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  if (u.id === req.user.id) return bad(res, 'C’est votre propre compte.');
  if (u.role === 'admin') return bad(res, 'L’accès au compte d’un autre administrateur n’est pas autorisé.');
  const reason = clean(req.body.reason, 200);
  if (reason.length < 3) return bad(res, 'Indiquez le motif de l’accès (il est journalisé et visible par l’abonné).');
  const s = startImpersonation(res, u, req);
  audit(req, 'user.impersonate', u.id, { reason, minutes: SUPPORT_MINUTES });
  logEvent(u.id, 'account', 'Accès support : un membre de l’équipe Oubli a consulté votre dossier, en lecture seule.');
  res.json({ ok: true, expires_at: s.expires_at });
});
admin.delete('/users/:id/sessions/:handle', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return bad(res, 'Compte introuvable.', 404);
  const s = q.all('SELECT id FROM sessions WHERE user_id = ?', u.id).find((x) => handleOf(x.id) === req.params.handle);
  if (!s) return bad(res, 'Session introuvable ou déjà fermée.', 404);
  if (s.id === req.sessionId) return bad(res, 'Pour fermer votre session en cours, déconnectez-vous.');
  q.run('DELETE FROM sessions WHERE id = ?', s.id);
  audit(req, 'user.session_revoke', u.id, {});
  res.json({ ok: true });
});
admin.post('/users/:id/notes', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return bad(res, 'Compte introuvable.', 404);
  const body = clean(req.body.body, 2000);
  if (!body) return bad(res, 'La note est vide.');
  const id = Number(q.run('INSERT INTO admin_notes (user_id, admin_id, body, created_at) VALUES (?, ?, ?, ?)', u.id, req.user.id, body, now()).lastInsertRowid);
  audit(req, 'user.note', u.id, { note_id: id });
  res.status(201).json({ note: q.get('SELECT n.id, n.body, n.created_at, a.email AS admin_email FROM admin_notes n LEFT JOIN users a ON a.id = n.admin_id WHERE n.id = ?', id) });
});
admin.delete('/notes/:id', (req, res) => {
  if (!INT.test(req.params.id)) return bad(res, 'Note introuvable.', 404);
  const n = q.get('SELECT * FROM admin_notes WHERE id = ?', Number(req.params.id));
  if (!n) return bad(res, 'Note introuvable.', 404);
  q.run('DELETE FROM admin_notes WHERE id = ?', n.id);
  audit(req, 'note.delete', n.user_id, { note_id: n.id });
  res.json({ ok: true });
});
admin.post('/users/:id/message', wrap(async (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  const subject = clean(req.body.subject, 160), body = String(req.body.body ?? '').trim().slice(0, 5000);
  if (subject.length < 3) return bad(res, 'Objet trop court.');
  if (body.length < 5) return bad(res, 'Message trop court.');
  try {
    const r = await sendMail({ to: u.email, subject, text: `${body}\n\n— L’équipe Oubli`, user_id: u.id });
    audit(req, 'user.message', u.id, { subject, mode: r.mode });
    res.json({ ok: true, mode: r.mode });
  } catch (e) { console.error(`[admin] message non envoyé (${req.id}) :`, e.message); bad(res, 'Le message n’a pas pu être envoyé.', 502); }
}));
admin.post('/users/:id/email', wrap(async (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  const email = clean(req.body.email, 160).toLowerCase();
  if (!EMAIL.test(email)) return bad(res, 'Adresse e-mail invalide.');
  if (email === u.email) return bad(res, 'C’est déjà l’adresse du compte.');
  if (isBlockedEmail(email)) return bad(res, 'Cette adresse est dans la liste de blocage.');
  if (q.get('SELECT id FROM users WHERE email = ?', email)) return bad(res, 'Un compte existe déjà avec cette adresse.', 409);
  q.run('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?', email, u.id);   // nouvelle adresse : pas encore prouvée
  logEvent(u.id, 'account', `Adresse de connexion remplacée par ${email} par l’équipe Oubli.`);
  audit(req, 'user.email', u.id, { from: u.email, to: email });
  // L'ancienne adresse est prévenue : c'est la seule défense si le changement n'a pas été demandé par l'abonné.
  sendMail({ to: u.email, subject: 'Votre adresse de connexion Oubli a été modifiée', text: `Bonjour,\n\nÀ votre demande, l’adresse de connexion de votre compte Oubli est désormais ${email}.\nSi vous n’êtes pas à l’origine de ce changement, répondez immédiatement à ce message.\n\n— L’équipe Oubli`, user_id: u.id }).catch(() => {});
  res.json({ user: adminUser(q.get('SELECT * FROM users WHERE id = ?', u.id)) });
}));
admin.get('/users/:id/export', (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.deleted_at) return bad(res, 'Compte introuvable.', 404);
  audit(req, 'user.export', u.id, {});
  res.setHeader('Content-Disposition', `attachment; filename="oubli-export-${u.id.slice(0, 8)}.json"`);
  res.json(exportData(u));
});

admin.delete('/users/:id', wrap(async (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return bad(res, 'Compte introuvable.', 404);
  if (u.id === req.user.id) return bad(res, 'Supprimez votre propre compte depuis vos paramètres, pas depuis l’administration.');
  if (u.deleted_at) return bad(res, 'Ce compte est déjà supprimé.');
  if (u.role === 'admin' && q.get(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND deleted_at IS NULL`).c <= 1) return bad(res, 'Il doit rester au moins un administrateur.');
  // Comme la suppression par l'abonné : abonnement actif ou impayé résilié d'abord, rien n'est supprimé si Stripe échoue.
  if (['active', 'past_due'].includes(u.subscription_status)) {
    try { await cancelSubscription(u); }
    catch (e) { console.error(`[admin] résiliation Stripe impossible à la suppression (${req.id}) :`, e.message); return bad(res, 'Stripe n’a pas confirmé la résiliation : le compte n’a pas été supprimé. Réessayez dans quelques instants.', 502); }
  }
  db.exec('BEGIN');
  try {
    q.run('DELETE FROM requests WHERE user_id = ?', u.id); q.run('DELETE FROM profiles WHERE user_id = ?', u.id); q.run('DELETE FROM events WHERE user_id = ?', u.id);
    q.run('DELETE FROM mails WHERE user_id = ?', u.id); q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    q.run(`UPDATE users SET email = ?, password_hash = '', role = 'user', deleted_at = ?, mandate_name = NULL, mandate_ip = NULL, stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = ?`, `deleted-${u.id}@oubli.invalid`, now(), u.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(req, 'user.delete', u.id, { reason: clean(req.body.reason, 200) || undefined });
  res.json({ ok: true });
}));

/* ---------- Demandes ---------- */
const REQ_BASE = 'FROM requests r JOIN brokers b ON b.id = r.broker_id JOIN users u ON u.id = r.user_id JOIN profiles p ON p.id = r.profile_id';
const REQ_COLS = `r.id, r.token, r.status, r.cycle, r.created_at, r.sent_at, r.due_at, r.followup_sent_at, r.completed_at, r.next_check_at, r.note, r.review_at, r.review_outcome, r.review_from, b.id AS broker_id, b.name AS broker, b.slug AS broker_slug, b.legal_basis, u.id AS user_id, u.email, p.id AS profile_id, (p.first_name || ' ' || p.last_name) AS profile`;
const SORTS = {
  created_desc: 'r.created_at DESC', created_asc: 'r.created_at ASC', sent_desc: 'r.sent_at DESC NULLS LAST', due_asc: 'r.due_at ASC NULLS LAST',
  status: `CASE r.status WHEN 'error' THEN 0 WHEN 'action_required' THEN 1 WHEN 'refused' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'sent' THEN 4 WHEN 'queued' THEN 5 ELSE 6 END, r.created_at DESC`,
  broker: 'b.name ASC, r.created_at DESC', user: 'u.email ASC, r.created_at DESC', review: 'r.review_at DESC NULLS LAST, r.created_at DESC',
};
admin.get('/requests', (req, res) => {
  const p = paging(req.query);
  const where = [], params = [];
  const status = clean(req.query.status, 20);
  if (status === 'open') where.push(`r.status IN ('queued', 'sent', 'in_progress', 'action_required')`);
  else if (status === 'review') where.push('r.review_at IS NOT NULL');   // réponses entrantes à vérifier (expéditeur non reconnu)
  else if (STATUSES.includes(status)) { where.push('r.status = ?'); params.push(status); }
  const broker = clean(req.query.broker, 60);
  if (INT.test(broker)) { where.push('b.id = ?'); params.push(Number(broker)); } else if (SLUG.test(broker)) { where.push('b.slug = ?'); params.push(broker); }
  if (UUID.test(String(req.query.user || ''))) { where.push('r.user_id = ?'); params.push(req.query.user); }
  if (UUID.test(String(req.query.profile || ''))) { where.push('r.profile_id = ?'); params.push(req.query.profile); }
  const search = clean(req.query.q, 120);
  if (search) { const l = like(search.replace(/^OUBLI-/i, '')); where.push(`(r.token LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\' OR (p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\')`); params.push(l, l, l, l); }
  const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'created_desc';
  const base = `${REQ_BASE}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  const total = q.get(`SELECT COUNT(*) AS c ${base}`, ...params).c; fit(p, total);
  const rows = q.all(`SELECT ${REQ_COLS} ${base} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`, ...params, p.per, p.offset);
  res.json({ requests: rows.map((r) => ({ ...r, ref: ref(r) })), ...pageMeta(total, p), sort, counts: { ...statusCounts(q.all('SELECT status, COUNT(*) AS n FROM requests GROUP BY status')), review: reviewCount() } });
});
admin.get('/requests/:id', (req, res) => {
  const r = getRequest(req.params.id);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  const row = q.get(`SELECT ${REQ_COLS} ${REQ_BASE} WHERE r.id = ?`, r.id) || { ...r, ref: ref(r) };
  const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
  res.json({
    request: { ...row, ref: ref(r) },
    broker: broker ? { id: broker.id, slug: broker.slug, name: broker.name, domain: broker.domain, category: broker.category, jurisdiction: broker.jurisdiction, legal_basis: broker.legal_basis, contact_email: broker.contact_email, contact_verified: broker.contact_verified, active: broker.active, recheck_days: broker.recheck_days } : null,
    mails: q.all('SELECT id, to_addr, subject, body, mode, message_id, created_at FROM mails WHERE request_id = ? ORDER BY id', r.id),
    events: q.all('SELECT id, type, message, created_at FROM events WHERE request_id = ? ORDER BY id DESC LIMIT 50', r.id),
    audit: q.all('SELECT a.id, a.action, a.details, a.created_at, ad.email AS admin_email FROM admin_audit a LEFT JOIN users ad ON ad.id = a.admin_id WHERE a.target = ? ORDER BY a.id DESC LIMIT 20', r.id).map((a) => ({ ...a, details: JSON.parse(a.details || '{}') })),
  });
});
admin.post('/requests/:id/outcome', wrap(async (req, res) => {
  const r = getRequest(req.params.id);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  const outcome = String(req.body.outcome || '');
  if (!OUTCOMES.includes(outcome)) return bad(res, 'Résultat inconnu.');
  const note = clean(req.body.note, 300);
  const out = await applyOutcome(r, outcome, note);
  if (out?.error) return bad(res, out.error, 409);
  const reviewed = clearReview(r.id);   // décision de l'équipe : la réponse à vérifier est traitée
  audit(req, 'request.outcome', r.id, { token: r.token, from: r.status, to: outcome, note: note || undefined, reviewed: reviewed || undefined });
  res.json({ ok: true, request: { id: r.id, token: r.token, status: q.get('SELECT status FROM requests WHERE id = ?', r.id).status } });
}));
admin.post('/requests/:id/resend', (req, res) => {
  const r = getRequest(req.params.id);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  // Courtier désactivé : la demande resterait « à envoyer » (puis serait de nouveau arrêtée par le planificateur).
  if (!q.get('SELECT active FROM brokers WHERE id = ?', r.broker_id)?.active) return bad(res, 'Ce courtier est désactivé : réactivez-le avant de renvoyer la demande.');
  // Nouvel envoi immédiat : compteur d'échecs et recul remis à zéro (sinon une demande en erreur y retombe au premier
  // échec, et une demande en recul attend la fin du délai).
  q.run(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL, followup_sent_at = NULL, completed_at = NULL, next_check_at = NULL, attempts = 0, next_attempt_at = NULL, last_error = NULL, note = ? WHERE id = ?`, 'Nouvel envoi demandé par l’équipe Oubli.', r.id);
  logEvent(r.user_id, 'queued', `Nouvel envoi programmé vers ${q.get('SELECT name FROM brokers WHERE id = ?', r.broker_id)?.name || 'le courtier'} (cycle ${r.cycle}).`, { profile_id: r.profile_id, request_id: r.id });
  clearReview(r.id);
  audit(req, 'request.resend', r.id, { token: r.token, from: r.status });
  setTimeout(() => tick(), 10);
  res.json({ ok: true, request: { id: r.id, token: r.token, status: 'queued' } });
});
admin.post('/requests/bulk', wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  if (!ids || !ids.length) return bad(res, 'Sélectionnez au moins une demande.');
  if (ids.length > PAGE_MAX) return bad(res, `Au plus ${PAGE_MAX} demandes à la fois.`);
  const outcome = String(req.body.outcome || '');
  if (!OUTCOMES.includes(outcome)) return bad(res, 'Résultat inconnu.');
  const note = clean(req.body.note, 300);
  let updated = 0; const missing = [], ignored = [];
  for (const id of ids) {
    const r = getRequest(id);
    if (!r) { missing.push(String(id).slice(0, 40)); continue; }
    const out = await applyOutcome(r, outcome, note);
    if (out?.error) { ignored.push(ref(r)); continue; }   // demande close ou jamais envoyée : réponse sans objet
    clearReview(r.id);
    updated += 1;
  }
  audit(req, 'request.bulk', null, { outcome, updated, missing: missing.length, ignored: ignored.length || undefined, note: note || undefined });
  res.json({ ok: true, updated, missing, ignored });
}));
// Réponse à vérifier jugée sans suite (message sans rapport, doublon) : le signalement est levé, la demande reste en l'état.
admin.delete('/requests/:id/review', (req, res) => {
  const r = getRequest(req.params.id);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  if (!clearReview(r.id)) return bad(res, 'Cette demande n’a pas de réponse à vérifier.');
  audit(req, 'request.review_dismiss', r.id, { token: r.token, outcome: r.review_outcome, sender: r.review_from || undefined });
  res.json({ ok: true, request: { id: r.id, token: r.token, status: r.status } });
});

/* ---------- Courtiers ---------- */
const BROKER_STATS = `(SELECT COUNT(*) FROM requests r WHERE r.broker_id = b.id AND r.sent_at IS NOT NULL) AS sent,
  (SELECT COUNT(*) FROM requests r WHERE r.broker_id = b.id AND r.status = 'done') AS done,
  (SELECT COUNT(*) FROM requests r WHERE r.broker_id = b.id AND r.status = 'refused' AND COALESCE(r.note, '') NOT LIKE 'Mandat révoqué%' AND COALESCE(r.note, '') NOT LIKE 'Courtier retiré%') AS refused,
  (SELECT COUNT(*) FROM requests r WHERE r.broker_id = b.id AND r.status = 'action_required') AS action_required,
  (SELECT COUNT(*) FROM requests r WHERE r.broker_id = b.id AND r.status IN ('sent', 'in_progress')) AS pending,
  (SELECT ROUND(AVG(julianday(r.completed_at) - julianday(r.sent_at)), 1) FROM requests r WHERE r.broker_id = b.id AND r.status = 'done' AND r.sent_at IS NOT NULL AND r.completed_at IS NOT NULL) AS avg_days_to_done`;
const brokerRow = (id) => q.get(`SELECT b.*, ${BROKER_STATS} FROM brokers b WHERE b.id = ?`, id);
function brokerInput(body, cur) {
  const v = {};
  const has = (k) => body[k] !== undefined;
  if (!cur || has('slug')) { v.slug = clean(body.slug, 60).toLowerCase(); if (!SLUG.test(v.slug)) return { error: 'Identifiant (slug) invalide : minuscules, chiffres et tirets.' }; }
  if (!cur || has('name')) { v.name = clean(body.name, 120); if (v.name.length < 2) return { error: 'Nom trop court.' }; }
  if (!cur || has('domain')) { v.domain = clean(body.domain, 120).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!DOMAIN.test(v.domain)) return { error: 'Domaine invalide.' }; }
  if (!cur || has('category')) { v.category = clean(body.category, 60); if (v.category.length < 2) return { error: 'Catégorie manquante.' }; }
  if (!cur || has('jurisdiction')) { v.jurisdiction = clean(body.jurisdiction, 2).toUpperCase(); if (!JURISDICTIONS.includes(v.jurisdiction)) return { error: `Juridiction inconnue (${JURISDICTIONS.join(', ')}).` }; }
  if (!cur || has('legal_basis')) { v.legal_basis = clean(body.legal_basis, 5).toLowerCase(); if (!BASES.includes(v.legal_basis)) return { error: 'Base légale inconnue (rgpd, ccpa ou both).' }; }
  if (!cur || has('sensitivity')) { v.sensitivity = int(body.sensitivity, cur ? cur.sensitivity : 2); if (v.sensitivity < 1 || v.sensitivity > 3) return { error: 'Sensibilité entre 1 et 3.' }; }
  if (!cur || has('recheck_days')) { v.recheck_days = int(body.recheck_days, cur ? cur.recheck_days : 60); if (v.recheck_days < 7 || v.recheck_days > 365) return { error: 'Revérification entre 7 et 365 jours.' }; }
  if (!cur || has('contact_email')) { v.contact_email = clean(body.contact_email, 160).toLowerCase(); if (!EMAIL.test(v.contact_email)) return { error: 'Adresse de contact invalide.' }; }
  if (!cur || has('contact_verified')) v.contact_verified = body.contact_verified === true || body.contact_verified === 1 || body.contact_verified === 'true' || body.contact_verified === '1' ? 1 : 0;
  if (!cur || has('active')) v.active = body.active === false || body.active === 0 || body.active === 'false' || body.active === '0' ? 0 : 1;
  return { values: v };
}
admin.get('/brokers', (_req, res) => {
  const brokers = q.all(`SELECT b.*, ${BROKER_STATS} FROM brokers b ORDER BY b.active DESC, b.name`);
  res.json({ brokers, categories: [...new Set(brokers.map((b) => b.category))].sort((a, b) => a.localeCompare(b, 'fr')), jurisdictions: JURISDICTIONS, legal_bases: BASES, total: brokers.length, active: brokers.filter((b) => b.active).length, verified: brokers.filter((b) => b.active && b.contact_verified).length });
});
admin.post('/brokers', (req, res) => {
  const { values: v, error } = brokerInput(req.body, null);
  if (error) return bad(res, error);
  if (q.get('SELECT id FROM brokers WHERE slug = ?', v.slug)) return bad(res, 'Cet identifiant (slug) existe déjà.', 409);
  const r = q.run('INSERT INTO brokers (slug, name, domain, category, jurisdiction, legal_basis, contact_email, contact_verified, sensitivity, recheck_days, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', v.slug, v.name, v.domain, v.category, v.jurisdiction, v.legal_basis, v.contact_email, v.contact_verified, v.sensitivity, v.recheck_days, v.active);
  const id = Number(r.lastInsertRowid);
  audit(req, 'broker.create', id, { slug: v.slug, name: v.name });
  res.status(201).json({ broker: brokerRow(id) });
});
admin.put('/brokers/:id', (req, res) => {
  const b = getBroker(req.params.id);
  if (!b) return bad(res, 'Courtier introuvable.', 404);
  const { values: v, error } = brokerInput(req.body, b);
  if (error) return bad(res, error);
  if (v.slug && v.slug !== b.slug && q.get('SELECT id FROM brokers WHERE slug = ? AND id <> ?', v.slug, b.id)) return bad(res, 'Cet identifiant (slug) existe déjà.', 409);
  // Un contact modifié redevient « non vérifié » sauf confirmation explicite dans la même requête ; pour un site ajouté
  // par un abonné, l'adresse saisie par l'équipe prime ensuite sur la recherche automatique.
  if (v.contact_email && v.contact_email !== b.contact_email && req.body.contact_verified === undefined) v.contact_verified = 0;
  if (b.custom && v.contact_email && v.contact_email !== b.contact_email) { v.contact_source = 'admin'; v.discovery_status = b.discovery_status === 'pending' ? 'found' : b.discovery_status; }
  const keys = Object.keys(v);
  if (!keys.length) return bad(res, 'Rien à modifier.');
  q.run(`UPDATE brokers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => v[k]), b.id);
  const changes = Object.fromEntries(keys.filter((k) => v[k] !== b[k]).map((k) => [k, { from: b[k], to: v[k] }]));
  // Case « Actif » décochée : comme la désactivation. Recochée : les demandes arrêtées repartent dans un nouveau cycle
  // (recherche complète au prochain passage, lancé tout de suite), comme après une nouvelle signature du mandat.
  const stopped = v.active === 0 && b.active ? scheduler.stopRemovedBrokerRequests(b.id) : undefined;
  if (v.active === 1 && !b.active) { scheduler.requestFullScan(); setTimeout(() => tick(), 10); }
  audit(req, 'broker.update', b.id, { slug: b.slug, changes, stopped });
  res.json({ broker: brokerRow(b.id), ...(stopped === undefined ? {} : { stopped }) });
});
// Désactivation : plus aucune nouvelle demande, et les demandes jamais envoyées (en file ou en erreur) sont arrêtées.
admin.delete('/brokers/:id', (req, res) => {
  const b = getBroker(req.params.id);
  if (!b) return bad(res, 'Courtier introuvable.', 404);
  q.run('UPDATE brokers SET active = 0 WHERE id = ?', b.id);
  const stopped = scheduler.stopRemovedBrokerRequests(b.id);
  audit(req, 'broker.deactivate', b.id, { slug: b.slug, stopped });
  res.json({ ok: true, broker: brokerRow(b.id), stopped });
});
// Relance la recherche du contact d'un site ajouté par un abonné (la réponse attend la fin de la recherche).
admin.post('/brokers/:id/discover', wrap(async (req, res) => {
  const b = getBroker(req.params.id);
  if (!b || !b.custom) return bad(res, 'Recherche possible seulement pour un site ajouté par un abonné.', 404);
  const r = await runDiscovery(b.id, { force: true });
  audit(req, 'broker.discover', b.id, { slug: b.slug, found: r?.email || undefined });
  res.json({ broker: brokerRow(b.id), found: r?.email || null, pages: r?.pages || 0 });
}));
admin.post('/brokers/:id/test-mail', wrap(async (req, res) => {
  const b = getBroker(req.params.id);
  if (!b) return bad(res, 'Courtier introuvable.', 404);
  const code = `OUBLI-TEST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const subject = `Vérification de l’adresse de contact — ${b.name} [${code}]`;
  const text = `Bonjour,

Ce message vérifie que l’adresse ${b.contact_email} reçoit bien les demandes d’effacement adressées à ${b.name}. Aucune action n’est requise ; un simple accusé de réception nous aidera à confirmer ce contact.

— This is a test message from Oubli, an authorized agent handling data-erasure requests. No action is required; a short acknowledgement helps us confirm this contact address.

Référence : ${code}`;
  const r = await sendMail({ to: b.contact_email, subject, text, headers: { 'X-Oubli-Ref': code } });
  audit(req, 'broker.test_mail', b.id, { slug: b.slug, to: b.contact_email, mode: r.mode, ref: code });
  res.json({ ok: true, to: b.contact_email, mode: r.mode, message_id: r.messageId, ref: code });
}));

/* ---------- Courrier sortant ---------- */
admin.get('/mails', (req, res) => {
  const p = paging(req.query);
  const where = [], params = [];
  const search = clean(req.query.q, 120);
  if (search) { const l = like(search.replace(/^OUBLI-/i, '')); where.push(`(m.to_addr LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR r.token LIKE ? ESCAPE '\\')`); params.push(l, l, l, l); }
  if (['smtp', 'outbox'].includes(req.query.mode)) { where.push('m.mode = ?'); params.push(req.query.mode); }
  if (UUID.test(String(req.query.request || ''))) { where.push('m.request_id = ?'); params.push(req.query.request); }
  if (UUID.test(String(req.query.user || ''))) { where.push('m.user_id = ?'); params.push(req.query.user); }
  const base = `FROM mails m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN requests r ON r.id = m.request_id${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  const total = q.get(`SELECT COUNT(*) AS c ${base}`, ...params).c; fit(p, total);
  const rows = q.all(`SELECT m.id, m.to_addr, m.subject, m.mode, m.created_at, m.request_id, m.user_id, r.token, u.email AS user_email, length(m.body) AS size ${base} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...params, p.per, p.offset);
  res.json({ mails: rows.map((m) => ({ ...m, ref: m.token ? `OUBLI-${m.token}` : null })), ...pageMeta(total, p), modes: Object.fromEntries(q.all('SELECT mode, COUNT(*) AS n FROM mails GROUP BY mode').map((r) => [r.mode, r.n])) });
});
admin.get('/mails/:id', (req, res) => {
  if (!INT.test(req.params.id)) return bad(res, 'Courrier introuvable.', 404);
  const m = q.get('SELECT m.*, r.token, u.email AS user_email FROM mails m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN requests r ON r.id = m.request_id WHERE m.id = ?', Number(req.params.id));
  if (!m) return bad(res, 'Courrier introuvable.', 404);
  res.json({ mail: { ...m, ref: m.token ? `OUBLI-${m.token}` : null } });
});

/* ---------- Courrier entrant (classification manuelle) ---------- */
admin.post('/inbound/simulate', (req, res) => {
  const text = `${clean(req.body.subject, 300)}\n${clean(req.body.text, 20000)}`;
  let token = clean(req.body.token, 24).toUpperCase().replace(/^OUBLI-/, '');
  if (!token) { const m = text.match(/OUBLI-([A-F0-9]{10})/i); token = m ? m[1].toUpperCase() : ''; }
  if (!TOKEN.test(token)) return res.json({ matched: false, reason: 'Aucune référence OUBLI-… reconnue dans le texte.' });
  const r = q.get(`SELECT ${REQ_COLS} ${REQ_BASE} WHERE r.token = ?`, token);
  if (!r) return res.json({ matched: false, token, reason: `Référence OUBLI-${token} inconnue.` });
  res.json({ matched: true, token, outcome: classifyReply(text), request: { ...r, ref: ref(r) } });
});

/* ---------- Prospects : newsletter, contacts, exports ---------- */
admin.get('/newsletter', (req, res) => {
  const p = paging(req.query, 50);
  const total = q.get('SELECT COUNT(*) AS c FROM newsletter').c; fit(p, total);
  res.json({ subscribers: q.all('SELECT email, created_at FROM newsletter ORDER BY created_at DESC LIMIT ? OFFSET ?', p.per, p.offset), ...pageMeta(total, p) });
});
admin.get('/contacts', (req, res) => {
  const p = paging(req.query);
  const status = clean(req.query.status, 10);
  const where = status === 'open' ? 'WHERE handled_at IS NULL' : status === 'handled' ? 'WHERE handled_at IS NOT NULL' : '';
  const total = q.get(`SELECT COUNT(*) AS c FROM contacts ${where}`).c; fit(p, total);
  res.json({
    contacts: q.all(`SELECT id, email, subject, message, created_at, handled_at FROM contacts ${where} ORDER BY (handled_at IS NOT NULL), id DESC LIMIT ? OFFSET ?`, p.per, p.offset),
    ...pageMeta(total, p),
    counts: { open: q.get('SELECT COUNT(*) AS c FROM contacts WHERE handled_at IS NULL').c, handled: q.get('SELECT COUNT(*) AS c FROM contacts WHERE handled_at IS NOT NULL').c },
  });
});
admin.post('/contacts/:id/handled', (req, res) => {
  if (!INT.test(req.params.id)) return bad(res, 'Message introuvable.', 404);
  const c = q.get('SELECT * FROM contacts WHERE id = ?', Number(req.params.id));
  if (!c) return bad(res, 'Message introuvable.', 404);
  const handled = req.body.handled === false ? null : now();
  q.run('UPDATE contacts SET handled_at = ? WHERE id = ?', handled, c.id);
  audit(req, 'contact.handled', c.id, { handled: !!handled });
  res.json({ contact: q.get('SELECT id, email, subject, message, created_at, handled_at FROM contacts WHERE id = ?', c.id) });
});
// CSV : guillemets doublés, cellules commençant par = + - @ préfixées d'une apostrophe (injection de formules). Même
// chose après une virgule ou un point-virgule : un tableur réglé sur l'autre séparateur (Excel en français découpe sur
// « ; ») ouvre là une nouvelle cellule, que les guillemets du CSV ne protègent plus.
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v).replace(/([,;])(["\s]*)(?=[=+\-@])/g, "$1$2'");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (headers, rows) => `﻿${[headers, ...rows.map((r) => headers.map((h) => r[h]))].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const EXPORTS = {
  newsletter: () => ({ headers: ['email', 'created_at'], rows: q.all('SELECT email, created_at FROM newsletter ORDER BY created_at') }),
  contacts: () => ({ headers: ['id', 'email', 'subject', 'message', 'created_at', 'handled_at'], rows: q.all('SELECT id, email, subject, message, created_at, handled_at FROM contacts ORDER BY id') }),
  users: () => ({ headers: ['id', 'email', 'role', 'plan', 'billing', 'subscription_status', 'subscription_ends_at', 'billing_mode', 'mandate_signed_at', 'mandate_revoked_at', 'created_at', 'deleted_at'], rows: q.all('SELECT id, email, role, plan, billing, subscription_status, subscription_ends_at, billing_mode, mandate_signed_at, mandate_revoked_at, created_at, deleted_at FROM users ORDER BY created_at') }),
  requests: () => ({ headers: ['ref', 'status', 'cycle', 'broker', 'broker_domain', 'legal_basis', 'user_email', 'profile', 'created_at', 'sent_at', 'due_at', 'followup_sent_at', 'completed_at', 'next_check_at', 'note'], rows: q.all(`SELECT 'OUBLI-' || r.token AS ref, r.status, r.cycle, b.name AS broker, b.domain AS broker_domain, b.legal_basis, u.email AS user_email, (p.first_name || ' ' || p.last_name) AS profile, r.created_at, r.sent_at, r.due_at, r.followup_sent_at, r.completed_at, r.next_check_at, r.note ${REQ_BASE} ORDER BY r.created_at`) }),
};
admin.get('/export.csv', (req, res) => {
  const what = String(req.query.what || '');
  if (!Object.hasOwn(EXPORTS, what)) return bad(res, 'Export inconnu (newsletter, contacts, users ou requests).');
  const { headers, rows } = EXPORTS[what]();
  audit(req, 'export.csv', what, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="oubli-${what}-${now().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(toCsv(headers, rows));
});

/* ---------- Sécurité : suspensions, liste de blocage, accès support, sessions ---------- */
admin.get('/security', (req, res) => {
  const t = now();
  res.json({
    suspended: q.all(`SELECT u.id, u.email, u.suspended_at, u.suspended_until, u.suspended_reason FROM users u WHERE u.deleted_at IS NULL AND ${SUSPENDED_SQL} ORDER BY u.suspended_at DESC LIMIT 200`, t),
    blocklist: q.all('SELECT b.id, b.pattern, b.reason, b.created_at, a.email AS created_by_email FROM blocked_emails b LEFT JOIN users a ON a.id = b.created_by ORDER BY b.id DESC LIMIT 500'),
    impersonations: q.all(`SELECT a.id, a.details, a.created_at, ad.email AS admin_email, u.email AS user_email, a.target FROM admin_audit a LEFT JOIN users ad ON ad.id = a.admin_id LEFT JOIN users u ON u.id = a.target WHERE a.action = 'user.impersonate' ORDER BY a.id DESC LIMIT 20`).map((x) => ({ ...x, details: JSON.parse(x.details || '{}') })),
    sessions: q.all(`SELECT ${SESSION_COLS}, u.email FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users a ON a.id = s.impersonator_id WHERE s.expires_at > ? ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC LIMIT 50`, t).map((x) => publicSession(x, req.sessionId)),
    sessions_total: q.get('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?', t).c,
  });
});
admin.post('/blocklist', (req, res) => {
  const pattern = clean(req.body.pattern, 160).toLowerCase();
  if (!BLOCK_PATTERN(pattern)) return bad(res, 'Saisissez une adresse (nom@domaine.fr) ou un domaine précédé de @ (@domaine.fr).');
  if (q.get('SELECT id FROM blocked_emails WHERE pattern = ?', pattern)) return bad(res, 'Cette adresse ou ce domaine est déjà bloqué.', 409);
  const id = Number(q.run('INSERT INTO blocked_emails (pattern, reason, created_by, created_at) VALUES (?, ?, ?, ?)', pattern, clean(req.body.reason, 200) || null, req.user.id, now()).lastInsertRowid);
  audit(req, 'blocklist.add', id, { pattern });
  res.status(201).json({ entry: q.get('SELECT id, pattern, reason, created_at FROM blocked_emails WHERE id = ?', id) });
});
admin.delete('/blocklist/:id', (req, res) => {
  if (!INT.test(req.params.id)) return bad(res, 'Entrée introuvable.', 404);
  const b = q.get('SELECT * FROM blocked_emails WHERE id = ?', Number(req.params.id));
  if (!b) return bad(res, 'Entrée introuvable.', 404);
  q.run('DELETE FROM blocked_emails WHERE id = ?', b.id);
  audit(req, 'blocklist.remove', b.id, { pattern: b.pattern });
  res.json({ ok: true });
});

/* ---------- Clés d’activation (abonnements offerts, voir keys.js) ---------- */
// Les clés en clair n’existent que dans la réponse de création ; ni la liste, ni l’audit, ni la base ne les contiennent
// (pas plus que leur empreinte, qui ne sort jamais de la base).
admin.post('/keys', (req, res) => {
  const r = createKeys(parseKeyBatch(req.body), req.user.id);
  audit(req, 'key.create', r.batch, { count: r.keys.length, plan: r.plan, days: r.days, max_uses: r.max_uses, expires_at: r.expires_at || undefined, note: r.note || undefined });
  res.status(201).json(r);
});
const KEY_COLS = 'k.id, k.hint, k.plan, k.days, k.max_uses, k.uses, k.expires_at, k.note, k.batch, k.created_at, k.revoked_at, c.email AS created_by_email, rv.email AS revoked_by_email';
admin.get('/keys', (req, res) => {
  const p = paging(req.query), at = now();
  const where = [], params = [];
  const status = clean(req.query.status, 20), st = Object.hasOwn(KEY_STATUS_SQL, status) ? KEY_STATUS_SQL[status] : null;
  if (st) { where.push(st.sql); if (st.dated) params.push(at); }
  const batch = clean(req.query.batch, 20).toUpperCase();
  if (/^[0-9A-F]{8}$/.test(batch)) { where.push('k.batch = ?'); params.push(batch); }
  const search = clean(req.query.q, 120).replace(/^[….\s]+/, '');   // « …K7QZ » : l’indice tel qu’il est affiché
  if (search) { const l = like(search); where.push(`(k.hint LIKE ? ESCAPE '\\' OR k.note LIKE ? ESCAPE '\\' OR k.batch LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM key_redemptions kr JOIN users u ON u.id = kr.user_id WHERE kr.key_id = k.id AND u.email LIKE ? ESCAPE '\\'))`); params.push(l, l, l, l); }
  const base = `FROM activation_keys k LEFT JOIN users c ON c.id = k.created_by LEFT JOIN users rv ON rv.id = k.revoked_by${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  const total = q.get(`SELECT COUNT(*) AS c ${base}`, ...params).c;
  const rows = q.all(`SELECT ${KEY_COLS} ${base} ORDER BY k.id DESC LIMIT ? OFFSET ?`, ...params, p.per, p.offset);
  // Comptes qui ont utilisé chaque clé : les cinq plus récents (uses donne le total).
  const used = new Map(rows.map((k) => [k.id, []]));
  if (rows.length) {
    for (const x of q.all(`SELECT * FROM (SELECT kr.key_id, kr.user_id, u.email, u.deleted_at, kr.redeemed_at, kr.ends_at, ROW_NUMBER() OVER (PARTITION BY kr.key_id ORDER BY kr.id DESC) AS rn
        FROM key_redemptions kr JOIN users u ON u.id = kr.user_id WHERE kr.key_id IN (${rows.map(() => '?').join(', ')})) WHERE rn <= 5 ORDER BY key_id, rn`, ...rows.map((k) => k.id))) {
      used.get(x.key_id).push({ user_id: x.user_id, email: x.deleted_at ? null : x.email, deleted: !!x.deleted_at, redeemed_at: x.redeemed_at, ends_at: x.ends_at });
    }
  }
  res.json({ keys: rows.map((k) => ({ ...k, status: keyStatus(k, at), redemptions: used.get(k.id) })), ...pageMeta(total, p), counts: keyCounts(at), subscriptions: keySubscriptions(at) });
});
admin.post('/keys/:id/revoke', (req, res) => {
  if (!INT.test(req.params.id)) return bad(res, 'Clé introuvable.', 404);
  const k = revokeKey(Number(req.params.id), req.user.id);
  audit(req, 'key.revoke', k.id, { hint: k.hint, batch: k.batch, uses: k.uses, max_uses: k.max_uses });
  res.json({ key: { id: k.id, hint: k.hint, uses: k.uses, max_uses: k.max_uses, revoked_at: k.revoked_at, status: keyStatus(k) } });
});

/* ---------- Annonce affichée dans l'application (bandeau) ---------- */
export function currentAnnouncement() {
  const r = q.get(`SELECT value FROM settings WHERE key = 'announcement'`);
  try { const a = r ? JSON.parse(r.value) : null; return a && a.text ? { text: String(a.text), level: a.level === 'warn' ? 'warn' : 'info' } : null; } catch { return null; }
}
admin.put('/announcement', (req, res) => {
  const text = clean(req.body.text, 280), level = req.body.level === 'warn' ? 'warn' : 'info';
  if (text.length < 3) return bad(res, 'Annonce trop courte.');
  q.run(`INSERT INTO settings (key, value, updated_at) VALUES ('announcement', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify({ text, level }), now());
  audit(req, 'settings.announcement', null, { text, level });
  res.json({ announcement: currentAnnouncement() });
});
admin.delete('/announcement', (req, res) => {
  q.run(`DELETE FROM settings WHERE key = 'announcement'`);
  audit(req, 'settings.announcement', null, { removed: true });
  res.json({ announcement: null });
});

/* ---------- Système ---------- */
admin.get('/system', (_req, res) => {
  const pages = db.prepare('PRAGMA page_count').get(), size = db.prepare('PRAGMA page_size').get();
  let outboxFiles = null; try { outboxFiles = fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).length; } catch { outboxFiles = null; }
  const present = (k) => !!(process.env[k] && String(process.env[k]).trim());
  res.json({
    node: process.version, platform: `${process.platform}-${process.arch}`, uptime_s: Math.round(process.uptime()), started_at: STARTED_AT, memory_rss_mb: Math.round(process.memoryUsage().rss / 1048576), time: now(),
    db: { bytes: (pages?.page_count || 0) * (size?.page_size || 0), wal: true },
    outbox: { dir: OUTBOX, files: outboxFiles },
    modes: { mail: mailMode, billing: billingMode, demo: DEMO, production: process.env.NODE_ENV === 'production', allow_unverified_contacts: /^(1|true|yes)$/i.test(process.env.ALLOW_UNVERIFIED_CONTACTS || '') },
    scheduler: { interval_ms: Number(process.env.SCHEDULER_INTERVAL_MS || (DEMO ? 20000 : 60000)), ...(lastTickAt() ? { last_tick_at: lastTickAt() } : {}), last_manual_tick_at: lastManualTickAt },
    counts: {
      users: q.get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').c, users_deleted: q.get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NOT NULL').c,
      admins: q.get(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND deleted_at IS NULL`).c, profiles: q.get('SELECT COUNT(*) AS c FROM profiles').c,
      requests: q.get('SELECT COUNT(*) AS c FROM requests').c, events: q.get('SELECT COUNT(*) AS c FROM events').c, mails: q.get('SELECT COUNT(*) AS c FROM mails').c,
      sessions: q.get('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?', now()).c, brokers: q.get('SELECT COUNT(*) AS c FROM brokers').c, brokers_active: q.get('SELECT COUNT(*) AS c FROM brokers WHERE active = 1').c,
      newsletter: q.get('SELECT COUNT(*) AS c FROM newsletter').c, contacts: q.get('SELECT COUNT(*) AS c FROM contacts').c, contacts_open: q.get('SELECT COUNT(*) AS c FROM contacts WHERE handled_at IS NULL').c, audit: q.get('SELECT COUNT(*) AS c FROM admin_audit').c,
    },
    announcement: currentAnnouncement(),
    backup: backupStatus(),
    env: Object.fromEntries(['NODE_ENV', 'APP_URL', 'SESSION_SECRET', 'DATABASE_PATH', 'OUTBOX_DIR', 'BACKUP_DIR', 'SMTP_URL', 'MAIL_FROM', 'MAIL_REPLY_TO', 'ALLOW_UNVERIFIED_CONTACTS', 'INBOUND_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ADMIN_EMAILS', 'COMPANY_NAME', 'COMPANY_ADDRESS', 'SCHEDULER_INTERVAL_MS', 'SHUTDOWN_TIMEOUT_MS', 'TRUST_PROXY', 'DEMO_MODE'].map((k) => [k, present(k)])),
  });
});
// Sauvegarde immédiate de la base (backup.js) ; rejoint celle en cours s'il y en a une. Journalisée dans l'audit.
admin.post('/backup', wrap(async (req, res) => {
  try {
    const r = await runBackup();
    audit(req, 'system.backup', null, { file: r.file, bytes: r.bytes, ms: r.ms });
    res.json({ backup: r, status: backupStatus() });
  } catch (e) {
    if (e.code === 'DISABLED') return bad(res, `Sauvegardes désactivées : ${e.message}`, 409);
    console.error(`[sauvegarde] demandée par l’administration (réf. ${req.id}) :`, e.message);
    audit(req, 'system.backup', null, { failed: true });
    bad(res, 'La sauvegarde a échoué. Le détail figure dans le journal du serveur.', 500);
  }
}));
admin.get('/audit', (req, res) => {
  const p = paging(req.query, 40);
  const where = [], params = [];
  const action = clean(req.query.action, 40);
  if (action) { where.push(`a.action LIKE ? ESCAPE '\\'`); params.push(like(action)); }
  if (UUID.test(String(req.query.admin || ''))) { where.push('a.admin_id = ?'); params.push(req.query.admin); }
  const target = clean(req.query.target, 60);
  if (target) { where.push('a.target = ?'); params.push(target); }
  const base = `FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  const total = q.get(`SELECT COUNT(*) AS c ${base}`, ...params).c; fit(p, total);
  const rows = q.all(`SELECT a.id, a.admin_id, a.action, a.target, a.details, a.ip, a.created_at, u.email AS admin_email ${base} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, p.per, p.offset);
  res.json({ entries: rows.map((a) => ({ ...a, details: JSON.parse(a.details || '{}') })), ...pageMeta(total, p), actions: q.all('SELECT action, COUNT(*) AS n FROM admin_audit GROUP BY action ORDER BY action').map((r) => r.action) });
});
admin.post('/reports/run', wrap(async (req, res) => {
  const r = await runMonthlyReports();
  audit(req, 'system.reports', null, { sent: r.sent, failed: r.failed });
  res.json(r);
}));
admin.post('/tick', wrap(async (req, res) => {
  await tick();
  lastManualTickAt = now();
  audit(req, 'system.tick', null, {});
  res.json({ ok: true, at: lastManualTickAt });
}));
