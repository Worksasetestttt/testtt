// Rapport mensuel par e-mail : une fois tous les 30 jours au plus par compte, pour les abonnés qui l'ont laissé activé,
// dont le mandat est signé et l'abonnement en cours (même règle que isEligible, scheduler.js : un abonnement offert par
// clé cesse à sa date de fin), et qui ont au moins une demande. Vérifié toutes les heures ; un envoi en échec (adresse
// refusée, panne du serveur d'envoi) est retenté le lendemain (report_retry_at), pas à chaque passage.
import { q, now, addDays, ensureColumn } from './db.js';
import { buildDashboard } from './dashboard.js';
import { sendMail } from './mailer.js';
import { monthlyReport } from './templates.js';
import { linkToken } from './auth.js';

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
// Désinscription en un clic (RFC 8058) : la messagerie appelle l'API en POST (« Se désabonner ») ; le lien du message mène
// à une page de confirmation de l'application. Jeton signé, propre à ce but (auth.js, linkToken).
export function unsubscribeLinks(userId) {
  const qs = new URLSearchParams({ u: userId, t: linkToken('report-unsub', userId) }).toString();
  return { page: `${APP_URL}/app/#unsubscribe?${qs}`, oneClick: `${APP_URL}/api/unsubscribe/report?${qs}` };
}

const PERIOD_DAYS = 30;
let running = false;
ensureColumn('users', 'report_retry_at', 'TEXT');

export function dueUsers(at = now()) {
  return q.all(`SELECT u.* FROM users u WHERE u.deleted_at IS NULL AND u.monthly_report = 1 AND u.mandate_signed_at IS NOT NULL AND u.mandate_revoked_at IS NULL
      AND (u.suspended_at IS NULL OR (u.suspended_until IS NOT NULL AND u.suspended_until <= ?))
      AND ((u.subscription_status = 'active' AND (u.billing_mode IS NOT 'key' OR u.subscription_ends_at > ?)) OR (u.subscription_status = 'canceled' AND u.subscription_ends_at > ?))
      AND COALESCE(u.last_report_at, u.created_at) <= ? AND (u.report_retry_at IS NULL OR u.report_retry_at <= ?)
      AND EXISTS (SELECT 1 FROM requests r WHERE r.user_id = u.id)
    ORDER BY u.created_at LIMIT 200`, at, at, at, addDays(at, -PERIOD_DAYS), at);
}
export async function runMonthlyReports() {
  if (running) return { sent: 0, skipped: true };
  running = true;
  let sent = 0, failed = 0;
  try {
    const since = addDays(now(), -PERIOD_DAYS);
    const month = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    for (const u of dueUsers()) {
      const blocks = q.all('SELECT id FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', u.id).map((p) => {
        const d = buildDashboard(u, p.id), c = d.counters, prof = d.profiles.find((x) => x.id === p.id) || {};
        return { name: `${prof.first_name || ''} ${prof.last_name || ''}`.trim() || 'Votre dossier', done: c.done, doneMonth: d.requests.filter((r) => r.status === 'done' && r.completed_at >= since).length, inProgress: c.in_progress + c.queued, action: c.action_required, refused: c.refused, exposure: d.exposure, total: c.total };
      }).filter((b) => b.total);
      // Rien à rapporter, ou envoi en échec : nouvel essai le lendemain. Sans ce délai, le compte resterait en tête de la
      // sélection à chaque passage (un courrier en échec de plus par heure) et bloquerait les suivants au-delà de 200.
      const retryTomorrow = () => q.run('UPDATE users SET report_retry_at = ? WHERE id = ?', addDays(now(), 1), u.id);
      if (!blocks.length) { retryTomorrow(); continue; }
      const links = unsubscribeLinks(u.id);
      const m = monthlyReport({ month, blocks, unsubscribe: links.page });
      const headers = { 'List-Unsubscribe': `<${links.oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
      try { await sendMail({ to: u.email, subject: m.subject, text: m.text, headers, user_id: u.id }); q.run('UPDATE users SET last_report_at = ?, report_retry_at = NULL WHERE id = ?', now(), u.id); sent += 1; }
      catch (e) { failed += 1; retryTomorrow(); console.error('[rapports] envoi impossible :', e.message); }
    }
  } finally { running = false; }
  return { sent, failed };
}
let timers = [];
export function startReports() {
  const run = () => { runMonthlyReports().catch((e) => console.error('[rapports]', e)); };
  timers = [setInterval(run, 60 * 60000), setTimeout(run, 30000)];
  for (const t of timers) t.unref();
}
// Arrêt du serveur : plus de passage programmé ; attend la fin d'un passage en cours (l'appelant borne l'attente).
export async function stopReports() {
  clearInterval(timers[0]); clearTimeout(timers[1]); timers = [];
  while (running) await new Promise((r) => setTimeout(r, 50));
}
