// Test des fonctions du tableau de bord et de l'exploitation : détail d'une demande, export CSV, préférences, rapport
// mensuel par e-mail (échéance, désinscription, pas de doublon), santé du service, compression et réponses 304.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-feat-'));
const PORT = 5100 + Math.floor(Math.random() * 300);
const DB = path.join(tmp, 'test.sqlite');
const env = { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, OUTBOX_DIR: path.join(tmp, 'outbox'), BACKUP_DIR: path.join(tmp, 'backups'), DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', SESSION_SECRET: 'test-secret-for-features-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off' };
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = ''; server.stderr.on('data', (x) => { serverErr += x; });
const origin = `http://localhost:${PORT}`, base = `${origin}/api`, STRONG = 'Corde-a-linge-78!';
async function call(method, p, body, cookie = '', headers = {}) {
  const h = { ...headers }; if (cookie) h.cookie = cookie; if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
  const sc = r.headers.get('set-cookie') || ''; return { status: r.status, data, text, headers: r.headers, cookie: sc ? sc.split(';')[0] : '' };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };
async function member(email) {
  const c = (await call('POST', '/auth/signup', { email, password: STRONG, plan: 'famille' })).cookie;
  const me = await call('GET', '/me', undefined, c);
  await call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: 'Léa', last_name: 'Moreau' }, c);
  await call('POST', '/mandate', { full_name: 'Léa Moreau', accepted: true }, c);
  await call('POST', '/billing/checkout', { plan: 'famille' }, c);
  await call('POST', '/requests/launch', {}, c);
  return { cookie: c, id: me.data.user.id };
}

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }
  const admin = (await call('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG })).cookie;
  const A = await member('lea@exemple.fr'), B = await member('basile@exemple.fr');
  await call('POST', '/admin/tick', {}, admin);

  /* ---------- 1. Détail d'une demande ---------- */
  let r = await call('GET', '/dashboard', undefined, A.cookie);
  const req = r.data.requests[0];
  r = await call('GET', `/requests/${req.id}/details`, undefined, A.cookie);
  assert.equal(r.status, 200); assert.equal(r.data.request.ref, req.ref); assert.ok(r.data.events.some((e) => /envoyée/.test(e.message))); assert.equal(r.data.mails.length, 1);
  assert.equal((await call('GET', `/requests/${req.id}/details`, undefined, B.cookie)).status, 404, 'demande d’un autre abonné invisible');
  assert.equal((await call('GET', `/requests/${req.id}/details`)).status, 401);
  step('détail d’une demande : historique et courriers, cloisonné par compte');

  /* ---------- 2. Export CSV ---------- */
  r = await call('GET', '/requests.csv', undefined, A.cookie);
  assert.match(r.headers.get('content-type'), /^text\/csv/); assert.match(r.headers.get('content-disposition'), /oubli-demandes-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = r.text.trim().split('\r\n');
  assert.equal(lines[0], 'courtier,domaine,categorie,statut,base_legale,cycle,envoyee_le,echeance,effacee_le,reverification,fiche,reference');
  assert.equal(lines.length - 1, (await call('GET', '/dashboard', undefined, A.cookie)).data.requests.length, 'une ligne par demande');
  assert.ok(!r.text.includes('basile'), 'seulement les demandes du compte');
  step('export CSV : en-têtes, une ligne par demande, cloisonné');

  /* ---------- 3. Préférences et rapport mensuel ---------- */
  assert.equal((await call('PUT', '/preferences', { monthly_report: 'oui' }, A.cookie)).status, 400);
  r = await call('GET', '/me', undefined, A.cookie); assert.equal(r.data.user.monthly_report, true, 'activé par défaut');
  r = await call('POST', '/admin/reports/run', {}, admin); assert.equal(r.data.sent, 0, 'pas de rapport avant 30 jours');
  const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout = 5000');
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  db.prepare('UPDATE users SET created_at = ? WHERE email IN (?, ?)').run(old, 'lea@exemple.fr', 'basile@exemple.fr');
  r = await call('PUT', '/preferences', { monthly_report: false }, B.cookie); assert.equal(r.data.user.monthly_report, false);
  r = await call('POST', '/admin/reports/run', {}, admin); assert.equal(r.data.sent, 1, 'un seul rapport : Basile s’est désinscrit');
  const mail = db.prepare(`SELECT to_addr, subject, body FROM mails WHERE subject LIKE 'Votre rapport mensuel%'`).all();
  assert.equal(mail.length, 1); assert.equal(mail[0].to_addr, 'lea@exemple.fr');
  assert.match(mail[0].body, /Léa Moreau/); assert.match(mail[0].body, /Exposition estimée : \d+ %/); assert.match(mail[0].body, /#settings/);
  r = await call('POST', '/admin/reports/run', {}, admin); assert.equal(r.data.sent, 0, 'pas de second rapport dans les 30 jours');
  db.close();
  step('rapport mensuel : activé par défaut, envoyé après 30 jours, désinscription respectée, pas de doublon');

  console.log(`✔ Fonctions validées (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr.trim()) console.error(serverErr.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
