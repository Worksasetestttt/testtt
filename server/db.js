// Base de données SQLite (module natif node:sqlite, aucune dépendance native).
// Le schéma est créé à la volée. Une base existante est mise à niveau au démarrage : ensureColumn() ajoute les
// colonnes manquantes (PRAGMA table_info), les index sont créés s’ils n’existent pas, les jetons dupliqués sont
// régénérés avant la pose de l’index unique, et le registre de courtiers est resynchronisé sans écraser les
// champs gérés par l’administrateur.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'oubli.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
// WAL + synchronous=NORMAL : aucune corruption possible, seules les toutes dernières transactions peuvent être perdues
// en cas de coupure de courant ; bien moins de fsync qu'en FULL.
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  plan TEXT,                         -- individuel | famille
  billing TEXT,                      -- monthly | annual
  subscription_status TEXT NOT NULL DEFAULT 'none', -- none | active | past_due | canceled
  subscription_ends_at TEXT,
  billing_mode TEXT,                 -- stripe | simulated | manual | key (clé d’activation, fin à subscription_ends_at)
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  mandate_signed_at TEXT,
  mandate_name TEXT,
  mandate_ip TEXT,
  mandate_version TEXT,
  mandate_revoked_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  birth_date TEXT,
  country TEXT NOT NULL DEFAULT 'FR',
  emails TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  addresses TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS brokers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  category TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,        -- FR | EU | UK | US | CA | CH
  legal_basis TEXT NOT NULL,         -- rgpd | ccpa | both
  contact_email TEXT NOT NULL,
  contact_verified INTEGER NOT NULL DEFAULT 0,
  sensitivity INTEGER NOT NULL DEFAULT 2,
  recheck_days INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1
);
-- Les demandes d’un profil supprimé disparaissent avec lui (ON DELETE CASCADE) : plus rien n’est envoyé en son nom.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  broker_id INTEGER NOT NULL REFERENCES brokers(id),
  cycle INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | in_progress | action_required | done | refused | error
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  due_at TEXT,
  followup_sent_at TEXT,
  completed_at TEXT,
  next_check_at TEXT,
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, -- tentatives d’envoi du courrier en cours (demande initiale ou relance)
  next_attempt_at TEXT,                -- prochain essai après un échec d’envoi (recul exponentiel)
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  profile_id TEXT,
  request_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  user_id TEXT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  mode TEXT NOT NULL,                -- smtp | outbox
  message_id TEXT,
  error TEXT,                        -- renseigné quand l’envoi a échoué (message_id NULL)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS newsletter (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  subject TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Événements Stripe déjà traités : un webhook rejoué (même id) est ignoré.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

/* ---------- Mise à niveau d’une base existante ---------- */
// Ajoute une colonne absente d’une table (ALTER TABLE … ADD COLUMN). Idempotent ; renvoie true si la colonne a été ajoutée.
export function ensureColumn(table, column, ddl) {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error('Nom de table ou de colonne invalide.');
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}
ensureColumn('requests', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('requests', 'next_attempt_at', 'TEXT');
ensureColumn('requests', 'last_error', 'TEXT');
ensureColumn('mails', 'error', 'TEXT');
// Sites ajoutés par les abonnés (sites.js) : courtiers « personnalisés », hors registre public et hors lancement global.
ensureColumn('brokers', 'custom', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('brokers', 'contact_source', 'TEXT');      // site (publiée par le site) | guess (présumée) | admin
ensureColumn('brokers', 'contact_page', 'TEXT');        // page où l'adresse a été trouvée
ensureColumn('brokers', 'discovery_status', 'TEXT');    // pending | found | not_found | failed | skipped
ensureColumn('brokers', 'discovered_at', 'TEXT');
ensureColumn('brokers', 'added_by', 'TEXT');
ensureColumn('brokers', 'created_at', 'TEXT');
ensureColumn('requests', 'source_url', 'TEXT');         // page où figure la fiche, citée dans le courrier
// Rapport mensuel par e-mail (reports.js) : activé par défaut, désactivable dans les paramètres.
ensureColumn('users', 'monthly_report', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'last_report_at', 'TEXT');

// Refus enregistrés avant que le refus ne programme un nouveau cycle : la dernière demande refusée par un courtier actif
// (hors arrêts avant envoi : mandat révoqué, courtier retiré du registre) reçoit sa date de nouvelle demande. Sans effet
// une fois ce cycle créé.
db.exec(`UPDATE requests SET next_check_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || (SELECT recheck_days FROM brokers b WHERE b.id = requests.broker_id) || ' days')
  WHERE status = 'refused' AND next_check_at IS NULL AND COALESCE(note, '') NOT LIKE 'Mandat révoqué%' AND COALESCE(note, '') NOT LIKE 'Courtier retiré%'
    AND EXISTS (SELECT 1 FROM brokers b WHERE b.id = requests.broker_id AND b.active = 1)
    AND NOT EXISTS (SELECT 1 FROM requests r2 WHERE r2.profile_id = requests.profile_id AND r2.broker_id = requests.broker_id AND r2.cycle > requests.cycle)`);

// Jeton de référence (OUBLI-XXXXXXXXXX) : il identifie une demande dans les réponses des courtiers, donc il est unique.
export function newToken() {
  for (;;) {
    const t = crypto.randomBytes(5).toString('hex').toUpperCase();
    if (!db.prepare('SELECT 1 FROM requests WHERE token = ?').get(t)) return t;
  }
}
for (const { token } of db.prepare('SELECT token FROM requests GROUP BY token HAVING COUNT(*) > 1').all()) {
  for (const r of db.prepare('SELECT id FROM requests WHERE token = ? ORDER BY created_at, id').all(token).slice(1)) {
    db.prepare('UPDATE requests SET token = ? WHERE id = ?').run(newToken(), r.id);
  }
}

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_token ON requests(token);
CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_profile ON requests(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_broker ON requests(profile_id, broker_id, cycle);
CREATE INDEX IF NOT EXISTS idx_requests_due ON requests(due_at);
CREATE INDEX IF NOT EXISTS idx_requests_next_check ON requests(next_check_at);
CREATE INDEX IF NOT EXISTS idx_brokers_registry ON brokers(id) WHERE custom = 0 AND active = 1;
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_mails_request ON mails(request_id);
CREATE INDEX IF NOT EXISTS idx_mails_user ON mails(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_subscription ON users(stripe_subscription_id);
`);

/* ---------- Clés d’activation (keys.js) ---------- */
// Abonnement offert sans paiement. La clé en clair (OUBLI-XXXX-XXXX-XXXX) n’est jamais stockée : seulement l’empreinte
// SHA-256 de sa forme normalisée et ses 4 derniers caractères (hint), pour la reconnaître. Le CHECK sur uses garantit
// au niveau de la base qu’une clé ne dépasse jamais son nombre d’utilisations.
db.exec(`
CREATE TABLE IF NOT EXISTS activation_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  plan TEXT NOT NULL,                -- individuel | famille
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 730),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  expires_at TEXT,                   -- date limite d’utilisation (facultative)
  note TEXT,
  batch TEXT NOT NULL,               -- lot de création
  created_by TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE TABLE IF NOT EXISTS key_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL REFERENCES activation_keys(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  UNIQUE (key_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_activation_keys_batch ON activation_keys(batch);
CREATE INDEX IF NOT EXISTS idx_activation_keys_created ON activation_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_key_redemptions_user ON key_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_key_ends ON users(subscription_ends_at) WHERE billing_mode = 'key' AND subscription_status = 'active';
`);

/* ---------- Registre de courtiers ---------- */
// brokers.json est la source : chaque démarrage ajoute les courtiers nouveaux et rafraîchit les champs descriptifs.
// Les champs gérés par l’administrateur (contact, vérification, activation) sont conservés ; seule l’adresse générée
// par défaut (privacy@domaine) d’un contact encore non vérifié est remplacée par celle du registre.
{
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'brokers.json'), 'utf8'));
  const upsert = db.prepare(`INSERT INTO brokers (slug, name, domain, category, jurisdiction, legal_basis, contact_email, contact_verified, sensitivity, recheck_days, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)
    ON CONFLICT(slug) DO UPDATE SET name = excluded.name, domain = excluded.domain, category = excluded.category, jurisdiction = excluded.jurisdiction,
      legal_basis = excluded.legal_basis, sensitivity = excluded.sensitivity, recheck_days = excluded.recheck_days,
      contact_email = CASE WHEN brokers.contact_verified = 0 AND brokers.contact_email = 'privacy@' || brokers.domain THEN excluded.contact_email ELSE brokers.contact_email END`);
  db.exec('BEGIN');
  try {
    for (const b of seed) {
      if (!b.slug || !b.name || !b.domain || !b.category) throw new Error(`brokers.json : entrée incomplète (${b.slug || '?'})`);
      upsert.run(b.slug, b.name, b.domain, b.category, b.jurisdiction || 'EU', b.legal_basis || 'rgpd', b.contact_email || `privacy@${b.domain}`, [1, 2, 3].includes(b.sensitivity) ? b.sensitivity : 2, b.recheck_days || 60);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Ménage : les sessions expirées ne servent plus à rien.
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());

/* ---------- Aides ---------- */
export const now = () => new Date().toISOString();
export const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
// Mois calendaire (délai de l’article 12 §3 du RGPD) : 31 janvier + 1 mois = 28 (ou 29) février.
export const addMonths = (iso, months) => {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
};
export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};
// Transaction imbriquable (SAVEPOINT) : tout ou rien, même appelée depuis une transaction déjà ouverte.
let depth = 0;
export function tx(fn) {
  const sp = `sp${depth++}`;
  db.exec(`SAVEPOINT ${sp}`);
  try { const out = fn(); db.exec(`RELEASE ${sp}`); return out; }
  catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e; }
  finally { depth--; }
}
export function logEvent(user_id, type, message, { profile_id = null, request_id = null } = {}) {
  q.run('INSERT INTO events (user_id, profile_id, request_id, type, message, created_at) VALUES (?, ?, ?, ?, ?, ?)', user_id, profile_id, request_id, type, String(message).slice(0, 1000), now());
}

/* ---------- Santé et arrêt ---------- */
// La connexion répond-elle ? (/api/health) Ne lève jamais d’exception.
export function dbPing() {
  try { return db.prepare('SELECT 1 AS ok').get()?.ok === 1; } catch { return false; }
}
// Arrêt du serveur : statistiques de l’optimiseur à jour (PRAGMA optimize), puis fermeture (le WAL est reversé dans la base).
let closed = false;
export function closeDb() {
  if (closed) return;
  closed = true;
  try { db.exec('PRAGMA optimize'); } catch (e) { console.error('[db] PRAGMA optimize :', e.message); }
  db.close();
}
