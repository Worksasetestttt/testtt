// Planificateur : envoi des demandes en attente, relances à l’échéance légale, nouveau cycle de vérification,
// et (en mode démo) simulation des réponses des courtiers.
//
// Machine à états d’une demande : queued → sent → (in_progress | action_required | done | refused)
//   · action_required → in_progress (vérification fournie par l’abonné, routes.js)
//   · done | refused → nouveau cycle (nouvelle demande queued, cycle + 1) quand next_check_at est atteint ; un refus
//     programme ce nouvel envoi après recheck_days jours, et l’abonné peut relancer plus tôt (sites.js, relaunchRequest)
//   · queued → error après SEND_MAX_ATTEMPTS échecs d’envoi (recul exponentiel entre deux essais) ; error → queued via applyOutcome(r, 'queued')
//   · queued → refused quand le mandat est révoqué (routes.js) ; ces demandes sont relancées dans un nouveau cycle après re-signature.
import crypto from 'node:crypto';
import { q, now, addDays, addMonths, logEvent, tx, newToken } from './db.js';
import { sendMail, mailMode, REPLY_TO } from './mailer.js';
import { removalRequest, followUp, actionRequiredMail } from './templates.js';

const truthy = (v) => /^(1|true|yes)$/i.test(v || '');
// Démo : jamais sur une instance de production reliée à un vrai courrier ou à Stripe (les réponses seraient fictives).
const PROD = process.env.NODE_ENV === 'production';
const REAL = !!(process.env.SMTP_URL || process.env.STRIPE_SECRET_KEY);
export const DEMO = truthy(process.env.DEMO_MODE) && !(PROD && REAL);
if (truthy(process.env.DEMO_MODE) && !DEMO) console.warn('[scheduler] DEMO_MODE ignoré : courrier ou paiement réels configurés en production.');
const ALLOW_UNVERIFIED = truthy(process.env.ALLOW_UNVERIFIED_CONTACTS);
const BATCH = Math.min(1000, Math.max(1, Number(process.env.SEND_BATCH) || 200)); // courriers par passage du planificateur
const MAX_ATTEMPTS = Math.max(1, Number(process.env.SEND_MAX_ATTEMPTS) || 6);  // puis statut « error » (contact à corriger)
export const STATUSES = ['queued', 'sent', 'in_progress', 'action_required', 'done', 'refused', 'error'];

export const ref = (r) => `OUBLI-${r.token}`;
// Compte suspendu par l'administration : plus aucun envoi tant que la suspension court (même règle que auth.js).
const suspended = (u) => !!(u.suspended_at && (!u.suspended_until || u.suspended_until > now()));
// Abonnement actif. Un abonnement offert par clé d’activation (billing_mode 'key', voir keys.js) cesse à sa date de fin,
// même avant que le balayage (expireKeySubscriptions) ne le passe en « canceled ».
export const subscriptionActive = (u) => !!(u && u.subscription_status === 'active'
  && (u.billing_mode !== 'key' || (u.subscription_ends_at && u.subscription_ends_at > now())));
// Accès au service : abonnement actif, ou résilié avec un accès maintenu jusqu’à la fin de la période payée.
export const hasAccess = (u) => subscriptionActive(u) || !!(u && u.subscription_status === 'canceled' && u.subscription_ends_at && u.subscription_ends_at > now());
export const isEligible = (u) => !!(u && !u.deleted_at && !suspended(u) && u.mandate_signed_at && !u.mandate_revoked_at && hasAccess(u));
// Sécurité : en SMTP réel, jamais d’envoi vers un contact non vérifié par l’administrateur. Exception réglable pour un site
// ajouté par un abonné : l’adresse publiée par le site lui-même, sur son propre domaine (AUTO_SEND_SITE_CONTACTS, actif
// par défaut). Une adresse seulement présumée (privacy@domaine) attend toujours la vérification de l’équipe.
const AUTO_SITE = !/^(0|off|false|no)$/i.test(process.env.AUTO_SEND_SITE_CONTACTS || '');
const canMail = (b) => !!b && b.active === 1 && !(b.custom === 1 && b.discovery_status === 'pending')
  && (mailMode !== 'smtp' || b.contact_verified === 1 || ALLOW_UNVERIFIED || (AUTO_SITE && b.custom === 1 && b.contact_source === 'site'));
const backoffDate = (attempts) => new Date(Date.now() + Math.min(24 * 60, 2 ** attempts) * 60000).toISOString(); // 2, 4, 8… min, plafond 24 h
const errMsg = (e) => String(e?.message || e).slice(0, 300);
const insertRequest = (user_id, profile_id, broker_id, cycle) =>
  q.run(`INSERT INTO requests (id, user_id, profile_id, broker_id, cycle, status, token, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`, crypto.randomUUID(), user_id, profile_id, broker_id, cycle, newToken(), now());

// Crée (si besoin) les demandes d’un profil complet. Idempotent : un courtier qui a déjà une demande vivante n’en reçoit
// pas de seconde ; une demande abandonnée par révocation du mandat est relancée dans un nouveau cycle (après re-signature).
export function launchProfile(user, profile) {
  if (!isEligible(user)) return { created: 0, reason: 'Mandat non signé ou abonnement inactif.' };
  if (!profile || profile.user_id !== user.id) return { created: 0, reason: 'Profil introuvable.' };
  if (!profile.first_name || !profile.last_name) return { created: 0, reason: 'Profil incomplet.' };
  const brokers = q.all('SELECT id FROM brokers WHERE active = 1 AND custom = 0 ORDER BY id');   // registre seulement
  const latest = new Map();
  for (const r of q.all('SELECT broker_id, cycle, status, note FROM requests WHERE profile_id = ? ORDER BY cycle, created_at', profile.id)) latest.set(r.broker_id, r);
  let created = 0;
  tx(() => {
    for (const b of brokers) {
      const last = latest.get(b.id);
      if (last && !(last.status === 'refused' && /^Mandat révoqué/.test(last.note || ''))) continue;
      insertRequest(user.id, profile.id, b.id, last ? last.cycle + 1 : 1);
      created += 1;
    }
  });
  if (created) logEvent(user.id, 'launch', `${created} demandes préparées pour ${profile.first_name} ${profile.last_name} (${brokers.length} courtiers surveillés).`, { profile_id: profile.id });
  return { created };
}

// Échec d’envoi : recul exponentiel, puis statut « error » (demande initiale) ou nouvel essai quotidien (relance).
function recordFailure(r, user, broker, e, kind) {
  const attempts = (r.attempts || 0) + 1;
  const message = errMsg(e);
  if (kind === 'initial' && attempts >= MAX_ATTEMPTS) {
    q.run(`UPDATE requests SET status = 'error', attempts = ?, last_error = ?, next_attempt_at = NULL, note = ? WHERE id = ? AND status = 'queued'`, attempts, message, `Envoi impossible après ${attempts} tentatives : ${message}`, r.id);
    logEvent(user.id, 'error', `Envoi impossible à ${broker.name} après ${attempts} tentatives : ${message}`, { profile_id: r.profile_id, request_id: r.id });
    return;
  }
  q.run('UPDATE requests SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?', attempts, message, backoffDate(attempts), r.id);
  if (attempts === 1) logEvent(user.id, 'error', `${kind === 'initial' ? 'Envoi' : 'Relance'} à ${broker.name} différé${kind === 'initial' ? '' : 'e'} : ${message} Nouvel essai automatique.`, { profile_id: r.profile_id, request_id: r.id });
}

async function sendQueued() {
  const t = now();
  const rows = q.all(`SELECT * FROM requests WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`, t, BATCH);
  let sent = 0;
  for (const r of rows) {
    try {
      // Relecture avant chaque envoi : une demande abandonnée (mandat révoqué, profil supprimé) pendant le passage n’est pas traitée.
      if (q.get('SELECT status FROM requests WHERE id = ?', r.id)?.status !== 'queued') continue;
      const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
      const profile = q.get('SELECT * FROM profiles WHERE id = ?', r.profile_id);
      const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
      if (!isEligible(user) || !profile || !canMail(broker)) continue;
      const mail = removalRequest({ profile, broker, user, ref: ref(r), mandateDate: user.mandate_signed_at, url: r.source_url });
      try {
        await sendMail({ to: broker.contact_email, subject: mail.subject, text: mail.text, headers: { 'X-Oubli-Ref': ref(r) }, request_id: r.id, user_id: user.id });
      } catch (e) { recordFailure(r, user, broker, e, 'initial'); continue; }
      const at = now();
      const due = broker.legal_basis === 'ccpa' ? addDays(at, 45) : addMonths(at, 1); // art. 12 §3 RGPD : un mois ; CCPA : 45 jours
      q.run(`UPDATE requests SET status = 'sent', sent_at = ?, due_at = ?, attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND status = 'queued'`, at, due, r.id);
      logEvent(user.id, 'sent', `Demande d’effacement envoyée à ${broker.name} (${broker.legal_basis === 'ccpa' ? 'CCPA' : 'art. 17 RGPD'}).`, { profile_id: r.profile_id, request_id: r.id });
      sent += 1;
    } catch (e) { console.error('[scheduler] envoi', r.id, e); }
  }
  return sent;
}

async function followUps() {
  const t = now();
  const rows = q.all(`SELECT * FROM requests WHERE status IN ('sent', 'in_progress') AND followup_sent_at IS NULL AND due_at IS NOT NULL AND due_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY due_at LIMIT ?`, t, t, BATCH);
  for (const r of rows) {
    try {
      const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
      const profile = q.get('SELECT * FROM profiles WHERE id = ?', r.profile_id);
      const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
      if (!isEligible(user) || !profile || !canMail(broker)) continue;
      const mail = followUp({ broker, ref: ref(r), sentAt: r.sent_at, profile });
      try {
        await sendMail({ to: broker.contact_email, subject: mail.subject, text: mail.text, headers: { 'X-Oubli-Ref': ref(r) }, request_id: r.id, user_id: user.id });
      } catch (e) { recordFailure(r, user, broker, e, 'followup'); continue; }
      q.run(`UPDATE requests SET status = 'in_progress', followup_sent_at = ?, attempts = 0, next_attempt_at = NULL, last_error = NULL, note = 'Relance envoyée à l’échéance légale.' WHERE id = ? AND status IN ('sent', 'in_progress') AND followup_sent_at IS NULL`, now(), r.id);
      logEvent(user.id, 'followup', `Relance envoyée à ${broker.name} : délai légal dépassé sans réponse.`, { profile_id: r.profile_id, request_id: r.id });
    } catch (e) { console.error('[scheduler] relance', r.id, e); }
  }
}

function rechecks() {
  const t = now();
  const rows = q.all(`SELECT * FROM requests WHERE status IN ('done', 'refused') AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`, t, BATCH);
  for (const r of rows) {
    try {
      const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
      const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
      if (!broker || !broker.active) { q.run('UPDATE requests SET next_check_at = NULL WHERE id = ?', r.id); continue; } // courtier retiré du registre : plus de vérification
      if (!isEligible(user)) { q.run('UPDATE requests SET next_check_at = ? WHERE id = ?', addDays(t, 1), r.id); continue; } // abonnement inactif : on réessaie demain
      // Un seul cycle à la fois par courtier et profil : pas de doublon si une demande plus récente existe déjà.
      const newer = q.get('SELECT id FROM requests WHERE profile_id = ? AND broker_id = ? AND cycle > ?', r.profile_id, r.broker_id, r.cycle);
      tx(() => {
        q.run('UPDATE requests SET next_check_at = NULL WHERE id = ?', r.id);
        if (!newer) insertRequest(r.user_id, r.profile_id, r.broker_id, r.cycle + 1);
      });
      if (!newer) logEvent(user.id, 'recheck', r.status === 'refused' ? `Nouvelle demande à ${broker.name} (cycle ${r.cycle + 1}) après son refus.` : `Nouvelle vérification chez ${broker.name} (cycle ${r.cycle + 1}) : une demande est renvoyée.`, { profile_id: r.profile_id });
    } catch (e) { console.error('[scheduler] revérification', r.id, e); }
  }
}

// Applique une réponse de courtier (webhook entrant, opérateur ou simulation) ou une remise en file par l’opérateur.
export async function applyOutcome(r, outcome, note = '') {
  const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
  const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
  if (!user || !broker) return;
  note = String(note || '').slice(0, 300);
  const at = now();
  const ctx = { profile_id: r.profile_id, request_id: r.id };
  if (outcome === 'done') {
    if (r.status === 'done') return; // même confirmation reçue deux fois : rien à refaire
    q.run(`UPDATE requests SET status = 'done', completed_at = ?, next_check_at = ?, next_attempt_at = NULL, note = ? WHERE id = ?`, at, addDays(at, broker.recheck_days), note, r.id);
    logEvent(user.id, 'done', `${broker.name} confirme l’effacement${note ? ' — ' + note : ''}. Nouvelle vérification dans ${broker.recheck_days} jours.`, ctx);
  } else if (outcome === 'action_required') {
    q.run(`UPDATE requests SET status = 'action_required', next_check_at = NULL, note = ? WHERE id = ?`, note || 'Le courtier demande une vérification.', r.id);
    if (r.status === 'action_required') return; // doublon : pas de second e-mail d’alerte
    logEvent(user.id, 'action_required', `${broker.name} demande une vérification avant suppression.`, ctx);
    if (user.deleted_at) return;
    const m = actionRequiredMail({ broker, ref: ref(r) });
    try { await sendMail({ to: user.email, subject: m.subject, text: m.text, request_id: r.id, user_id: user.id }); }
    catch (e) { logEvent(user.id, 'error', `E-mail d’alerte non envoyé : ${errMsg(e)}`, ctx); }
  } else if (outcome === 'refused') {
    q.run(`UPDATE requests SET status = 'refused', next_check_at = ?, next_attempt_at = NULL, note = ? WHERE id = ?`, addDays(at, broker.recheck_days), note || 'Refus du courtier.', r.id);
    logEvent(user.id, 'refused', `${broker.name} refuse la demande : plainte possible auprès de l’autorité de contrôle, nouvelle demande dans ${broker.recheck_days} jours.`, ctx);
  } else if (outcome === 'queued') {
    q.run(`UPDATE requests SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL, next_check_at = NULL, note = ? WHERE id = ?`, note || null, r.id);
    logEvent(user.id, 'queued', `Demande à ${broker.name} remise en file d’envoi${note ? ' — ' + note : ''}.`, ctx);
  } else {
    q.run(`UPDATE requests SET status = 'in_progress', next_check_at = NULL, note = ? WHERE id = ?`, note || 'Accusé de réception, en traitement.', r.id);
    logEvent(user.id, 'in_progress', `${broker.name} accuse réception : demande en traitement.`, ctx);
  }
}

// Mode démo : les courtiers « répondent » en quelques minutes pour montrer le pipeline.
async function simulateReplies() {
  const rows = q.all(`SELECT * FROM requests WHERE status IN ('sent', 'in_progress') AND sent_at <= ? ORDER BY RANDOM() LIMIT 6`, new Date(Date.now() - 45000).toISOString());
  for (const r of rows) {
    try {
      const x = Math.random();
      if (r.status === 'sent') await applyOutcome(r, x < 0.55 ? 'done' : x < 0.85 ? 'in_progress' : 'action_required', x < 0.55 ? 'suppression confirmée (simulation)' : '');
      else if (x < 0.6) await applyOutcome(r, 'done', 'suppression confirmée (simulation)');
    } catch (e) { console.error('[scheduler] simulation', r.id, e); }
  }
}

// Fin des abonnements offerts par clé : passés en « canceled » une fois leur date de fin atteinte (elle reste affichée
// comme fin d’accès). Les demandes en file attendent un nouvel abonnement, comme après une résiliation.
const longDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
export function expireKeySubscriptions(at = now()) {
  const rows = q.all(`SELECT id, subscription_ends_at FROM users WHERE billing_mode = 'key' AND subscription_status = 'active' AND (subscription_ends_at IS NULL OR subscription_ends_at <= ?) AND deleted_at IS NULL`, at);
  let expired = 0;
  for (const u of rows) {
    const r = q.run(`UPDATE users SET subscription_status = 'canceled' WHERE id = ? AND billing_mode = 'key' AND subscription_status = 'active' AND (subscription_ends_at IS NULL OR subscription_ends_at <= ?)`, u.id, at);
    if (!r.changes) continue;
    expired += 1;
    logEvent(u.id, 'account', `Abonnement offert par clé arrivé à échéance${u.subscription_ends_at ? ` le ${longDate(u.subscription_ends_at)}` : ''}\u00a0: plus aucune demande ne part. Choisissez une offre ou activez une nouvelle clé pour reprendre la surveillance.`);
  }
  return expired;
}

function autoLaunch() {
  const profiles = q.all(`SELECT p.* FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.deleted_at IS NULL AND u.mandate_signed_at IS NOT NULL AND u.mandate_revoked_at IS NULL AND u.subscription_status = 'active' AND p.first_name <> '' AND p.last_name <> '' AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.profile_id = p.id)`);
  for (const p of profiles) {
    try { launchProfile(q.get('SELECT * FROM users WHERE id = ?', p.user_id), p); } catch (e) { console.error('[scheduler] lancement', p.id, e); }
  }
}

// Un seul passage à la fois : un tick demandé pendant un passage en cours est fusionné (un nouveau passage suit).
let inflight = null, again = false, lastTick = null;
// Date (ISO) de la fin du dernier passage, affichée dans l’administration.
export const lastTickAt = () => lastTick;
export function tick() {
  if (inflight) { again = true; return inflight; }
  inflight = (async () => {
    do {
      again = false;
      try { expireKeySubscriptions(); autoLaunch(); await sendQueued(); await followUps(); rechecks(); if (DEMO) await simulateReplies(); }
      catch (e) { console.error('[scheduler]', e); }
      lastTick = now();
    } while (again);
  })().finally(() => { inflight = null; });
  return inflight;
}
export function startScheduler() {
  const every = Math.max(1000, Number(process.env.SCHEDULER_INTERVAL_MS) || (DEMO ? 20000 : 60000));
  setTimeout(tick, 1500);
  const h = setInterval(tick, every); h.unref();
  console.log(`[scheduler] actif toutes les ${every / 1000} s · courrier : ${mailMode} · démo : ${DEMO ? 'oui' : 'non'} · réponses attendues sur ${REPLY_TO}`);
}
