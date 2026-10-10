// Rapport mensuel par e-mail : une fois tous les 30 jours au plus par compte, pour les abonnés qui l'ont laissé activé,
// dont le mandat est signé et l'abonnement en cours (même règle que isEligible, scheduler.js : un abonnement offert par
// clé cesse à sa date de fin), et qui ont au moins une demande. Vérifié toutes les heures.
import { q, now, addDays } from './db.js';
import { buildDashboard } from './dashboard.js';
import { sendMail } from './mailer.js';
import { monthlyReport } from './templates.js';

const PERIOD_DAYS = 30;
let running = false;

export function dueUsers(at = now()) {
  return q.all(`SELECT u.* FROM users u WHERE u.deleted_at IS NULL AND u.monthly_report = 1 AND u.mandate_signed_at IS NOT NULL AND u.mandate_revoked_at IS NULL
      AND (u.suspended_at IS NULL OR (u.suspended_until IS NOT NULL AND u.suspended_until <= ?))
      AND ((u.subscription_status = 'active' AND (u.billing_mode IS NOT 'key' OR u.subscription_ends_at > ?)) OR (u.subscription_status = 'canceled' AND u.subscription_ends_at > ?))
      AND COALESCE(u.last_report_at, u.created_at) <= ?
      AND EXISTS (SELECT 1 FROM requests r WHERE r.user_id = u.id)
    ORDER BY u.created_at LIMIT 200`, at, at, at, addDays(at, -PERIOD_DAYS));
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
      if (!blocks.length) continue;
      const m = monthlyReport({ month, blocks });
      try { await sendMail({ to: u.email, subject: m.subject, text: m.text, user_id: u.id }); q.run('UPDATE users SET last_report_at = ? WHERE id = ?', now(), u.id); sent += 1; }
      catch (e) { failed += 1; console.error('[rapports] envoi impossible :', e.message); }
    }
  } finally { running = false; }
  return { sent, failed };
}
export function startReports() {
  const h = setInterval(() => { runMonthlyReports().catch((e) => console.error('[rapports]', e)); }, 60 * 60000); h.unref();
  setTimeout(() => { runMonthlyReports().catch((e) => console.error('[rapports]', e)); }, 30000).unref();
}
