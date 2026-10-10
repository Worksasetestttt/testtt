// Test des fonctions du tableau de bord : détail d'une demande, export CSV, préférences, rapport mensuel par e-mail
// (échéance, désinscription dans les paramètres et en un clic, pas de doublon), refus et plainte, relance « données
// réapparues », demandes arrêtées par la révocation du mandat. Santé, compression et 304 : voir perf.test.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-feat-'));
const PORT = await freePort();
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
  assert.match(mail[0].body, /Léa Moreau/); assert.match(mail[0].body, /Exposition estimée\u00a0: \d+\u00a0%/, 'typographie française : espace insécable avant « : » et « % »'); assert.match(mail[0].body, /#settings/);
  r = await call('POST', '/admin/reports/run', {}, admin); assert.equal(r.data.sent, 0, 'pas de second rapport dans les 30 jours');
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM mails WHERE subject LIKE 'Votre rapport mensuel%'`).get().c, 1);
  // Désinscription en un clic (RFC 8058) : en-têtes du message, lien de la page de confirmation, POST sans session.
  const eml = fs.readdirSync(path.join(tmp, 'outbox')).filter((f) => f.endsWith('-lea@exemple.fr.eml')).map((f) => fs.readFileSync(path.join(tmp, 'outbox', f), 'utf8')).find((t) => /Subject: Votre rapport mensuel/.test(t));
  const oneClick = (eml.match(/^List-Unsubscribe: <([^>]+)>$/m) || [])[1];
  assert.ok(oneClick && /\/api\/unsubscribe\/report\?u=/.test(oneClick), 'en-tête List-Unsubscribe'); assert.match(eml, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  assert.match(mail[0].body, /\/app\/#unsubscribe\?u=[^&\s]+&t=[A-Za-z0-9_-]{43}/, 'lien de désinscription dans le message');
  const unsubPath = '/unsubscribe/report' + oneClick.slice(oneClick.indexOf('?'));
  const get = await fetch(base + unsubPath, { redirect: 'manual' });
  assert.equal(get.status, 303); assert.match(get.headers.get('location'), /#unsubscribe\?u=/); assert.equal((await call('GET', '/me', undefined, A.cookie)).data.user.monthly_report, true, 'un GET ne désinscrit pas');
  assert.equal((await call('POST', unsubPath.replace(/t=[^&]+/, 't=' + 'x'.repeat(43)), undefined)).status, 400, 'jeton faux');
  const post = await fetch(base + unsubPath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(post.status, 200, 'POST en un clic, sans session ni JSON');
  assert.equal((await call('GET', '/me', undefined, A.cookie)).data.user.monthly_report, false, 'désinscrit');
  step('rapport mensuel : activé par défaut, envoyé après 30 jours, désinscription respectée (paramètres et lien en un clic), pas de doublon');

  /* ---------- 4. Refus : nouvelle demande programmée, plainte prête à déposer ---------- */
  r = await call('GET', '/dashboard', undefined, A.cookie);
  const [r1, r2] = r.data.requests.filter((x) => x.status === 'sent');
  assert.equal(r1.complaint, false);
  assert.equal((await call('GET', `/requests/${r1.id}/complaint`, undefined, A.cookie)).status, 400, 'pas de plainte pendant le délai de réponse');
  assert.equal((await call('POST', `/admin/requests/${r1.id}/outcome`, { outcome: 'refused', note: 'Données nécessaires à nos obligations légales' }, admin)).status, 200);
  r = await call('GET', '/dashboard', undefined, A.cookie);
  let row = r.data.requests.find((x) => x.id === r1.id);
  assert.equal(row.status, 'refused'); assert.equal(row.complaint, true);
  assert.ok(row.next_check_at > new Date().toISOString(), 'un refus programme une nouvelle demande');
  r = await call('GET', `/requests/${r1.id}/complaint`, undefined, A.cookie);
  assert.equal(r.status, 200); assert.equal(r.data.authority.short, 'CNIL'); assert.match(r.data.authority.url, /^https:\/\/www\.cnil\.fr\//);
  assert.match(r.data.subject, /refusée/); assert.match(r.data.text, /«\u00a0Données nécessaires à nos obligations légales\u00a0»/);
  assert.match(r.data.text, /OUBLI-[A-F0-9]{10}/); assert.match(r.data.text, /MOREAU/); assert.match(r.data.text, /article 17 du RGPD/);
  assert.ok(r.data.text.includes('Les faits :'), 'typographie française (espace insécable avant les deux-points)');
  assert.equal((await call('GET', `/requests/${r1.id}/complaint`, undefined, B.cookie)).status, 404, 'plainte d’un autre abonné invisible');
  // Une relance restée sans réponse huit jours rend aussi la plainte possible.
  const late = new Date(Date.now() - 40 * 86400000).toISOString(), lateFollow = new Date(Date.now() - 9 * 86400000).toISOString();
  db.prepare('UPDATE requests SET status = ?, due_at = ?, followup_sent_at = ? WHERE id = ?').run('in_progress', late, lateFollow, r2.id);
  r = await call('GET', `/requests/${r2.id}/complaint`, undefined, A.cookie);
  assert.equal(r.status, 200); assert.match(r.data.subject, /restée sans réponse/); assert.match(r.data.text, /Une relance a été envoyée le/);
  step('refus : nouvelle demande programmée, plainte rédigée (refus ou relance sans réponse), cloisonnée');

  /* ---------- 5. « Mes données sont réapparues » : relance immédiate ---------- */
  assert.equal((await call('POST', `/requests/${r2.id}/relaunch`, {}, A.cookie)).status, 400, 'une demande en cours ne se relance pas');
  assert.equal((await call('POST', `/requests/${r1.id}/relaunch`, { url: 'https://autre-site.fr/fiche' }, A.cookie)).status, 400, 'adresse d’un autre site refusée');
  assert.equal((await call('POST', `/requests/${r1.id}/relaunch`, {}, B.cookie)).status, 404);
  r = await call('POST', `/requests/${r1.id}/relaunch`, { url: `https://www.${row.domain}/fiche/lea-moreau` }, A.cookie);
  assert.equal(r.status, 201); assert.equal(r.data.cycle, 2);
  assert.equal((await call('POST', `/requests/${r1.id}/relaunch`, {}, A.cookie)).status, 409, 'un cycle ne se relance qu’une fois');
  const relaunched = r.data.request_id;
  let sentMail = null;
  for (let i = 0; i < 40 && !sentMail; i++) { await wait(100); sentMail = db.prepare('SELECT body FROM mails WHERE request_id = ?').get(relaunched); }
  assert.ok(sentMail, 'la nouvelle demande part sans attendre'); assert.ok(sentMail.body.includes(`https://www.${row.domain}/fiche/lea-moreau`), 'la fiche signalée est citée');
  r = await call('GET', '/dashboard', undefined, A.cookie);
  row = r.data.requests.find((x) => x.broker === row.broker);
  assert.equal(row.cycle, 2); assert.equal(row.id, relaunched);
  // Le refus de Basile, arrivé à échéance, déclenche le nouveau cycle tout seul.
  const rb = (await call('GET', '/dashboard', undefined, B.cookie)).data.requests.find((x) => x.status === 'sent');
  await call('POST', `/admin/requests/${rb.id}/outcome`, { outcome: 'refused' }, admin);
  db.prepare('UPDATE requests SET next_check_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), rb.id);
  await call('POST', '/admin/tick', {}, admin);
  r = await call('GET', '/dashboard', undefined, B.cookie);
  assert.equal(r.data.requests.find((x) => x.broker === rb.broker).cycle, 2);
  assert.ok(r.data.events.some((e) => /après son refus/.test(e.message)));
  db.close();
  step('relance : nouvelle demande immédiate avec la fiche citée, une seule par cycle ; un refus échu repart seul');

  /* ---------- 6. Mandat révoqué : demandes « arrêtées » (ni refus ni plainte) ; accès maintenu jusqu'à la fin de période ---------- */
  const C = await member('chloe@exemple.fr');
  { const d = new DatabaseSync(DB); d.prepare(`UPDATE requests SET status = 'refused', note = 'Mandat révoqué par l’abonné.', sent_at = NULL WHERE user_id = ?`).run(C.id); d.close(); }
  await call('DELETE', '/mandate', undefined, C.cookie);
  r = await call('GET', '/dashboard', undefined, C.cookie);
  assert.ok(r.data.requests.length > 0);
  assert.ok(r.data.requests.every((x) => x.status === 'stopped' && !x.complaint), 'demande arrêtée : statut « stopped », pas de plainte');
  assert.equal(r.data.counters.stopped, r.data.requests.length); assert.equal(r.data.counters.refused, 0, 'une révocation n’est pas un refus');
  assert.match((await call('GET', '/requests.csv', undefined, C.cookie)).text, /Arrêtée \(mandat révoqué\)/);
  await call('POST', '/mandate', { full_name: 'Léa Moreau', accepted: true }, C.cookie);
  assert.equal((await call('POST', `/admin/users/${C.id}/subscription`, { status: 'canceled', ends_at: '2099-01-01' }, admin)).status, 200);
  r = await call('GET', '/dashboard', undefined, C.cookie);
  assert.equal(r.data.onboarding.subscription, false); assert.equal(r.data.onboarding.access, true, 'résilié mais payé : accès maintenu');
  step('mandat révoqué : demandes « arrêtées » (ni refus ni plainte, CSV) ; résilié mais payé : accès maintenu');

  console.log(`✔ Fonctions validées (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr.trim()) console.error(serverErr.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000).unref(); });   // attendre l'arrêt : le serveur peut encore écrire dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
