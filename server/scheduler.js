// Planificateur : envoi des demandes en attente, relances à l'échéance légale,
// nouveau cycle de vérification, et (en mode démo) simulation des réponses des courtiers.
import crypto from 'node:crypto';
import { q, now, addDays, logEvent } from './db.js';
import { sendMail, mailMode, REPLY_TO } from './mailer.js';
import { removalRequest, followUp, actionRequiredMail } from './templates.js';

export const DEMO = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '');
const ALLOW_UNVERIFIED = /^(1|true|yes)$/i.test(process.env.ALLOW_UNVERIFIED_CONTACTS || '');
const BATCH = Number(process.env.SEND_BATCH || 200); // courriers par passage du planificateur

export const ref = (r) => `OUBLI-${r.token}`;
const isEligible = (u) => u && !u.deleted_at && u.mandate_signed_at && !u.mandate_revoked_at && (u.subscription_status === 'active' || (u.subscription_status === 'canceled' && u.subscription_ends_at && u.subscription_ends_at > now()));

// Crée (si besoin) les demandes du cycle 1 pour un profil complet.
export function launchProfile(user, profile) {
  if (!isEligible(user)) return { created: 0, reason: 'Mandat non signé ou abonnement inactif.' };
  if (!profile.first_name || !profile.last_name) return { created: 0, reason: 'Profil incomplet.' };
  const brokers = q.all('SELECT * FROM brokers WHERE active = 1');
  const existing = new Set(q.all('SELECT broker_id FROM requests WHERE profile_id = ?', profile.id).map((r) => r.broker_id));
  let created = 0;
  for (const b of brokers) {
    if (existing.has(b.id)) continue;
    q.run(`INSERT INTO requests (id, user_id, profile_id, broker_id, cycle, status, token, created_at) VALUES (?, ?, ?, ?, 1, 'queued', ?, ?)`,
      crypto.randomUUID(), user.id, profile.id, b.id, crypto.randomBytes(5).toString('hex').toUpperCase(), now());
    created += 1;
  }
  if (created) logEvent(user.id, 'launch', `${created} demandes préparées pour ${profile.first_name} ${profile.last_name} (${brokers.length} courtiers surveillés).`, { profile_id: profile.id });
  return { created };
}

async function sendQueued() {
  const rows = q.all(`SELECT r.* FROM requests r WHERE r.status = 'queued' ORDER BY r.created_at LIMIT ?`, BATCH);
  for (const r of rows) {
    const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
    const profile = q.get('SELECT * FROM profiles WHERE id = ?', r.profile_id);
    const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
    if (!isEligible(user) || !profile || !broker) continue;
    if (mailMode === 'smtp' && !broker.contact_verified && !ALLOW_UNVERIFIED) continue; // sécurité : jamais d'envoi réel vers un contact non vérifié
    const mail = removalRequest({ profile, broker, user, ref: ref(r), mandateDate: user.mandate_signed_at });
    try {
      await sendMail({ to: broker.contact_email, subject: mail.subject, text: mail.text, headers: { 'X-Oubli-Ref': ref(r) }, request_id: r.id, user_id: user.id });
    } catch (e) {
      logEvent(user.id, 'error', `Envoi impossible à ${broker.name} : ${e.message}`, { profile_id: profile.id, request_id: r.id });
      continue;
    }
    const sent = now();
    const due = addDays(sent, broker.legal_basis === 'ccpa' ? 45 : 30);
    q.run(`UPDATE requests SET status = 'sent', sent_at = ?, due_at = ? WHERE id = ?`, sent, due, r.id);
    logEvent(user.id, 'sent', `Demande d'effacement envoyée à ${broker.name} (${broker.legal_basis === 'ccpa' ? 'CCPA' : 'art. 17 RGPD'}).`, { profile_id: profile.id, request_id: r.id });
  }
  return rows.length;
}

async function followUps() {
  const rows = q.all(`SELECT * FROM requests WHERE status IN ('sent') AND due_at <= ? AND followup_sent_at IS NULL LIMIT ?`, now(), BATCH);
  for (const r of rows) {
    const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
    const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
    if (!isEligible(user) || !broker) continue;
    if (mailMode === 'smtp' && !broker.contact_verified && !ALLOW_UNVERIFIED) continue;
    const mail = followUp({ broker, ref: ref(r), sentAt: r.sent_at });
    try { await sendMail({ to: broker.contact_email, subject: mail.subject, text: mail.text, headers: { 'X-Oubli-Ref': ref(r) }, request_id: r.id, user_id: user.id }); } catch (e) { continue; }
    q.run(`UPDATE requests SET status = 'in_progress', followup_sent_at = ?, note = 'Relance envoyée à l''échéance légale.' WHERE id = ?`, now(), r.id);
    logEvent(user.id, 'followup', `Relance envoyée à ${broker.name} : délai légal dépassé sans réponse.`, { profile_id: r.profile_id, request_id: r.id });
  }
}

function rechecks() {
  const rows = q.all(`SELECT * FROM requests WHERE status = 'done' AND next_check_at IS NOT NULL AND next_check_at <= ? LIMIT ?`, now(), BATCH);
  for (const r of rows) {
    const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
    const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
    if (!isEligible(user) || !broker) continue;
    q.run(`UPDATE requests SET next_check_at = NULL WHERE id = ?`, r.id);
    q.run(`INSERT INTO requests (id, user_id, profile_id, broker_id, cycle, status, token, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      crypto.randomUUID(), r.user_id, r.profile_id, r.broker_id, r.cycle + 1, crypto.randomBytes(5).toString('hex').toUpperCase(), now());
    logEvent(user.id, 'recheck', `Nouvelle vérification chez ${broker.name} (cycle ${r.cycle + 1}) : une demande est renvoyée.`, { profile_id: r.profile_id });
  }
}

// Applique une réponse de courtier (webhook entrant, opérateur ou simulation).
export async function applyOutcome(r, outcome, note = '') {
  const user = q.get('SELECT * FROM users WHERE id = ?', r.user_id);
  const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
  if (!user || !broker) return;
  if (outcome === 'done') {
    q.run(`UPDATE requests SET status = 'done', completed_at = ?, next_check_at = ?, note = ? WHERE id = ?`, now(), addDays(now(), broker.recheck_days), note, r.id);
    logEvent(user.id, 'done', `${broker.name} confirme l'effacement${note ? ' — ' + note : ''}. Nouvelle vérification dans ${broker.recheck_days} jours.`, { profile_id: r.profile_id, request_id: r.id });
  } else if (outcome === 'action_required') {
    q.run(`UPDATE requests SET status = 'action_required', note = ? WHERE id = ?`, note || 'Le courtier demande une vérification.', r.id);
    logEvent(user.id, 'action_required', `${broker.name} demande une vérification avant suppression.`, { profile_id: r.profile_id, request_id: r.id });
    const m = actionRequiredMail({ broker, ref: ref(r) });
    try { await sendMail({ to: user.email, subject: m.subject, text: m.text, request_id: r.id, user_id: user.id }); } catch {}
  } else if (outcome === 'refused') {
    q.run(`UPDATE requests SET status = 'refused', note = ? WHERE id = ?`, note || 'Refus du courtier : réclamation à préparer.', r.id);
    logEvent(user.id, 'refused', `${broker.name} refuse la demande : réclamation à préparer auprès de l'autorité de contrôle.`, { profile_id: r.profile_id, request_id: r.id });
  } else {
    q.run(`UPDATE requests SET status = 'in_progress', note = ? WHERE id = ?`, note || 'Accusé de réception, en traitement.', r.id);
    logEvent(user.id, 'in_progress', `${broker.name} accuse réception : demande en traitement.`, { profile_id: r.profile_id, request_id: r.id });
  }
}

// Mode démo : les courtiers « répondent » en quelques minutes pour montrer le pipeline.
async function simulateReplies() {
  const rows = q.all(`SELECT * FROM requests WHERE status IN ('sent', 'in_progress') AND sent_at <= ? ORDER BY RANDOM() LIMIT 6`, new Date(Date.now() - 45000).toISOString());
  for (const r of rows) {
    const x = Math.random();
    if (r.status === 'sent') await applyOutcome(r, x < 0.55 ? 'done' : x < 0.85 ? 'in_progress' : 'action_required', x < 0.55 ? 'suppression confirmée (simulation)' : '');
    else if (x < 0.6) await applyOutcome(r, 'done', 'suppression confirmée (simulation)');
  }
}

function autoLaunch() {
  const profiles = q.all(`SELECT p.*, u.id AS uid FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.deleted_at IS NULL AND u.mandate_signed_at IS NOT NULL AND u.mandate_revoked_at IS NULL AND u.subscription_status = 'active' AND p.first_name <> '' AND p.last_name <> '' AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.profile_id = p.id)`);
  for (const p of profiles) launchProfile(q.get('SELECT * FROM users WHERE id = ?', p.uid), p);
}

let running = false;
export async function tick() {
  if (running) return; running = true;
  try { autoLaunch(); await sendQueued(); await followUps(); rechecks(); if (DEMO) await simulateReplies(); }
  catch (e) { console.error('[scheduler]', e); }
  finally { running = false; }
}
export function startScheduler() {
  const every = Number(process.env.SCHEDULER_INTERVAL_MS || (DEMO ? 20000 : 60000));
  setTimeout(tick, 1500);
  const h = setInterval(tick, every); h.unref();
  console.log(`[scheduler] actif toutes les ${every / 1000} s · courrier : ${mailMode} · démo : ${DEMO ? 'oui' : 'non'} · réponses attendues sur ${REPLY_TO}`);
}
