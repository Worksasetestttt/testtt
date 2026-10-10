// Tests de régression des bugs fonctionnels corrigés : un groupe par bug. Chaque groupe démarre au besoin son propre
// serveur (port libre, base temporaire, jamais data/) avec la configuration qu'il exige : Stripe, SMTP factice, etc.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-reg-'));
const STRONG = 'Corde-a-linge-78!', INBOUND = 'inbound-secret-token-0123456789', WHSEC = 'whsec_regression_0123456789';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 5500 + Math.floor(Math.random() * 300);
const servers = [];
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

async function call(base, method, p, body, cookie = '', headers = {}) {
  const h = { ...headers }; if (cookie) h.cookie = cookie; if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
  const sc = r.headers.get('set-cookie') || ''; return { status: r.status, data, text, headers: r.headers, cookie: sc ? sc.split(';')[0] : '' };
}
// Démarre un serveur : `extra` complète l'environnement de test, `cwd` permet de lancer une copie du dépôt, `db` de
// reprendre une base existante (redémarrage).
async function start(name, extra = {}, { cwd = ROOT, db } = {}) {
  const dir = path.join(tmp, `${name}-${nextPort}`); fs.mkdirSync(dir, { recursive: true });
  const port = nextPort++;
  const env = {
    ...process.env, PORT: String(port), DATABASE_PATH: db || path.join(dir, 'test.sqlite'), OUTBOX_DIR: path.join(dir, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: WHSEC, SESSION_SECRET: 'test-secret-for-regression-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr',
    INBOUND_TOKEN: INBOUND, SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off', ...extra,
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
  const s = { name, port, origin: `http://localhost:${port}`, base: `http://localhost:${port}/api`, db: env.DATABASE_PATH, err: '', child };
  child.stderr.on('data', (d) => { s.err += d; });
  servers.push(s);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(s.base + '/health')).ok) break; } catch {} await wait(100); }
  s.call = (method, p, body, cookie, headers) => call(s.base, method, p, body, cookie, headers);
  s.stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once('exit', res); child.kill(); });
  s.sql = () => { const d = new DatabaseSync(s.db); d.exec('PRAGMA busy_timeout = 5000'); return d; };
  return s;
}
let seq = 0;
// Abonné complet : profil, mandat, abonnement (simulé), demandes lancées.
async function member(s, { plan = 'individuel', subscribe = true, launch = true, first = 'Léa', last = 'Moreau' } = {}) {
  const email = `abonne${++seq}@exemple.fr`;
  const r = await s.call('POST', '/auth/signup', { email, password: STRONG, plan });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cookie = r.cookie;
  const me = await s.call('GET', '/me', undefined, cookie);
  await s.call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: first, last_name: last }, cookie);
  await s.call('POST', '/mandate', { full_name: `${first} ${last}`, accepted: true }, cookie);
  if (subscribe) await s.call('POST', '/billing/checkout', { plan }, cookie);
  if (subscribe && launch) await s.call('POST', '/requests/launch', {}, cookie);
  return { cookie, id: me.data.user.id, email, pid: me.data.profiles[0].id };
}
async function adminOf(s) {
  let r = await s.call('POST', '/auth/login', { email: 'admin@test.fr', password: STRONG });
  if (r.status !== 200) r = await s.call('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG });
  return r.cookie;
}
// Événement Stripe signé (STRIPE_WEBHOOK_SECRET du serveur de test).
async function stripeEvent(s, type, object, id = `evt_${crypto.randomBytes(8).toString('hex')}`) {
  const raw = JSON.stringify({ id, type, data: { object } }), t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  const r = await fetch(s.base + '/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: raw });
  assert.equal(r.status, 200, `webhook ${type} : ${await r.text()}`);
}
const inbound = (s, subject, text) => s.call('POST', '/inbound', { subject, text, from: 'dpo@courtier.fr' }, '', { 'x-inbound-token': INBOUND });

try {
  /* ---------- 1. Installation dans un dossier dont le chemin contient un dossier caché ---------- */
  // res.sendFile(chemin absolu) refuse tout chemin contenant un segment « .xxx » (dotfiles: ignore) : landing et
  // repli de l'application en 404 dès que le dépôt vit sous ~/.local, .claude/worktrees, /srv/.apps…
  {
    const copy = path.join(tmp, '.cache', 'oubli');
    for (const x of ['server', 'app', 'assets', 'index.html', 'package.json']) fs.cpSync(path.join(ROOT, x), path.join(copy, x), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(copy, 'node_modules'), 'dir');
    const s = await start('dotdir', {}, { cwd: copy });
    let r = await fetch(s.origin + '/');
    assert.equal(r.status, 200, 'landing servie'); assert.match(await r.text(), /<html/i);
    r = await fetch(s.origin + '/app/'); assert.equal(r.status, 200);
    r = await fetch(s.origin + '/app/une-page-inconnue'); assert.equal(r.status, 200, 'repli de l’application sur index.html');
    assert.match(await r.text(), /app\.js/);
    await s.stop();
  }
  step('chemin d’installation contenant un dossier caché : landing et repli de l’application servis (plus de 404)');

  console.log(`✔ Régressions validées (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err.trim()) console.error(`[${s.name}]`, s.err.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((s) => s.stop()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
