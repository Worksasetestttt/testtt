// Test des sites ajoutés par les abonnés (« coller une URL ») : fonctions de découverte (normalisation, sites exclus,
// garde anti-SSRF, extraction des contacts, parcours d'un site simulé), puis parcours API sur un serveur de test
// (sans réseau : SITE_DISCOVERY=off, le contact reste présumé et part dans la boîte d'envoi locale).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeSite, excludedReason, isPublicIp, extractContacts, discoverContact, legalLinks, registrableDomain, safeFetch } from '../server/sitediscovery.js';

let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

/* ---------- 1. Normalisation et sites exclus ---------- */
let n = normalizeSite('exemple.fr/fiche/12?x=1#ancre');
assert.deepEqual(n, { url: 'https://exemple.fr/fiche/12?x=1', host: 'exemple.fr', domain: 'exemple.fr' });
n = normalizeSite('  https://WWW.Pages-Annuaire.co.uk/a  ');
assert.equal(n.host, 'pages-annuaire.co.uk'); assert.equal(n.domain, 'pages-annuaire.co.uk');
assert.equal(normalizeSite('https://fiches.annuaire.fr/x').domain, 'annuaire.fr');
for (const bad of ['', 'pas une adresse', 'http://127.0.0.1/x', 'http://[::1]/', 'localhost', 'http://intranet.local/', 'ftp://exemple.fr', 'https://user:pw@exemple.fr', 'https://exemple.fr:8080/', 'javascript:alert(1)', 'http://10.0.0.1', 'https://exemple', 'https://-x.fr']) {
  assert.ok(normalizeSite(bad).error, `refusé : ${bad}`);
}
assert.ok(excludedReason('facebook.com') && excludedReason('m.facebook.com') && excludedReason('impots.gouv.fr') && excludedReason('service-public.fr'));
assert.equal(excludedReason('annuaire.fr'), null); assert.equal(excludedReason('notfacebook.com'), null);
assert.equal(registrableDomain('a.b.exemple.com.au'), 'exemple.com.au');
step('normalisation (schéma, www, ports, IP, noms locaux) et sites exclus (réseaux sociaux, administrations)');

/* ---------- 2. Garde anti-SSRF ---------- */
for (const ip of ['10.0.0.1', '172.20.1.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', 'ff02::1', '2001:db8::1', 'pas-une-ip']) assert.equal(isPublicIp(ip), false, ip);
for (const ip of ['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2001:4860:4860::8888', '2a00:1450:4007::1']) assert.equal(isPublicIp(ip), true, ip);
for (const url of ['http://127.0.0.1:3000/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
  await assert.rejects(safeFetch(url), `requête refusée : ${url}`);
}
step('garde réseau : adresses privées, locales, métadonnées cloud et IPv4 encapsulées refusées');

/* ---------- 3. Extraction des contacts ---------- */
const html = `<p>Écrivez à contact@exemple.fr ou à <a href="mailto:dpo@exemple.fr">notre DPO</a>.</p>
  <p>rgpd [at] exemple.fr · privacy&#64;exemple.fr · noreply@exemple.fr · dpo@autre-site.com · logo@exemple.fr.png</p>`;
const found = extractContacts(html, 'exemple.fr').map((c) => c.email);
assert.equal(found[0], 'dpo@exemple.fr'); assert.ok(found.includes('rgpd@exemple.fr') && found.includes('privacy@exemple.fr') && found.includes('contact@exemple.fr'));
assert.ok(!found.includes('noreply@exemple.fr') && !found.includes('dpo@autre-site.com'), 'ni adresse technique ni autre domaine');
assert.ok(found.indexOf('contact@exemple.fr') > found.indexOf('privacy@exemple.fr'), 'contact général après les adresses dédiées');
assert.deepEqual(legalLinks('<a href="/mentions-legales">Mentions</a><a href="https://ailleurs.fr/privacy">x</a><a href="/blog">Blog</a>', 'https://exemple.fr/'), ['https://exemple.fr/mentions-legales']);
step('extraction : adresses masquées, priorité DPO/confidentialité, autres domaines et adresses techniques ignorés');

/* ---------- 4. Parcours d'un site simulé ---------- */
const pages = {
  'https://site.fr/': '<title>Annuaire Site</title><a href="/infos/mentions-legales">Mentions légales</a> contact@site.fr',
  'https://site.fr/infos/mentions-legales': 'Délégué à la protection des données : dpo@site.fr',
};
const seen = [];
const fake = async (url) => { seen.push(url); if (!(url in pages)) throw new Error('404'); return { url, html: pages[url] }; };
let d = await discoverContact('site.fr', { fetchPage: fake });
assert.equal(d.email, 'dpo@site.fr'); assert.equal(d.page, 'https://site.fr/infos/mentions-legales'); assert.equal(d.title, 'Annuaire Site');
assert.equal(seen[1], 'https://site.fr/infos/mentions-legales', 'les liens trouvés passent avant les chemins usuels');
d = await discoverContact('rien.fr', { fetchPage: async (url) => ({ url, html: '<p>Aucune adresse ici.</p>' }), maxPages: 4 });
assert.equal(d.email, null); assert.equal(d.pages, 4, 'nombre de pages plafonné');
d = await discoverContact('lent.fr', { fetchPage: () => new Promise((r) => setTimeout(() => r({ url: 'x', html: '' }), 60)), budgetMs: 100 });
assert.ok(d.pages <= 3, 'budget de temps respecté');
step('découverte : liens légaux suivis en priorité, arrêt sur une adresse DPO, pages et durée plafonnées');

/* ---------- 5. Parcours API ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-sites-'));
const PORT = 4950 + Math.floor(Math.random() * 40);
const env = { ...process.env, PORT: String(PORT), DATABASE_PATH: path.join(tmp, 'test.sqlite'), OUTBOX_DIR: path.join(tmp, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', SESSION_SECRET: 'test-secret-for-sites-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off' };
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = ''; server.stderr.on('data', (x) => { serverErr += x; });
const base = `http://localhost:${PORT}/api`, STRONG = 'Corde-a-linge-78!';
async function call(method, p, body, cookie = '') {
  const h = {}; if (cookie) h.cookie = cookie; if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data = {}; try { data = JSON.parse(t); } catch { data = { _t: t }; }
  const sc = r.headers.get('set-cookie') || ''; return { status: r.status, data, cookie: sc ? sc.split(';')[0] : '' };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function member(email, { subscribe = true } = {}) {
  const c = (await call('POST', '/auth/signup', { email, password: STRONG, plan: 'individuel' })).cookie;
  const me = await call('GET', '/me', undefined, c);
  await call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: 'Marie', last_name: 'Durand' }, c);
  await call('POST', '/mandate', { full_name: 'Marie Durand', accepted: true }, c);
  if (subscribe) await call('POST', '/billing/checkout', { plan: 'individuel' }, c);
  return c;
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }
  const A = await member('marie@exemple.fr');
  let r = await call('POST', '/requests/launch', {}, A); assert.ok(r.data.created >= 50);
  await call('POST', '/admin/tick', {}, (await call('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG })).cookie);
  const registryCount = (await call('GET', '/config')).data.brokers;
  for (const [url, re] of [['facebook.com/marie', /Réseau social/], ['impots.gouv.fr', /administration/], ['http://192.168.1.10/fiche', /adresse IP/], ['pas une adresse', /invalide|Nom de site/]]) {
    r = await call('POST', '/sites', { url }, A); assert.equal(r.status, 400, url); assert.match(r.data.error, re);
  }
  const reg = (await call('GET', '/brokers')).data.brokers[0];
  r = await call('POST', '/sites', { url: `https://www.${reg.domain}/fiche/marie-durand` }, A);
  assert.equal(r.status, 200); assert.equal(r.data.status, 'already'); assert.equal(r.data.registry, true, 'site du registre reconnu (sous-domaine www)');
  step('API : sites exclus et adresses invalides refusés ; un site du registre est rattaché à la demande existante');

  r = await call('POST', '/sites', { url: 'https://www.annuaire-inconnu.fr/fiche/marie-durand?id=42' }, A);
  assert.equal(r.status, 201); assert.equal(r.data.status, 'created'); assert.equal(r.data.broker.custom, true); assert.equal(r.data.broker.domain, 'annuaire-inconnu.fr');
  const reqId = r.data.request_id;
  await wait(300);
  r = await call('GET', `/requests/${reqId}/mails`, undefined, A);
  assert.equal(r.data.mails.length, 1, 'demande envoyée automatiquement'); assert.equal(r.data.mails[0].to_addr, 'privacy@annuaire-inconnu.fr');
  assert.ok(r.data.mails[0].body.includes('https://www.annuaire-inconnu.fr/fiche/marie-durand?id=42'), 'adresse de la fiche citée dans le courrier');
  r = await call('POST', '/sites', { url: 'annuaire-inconnu.fr/autre-page' }, A); assert.equal(r.data.status, 'already', 'pas de doublon');
  r = await call('GET', '/dashboard', undefined, A);
  const row = r.data.requests.find((x) => x.id === reqId);
  assert.equal(row.custom, true); assert.equal(row.site.status, 'presumed'); assert.equal(r.data.sites.count, 1); assert.equal(r.data.sites.max, 20);
  assert.ok(r.data.events.some((e) => /Site ajouté : annuaire-inconnu\.fr/.test(e.message)));
  r = await call('GET', '/brokers'); assert.ok(!JSON.stringify(r.data).includes('annuaire-inconnu'), 'jamais publié dans le registre public');
  assert.equal((await call('GET', '/config')).data.brokers, registryCount, 'compteur du registre inchangé');
  step('site inconnu : courtier personnalisé, demande envoyée avec l’adresse de la fiche, sans doublon, absent du registre public');

  const B = await member('bruno@exemple.fr');
  r = await call('POST', '/requests/launch', {}, B);
  assert.equal(r.data.created, registryCount, 'un site ajouté par un abonné ne part pas dans les demandes des autres');
  const C = await member('chloe@exemple.fr', { subscribe: false });
  r = await call('POST', '/sites', { url: 'annuaire-inconnu.fr' }, C); assert.equal(r.status, 400); assert.match(r.data.error, /abonnement/);
  step('isolement : les autres abonnés ne reçoivent pas ce site ; abonnement actif exigé');

  for (let i = 2; i <= 20; i++) { r = await call('POST', '/sites', { url: `site-numero-${i}.fr` }, A); assert.equal(r.status, 201, `site ${i}`); }
  r = await call('POST', '/sites', { url: 'site-numero-21.fr' }, A); assert.equal(r.status, 400); assert.match(r.data.error, /Limite atteinte/);
  r = await call('POST', '/sites', { url: 'site-numero-5.fr/nouvelle-fiche' }, A); assert.equal(r.status, 200, 'un site déjà ajouté reste accessible à la limite');
  step('limite de 20 sites par profil');

  const admin = (await call('POST', '/auth/login', { email: 'admin@test.fr', password: STRONG })).cookie;
  r = await call('GET', '/admin/brokers', undefined, admin);
  const custom = r.data.brokers.find((b) => b.domain === 'annuaire-inconnu.fr');
  assert.equal(custom.custom, 1); assert.equal(custom.contact_source, 'guess'); assert.equal(custom.discovery_status, 'skipped');
  r = await call('POST', `/admin/requests/${reqId}/outcome`, { outcome: 'done' }, admin); assert.equal(r.status, 200);
  r = await call('POST', '/sites', { url: 'https://annuaire-inconnu.fr/fiche/marie-durand-2' }, A);
  assert.equal(r.data.status, 'relaunched', 'fiche réapparue : nouvelle demande'); assert.notEqual(r.data.request_id, reqId);
  r = await call('PUT', `/admin/brokers/${custom.id}`, { contact_email: 'dpo@annuaire-inconnu.fr' }, admin);
  assert.equal(r.data.broker.contact_source, 'admin', 'adresse saisie par l’équipe');
  r = await call('POST', `/admin/brokers/${custom.id}/discover`, {}, admin); assert.equal(r.status, 200);
  step('administration : site ajouté visible (source du contact), fiche réapparue relancée, contact corrigé par l’équipe');

  // Envoi réel (SMTP) : une adresse présumée n'est jamais écrite ; une adresse publiée par le site part (ici, tentative
  // vers un serveur SMTP fermé : l'échec enregistré prouve que l'envoi a été autorisé).
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-sites-smtp-')), PORT2 = PORT + 50, DB2 = path.join(tmp2, 'test.sqlite');
  const smtp = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env: { ...env, PORT: String(PORT2), DATABASE_PATH: DB2, OUTBOX_DIR: path.join(tmp2, 'outbox'), SMTP_URL: 'smtp://127.0.0.1:9', MAIL_FROM: 'Oubli <demandes@oubli.test>' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base2 = `http://localhost:${PORT2}/api`;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base2 + '/health')).ok) break; } catch {} await wait(250); }
    const c2 = async (m, p, b, ck) => { const rr = await fetch(base2 + p, { method: m, headers: { 'content-type': 'application/json', cookie: ck || '' }, body: b ? JSON.stringify(b) : undefined }); return { status: rr.status, data: await rr.json().catch(() => ({})), cookie: (rr.headers.get('set-cookie') || '').split(';')[0] }; };
    const S = (await c2('POST', '/auth/signup', { email: 'smtp@exemple.fr', password: STRONG, plan: 'individuel' })).cookie;
    const me = await c2('GET', '/me', null, S);
    await c2('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: 'Marie', last_name: 'Durand' }, S);
    await c2('POST', '/mandate', { full_name: 'Marie Durand', accepted: true }, S); await c2('POST', '/billing/checkout', { plan: 'individuel' }, S);
    r = await c2('POST', '/sites', { url: 'annuaire-presume.fr/fiche' }, S); assert.equal(r.status, 201);
    const sid = r.data.request_id;
    const ADM = (await c2('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG })).cookie;
    await c2('POST', '/admin/tick', {}, ADM);
    const db2 = new DatabaseSync(DB2);
    db2.exec('PRAGMA busy_timeout = 5000');   // le serveur écrit en même temps : attendre plutôt qu'échouer
    let row2 = db2.prepare('SELECT status, attempts FROM requests WHERE id = ?').get(sid);
    assert.equal(row2.status, 'queued'); assert.equal(row2.attempts, 0, 'adresse présumée : aucun envoi réel');
    db2.prepare(`UPDATE brokers SET contact_source = 'site', contact_email = 'dpo@annuaire-presume.fr' WHERE domain = 'annuaire-presume.fr'`).run();
    await c2('POST', '/admin/tick', {}, ADM);
    row2 = db2.prepare('SELECT status, attempts, last_error FROM requests WHERE id = ?').get(sid);
    assert.ok(row2.attempts >= 1 && row2.last_error, 'adresse publiée par le site : envoi tenté');
    db2.close();
    // Le message brut du serveur d'envoi (ici « connect ECONNREFUSED 127.0.0.1:9 ») reste dans last_error, pour l'équipe.
    const seen = JSON.stringify((await c2('GET', '/dashboard', null, S)).data) + JSON.stringify((await c2('GET', '/export', null, S)).data);
    assert.ok(!seen.includes(row2.last_error) && !seen.includes('127.0.0.1'), 'erreur SMTP brute invisible pour l’abonné (journal, note, export)');
  } finally {
    if (smtp.exitCode === null) await new Promise((r) => { smtp.once('exit', r); smtp.kill(); setTimeout(r, 5000).unref(); });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
  step('envoi réel : adresse présumée jamais écrite, adresse publiée par le site envoyée automatiquement');

  console.log(`✔ Sites ajoutés validés (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr.trim()) console.error(serverErr.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000).unref(); });   // attendre l'arrêt : le serveur peut encore écrire dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
