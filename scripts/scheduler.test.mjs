// Tests du planificateur et des flux qui l'alimentent, un groupe par correctif :
//   1. recherche du contact d'un site pendant laquelle l'équipe saisit l'adresse ;
//   2. courtier ajouté au registre (brokers.json ou administration) : demandes pour les abonnés existants ;
//   3. courtier désactivé puis réactivé : demandes jamais envoyées arrêtées, puis relancées ;
//   4. réponses entrantes d'un expéditeur qui n'est ni le courtier ni son contact vérifié ;
//   5. envoi en double : deux instances sur la même base, reprise après une panne entre l'envoi et la mise à jour.
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
    assert.match(journal, /^1\sdemande\spréparée\s/, 'journal au singulier pour une seule demande');
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

  /* ---------- Serveur principal des groupes 3 et 4 (boîte d'envoi locale, paiement simulé) ---------- */
  const S = want(3) || want(4) || want(5) ? await start('main') : null;
  const ADM = S ? await adminOf(S) : null;
  const db = S ? S.sql() : null;
  const reqRow = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  const brokerOf = (id) => db.prepare('SELECT b.* FROM requests r JOIN brokers b ON b.id = r.broker_id WHERE r.id = ?').get(id);

  /* ---------- 3. Courtier désactivé : demandes jamais envoyées closes, montrées « arrêtées », relancées à la réactivation ---------- */
  // Ses demandes en file ou en erreur restaient « À envoyer » pour toujours.
  if (want(3)) {
    const M = await member(S), N = await member(S), P = await member(S);
    const site = await S.call('POST', '/sites', { url: 'https://annuaire-retire.fr/fiche/lea' }, M.cookie);
    assert.equal(site.status, 201);
    await settle(S);
    const X = db.prepare('SELECT id, name FROM brokers WHERE custom = 0 AND active = 1 ORDER BY id LIMIT 1').get();
    const reqOf = (u, broker) => db.prepare('SELECT * FROM requests WHERE user_id = ? AND broker_id = ? ORDER BY cycle DESC LIMIT 1').get(u.id, broker);
    const mx = reqOf(M, X.id), nx = reqOf(N, X.id), px = reqOf(P, X.id), mw = reqOf(M, site.data.broker.id);
    db.prepare(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL WHERE id IN (?, ?)`).run(mx.id, mw.id);       // pas encore parties
    db.prepare(`UPDATE requests SET status = 'error', sent_at = NULL, due_at = NULL, attempts = 6, last_error = 'refus SMTP' WHERE id = ?`).run(nx.id);
    let r = await S.call('DELETE', `/admin/brokers/${X.id}`, {}, ADM);
    assert.equal(r.status, 200); assert.equal(r.data.broker.active, 0); assert.equal(r.data.stopped, 2, 'deux demandes jamais parties closes');
    r = await S.call('PUT', `/admin/brokers/${site.data.broker.id}`, { active: false }, ADM);   // case « Actif » décochée dans la fiche
    assert.equal(r.status, 200); assert.equal(r.data.stopped, 1);
    for (const id of [mx.id, nx.id, mw.id]) { const x = reqRow(id); assert.equal(x.status, 'refused'); assert.match(x.note, /^Courtier retiré/); assert.equal(x.next_check_at, null); }
    assert.equal(reqRow(px.id).status, 'sent', 'une demande déjà envoyée n’est pas touchée');
    // Tableau de bord, CSV, plainte, rapport mensuel : « arrêtée », jamais un refus.
    let dash = (await S.call('GET', '/dashboard', undefined, M.cookie)).data;
    const rowX = dash.requests.find((x) => x.id === mx.id), rowW = dash.requests.find((x) => x.id === mw.id);
    for (const row of [rowX, rowW]) { assert.equal(row.status, 'stopped'); assert.equal(row.stop_reason, 'broker'); assert.equal(row.complaint, false); }
    assert.equal(dash.counters.stopped, 2); assert.equal(dash.counters.refused, 0, 'pas un refus');
    const csv = (await S.call('GET', '/requests.csv', undefined, M.cookie)).text;
    assert.equal(csv.match(/Arrêtée\s\(courtier\sretiré\sdu\sregistre\)/g)?.length, 2, 'CSV : arrêtées, cause indiquée');
    assert.ok(!/Refusée|mandat révoqué/.test(csv), 'CSV : ni refus ni mandat révoqué');
    assert.equal((await S.call('GET', `/requests/${mx.id}/complaint`, undefined, M.cookie)).status, 400, 'aucune plainte proposée');
    assert.equal((await S.call('GET', '/admin/brokers', undefined, ADM)).data.brokers.find((b) => b.id === X.id).refused, 0, 'administration : pas compté comme un refus');
    assert.ok(dash.events.some((e) => e.request_id === mx.id && /retiré\sde\snotre\sregistre/.test(e.message)), 'journal : arrêt expliqué');
    db.prepare('UPDATE users SET created_at = ?, last_report_at = NULL WHERE id = ?').run(ago(31 * DAY), M.id);
    r = await S.call('POST', '/admin/reports/run', {}, ADM); assert.ok(r.data.sent >= 1);
    const report = db.prepare(`SELECT body FROM mails WHERE user_id = ? AND subject LIKE 'Votre rapport mensuel%' ORDER BY id DESC LIMIT 1`).get(M.id).body;
    assert.match(report, /2\sdemandes\sarrêtées/); assert.match(report, /retirés\sde\snotre\sregistre/); assert.doesNotMatch(report, /refus/i);
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(mx.id).status, 'refused', 'pas de nouveau cycle tant que le courtier est retiré');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM requests WHERE broker_id = ? AND user_id = ?').get(X.id, M.id).c, 1);
    // Un renvoi par l'administration vers un courtier désactivé est refusé (il resterait « à envoyer »).
    r = await S.call('POST', `/admin/requests/${mx.id}/resend`, {}, ADM);
    assert.equal(r.status, 400); assert.match(r.data.error, /désactivé/);
    // Réactivation : un nouveau cycle repart, comme après une nouvelle signature du mandat.
    r = await S.call('PUT', `/admin/brokers/${X.id}`, { active: true }, ADM); assert.equal(r.status, 200);
    await settle(S);
    for (const u of [M, N]) { const next = reqOf(u, X.id); assert.equal(next.cycle, 2, 'nouveau cycle'); assert.equal(next.status, 'sent'); }
    assert.equal(reqOf(M, site.data.broker.id).id, mw.id, 'le site, toujours retiré, reste arrêté');
    r = await S.call('PUT', `/admin/brokers/${site.data.broker.id}`, { active: true }, ADM); assert.equal(r.status, 200);   // site : hors registre
    await settle(S);
    assert.equal(reqOf(M, site.data.broker.id).cycle, 2, 'site rétabli : nouveau cycle'); assert.equal(reqOf(M, site.data.broker.id).status, 'sent');
    assert.equal(reqOf(M, site.data.broker.id).source_url, 'https://annuaire-retire.fr/fiche/lea', 'la fiche signalée reste citée');
    assert.equal(reqOf(P, X.id).id, px.id, 'la demande déjà envoyée suit son cours');
    dash = (await S.call('GET', '/dashboard', undefined, M.cookie)).data;
    assert.equal(dash.counters.stopped, 0, 'plus aucune demande arrêtée');
    // Courtier déjà inactif avec une demande en file (base antérieure au correctif) : arrêtée au passage suivant.
    const old = await S.call('POST', '/sites', { url: 'https://ancien-annuaire.fr/fiche/lea' }, M.cookie);
    await settle(S);
    db.prepare('UPDATE brokers SET active = 0 WHERE id = ?').run(old.data.broker.id);
    db.prepare(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL WHERE id = ?`).run(old.data.request_id);
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(old.data.request_id).status, 'refused'); assert.match(reqRow(old.data.request_id).note, /^Courtier retiré/);
    // Abonné suspendu pendant la réactivation : rien ne repart, même après un redémarrage (la reprise des anciens refus
    // au démarrage ne transforme pas l'arrêt en refus) ; la levée de la suspension relance la demande.
    const T1 = await start('arret-1');
    const O = await member(T1), TA = await adminOf(T1);
    await settle(T1);
    const tdb = T1.sql();
    const Z = tdb.prepare('SELECT id FROM brokers WHERE custom = 0 AND active = 1 ORDER BY id LIMIT 1').get().id;
    const oz = tdb.prepare('SELECT id FROM requests WHERE user_id = ? AND broker_id = ?').get(O.id, Z).id;
    tdb.prepare(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL WHERE id = ?`).run(oz);
    tdb.close();
    assert.equal((await T1.call('DELETE', `/admin/brokers/${Z}`, {}, TA)).data.stopped, 1);
    assert.equal((await T1.call('POST', `/admin/users/${O.id}/suspend`, { reason: 'vérification du compte' }, TA)).status, 200);
    assert.equal((await T1.call('PUT', `/admin/brokers/${Z}`, { active: true }, TA)).status, 200);
    await settle(T1);
    await T1.stop();
    const T2 = await start('arret-2', {}, { db: T1.db });
    const t2db = T2.sql();
    const stoppedRow = () => t2db.prepare('SELECT status, note, next_check_at FROM requests WHERE id = ?').get(oz);
    assert.equal(stoppedRow().status, 'refused'); assert.match(stoppedRow().note, /^Courtier retiré/);
    assert.equal(stoppedRow().next_check_at, null, 'redémarrage : pas de nouvelle demande programmée comme après un refus');
    assert.equal((await T2.call('POST', `/admin/users/${O.id}/unsuspend`, {}, await adminOf(T2))).status, 200);
    await settle(T2);
    const relaunched = t2db.prepare('SELECT cycle, status FROM requests WHERE user_id = ? AND broker_id = ? ORDER BY cycle DESC LIMIT 1').get(O.id, Z);
    assert.deepEqual({ ...relaunched }, { cycle: 2, status: 'sent' }, 'suspension levée : la demande arrêtée repart');
    t2db.close(); await T2.stop();
  }
  if (want(3)) step('courtier désactivé : demandes jamais parties closes (« arrêtées », cause propre, sans plainte ni refus, CSV et rapport) ; nouveau cycle à la réactivation');

  /* ---------- 4. Réponses entrantes : un effacement ou un refus ne s'applique que s'il vient du courtier ---------- */
  // /api/inbound appliquait « effacée » ou « refusée » à toute réponse citant une référence, quel que soit l'expéditeur.
  if (want(4)) {
    const M = await member(S);
    await settle(S);
    const sent = db.prepare(`SELECT id, token FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at`).all(M.id);
    const DONE = 'Bonjour, vos données ont été supprimées de nos bases.', REFUSED = 'Nous ne pouvons pas donner suite à votre demande.';
    const ref = (x) => `Re: Demande [OUBLI-${x.token}]`;
    const domainOf = (x) => brokerOf(x.id).domain;
    // a. Expéditeur inconnu : au plus « en cours », demande signalée à l'équipe.
    let r = await inbound(S, ref(sent[0]), DONE, 'dpo@usurpateur.example');
    assert.equal(r.status, 200); assert.equal(r.data.matched, true); assert.equal(r.data.outcome, 'done'); assert.equal(r.data.review, true);
    assert.equal(r.data.status, 'in_progress');
    let row = reqRow(sent[0].id);
    assert.equal(row.status, 'in_progress', 'pas d’effacement enregistré'); assert.equal(row.completed_at, null); assert.equal(row.next_check_at, null);
    assert.ok(row.review_at); assert.equal(row.review_outcome, 'done'); assert.equal(row.review_from, 'dpo@usurpateur.example');
    // b. Domaine qui imite celui du courtier, nom affiché trompeur, expéditeur absent : refus non appliqués.
    const d1 = domainOf(sent[1]);
    for (const [x, from] of [[sent[1], `privacy@${d1}.usurpateur.example`], [sent[2], `"privacy@${domainOf(sent[2])}" <pirate@usurpateur.example>`], [sent[3], undefined], [sent[8], `dpo@faux${domainOf(sent[8])}`]]) {
      r = await inbound(S, ref(x), REFUSED, from);
      assert.equal(r.data.outcome, 'refused'); assert.equal(r.data.review, true, `expéditeur ${from} : à vérifier`);
      assert.equal(reqRow(x.id).status, 'in_progress');
    }
    // c. Domaine du courtier, sous-domaine, adresse de contact vérifiée par l'équipe : appliqué.
    r = await inbound(S, ref(sent[4]), DONE, `"Service RGPD" <DPO@${domainOf(sent[4]).toUpperCase()}>`);
    assert.equal(r.data.review, false); assert.equal(reqRow(sent[4].id).status, 'done');
    r = await inbound(S, ref(sent[5]), REFUSED, `privacy@mail.${domainOf(sent[5])}`);
    assert.equal(r.data.review, false); assert.equal(reqRow(sent[5].id).status, 'refused');
    r = await inbound(S, ref(sent[4]), DONE, 'dpo@usurpateur.example');   // déjà effacée : rien à vérifier
    assert.equal(r.data.review, false); assert.equal(r.data.applied, false); assert.equal(reqRow(sent[4].id).review_at, null);
    const b6 = brokerOf(sent[6].id);
    assert.equal((await S.call('PUT', `/admin/brokers/${b6.id}`, { contact_email: 'dpo@groupe-mere.fr' }, ADM)).status, 200);   // nouvelle adresse : non vérifiée
    r = await inbound(S, ref(sent[6]), DONE, 'dpo@groupe-mere.fr');
    assert.equal(r.data.review, true, 'adresse de contact non vérifiée : pas digne de confiance'); assert.equal(reqRow(sent[6].id).status, 'in_progress');
    assert.equal((await S.call('PUT', `/admin/brokers/${b6.id}`, { contact_verified: true }, ADM)).status, 200);
    r = await inbound(S, ref(sent[6]), DONE, 'dpo@groupe-mere.fr');
    assert.equal(r.data.review, false); assert.equal(reqRow(sent[6].id).status, 'done', 'adresse de contact vérifiée : appliqué');
    assert.equal(reqRow(sent[6].id).review_at, null, 'un résultat fiable lève le signalement');
    // d. Une demande de vérification n'est pas un résultat définitif : appliquée comme avant.
    r = await inbound(S, ref(sent[7]), 'Merci de confirmer votre identité (copie d’une pièce d’identité).', 'support@helpdesk.example');
    assert.equal(r.data.outcome, 'action_required'); assert.equal(r.data.review, false); assert.equal(reqRow(sent[7].id).status, 'action_required');
    // e. Abonné : rien d'une décision ; ni l'expéditeur ni le signalement dans son export.
    const dash = (await S.call('GET', '/dashboard', undefined, M.cookie)).data;
    assert.equal(dash.requests.find((x) => x.id === sent[0].id).status, 'in_progress');
    assert.ok(dash.events.some((e) => e.request_id === sent[0].id && /vérifie/.test(e.message)), 'journal : réponse en cours de vérification');
    const exp = JSON.stringify((await S.call('GET', '/export', undefined, M.cookie)).data);
    assert.ok(!exp.includes('usurpateur') && !exp.includes('review_'), 'export sans l’expéditeur ni le signalement');
    // f. Administration : liste des réponses à vérifier, fiche de la demande, décision ou levée du signalement.
    r = await S.call('GET', '/admin/requests?status=review', undefined, ADM);
    assert.equal(r.status, 200);
    const ids = r.data.requests.map((x) => x.id);
    for (const x of [...sent.slice(0, 4), sent[8]]) assert.ok(ids.includes(x.id), 'demande à vérifier listée');
    assert.equal(r.data.counts.review, 5);
    const listed = r.data.requests.find((x) => x.id === sent[0].id);
    assert.equal(listed.review_outcome, 'done'); assert.equal(listed.review_from, 'dpo@usurpateur.example');
    r = await S.call('GET', `/admin/requests/${sent[0].id}`, undefined, ADM); assert.equal(r.data.request.review_outcome, 'done');
    assert.equal((await S.call('GET', '/admin/stats', undefined, ADM)).data.review, 5, 'compteur pour le badge de l’onglet');
    r = await S.call('POST', `/admin/requests/${sent[0].id}/outcome`, { outcome: 'done', note: 'confirmé par téléphone' }, ADM);
    assert.equal(r.status, 200); row = reqRow(sent[0].id); assert.equal(row.status, 'done'); assert.equal(row.review_at, null, 'décision de l’équipe : signalement levé');
    r = await S.call('DELETE', `/admin/requests/${sent[1].id}/review`, {}, ADM);
    assert.equal(r.status, 200); row = reqRow(sent[1].id); assert.equal(row.review_at, null); assert.equal(row.status, 'in_progress', 'statut inchangé');
    assert.equal((await S.call('DELETE', `/admin/requests/${sent[1].id}/review`, {}, ADM)).status, 400, 'rien à lever');
    assert.equal((await S.call('GET', '/admin/requests?status=review', undefined, ADM)).data.total, 3);
    r = await S.call('POST', '/admin/requests/bulk', { ids: [sent[2].id], outcome: 'refused' }, ADM);
    assert.equal(r.data.updated, 1); assert.equal(reqRow(sent[2].id).review_at, null, 'réponses groupées : signalement levé');
    assert.equal((await S.call('POST', `/admin/requests/${sent[3].id}/resend`, {}, ADM)).status, 200);
    assert.equal(reqRow(sent[3].id).review_at, null, 'renvoi : signalement levé');
    assert.equal((await S.call('GET', '/admin/requests?status=review', undefined, ADM)).data.total, 1);
    assert.equal((await S.call('DELETE', `/admin/requests/${sent[2].id}/review`, {}, M.cookie)).status, 403, 'réservé aux administrateurs');
  }
  if (want(4)) step('réponses entrantes : effacement ou refus appliqués seulement depuis le domaine du courtier ou son contact vérifié ; sinon « en cours » et « à vérifier » dans l’administration');

  /* ---------- 5. Envoi en double : réservation atomique avant l'envoi ---------- */
  // Deux instances sur la même base envoyaient la même demande ; après une panne entre l'envoi et la mise à jour, le
  // courrier repartait. La demande est réservée (claimed_at) avant l'envoi ; une réservation périmée est reprise, et un
  // courrier déjà parti pendant cette réservation n'est pas renvoyé.
  if (want(5)) {
    if (!db.prepare('PRAGMA table_info(requests)').all().some((c) => c.name === 'claimed_at')) db.exec('ALTER TABLE requests ADD COLUMN claimed_at TEXT');
    const Q = await member(S);
    await settle(S);
    const [x1, x2, x3] = db.prepare(`SELECT id FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at LIMIT 3`).all(Q.id);
    const mails = (id) => db.prepare(`SELECT id, created_at FROM mails WHERE request_id = ? AND subject LIKE 'Demande d%' AND error IS NULL ORDER BY id`).all(id);
    const requeue = db.prepare(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL, claimed_at = ? WHERE id = ?`);
    // x1 : panne après l'envoi (courrier enregistré pendant une réservation périmée, demande restée en file).
    requeue.run(ago(2 * HOUR), x1.id);
    const m1 = mails(x1.id)[0];
    db.prepare('UPDATE mails SET created_at = ? WHERE id = ?').run(ago(2 * HOUR - 60000), m1.id);
    // x2 : panne avant l'envoi (réservation périmée, aucun courrier depuis) ; x3 : réservée par une autre instance à l'instant.
    requeue.run(ago(2 * HOUR), x2.id);
    db.prepare('UPDATE mails SET created_at = ? WHERE request_id = ?').run(ago(3 * HOUR), x2.id);
    requeue.run(ago(60000), x3.id);
    await S.call('POST', '/admin/tick', {}, ADM);
    let row = reqRow(x1.id);
    assert.equal(row.status, 'sent', 'reprise : demande marquée envoyée'); assert.equal(mails(x1.id).length, 1, 'courrier non renvoyé');
    assert.equal(row.sent_at, db.prepare('SELECT created_at FROM mails WHERE id = ?').get(m1.id).created_at, 'date d’envoi : celle du courrier parti');
    assert.equal(row.claimed_at, null, 'réservation levée');
    assert.equal(reqRow(x2.id).status, 'sent'); assert.equal(mails(x2.id).length, 2, 'envoi repris après une réservation périmée');
    assert.equal(reqRow(x3.id).status, 'queued', 'réservée ailleurs : pas d’envoi'); assert.equal(mails(x3.id).length, 1);
    db.prepare('UPDATE requests SET claimed_at = ? WHERE id = ?').run(ago(2 * HOUR), x3.id);
    db.prepare('UPDATE mails SET created_at = ? WHERE request_id = ?').run(ago(3 * HOUR), x3.id);
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(x3.id).status, 'sent'); assert.equal(mails(x3.id).length, 2);
    // Relances : même réservation. x4 : relance partie juste avant une panne ; x5 : relance en cours sur une autre instance.
    const [x4, x5] = db.prepare(`SELECT id, token FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at LIMIT 2 OFFSET 3`).all(Q.id);
    const relances = (id) => db.prepare(`SELECT created_at FROM mails WHERE request_id = ? AND subject LIKE 'Relance%' AND error IS NULL`).all(id);
    const overdue = db.prepare('UPDATE requests SET due_at = ?, claimed_at = ? WHERE id = ?');
    overdue.run(ago(DAY), ago(2 * HOUR), x4.id); overdue.run(ago(DAY), ago(60000), x5.id);
    const sentAt = ago(2 * HOUR - 60000);
    db.prepare(`INSERT INTO mails (request_id, user_id, to_addr, subject, body, mode, message_id, created_at) VALUES (?, ?, 'dpo@courtier.fr', ?, 'relance', 'outbox', '<x4@oubli.local>', ?)`).run(x4.id, Q.id, `Relance — demande d’effacement sans réponse [OUBLI-${x4.token}]`, sentAt);
    await S.call('POST', '/admin/tick', {}, ADM);
    row = reqRow(x4.id);
    assert.equal(row.status, 'in_progress'); assert.equal(row.followup_sent_at, sentAt, 'relance déjà partie : enregistrée, pas renvoyée'); assert.equal(relances(x4.id).length, 1);
    assert.equal(reqRow(x5.id).status, 'sent', 'relance réservée ailleurs : pas d’envoi'); assert.equal(relances(x5.id).length, 0);
    // Renvoi demandé par l'équipe après une panne : le courrier parti pendant l'ancienne réservation ne dispense pas du renvoi.
    const [x6] = db.prepare(`SELECT id FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at LIMIT 1 OFFSET 5`).all(Q.id);
    requeue.run(ago(2 * HOUR), x6.id);
    db.prepare('UPDATE mails SET created_at = ? WHERE request_id = ?').run(ago(2 * HOUR - 60000), x6.id);
    assert.equal((await S.call('POST', `/admin/requests/${x6.id}/resend`, {}, ADM)).status, 200);
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(x6.id).status, 'sent'); assert.equal(mails(x6.id).length, 2, 'renvoi effectué');
    // Échec d'envoi : la réservation est levée, l'essai suivant part à l'échéance du recul.
    const bad = await S.call('POST', '/sites', { url: 'https://annuaire-injoignable.fr/fiche/lea' }, Q.cookie);
    await settle(S);
    db.prepare(`UPDATE brokers SET contact_email = 'adresse-invalide' WHERE id = ?`).run(bad.data.broker.id);
    requeue.run(null, bad.data.request_id);
    await S.call('POST', '/admin/tick', {}, ADM);
    row = reqRow(bad.data.request_id);
    assert.equal(row.status, 'queued'); assert.ok(row.attempts >= 1); assert.equal(row.claimed_at, null, 'réservation levée après l’échec');
    const tries = row.attempts;
    db.prepare('UPDATE requests SET next_attempt_at = ? WHERE id = ?').run(ago(1000), bad.data.request_id);
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(bad.data.request_id).attempts, tries + 1, 'nouvel essai après le recul');
    // Désactivation pendant un envoi : la demande réservée n'est pas arrêtée (son courrier part), puis l'est si l'envoi échoue.
    const site = await S.call('POST', '/sites', { url: 'https://annuaire-en-cours.fr/fiche/lea' }, Q.cookie);
    await settle(S);
    requeue.run(ago(30000), site.data.request_id);
    assert.equal((await S.call('DELETE', `/admin/brokers/${site.data.broker.id}`, {}, ADM)).data.stopped, 0, 'demande en cours d’envoi : pas arrêtée');
    assert.equal(reqRow(site.data.request_id).status, 'queued');
    db.prepare('UPDATE requests SET claimed_at = NULL WHERE id = ?').run(site.data.request_id);   // l'envoi a échoué et la réservation est levée
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(site.data.request_id).status, 'refused', 'arrêtée au passage suivant'); assert.match(reqRow(site.data.request_id).note, /^Courtier retiré/);
    // Réservation prise par une autre instance entre la lecture de la demande et son UPDATE : pendant que le serveur
    // attend le verrou d'écriture (tenu ici), l'autre connexion réserve la demande ; la condition de l'UPDATE l'emporte.
    const [y] = db.prepare(`SELECT id FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at LIMIT 1 OFFSET 6`).all(Q.id);
    requeue.run(null, y.id);
    const before = mails(y.id).length;
    const other = S.sql();
    other.exec('BEGIN IMMEDIATE');
    const ticking = S.call('POST', '/admin/tick', {}, ADM);
    await wait(400);
    other.prepare('UPDATE requests SET claimed_at = ? WHERE id = ?').run(new Date().toISOString(), y.id);
    other.exec('COMMIT'); other.close();
    assert.equal((await ticking).status, 200);
    assert.equal(reqRow(y.id).status, 'queued', 'réservée entre-temps par l’autre instance : pas d’envoi'); assert.equal(mails(y.id).length, before);
    db.prepare('UPDATE requests SET claimed_at = NULL WHERE id = ?').run(y.id);   // l'autre instance a levé sa réservation
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(y.id).status, 'sent'); assert.equal(mails(y.id).length, before + 1);
    // Deux instances sur la même base, SMTP lent (400 ms par courrier) : chaque demande ne part qu'une fois.
    const slow = slowSmtp(400);
    await new Promise((res) => slow.server.listen(0, '127.0.0.1', res));
    const dbPath = path.join(tmp, 'deux-instances.sqlite');
    const env = { SMTP_URL: `smtp://127.0.0.1:${slow.server.address().port}`, ALLOW_UNVERIFIED_CONTACTS: 'true', SEND_BATCH: '4', MAIL_TIMEOUT_MS: '5000' };
    const I1 = await start('instance-1', env, { db: dbPath });
    const I2 = await start('instance-2', env, { db: dbPath });
    try {
      const U = await member(I1, { launch: false });
      const A1 = await adminOf(I1), A2 = await adminOf(I2);
      assert.equal((await I1.call('POST', '/requests/launch', {}, U.cookie)).status, 200);   // lance aussi un passage sur I1
      await Promise.all([I2.call('POST', '/admin/tick', {}, A2), I1.call('POST', '/admin/tick', {}, A1), wait(30).then(() => I2.call('POST', '/admin/tick', {}, A2))]);
      const idb = I1.sql();
      const dup = idb.prepare(`SELECT request_id, COUNT(*) AS n FROM mails WHERE request_id IS NOT NULL AND error IS NULL GROUP BY request_id HAVING n > 1`).all();
      const sentN = idb.prepare(`SELECT COUNT(*) AS c FROM requests WHERE user_id = ? AND status = 'sent'`).get(U.id).c;
      const mailedN = idb.prepare(`SELECT COUNT(*) AS c FROM mails WHERE user_id = ? AND request_id IS NOT NULL AND error IS NULL`).get(U.id).c;
      const allOk = idb.prepare('SELECT COUNT(*) AS c FROM mails WHERE error IS NULL').get().c;   // courriers de bienvenue compris
      idb.close();
      assert.deepEqual(dup.map((x) => ({ ...x })), [], 'aucune demande envoyée deux fois');
      assert.ok(sentN >= 4, `les deux instances ont envoyé (${sentN})`); assert.equal(mailedN, sentN, 'un courrier par demande envoyée');
      assert.equal(slow.count(), allOk, 'le serveur SMTP n’a reçu chaque courrier qu’une fois');
    } finally { await I1.stop(); await I2.stop(); slow.close(); }
  }
  if (want(5)) step('envoi en double : réservation atomique (deux instances, SMTP lent), reprise d’une réservation périmée sans renvoyer un courrier déjà parti');

  if (db) db.close();
  console.log(`✔ Planificateur validé (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err.trim()) console.error(`[${s.name}]`, s.err.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((s) => s.stop()));   // attendre l'arrêt : les serveurs écrivent encore dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
