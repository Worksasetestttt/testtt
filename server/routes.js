// API JSON. Toutes les réponses d'erreur ont la forme { error: "message" }.
import express from 'express';
import crypto from 'node:crypto';
import { q, now, logEvent, db } from './db.js';
import { hashPassword, verifyPassword, createSession, destroySession, requireAuth, requireAdmin, rateLimit, isAdminEmail } from './auth.js';
import { sendMail, mailMode } from './mailer.js';
import { welcomeMail, mandateText, MANDATE_VERSION } from './templates.js';
import { PLANS, billingMode, startCheckout, cancelSubscription, verifyStripeSignature, handleStripeEvent } from './billing.js';
import { launchProfile, applyOutcome, tick, DEMO } from './scheduler.js';
import { EMAIL, clean, arr, publicUser, parseProfile, wrap } from './util.js';
import { buildDashboard } from './dashboard.js';
import { admin } from './admin.js';

export const api = express.Router();
const fresh = (req) => q.get('SELECT * FROM users WHERE id = ?', req.user.id);

api.get('/health', (_req, res) => res.json({ ok: true, mail: mailMode, billing: billingMode, demo: DEMO, time: now() }));
api.get('/config', (_req, res) => res.json({ plans: PLANS, billing: billingMode, mail: mailMode, demo: DEMO, mandate_version: MANDATE_VERSION, brokers: q.get('SELECT COUNT(*) AS c FROM brokers WHERE active = 1').c }));

/* ---------- Authentification ---------- */
api.post('/auth/signup', rateLimit({ max: 20 }), wrap(async (req, res) => {
  const email = clean(req.body.email, 160).toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  if (password.length < 10) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 10 caractères.' });
  if (q.get('SELECT id FROM users WHERE email = ?', email)) return res.status(409).json({ error: 'Un compte existe déjà avec cette adresse.' });
  const id = crypto.randomUUID();
  const plan = PLANS[req.body.plan] ? req.body.plan : null;
  const billing = ['monthly', 'annual'].includes(req.body.billing) ? req.body.billing : (plan ? 'annual' : null);
  q.run('INSERT INTO users (id, email, password_hash, role, plan, billing, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, email, hashPassword(password), isAdminEmail(email) ? 'admin' : 'user', plan, billing, now());
  q.run('INSERT INTO profiles (id, user_id, is_primary, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', crypto.randomUUID(), id, now(), now());
  logEvent(id, 'account', 'Compte créé. Dossier ouvert.');
  const user = q.get('SELECT * FROM users WHERE id = ?', id);
  createSession(res, user, req);
  const w = welcomeMail({ email });
  sendMail({ to: email, subject: w.subject, text: w.text, user_id: id }).catch(() => {});
  res.status(201).json({ user: publicUser(user) });
}));
api.post('/auth/login', rateLimit({ max: 30 }), wrap(async (req, res) => {
  const email = clean(req.body.email, 160).toLowerCase();
  const user = q.get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
  createSession(res, user, req);
  res.json({ user: publicUser(user) });
}));
api.post('/auth/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });
api.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, profiles: [] });
  const u = fresh(req);
  res.json({ user: publicUser(u), profiles: q.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', u.id).map(parseProfile) });
});
api.post('/auth/password', requireAuth, wrap(async (req, res) => {
  const u = fresh(req);
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
  if (String(req.body.next || '').length < 10) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 10 caractères.' });
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(req.body.next)), u.id);
  q.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, req.sessionId);
  res.json({ ok: true });
}));

/* ---------- Profils (personnes protégées) ---------- */
api.get('/profiles', requireAuth, (req, res) => res.json({ profiles: q.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', req.user.id).map(parseProfile) }));
api.post('/profiles', requireAuth, (req, res) => {
  const u = fresh(req);
  const max = PLANS[u.plan]?.members || 1;
  const n = q.get('SELECT COUNT(*) AS c FROM profiles WHERE user_id = ?', u.id).c;
  if (n >= max) return res.status(400).json({ error: max === 1 ? "L'offre Individuel couvre une seule personne : passez à l'offre Famille pour ajouter un proche." : `L'offre Famille couvre jusqu'à ${max} personnes.` });
  const id = crypto.randomUUID();
  q.run('INSERT INTO profiles (id, user_id, is_primary, first_name, last_name, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)', id, u.id, clean(req.body.first_name, 80), clean(req.body.last_name, 80), now(), now());
  logEvent(u.id, 'profile', `Proche ajouté au dossier : ${clean(req.body.first_name, 80)} ${clean(req.body.last_name, 80)}.`, { profile_id: id });
  res.status(201).json({ profile: parseProfile(q.get('SELECT * FROM profiles WHERE id = ?', id)) });
});
api.put('/profiles/:id', requireAuth, (req, res) => {
  const p = q.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Profil introuvable.' });
  const b = req.body;
  const first = clean(b.first_name ?? p.first_name, 80), last = clean(b.last_name ?? p.last_name, 80);
  if (!first || !last) return res.status(400).json({ error: 'Prénom et nom sont obligatoires.' });
  const birth = b.birth_date ? clean(b.birth_date, 10) : null;
  if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) return res.status(400).json({ error: 'Date de naissance invalide (AAAA-MM-JJ).' });
  const emails = arr(b.emails ?? JSON.parse(p.emails)); if (emails.some((e) => !EMAIL.test(e))) return res.status(400).json({ error: 'Une adresse e-mail est invalide.' });
  q.run('UPDATE profiles SET first_name = ?, last_name = ?, birth_date = ?, country = ?, emails = ?, phones = ?, addresses = ?, aliases = ?, updated_at = ? WHERE id = ?',
    first, last, birth, clean(b.country ?? p.country, 2).toUpperCase() || 'FR', JSON.stringify(emails), JSON.stringify(arr(b.phones ?? JSON.parse(p.phones))), JSON.stringify(arr(b.addresses ?? JSON.parse(p.addresses), 6)), JSON.stringify(arr(b.aliases ?? JSON.parse(p.aliases), 6)), now(), p.id);
  logEvent(req.user.id, 'profile', `Informations mises à jour pour ${first} ${last}.`, { profile_id: p.id });
  res.json({ profile: parseProfile(q.get('SELECT * FROM profiles WHERE id = ?', p.id)) });
});
api.delete('/profiles/:id', requireAuth, (req, res) => {
  const p = q.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Profil introuvable.' });
  if (p.is_primary) return res.status(400).json({ error: 'Le profil principal ne peut pas être supprimé (supprimez le compte).' });
  q.run('DELETE FROM profiles WHERE id = ?', p.id);
  logEvent(req.user.id, 'profile', `${p.first_name} ${p.last_name} retiré du dossier ; ses demandes en cours sont abandonnées.`);
  res.json({ ok: true });
});

/* ---------- Mandat ---------- */
api.get('/mandate', requireAuth, (req, res) => {
  const u = fresh(req);
  const p = parseProfile(q.get('SELECT * FROM profiles WHERE user_id = ? AND is_primary = 1', u.id));
  if (!u.mandate_signed_at) return res.json({ signed: false, version: MANDATE_VERSION, text: mandateText({ user: { ...u, mandate_name: `${p.first_name} ${p.last_name}` }, profile: p, signedAt: now() }).replace(/Signé électroniquement le .*$/s, 'À signer électroniquement ci-dessous.') });
  res.json({ signed: true, revoked: !!u.mandate_revoked_at, signed_at: u.mandate_signed_at, version: u.mandate_version, text: mandateText({ user: u, profile: p, signedAt: u.mandate_signed_at }) });
});
api.post('/mandate', requireAuth, (req, res) => {
  const u = fresh(req);
  const name = clean(req.body.full_name, 120);
  const p = q.get('SELECT * FROM profiles WHERE user_id = ? AND is_primary = 1', u.id);
  if (!p?.first_name || !p?.last_name) return res.status(400).json({ error: 'Renseignez d’abord votre nom et prénom.' });
  if (req.body.accepted !== true) return res.status(400).json({ error: 'Vous devez accepter le mandat.' });
  const expected = `${p.first_name} ${p.last_name}`.toLowerCase().replace(/\s+/g, ' ');
  if (name.toLowerCase().replace(/\s+/g, ' ') !== expected) return res.status(400).json({ error: `Tapez exactement « ${p.first_name} ${p.last_name} » pour signer.` });
  q.run('UPDATE users SET mandate_signed_at = ?, mandate_name = ?, mandate_ip = ?, mandate_version = ?, mandate_revoked_at = NULL WHERE id = ?', now(), name, req.ip, MANDATE_VERSION, u.id);
  logEvent(u.id, 'mandate', `Mandat de représentation signé électroniquement (version ${MANDATE_VERSION}).`);
  res.json({ ok: true, signed_at: now() });
});
api.delete('/mandate', requireAuth, (req, res) => {
  q.run('UPDATE users SET mandate_revoked_at = ? WHERE id = ?', now(), req.user.id);
  q.run(`UPDATE requests SET status = 'refused', note = 'Mandat révoqué par l’abonné.' WHERE user_id = ? AND status = 'queued'`, req.user.id);
  logEvent(req.user.id, 'mandate', 'Mandat révoqué : plus aucune demande ne sera envoyée.');
  res.json({ ok: true });
});

/* ---------- Courtiers ---------- */
api.get('/brokers', (_req, res) => {
  const brokers = q.all('SELECT id, slug, name, domain, category, jurisdiction, legal_basis, sensitivity, recheck_days, active FROM brokers ORDER BY name');
  const categories = q.all('SELECT category, COUNT(*) AS n FROM brokers WHERE active = 1 GROUP BY category ORDER BY n DESC');
  res.json({ brokers, categories, total: brokers.filter((b) => b.active).length });
});

/* ---------- Demandes & tableau de bord ---------- */
api.post('/requests/launch', requireAuth, wrap(async (req, res) => {
  const u = fresh(req);
  const profiles = req.body.profile_id ? [q.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', req.body.profile_id, u.id)].filter(Boolean) : q.all('SELECT * FROM profiles WHERE user_id = ?', u.id);
  let created = 0, reason = null;
  for (const p of profiles) { const r = launchProfile(u, p); created += r.created; reason = reason || r.reason; }
  if (!created && reason) return res.status(400).json({ error: reason });
  setTimeout(() => tick(), 10);
  res.json({ created });
}));
api.get('/dashboard', requireAuth, (req, res) => res.json(buildDashboard(fresh(req), req.query.profile_id)));
api.post('/requests/:id/resolve', requireAuth, wrap(async (req, res) => {
  const r = q.get('SELECT * FROM requests WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable.' });
  if (r.status !== 'action_required') return res.status(400).json({ error: 'Cette demande n’attend pas d’action de votre part.' });
  q.run(`UPDATE requests SET status = 'in_progress', note = 'Vérification fournie par l’abonné ; en attente du courtier.' WHERE id = ?`, r.id);
  logEvent(req.user.id, 'in_progress', 'Vérification transmise : la demande reprend son cours.', { profile_id: r.profile_id, request_id: r.id });
  res.json({ ok: true });
}));
api.get('/requests/:id/mails', requireAuth, (req, res) => {
  const r = q.get('SELECT id FROM requests WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable.' });
  res.json({ mails: q.all('SELECT id, to_addr, subject, body, mode, created_at FROM mails WHERE request_id = ? ORDER BY id', r.id) });
});

/* ---------- Facturation ---------- */
api.post('/billing/checkout', requireAuth, wrap(async (req, res) => {
  try { res.json(await startCheckout(fresh(req), req.body.plan, req.body.billing)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
api.post('/billing/cancel', requireAuth, wrap(async (req, res) => res.json(await cancelSubscription(fresh(req)))));
export function stripeWebhook(req, res) {
  const raw = req.body.toString('utf8');
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) return res.status(400).json({ error: 'Signature invalide.' });
  try { handleStripeEvent(JSON.parse(raw)); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ received: true });
}

/* ---------- Courrier entrant (réponses des courtiers via webhook de votre fournisseur e-mail) ---------- */
api.post('/inbound', wrap(async (req, res) => {
  const token = process.env.INBOUND_TOKEN;
  if (!token || req.get('x-inbound-token') !== token) return res.status(401).json({ error: 'Jeton manquant ou invalide.' });
  const text = `${req.body.subject || ''}\n${req.body.text || req.body.body || ''}`;
  const m = text.match(/OUBLI-([A-F0-9]{10})/i);
  if (!m) return res.status(202).json({ matched: false });
  const r = q.get('SELECT * FROM requests WHERE token = ?', m[1].toUpperCase());
  if (!r) return res.status(202).json({ matched: false });
  const t = text.toLowerCase();
  const outcome = /(supprim|effac|deleted|removed|erased|no longer|opted out|completed)/.test(t) ? 'done' : /(v[ée]rif|verify|confirm your identity|identity|pièce d|proof|photo id)/.test(t) ? 'action_required' : /(refus|decline|cannot|unable|not applicable|exempt)/.test(t) ? 'refused' : 'in_progress';
  await applyOutcome(r, outcome, `réponse reçue de ${clean(req.body.from, 120)}`);
  res.json({ matched: true, outcome });
}));

/* ---------- Divers : newsletter, contact, export RGPD, suppression ---------- */
api.post('/newsletter', rateLimit({ max: 20 }), (req, res) => {
  const email = clean(req.body.email, 160).toLowerCase();
  if (!EMAIL.test(email)) return res.status(400).json({ error: 'Adresse invalide.' });
  q.run('INSERT OR IGNORE INTO newsletter (email, created_at) VALUES (?, ?)', email, now());
  res.json({ ok: true });
});
api.post('/contact', rateLimit({ max: 10 }), (req, res) => {
  const email = clean(req.body.email, 160).toLowerCase(), message = clean(req.body.message, 4000);
  if (!EMAIL.test(email) || message.length < 5) return res.status(400).json({ error: 'Adresse ou message invalide.' });
  q.run('INSERT INTO contacts (email, subject, message, created_at) VALUES (?, ?, ?, ?)', email, clean(req.body.subject, 200), message, now());
  res.json({ ok: true });
});
api.get('/export', requireAuth, (req, res) => {
  const u = fresh(req);
  res.setHeader('Content-Disposition', 'attachment; filename="oubli-export.json"');
  res.json({
    exported_at: now(), user: publicUser(u),
    profiles: q.all('SELECT * FROM profiles WHERE user_id = ?', u.id).map(parseProfile),
    requests: q.all('SELECT r.*, b.name AS broker FROM requests r JOIN brokers b ON b.id = r.broker_id WHERE r.user_id = ?', u.id),
    events: q.all('SELECT * FROM events WHERE user_id = ? ORDER BY id', u.id),
    mails: q.all('SELECT to_addr, subject, body, created_at FROM mails WHERE user_id = ? ORDER BY id', u.id),
  });
});
api.delete('/account', requireAuth, wrap(async (req, res) => {
  const u = fresh(req);
  if (!verifyPassword(String(req.body.password || ''), u.password_hash)) return res.status(400).json({ error: 'Mot de passe incorrect.' });
  if (u.subscription_status === 'active') { try { await cancelSubscription(u); } catch {} }
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
