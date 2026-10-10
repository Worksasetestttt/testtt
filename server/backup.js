// Sauvegardes de la base SQLite : copie cohérente par VACUUM INTO, faite dans un fil d'exécution séparé (le serveur
// continue de répondre pendant la copie), une fois par jour et à la demande (POST /api/admin/backup).
// · BACKUP_DIR vide : désactivé. Un dossier situé dans un dossier servi en statique (assets/, app/) est refusé.
// · Fichiers oubli-<date ISO>.sqlite en 0600 (dossier créé en 0700), écrits sous un nom provisoire (.part) puis
//   renommés : une copie interrompue n'est jamais prise pour une sauvegarde. Les 7 plus récentes sont conservées.
// · Vérification toutes les heures (première une minute après le démarrage) : une copie dès que la dernière a 24 h.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { PUBLIC_DIRS } from './static.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKUP_KEEP = 7;
const DAY = 86400000, HOUR = 3600000, FIRST_CHECK_MS = 60000;
const NAME = /^oubli-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/;
const PART = /^oubli-.+\.sqlite\.part$/;
const DIR = String(process.env.BACKUP_DIR || '').trim() ? path.resolve(String(process.env.BACKUP_DIR).trim()) : null;
const SOURCE = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file || '';

// Chemin réel (liens symboliques résolus), même pour un dossier pas encore créé : on résout son plus proche parent existant.
function real(p) {
  let cur = path.resolve(p), rest = '';
  for (;;) {
    try { return path.join(fs.realpathSync(cur), rest); } catch { /* absent : on remonte */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest = path.join(path.basename(cur), rest); cur = up;
  }
}
const inside = (dir, parent) => dir === parent || dir.startsWith(parent + path.sep);
// Raison pour laquelle les sauvegardes sont impossibles, ou null.
function refusal() {
  if (!DIR) return 'BACKUP_DIR n’est pas défini.';
  if (!SOURCE) return 'DATABASE_PATH ne désigne pas un fichier.';
  const dir = real(DIR);
  if (PUBLIC_DIRS.some((d) => inside(dir, real(path.join(ROOT, d))))) return 'BACKUP_DIR est dans un dossier servi publiquement (assets/ ou app/).';
  return null;
}
// Sauvegardes présentes, de la plus récente à la plus ancienne (le nom porte la date ISO : l'ordre alphabétique suffit).
function listBackups() {
  let names;
  try { names = fs.readdirSync(DIR); } catch { return []; }
  return names.filter((n) => NAME.test(n)).sort().reverse().map((file) => {
    const [, day, h, m, s, ms] = NAME.exec(file);
    let bytes = 0;
    try { bytes = fs.statSync(path.join(DIR, file)).size; } catch { /* supprimée entre-temps */ }
    return { file, at: `${day}T${h}:${m}:${s}.${ms}Z`, bytes };
  });
}
function rotate() {
  for (const b of listBackups().slice(BACKUP_KEEP)) fs.rmSync(path.join(DIR, b.file), { force: true });
  // Copie provisoire de plus d'une heure : reste d'un arrêt brutal pendant une sauvegarde.
  for (const name of fs.readdirSync(DIR)) {
    if (!PART.test(name)) continue;
    try { if (Date.now() - fs.statSync(path.join(DIR, name)).mtimeMs > HOUR) fs.rmSync(path.join(DIR, name), { force: true }); } catch { /* ignoré */ }
  }
}
function vacuumInto(target) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./backup-worker.js', import.meta.url), { workerData: { source: SOURCE, target } });
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    w.once('message', (m) => (m?.ok ? settle(resolve) : settle(reject, new Error(m?.error || 'copie impossible'))));
    w.once('error', (e) => settle(reject, e));
    w.once('exit', (code) => settle(reject, new Error(`fil de sauvegarde arrêté (code ${code})`)));
  });
}

let running = null, lastError = null, timers = [];
// Lance une sauvegarde (ou rejoint celle en cours) → { file, bytes, at, ms }. Rejet si désactivé (code DISABLED).
export function runBackup() {
  const why = refusal();
  if (why) return Promise.reject(Object.assign(new Error(why), { code: 'DISABLED' }));
  if (running) return running;
  running = (async () => {
    await null;   // la suite s'exécute après l'affectation de `running`
    try { return await backupOnce(); }
    catch (e) { lastError = { message: String(e?.message || e).slice(0, 300), at: new Date().toISOString() }; throw e; }
    finally { running = null; }
  })();
  return running;
}
async function backupOnce() {
  const t0 = Date.now(), at = new Date(t0).toISOString();
  const file = `oubli-${at.replace(/[:.]/g, '-')}.sqlite`;
  const target = path.join(DIR, file), part = `${target}.part`;
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try {
    await vacuumInto(part);
    fs.chmodSync(part, 0o600);
    fs.renameSync(part, target);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignoré */ }
    throw e;
  }
  try { rotate(); } catch (e) { console.error('[sauvegarde] rotation :', e.message); }
  lastError = null;
  return { file, bytes: fs.statSync(target).size, at, ms: Date.now() - t0 };
}

// État affiché dans l'administration (onglet Système).
export function backupStatus() {
  const why = refusal();
  if (why) return { enabled: false, reason: why, keep: BACKUP_KEEP };
  const list = listBackups(), last = list[0] || null;
  return { enabled: true, dir: DIR, keep: BACKUP_KEEP, count: list.length, running: !!running, last, next_at: last ? new Date(Date.parse(last.at) + DAY).toISOString() : null, last_error: lastError };
}

export function startBackups() {
  if (!DIR) return;
  const why = refusal();
  if (why) { console.error(`[sauvegarde] désactivée : ${why}`); return; }
  const check = () => {
    if (running) return;
    const last = listBackups()[0];
    if (last && Date.now() - Date.parse(last.at) < DAY) return;
    runBackup().then((r) => console.log(`[sauvegarde] ${r.file} (${r.bytes} octets, ${r.ms} ms)`), (e) => console.error('[sauvegarde] échec :', e.message));
  };
  timers = [setTimeout(check, FIRST_CHECK_MS), setInterval(check, HOUR)];
  for (const t of timers) t.unref();
  console.log(`[sauvegarde] quotidienne dans ${DIR} (${BACKUP_KEEP} conservées)`);
}
// Arrêt : plus de sauvegarde programmée ; attend la fin d'une copie en cours (l'appelant borne l'attente).
export async function stopBackups() {
  clearTimeout(timers[0]); clearInterval(timers[1]); timers = [];
  if (running) await running.catch(() => {});
}
