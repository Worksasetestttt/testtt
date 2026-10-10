// Tests du planificateur et des flux qui l'alimentent, un groupe par correctif :
//   1. recherche du contact d'un site pendant laquelle l'équipe saisit l'adresse ;
//   2. courtier ajouté au registre (brokers.json ou administration) : demandes pour les abonnés existants ;
// Chaque groupe démarre ses serveurs (port libre, base temporaire, jamais data/). SCHED_ONLY=2,4 ne lance que ces groupes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-sched-'));
const STRONG = 'Corde-a-linge-78!', INBOUND = 'inbound-secret-token-0123456789';
const ONLY = String(process.env.SCHED_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (n) => !ONLY.length || ONLY.includes(String(n));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600000, DAY = 86400000;

async function call(base, method, p, body, cookie = '', headers = {}) {
  const h = { ...headers }; if (cookie) h.cookie = cookie; if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
  const sc = r.headers.get('set-cookie') || ''; return { status: r.status, data, text, cookie: sc ? sc.split(';')[0] : '' };
}
// Serveur de test : `extra` complète l'environnement, `cwd` lance une copie du dépôt, `db` reprend une base existante.
async function start(name, extra = {}, { cwd = ROOT, db } = {}) {
  const port = await freePort();
  const dir = path.join(tmp, `${name}-${port}`); fs.mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env, PORT: String(port), DATABASE_PATH: db || path.join(dir, 'test.sqlite'), OUTBOX_DIR: path.join(dir, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SESSION_SECRET: 'test-secret-for-scheduler-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr',
    INBOUND_TOKEN: INBOUND, SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off', ...extra,
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
  const s = { name, base: `http://localhost:${port}/api`, db: env.DATABASE_PATH, err: '', child };
  child.stderr.on('data', (d) => { s.err += d; });
  servers.push(s);
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(s.base + '/health')).ok; } catch {} if (!up) await wait(100); }
  if (!up) throw new Error(`serveur ${name} injoignable :\n${s.err}`);
  s.call = (method, p, body, cookie, headers) => call(s.base, method, p, body, cookie, headers);
  s.stop = () => new Promise((res) => { if (child.exitCode !== null || child.signalCode) return res(); child.once('exit', res); child.kill(); });
  s.sql = () => { const d = new DatabaseSync(s.db); d.exec('PRAGMA busy_timeout = 5000'); return d; };
  return s;
}
async function adminOf(s) {
  if (s.admin) return s.admin;
  let r = await s.call('POST', '/auth/login', { email: 'admin@test.fr', password: STRONG });
  if (r.status !== 200) r = await s.call('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG });
  s.admin = r.cookie;
  return s.admin;
}
let seq = 0;
// Abonné complet : profil, mandat, abonnement activé par l'administration, demandes lancées (sauf launch: false).
async function member(s, { launch = true, first = 'Léa', last = 'Moreau' } = {}) {
  const email = `sched${++seq}@exemple.fr`;
  const r = await s.call('POST', '/auth/signup', { email, password: STRONG, plan: 'individuel' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cookie = r.cookie, me = await s.call('GET', '/me', undefined, cookie);
  await s.call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: first, last_name: last }, cookie);
  await s.call('POST', '/mandate', { full_name: `${first} ${last}`, accepted: true }, cookie);
  assert.equal((await s.call('POST', `/admin/users/${me.data.user.id}/subscription`, { status: 'active', plan: 'individuel' }, await adminOf(s))).status, 200);
  if (launch) assert.ok((await s.call('POST', '/requests/launch', {}, cookie)).data.created > 0, 'demandes lancées');
  return { cookie, id: me.data.user.id, email, pid: me.data.profiles[0].id };
}
// Laisse partir les passages programmés après un lancement, puis deux passages manuels.
async function settle(s) { for (let i = 0; i < 2; i++) { await wait(60); await s.call('POST', '/admin/tick', {}, await adminOf(s)); } }
// Copie du dépôt (serveur, application, landing) : permet de modifier server/brokers.json sans toucher au dépôt.
function copyRepo(name) {
  const dir = path.join(tmp, name);
  for (const x of ['server', 'app', 'assets', 'index.html', 'package.json']) fs.cpSync(path.join(ROOT, x), path.join(dir, x), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
// Serveur SMTP factice qui répond 250 après `delayMs` à chaque message (envoi lent) et compte les messages acceptés.
function slowSmtp(delayMs) {
  let accepted = 0;
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => {});
    sock.setEncoding('utf8');
    let buf = '', data = false;
    sock.write('220 smtp.test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return;
          buf = buf.slice(end + 5); data = false;
          setTimeout(() => { accepted += 1; if (!sock.destroyed) sock.write('250 2.0.0 OK\r\n'); }, delayMs);
          continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const cmd = buf.slice(0, Math.min(4, i)).toUpperCase(); buf = buf.slice(i + 2);
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 smtp.test\r\n');
        else if (cmd === 'DATA') { data = true; sock.write('354 OK\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 OK\r\n'); return; }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return { server, count: () => accepted, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}
const inbound = (s, subject, text, from) => s.call('POST', '/inbound', from === undefined ? { subject, text } : { subject, text, from }, '', { 'x-inbound-token': INBOUND });

try {
  /* ---------- 1. Recherche du contact d'un site : l'équipe saisit l'adresse pendant la recherche ---------- */
  // La recherche se terminait en « introuvable » (ou écrasait l'adresse de l'équipe par celle trouvée sur le site) et
  // prévenait les abonnés à tort. Test en processus : la recherche est remplacée par une promesse que le test résout
  // après avoir enregistré l'adresse comme le fait PUT /api/admin/brokers/:id (contact_source « admin »).
  if (want(1)) {
    const dir = path.join(tmp, 'unit'); fs.mkdirSync(dir, { recursive: true });
    Object.assign(process.env, { DATABASE_PATH: path.join(dir, 'unit.sqlite'), OUTBOX_DIR: path.join(dir, 'outbox'), SITE_DISCOVERY: 'on', SMTP_URL: '', STRIPE_SECRET_KEY: '', DEMO_MODE: 'false', NODE_ENV: 'test', SESSION_SECRET: 'test-secret-for-scheduler-suite-0123456789' });
    const { q, now, closeDb } = await import('../server/db.js');
    await import('../server/auth.js');   // colonnes de suspension lues par le planificateur
    const { runDiscovery } = await import('../server/sites.js');
    const scheduler = await import('../server/scheduler.js');
    try {
      const t = now();
      q.run(`INSERT INTO users (id, email, password_hash, created_at, subscription_status, mandate_signed_at) VALUES ('u-1', 'site@exemple.fr', 'x', ?, 'none', ?)`, t, t);   // sans abonnement : aucun envoi pendant le test
      q.run(`INSERT INTO profiles (id, user_id, is_primary, first_name, last_name, created_at, updated_at) VALUES ('p-1', 'u-1', 1, 'Léa', 'Moreau', ?, ?)`, t, t);
      const site = (host) => {
        const id = Number(q.run(`INSERT INTO brokers (slug, name, domain, category, jurisdiction, legal_basis, contact_email, contact_verified, sensitivity, recheck_days, active, custom, contact_source, discovery_status, created_at)
          VALUES (?, ?, ?, 'Site ajouté', 'FR', 'rgpd', ?, 0, 2, 90, 1, 1, 'guess', 'pending', ?)`, `site-${host.replace(/\W+/g, '-')}`, host, host, `privacy@${host}`, t).lastInsertRowid);
        q.run(`INSERT INTO requests (id, user_id, profile_id, broker_id, cycle, status, token, created_at) VALUES (?, 'u-1', 'p-1', ?, 1, 'queued', ?, ?)`, `r-${id}`, id, `A${String(id).padStart(9, '0')}`, t);
        return id;
      };
      const broker = (id) => q.get('SELECT contact_email, contact_source, discovery_status FROM brokers WHERE id = ?', id);
      const notices = (id) => q.get(`SELECT COUNT(*) AS c FROM events WHERE request_id = ? AND type = 'site'`, `r-${id}`).c;
      const pending = () => { let finish; const promise = new Promise((r) => { finish = r; }); return { discover: () => promise, finish }; };
      const teamSaves = (id, email) => q.run(`UPDATE brokers SET contact_email = ?, contact_source = 'admin', contact_verified = 0, discovery_status = CASE WHEN discovery_status = 'pending' THEN 'found' ELSE discovery_status END WHERE id = ?`, email, id);

      // a. Recherche automatique sans résultat, adresse saisie par l'équipe entre-temps.
      const a = site('course-a.fr'), da = pending();
      const pa = runDiscovery(a, { discover: da.discover });
      teamSaves(a, 'dpo@course-a.fr');
      da.finish({ email: null, page: null, pages: 6, title: null });
      await pa;
      assert.deepEqual({ ...broker(a) }, { contact_email: 'dpo@course-a.fr', contact_source: 'admin', discovery_status: 'found' }, 'ni « introuvable » ni adresse écrasée');
      assert.equal(notices(a), 0, 'aucun abonné prévenu à tort');
      // b. Recherche forcée (bouton « Chercher le contact ») qui trouve une adresse : celle de l'équipe, saisie pendant la
      // recherche, est conservée.
      const b = site('course-b.fr'), db2 = pending();
      const pb = runDiscovery(b, { force: true, discover: db2.discover });
      teamSaves(b, 'juridique@course-b.fr');
      db2.finish({ email: 'contact@course-b.fr', page: 'https://course-b.fr/contact', pages: 2, title: null });
      await pb;
      assert.deepEqual({ ...broker(b) }, { contact_email: 'juridique@course-b.fr', contact_source: 'admin', discovery_status: 'found' }, 'adresse de l’équipe conservée');
      assert.equal(notices(b), 0);
      // c. Recherche en échec : l'état de l'adresse saisie par l'équipe n'est pas remplacé par « échec ».
      const c = site('course-c.fr');
      let failNow;
      const pc = runDiscovery(c, { discover: () => new Promise((_res, rej) => { failNow = rej; }) });
      teamSaves(c, 'dpo@course-c.fr');
      const logError = console.error; console.error = () => {};   // l'échec de la recherche est journalisé par le serveur
      try { failNow(new Error('réseau indisponible')); await pc; } finally { console.error = logError; }
      assert.equal(broker(c).discovery_status, 'found', 'état conservé après un échec');
      // d. Témoin : sans intervention de l'équipe, l'adresse trouvée sur le site est enregistrée et l'abonné prévenu.
      const d = site('course-d.fr'), dd = pending();
      const pd = runDiscovery(d, { discover: dd.discover });
      dd.finish({ email: 'dpo@course-d.fr', page: 'https://course-d.fr/mentions-legales', pages: 2, title: null });
      await pd;
      assert.deepEqual({ ...broker(d) }, { contact_email: 'dpo@course-d.fr', contact_source: 'site', discovery_status: 'found' });
      assert.equal(notices(d), 1, 'abonné prévenu du contact trouvé');
    } finally {
      await wait(30);
      await scheduler.stopScheduler();   // un passage déclenché par la fin d'une recherche se termine avant la fermeture
      closeDb();
    }
    step('recherche du contact : une adresse saisie par l’équipe pendant la recherche n’est ni écrasée ni suivie d’un avis');
  }

  /* ---------- 2. Courtier ajouté au registre : demandes pour les abonnés existants ---------- */
  // autoLaunch ne traitait que les profils sans aucune demande : un courtier ajouté à brokers.json (ou créé dans
  // l'administration) ne recevait jamais de demande pour les abonnés déjà suivis.
  if (want(2)) {
    const copy = copyRepo('registre');
    const R1 = await start('registre-1', {}, { cwd: copy });
    const A = await member(R1), C = await member(R1), B = await member(R1), D = await member(R1);
    await settle(R1);
    const ADM1 = await adminOf(R1);
    // C : résilié, accès payé jusqu'à une date future (éligible). B : résilié, accès terminé. D : suspendu.
    assert.equal((await R1.call('POST', `/admin/users/${C.id}/subscription`, { status: 'canceled', ends_at: new Date(Date.now() + 20 * DAY).toISOString() }, ADM1)).status, 200);
    assert.equal((await R1.call('POST', `/admin/users/${B.id}/subscription`, { status: 'canceled', ends_at: ago(DAY) }, ADM1)).status, 200);
    assert.equal((await R1.call('POST', `/admin/users/${D.id}/suspend`, { reason: 'test de suspension' }, ADM1)).status, 200);
    await R1.stop();
    const reg = path.join(copy, 'server', 'brokers.json');
    const list = JSON.parse(fs.readFileSync(reg, 'utf8'));
    list.push({ slug: 'courtier-ajoute', name: 'Courtier Ajouté', domain: 'courtier-ajoute.fr', category: 'Annuaire', jurisdiction: 'FR', legal_basis: 'rgpd', sensitivity: 2, recheck_days: 60 });
    fs.writeFileSync(reg, JSON.stringify(list, null, 2));
    const R2 = await start('registre-2', {}, { cwd: copy, db: R1.db });
    await settle(R2);
    const db = R2.sql();
    const added = db.prepare(`SELECT id FROM brokers WHERE slug = 'courtier-ajoute'`).get().id;
    const reqsFor = (u, broker) => db.prepare('SELECT cycle, status FROM requests WHERE user_id = ? AND broker_id = ? ORDER BY cycle').all(u.id, broker).map((x) => ({ ...x }));
    const dups = () => db.prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM requests GROUP BY profile_id, broker_id, cycle HAVING COUNT(*) > 1)').get().c;
    assert.deepEqual(reqsFor(A, added), [{ cycle: 1, status: 'sent' }], 'abonné existant : une demande de cycle 1, envoyée');
    assert.deepEqual(reqsFor(C, added), [{ cycle: 1, status: 'sent' }], 'résilié avec accès jusqu’à une date future : éligible');
    assert.deepEqual(reqsFor(B, added), [], 'accès terminé : aucune demande');
    assert.deepEqual(reqsFor(D, added), [], 'compte suspendu : aucune demande');
    const countA = db.prepare('SELECT COUNT(*) AS c FROM requests WHERE user_id = ?').get(A.id).c;
    await settle(R2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM requests WHERE user_id = ?').get(A.id).c, countA, 'aucune demande de plus au passage suivant');
    assert.equal(dups(), 0, 'aucun doublon');
    // Courtier créé dans l'administration, sans redémarrage.
    const ADM2 = await adminOf(R2);
    let r = await R2.call('POST', '/admin/brokers', { slug: 'annuaire-cree', name: 'Annuaire Créé', domain: 'annuaire-cree.fr', category: 'Annuaire', jurisdiction: 'FR', legal_basis: 'rgpd', sensitivity: 2, recheck_days: 60, contact_email: 'dpo@annuaire-cree.fr' }, ADM2);
    assert.equal(r.status, 201);
    const created = r.data.broker.id;
    await settle(R2);
    assert.deepEqual(reqsFor(A, created), [{ cycle: 1, status: 'sent' }], 'courtier créé dans l’administration : demande envoyée');
    // De nouveau éligibles (abonnement réactivé, suspension levée) : les courtiers ajoutés entre-temps sont rattrapés.
    assert.equal((await R2.call('POST', `/admin/users/${B.id}/subscription`, { status: 'active', plan: 'individuel' }, ADM2)).status, 200);
    await settle(R2);
    assert.equal(reqsFor(B, added).length, 1, 'abonnement réactivé : courtier du registre rattrapé'); assert.equal(reqsFor(B, created).length, 1, 'courtier créé rattrapé');
    assert.equal(reqsFor(D, added).length, 0, 'toujours suspendu');
    assert.equal((await R2.call('POST', `/admin/users/${D.id}/unsuspend`, {}, ADM2)).status, 200);
    await settle(R2);
    assert.equal(reqsFor(D, added).length, 1, 'suspension levée : courtier du registre rattrapé'); assert.equal(reqsFor(D, created).length, 1);
    assert.equal(dups(), 0, 'aucun doublon');
    const journal = db.prepare(`SELECT message FROM events WHERE user_id = ? AND type = 'launch' ORDER BY id DESC LIMIT 1`).get(A.id).message;
    assert.match(journal, /^1 demande préparée /, 'journal au singulier pour une seule demande');
    // Lancement simultané (autre instance) : pendant que le serveur lance le profil de A, une autre connexion tient le
    // verrou d'écriture et crée la même demande. L'insertion du serveur, vérifiée dans l'instruction même, n'en ajoute pas
    // une seconde.
    r = await R2.call('POST', '/admin/brokers', { slug: 'annuaire-concurrent', name: 'Annuaire Concurrent', domain: 'annuaire-concurrent.fr', category: 'Annuaire', jurisdiction: 'FR', legal_basis: 'rgpd', sensitivity: 2, recheck_days: 60, contact_email: 'dpo@annuaire-concurrent.fr' }, ADM2);
    const rival = r.data.broker.id;
    const other = R2.sql();
    other.exec('BEGIN IMMEDIATE');
    const launching = R2.call('POST', '/requests/launch', {}, A.cookie);
    await wait(400);   // le serveur a lu les demandes du profil et attend le verrou
    other.prepare(`INSERT INTO requests (id, user_id, profile_id, broker_id, cycle, status, token, created_at) VALUES ('concurrente', ?, ?, ?, 1, 'queued', 'C0C0C0C0C0', ?)`).run(A.id, A.pid, rival, new Date().toISOString());
    other.exec('COMMIT'); other.close();
    r = await launching;
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.created, 0, 'demande déjà créée par l’autre connexion');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM requests WHERE profile_id = ? AND broker_id = ?').get(A.pid, rival).c, 1, 'pas de doublon');
    db.close(); await R2.stop();
  }
  if (want(2)) step('courtier ajouté au registre (brokers.json ou administration) : une demande de cycle 1 par profil éligible, sans doublon, rattrapage des profils redevenus éligibles');




  console.log(`✔ Planificateur validé (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err.trim()) console.error(`[${s.name}]`, s.err.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((s) => s.stop()));   // attendre l'arrêt : les serveurs écrivent encore dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
