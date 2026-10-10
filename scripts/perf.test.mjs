// Test de performance et de fiabilité côté serveur :
// négociation et ETag (unitaire), santé évaluée (unitaire), module statique sur un dossier temporaire (versionnement,
// invalidation quand un fichier change), puis, sur un serveur réel : santé profonde, compression de l'API (et ses
// exceptions : webhook, petites réponses, téléchargements, HEAD), ETag et 304 du tableau de bord, versionnement et cache
// des pages et ressources, sauvegardes (fichier, rotation, audit), arrêt propre (requête en cours menée à terme, code 0,
// base fermée) ; enfin un second serveur au planificateur figé (SMTP muet) : santé 503, sauvegarde refusée dans un
// dossier public, arrêt borné malgré le passage bloqué.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createStatic } from '../server/static.js';
import { evaluateHealth, STARTUP_GRACE_MS } from '../server/health.js';
import { negotiate, etagMatches } from '../server/compress.js';

const ROOT = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-perf-'));
const DB = path.join(tmp, 'test.sqlite'), BACKUPS = path.join(tmp, 'backups');
const PUBLIC_BACKUPS = path.join(ROOT, 'assets', 'perf-test-backups');   // doit être refusé (jamais créé)
const STRONG = 'Corde-a-linge-78!', WHSEC = 'whsec_perf_test_0123456789abcdef';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b, n) => crypto.createHash('sha256').update(b).digest('hex').slice(0, n);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

// Requête HTTP brute : octets tels que transférés (fetch décompresse de lui-même).
function raw(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const decode = (r) => (r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body);
const varies = (r) => /(^|,)\s*accept-encoding\s*(,|$)/i.test(r.headers.vary || '');

function startServer(port, extra = {}) {
  const env = { ...process.env, PORT: String(port), DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', INBOUND_TOKEN: '', BACKUP_DIR: '', SESSION_SECRET: 'test-secret-for-perf-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off', ...extra };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return { proc, exited, log: () => log, port };
}
async function waitHealthy(port) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return; } catch { /* pas encore prêt */ } await wait(250); }
  throw new Error(`serveur ${port} injoignable`);
}
function client(port) {
  const base = `http://localhost:${port}/api`;
  return async function call(method, p, body, cookie = '', headers = {}) {
    const h = { ...headers }; if (cookie) h.cookie = cookie; if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
    const sc = r.headers.get('set-cookie') || '';
    return { status: r.status, data, text, headers: r.headers, cookie: sc ? sc.split(';')[0] : '' };
  };
}
async function member(call, email) {
  const c = (await call('POST', '/auth/signup', { email, password: STRONG, plan: 'famille' })).cookie;
  const me = await call('GET', '/me', undefined, c);
  await call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: 'Léa', last_name: 'Moreau', emails: [email] }, c);
  await call('POST', '/mandate', { full_name: 'Léa Moreau', accepted: true }, c);
  await call('POST', '/billing/checkout', { plan: 'famille' }, c);
  const l = await call('POST', '/requests/launch', {}, c);
  assert.ok(l.data.created >= 50, `lancement : ${JSON.stringify(l.data)}`);
  return c;
}

let main = null, second = null, mini = null, blackhole = null;
const holes = new Set();
try {
  /* ---------- 1. Négociation, ETag, santé (unitaire) ---------- */
  assert.equal(negotiate('gzip, deflate, br, zstd'), 'br');
  assert.equal(negotiate('gzip'), 'gzip');
  assert.equal(negotiate('br;q=0, gzip'), 'gzip');
  assert.equal(negotiate('gzip;q=0.5, br;q=0.4'), 'gzip');
  assert.equal(negotiate('*'), 'br');
  assert.equal(negotiate('*;q=0'), null);
  assert.equal(negotiate('identity'), null);
  assert.equal(negotiate(''), null);
  assert.equal(negotiate('br', ['gzip']), null, 'variante indisponible');
  assert.ok(etagMatches('"abc1"', '"abc1"') && etagMatches('W/"abc1"', '"abc1"') && etagMatches('"abc1-br"', '"abc1"') && etagMatches('"x", "abc1-gz"', '"abc1-br"') && etagMatches('*', '"abc1"'));
  assert.ok(!etagMatches('"abc2"', '"abc1"') && !etagMatches('', '"abc1"') && !etagMatches('"abc1', '"abc1"'));
  const t0 = 1_000_000_000_000, sched = (o) => ({ startedAt: t0, intervalMs: 60000, lastBeatAt: t0, stopped: false, ...o });
  let h = evaluateHealth({ db: true, scheduler: sched(), stopping: false, nowMs: t0 + 179000 });
  assert.deepEqual(h, { ok: true, checks: { db: 'ok', scheduler: 'ok' } });
  h = evaluateHealth({ db: false, scheduler: sched(), stopping: false, nowMs: t0 + 1000 });
  assert.deepEqual(h, { ok: false, checks: { db: 'error', scheduler: 'ok' } }, 'base indisponible → 503');
  h = evaluateHealth({ db: true, scheduler: sched(), stopping: false, nowMs: t0 + 181000 });
  assert.deepEqual(h, { ok: false, checks: { db: 'ok', scheduler: 'stale' } }, 'figé après trois intervalles');
  h = evaluateHealth({ db: true, scheduler: sched({ lastBeatAt: null }), stopping: false, nowMs: t0 + 180000 + STARTUP_GRACE_MS });
  assert.deepEqual(h.checks.scheduler, 'starting', 'marge au démarrage');
  h = evaluateHealth({ db: true, scheduler: sched({ lastBeatAt: null }), stopping: false, nowMs: t0 + 181000 + STARTUP_GRACE_MS });
  assert.equal(h.checks.scheduler, 'stale', 'premier passage jamais terminé');
  assert.equal(evaluateHealth({ db: true, scheduler: sched({ stopped: true }), stopping: false, nowMs: t0 }).ok, false, 'planificateur arrêté');
  assert.deepEqual(evaluateHealth({ db: true, scheduler: sched(), stopping: true, nowMs: t0 }), { ok: false, checks: { db: 'ok', scheduler: 'ok', server: 'stopping' } });
  step('négociation (q, *, refus), comparaison d’ETag (W/, suffixes, listes), santé : base, planificateur figé, démarrage, arrêt');

  /* ---------- 2. Module statique sur un dossier temporaire : versionnement et invalidation ---------- */
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true }); fs.mkdirSync(path.join(site, 'app'));
  const css1 = `body { color: #1C1915; }\n${'.x { margin: 0; }\n'.repeat(120)}`;
  fs.writeFileSync(path.join(site, 'assets', 's.css'), css1);
  fs.writeFileSync(path.join(site, 'assets', 'a.js'), 'console.log(1);');
  fs.writeFileSync(path.join(site, 'assets', '.secret'), 'non');
  const inline = "document.title = 'ok <script src=\"/assets/a.js\"></script>';";
  fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html><link rel="stylesheet" href="assets/s.css"><link rel="preconnect" href="https://fonts.gstatic.com"><script>${inline}</script><script src="/assets/a.js" defer></script><a href="/app/#login">x</a>`);
  fs.writeFileSync(path.join(site, 'app', 'index.html'), '<!doctype html><link rel="stylesheet" href="/assets/s.css"><script src="/assets/missing.js"></script>');
  const miniPort = await freePort();
  const mw = createStatic(site);
  mini = express().use(mw).use((_req, res) => res.status(404).end()).listen(miniPort, '127.0.0.1');
  await new Promise((r) => mini.once('listening', r));
  let r = await raw(miniPort, 'GET', '/', { headers: { 'accept-encoding': 'br' } });
  let html = decode(r).toString();
  const v1 = sha(css1, 12);
  assert.ok(html.includes(`href="assets/s.css?v=${v1}"`), 'référence relative versionnée par l’empreinte du contenu');
  assert.ok(html.includes(`src="/assets/a.js?v=${sha('console.log(1);', 12)}" defer`), 'script externe versionné');
  assert.ok(html.includes(`<script>${inline}</script>`), 'script en ligne intact (même s’il contient une balise)');
  assert.ok(html.includes('href="https://fonts.gstatic.com"') && html.includes('href="/app/#login"'), 'références externes et liens intacts');
  assert.equal(r.headers['cache-control'], 'no-cache');
  r = await raw(miniPort, 'GET', `/assets/s.css?v=${v1}`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable'); assert.equal(decode(r).toString(), css1);
  const css2 = `${css1}.y { padding: 1px; }\n`;
  fs.writeFileSync(path.join(site, 'assets', 's.css'), css2);
  html = decode(await raw(miniPort, 'GET', '/', { headers: { 'accept-encoding': 'br' } })).toString();
  const v2 = sha(css2, 12);
  assert.ok(v2 !== v1 && html.includes(`assets/s.css?v=${v2}"`), 'la page reprend la nouvelle empreinte dès que le fichier change');
  r = await raw(miniPort, 'GET', `/assets/s.css?v=${v1}`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.headers['cache-control'], 'no-cache', 'empreinte périmée : pas de cache longue durée'); assert.equal(decode(r).toString(), css2, 'contenu à jour');
  assert.equal((await raw(miniPort, 'GET', `/assets/s.css?v=${v2}`)).headers['cache-control'], 'public, max-age=31536000, immutable');
  r = await raw(miniPort, 'GET', '/app/tableau/de/bord');
  assert.equal(r.status, 200); assert.ok(r.body.toString().includes(`/assets/s.css?v=${v2}`) && r.body.toString().includes('src="/assets/missing.js"'), 'repli de l’application ; référence absente laissée telle quelle');
  assert.equal((await raw(miniPort, 'GET', '/assets/.secret')).status, 404, 'fichier caché jamais servi');
  assert.equal((await raw(miniPort, 'GET', '/assets/%2e%2e/index.html')).status, 404, 'remontée de dossier refusée');
  assert.equal((await raw(miniPort, 'POST', '/assets/s.css')).status, 404, 'GET et HEAD seulement');
  await new Promise((res) => mini.close(res)); mini = null;
  step('module statique : ?v= = empreinte du contenu, scripts en ligne intacts, invalidation à la modification, fichiers cachés refusés');

  /* ---------- 3. Serveur réel : santé ---------- */
  const PORT = await freePort();
  main = startServer(PORT, { DATABASE_PATH: DB, OUTBOX_DIR: path.join(tmp, 'outbox'), BACKUP_DIR: BACKUPS, STRIPE_WEBHOOK_SECRET: WHSEC, SHUTDOWN_TIMEOUT_MS: '8000' });
  await waitHealthy(PORT);
  const call = client(PORT);
  r = await raw(PORT, 'GET', '/api/health', { headers: { 'accept-encoding': 'br' } });
  let j = JSON.parse(r.body);
  assert.equal(r.status, 200); assert.equal(j.ok, true);
  for (const k of ['mail', 'billing', 'demo', 'time']) assert.ok(k in j, `champ ${k} conservé`);
  assert.equal(j.checks.db, 'ok'); assert.ok(['ok', 'starting'].includes(j.checks.scheduler));
  assert.equal(r.headers['content-encoding'], undefined, 'petite réponse jamais compressée');
  step('santé : 200 avec ok, mail, billing, demo, time et le détail (base, planificateur) ; petite réponse non compressée');

  /* ---------- 4. Compression de l'API ---------- */
  const admin = (await call('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG })).cookie;
  const lea = await member(call, 'lea@exemple.fr');
  const other = (await call('POST', '/auth/signup', { email: 'basile@exemple.fr', password: STRONG })).cookie;
  await call('POST', '/admin/tick', {}, admin);
  const plain = await raw(PORT, 'GET', '/api/brokers');
  assert.equal(plain.headers['content-encoding'], undefined); assert.ok(varies(plain), 'Vary: Accept-Encoding même sans compression');
  assert.ok(plain.body.length > 4096);
  for (const [ae, enc] of [['gzip, deflate, br, zstd', 'br'], ['gzip', 'gzip'], ['br;q=0, gzip;q=1', 'gzip']]) {
    r = await raw(PORT, 'GET', '/api/brokers', { headers: { 'accept-encoding': ae } });
    assert.equal(r.headers['content-encoding'], enc, ae); assert.ok(varies(r)); assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(r.body.length < plain.body.length / 3, `${enc} : ${r.body.length} octets`); assert.equal(Number(r.headers['content-length']), r.body.length);
    assert.ok(decode(r).equals(plain.body), `${enc} : contenu identique une fois décompressé`);
  }
  r = await raw(PORT, 'HEAD', '/api/brokers', { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.status, 200); assert.equal(r.body.length, 0); assert.equal(r.headers['content-encoding'], undefined, 'HEAD : pas de compression');
  // Webhook Stripe : corps brut signé (et volumineux), réponse jamais compressée.
  const event = JSON.stringify({ id: 'evt_perf_test_1', type: 'perf.test', data: { object: { padding: 'x'.repeat(8000) } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${ts}.${event}`).digest('hex');
  r = await raw(PORT, 'POST', '/api/billing/webhook', { headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}`, 'accept-encoding': 'gzip, br' }, body: event });
  assert.equal(r.status, 200, r.body.toString()); assert.deepEqual(JSON.parse(r.body), { received: true }); assert.equal(r.headers['content-encoding'], undefined);
  r = await raw(PORT, 'POST', '/api/billing/webhook', { headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}`, 'accept-encoding': 'br' }, body: event });
  assert.equal(r.status, 400, 'signature toujours vérifiée sur le corps brut');
  // Téléchargements : CSV et export JSON (Content-Disposition) jamais compressés.
  for (const p of ['/api/requests.csv', '/api/export']) {
    r = await raw(PORT, 'GET', p, { headers: { 'accept-encoding': 'br, gzip', cookie: lea } });
    assert.equal(r.status, 200); assert.match(r.headers['content-disposition'], /^attachment/);
    assert.equal(r.headers['content-encoding'], undefined, `${p} : téléchargement non compressé`);
    assert.ok(r.body.length > 2048, `${p} : assez volumineux pour être compressé`);
  }
  step('compression de l’API : br ou gzip selon Accept-Encoding, Vary, contenu identique ; ni HEAD, ni webhook, ni téléchargements');

  /* ---------- 5. Tableau de bord : ETag fort et 304 ---------- */
  r = await raw(PORT, 'GET', '/api/dashboard', { headers: { 'accept-encoding': 'br', cookie: lea } });
  assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], 'br'); assert.equal(r.headers['cache-control'], 'no-store');
  const json = decode(r);
  const etagBr = r.headers.etag;
  assert.equal(etagBr, `"${sha(json, 32)}-br"`, 'ETag fort = empreinte du JSON (+ suffixe de la variante brotli)');
  assert.equal(JSON.parse(json).requests.length >= 50, true);
  // Comme le client : fetch avec If-None-Match (fetch ajoute alors Cache-Control: no-cache et Pragma: no-cache).
  let f = await fetch(`http://localhost:${PORT}/api/dashboard`, { headers: { cookie: lea, 'if-none-match': etagBr } });
  assert.equal(f.status, 304, 'fetch conditionnel → 304'); assert.equal((await f.arrayBuffer()).byteLength, 0, '304 sans corps');
  assert.equal(f.headers.get('cache-control'), 'no-store'); assert.ok(f.headers.get('etag'));
  r = await raw(PORT, 'GET', '/api/dashboard', { headers: { cookie: lea, 'if-none-match': etagBr, 'cache-control': 'no-cache', pragma: 'no-cache' } });
  assert.equal(r.status, 304); assert.equal(r.body.length, 0); assert.equal(r.headers.etag, `"${sha(json, 32)}"`, 'client sans compression : ETag sans suffixe');
  r = await raw(PORT, 'GET', '/api/dashboard', { headers: { cookie: lea, 'if-none-match': `W/"${sha(json, 32)}"` } });
  assert.equal(r.status, 304, 'comparaison faible (W/)');
  r = await raw(PORT, 'GET', '/api/dashboard', { headers: { cookie: other, 'if-none-match': etagBr } });
  assert.equal(r.status, 200, 'un autre compte n’obtient jamais 304 avec cet ETag');
  assert.equal((await raw(PORT, 'GET', '/api/dashboard', { headers: { 'if-none-match': etagBr } })).status, 401, 'anonyme : 401 avant toute comparaison');
  assert.equal((await call('PUT', '/preferences', { monthly_report: false }, lea)).status, 200);   // le journal change
  f = await fetch(`http://localhost:${PORT}/api/dashboard`, { headers: { cookie: lea, 'if-none-match': etagBr } });
  assert.equal(f.status, 200, 'données modifiées → 200'); assert.notEqual(f.headers.get('etag'), etagBr); assert.ok((await f.json()).events.length > 0);
  step('tableau de bord : ETag fort calculé sur le JSON, 304 sans corps (fetch conditionnel, W/, sans suffixe), 200 dès que les données changent, no-store');

  /* ---------- 6. Pages et ressources : versionnement, cache, compression ---------- */
  const file = (rel) => fs.readFileSync(path.join(ROOT, rel));
  r = await raw(PORT, 'GET', '/', { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
  assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], 'br'); assert.equal(r.headers['cache-control'], 'no-cache'); assert.match(r.headers.etag, /^"[0-9a-f]{32}-br"$/);
  assert.ok(r.body.length < file('index.html').length / 3);
  html = decode(r).toString();
  for (const rel of ['assets/css/styles.css', 'assets/js/main.js', 'assets/favicon.svg']) assert.ok(html.includes(`${rel}?v=${sha(file(rel), 12)}"`), `landing : ${rel} versionné`);
  const csp = r.headers['content-security-policy'];
  const inlines = [...html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.ok(inlines.length >= 1);
  for (const s of inlines) assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`), 'CSP valide pour chaque script en ligne servi');
  const appHtml = decode(await raw(PORT, 'GET', '/app/', { headers: { 'accept-encoding': 'br' } })).toString();
  for (const rel of ['app/app.css', 'app/app.js', 'assets/favicon.svg']) assert.ok(appHtml.includes(`/${rel}?v=${sha(file(rel), 12)}"`), `application : /${rel} versionné`);
  const vJs = sha(file('app/app.js'), 12);
  r = await raw(PORT, 'GET', `/app/app.js?v=${vJs}`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable'); assert.equal(r.headers['content-encoding'], 'br'); assert.ok(varies(r));
  assert.ok(decode(r).equals(file('app/app.js')), 'app.js identique une fois décompressé');
  for (const q of ['', '?v=000000000000', `?v=${vJs}x`]) assert.equal((await raw(PORT, 'GET', `/app/app.js${q}`)).headers['cache-control'], 'no-cache', `sans empreinte valide (${q || 'aucune'}) : no-cache`);
  r = await raw(PORT, 'GET', '/assets/css/styles.css', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.headers['content-encoding'], 'gzip'); assert.ok(decode(r).equals(file('assets/css/styles.css')));
  const etagCss = r.headers.etag;
  r = await raw(PORT, 'GET', '/assets/css/styles.css', { headers: { 'accept-encoding': 'gzip', 'if-none-match': etagCss, 'cache-control': 'no-cache' } });
  assert.equal(r.status, 304); assert.equal(r.body.length, 0); assert.equal(r.headers['cache-control'], 'no-cache');
  r = await raw(PORT, 'GET', '/', { headers: { 'if-none-match': `"${sha(Buffer.from(html), 32)}"` } });
  assert.equal(r.status, 304, 'page HTML revalidée');
  r = await raw(PORT, 'GET', '/app/admin.js', { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.headers['cache-control'], 'no-cache'); assert.ok(decode(r).equals(file('app/admin.js')));
  assert.equal((await raw(PORT, 'GET', '/app/admin.js', { headers: { 'if-none-match': r.headers.etag } })).status, 304, 'admin.js (chargé sans ?v= par app.js) : 304');
  r = await raw(PORT, 'HEAD', '/app/app.css');
  assert.equal(r.status, 200); assert.equal(r.body.length, 0); assert.equal(Number(r.headers['content-length']), file('app/app.css').length);
  r = await raw(PORT, 'GET', '/app/settings/profil');
  assert.equal(r.status, 200); assert.ok(r.body.toString().includes(`/app/app.js?v=${vJs}`), 'route de l’application : page versionnée');
  assert.equal((await raw(PORT, 'GET', '/assets/absent.css')).status, 302, 'ressource absente : redirection comme avant');
  for (const p of ['/app/%2e%2e/server/index.js', '/app/.env', '/assets/..%2fserver%2findex.js']) {
    r = await raw(PORT, 'GET', p);
    assert.ok(!r.body.toString().includes('express'), `${p} : aucun fichier hors des dossiers publics`);
  }
  step('pages : ?v= = empreinte, CSP valide, HTML no-cache ; ressource versionnée immutable, sinon no-cache + ETag + 304 ; br/gzip identiques');

  /* ---------- 7. Sauvegardes ---------- */
  assert.equal((await call('POST', '/admin/backup', {})).status, 401);
  assert.equal((await call('POST', '/admin/backup', {}, lea)).status, 403);
  r = await call('POST', '/admin/backup', {}, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const first = r.data.backup;
  assert.match(first.file, /^oubli-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/); assert.ok(first.bytes > 0);
  const firstPath = path.join(BACKUPS, first.file);
  assert.equal(fs.statSync(firstPath).size, first.bytes);
  assert.equal(fs.statSync(firstPath).mode & 0o777, 0o600, 'sauvegarde lisible par le seul propriétaire');
  const copy = new DatabaseSync(firstPath, { readOnly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) AS c FROM users').get().c >= 3, 'sauvegarde exploitable'); assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();
  r = await call('GET', '/admin/audit?action=system.backup', undefined, admin);
  assert.equal(r.data.entries.length, 1); assert.equal(r.data.entries[0].details.file, first.file);
  fs.writeFileSync(path.join(BACKUPS, 'notes.txt'), 'à garder');
  let last = null;
  for (let i = 0; i < 8; i++) { r = await call('POST', '/admin/backup', {}, admin); assert.equal(r.status, 200); last = r.data.backup; }
  const kept = fs.readdirSync(BACKUPS).filter((n) => n.startsWith('oubli-')).sort();
  assert.equal(kept.length, 7, `rotation : ${kept.join(', ')}`);
  assert.ok(!kept.includes(first.file) && kept.includes(last.file), 'les plus anciennes sont supprimées, la dernière est gardée');
  assert.ok(fs.existsSync(path.join(BACKUPS, 'notes.txt')), 'fichiers étrangers intacts'); assert.ok(!kept.some((n) => n.endsWith('.part')));
  r = await call('GET', '/admin/system', undefined, admin);
  assert.equal(r.data.backup.enabled, true); assert.equal(r.data.backup.count, 7); assert.equal(r.data.backup.keep, 7); assert.equal(r.data.backup.last.file, last.file); assert.equal(r.data.env.BACKUP_DIR, true);
  step('sauvegardes : réservées aux administrateurs, fichier SQLite intègre en 0600, audit system.backup, rotation à 7, onglet Système');

  /* ---------- 8. Arrêt propre : requête en cours menée à terme, code 0, base fermée ---------- */
  const body = Buffer.from(JSON.stringify({ email: 'arret@exemple.fr' }));
  let finish = null;
  const pending = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/newsletter', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, 5));   // en-têtes et début du corps : la requête est en cours côté serveur
    finish = () => { if (!req.destroyed) req.end(body.subarray(5)); };
  });
  const outcome = pending.then((v) => v, (e) => ({ error: e.message }));   // jamais de rejet non géré
  await wait(200);
  main.proc.kill('SIGTERM');
  let refused = false;
  for (let i = 0; i < 40 && !refused; i++) {
    refused = await new Promise((resolve) => { const s = net.connect(PORT, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); });
    if (!refused) await wait(50);
  }
  assert.ok(refused, 'plus aucune nouvelle connexion après SIGTERM');
  await wait(300);
  finish();
  const done = await outcome;
  assert.ok(!done.error, `requête en cours coupée par l’arrêt : ${done.error}`);
  assert.equal(done.status, 200, done.body); assert.deepEqual(JSON.parse(done.body), { ok: true }); assert.equal(done.headers.connection, 'close');
  const exit = await Promise.race([main.exited, wait(10000).then(() => ({ timeout: true }))]);
  assert.deepEqual(exit, { code: 0, signal: null }, `sortie : ${JSON.stringify(exit)}`);
  assert.ok(!fs.existsSync(`${DB}-wal`), 'base fermée proprement (WAL reversé et supprimé)');
  const after = new DatabaseSync(DB, { readOnly: true });
  assert.ok(after.prepare('SELECT 1 FROM newsletter WHERE email = ?').get('arret@exemple.fr'), 'la requête en cours a été enregistrée');
  after.close();
  main = null;
  step('arrêt propre : SIGTERM ferme l’écoute, la requête en cours aboutit, sortie 0, base fermée');

  /* ---------- 9. Planificateur figé (SMTP muet), sauvegarde refusée dans un dossier public, arrêt borné ---------- */
  const holePort = await freePort();
  blackhole = net.createServer((s) => { holes.add(s); s.on('close', () => holes.delete(s)); }).listen(holePort, '127.0.0.1');
  const PORT2 = await freePort();
  second = startServer(PORT2, { DATABASE_PATH: path.join(tmp, 'stale.sqlite'), OUTBOX_DIR: path.join(tmp, 'outbox2'), SMTP_URL: `smtp://127.0.0.1:${holePort}`, ALLOW_UNVERIFIED_CONTACTS: 'true', MAIL_TIMEOUT_MS: '60000', SCHEDULER_INTERVAL_MS: '1000', SHUTDOWN_TIMEOUT_MS: '1500', BACKUP_DIR: PUBLIC_BACKUPS });
  await waitHealthy(PORT2);
  const call2 = client(PORT2);
  const admin2 = (await call2('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG })).cookie;
  r = await call2('GET', '/admin/system', undefined, admin2);
  assert.equal(r.data.backup.enabled, false); assert.match(r.data.backup.reason, /publiquement/);
  r = await call2('POST', '/admin/backup', {}, admin2);
  assert.equal(r.status, 409); assert.match(r.data.error, /désactivées/);
  assert.ok(!fs.existsSync(PUBLIC_BACKUPS), 'aucun dossier créé dans assets/');
  assert.equal((await fetch(`http://localhost:${PORT2}/api/health`)).status, 200);
  await member(call2, 'figee@exemple.fr');   // le passage suivant reste bloqué sur le premier courrier
  let stale = null;
  for (let i = 0; i < 40 && !stale; i++) {
    const x = await fetch(`http://localhost:${PORT2}/api/health`);
    if (x.status === 503) stale = { status: x.status, text: await x.text() }; else await wait(250);
  }
  assert.ok(stale, 'santé 503 quand le planificateur ne donne plus signe de vie');
  j = JSON.parse(stale.text);
  assert.equal(j.ok, false); assert.equal(j.checks.scheduler, 'stale'); assert.equal(j.checks.db, 'ok'); assert.equal(j.mail, 'smtp');
  assert.ok(!/smtp:\/\/|127\.0\.0\.1|sqlite|secret/i.test(stale.text), 'détail minimal, sans secret ni chemin');
  const t1 = Date.now();
  second.proc.kill('SIGTERM');
  const exit2 = await Promise.race([second.exited, wait(8000).then(() => ({ timeout: true }))]);
  assert.deepEqual(exit2, { code: 0, signal: null }, `sortie : ${JSON.stringify(exit2)}`);
  assert.ok(Date.now() - t1 < 5000, `arrêt borné malgré le passage bloqué (${Date.now() - t1} ms)`);
  assert.match(second.log(), /délai dépassé/);
  second = null;
  step('planificateur figé : santé 503 (scheduler stale, sans secret) ; sauvegarde refusée dans assets/ ; arrêt borné, sortie 0');

  console.log(`✔ Performance et fiabilité validées (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of [main, second]) if (s && s.log().trim()) console.error(s.log().split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  for (const s of [main, second]) if (s) s.proc.kill('SIGKILL');
  for (const s of holes) s.destroy();
  if (blackhole) blackhole.close();
  if (mini) mini.close();
  fs.rmSync(PUBLIC_BACKUPS, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
