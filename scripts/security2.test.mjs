// Tests de sécurité, seconde série (audit) : découverte des sites ajoutés (expressions à coût quadratique, durée totale
// d’une lecture, adresses IPv6 qui encapsulent une IPv4 privée), limitation de débit (casse et barre finale du chemin,
// rotation d’adresses IPv6) et courtiers personnalisés (deux sites différents ne partagent jamais le même contact).
// Les groupes réseau démarrent leurs propres serveurs sur des ports libres, avec une base et une boîte d’envoi temporaires.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { discoverContact, isPublicIp, safeFetch } from '../server/sitediscovery.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-sec2-'));
const servers = [];
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };

// Serveur de test : port libre, base temporaire, découverte désactivée (aucun accès réseau), variables en plus.
async function startServer(name, extra = {}) {
  const port = 5100 + Math.floor(Math.random() * 800);
  const dir = path.join(tmp, name);
  const env = {
    ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'test.sqlite'), OUTBOX_DIR: path.join(dir, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SESSION_SECRET: 'test-secret-for-security2-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr',
    SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off', TRUST_PROXY: '', ...extra,
  };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { proc, err: '', origin: `http://localhost:${port}`, base: `http://localhost:${port}/api` };
  proc.stderr.on('data', (d) => { s.err += d; });
  servers.push(s);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(s.base + '/health')).ok) return s; } catch {} await wait(250); }
  throw new Error(`serveur ${name} injoignable :\n${s.err}`);
}
// Appel JSON ; `p` est relatif à /api, ou absolu (commence par //) pour tester une autre écriture du préfixe.
async function call(s, method, p, body, { cookie = '', headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const url = p.startsWith('//') ? s.origin + p.slice(1) : s.base + p;
  const r = await fetch(url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { _text: text }; }
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, data, cookie: sc ? sc.split(';')[0] : '' };
}
// Abonné prêt à envoyer des demandes : profil complet, mandat signé, abonnement (simulé) actif.
async function member(s, email, first, last) {
  const r = await call(s, 'POST', '/auth/signup', { email, password: 'Corde-a-linge-78!', plan: 'individuel' });
  assert.equal(r.status, 201, `inscription ${email} : ${JSON.stringify(r.data)}`);
  const c = r.cookie, me = await call(s, 'GET', '/me', undefined, { cookie: c });
  await call(s, 'PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: first, last_name: last, emails: [email], phones: ['+33 6 12 34 56 78'] }, { cookie: c });
  await call(s, 'POST', '/mandate', { full_name: `${first} ${last}`, accepted: true }, { cookie: c });
  assert.equal((await call(s, 'POST', '/billing/checkout', { plan: 'individuel' }, { cookie: c })).status, 200, `abonnement ${email}`);
  return c;
}

try {
  /* ---------- 1. Découverte : une page hostile ne bloque pas le serveur ---------- */
  // Le serveur est mono-processus : une expression à coût quadratique sur une page de 600 Ko gèle toutes les requêtes
  // pendant des minutes. Chaque page ci-dessous prenait plusieurs secondes ; elles doivent être lues en quelques millisecondes.
  const hostile = [
    ['balises <title jamais fermées', '<title'.repeat(30000)],
    ['espaces sans [at]', `${' '.repeat(60000)}x`],
    ['liens <a jamais fermés', '<a'.repeat(40000)],
  ];
  for (const [label, html] of hostile) {
    const t = await elapsed(() => discoverContact('piege.fr', { fetchPage: async (url) => ({ url, html }), maxPages: 1 }));
    assert.ok(t < 1000, `découverte bloquante (${label}) : ${Math.round(t)} ms`);
  }
  const big = `${'<title'.repeat(20000)}${' '.repeat(100000)}${'<a'.repeat(50000)}${'<a href="'.repeat(20000)}${'x@'.repeat(30000)}${'a'.repeat(100000)}`.slice(0, 600000);
  const tBig = await elapsed(() => discoverContact('piege.fr', { fetchPage: async (url) => ({ url, html: big }), maxPages: 1 }));
  assert.ok(tBig < 2000, `page hostile de 600 Ko : ${Math.round(tBig)} ms`);
  const ok = await discoverContact('site.fr', { fetchPage: async (url) => ({ url, html: url === 'https://site.fr/' ? '<title>Site</title><a class="x" data-href="/faux" href="/infos/mentions">Mentions légales</a>' : 'Écrivez à rgpd [at] site.fr' }) });
  assert.equal(ok.email, 'rgpd@site.fr'); assert.equal(ok.page, 'https://site.fr/infos/mentions'); assert.equal(ok.title, 'Site');
  step('découverte : pages hostiles de 600 Ko lues en temps linéaire, extraction et liens légaux inchangés');

  /* ---------- 2. Découverte : durée totale d'une lecture plafonnée ---------- */
  // Un site qui envoie un octet toutes les 200 ms ne déclenche jamais le délai d'inactivité : sans plafond de durée totale,
  // la connexion (et la recherche du contact) reste ouverte indéfiniment.
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/rapide') return res.end('<title>Rapide</title>');
    const drip = setInterval(() => res.write('a'), 200);
    res.on('close', () => clearInterval(drip));
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const realRequest = http.request;
  // La connexion est redirigée vers le serveur local (la garde réseau refuserait 127.0.0.1) ; la logique de safeFetch est inchangée.
  http.request = (u, opts, cb) => realRequest.call(http, { host: '127.0.0.1', port: slow.address().port, path: u.pathname, method: 'GET', headers: opts.headers, timeout: opts.timeout }, cb);
  let guard;
  try {
    const t0 = Date.now();
    const outcome = await Promise.race([
      safeFetch('http://lent.example.com/', { timeoutMs: 800 }).then(() => 'résolue', (e) => `rejetée : ${e.message}`),
      new Promise((r) => { guard = setTimeout(() => r('toujours en cours'), 4000); }),
    ]);
    assert.match(outcome, /^rejetée : Délai dépassé/, `lecture au goutte-à-goutte : ${outcome} après ${Date.now() - t0} ms`);
    assert.ok(Date.now() - t0 < 2500, `délai total non respecté : ${Date.now() - t0} ms`);
    const fast = await safeFetch('http://rapide.example.com/rapide', { timeoutMs: 800 });
    assert.equal(fast.html, '<title>Rapide</title>', 'une réponse rapide est lue normalement');
  } finally { clearTimeout(guard); http.request = realRequest; slow.closeAllConnections(); slow.close(); }
  step('découverte : une réponse au goutte-à-goutte est coupée à la durée totale prévue');

  /* ---------- 3. Garde réseau : IPv4 encapsulées dans IPv6, quelle que soit leur écriture ---------- */
  // dns.lookup rend une adresse NAT64 (64:ff9b::/96) en hexadécimal : 64:ff9b::a9fe:a9fe est 169.254.169.254, joignable
  // par la passerelle NAT64 d'un réseau IPv6 seul. Les autres écritures de l'IPv4 encapsulée sont refusées de même.
  for (const ip of ['64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b:1::a00:1', '::ffff:7f00:1', '::7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:0:7f00:1',
    '::ffff:a9fe:a9fe', '2002:7f00:1::1', '2002:a9fe:a9fe::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fec0::1', '100::1', 'fe80::1%eth0', '::ffff:0:0']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['64:ff9b::808:808', '64:ff9b::8.8.8.8', '2002:808:808::1', '2001:4860:4860::8888', '2a00:1450:4007::1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);
  step('garde réseau : NAT64, IPv4 mappée ou traduite en hexadécimal, 6to4, Teredo, plages réservées refusées');

  /* ---------- 4. Limitation de débit : la casse et la barre finale du chemin ne donnent pas un compteur neuf ---------- */
  // Express route /api/Contact et /api/contact/ vers /api/contact, mais la clé du compteur reprenait le chemin brut :
  // chaque variante (2^n écritures) repartait de zéro, ce qui annulait tous les plafonds (connexion, inscription…).
  const A = await startServer('a');
  const msg = (i) => ({ email: `c${i}@test.fr`, message: 'Bonjour, test.' });
  for (let i = 0; i < 10; i++) assert.equal((await call(A, 'POST', '/contact', msg(i))).status, 200, `message ${i + 1}`);
  assert.equal((await call(A, 'POST', '/contact', msg(10))).status, 429, 'onzième message');
  for (const p of ['/Contact', '/contact/', '/CONTACT', '//API/contact', '//Api/Contact/']) assert.equal((await call(A, 'POST', p, msg(p))).status, 429, `variante ${p}`);
  assert.equal((await call(A, 'POST', '/newsletter', { email: 'n@test.fr' })).status, 200, 'les autres routes gardent leur propre compteur');
  step('limitation de débit : /api/Contact, /api/contact/, /API/contact partagent le compteur de /api/contact');

  /* ---------- 5. Limitation de débit : une adresse IPv6 compte pour tout son /64 ---------- */
  // Un hôte IPv6 dispose d'ordinaire d'un /64 entier (2^64 adresses) : compter par adresse permettait d'en changer à chaque
  // requête. Serveur derrière un proxy de confiance (TRUST_PROXY=1) pour simuler plusieurs clients par X-Forwarded-For.
  const P = await startServer('proxy', { TRUST_PROXY: '1' });
  const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });
  for (let i = 1; i <= 10; i++) assert.equal((await call(P, 'POST', '/contact', msg(i), from(`2001:db8:abcd:12::${i.toString(16)}`))).status, 200, `adresse ${i}`);
  assert.equal((await call(P, 'POST', '/contact', msg(11), from('2001:db8:abcd:12:ffff:1:2:3'))).status, 429, 'même /64, autre adresse');
  assert.equal((await call(P, 'POST', '/contact', msg(12), from('2001:DB8:ABCD:0012:0:0:0:99'))).status, 429, 'même /64, autre écriture');
  assert.equal((await call(P, 'POST', '/contact', msg(13), from('2001:db8:abcd:13::1'))).status, 200, 'autre /64');
  for (let i = 1; i <= 10; i++) assert.equal((await call(P, 'POST', '/contact', msg(i), from(`203.0.113.${i}`))).status, 200, `IPv4 distincte ${i}`);
  step('limitation de débit : la rotation d’adresses dans un même /64 IPv6 ne contourne pas le plafond');

  /* ---------- 6. Sites ajoutés : un site ne reprend jamais le courtier (et le contact) d'un autre site ---------- */
  // « fiches-annuaire.fr » et « fiches.annuaire.fr » donnaient le même slug : la demande de la victime, avec son identité
  // (nom, adresses e-mail, téléphones, adresses postales), partait au contact du site enregistré en premier par un autre abonné.
  const eve = await member(A, 'eve@test.fr', 'Eve', 'Malice');
  let r = await call(A, 'POST', '/sites', { url: 'https://fiches-annuaire.fr/' }, { cookie: eve });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const eveBroker = r.data.broker.id;
  const marie = await member(A, 'marie@test.fr', 'Marie', 'Durand');
  r = await call(A, 'POST', '/sites', { url: 'https://fiches.annuaire.fr/marie-durand' }, { cookie: marie });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.broker.domain, 'fiches.annuaire.fr', 'courtier du site collé'); assert.notEqual(r.data.broker.id, eveBroker, 'courtier distinct');
  const reqId = r.data.request_id;
  let mails = [];
  for (let i = 0; i < 40 && !mails.length; i++) { await wait(100); mails = (await call(A, 'GET', `/requests/${reqId}/mails`, undefined, { cookie: marie })).data.mails || []; }
  assert.equal(mails.length, 1, 'demande envoyée'); assert.equal(mails[0].to_addr, 'privacy@annuaire.fr', 'jamais au contact de fiches-annuaire.fr');
  r = await call(A, 'POST', '/sites', { url: 'fiches-annuaire.fr/autre-page' }, { cookie: eve });
  assert.equal(r.data.status, 'already'); assert.equal(r.data.broker.id, eveBroker, 'même site, même courtier');
  r = await call(A, 'POST', '/sites', { url: 'https://www.fiches.annuaire.fr/x' }, { cookie: marie });
  assert.equal(r.data.status, 'already', 'pas de doublon pour le site de Marie');
  step('sites ajoutés : deux noms d’hôte au même slug restent deux courtiers, chacun avec son contact');

  for (const s of servers) assert.ok(!/TypeError|RangeError|→ 500/.test(s.err), `erreurs serveur :\n${s.err}`);
  console.log(`✔ Sécurité (seconde série) validée (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err) console.error(s.err.slice(-1500));
  process.exitCode = 1;
} finally {
  // Attendre l'arrêt de chaque serveur avant de supprimer le dossier temporaire où il écrit encore.
  await Promise.all(servers.map((s) => (s.proc.exitCode !== null ? null : new Promise((r) => { s.proc.once('exit', r); s.proc.kill(); setTimeout(r, 5000).unref(); }))));
  fs.rmSync(tmp, { recursive: true, force: true });
}
