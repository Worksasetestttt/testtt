// Tableau de bord d'un abonné : compteurs, exposition, demandes du cycle courant, journal, échéances.
import { q } from './db.js';
import { ref } from './scheduler.js';
import { publicUser, parseProfile } from './util.js';

export function buildDashboard(u, requestedProfileId) {
  const profiles = q.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', u.id).map(parseProfile);
  const pid = requestedProfileId && profiles.some((p) => p.id === requestedProfileId) ? requestedProfileId : profiles[0]?.id;
  const rows = q.all(`SELECT r.*, b.name AS broker_name, b.category, b.domain, b.sensitivity, b.legal_basis, b.recheck_days FROM requests r JOIN brokers b ON b.id = r.broker_id WHERE r.profile_id = ? ORDER BY CASE r.status WHEN 'action_required' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'sent' THEN 2 WHEN 'queued' THEN 3 WHEN 'done' THEN 4 ELSE 5 END, b.sensitivity DESC, b.name`, pid);
  const counts = { queued: 0, sent: 0, in_progress: 0, action_required: 0, done: 0, refused: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const total = rows.length;
  const latestByBroker = new Map();
  rows.forEach((r) => { const k = r.broker_id; if (!latestByBroker.has(k) || latestByBroker.get(k).cycle < r.cycle) latestByBroker.set(k, r); });
  const active = [...latestByBroker.values()];
  const exposed = active.filter((r) => r.status !== 'done').length;
  const exposure = active.length ? Math.round((exposed / active.length) * 100) : 100;
  const sentTotal = rows.filter((r) => r.sent_at).length;
  const nextCheck = q.get('SELECT MIN(next_check_at) AS d FROM requests WHERE profile_id = ? AND next_check_at IS NOT NULL', pid)?.d || null;
  const events = q.all('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 40', u.id);
  const brokers = q.get('SELECT COUNT(*) AS c FROM brokers WHERE active = 1').c;
  return {
    user: publicUser(u), profiles, profile_id: pid,
    counters: { sent: sentTotal, in_progress: counts.sent + counts.in_progress, action_required: counts.action_required, done: counts.done, queued: counts.queued, refused: counts.refused, total, brokers },
    exposure, next_check_at: nextCheck,
    requests: active.map((r) => ({ id: r.id, broker: r.broker_name, domain: r.domain, category: r.category, sensitivity: r.sensitivity, legal_basis: r.legal_basis, status: r.status, cycle: r.cycle, sent_at: r.sent_at, due_at: r.due_at, completed_at: r.completed_at, next_check_at: r.next_check_at, note: r.note, ref: ref(r) })),
    events,
    onboarding: { profile_complete: !!(profiles[0]?.first_name && profiles[0]?.last_name), mandate: !!u.mandate_signed_at && !u.mandate_revoked_at, subscription: u.subscription_status === 'active' },
  };
}
