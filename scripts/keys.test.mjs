// Test des clés d'activation (abonnements offerts sans paiement) : démarre le serveur sur un port libre avec une base
// temporaire et vérifie la création réservée aux administrateurs, le format et l'unicité des clés, l'absence de la clé
// en clair (liste, audit, base, console, courriers), l'activation (abonnement actif, demandes lancées), la saisie
// tolérante, les erreurs, le cumul, les refus (carte, simulé, équipe), les webhooks Stripe tardifs, la concurrence,
// l'expiration et son balayage, la limitation de débit, l'accès support en lecture seule et l'administration.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-keys-'));
const PORT = await freePort();
const DB = path.join(tmp, 'test.sqlite');
const OUTBOX = path.join(tmp, 'outbox');
const WHSEC = 'whsec_keys_suite_0123456789abcdef';
// TRUST_PROXY=1 : chaque acteur du test présente sa propre adresse (X-Forwarded-For), ce qui permet d'éprouver
// séparément la limite par compte et la limite par adresse IP.
const env = {
  ...process.env, PORT: String(PORT), DATABASE_PATH: DB, OUTBOX_DIR: OUTBOX, DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: WHSEC,
  SESSION_SECRET: 'test-secret-for-keys-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off', TRUST_PROXY: '1', INBOUND_TOKEN: '',
};
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '', serverErr = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverErr += d; });
const base = `http://localhost:${PORT}/api`, STRONG = 'Corde-a-linge-78!';
const DAY = 86400000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_RE = /^OUBLI-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (iso, ms, tol = 120000) => Math.abs(Date.parse(iso) - ms) < tol;
const plusDays = (iso, d) => new Date(Date.parse(iso) + d * DAY).toISOString();
let ipSeq = 0;
const newIp = () => { ipSeq += 1; return `10.0.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

async function call(method, p, body, { cookie = '', ip = '10.255.255.1', headers = {} } = {}) {
  const h = { 'x-forwarded-for': ip, ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, data, text, headers: r.headers, cookie: sc ? sc.split(';')[0] : '' };
}
// Un acteur : un compte, sa session et sa propre adresse IP ; « complete » renseigne le profil et signe le mandat.
async function actor(email, { complete = false } = {}) {
  const ip = newIp();
  const r = await call('POST', '/auth/signup', { email, password: STRONG }, { ip });
  assert.equal(r.status, 201, `inscription ${email} : ${JSON.stringify(r.data)}`);
  const a = { email, ip, cookie: r.cookie, id: r.data.user.id };
  a.call = (method, p, body, opts = {}) => call(method, p, body, { cookie: a.cookie, ip: a.ip, ...opts });
  a.redeem = (key, opts) => a.call('POST', '/billing/redeem', { key }, opts);
  if (complete) {
    const me = await a.call('GET', '/me');
    assert.equal((await a.call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: 'Léa', last_name: 'Moreau' })).status, 200);
    assert.equal((await a.call('POST', '/mandate', { full_name: 'Léa Moreau', accepted: true })).status, 200);
  }
  return a;
}
// Webhook Stripe signé (en-tête t=…,v1=…), comme Stripe l'envoie.
async function stripeEvent(type, object) {
  const raw = JSON.stringify({ id: `evt_${crypto.randomBytes(8).toString('hex')}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  return call('POST', '/billing/webhook', raw, { headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
}
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }
  const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout = 5000');
  const uses = (id) => db.prepare('SELECT uses FROM activation_keys WHERE id = ?').get(id).uses;
  const journal = (userId) => db.prepare(`SELECT message FROM events WHERE user_id = ? AND type = 'account' ORDER BY id`).all(userId).map((e) => e.message);
  const admin = await actor('admin@test.fr');
  const plain = new Set();   // toutes les clés en clair reçues dans les réponses de création
  const mkKeys = async (body) => {
    const r = await admin.call('POST', '/admin/keys', body);
    assert.equal(r.status, 201, `création : ${JSON.stringify(r.data)}`);
    r.data.keys.forEach((k) => plain.add(k.key));
    return r.data;
  };
  const forms = (k) => [k, k.slice(6), k.slice(6).replace(/-/g, '')];
  const leaks = (text) => [...plain].filter((k) => forms(k).some((f) => text.includes(f)));
  const unknownKey = () => { for (;;) { let s = ''; for (let i = 0; i < 12; i++) s += ALPHABET[crypto.randomInt(32)]; const k = `OUBLI-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`; if (!plain.has(k)) return k; } };
  const dumpDb = () => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('\n');

  /* ---------- 1. Création réservée aux administrateurs, paramètres validés ---------- */
  const lambda = await actor('lambda@exemple.fr');
  assert.equal((await lambda.call('POST', '/admin/keys', { count: 1, plan: 'individuel', days: 30 })).status, 403);
  assert.equal((await lambda.call('GET', '/admin/keys')).status, 403);
  assert.equal((await lambda.call('POST', '/admin/keys/1/revoke', {})).status, 403);
  assert.equal((await call('POST', '/admin/keys', { count: 1, plan: 'individuel', days: 30 })).status, 401);
  for (const [body, re] of [
    [{ count: 0, plan: 'individuel', days: 30 }, /^Nombre de clés invalide/], [{ count: 101, plan: 'individuel', days: 30 }, /^Nombre de clés invalide/], [{ count: 2.5, plan: 'individuel', days: 30 }, /^Nombre de clés invalide/],
    [{ count: 1, plan: 'gold', days: 30 }, /^Offre inconnue/], [{ count: 1, plan: 'constructor', days: 30 }, /^Offre inconnue/], [{ count: 1, days: 30 }, /^Offre inconnue/],
    [{ count: 1, plan: 'famille', days: 0 }, /^Durée invalide/], [{ count: 1, plan: 'famille', days: 731 }, /^Durée invalide/], [{ count: 1, plan: 'famille' }, /^Durée invalide/],
    [{ count: 1, plan: 'famille', days: 30, max_uses: 0 }, /utilisations invalide/], [{ count: 1, plan: 'famille', days: 30, max_uses: 1001 }, /utilisations invalide/],
    [{ count: 1, plan: 'famille', days: 30, expires_at: '2020-01-01' }, /dans le futur/], [{ count: 1, plan: 'famille', days: 30, expires_at: 'demain' }, /^Date limite invalide/], [{ count: 1, plan: 'famille', days: 30, expires_at: '2031-02-30' }, /^Date limite invalide/],
    [{ count: 1, plan: 'famille', days: 30, note: 'x'.repeat(121) }, /^Note trop longue/], [{ count: 1, plan: 'famille', days: 30, note: 42 }, /^Note invalide/],
  ]) {
    const r = await admin.call('POST', '/admin/keys', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`); assert.match(r.data.error, re);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM activation_keys').get().c, 0, 'aucune clé créée par une requête refusée');
  step('création réservée aux administrateurs (403, 401), nombre, offre, durée, utilisations, date limite et note validés');

  /* ---------- 2. Format et unicité ---------- */
  const big = await mkKeys({ count: 100, plan: 'individuel', days: 30, note: 'Lot de test' });
  assert.match(big.batch, /^[0-9A-F]{8}$/); assert.equal(big.keys.length, 100); assert.equal(big.plan, 'individuel'); assert.equal(big.max_uses, 1);
  for (const k of big.keys) { assert.match(k.key, KEY_RE); assert.equal(k.hint, k.key.slice(-4)); assert.ok(Number.isInteger(k.id)); }
  const second = await mkKeys({ count: 100, plan: 'famille', days: 90 });
  assert.equal(new Set([...big.keys, ...second.keys].map((k) => k.key)).size, 200, 'deux cents clés toutes différentes');
  const drawn = new Set([...big.keys, ...second.keys].map((k) => k.key.slice(6).replace(/-/g, '')).join(''));
  assert.equal(drawn.size, 32, 'les 32 caractères de Crockford sont tirés, aucun I, L, O ni U');
  step('format OUBLI-XXXX-XXXX-XXXX en base32 de Crockford, indice = 4 derniers caractères, 200 clés uniques');

  /* ---------- 3. La clé en clair n'est ni listée, ni journalisée, ni stockée ---------- */
  let r = await admin.call('GET', '/admin/keys?per=100');
  assert.equal(r.status, 200); assert.equal(r.data.keys.length, 100); assert.equal(r.data.total, 200);
  assert.deepEqual(leaks(JSON.stringify(r.data)), [], 'GET /admin/keys sans clé en clair');
  assert.ok(r.data.keys.every((k) => !('key' in k) && !('key_hash' in k) && /^[0-9A-HJKMNP-TV-Z]{4}$/.test(k.hint)), 'ni clé, ni empreinte dans la liste');
  assert.ok(!JSON.stringify(r.data).includes(crypto.createHash('sha256').update(second.keys[0].key).digest('hex')), 'empreinte jamais renvoyée');
  r = await admin.call('GET', '/admin/audit?action=key.create');
  assert.deepEqual(r.data.entries.find((e) => e.target === big.batch).details, { count: 100, plan: 'individuel', days: 30, max_uses: 1, note: 'Lot de test' });
  assert.deepEqual(leaks(JSON.stringify(r.data)), [], 'audit sans clé en clair');
  assert.deepEqual(leaks(dumpDb()), [], 'aucune table ne contient une clé en clair');
  const row = db.prepare('SELECT key_hash, hint FROM activation_keys WHERE id = ?').get(big.keys[0].id);
  assert.equal(row.key_hash, crypto.createHash('sha256').update(big.keys[0].key, 'utf8').digest('hex'), 'seule l’empreinte SHA-256 de la clé normalisée est stockée');
  step('clé en clair absente de GET /api/admin/keys, de l’audit (nombre, offre, jours seulement) et de la base (SHA-256)');

  /* ---------- 4. Activation : abonnement actif, demandes lancées comme après un paiement ---------- */
  const lea = await actor('lea@exemple.fr', { complete: true });
  const K1 = big.keys[0];
  const t0 = Date.now();
  r = await lea.redeem(K1.key);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.plan, 'individuel'); assert.equal(r.data.extended, false); assert.equal(r.data.days, 30); assert.ok(r.data.launched > 0, 'demandes préparées');
  assert.ok(near(r.data.ends_at, t0 + 30 * DAY), 'fin = maintenant + 30 jours');
  assert.equal(r.data.user.subscription_status, 'active'); assert.equal(r.data.user.billing_mode, 'key'); assert.equal(r.data.user.subscription_ends_at, r.data.ends_at);
  const leaEnds1 = r.data.ends_at;
  r = await lea.call('GET', '/me'); assert.equal(r.data.user.billing_mode, 'key'); assert.equal(r.data.user.billing, null);
  let dash;
  for (let i = 0; i < 50; i++) { dash = (await lea.call('GET', '/dashboard')).data; if (dash.counters.sent > 0) break; await wait(100); }
  assert.equal(dash.onboarding.subscription, true); assert.ok(dash.counters.total > 0); assert.ok(dash.counters.sent > 0, 'les courriers partent sans attendre le planificateur');
  assert.ok(journal(lea.id).some((m) => /^Abonnement Individuel activé par clé jusqu’au \d{1,2} \S+ \d{4}\.$/.test(m)), 'journal : activation par clé');
  r = await admin.call('GET', `/admin/keys?q=${K1.hint}`);
  const k1row = r.data.keys.find((k) => k.id === K1.id);
  assert.equal(k1row.status, 'used'); assert.equal(k1row.uses, 1); assert.equal(k1row.redemptions[0].email, 'lea@exemple.fr'); assert.ok(k1row.redemptions[0].redeemed_at);
  r = await admin.call('GET', `/admin/users/${lea.id}`);
  assert.equal(r.data.user.billing_mode, 'key'); assert.equal(r.data.keys[0].hint, K1.hint); assert.equal(r.data.keys[0].ends_at, leaEnds1);
  step('activation : abonnement actif par clé, fin à 30 jours, demandes lancées et envoyées, journal, fiche admin avec l’indice');

  /* ---------- 5. Saisie tolérante ---------- */
  const pool = big.keys.slice(1);
  const take = (pred = () => true) => { const i = pool.findIndex(pred); assert.ok(i >= 0, 'clé disponible'); return pool.splice(i, 1)[0]; };
  let flip = 0;
  const typed = (k) => k.key.slice(6).toLowerCase().replace(/0/g, 'o').replace(/1/g, () => ((flip += 1) % 2 ? 'i' : 'l')).replace(/-/g, ' ');
  const tol = await actor('tolerant@exemple.fr');
  const K2 = take((k) => /[01]/.test(k.key.slice(6)));
  r = await tol.redeem(`  ${typed(K2)}  `);   // minuscules, espaces pour les tirets, sans préfixe, o pour 0, i ou l pour 1
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(uses(K2.id), 1);
  for (const v of [K2.key.toLowerCase(), `oubli ${typed(K2)}`, `OUBLI${K2.key.slice(6).replace(/-/g, '')}`, K2.key.replace(/-/g, '\u2013'), `Oubli-${typed(K2).replace(/ /g, '-')}`]) {
    r = await tol.redeem(v); assert.equal(r.status, 410, `${v} → ${r.status} ${r.data.error}`); assert.match(r.data.error, /déjà activé cette clé/, v);
  }
  step('saisie tolérante : casse, espaces, tirets (même typographiques), préfixe facultatif, O lu 0, I et L lus 1');

  /* ---------- 6. Erreurs : format, inconnue, révoquée, expirée, épuisée, déjà utilisée ---------- */
  const err = await actor('erreurs@exemple.fr');
  r = await err.redeem('OUBLI-1234'); assert.equal(r.status, 400); assert.match(r.data.error, /^Clé invalide/);
  r = await err.call('POST', '/billing/redeem', { key: 12 }); assert.equal(r.status, 400);
  r = await err.redeem(unknownKey()); assert.equal(r.status, 404); assert.match(r.data.error, /^Clé inconnue/);
  const K3 = take();
  assert.equal((await admin.call('POST', `/admin/keys/${K3.id}/revoke`, {})).status, 200);
  r = await err.redeem(K3.key); assert.equal(r.status, 410); assert.match(r.data.error, /révoquée/);
  const EXP = (await mkKeys({ count: 1, plan: 'famille', days: 30, expires_at: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10) })).keys[0];
  db.prepare('UPDATE activation_keys SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), EXP.id);
  r = await err.redeem(EXP.key); assert.equal(r.status, 410); assert.match(r.data.error, /a expiré le \d{1,2} \S+ \d{4}/);
  r = await err.redeem(K1.key); assert.equal(r.status, 410); assert.match(r.data.error, /déjà été utilisée/);
  r = await lea.redeem(K1.key); assert.equal(r.status, 410); assert.match(r.data.error, /déjà activé cette clé sur ce compte/);
  assert.deepEqual([uses(K3.id), uses(EXP.id), uses(K1.id)], [0, 0, 1], 'une erreur ne consomme rien');
  assert.equal((await err.call('GET', '/me')).data.user.subscription_status, 'none', 'aucune erreur ne donne d’abonnement');
  step('erreurs claires : format (400), inconnue (404), révoquée, expirée, épuisée, déjà activée par ce compte (410)');

  /* ---------- 7. Cumul : la durée s'ajoute à la fin en cours, une clé Famille fait passer à Famille ---------- */
  r = await lea.redeem(second.keys[0].key);
  assert.equal(r.status, 200); assert.equal(r.data.extended, true); assert.equal(r.data.plan, 'famille');
  assert.equal(r.data.ends_at, plusDays(leaEnds1, 90), 'fin précédente + 90 jours');
  const leaEnds2 = r.data.ends_at;
  const K10 = (await mkKeys({ count: 1, plan: 'individuel', days: 10 })).keys[0];
  r = await lea.redeem(K10.key);
  assert.equal(r.status, 200); assert.equal(r.data.plan, 'famille', 'une clé Individuel ne retire pas l’offre Famille en cours'); assert.equal(r.data.ends_at, plusDays(leaEnds2, 10));
  r = await lea.call('GET', '/dashboard');
  assert.ok(journal(lea.id).some((m) => /^Abonnement Famille prolongé par clé jusqu’au/.test(m))); assert.equal(r.data.onboarding.max_profiles, 5);
  step('cumul : +90 jours après la fin en cours, passage à Famille, puis +10 jours sans perdre Famille');

  /* ---------- 8. Refus : abonnement payé par carte, paiement en attente, abonnement de l'équipe, dossier trop grand ---------- */
  // Abonnement simulé (sans Stripe, rien n'est payé) : la clé le remplace aussitôt.
  const sim = await actor('simule@exemple.fr');
  assert.equal((await sim.call('POST', '/billing/checkout', { plan: 'individuel' })).status, 200);
  const K4 = take();
  r = await sim.redeem(K4.key); assert.equal(r.status, 200, 'abonnement simulé remplacé par la clé'); assert.ok(near(r.data.ends_at, Date.now() + 30 * DAY));
  assert.equal(r.data.user.billing_mode, 'key');
  // Dossier de deux personnes et clé Individuel : refus expliqué, clé non consommée.
  const fam = await actor('famille-simulee@exemple.fr');
  assert.equal((await fam.call('POST', '/billing/checkout', { plan: 'famille' })).status, 200);
  assert.equal((await fam.call('POST', '/profiles', { first_name: 'Noé', last_name: 'Roux' })).status, 201);
  const K6 = take();
  r = await fam.redeem(K6.key); assert.equal(r.status, 409); assert.match(r.data.error, /protège 2\u00a0personnes/); assert.equal(uses(K6.id), 0, 'un refus ne consomme pas la clé');
  const card = await actor('carte@exemple.fr');
  db.prepare(`UPDATE users SET plan = 'individuel', billing = 'monthly', subscription_status = 'active', billing_mode = 'stripe', stripe_customer_id = 'cus_keys', stripe_subscription_id = 'sub_keys' WHERE id = ?`).run(card.id);
  const K5 = take();
  r = await card.redeem(K5.key); assert.equal(r.status, 409); assert.match(r.data.error, /payé par carte.*résiliez/);
  db.prepare(`UPDATE users SET subscription_status = 'past_due' WHERE id = ?`).run(card.id);
  r = await card.redeem(K5.key); assert.equal(r.status, 409); assert.match(r.data.error, /en attente de régularisation/);
  const team = await actor('equipe@exemple.fr');
  assert.equal((await admin.call('POST', `/admin/users/${team.id}/subscription`, { status: 'active', plan: 'individuel' })).status, 200);
  r = await team.redeem(K5.key); assert.equal(r.status, 409); assert.match(r.data.error, /activé par l’équipe/);
  assert.equal(uses(K5.id), 0, 'un refus ne consomme pas la clé');
  // Carte résiliée, période payée en cours : la clé prend le relais à la fin de la période, sans la raccourcir.
  const paidEnd = new Date(Date.now() + 10 * DAY).toISOString();
  db.prepare(`UPDATE users SET subscription_status = 'canceled', subscription_ends_at = ? WHERE id = ?`).run(paidEnd, card.id);
  r = await card.redeem(K5.key); assert.equal(r.status, 200); assert.equal(r.data.ends_at, plusDays(paidEnd, 30));
  const cardEnds = r.data.ends_at;
  step('refus avec explication : carte, paiement en attente, équipe, dossier trop grand ; simulé remplacé ; après résiliation, la clé suit la période payée');

  /* ---------- 9. Webhooks Stripe tardifs : l'abonnement offert en cours n'est pas écrasé ---------- */
  const ts = Math.floor(Date.now() / 1000);
  for (const [type, object] of [
    ['customer.subscription.deleted', { id: 'sub_keys', customer: 'cus_keys', ended_at: ts }],
    ['customer.subscription.updated', { id: 'sub_keys', customer: 'cus_keys', status: 'active', cancel_at_period_end: true, cancel_at: ts + 3600 }],
    ['customer.subscription.updated', { id: 'sub_keys', customer: 'cus_keys', status: 'past_due' }],
    ['invoice.payment_failed', { customer: 'cus_keys', subscription: 'sub_keys' }],
  ]) {
    r = await stripeEvent(type, object); assert.equal(r.status, 200, `${type} : ${JSON.stringify(r.data)}`);
    const u = (await card.call('GET', '/me')).data.user;
    assert.deepEqual([u.subscription_status, u.billing_mode, u.subscription_ends_at], ['active', 'key', cardEnds], type);
  }
  // Un paiement confirmé remplace l'abonnement offert : l'abonné a choisi de payer.
  r = await stripeEvent('checkout.session.completed', { mode: 'subscription', payment_status: 'paid', customer: 'cus_keys', subscription: 'sub_new', client_reference_id: card.id, metadata: { user_id: card.id, plan: 'famille', billing: 'monthly' } });
  assert.equal(r.status, 200);
  let u = (await card.call('GET', '/me')).data.user;
  assert.deepEqual([u.subscription_status, u.billing_mode, u.subscription_ends_at, u.plan], ['active', 'stripe', null, 'famille']);
  step('webhooks Stripe : résiliation, impayé et mises à jour tardives ignorés pendant un abonnement offert ; un paiement le remplace');

  /* ---------- 10. « Résilier » ne s'applique pas à un abonnement offert ---------- */
  r = await lea.call('POST', '/billing/cancel', {});
  assert.equal(r.status, 409); assert.match(r.data.error, /rien à résilier.*révoquez le mandat/);
  u = (await lea.call('GET', '/me')).data.user; assert.equal(u.subscription_status, 'active'); assert.equal(u.billing_mode, 'key');
  step('résiliation refusée (409) avec explication : l’abonnement offert s’arrête de lui-même');

  /* ---------- 11. Concurrence : cinq activations simultanées d'une clé à usage unique, une seule réussit ---------- */
  const KC = (await mkKeys({ count: 1, plan: 'individuel', days: 30, max_uses: 1 })).keys[0];
  const racers = await Promise.all([1, 2, 3, 4, 5].map((i) => actor(`course${i}@exemple.fr`)));
  const results = await Promise.all(racers.map((a) => a.redeem(KC.key)));
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 410, 410, 410, 410], JSON.stringify(results.map((x) => [x.status, x.data.error])));
  results.filter((x) => x.status === 410).forEach((x) => assert.match(x.data.error, /déjà été utilisée/));
  assert.equal(uses(KC.id), 1); assert.equal(db.prepare('SELECT COUNT(*) AS c FROM key_redemptions WHERE key_id = ?').get(KC.id).c, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM users WHERE email LIKE 'course%' AND subscription_status = 'active'`).get().c, 1);
  const KM = (await mkKeys({ count: 1, plan: 'individuel', days: 30, max_uses: 10 })).keys[0];
  const solo = await actor('solo@exemple.fr');
  const same = await Promise.all([1, 2, 3, 4, 5].map(() => solo.redeem(KM.key)));
  assert.deepEqual(same.map((x) => x.status).sort(), [200, 410, 410, 410, 410], 'le même compte, cinq fois à la fois');
  assert.equal(uses(KM.id), 1);
  assert.throws(() => db.prepare('UPDATE activation_keys SET uses = max_uses + 1 WHERE id = ?').run(KC.id), /CHECK constraint failed/, 'la base refuse tout dépassement');
  step('concurrence : 5 activations simultanées → 1 seule réussit (uses = 1) ; même compte ×5 → 1 ; CHECK en base');

  /* ---------- 12. Expiration : plus éligible dès la date de fin, puis le balayage passe le compte en « canceled » ---------- */
  const fin = await actor('fin@exemple.fr', { complete: true });
  r = await fin.redeem(take().key); assert.equal(r.status, 200);
  let finDash;
  for (let i = 0; i < 50; i++) { finDash = (await fin.call('GET', '/dashboard')).data; if (finDash.counters.sent > 0) break; await wait(100); }
  const past = new Date(Date.now() - 60000).toISOString();
  db.prepare('UPDATE users SET subscription_ends_at = ? WHERE id = ?').run(past, fin.id);
  assert.equal((await fin.call('GET', '/me')).data.user.subscription_status, 'active', 'pas encore balayé');
  assert.equal((await fin.call('GET', '/dashboard')).data.onboarding.subscription, false, 'le tableau de bord applique déjà la date de fin');
  assert.equal((await fin.call('POST', '/requests/launch', {})).status, 400, 'plus éligible');
  r = await fin.call('POST', '/sites', { url: 'https://annuaire-exemple.fr/fiche/lea-moreau' }); assert.equal(r.status, 400); assert.match(r.data.error, /abonnement actif/);
  const rq = finDash.requests.find((x) => x.status === 'sent');
  assert.equal((await admin.call('POST', `/admin/requests/${rq.id}/resend`, {})).status, 200);
  assert.equal((await admin.call('POST', '/admin/tick', {})).status, 200);
  u = (await fin.call('GET', '/me')).data.user;
  assert.deepEqual([u.subscription_status, u.billing_mode, u.subscription_ends_at], ['canceled', 'key', past], 'balayé, la date de fin reste affichée');
  assert.equal((await admin.call('GET', `/admin/requests/${rq.id}`)).data.request.status, 'queued', 'rien ne part après la fin');
  assert.ok(journal(fin.id).some((m) => /^Abonnement offert par clé arrivé à échéance le \d{1,2} \S+ \d{4}\u00a0: plus aucune demande ne part\./.test(m)), 'journal : fin de l’abonnement offert');
  r = await fin.redeem(take().key);
  assert.equal(r.status, 200); assert.equal(r.data.extended, false); assert.ok(near(r.data.ends_at, Date.now() + 30 * DAY), 'une nouvelle clé repart de maintenant');
  let back;
  for (let i = 0; i < 50; i++) { back = (await admin.call('GET', `/admin/requests/${rq.id}`)).data.request.status; if (back === 'sent') break; await wait(100); }
  assert.equal(back, 'sent', 'la demande en file repart avec la nouvelle clé');
  step('expiration : inéligible dès la date de fin (envois, lancement, sites), balayage → canceled, nouvelle clé → reprise');

  /* ---------- 13. Limitation de débit : 10 essais par heure et par compte, 10 par adresse IP ---------- */
  const brute = await actor('brute@exemple.fr');
  for (let i = 0; i < 10; i++) { r = await brute.redeem(unknownKey(), { ip: newIp() }); assert.equal(r.status, 404, `essai ${i + 1}`); }
  r = await brute.redeem(unknownKey(), { ip: newIp() });
  assert.equal(r.status, 429, 'onze essais du même compte, depuis onze adresses'); assert.match(r.data.error, /^Trop de tentatives\. Réessayez dans \d+ minutes\.$/); assert.ok(Number(r.headers.get('retry-after')) > 0);
  const shared = newIp();
  const crowd = await Promise.all(Array.from({ length: 11 }, (_, i) => actor(`foule${i}@exemple.fr`)));
  for (let i = 0; i < 10; i++) { r = await crowd[i].redeem(unknownKey(), { ip: shared }); assert.equal(r.status, 404); }
  r = await crowd[10].redeem(unknownKey(), { ip: shared }); assert.equal(r.status, 429, 'onze comptes depuis la même adresse');
  assert.equal((await crowd[10].redeem(unknownKey())).status, 404, 'le même compte, depuis son adresse, reste libre');
  assert.equal((await call('POST', '/billing/redeem', { key: unknownKey() })).status, 401, 'connexion requise');
  step('limitation de débit : 429 en français + Retry-After au 11ᵉ essai par compte et par adresse IP ; connexion requise');

  /* ---------- 14. Accès support : lecture seule, l'activation est refusée ---------- */
  const helped = await actor('aide@exemple.fr');
  const KS = take();
  r = await admin.call('POST', `/admin/users/${helped.id}/impersonate`, { reason: 'ticket clé' }); assert.equal(r.status, 200);
  const S = { cookie: r.cookie, ip: admin.ip };
  r = await call('POST', '/billing/redeem', { key: KS.key }, S); assert.equal(r.status, 403); assert.match(r.data.error, /lecture seule/);
  assert.equal(uses(KS.id), 0); assert.equal((await helped.call('GET', '/me')).data.user.subscription_status, 'none');
  assert.equal((await call('POST', '/auth/impersonate/stop', {}, S)).status, 200);
  step('accès support en lecture seule : POST /billing/redeem refusé (403), clé intacte');

  /* ---------- 15. Administration : filtres, compteurs, pagination, révocation, audit, revenu, fiche, export ---------- */
  r = await admin.call('GET', '/admin/keys');
  const counts = r.data.counts;
  assert.equal(counts.all, counts.active + counts.used + counts.expired + counts.revoked);
  assert.ok(counts.active > 0 && counts.used > 0 && counts.expired === 1 && counts.revoked === 1, JSON.stringify(counts));
  for (const st of ['active', 'used', 'expired', 'revoked']) {
    const x = await admin.call('GET', `/admin/keys?status=${st}&per=100`);
    assert.equal(x.data.total, counts[st], st); assert.ok(x.data.keys.every((k) => k.status === st), st);
  }
  assert.equal((await admin.call('GET', '/admin/keys?status=constructor')).data.total, counts.all, 'statut inconnu ignoré');
  r = await admin.call('GET', '/admin/keys?per=5&page=2'); assert.equal(r.data.keys.length, 5); assert.equal(r.data.page, 2); assert.equal(r.data.pages, Math.ceil(counts.all / 5));
  r = await admin.call('GET', '/admin/keys?q=lea%40exemple.fr'); assert.equal(r.data.total, 3); assert.ok(r.data.keys.every((k) => k.redemptions.some((x) => x.email === 'lea@exemple.fr')));
  assert.equal((await admin.call('GET', `/admin/keys?batch=${second.batch}&per=100`)).data.total, 100);
  const KR = take();
  r = await admin.call('POST', `/admin/keys/${KR.id}/revoke`, {});
  assert.equal(r.status, 200); assert.equal(r.data.key.status, 'revoked'); assert.deepEqual(leaks(JSON.stringify(r.data)), []);
  assert.equal((await admin.call('POST', `/admin/keys/${KR.id}/revoke`, {})).status, 409);
  assert.equal((await admin.call('POST', '/admin/keys/999999/revoke', {})).status, 404);
  assert.equal((await admin.call('POST', '/admin/keys/abc/revoke', {})).status, 404);
  r = await admin.call('GET', '/admin/audit?action=key.revoke');
  assert.ok(r.data.entries.some((e) => e.target === String(KR.id) && e.details.hint === KR.hint && e.details.batch === big.batch));
  const stats = (await admin.call('GET', '/admin/stats')).data;
  assert.equal(stats.keys.active, counts.active - 1);
  assert.equal(stats.keys.subscriptions, db.prepare(`SELECT COUNT(*) AS c FROM users WHERE billing_mode = 'key' AND subscription_status = 'active' AND subscription_ends_at > ?`).get(new Date().toISOString()).c);
  const paying = db.prepare(`SELECT plan FROM users WHERE deleted_at IS NULL AND subscription_status = 'active' AND billing_mode IS NOT 'key'`).all();
  assert.equal(stats.mrr_cents, paying.reduce((a, x) => a + ({ individuel: 500, famille: 999 }[x.plan] || 0), 0), 'abonnements offerts hors revenu');
  for (const k of ['users', 'active', 'requests', 'mails', 'action_required']) assert.ok(k in stats, `contrat /admin/stats : ${k}`);
  const leaNow = (await lea.call('GET', '/me')).data.user;
  r = await admin.call('POST', `/admin/users/${lea.id}/subscription`, { status: 'active', plan: 'famille', ends_at: leaNow.subscription_ends_at.slice(0, 10) });
  assert.equal(r.status, 200); assert.equal(r.data.user.billing_mode, 'key', 'enregistrer la fiche garde l’abonnement par clé'); assert.equal(r.data.user.subscription_ends_at, leaNow.subscription_ends_at, 'même jour : heure conservée');
  assert.equal((await admin.call('POST', `/admin/users/${lea.id}/subscription`, { status: 'active', plan: 'famille', ends_at: '2020-01-01' })).status, 400);
  r = await lea.call('GET', '/export');
  assert.equal(r.data.key_redemptions.length, 3); assert.ok(r.data.key_redemptions.every((x) => /^[0-9A-HJKMNP-TV-Z]{4}$/.test(x.hint) && !('key_hash' in x)));
  r = await admin.call('POST', `/admin/users/${lea.id}/subscription`, { status: 'active', plan: 'famille', ends_at: '' });
  assert.deepEqual([r.data.user.billing_mode, r.data.user.subscription_ends_at], ['manual', null], 'sans date : abonnement sans limite de l’équipe');
  // Compte supprimé : l'activation reste comptée, sans l'adresse (anonymisée) du compte.
  const winner = racers[results.findIndex((x) => x.status === 200)];
  assert.equal((await winner.call('DELETE', '/account', { password: STRONG })).status, 200);
  r = await admin.call('GET', `/admin/keys?q=${KC.hint}`);
  const kcRow = r.data.keys.find((k) => k.id === KC.id);
  assert.equal(kcRow.uses, 1); assert.deepEqual([kcRow.redemptions[0].deleted, kcRow.redemptions[0].email], [true, null]);
  step('administration : filtres et compteurs, pagination, recherche, lot, révocation (409, 404), audit, revenu hors clés, fiche, export, compte supprimé');

  /* ---------- 15 bis. Ligne de commande (npm run admin) : clés et rôle administrateur sans passer par le panel ---------- */
  const cli = (...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin-cli.mjs', ...args], { env: { ...env, APP_URL: 'https://oubli.example' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
  const keysBefore = db.prepare('SELECT COUNT(*) AS c FROM activation_keys').get().c;
  let c = await cli('keys', '--plan', 'famille', '--days', '7', '--count', '2', '--note', 'Ligne de commande');
  assert.equal(c.code, 0, c.out);
  const cliKeys = [...new Set([...c.out.matchAll(/OUBLI-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/g)].map((m) => m[0]))];
  assert.equal(cliKeys.length, 2); assert.match(c.out, /https:\/\/oubli\.example\/app\/#signup\?key=OUBLI-/, 'lien de partage affiché');
  cliKeys.forEach((k) => plain.add(k));
  const cliUser = await actor('ligne-de-commande@exemple.fr', { complete: true });
  r = await cliUser.redeem(cliKeys[0]); assert.equal(r.status, 200); assert.equal(r.data.plan, 'famille');
  assert.equal((await cli('keys', '--count', '2', '--plann', 'famille')).code, 1, 'option inconnue');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM activation_keys').get().c, keysBefore + 2, 'une option inconnue ne crée aucune clé');
  assert.equal((await cliUser.call('GET', '/admin/stats')).status, 403);
  c = await cli('promote', 'ligne-de-commande@exemple.fr'); assert.equal(c.code, 0, c.out);
  assert.equal((await cliUser.call('GET', '/admin/stats')).status, 200, 'administrateur après « promote »');
  assert.equal((await cli('promote', 'personne@exemple.fr')).code, 1, 'compte inexistant');
  step('ligne de commande : clés affichées une fois avec leur lien, option inconnue refusée, rôle administrateur accordé');

  /* ---------- 16. Ni la console du serveur, ni les courriers, ni la base ne contiennent de clé ---------- */
  const mails = fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).map((f) => fs.readFileSync(path.join(OUTBOX, f), 'utf8')).join('\n') : '';
  assert.ok(mails.length > 0, 'des courriers ont bien été écrits');
  assert.deepEqual(leaks(serverOut + serverErr), [], 'console du serveur sans clé');
  assert.deepEqual(leaks(mails), [], 'courriers sans clé');
  assert.deepEqual(leaks(dumpDb()), [], 'base sans clé après toutes les activations');
  db.close();
  step(`aucune des ${plain.size} clés créées n’apparaît dans la console du serveur, les courriers ou la base`);

  console.log(`✔ Clés d’activation validées (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr.trim()) console.error(serverErr.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000).unref(); });   // attendre l'arrêt : le serveur peut encore écrire dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
