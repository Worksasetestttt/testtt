// Base de données SQLite (module natif node:sqlite, aucune dépendance native).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'oubli.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

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
  billing_mode TEXT,                 -- stripe | simulated
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
  jurisdiction TEXT NOT NULL,        -- US | EU | UK | CA | CH
  legal_basis TEXT NOT NULL,         -- rgpd | ccpa | both
  contact_email TEXT NOT NULL,
  contact_verified INTEGER NOT NULL DEFAULT 0,
  sensitivity INTEGER NOT NULL DEFAULT 2,
  recheck_days INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  broker_id INTEGER NOT NULL REFERENCES brokers(id),
  cycle INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | in_progress | action_required | done | refused
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  due_at TEXT,
  followup_sent_at TEXT,
  completed_at TEXT,
  next_check_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_profile ON requests(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  profile_id TEXT,
  request_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id DESC);
CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  user_id TEXT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  mode TEXT NOT NULL,                -- smtp | outbox
  message_id TEXT,
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
`);

// Registre de courtiers : chargé une fois depuis brokers.json.
const count = db.prepare('SELECT COUNT(*) AS c FROM brokers').get().c;
if (count === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'brokers.json'), 'utf8'));
  const ins = db.prepare(`INSERT INTO brokers (slug, name, domain, category, jurisdiction, legal_basis, contact_email, contact_verified, sensitivity, recheck_days, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`);
  for (const b of seed) ins.run(b.slug, b.name, b.domain, b.category, b.jurisdiction, b.legal_basis, b.contact_email || `privacy@${b.domain}`, b.sensitivity, b.recheck_days);
}

export const now = () => new Date().toISOString();
export const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};
export function logEvent(user_id, type, message, { profile_id = null, request_id = null } = {}) {
  q.run('INSERT INTO events (user_id, profile_id, request_id, type, message, created_at) VALUES (?, ?, ?, ?, ?, ?)', user_id, profile_id, request_id, type, message, now());
}
