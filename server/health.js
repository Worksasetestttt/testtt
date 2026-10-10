// Santé « profonde » de /api/health (module sans dépendance : routes.js lui passe l'état de la base et du planificateur).
// · base : la connexion répond (SELECT 1) ;
// · planificateur : son dernier signe de vie (fin de passage, ou demande traitée pendant un long passage) date de moins
//   de trois intervalles ; avant le premier passage, une marge de démarrage s'ajoute ;
// · arrêt en cours : 503, pour qu'un répartiteur de charge cesse d'envoyer du trafic.
// Le détail renvoyé se limite à des états (« ok », « error », « stale »…) : jamais de message d'erreur ni de chemin.
export const STARTUP_GRACE_MS = 30000;
let draining = false;
export const markDraining = () => { draining = true; };
export const isDraining = () => draining;

// s : { startedAt, intervalMs, lastBeatAt, stopped } (scheduler.js, schedulerState) ; horodatages en millisecondes.
export function schedulerHealth(s, nowMs = Date.now()) {
  if (!s || !s.startedAt || !s.intervalMs || s.stopped) return 'stopped';
  const limit = 3 * s.intervalMs;
  if (s.lastBeatAt == null) return nowMs - s.startedAt <= limit + STARTUP_GRACE_MS ? 'starting' : 'stale';
  return nowMs - s.lastBeatAt <= limit ? 'ok' : 'stale';
}

// → { ok, checks } ; ok vaut false (réponse 503) si la base ne répond pas, si le planificateur est figé ou arrêté,
// ou pendant l'arrêt du serveur.
export function evaluateHealth({ db, scheduler, stopping = draining, nowMs = Date.now() }) {
  const checks = { db: db ? 'ok' : 'error', scheduler: schedulerHealth(scheduler, nowMs) };
  if (stopping) checks.server = 'stopping';
  return { ok: !!db && (checks.scheduler === 'ok' || checks.scheduler === 'starting') && !stopping, checks };
}
