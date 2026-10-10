// API JSON. Toutes les réponses d'erreur ont la forme { error: "message" }.
// Règles : chaque entrée est typée et bornée (util.js), chaque ressource est filtrée par req.user.id,
// les points sensibles sont limités en débit, et aucune donnée interne (haché, identifiants Stripe, sessions) ne sort.
import express from 'express';
import crypto from 'node:crypto';
import { q, now, logEvent, db } from './db.js';
import {
  hashPassword, verifyPassword, verifyDecoy, passwordProblem, createSession, destroySession, destroyOtherSessions,
  requireAuth, requireAdmin, rateLimit, isAdminEmail, promoteIfAdmin, loginLockRemaining, noteLoginFailure, clearLoginFailures, fmtWait,
  isSuspended, isBlockedEmail, endImpersonation,
} from './auth.js';
import { sendMail, mailMode } from './mailer.js';
import { welcomeMail, mandateText, complaintDraft, MANDATE_VERSION } from './templates.js';
import { PLANS, BILLING_PERIODS, billingMode, startCheckout, cancelSubscription, verifyStripeSignature, handleStripeEvent } from './billing.js';
import { launchProfile, applyOutcome, tick, ref, DEMO } from './scheduler.js';
import { EMAIL, publicUser, parseProfile, wrap, isId, str, strList, oneOf } from './util.js';
import { buildDashboard, exportData, complaintReady } from './dashboard.js';
import { addSite, relaunchRequest } from './sites.js';
import { admin, auditAs, currentAnnouncement, toCsv, classifyReply } from './admin.js';

export const api = express.Router();
const fresh = (req) => q.get('SELECT * FROM users WHERE id = ?', req.user.id);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const PLAN_KEYS = Object.keys(PLANS);
const PHONE = /^\+?[\d\s().-]{5,30}$/;
const COUNTRY = /^[A-Z]{2}$/;
const tooMany = (res, seconds) => { res.setHeader('Retry-After', String(seconds)); return bad(res, `Trop de tentatives. Réessayez dans ${fmtWait(seconds)}.`, 429); };
const isoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

api.get('/health', (_req, res) => res.json({ ok: true, mail: mailMode, billing: billingMode, demo: DEMO, time: now() }));
api.get('/config', (_req, res) => res.json({ plans: PLANS, billing: billingMode, mail: mailMode, demo: DEMO, mandate_version: MANDATE_VERSION, brokers: q.get('SELECT COUNT(*) AS c FROM brokers WHERE active = 1 AND custom = 0').c, announcement: currentAnnouncement() }));

/* ---------- Authentification ---------- */
api.post('/auth/signup', rateLimit({ windowMs: 60 * 60000, max: 20 }), wrap(async (req, res) => {
  const email = str(req.body.email, 'email', 160).toLowerCase();
  const password = req.body.password;
  if (!EMAIL.test(email)) return bad(res, 'Adresse e-mail invalide.');
  if (isBlockedEmail(email)) return bad(res, 'Inscription impossible avec cette adresse.', 403);
  const problem = passwordProblem(password, email);
  if (problem) return bad(res, problem);
  if ((req.body.plan !== undefined && req.body.plan !== null && typeof req.body.plan !== 'string') || (req.body.billing !== undefined && req.body.billing !== null && typeof req.body.billing !== 'string')) return bad(res, 'Offre invalide.');
  const plan = PLAN_KEYS.includes(req.body.plan) ? req.body.plan : null;             // liste blanche ; valeur inconnue ignorée
  const billing = plan ? 'monthly' : null;   // formule unique : une périodicité « annual » transmise est ignorée
  if (q.get('SELECT id FROM users WHERE email = ?', email)) return bad(res, 'Un compte existe déjà avec cette adresse.', 409);
  const password_hash = await hashPassword(password);
  if (q.get('SELECT id FROM users WHERE email = ?', email)) return bad(res, 'Un compte existe déjà avec cette adresse.', 409);
  const id = crypto.randomUUID();
  q.run('INSERT INTO users (id, email, password_hash, role, plan, billing, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, email, password_hash, isAdminEmail(email) ? 'admin' : 'user', plan, billing, now());
  q.run('INSERT INTO profiles (id, user_id, is_primary, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', crypto.randomUUID(), id, now(), now());
  logEvent(id, 'account', 'Compte créé. Dossier ouvert.');
  const user = q.get('SELECT * FROM users WHERE id = ?', id);
  createSession(res, user, req);
  const w = welcomeMail({ email });
  sendMail({ to: email, subject: w.subject, text: w.text, user_id: id }).catch(() => {});
  res.status(201).json({ user: publicUser(user) });
}));
api.post('/auth/login', rateLimit({ max: 50 }), wrap(async (req, res) => {
  const email = str(req.body.email, 'email', 160).toLowerCase();
  const password = req.body.password;
  if (!EMAIL.test(email) || typeof password !== 'string' || !password.length) return bad(res, 'E-mail ou mot de passe incorrect.', 401);
  const locked = loginLockRemaining(email);
  if (locked) return tooMany(res, locked);
  const user = q.get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', email);
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyDecoy(password);
  if (!ok) { noteLoginFailure(email); return bad(res, 'E-mail ou mot de passe incorrect.', 401); }
  clearLoginFailures(email);
  // Mot de passe correct seulement : la suspension n'est jamais révélée à qui ne connaît pas le mot de passe.
  if (isSuspended(user)) return bad(res, 'Ce compte est suspendu. Pour toute question, écrivez au support.', 403);
  promoteIfAdmin(user);
  createSession(res, user, req);
  res.json({ user: publicUser(user) });
}));
// Pendant un accès support, se déconnecter ramène l'administrateur à sa propre session.
const stopSupport = (req, res) => { auditAs(req.impersonator.id, 'user.impersonate_stop', req.user.id, {}, req.ip); return { ok: true, ...endImpersonation(req, res) }; };
api.post('/auth/logout', (req, res) => { if (req.impersonator) return res.json(stopSupport(req, res)); destroySession(req, res); res.json({ ok: true }); });
api.post('/auth/impersonate/stop', (req, res) => (req.impersonator ? res.json(stopSupport(req, res)) : bad(res, 'Aucun accès support en cours.')));
// Déconnecte tous les autres appareils (la session courante est conservée).
api.post('/auth/logout-all', requireAuth, (req, res) => res.json({ ok: true, revoked: destroyOtherSessions(req.user.id, req.sessionId) }));
api.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, profiles: [] });
  const u = fresh(req);
  res.json({ user: publicUser(u), profiles: q.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', u.id).map(parseProfile), impersonation: req.impersonator ? { admin_email: req.impersonator.email, expires_at: req.sessionExpiresAt } : null });
});
api.post('/auth/password', requireAuth, rateLimit({ max: 10 }), wrap(async (req, res) => {
  const current = req.body.current, next = req.body.next;
  if (typeof current !== 'string' || typeof next !== 'string') return bad(res, 'Mot de passe invalide.');
  const u = fresh(req);
  const problem = passwordProblem(next, u.email);
  if (problem) return bad(res, problem);
  if (!(await verifyPassword(current, u.password_hash))) return bad(res, 'Mot de passe actuel incorrect.');
  if (next === current) return bad(res, 'Le nouveau mot de passe doit être différent de l’actuel.');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(next), u.id);
  destroyOtherSessions(u.id, req.sessionId);
  logEvent(u.id, 'account', 'Mot de passe modifié ; les autres sessions ont été déconnectées.');
  res.json({ ok: true });
}));

/* ---------- Profils (personnes protégées) ---------- */
const ownProfile = (req) => (isId(req.params.id) ? q.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', req.params.id, req.user.id) : null);
api.get('/profiles', requireAuth, (req, res) => res.json({ profiles: q.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', req.user.id).map(parseProfile) }));
api.post('/profiles', requireAuth, (req, res) => {
  const u = fresh(req);
  const first = str(req.body.first_name, 'first_name', 80), last = str(req.body.last_name, 'last_name', 80);
  if (!first || !last) return bad(res, 'Prénom et nom sont obligatoires.');
  const max = PLANS[u.plan]?.members || 1;
  const n = q.get('SELECT COUNT(*) AS c FROM profiles WHERE user_id = ?', u.id).c;
  if (n >= max) return bad(res, max === 1 ? "L'offre Individuel couvre une seule personne : passez à l'offre Famille pour ajouter un proche." : `L'offre Famille couvre jusqu'à ${max} personnes.`);
  const id = crypto.randomUUID();
  q.run('INSERT INTO profiles (id, user_id, is_primary, first_name, last_name, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)', id, u.id, first, last, now(), now());
  logEvent(u.id, 'profile', `Proche ajouté au dossier : ${first} ${last}.`, { profile_id: id });
  res.status(201).json({ profile: parseProfile(q.get('SELECT * FROM profiles WHERE id = ?', id)) });
});
api.put('/profiles/:id', requireAuth, (req, res) => {
  const p = ownProfile(req);
  if (!p) return bad(res, 'Profil introuvable.', 404);
  const b = req.body, cur = parseProfile(p);
  const first = b.first_name === undefined ? p.first_name : str(b.first_name, 'first_name', 80);
  const last = b.last_name === undefined ? p.last_name : str(b.last_name, 'last_name', 80);
  if (!first || !last) return bad(res, 'Prénom et nom sont obligatoires.');
  const birth = str(b.birth_date, 'birth_date', 10) || null;
  if (birth && (!isoDate(birth) || birth < '1900-01-01' || birth > now().slice(0, 10))) return bad(res, 'Date de naissance invalide (AAAA-MM-JJ).');
  const country = (b.country === undefined ? p.country : str(b.country, 'country', 2)).toUpperCase() || 'FR';
  if (!COUNTRY.test(country)) return bad(res, 'Pays invalide (code à deux lettres).');
  const emails = b.emails === undefined ? cur.emails : strList(b.emails, 'emails', 10);
  if (emails.some((e) => !EMAIL.test(e))) return bad(res, 'Une adresse e-mail est invalide.');
  const phones = b.phones === undefined ? cur.phones : strList(b.phones, 'phones', 10, 40);
  if (phones.some((t) => !PHONE.test(t))) return bad(res, 'Un numéro de téléphone est invalide.');
  const addresses = b.addresses === undefined ? cur.addresses : strList(b.addresses, 'addresses', 6, 160);
  const aliases = b.aliases === undefined ? cur.aliases : strList(b.aliases, 'aliases', 6, 80);
  q.run('UPDATE profiles SET first_name = ?, last_name = ?, birth_date = ?, country = ?, emails = ?, phones = ?, addresses = ?, aliases = ?, updated_at = ? WHERE id = ?',
    first, last, birth, country, JSON.stringify(emails.map((e) => e.toLowerCase())), JSON.stringify(phones), JSON.stringify(addresses), JSON.stringify(aliases), now(), p.id);
  logEvent(req.user.id, 'profile', `Informations mises à jour pour ${first} ${last}.`, { profile_id: p.id });
  res.json({ profile: parseProfile(q.get('SELECT * FROM profiles WHERE id = ?', p.id)) });
});
api.delete('/profiles/:id', requireAuth, (req, res) => {
  const p = ownProfile(req);
  if (!p) return bad(res, 'Profil introuvable.', 404);
  if (p.is_primary) return bad(res, 'Le profil principal ne peut pas être supprimé (supprimez le compte).');
  q.run('DELETE FROM profiles WHERE id = ?', p.id);
  logEvent(req.user.id, 'profile', `${p.first_name} ${p.last_name} retiré du dossier ; ses demandes en cours sont abandonnées.`);
  res.json({ ok: true });
});

/* ---------- Mandat ---------- */
api.get('/mandate', requireAuth, (req, res) => {
  const u = fresh(req);
  const p = parseProfile(q.get('SELECT * FROM profiles WHERE user_id = ? AND is_primary = 1', u.id) || { emails: '[]', phones: '[]', addresses: '[]', aliases: '[]', first_name: '', last_name: '', country: 'FR' });
  if (!u.mandate_signed_at) return res.json({ signed: false, version: MANDATE_VERSION, text: mandateText({ user: { ...u, mandate_name: `${p.first_name} ${p.last_name}` }, profile: p, signedAt: now() }).replace(/Signé électroniquement le .*$/s, 'À signer électroniquement ci-dessous.') });
  res.json({ signed: true, revoked: !!u.mandate_revoked_at, signed_at: u.mandate_signed_at, version: u.mandate_version, text: mandateText({ user: u, profile: p, signedAt: u.mandate_signed_at }) });
});
api.post('/mandate', requireAuth, (req, res) => {
  const u = fresh(req);
  const name = str(req.body.full_name, 'full_name', 120);
  const p = q.get('SELECT * FROM profiles WHERE user_id = ? AND is_primary = 1', u.id);
  if (!p?.first_name || !p?.last_name) return bad(res, 'Renseignez d’abord votre nom et prénom.');
  if (req.body.accepted !== true) return bad(res, 'Vous devez accepter le mandat.');
  const expected = `${p.first_name} ${p.last_name}`.toLowerCase().replace(/\s+/g, ' ');
  if (name.toLowerCase().replace(/\s+/g, ' ') !== expected) return bad(res, `Tapez exactement « ${p.first_name} ${p.last_name} » pour signer.`);
  q.run('UPDATE users SET mandate_signed_at = ?, mandate_name = ?, mandate_ip = ?, mandate_version = ?, mandate_revoked_at = NULL WHERE id = ?', now(), name, String(req.ip || '').slice(0, 64), MANDATE_VERSION, u.id);
  logEvent(u.id, 'mandate', `Mandat de représentation signé électroniquement (version ${MANDATE_VERSION}).`);
  res.json({ ok: true, signed_at: now() });
});
api.delete('/mandate', requireAuth, (req, res) => {
  q.run('UPDATE users SET mandate_revoked_at = ? WHERE id = ?', now(), req.user.id);
  q.run(`UPDATE requests SET status = 'refused', note = 'Mandat révoqué par l’abonné.' WHERE user_id = ? AND status = 'queued'`, req.user.id);
  logEvent(req.user.id, 'mandate', 'Mandat révoqué : plus aucune demande ne sera envoyée.');
  res.json({ ok: true });
});

/* ---------- Courtiers (liste publique : jamais d'adresse de contact ni de statut de vérification) ---------- */
api.get('/brokers', (_req, res) => {
  // Registre seulement : les sites ajoutés par les abonnés ne sont jamais publiés (ils révéleraient leurs recherches).
  const brokers = q.all('SELECT id, slug, name, domain, category, jurisdiction, legal_basis, sensitivity, recheck_days, active FROM brokers WHERE custom = 0 ORDER BY name');
  const categories = q.all('SELECT category, COUNT(*) AS n FROM brokers WHERE active = 1 AND custom = 0 GROUP BY category ORDER BY n DESC');
  res.json({ brokers, categories, total: brokers.filter((b) => b.active).length });
});

/* ---------- Demandes & tableau de bord ---------- */
api.post('/requests/launch', requireAuth, rateLimit({ max: 30 }), wrap(async (req, res) => {
  const u = fresh(req);
  const pid = req.body.profile_id;
  if (pid !== undefined && pid !== null && pid !== '' && !isId(pid)) return bad(res, 'Profil introuvable.', 404);
  const profiles = pid ? [q.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', pid, u.id)].filter(Boolean) : q.all('SELECT * FROM profiles WHERE user_id = ?', u.id);
  if (pid && !profiles.length) return bad(res, 'Profil introuvable.', 404);
  let created = 0, reason = null;
  for (const p of profiles) { const r = launchProfile(u, p); created += r.created; reason = reason || r.reason; }
  if (!created && reason) return bad(res, reason);
  setTimeout(() => tick(), 10);
  res.json({ created });
}));
// Coller l'adresse d'un site (ou d'une fiche) : demande d'effacement automatique pour le profil affiché.
api.post('/sites', requireAuth, rateLimit({ windowMs: 60 * 60000, max: 30 }), (req, res) => {
  const u = fresh(req);
  const pid = req.body.profile_id;
  const profile = isId(pid) ? q.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', pid, u.id) : q.get('SELECT * FROM profiles WHERE user_id = ? AND is_primary = 1', u.id);
  if (!profile) return bad(res, 'Profil introuvable.', 404);
  const r = addSite(u, profile, str(req.body.url, 'url', 2048));
  const b = r.broker;
  res.status(r.status === 'already' ? 200 : 201).json({ status: r.status, registry: r.registry, request_id: r.request.id, broker: { id: b.id, name: b.name, domain: b.domain, custom: !!b.custom }, url: r.site.url });
});
api.get('/dashboard', requireAuth, (req, res) => res.json(buildDashboard(fresh(req), isId(req.query.profile_id) ? req.query.profile_id : undefined)));
const ownRequest = (req, cols = '*') => (isId(req.params.id) ? q.get(`SELECT ${cols} FROM requests WHERE id = ? AND user_id = ?`, req.params.id, req.user.id) : null);
api.post('/requests/:id/resolve', requireAuth, wrap(async (req, res) => {
  const r = ownRequest(req);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  if (r.status !== 'action_required') return bad(res, 'Cette demande n’attend pas d’action de votre part.');
  q.run(`UPDATE requests SET status = 'in_progress', note = 'Vérification fournie par l’abonné ; en attente du courtier.' WHERE id = ?`, r.id);
  logEvent(req.user.id, 'in_progress', 'Vérification transmise : la demande reprend son cours.', { profile_id: r.profile_id, request_id: r.id });
  res.json({ ok: true });
}));
// Détail d'une demande : historique (événements liés) et courriers, pour le panneau « Détails » du tableau de bord.
api.get('/requests/:id/details', requireAuth, (req, res) => {
  const r = ownRequest(req);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  const b = q.get('SELECT name, domain, category, custom, legal_basis FROM brokers WHERE id = ?', r.broker_id);
  res.json({
    request: { id: r.id, ref: `OUBLI-${r.token}`, status: r.status, cycle: r.cycle, created_at: r.created_at, sent_at: r.sent_at, due_at: r.due_at, followup_sent_at: r.followup_sent_at, completed_at: r.completed_at, next_check_at: r.next_check_at, note: r.note, source_url: r.source_url, broker: b?.name, domain: b?.domain, custom: !!b?.custom },
    events: q.all('SELECT id, type, message, created_at FROM events WHERE request_id = ? AND user_id = ? ORDER BY id DESC LIMIT 50', r.id, req.user.id),
    mails: q.all('SELECT id, to_addr, subject, body, mode, created_at FROM mails WHERE request_id = ? AND user_id = ? ORDER BY id', r.id, req.user.id),
  });
});
// Plainte auprès de l'autorité de contrôle : texte rédigé au nom de l'abonné, à déposer lui-même (refus, ou relance sans réponse).
api.get('/requests/:id/complaint', requireAuth, (req, res) => {
  const r = ownRequest(req);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  if (!complaintReady(r)) return bad(res, 'Une plainte se prépare après un refus du courtier, ou quand la relance est restée sans réponse huit jours.');
  const profile = q.get('SELECT * FROM profiles WHERE id = ?', r.profile_id), broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
  const refusedAt = r.status === 'refused' ? q.get(`SELECT created_at FROM events WHERE request_id = ? AND type = 'refused' ORDER BY id DESC LIMIT 1`, r.id)?.created_at || null : null;
  res.json(complaintDraft({ profile, broker, user: fresh(req), ref: ref(r), request: r, refusedAt }));
});
// « Mes données sont réapparues » : nouvelle demande immédiate pour un courtier qui a effacé (ou refusé).
api.post('/requests/:id/relaunch', requireAuth, rateLimit({ windowMs: 60 * 60000, max: 20 }), (req, res) => {
  const r = ownRequest(req);
  if (!r) return bad(res, 'Demande introuvable.', 404);
  res.status(201).json(relaunchRequest(fresh(req), r, str(req.body.url, 'url', 2048)));
});
// Demandes du profil en CSV (rapport imprimable) : cycle en cours, une ligne par courtier ou site.
api.get('/requests.csv', requireAuth, rateLimit({ max: 30 }), (req, res) => {
  const d = buildDashboard(fresh(req), isId(req.query.profile_id) ? req.query.profile_id : undefined);
  const STATUS = { queued: 'À envoyer', sent: 'Envoyée', in_progress: 'En cours', action_required: 'Action requise', done: 'Effacée', refused: 'Refusée', error: 'Erreur d’envoi' };
  const rows = d.requests.map((r) => ({ courtier: r.broker, domaine: r.domain, categorie: r.category, statut: STATUS[r.status] || r.status, base_legale: r.legal_basis === 'ccpa' ? 'CCPA' : r.legal_basis === 'both' ? 'RGPD et CCPA' : 'RGPD', cycle: r.cycle, envoyee_le: r.sent_at || '', echeance: r.due_at || '', effacee_le: r.completed_at || '', reverification: r.next_check_at || '', fiche: r.source_url || '', reference: r.ref }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="oubli-demandes-${now().slice(0, 10)}.csv"`);
  res.send(toCsv(['courtier', 'domaine', 'categorie', 'statut', 'base_legale', 'cycle', 'envoyee_le', 'echeance', 'effacee_le', 'reverification', 'fiche', 'reference'], rows));
});
// Préférences de l'abonné (rapport mensuel par e-mail).
api.put('/preferences', requireAuth, (req, res) => {
  if (typeof req.body.monthly_report !== 'boolean') return bad(res, 'Préférence invalide.');
  q.run('UPDATE users SET monthly_report = ? WHERE id = ?', req.body.monthly_report ? 1 : 0, req.user.id);
  logEvent(req.user.id, 'account', req.body.monthly_report ? 'Rapport mensuel par e-mail activé.' : 'Rapport mensuel par e-mail désactivé.');
  res.json({ user: publicUser(fresh(req)) });
});
api.get('/requests/:id/mails', requireAuth, (req, res) => {
  const r = ownRequest(req, 'id');
  if (!r) return bad(res, 'Demande introuvable.', 404);
  res.json({ mails: q.all('SELECT id, to_addr, subject, body, mode, created_at FROM mails WHERE request_id = ? AND user_id = ? ORDER BY id', r.id, req.user.id) });
});

/* ---------- Facturation ---------- */
api.post('/billing/checkout', requireAuth, rateLimit({ max: 10 }), wrap(async (req, res) => {
  const plan = oneOf(req.body.plan, PLAN_KEYS, 'plan');
  if (!plan) return bad(res, 'Offre inconnue.');
  if (req.body.billing != null && req.body.billing !== '' && !BILLING_PERIODS.includes(req.body.billing)) return bad(res, 'L’offre annuelle n’est plus proposée : l’abonnement est mensuel et sans engagement.');
  const billing = 'monthly';
  try { res.json(await startCheckout(fresh(req), plan, billing)); }
  catch (e) { console.error(`[billing] checkout impossible (${req.id}) :`, e.message); bad(res, 'Le paiement n’a pas pu être initialisé. Réessayez dans quelques instants.', 502); }
}));
api.post('/billing/cancel', requireAuth, rateLimit({ max: 10 }), wrap(async (req, res) => {
  try { res.json(await cancelSubscription(fresh(req))); }
  catch (e) { console.error(`[billing] résiliation impossible (${req.id}) :`, e.message); bad(res, 'La résiliation n’a pas pu être transmise. Réessayez dans quelques instants.', 502); }
}));
// Webhook Stripe : corps brut uniquement, signature obligatoire, cookies ignorés (voir index.js).
export function stripeWebhook(req, res) {
  if (!Buffer.isBuffer(req.body)) return bad(res, 'Corps de requête invalide.');
  const raw = req.body.toString('utf8');
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) return bad(res, 'Signature invalide.');
  let event;
  try { event = JSON.parse(raw); } catch { return bad(res, 'Événement invalide.'); }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return bad(res, 'Événement invalide.');
  try { handleStripeEvent(event); } catch (e) { console.error(`[billing] webhook (${req.id}) :`, e); return bad(res, 'Événement non traité.'); }
  res.json({ received: true });
}

/* ---------- Courrier entrant (réponses des courtiers via webhook de votre fournisseur e-mail) ---------- */
const INBOUND_TOKEN = String(process.env.INBOUND_TOKEN || '');
if (INBOUND_TOKEN && INBOUND_TOKEN.length < 16) console.error('[inbound] INBOUND_TOKEN trop court (16 caractères minimum) : le webhook /api/inbound est désactivé.');
const inboundTokenOk = (given) => {
  if (INBOUND_TOKEN.length < 16 || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(INBOUND_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
};
api.post('/inbound', rateLimit({ windowMs: 60000, max: 120 }), wrap(async (req, res) => {
  if (!inboundTokenOk(req.get('x-inbound-token'))) return bad(res, 'Jeton manquant ou invalide.', 401);
  const subject = str(req.body.subject, 'subject', 1000), body = str(req.body.text, 'text', 200000) || str(req.body.body, 'body', 200000);
  const text = `${subject}\n${body}`;
  const m = text.match(/OUBLI-([A-F0-9]{10})/i);
  if (!m) return res.status(202).json({ matched: false });
  const r = q.get('SELECT * FROM requests WHERE token = ?', m[1].toUpperCase());
  if (!r) return res.status(202).json({ matched: false });
  const outcome = classifyReply(text);
  const out = await applyOutcome(r, outcome, `réponse reçue de ${str(req.body.from, 'from', 120)}`);
  res.json({ matched: true, outcome, applied: !!out?.applied });
}));

/* ---------- Divers : newsletter, contact, export RGPD, suppression ---------- */
api.post('/newsletter', rateLimit({ max: 20 }), (req, res) => {
  const email = str(req.body.email, 'email', 160).toLowerCase();
  if (!EMAIL.test(email)) return bad(res, 'Adresse invalide.');
  q.run('INSERT OR IGNORE INTO newsletter (email, created_at) VALUES (?, ?)', email, now());
  res.json({ ok: true });
});
api.post('/contact', rateLimit({ windowMs: 60 * 60000, max: 10 }), (req, res) => {
  const email = str(req.body.email, 'email', 160).toLowerCase(), message = str(req.body.message, 'message', 4000), subject = str(req.body.subject, 'subject', 200);
  if (!EMAIL.test(email) || message.length < 5) return bad(res, 'Adresse ou message invalide.');
  q.run('INSERT INTO contacts (email, subject, message, created_at) VALUES (?, ?, ?, ?)', email, subject, message, now());
  res.json({ ok: true });
});
api.get('/export', requireAuth, rateLimit({ max: 10 }), (req, res) => {
  const u = fresh(req);
  res.setHeader('Content-Disposition', 'attachment; filename="oubli-export.json"');
  res.json(exportData(u));
});
api.delete('/account', requireAuth, rateLimit({ max: 5 }), wrap(async (req, res) => {
  const u = fresh(req);
  if (typeof req.body.password !== 'string' || !(await verifyPassword(req.body.password, u.password_hash))) return bad(res, 'Mot de passe incorrect.');
  if (u.subscription_status === 'active') { try { await cancelSubscription(u); } catch (e) { console.error(`[billing] résiliation à la suppression (${req.id}) :`, e.message); } }
  db.exec('BEGIN');
  try {
    q.run('DELETE FROM requests WHERE user_id = ?', u.id); q.run('DELETE FROM profiles WHERE user_id = ?', u.id); q.run('DELETE FROM events WHERE user_id = ?', u.id);
    q.run('DELETE FROM mails WHERE user_id = ?', u.id); q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    q.run(`UPDATE users SET email = ?, password_hash = '', deleted_at = ?, mandate_name = NULL, mandate_ip = NULL, stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = ?`, `deleted-${u.id}@oubli.invalid`, now(), u.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  destroySession(req, res);
  res.json({ ok: true });
}));

/* ---------- Administration (voir server/admin.js) ---------- */
api.use('/admin', requireAuth, requireAdmin, admin);
