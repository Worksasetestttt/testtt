// Test de bout en bout : démarre le serveur sur un port libre avec une base temporaire et déroule le parcours complet.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-'));
const PORT = 3900 + Math.floor(Math.random() * 100);
const env = { ...process.env, PORT: String(PORT), DATABASE_PATH: path.join(tmp, 'test.sqlite'), OUTBOX_DIR: path.join(tmp, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', SESSION_SECRET: 'test-secret', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test' };
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const base = `http://localhost:${PORT}/api`;
let cookie = '';
async function call(method, p, body, extraHeaders = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }
  let r = await call('GET', '/health'); assert.equal(r.data.ok, true);
  r = await call('GET', '/config'); assert.equal(r.data.plans.individuel.monthly, 500); assert.equal(r.data.plans.famille.monthly, 999); assert.equal(r.data.plans.individuel.annual, undefined, 'formule unique');
  r = await call('POST', '/auth/signup', { email: 'admin@test.fr', password: 'motdepasse-solide', plan: 'famille', billing: 'annual' }); assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await call('POST', '/auth/signup', { email: 'admin@test.fr', password: 'motdepasse-solide' }); assert.equal(r.status, 409);
  r = await call('GET', '/me'); assert.equal(r.data.user.role, 'admin');
  const pid = r.data.profiles[0].id;
  r = await call('POST', '/requests/launch', {}); assert.equal(r.status, 400, 'lancement refusé sans mandat');
  r = await call('PUT', `/profiles/${pid}`, { first_name: 'Marie', last_name: 'Dupont', birth_date: '1991-06-14', emails: 'marie@test.fr', phones: ['+33 6 00 00 00 00'], addresses: ['1 rue Test, Lyon'] }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('GET', '/mandate'); assert.equal(r.data.signed, false); assert.ok(r.data.text.includes('MANDAT'));
  r = await call('POST', '/mandate', { full_name: 'marie dupont', accepted: true }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('POST', '/billing/checkout', { plan: 'famille', billing: 'monthly' }); assert.equal(r.data.mode, 'simulated');
  r = await call('POST', '/profiles', { first_name: 'Paul', last_name: 'Dupont' }); assert.equal(r.status, 201);
  r = await call('POST', '/requests/launch', {}); assert.ok(r.data.created >= 100, 'deux profils × courtiers');
  await wait(1500);
  r = await call('GET', '/dashboard'); assert.equal(r.data.counters.sent, r.data.counters.total); assert.equal(r.data.exposure, 100);
  const req = r.data.requests[0];
  r = await call('GET', `/requests/${req.id}/mails`); assert.ok(r.data.mails[0].body.includes('article 17'));
  // Réponse entrante d'un courtier via webhook (jeton absent → 401 ; présent → traitement)
  r = await call('POST', '/inbound', { subject: `Re: ${req.ref}`, text: 'Your data has been deleted.' }); assert.equal(r.status, 401);
  process.env.INBOUND_TOKEN = 'x';
  r = await call('POST', '/admin/requests/' + req.id + '/outcome', { outcome: 'done', note: 'test' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('GET', '/dashboard'); assert.equal(r.data.counters.done, 1); assert.ok(r.data.exposure < 100); assert.ok(r.data.next_check_at);
  r = await call('GET', '/admin/stats'); assert.equal(r.data.active, 1);
  r = await call('POST', '/billing/cancel'); assert.equal(r.status, 200);
  r = await call('GET', '/export'); assert.ok(Array.isArray(r.data.requests));
  r = await call('DELETE', '/account', { password: 'motdepasse-solide' }); assert.equal(r.status, 200);
  r = await call('GET', '/me'); assert.equal(r.status, 200); assert.equal(r.data.user, null, 'session détruite');
  assert.ok(fs.readdirSync(path.join(tmp, 'outbox')).length >= 100, 'courriers écrits dans la boîte d’envoi');
  console.log('✔ Parcours complet validé (inscription → profil → mandat → abonnement → demandes → réponse → résiliation → export → suppression).');
} catch (e) { console.error('✘ Échec :', e.message); process.exitCode = 1; }
finally { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
