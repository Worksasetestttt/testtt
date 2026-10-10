// Tableau de bord d'un abonné : compteurs, exposition (valeur courante et historique sur 12 semaines),
// répartition par catégorie et par sensibilité, demandes du cycle courant, journal, échéances.
import { q } from './db.js';
import { ref } from './scheduler.js';
import { publicUser, parseProfile } from './util.js';

const DAY = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);

// Part (en %) des courtiers du cycle courant dont l'effacement n'était pas encore confirmé à une date donnée.
function exposureAt(active, atIso) {
  if (!active.length) return 100;
  const exposed = active.filter((r) => !(r.completed_at && r.completed_at <= atIso && r.status === 'done')).length;
  return Math.round((exposed / active.length) * 100);
}

// 12 points hebdomadaires : la valeur d'une semaine est l'exposition à la fin de cette semaine (bornée à maintenant).
function exposureHistory(active, nowDate) {
  const monday = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate()));
  monday.setTime(monday.getTime() - ((monday.getUTCDay() + 6) % 7) * DAY);
  const out = [];
  for (let k = 11; k >= 0; k -= 1) {
    const weekStart = new Date(monday.getTime() - k * 7 * DAY);
    const boundary = k === 0 ? nowDate : new Date(weekStart.getTime() + 7 * DAY);
    out.push({ week_start: isoDay(weekStart), exposure: exposureAt(active, boundary.toISOString()) });
  }
  return out;
}

function bucket() { return { total: 0, done: 0, action_required: 0, in_progress: 0, queued: 0, refused: 0 }; }
function count(b, r) {
  b.total += 1;
  if (r.status === 'done') b.done += 1;
  else if (r.status === 'action_required') b.action_required += 1;
  else if (r.status === 'refused') b.refused += 1;
  else if (r.status === 'queued') b.queued += 1;
  else b.in_progress += 1; // sent | in_progress
}

export function buildDashboard(u, requestedProfileId) {
  const profiles = q.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at', u.id).map(parseProfile);
  const pid = requestedProfileId && profiles.some((p) => p.id === requestedProfileId) ? requestedProfileId : profiles[0]?.id;
  const rows = q.all(`SELECT r.*, b.name AS broker_name, b.category, b.domain, b.sensitivity, b.legal_basis, b.recheck_days, b.jurisdiction FROM requests r JOIN brokers b ON b.id = r.broker_id WHERE r.profile_id = ? ORDER BY CASE r.status WHEN 'action_required' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'sent' THEN 2 WHEN 'queued' THEN 3 WHEN 'refused' THEN 4 WHEN 'done' THEN 5 ELSE 6 END, b.sensitivity DESC, b.name`, pid);
  const counts = { queued: 0, sent: 0, in_progress: 0, action_required: 0, done: 0, refused: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const total = rows.length;
  const latestByBroker = new Map();
  rows.forEach((r) => { const k = r.broker_id; if (!latestByBroker.has(k) || latestByBroker.get(k).cycle < r.cycle) latestByBroker.set(k, r); });
  const active = [...latestByBroker.values()];
  const nowDate = new Date();
  const exposure = exposureAt(active, nowDate.toISOString());
  const sentTotal = rows.filter((r) => r.sent_at).length;
  const nextCheck = q.get('SELECT MIN(next_check_at) AS d FROM requests WHERE profile_id = ? AND next_check_at IS NOT NULL', pid)?.d || null;
  const nextDue = active.filter((r) => r.due_at && (r.status === 'sent' || r.status === 'in_progress')).map((r) => r.due_at).sort()[0] || null;
  const lastSent = active.filter((r) => r.sent_at).map((r) => r.sent_at).sort().pop() || null;
  // Journal du dossier affiché : les événements de ce profil et ceux du compte (sans profil).
  const events = q.all('SELECT * FROM events WHERE user_id = ? AND (profile_id IS NULL OR profile_id = ?) ORDER BY id DESC LIMIT 40', u.id, pid);
  const brokers = q.get('SELECT COUNT(*) AS c FROM brokers WHERE active = 1').c;

  const byCategory = new Map();
  active.forEach((r) => { if (!byCategory.has(r.category)) byCategory.set(r.category, bucket()); count(byCategory.get(r.category), r); });
  const categories = [...byCategory.entries()].map(([category, b]) => ({ category, ...b })).sort((a, b) => b.total - a.total || a.category.localeCompare(b.category, 'fr'));
  const sensitivity = [3, 2, 1].map((level) => { const b = bucket(); active.filter((r) => r.sensitivity === level).forEach((r) => count(b, r)); return { level, ...b, exposed: b.total - b.done }; });

  const profile = profiles.find((p) => p.id === pid);
  return {
    user: publicUser(u), profiles, profile_id: pid,
    counters: { sent: sentTotal, in_progress: counts.sent + counts.in_progress, action_required: counts.action_required, done: counts.done, queued: counts.queued, refused: counts.refused, total, brokers, active: active.length },
    exposure, next_check_at: nextCheck,
    exposure_history: exposureHistory(active, nowDate),
    categories, sensitivity,
    next_due_at: nextDue, last_sent_at: lastSent,
    last_activity_at: events[0]?.created_at || null,
    requests: active.map((r) => ({ id: r.id, broker: r.broker_name, domain: r.domain, category: r.category, sensitivity: r.sensitivity, legal_basis: r.legal_basis, jurisdiction: r.jurisdiction, recheck_days: r.recheck_days, status: r.status, cycle: r.cycle, created_at: r.created_at, sent_at: r.sent_at, due_at: r.due_at, followup_sent_at: r.followup_sent_at, completed_at: r.completed_at, next_check_at: r.next_check_at, note: r.note, ref: ref(r) })),
    events,
    onboarding: {
      profile_complete: !!(profile?.first_name && profile?.last_name),
      mandate: !!u.mandate_signed_at && !u.mandate_revoked_at,
      subscription: u.subscription_status === 'active',
      max_profiles: u.plan === 'famille' ? 5 : 1,
    },
  };
}
