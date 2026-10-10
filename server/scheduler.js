// Planificateur : envoi des demandes en attente, relances à l’échéance légale, nouveau cycle de vérification,
// et (en mode démo) simulation des réponses des courtiers.
//
// Machine à états d’une demande : queued → sent → (in_progress | action_required | done | refused)
//   · action_required → in_progress (vérification fournie par l’abonné, routes.js)
//   · done | refused → nouveau cycle (nouvelle demande queued, cycle + 1) quand next_check_at est atteint ; un refus
//     programme ce nouvel envoi après recheck_days jours, et l’abonné peut relancer plus tôt (sites.js, relaunchRequest)
//   · queued → error après SEND_MAX_ATTEMPTS échecs d’envoi (recul exponentiel entre deux essais) ; error → queued par le
//     renvoi de l’administration (admin.js, essais et recul remis à zéro) ou applyOutcome(r, 'queued')
//   · queued → refused quand le mandat est révoqué (routes.js) ; ces demandes sont relancées dans un nouveau cycle après re-signature.
//   · queued | error → refused quand le courtier est retiré du registre (admin.js, stopRemovedBrokerRequests) ; un nouveau
//     cycle repart à sa réactivation. Ces deux arrêts ne sont pas des refus (stopCause) : ni plainte ni revérification.
//   · une réponse « en cours » ou « vérification demandée » ne s’applique qu’à une demande en attente du courtier
//     (sent, in_progress, action_required) : jamais à une demande en file, en erreur, effacée ou refusée (applyOutcome).
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
// Nouvelle demande (cycle afterCycle + 1, 1 pour un premier envoi) à un courtier, sauf si ce profil a déjà une demande
// plus récente pour lui. La condition est vérifiée dans l'instruction même : deux lancements simultanés (deux instances
// sur la même base) ne créent jamais deux fois la même demande. Cela suppose que la transaction appelante commence par
// une écriture (cette insertion, ou une mise à jour) : elle attend alors le verrou d'écriture et lit l'état validé par
// l'autre instance. Une lecture préalable dans la transaction (newToken) figerait un instantané périmé.
// source_url : adresse de la fiche signalée par l'abonné, reprise d'un cycle à l'autre (citée dans le courrier).
// Renvoie 1 si la demande a été créée, 0 sinon.
const insertNext = (user_id, profile_id, broker_id, afterCycle, source_url = null, token = newToken()) => Number(q.run(
  `INSERT INTO requests (id, user_id, profile_id, broker_id, cycle, status, token, created_at, source_url)
   SELECT ?, ?, ?, ?, ?, 'queued', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM requests WHERE profile_id = ? AND broker_id = ? AND cycle > ?)`,
  crypto.randomUUID(), user_id, profile_id, broker_id, afterCycle + 1, token, now(), source_url, profile_id, broker_id, afterCycle).changes);
// Demande arrêtée avant son envoi : « refused » en base (la machine à états la traite comme close), mais pas un refus du
// courtier. La note en donne la cause : « mandate » (mandat révoqué par l'abonné, routes.js) ou « broker » (courtier ou
// site retiré du registre par l'équipe, admin.js). Le tableau de bord, son CSV et le rapport mensuel la montrent sous le
// statut virtuel « stopped » (dashboard.js), sans plainte.
export const BROKER_STOP_NOTE = 'Courtier retiré du registre par l’équipe Oubli avant l’envoi.';
export const stopCause = (r) => (r?.status !== 'refused' ? null : /^Mandat révoqué/.test(r.note || '') ? 'mandate' : /^Courtier retiré/.test(r.note || '') ? 'broker' : null);
const STOP_NOTE_SQL = `(r.note LIKE 'Mandat révoqué%' OR r.note LIKE 'Courtier retiré%')`;

// Crée (si besoin) les demandes d’un profil complet. Idempotent : un courtier qui a déjà une demande vivante n’en reçoit
// pas de seconde ; un courtier actif du registre sans demande (nouveau profil, courtier ajouté) en reçoit une de cycle 1 ;
// une demande arrêtée avant son envoi (mandat révoqué, courtier retiré du registre) est relancée dans un nouveau cycle
// dès que le mandat est re-signé et que le courtier est actif, y compris pour un site que l'abonné avait ajouté (les
// autres sites ajoutés ne concernent que leurs propres profils).
export function launchProfile(user, profile) {
  if (!isEligible(user)) return { created: 0, reason: 'Mandat non signé ou abonnement inactif.' };
  if (!profile || profile.user_id !== user.id) return { created: 0, reason: 'Profil introuvable.' };
  if (!profile.first_name || !profile.last_name) return { created: 0, reason: 'Profil incomplet.' };
  const brokers = q.all('SELECT id, custom FROM brokers WHERE active = 1 AND (custom = 0 OR id IN (SELECT broker_id FROM requests WHERE profile_id = ?)) ORDER BY id', profile.id);
  const latest = new Map();
  for (const r of q.all('SELECT broker_id, cycle, status, note, source_url FROM requests WHERE profile_id = ? ORDER BY cycle, created_at', profile.id)) latest.set(r.broker_id, r);
  // Jetons tirés avant la transaction : sa première instruction est une insertion (voir insertNext).
  const todo = brokers.map((b) => ({ b, last: latest.get(b.id) })).filter(({ b, last }) => (last ? !!stopCause(last) : !b.custom)).map((x) => ({ ...x, token: newToken() }));
  let created = 0;
  if (todo.length) tx(() => { for (const { b, last, token } of todo) created += insertNext(user.id, profile.id, b.id, last ? last.cycle : 0, last?.source_url || null, token); });
  if (created) logEvent(user.id, 'launch', `${created} demande${created > 1 ? 's' : ''} préparée${created > 1 ? 's' : ''} pour ${profile.first_name} ${profile.last_name} (${brokers.filter((b) => !b.custom).length} courtiers surveillés).`, { profile_id: profile.id });
  return { created };
}

// Échec d’envoi : recul exponentiel, puis statut « error » (demande initiale) ou nouvel essai quotidien (relance).
// Le message brut du serveur d’envoi (hôte, port, refus d’authentification…) ne va que dans last_error, lu par
// l’administration : le journal et la note, que l’abonné voit et exporte, gardent un texte générique.
function recordFailure(r, user, broker, e, kind) {
  const attempts = (r.attempts || 0) + 1;
  const message = errMsg(e);
  if (kind === 'initial' && attempts >= MAX_ATTEMPTS) {
    q.run(`UPDATE requests SET status = 'error', attempts = ?, last_error = ?, next_attempt_at = NULL, note = ? WHERE id = ? AND status = 'queued'`, attempts, message, `Envoi impossible après ${attempts} tentatives : notre équipe vérifie l’adresse de contact.`, r.id);
    logEvent(user.id, 'error', `Envoi impossible à ${broker.name} après ${attempts} tentatives : notre équipe vérifie l’adresse de contact, puis la demande repart.`, { profile_id: r.profile_id, request_id: r.id });
    return;
  }
  q.run('UPDATE requests SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?', attempts, message, backoffDate(attempts), r.id);
  if (attempts === 1) logEvent(user.id, 'error', `${kind === 'initial' ? 'Envoi' : 'Relance'} à ${broker.name} différé${kind === 'initial' ? '' : 'e'} : le courrier n’a pas pu partir. Nouvel essai automatique.`, { profile_id: r.profile_id, request_id: r.id });
}

async function sendQueued() {
  const t = now();
  const rows = q.all(`SELECT * FROM requests WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`, t, BATCH);
  let sent = 0;
  for (const r of rows) {
    if (stopped) break;   // arrêt du serveur : on s’interrompt entre deux courriers
    beat = Date.now();
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
    if (stopped) break;
    beat = Date.now();
    try {
      // Relecture avant chaque envoi, comme pour les demandes : une réponse reçue pendant le passage (envoi SMTP lent)
      // rend la relance sans objet.
      const cur = q.get('SELECT status, followup_sent_at FROM requests WHERE id = ?', r.id);
      if (!cur || !['sent', 'in_progress'].includes(cur.status) || cur.followup_sent_at) continue;
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
      const created = tx(() => {
        q.run('UPDATE requests SET next_check_at = NULL WHERE id = ?', r.id);
        return insertNext(r.user_id, r.profile_id, r.broker_id, r.cycle, r.source_url);   // la fiche signalée reste citée
      });
      if (created) logEvent(user.id, 'recheck', r.status === 'refused' ? `Nouvelle demande à ${broker.name} (cycle ${r.cycle + 1}) après son refus.` : `Nouvelle vérification chez ${broker.name} (cycle ${r.cycle + 1}) : une demande est renvoyée.`, { profile_id: r.profile_id });
    } catch (e) { console.error('[scheduler] revérification', r.id, e); }
  }
}

// Courtier retiré du registre (désactivé par l'équipe) : ses demandes jamais envoyées, en file ou en erreur, sont closes
// sans revérification et l'abonné en est informé dans son journal. Avec brokerId : un courtier (désactivation dans
// l'administration) ; sans : tous les courtiers inactifs, à chaque passage (base antérieure à ce correctif, demande remise
// en file entre-temps). Renvoie le nombre de demandes arrêtées.
export function stopRemovedBrokerRequests(brokerId = null) {
  const one = brokerId != null;
  const rows = q.all(`SELECT r.id, r.user_id, r.profile_id, b.name, b.custom FROM requests r JOIN brokers b ON b.id = r.broker_id
    WHERE b.active = 0 AND r.status IN ('queued', 'error')${one ? ' AND b.id = ?' : ` LIMIT ${BATCH}`}`, ...(one ? [brokerId] : []));
  let n = 0;
  for (const r of rows) {
    if (!q.run(`UPDATE requests SET status = 'refused', note = ?, next_check_at = NULL, next_attempt_at = NULL WHERE id = ? AND status IN ('queued', 'error')`, BROKER_STOP_NOTE, r.id).changes) continue;
    n += 1;
    logEvent(r.user_id, 'stopped', r.custom
      ? `Site ${r.name} retiré du service par notre équipe : la demande ne lui a pas été envoyée. Ce n’est pas un refus ; une nouvelle demande partira s’il est rétabli.`
      : `Courtier ${r.name} retiré de notre registre : la demande ne lui a pas été envoyée. Ce n’est pas un refus ; une nouvelle demande partira s’il y revient.`, { profile_id: r.profile_id, request_id: r.id });
  }
  return n;
}

// Un accusé de réception ou une demande de vérification suppose une demande en attente du courtier : sans objet pour une
// demande jamais partie (file, erreur), qu'elle bloquerait sans échéance, ou déjà close (effacée, refusée), dont la
// revérification serait perdue et que la relance rouvrirait auprès d'un courtier qui a déjà répondu.
const AWAITING = ['sent', 'in_progress', 'action_required'];

// Applique une réponse de courtier (webhook entrant, opérateur ou simulation) ou une remise en file par l’opérateur.
// Renvoie { applied } ; { applied: false, error } quand la réponse ne s'applique pas à l'état de la demande.
// message : texte du journal de l'abonné pour « en cours », à la place de l'accusé de réception (réponse à vérifier).
export async function applyOutcome(r, outcome, note = '', { message } = {}) {
  const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
  const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
  if (!user || !broker) return { applied: false };
  if ((outcome === 'in_progress' || outcome === 'action_required') && !AWAITING.includes(r.status)) {
    return { applied: false, error: ['done', 'refused'].includes(r.status) ? 'Cette demande est close (effacée ou refusée) : un accusé de réception ou une demande de vérification ne la rouvre pas.' : 'Cette demande n’est pas encore partie : elle ne peut être ni en cours de traitement ni en attente de vérification.' };
  }
  note = String(note || '').slice(0, 300);
  const at = now();
  const ctx = { profile_id: r.profile_id, request_id: r.id };
  if (outcome === 'done') {
    if (r.status === 'done') return { applied: false }; // même confirmation reçue deux fois : rien à refaire
    q.run(`UPDATE requests SET status = 'done', completed_at = ?, next_check_at = ?, next_attempt_at = NULL, note = ? WHERE id = ?`, at, addDays(at, broker.recheck_days), note, r.id);
    logEvent(user.id, 'done', `${broker.name} confirme l’effacement${note ? ' — ' + note : ''}. Nouvelle vérification dans ${broker.recheck_days} jours.`, ctx);
  } else if (outcome === 'action_required') {
    q.run(`UPDATE requests SET status = 'action_required', next_check_at = NULL, note = ? WHERE id = ?`, note || 'Le courtier demande une vérification.', r.id);
    if (r.status === 'action_required') return { applied: true }; // doublon : pas de second e-mail d’alerte
    logEvent(user.id, 'action_required', `${broker.name} demande une vérification avant suppression.`, ctx);
    if (user.deleted_at) return { applied: true };
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
    logEvent(user.id, 'in_progress', message || `${broker.name} accuse réception : demande en traitement.`, ctx);
  }
  return { applied: true };
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

// Lancement automatique des profils éligibles (même règle que isEligible, écrite en SQL ; launchProfile la revérifie).
// · À chaque passage, requête légère : les profils sans aucune demande (nouveau dossier).
// · Au démarrage, quand le registre change (courtier ajouté dans brokers.json ou par l'administration, réactivé), sur
//   demande (requestFullScan : abonnement réactivé, suspension levée, courtier ou site réactivé…) et toutes les 10 minutes :
//   les profils à qui il manque une demande pour un courtier actif du registre (custom = 0), ou dont la dernière demande
//   à un courtier actif a été arrêtée avant son envoi (stopCause). Cette recherche coûte une lecture d'index
//   (idx_requests_broker) par courtier et par profil, environ 0,6 s pour 20 000 profils : elle n'a donc pas lieu à chaque
//   passage, et se fait par tranches de profils pour laisser passer les requêtes HTTP.
// Aucun doublon : launchProfile n'insère qu'une demande absente (insertNext).
const SCAN_EVERY_MS = 10 * 60000, SCAN_CHUNK = 1000;
const ELIGIBLE_SQL = `u.deleted_at IS NULL AND u.mandate_signed_at IS NOT NULL AND u.mandate_revoked_at IS NULL
  AND (u.suspended_at IS NULL OR (u.suspended_until IS NOT NULL AND u.suspended_until <= :at))
  AND ((u.subscription_status = 'active' AND (u.billing_mode IS NOT 'key' OR u.subscription_ends_at > :at)) OR (u.subscription_status = 'canceled' AND u.subscription_ends_at > :at))
  AND p.first_name <> '' AND p.last_name <> ''`;
const MISSING_SQL = 'EXISTS (SELECT 1 FROM brokers b WHERE b.active = 1 AND b.custom = 0 AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.profile_id = p.id AND r.broker_id = b.id))';
const RELAUNCH_SQL = `EXISTS (SELECT 1 FROM requests r JOIN brokers b ON b.id = r.broker_id WHERE r.profile_id = p.id AND r.status = 'refused' AND ${STOP_NOTE_SQL} AND b.active = 1
  AND NOT EXISTS (SELECT 1 FROM requests n WHERE n.profile_id = r.profile_id AND n.broker_id = r.broker_id AND n.cycle > r.cycle))`;
let scannedRegistry = null, scannedAt = 0, scanWanted = false;
// Demande une recherche complète au prochain passage (un profil a pu redevenir éligible).
export const requestFullScan = () => { scanWanted = true; };
async function autoLaunch() {
  const at = now();
  const launch = (p) => { try { launchProfile(q.get('SELECT * FROM users WHERE id = ?', p.user_id), p); } catch (e) { console.error('[scheduler] lancement', p.id, e); } };
  const registry = q.get('SELECT group_concat(id) AS ids FROM (SELECT id FROM brokers WHERE active = 1 AND custom = 0 ORDER BY id)').ids || '';
  if (!scanWanted && registry === scannedRegistry && Date.now() - scannedAt < SCAN_EVERY_MS) {
    for (const p of q.all(`SELECT p.* FROM profiles p JOIN users u ON u.id = p.user_id WHERE ${ELIGIBLE_SQL} AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.profile_id = p.id)`, { at })) launch(p);
    return;
  }
  scanWanted = false;
  const last = q.get('SELECT MAX(rowid) AS m FROM profiles').m || 0;
  for (let lo = 0; lo < last && !stopped; lo += SCAN_CHUNK) {
    for (const p of q.all(`SELECT p.* FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.rowid > :lo AND p.rowid <= :hi AND ${ELIGIBLE_SQL} AND (${MISSING_SQL} OR ${RELAUNCH_SQL})`, { at, lo, hi: lo + SCAN_CHUNK })) launch(p);
    beat = Date.now();
    await new Promise((r) => setImmediate(r));
  }
  if (!stopped) { scannedRegistry = registry; scannedAt = Date.now(); }   // registre modifié pendant la recherche : elle reprend au passage suivant
}

// Un seul passage à la fois : un tick demandé pendant un passage en cours est fusionné (un nouveau passage suit).
let inflight = null, again = false, lastTick = null;
// Signe de vie (ms) : début et fin de passage, et chaque demande traitée ; un long passage qui avance reste « vivant ».
let beat = null, every = null, startedAt = null, stopped = false, timers = [];
// Date (ISO) de la fin du dernier passage, affichée dans l’administration.
export const lastTickAt = () => lastTick;
// État lu par /api/health (health.js) : un planificateur sans signe de vie depuis trois intervalles est figé.
export const schedulerState = () => ({ startedAt, intervalMs: every, lastTickAt: lastTick, lastBeatAt: beat, running: !!inflight, stopped });
export function tick() {
  if (stopped) return Promise.resolve();
  if (inflight) { again = true; return inflight; }
  inflight = (async () => {
    do {
      again = false;
      beat = Date.now();
      try { expireKeySubscriptions(); stopRemovedBrokerRequests(); await autoLaunch(); await sendQueued(); await followUps(); rechecks(); if (DEMO) await simulateReplies(); }
      catch (e) { console.error('[scheduler]', e); }
      lastTick = now();
      beat = Date.now();
    } while (again && !stopped);
  })().finally(() => { inflight = null; });
  return inflight;
}
export function startScheduler() {
  every = Math.max(1000, Number(process.env.SCHEDULER_INTERVAL_MS) || (DEMO ? 20000 : 60000));
  startedAt = Date.now(); stopped = false;
  timers = [setTimeout(tick, 1500), setInterval(tick, every)];
  timers[1].unref();
  console.log(`[scheduler] actif toutes les ${every / 1000} s · courrier : ${mailMode} · démo : ${DEMO ? 'oui' : 'non'} · réponses attendues sur ${REPLY_TO}`);
}
// Arrêt du serveur : plus aucun passage. Renvoie la promesse du passage en cours, à attendre (avec une limite) avant de
// fermer la base.
export function stopScheduler() {
  stopped = true;
  clearTimeout(timers[0]); clearInterval(timers[1]); timers = [];
  return inflight || Promise.resolve();
}
