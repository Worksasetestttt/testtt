// Fil d'exécution d'une sauvegarde (voir backup.js) : sa propre connexion, puis VACUUM INTO vers le fichier cible.
// En WAL, la copie est un instantané cohérent et ne bloque ni les lectures ni les écritures du serveur.
// N'importe pas db.js : aucune migration ni aucun autre effet de bord ne s'exécute ici.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

let db = null;
try {
  db = new DatabaseSync(workerData.source);
  db.exec('PRAGMA busy_timeout = 10000');
  db.prepare('VACUUM INTO ?').run(workerData.target);
  parentPort.postMessage({ ok: true });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message || e) });
} finally {
  try { db?.close(); } catch { /* déjà fermée */ }
}
