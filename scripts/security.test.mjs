// Test de sécurité de bout en bout : démarre le serveur sur un port libre avec une base temporaire et vérifie
// en-têtes, cookies, CSRF, validation des corps, autorisation, verrouillage, limitation de débit, sessions, webhooks.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-sec-'));
const PORT = await freePort();
const DB = path.join(tmp, 'test.sqlite');
const INBOUND = 'inbound-secret-token-0123456789';
const env = {
  ...process.env, PORT: String(PORT), DATABASE_PATH: DB, OUTBOX_DIR: path.join(tmp, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  SESSION_SECRET: 'test-secret-for-security-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr', INBOUND_TOKEN: INBOUND, SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test',
  APP_URL: 'https://oubli.test',
};
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });
const origin = `http://localhost:${PORT}`;
const base = `${origin}/api`;
const STRONG = 'Corde-a-linge-78!';

// Appel JSON : pas de Content-Type sans corps (comme app.js), cookie et en-têtes optionnels.
async function call(method, p, body, { cookie = '', headers = {}, raw } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined && raw === undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { _text: text }; }
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, data, headers: r.headers, cookie: sc ? sc.split(';')[0] : '', text };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function signup(email, password = STRONG, extra = {}) {
  const r = await call('POST', '/auth/signup', { email, password, ...extra });
  assert.equal(r.status, 201, `inscription ${email} : ${JSON.stringify(r.data)}`);
  return { cookie: r.cookie, user: r.data.user };
}
async function login(email, password = STRONG) { const r = await call('POST', '/auth/login', { email, password }); return r; }
const noSecrets = (obj, sid) => {
  const s = JSON.stringify(obj);
  for (const bad of ['password_hash', 'stripe_customer_id', 'stripe_subscription_id', 'mandate_ip', 'scrypt$']) assert.ok(!s.includes(bad), `fuite : ${bad}`);
  if (sid) assert.ok(!s.includes(sid), 'fuite : identifiant de session');
};
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }

  /* ---------- 1. En-têtes de sécurité ---------- */
  let r = await call('GET', '/health');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy') || '';
  for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "connect-src 'self'", "form-action 'self' https://checkout.stripe.com", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']) assert.ok(csp.includes(d), `CSP sans ${d}`);
  const inline = fs.readFileSync('index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(inline, 'utf8').digest('base64')}'`), 'empreinte du script en ligne de la landing absente de la CSP');
  assert.ok(!csp.includes("'unsafe-inline'") || csp.includes("style-src 'self' 'unsafe-inline'"), "unsafe-inline uniquement pour style-src");
  assert.ok(!/script-src[^;]*unsafe/.test(csp), 'script-src ne doit pas contenir unsafe-*');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('x-permitted-cross-domain-policies'), 'none');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(/^[0-9a-f]{16}$/.test(r.headers.get('x-request-id') || ''), 'X-Request-Id');
  assert.equal(r.headers.get('x-powered-by'), null);
  const landing = await fetch(origin + '/');
  assert.equal(landing.status, 200); assert.equal(landing.headers.get('content-security-policy'), csp, 'même CSP sur la landing');
  const appPage = await fetch(origin + '/app/');
  assert.equal(appPage.status, 200); assert.ok(appPage.headers.get('content-security-policy'));
  step('en-têtes de sécurité (CSP avec empreinte, nosniff, DENY, COOP, CORP, no-store, X-Request-Id)');

  /* ---------- 2. Cookies malformés ou falsifiés → anonyme 200 ---------- */
  const fakeId = crypto.randomBytes(24).toString('base64url'), fakeSig = crypto.randomBytes(32).toString('base64url');
  for (const c of ['oubli_sid=abc.def', 'oubli_sid=' + fakeId + '.' + fakeSig, 'oubli_sid=%zz%', 'oubli_sid=' + fakeId, 'oubli_sid=.', 'oubli_sid=' + 'x'.repeat(5000)]) {
    r = await call('GET', '/me', undefined, { cookie: c });
    assert.equal(r.status, 200, c); assert.equal(r.data.user, null, c);
  }
  step('cookie absent, malformé, longueur différente ou falsifié → 200 anonyme');

  /* ---------- 3. Corps de requête ---------- */
  r = await call('POST', '/auth/signup'); assert.equal(r.status, 400, 'corps absent → 400');
  r = await call('POST', '/auth/login', undefined, { raw: '[1]', headers: { 'content-type': 'application/json' } }); assert.equal(r.status, 400); assert.match(r.data.error, /objet JSON/);
  r = await call('POST', '/auth/login', undefined, { raw: '"x"', headers: { 'content-type': 'application/json' } }); assert.equal(r.status, 400);
  r = await call('POST', '/auth/login', undefined, { raw: '{', headers: { 'content-type': 'application/json' } }); assert.equal(r.status, 400); assert.equal(r.data.error, 'JSON invalide.');
  r = await call('POST', '/auth/login', undefined, { raw: JSON.stringify({ a: 'x'.repeat(210000) }), headers: { 'content-type': 'application/json' } }); assert.equal(r.status, 413); assert.ok(r.data.error && !/entity/i.test(r.data.error), 'message 413 générique en français');
  r = await call('POST', '/auth/signup', { email: ['a@b.fr'], password: STRONG }); assert.equal(r.status, 400, 'e-mail non chaîne');
  r = await call('POST', '/auth/signup', { email: 'x@test.fr', password: { toString: 1 } }); assert.equal(r.status, 400, 'mot de passe non chaîne');
  r = await call('GET', '/nope'); assert.equal(r.status, 404); assert.equal(r.data.error, 'Route inconnue.');
  r = await call('POST', '/nope', {}); assert.equal(r.status, 404);
  r = await fetch(base + '/%zz'); assert.ok([400, 404].includes(r.status)); assert.ok(JSON.parse(await r.text()).error);
  step('corps absent / tableau / chaîne / JSON invalide / trop gros → 400-413 JSON ; route inconnue → 404 JSON');

  /* ---------- 4. Politique de mot de passe ---------- */
  for (const [pw, why] of [['a'.repeat(129), 'trop long'], ['court', 'trop court'], ['password123', 'courant'], ['azertyuiop', 'courant'], ['1234567890', 'chiffres'], ['marie.dupont2024', 'contient le local-part'], ['xxmariexx-1', 'contient un segment du local-part']]) {
    r = await call('POST', '/auth/signup', { email: 'marie.dupont@test.fr', password: pw }); assert.equal(r.status, 400, why); assert.ok(r.data.error);
  }
  step('mot de passe trop long / trop court / courant / contenant l’e-mail → 400');

  /* ---------- 5. Inscriptions et CSRF ---------- */
  const A = await signup('a@test.fr', STRONG, { plan: 'famille', billing: 'monthly' });
  assert.equal(A.user.plan, 'famille');
  const B = await signup('b@test.fr');
  const sidA = A.cookie.split('=')[1].split('.')[0];
  r = await call('GET', '/me', undefined, { cookie: A.cookie }); assert.equal(r.data.user.email, 'a@test.fr'); noSecrets(r.data, sidA);
  const pidA = r.data.profiles[0].id;
  r = await call('GET', '/me', undefined, { cookie: B.cookie }); const pidB = r.data.profiles[0].id;
  assert.match(A.cookie, /^oubli_sid=[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/);
  const scA = (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.fr', password: STRONG }) })).headers.get('set-cookie');
  assert.ok(/HttpOnly/.test(scA) && /SameSite=Lax/.test(scA) && /Path=\//.test(scA), 'attributs du cookie');
  const A2 = scA.split(';')[0];

  r = await call('POST', '/profiles', undefined, { cookie: A.cookie, raw: 'first_name=x&last_name=y', headers: { 'content-type': 'application/x-www-form-urlencoded' } }); assert.equal(r.status, 415);
  r = await call('POST', '/profiles', undefined, { cookie: A.cookie, raw: '{"first_name":"x","last_name":"y"}', headers: { 'content-type': 'text/plain' } }); assert.equal(r.status, 415);
  r = await call('POST', '/profiles', { first_name: 'x', last_name: 'y' }, { cookie: A.cookie, headers: { origin: 'https://evil.example' } }); assert.equal(r.status, 403);
  r = await call('POST', '/profiles', { first_name: 'x', last_name: 'y' }, { cookie: A.cookie, headers: { origin: 'null' } }); assert.equal(r.status, 403);
  r = await call('POST', '/profiles', { first_name: 'x', last_name: 'y' }, { cookie: A.cookie, headers: { referer: 'https://evil.example/page' } }); assert.equal(r.status, 403);
  r = await call('POST', '/profiles', { first_name: 'x', last_name: 'y' }, { cookie: A.cookie, headers: { origin, referer: origin + '/app/' } }); assert.equal(r.status, 201, 'même origine acceptée');
  const pidA2 = r.data.profile.id;
  r = await call('POST', '/profiles', { first_name: 'x', last_name: 'y' }, { cookie: A.cookie, headers: { origin: 'https://oubli.test' } }); assert.equal(r.status, 201, 'origine APP_URL acceptée');
  r = await call('POST', '/auth/logout', undefined, { cookie: A2, headers: { origin } }); assert.equal(r.status, 200, 'POST sans corps ni Content-Type, même origine');
  r = await call('GET', '/me', undefined, { cookie: A2 }); assert.equal(r.data.user, null, 'session A2 détruite');
  r = await call('GET', '/me', undefined, { cookie: A.cookie, headers: { origin: 'https://evil.example' } }); assert.equal(r.status, 200, 'GET jamais bloqué');
  step('CSRF : formulaire → 415, Origin/Referer étrangers → 403, même origine / APP_URL → OK, POST sans corps → OK');

  /* ---------- 6. Autorisation ---------- */
  r = await call('PUT', `/profiles/${pidA}`, { first_name: 'Alice', last_name: 'Martin', emails: ['alice@test.fr'], phones: ['+33 6 00 00 00 00'] }, { cookie: A.cookie }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('PUT', `/profiles/${pidA}`, { phones: ['abc'] }, { cookie: A.cookie }); assert.equal(r.status, 400, 'téléphone invalide');
  r = await call('PUT', `/profiles/${pidA}`, { birth_date: '2099-02-30' }, { cookie: A.cookie }); assert.equal(r.status, 400, 'date invalide');
  r = await call('PUT', `/profiles/${pidA}`, { emails: { a: 1 } }, { cookie: A.cookie }); assert.equal(r.status, 400, 'liste invalide');
  r = await call('PUT', `/profiles/${pidA}`, { country: 'France' }, { cookie: A.cookie }); assert.equal(r.status, 400, 'pays invalide');
  r = await call('POST', '/mandate', { full_name: 'alice martin', accepted: true }, { cookie: A.cookie }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('POST', '/billing/checkout', { plan: 'constructor', billing: 'monthly' }, { cookie: A.cookie }); assert.equal(r.status, 400, 'plan hors liste blanche');
  r = await call('POST', '/billing/checkout', { plan: 'famille', billing: 'weekly' }, { cookie: A.cookie }); assert.equal(r.status, 400, 'billing hors liste blanche');
  r = await call('POST', '/billing/checkout', { plan: 'famille', billing: 'monthly' }, { cookie: A.cookie }); assert.equal(r.data.mode, 'simulated');
  r = await call('POST', '/requests/launch', { profile_id: pidA }, { cookie: A.cookie }); assert.ok(r.data.created > 0, JSON.stringify(r.data));
  r = await call('POST', '/requests/launch', { profile_id: pidB }, { cookie: A.cookie }); assert.equal(r.status, 404, 'profil d’autrui au lancement');
  r = await call('POST', '/requests/launch', { profile_id: { $ne: 1 } }, { cookie: A.cookie }); assert.equal(r.status, 404);
  r = await call('GET', '/dashboard', undefined, { cookie: A.cookie }); assert.equal(r.status, 200); const reqA = r.data.requests[0]; assert.ok(reqA?.id); noSecrets(r.data, sidA);
  r = await call('GET', `/dashboard?profile_id=${pidA}`, undefined, { cookie: B.cookie }); assert.equal(r.status, 200); assert.equal(r.data.profile_id, pidB, 'B ne voit pas le dossier de A');
  r = await call('GET', `/dashboard?profile_id[]=${pidA}&profile_id=${pidA}&__proto__=1`, undefined, { cookie: B.cookie }); assert.equal(r.status, 200, 'paramètres de requête assainis');
  r = await call('PUT', `/profiles/${pidA}`, { first_name: 'Hack' }, { cookie: B.cookie }); assert.equal(r.status, 404);
  r = await call('DELETE', `/profiles/${pidA2}`, undefined, { cookie: B.cookie }); assert.equal(r.status, 404);
  r = await call('POST', `/requests/${reqA.id}/resolve`, undefined, { cookie: B.cookie }); assert.equal(r.status, 404);
  r = await call('GET', `/requests/${reqA.id}/mails`, undefined, { cookie: B.cookie }); assert.equal(r.status, 404);
  r = await call('GET', `/requests/${reqA.id}/mails`, undefined, { cookie: A.cookie }); assert.equal(r.status, 200);
  r = await call('GET', `/requests/${encodeURIComponent("' OR 1=1 --")}/mails`, undefined, { cookie: A.cookie }); assert.equal(r.status, 404);
  for (const p of [`/requests/${reqA.id}/mails`, '/dashboard', '/profiles', '/export', '/mandate']) { r = await call('GET', p); assert.equal(r.status, 401, p); }
  for (const [m, p] of [['POST', '/requests/launch'], ['PUT', `/profiles/${pidA}`], ['DELETE', '/account'], ['POST', '/auth/logout-all'], ['POST', '/billing/checkout']]) { r = await call(m, p, {}); assert.equal(r.status, 401, `${m} ${p}`); }
  r = await call('GET', `/profiles/${pidA}`, undefined, { cookie: A.cookie }); assert.equal(r.status, 404, 'pas de GET /profiles/:id');
  r = await call('GET', '/admin/stats', undefined, { cookie: B.cookie }); assert.equal(r.status, 403);
  r = await call('POST', `/admin/requests/${reqA.id}/outcome`, { outcome: 'done' }, { cookie: B.cookie }); assert.equal(r.status, 403);
  r = await call('GET', '/admin/stats'); assert.equal(r.status, 401);
  const ADM = await signup('admin@test.fr'); assert.equal(ADM.user.role, 'admin');
  r = await call('GET', '/admin/stats', undefined, { cookie: ADM.cookie }); assert.equal(r.status, 200);
  r = await call('GET', '/export', undefined, { cookie: A.cookie }); assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition') || '', /attachment/); noSecrets(r.data, sidA); assert.ok(Array.isArray(r.data.requests));
  r = await call('GET', '/brokers'); assert.equal(r.status, 200); assert.ok(r.data.brokers.length > 0); assert.ok(!r.text.includes('contact_email') && !r.text.includes('contact_verified'), 'brokers : pas de contact_email');
  step('autorisation : B → 404 sur les ressources de A, 403 sur /admin, anonyme → 401 ; /me, /export, /dashboard sans secret ; /brokers sans contact_email');

  /* ---------- 7. Verrouillage de compte ---------- */
  const L = await signup('lock@test.fr');
  for (let i = 1; i <= 10; i++) { r = await login('lock@test.fr', 'Mauvais-mot-de-passe-' + i); assert.equal(r.status, 401, `échec ${i}`); assert.equal(r.data.error, 'E-mail ou mot de passe incorrect.'); }
  r = await login('lock@test.fr', 'Mauvais-mot-de-passe-11'); assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0, 'Retry-After');
  r = await login('lock@test.fr', STRONG); assert.equal(r.status, 429, 'verrouillé même avec le bon mot de passe');
  const lockMsg = r.data.error;
  r = await login('inconnu@test.fr', STRONG); assert.equal(r.status, 401); assert.equal(r.data.error, 'E-mail ou mot de passe incorrect.', 'message générique');
  // Adresse sans compte : même verrouillage, même message (le blocage ne révèle pas l'existence du compte).
  for (let i = 1; i <= 10; i++) { r = await login('fantome@test.fr', 'Mauvais-mot-de-passe-' + i); assert.equal(r.status, 401, `échec ${i} (adresse inconnue)`); }
  r = await login('fantome@test.fr', STRONG); assert.equal(r.status, 429, 'adresse inconnue verrouillée de même'); assert.equal(r.data.error, lockMsg, 'message de verrouillage identique');
  r = await login('a@test.fr', 'x'.repeat(200)); assert.equal(r.status, 401, 'mot de passe trop long à la connexion → 401 générique');
  r = await call('GET', '/me', undefined, { cookie: L.cookie }); assert.equal(r.data.user.email, 'lock@test.fr', 'la session existante survit au verrouillage');
  step('verrouillage : 10 échecs depuis un client → 429 + Retry-After pour ce client, message générique, même verrouillage pour une adresse sans compte');

  /* ---------- 8. Sessions : logout-all, changement de mot de passe, plafond, IP, index ---------- */
  const s1 = (await login('b@test.fr')).cookie, s2 = (await login('b@test.fr')).cookie;
  r = await call('POST', '/auth/logout-all', undefined, { cookie: B.cookie }); assert.equal(r.status, 200); assert.equal(r.data.revoked, 2);
  r = await call('GET', '/me', undefined, { cookie: s1 }); assert.equal(r.data.user, null);
  r = await call('GET', '/me', undefined, { cookie: s2 }); assert.equal(r.data.user, null);
  r = await call('GET', '/me', undefined, { cookie: B.cookie }); assert.equal(r.data.user.email, 'b@test.fr', 'la session courante est conservée');
  const s3 = (await login('b@test.fr')).cookie;
  r = await call('POST', '/auth/password', { current: 'faux', next: STRONG + 'x' }, { cookie: B.cookie }); assert.equal(r.status, 400);
  r = await call('POST', '/auth/password', { current: STRONG, next: 'b-b-b-b-b-b' }, { cookie: B.cookie }); assert.equal(r.status, 400, 'nouveau mot de passe faible');
  r = await call('POST', '/auth/password', { current: STRONG, next: 'Nouveau-mdp-tres-solide-9' }, { cookie: B.cookie }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('GET', '/me', undefined, { cookie: s3 }); assert.equal(r.data.user, null, 'autres sessions déconnectées après changement de mot de passe');
  r = await login('b@test.fr', STRONG); assert.equal(r.status, 401);
  r = await login('b@test.fr', 'Nouveau-mdp-tres-solide-9'); assert.equal(r.status, 200);
  const C = await signup('c@test.fr');
  for (let i = 0; i < 12; i++) assert.equal((await login('c@test.fr')).status, 200);
  const db = new DatabaseSync(DB);
  // Changement depuis les paramètres : le titulaire est prévenu par e-mail.
  assert.match(db.prepare(`SELECT body FROM mails WHERE to_addr = 'b@test.fr' AND subject = 'Votre mot de passe Oubli a été changé' ORDER BY id DESC`).get()?.body || '', /depuis les paramètres/, 'avis de changement de mot de passe');
  const cId = C.user.id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(cId).n, 10, 'plafond de 10 sessions');
  assert.ok(db.prepare('SELECT ip FROM sessions WHERE user_id = ? LIMIT 1').get(cId).ip, 'IP stockée');
  assert.ok(db.prepare('PRAGMA index_list(sessions)').all().some((i) => i.name === 'idx_sessions_user'), 'index sessions(user_id)');
  assert.ok(db.prepare('SELECT expires_at, created_at FROM sessions WHERE user_id = ? LIMIT 1').get(cId).expires_at > new Date().toISOString(), 'expiration future');
  // Promotion administrateur à la connexion (jamais de rétrogradation automatique).
  db.prepare(`UPDATE users SET role = 'user' WHERE email = 'admin@test.fr'`).run();
  r = await login('admin@test.fr'); assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin', 'promotion à la connexion');
  db.prepare(`UPDATE users SET role = 'admin' WHERE email = 'c@test.fr'`).run();
  r = await login('c@test.fr'); assert.equal(r.data.user.role, 'admin', 'pas de rétrogradation automatique');
  db.close();
  step('sessions : logout-all, invalidation après changement de mot de passe, plafond 10, IP, index, promotion admin');

  /* ---------- 9. Limitation de débit ---------- */
  let last;
  for (let i = 0; i < 25; i++) { last = await call('POST', '/newsletter', { email: `n${i}@test.fr` }); if (last.status === 429) break; }
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0, 'Retry-After');
  assert.ok(last.data.error, 'message JSON');
  r = await call('POST', '/contact', { email: 'x@test.fr', message: 'Bonjour, test.' }); assert.equal(r.status, 200, 'autre route non affectée');
  step('limitation de débit : /newsletter → 429 + Retry-After, clé par route');

  /* ---------- 10. Webhooks : jeton seul, cookies ignorés ---------- */
  r = await call('POST', '/inbound', { subject: `Re: ${reqA.ref}`, text: 'deleted' }); assert.equal(r.status, 401);
  r = await call('POST', '/inbound', { subject: `Re: ${reqA.ref}`, text: 'deleted' }, { headers: { 'x-inbound-token': 'nope' } }); assert.equal(r.status, 401);
  r = await call('POST', '/inbound', { subject: `Re: ${reqA.ref}`, text: 'deleted' }, { headers: { 'x-inbound-token': INBOUND + 'x' } }); assert.equal(r.status, 401);
  r = await call('POST', '/inbound', { subject: 'Re: OUBLI-0000000000', text: 'deleted' }, { headers: { 'x-inbound-token': INBOUND } }); assert.equal(r.status, 202); assert.equal(r.data.matched, false);
  r = await call('POST', '/inbound', { subject: 'x', text: ['a'] }, { headers: { 'x-inbound-token': INBOUND } }); assert.equal(r.status, 400, 'champ non chaîne');
  r = await call('POST', '/inbound', { subject: `Re: ${reqA.ref}`, text: 'Your data has been deleted.' }, { cookie: ADM.cookie, headers: { 'x-inbound-token': INBOUND, origin: 'https://evil.example' } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.outcome, 'done');
  r = await call('POST', '/billing/webhook', undefined, { cookie: ADM.cookie, raw: '{"type":"checkout.session.completed"}', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'Signature invalide.');
  step('webhooks : /inbound 401 sans ou avec mauvais jeton, OK avec le bon (cookies et Origin ignorés) ; Stripe sans signature → 400');

  /* ---------- 11. Suppression de compte ---------- */
  r = await call('DELETE', '/account', {}, { cookie: A.cookie }); assert.equal(r.status, 400);
  r = await call('DELETE', '/account', { password: 'faux-mot-de-passe' }, { cookie: A.cookie }); assert.equal(r.status, 400);
  r = await call('DELETE', '/account', { password: STRONG }, { cookie: A.cookie }); assert.equal(r.status, 200);
  r = await call('GET', '/me', undefined, { cookie: A.cookie }); assert.equal(r.data.user, null);
  r = await login('a@test.fr'); assert.equal(r.status, 401);
  step('suppression de compte : mot de passe exigé, sessions détruites');

  assert.ok(!/TypeError|RangeError|→ 500/.test(serverErr), `erreurs serveur :\n${serverErr}`);
  console.log(`✔ Sécurité validée (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr) console.error(serverErr.slice(-2000));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000).unref(); });   // attendre l'arrêt : le serveur peut encore écrire dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
