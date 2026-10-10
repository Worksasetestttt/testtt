// Test de la facturation Stripe contre un faux serveur Stripe (node:http) : chaque appel à l'API est enregistré (méthode,
// chemin, paramètres form-urlencoded, en-têtes) et reçoit une réponse réaliste. Le serveur Oubli tourne sur un port libre,
// avec une base temporaire, STRIPE_API_BASE pointé vers le faux Stripe et des webhooks signés comme Stripe les envoie.
// Groupes : session de paiement et résiliation en fin de période ; garde https en production ; réabonnement pendant la
// période payée (reprise sans paiement, changement d'offre au prorata, jamais de second abonnement) et état réel chez
// Stripe ; application à 1280 et 390 px ; webhooks livrés en retard ; suppression du compte (annulation immédiate,
// factures ouvertes annulées) ; aucun identifiant Stripe dans les réponses ; signatures ; abonnement d'un compte supprimé.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { freePort } from './free-port.mjs';

// Navigateur pour les vérifications de l'application (facultatif : ignorées si Playwright n'est pas installé).
const playwright = (() => { try { return createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright'); } catch { return null; } })();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-billing-'));
const SK = 'sk_test_billing_suite_0123456789abcdef';
const WHSEC = 'whsec_billing_suite_0123456789abcdef';
const STRONG = 'Corde-a-linge-78!';
const PRICE = { individuel: 500, famille: 999 };
const DAY = 86400;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString();

/* ---------- Faux serveur Stripe ---------- */
// Sous-ensemble de l'API REST utilisé par server/billing.js. Les objets vivent en mémoire : le test les crée ou les modifie
// directement (ce que ferait Stripe après un paiement), puis envoie les webhooks correspondants. fail() fait échouer le
// prochain appel qui correspond (méthode et chemin exact ou expression régulière).
function fakeStripe() {
  const calls = [], subs = new Map(), invoices = new Map(), prices = new Map(), failures = [], issued = new Set();
  let seq = 0;
  const nextId = (prefix) => { const id = `${prefix}_F${String(++seq).padStart(4, '0')}${crypto.randomBytes(5).toString('hex')}`; if (prefix !== 'cs_test') issued.add(id); return id; };
  const ok = (body) => ({ status: 200, body });
  const error = (status, message, code) => ({ status, body: { error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', ...(code ? { code } : {}), message } } });
  const list = (data, limit) => ({ object: 'list', data: data.slice(0, limit), has_more: data.length > limit, url: '' });
  const metadata = (form) => Object.fromEntries(Object.entries(form).filter(([k]) => /^metadata\[[^\]]+\]$/.test(k)).map(([k, v]) => [k.slice(9, -1), v]));
  function addSubscription({ userId, plan = 'individuel', amount = PRICE[plan], interval = 'month', status = 'active', periodDays = 30, customer = nextId('cus') }) {
    const start = nowS() - DAY, end = start + periodDays * DAY;
    const price = { id: nextId('price'), object: 'price', active: true, currency: 'eur', unit_amount: amount, recurring: { interval }, product: nextId('prod'), lookup_key: null };
    const sub = {
      id: nextId('sub'), object: 'subscription', customer, status, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
      current_period_start: start, current_period_end: end,
      items: { object: 'list', data: [{ id: nextId('si'), object: 'subscription_item', quantity: 1, price, current_period_start: start, current_period_end: end }] },
      metadata: { user_id: userId, plan, billing: interval === 'year' ? 'annual' : 'monthly' },
    };
    subs.set(sub.id, sub);
    return sub;
  }
  function addInvoice(sub, { status = 'open', amount = sub.items.data[0].price.unit_amount } = {}) {
    const inv = { id: nextId('in'), object: 'invoice', customer: sub.customer, subscription: sub.id, status, amount_due: amount, currency: 'eur' };
    invoices.set(inv.id, inv);
    return inv;
  }
  function handle(method, p, form, query) {
    let m;
    if (method === 'POST' && p === '/v1/checkout/sessions') {
      const id = nextId('cs_test');
      return ok({ id, object: 'checkout.session', mode: form.mode, status: 'open', url: `https://checkout.stripe.com/c/pay/${id}`, client_reference_id: form.client_reference_id || null, customer: form.customer || null, customer_email: form.customer_email || null, metadata: metadata(form) });
    }
    if ((m = /^\/v1\/subscriptions\/([^/]+)$/.exec(p))) {
      const sub = subs.get(decodeURIComponent(m[1]));
      if (!sub) return error(404, `No such subscription: '${decodeURIComponent(m[1])}'`, 'resource_missing');
      if (method === 'GET') return ok(sub);
      if (method === 'DELETE') {
        if (sub.status === 'canceled') return error(400, 'This subscription has already been canceled.');
        Object.assign(sub, { status: 'canceled', canceled_at: nowS(), ended_at: nowS(), cancel_at_period_end: false, cancel_at: null });
        return ok(sub);
      }
      if (method === 'POST') {
        if (sub.status === 'canceled') return error(400, 'A canceled subscription can only update its cancellation_details and metadata.');
        if ('cancel_at_period_end' in form) { sub.cancel_at_period_end = form.cancel_at_period_end === 'true'; sub.cancel_at = sub.cancel_at_period_end ? sub.current_period_end : null; }
        if (form['items[0][id]'] !== undefined) {
          const item = sub.items.data.find((i) => i.id === form['items[0][id]']);
          if (!item) return error(400, `Invalid subscription item: '${form['items[0][id]']}'`);
          const price = prices.get(form['items[0][price]']);
          if (!price) return error(400, `No such price: '${form['items[0][price]']}'`, 'resource_missing');
          item.price = price;
          sub.proration_behavior = form.proration_behavior || null;
        }
        Object.assign(sub.metadata, metadata(form));
        return ok(sub);
      }
    }
    if (method === 'GET' && p === '/v1/invoices') {
      const data = [...invoices.values()].filter((i) => (!query.subscription || i.subscription === query.subscription) && (!query.status || i.status === query.status));
      return ok(list(data, Number(query.limit) || 10));
    }
    if (method === 'POST' && (m = /^\/v1\/invoices\/([^/]+)\/void$/.exec(p))) {
      const inv = invoices.get(decodeURIComponent(m[1]));
      if (!inv) return error(404, `No such invoice: '${decodeURIComponent(m[1])}'`, 'resource_missing');
      if (inv.status !== 'open') return error(400, 'You can only void open invoices.');
      inv.status = 'void';
      return ok(inv);
    }
    if (p === '/v1/prices' && method === 'GET') {
      const keys = Object.entries(query).filter(([k]) => /^lookup_keys\[\d*\]$/.test(k)).map(([, v]) => v);
      const data = [...prices.values()].filter((x) => (!keys.length || keys.includes(x.lookup_key)) && (query.active !== 'true' || x.active));
      return ok(list(data, Number(query.limit) || 10));
    }
    if (p === '/v1/prices' && method === 'POST') {
      const lookup = form.lookup_key || null;
      const holder = lookup ? [...prices.values()].find((x) => x.lookup_key === lookup) : null;
      if (holder && form.transfer_lookup_key !== 'true') return error(400, `A price (${holder.id}) already uses the lookup key '${lookup}'.`);
      if (holder) holder.lookup_key = null;
      const price = { id: nextId('price'), object: 'price', active: true, currency: form.currency, unit_amount: Number(form.unit_amount), recurring: { interval: form['recurring[interval]'] }, product: nextId('prod'), product_name: form['product_data[name]'] ?? null, lookup_key: lookup, metadata: metadata(form) };
      prices.set(price.id, price);
      return ok(price);
    }
    return error(404, `Unrecognized request URL (${method}: ${p}).`);
  }
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://stripe.test');
      const form = Object.fromEntries(new URLSearchParams(raw)), query = Object.fromEntries(u.searchParams);
      const i = failures.findIndex((f) => f.method === req.method && (typeof f.path === 'string' ? f.path === u.pathname : f.path.test(u.pathname)));
      const out = i >= 0 ? (({ status, message }) => error(status, message))(failures.splice(i, 1)[0]) : handle(req.method, u.pathname, form, query);
      calls.push({ method: req.method, path: u.pathname, form, query, raw, auth: req.headers.authorization || '', idem: req.headers['idempotency-key'] || null, type: req.headers['content-type'] || null, status: out.status, response: out.body });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return {
    server, calls, subs, invoices, prices, issued, addSubscription, addInvoice,
    fail: (method, p, status = 500, message = 'Erreur simulée du faux Stripe') => failures.push({ method, path: p, status, message }),
    mark: () => calls.length,
    since: (mark) => calls.slice(mark),
  };
}

/* ---------- Serveur Oubli ---------- */
const fake = fakeStripe();
const FAKE_PORT = await freePort();
await new Promise((r) => fake.server.listen(FAKE_PORT, '127.0.0.1', r));
const PORT = await freePort();
const DB = path.join(tmp, 'test.sqlite');
const APP = `http://localhost:${PORT}`;
const env = {
  ...process.env, PORT: String(PORT), DATABASE_PATH: DB, OUTBOX_DIR: path.join(tmp, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '',
  STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: `http://127.0.0.1:${FAKE_PORT}/v1`, APP_URL: APP,
  SESSION_SECRET: 'test-secret-for-billing-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test',
  SITE_DISCOVERY: 'off', TRUST_PROXY: '1', INBOUND_TOKEN: '',
};
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '', serverErr = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverErr += d; });
const base = `${APP}/api`;
const responses = [];   // corps de toutes les réponses reçues par le test (recherche de fuites d'identifiants Stripe)

let ipSeq = 0;
const newIp = () => { ipSeq += 1; return `10.20.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };
async function call(method, p, body, { cookie = '', ip = '10.20.255.1', headers = {}, raw } = {}) {
  const h = { 'x-forwarded-for': ip, ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined && raw === undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
  responses.push({ p, text });
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, data, text, headers: r.headers, cookie: sc ? sc.split(';')[0] : '' };
}
// Un acteur : un compte, sa session et sa propre adresse IP (limites de débit par client) ; « complete » renseigne le
// profil et signe le mandat.
async function actor(email, { complete = false } = {}) {
  const ip = newIp();
  const r = await call('POST', '/auth/signup', { email, password: STRONG }, { ip });
  assert.equal(r.status, 201, `inscription ${email} : ${JSON.stringify(r.data)}`);
  const a = { email, ip, cookie: r.cookie, id: r.data.user.id };
  a.call = (method, p, body, opts = {}) => call(method, p, body, { cookie: a.cookie, ip: a.ip, ...opts });
  a.me = async () => (await a.call('GET', '/me')).data.user;
  if (complete) {
    const me = await a.call('GET', '/me');
    assert.equal((await a.call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: 'Léa', last_name: 'Moreau' })).status, 200);
    assert.equal((await a.call('POST', '/mandate', { full_name: 'Léa Moreau', accepted: true })).status, 200);
  }
  return a;
}
// Webhook Stripe signé (en-tête t=…,v1=…), avec sa date de création comme Stripe l'envoie.
const signed = (raw, t = nowS(), secret = WHSEC) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
async function stripeEvent(type, object, { created = nowS(), id = `evt_${crypto.randomBytes(8).toString('hex')}` } = {}) {
  const raw = JSON.stringify({ id, object: 'event', type, created, data: { object } });
  const r = await call('POST', '/billing/webhook', undefined, { raw, headers: { 'content-type': 'application/json', 'stripe-signature': signed(raw) } });
  assert.equal(r.status, 200, `webhook ${type} : ${r.text}`);
  return r;
}
// Paiement d'un abonnement : l'abonnement existe chez Stripe, puis le webhook checkout.session.completed l'annonce.
async function paid(a, plan = 'individuel', opts = {}) {
  const sub = fake.addSubscription({ userId: a.id, plan, ...opts });
  await stripeEvent('checkout.session.completed', { object: 'checkout.session', mode: 'subscription', payment_status: 'paid', customer: sub.customer, subscription: sub.id, client_reference_id: a.id, metadata: { user_id: a.id, plan, billing: opts.interval === 'year' ? 'annual' : 'monthly' } }, { created: opts.created });
  return sub;
}
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }
  const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout = 5000');
  const row = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  /* ---------- 1. STRIPE_API_BASE : session de paiement, résiliation en fin de période, erreurs ---------- */
  {
    assert.equal((await call('GET', '/config')).data.billing, 'stripe');
    const A = await actor('session@exemple.fr');
    let m = fake.mark();
    let r = await A.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 200, r.text);
    const [cs] = fake.since(m);
    assert.equal(fake.since(m).length, 1, 'un seul appel à Stripe');
    assert.equal(cs.method, 'POST'); assert.equal(cs.path, '/v1/checkout/sessions');
    assert.equal(cs.auth, `Bearer ${SK}`); assert.match(cs.idem, /^[0-9a-f-]{36}$/, 'clé d’idempotence'); assert.match(cs.type, /^application\/x-www-form-urlencoded/);
    assert.deepEqual(r.data, { mode: 'stripe', url: cs.response.url }, 'adresse de la session renvoyée telle quelle');
    for (const [k, v] of Object.entries({
      mode: 'subscription', client_reference_id: A.id, customer_email: A.email, locale: 'fr', success_url: `${APP}/app/#billing-success`, cancel_url: `${APP}/app/#billing`,
      'metadata[user_id]': A.id, 'metadata[plan]': 'individuel', 'metadata[billing]': 'monthly', 'subscription_data[metadata][user_id]': A.id, 'subscription_data[metadata][plan]': 'individuel',
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur', 'line_items[0][price_data][unit_amount]': '500', 'line_items[0][price_data][recurring][interval]': 'month', 'line_items[0][price_data][product_data][name]': 'Oubli Individuel',
    })) assert.equal(cs.form[k], v, k);
    // Paiement confirmé par webhook : identifiants rattachés au compte, jamais renvoyés.
    const sub = await paid(A, 'individuel');
    let u = await A.me();
    assert.deepEqual([u.subscription_status, u.billing_mode, u.plan, u.subscription_ends_at], ['active', 'stripe', 'individuel', null]);
    assert.deepEqual([row(A.id).stripe_customer_id, row(A.id).stripe_subscription_id], [sub.customer, sub.id]);
    // Abonnement actif : pas de seconde session.
    m = fake.mark();
    r = await A.call('POST', '/billing/checkout', { plan: 'famille' });
    assert.equal(r.status, 409); assert.match(r.data.error, /déjà actif/); assert.equal(fake.since(m).length, 0, 'aucun appel à Stripe');
    // « Résilier » : fin de période chez Stripe, accès maintenu jusqu'à cette date.
    m = fake.mark();
    r = await A.call('POST', '/billing/cancel', {});
    assert.equal(r.status, 200, r.text);
    const calls = fake.since(m);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /v1/subscriptions/${sub.id}`]);
    assert.deepEqual(calls[0].form, { cancel_at_period_end: 'true' });
    u = await A.me();
    assert.deepEqual([u.subscription_status, u.subscription_ends_at], ['canceled', iso(sub.current_period_end)]);
    assert.equal(r.data.ends_at, iso(sub.current_period_end));
    // Stripe en erreur : 502 générique, rien n'est modifié, le message de Stripe ne sort pas.
    const B = await actor('erreur-stripe@exemple.fr');
    fake.fail('POST', '/v1/checkout/sessions', 500);
    r = await B.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 502); assert.match(r.data.error, /n’a pas pu être initialisé/); assert.ok(!r.text.includes('faux Stripe'));
    const sub2 = await paid(B, 'individuel');
    fake.fail('POST', `/v1/subscriptions/${sub2.id}`, 500);
    r = await B.call('POST', '/billing/cancel', {});
    assert.equal(r.status, 502); assert.equal((await B.me()).subscription_status, 'active', 'résiliation non confirmée : rien ne change');
  }
  step('STRIPE_API_BASE : session de paiement (clé, idempotence, paramètres), abonnement déjà actif (409), résiliation en fin de période, erreurs de Stripe (502)');

  /* ---------- 2. En production, STRIPE_API_BASE doit être en https ---------- */
  {
    const prodDir = path.join(tmp, 'prod'); fs.mkdirSync(prodDir);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
      env: { ...env, NODE_ENV: 'production', PORT: String(await freePort()), DATABASE_PATH: path.join(prodDir, 'prod.sqlite'), OUTBOX_DIR: path.join(prodDir, 'outbox'), SESSION_SECRET: 'x'.repeat(40), STRIPE_API_BASE: `http://127.0.0.1:${FAKE_PORT}/v1` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill(); child.once('exit', () => r('toujours en marche après 10 s')); }, 10000).unref(); });
    assert.equal(code, 1, `sortie ${code} : ${err}`); assert.match(err, /STRIPE_API_BASE doit commencer par https:\/\//);
    assert.ok(!err.includes(SK), 'la clé secrète n’est pas affichée');
  }
  step('production : STRIPE_API_BASE en http refusé au démarrage (sortie 1), sans afficher la clé');

  /* ---------- 3. Réabonnement pendant la période payée : l'abonnement existant est repris, jamais doublé ---------- */
  // Un abonné qui résilie (fin de période) puis choisit à nouveau une offre avant cette date payait deux fois la même
  // période : une seconde session de paiement créait un second abonnement.
  const sig = (calls) => calls.map((c) => `${c.method} ${c.path}`);
  const journal = (id) => db.prepare(`SELECT message FROM events WHERE user_id = ? AND type = 'billing' ORDER BY id`).all(id).map((e) => e.message);
  const cancelNow = async (a, sub) => {
    assert.equal((await a.call('POST', '/billing/cancel', {})).status, 200);
    assert.equal(fake.subs.get(sub.id).cancel_at_period_end, true);
    await stripeEvent('customer.subscription.updated', structuredClone(fake.subs.get(sub.id)));   // annonce de Stripe
    assert.equal((await a.me()).subscription_status, 'canceled');
  };
  {
    const R = await actor('reprise@exemple.fr', { complete: true });
    const sub = await paid(R, 'individuel');
    await cancelNow(R, sub);
    // Même offre : la résiliation est annulée chez Stripe, sans nouveau paiement.
    let m = fake.mark();
    let r = await R.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${sub.id}`, `POST /v1/subscriptions/${sub.id}`], 'aucune session de paiement');
    assert.deepEqual(fake.since(m)[1].form, { cancel_at_period_end: 'false' });
    assert.equal(r.data.mode, 'resumed'); assert.equal(r.data.switched, false); assert.equal(r.data.plan, 'individuel'); assert.ok(!('url' in r.data));
    assert.match(r.data.message, /^Résiliation annulée : votre abonnement Individuel continue, sans nouveau paiement\. Prochain prélèvement le \d{1,2} \S+ \d{4}\.$/);
    let u = await R.me();
    assert.deepEqual([u.subscription_status, u.subscription_ends_at, u.plan, u.billing_mode], ['active', null, 'individuel', 'stripe']);
    assert.equal(row(R.id).stripe_subscription_id, sub.id, 'même abonnement');
    assert.equal(fake.subs.get(sub.id).cancel_at_period_end, false);
    assert.match(journal(R.id).at(-1), /^Résiliation annulée/);
    await stripeEvent('customer.subscription.updated', structuredClone(fake.subs.get(sub.id)));
    assert.equal((await R.me()).subscription_status, 'active', 'l’annonce de Stripe confirme');

    // Autre offre : l'abonnement change d'offre au prorata (prix de l'offre retrouvé ou créé chez Stripe).
    await cancelNow(R, sub);
    m = fake.mark();
    r = await R.call('POST', '/billing/checkout', { plan: 'famille' });
    assert.equal(r.status, 200, r.text);
    let calls = fake.since(m);
    assert.deepEqual(sig(calls), [`GET /v1/subscriptions/${sub.id}`, 'GET /v1/prices', 'POST /v1/prices', `POST /v1/subscriptions/${sub.id}`]);
    const lookup = calls[1].query['lookup_keys[0]'];
    assert.match(lookup, /^oubli_famille_999_eur_month$/); assert.equal(calls[1].query.active, 'true'); assert.equal(calls[1].raw, '', 'GET sans corps');
    assert.deepEqual({ currency: calls[2].form.currency, amount: calls[2].form.unit_amount, interval: calls[2].form['recurring[interval]'], lookup: calls[2].form.lookup_key, name: calls[2].form['product_data[name]'] }, { currency: 'eur', amount: '999', interval: 'month', lookup, name: 'Oubli Famille' });
    assert.ok(calls[2].idem, 'création du prix idempotente');
    const famillePrice = calls[2].response.id;
    assert.deepEqual(calls[3].form, { cancel_at_period_end: 'false', proration_behavior: 'create_prorations', 'items[0][id]': sub.items.data[0].id, 'items[0][price]': famillePrice, 'metadata[user_id]': R.id, 'metadata[plan]': 'famille', 'metadata[billing]': 'monthly' });
    assert.deepEqual([r.data.mode, r.data.switched, r.data.plan], ['resumed', true, 'famille']);
    assert.match(r.data.message, /^Résiliation annulée, offre Famille active dès maintenant : la différence au prorata \(supplément ou avoir\) figurera sur votre prochaine facture, le \d{1,2} \S+ \d{4}\.$/);
    u = await R.me();
    assert.deepEqual([u.subscription_status, u.subscription_ends_at, u.plan], ['active', null, 'famille']);
    assert.equal(fake.subs.get(sub.id).items.data[0].price.unit_amount, 999); assert.equal(fake.subs.get(sub.id).metadata.plan, 'famille');
    assert.match(journal(R.id).at(-1), /^Offre Famille choisie/);
    await stripeEvent('customer.subscription.updated', structuredClone(fake.subs.get(sub.id)));
    assert.equal((await R.me()).plan, 'famille', 'les métadonnées de Stripe portent la nouvelle offre');

    // Retour à Individuel : refusé tant que le dossier compte plus d'une personne (aucun appel), puis accepté ; le prix
    // déjà retrouvé n'est plus recherché.
    const p2 = (await R.call('POST', '/profiles', { first_name: 'Paul', last_name: 'Moreau' })).data.profile;
    await cancelNow(R, sub);
    m = fake.mark();
    r = await R.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 409); assert.match(r.data.error, /2\u00a0personnes/); assert.equal(fake.since(m).length, 0);
    assert.equal((await R.call('DELETE', `/profiles/${p2.id}`)).status, 200);
    r = await R.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 200, r.text); assert.equal(r.data.switched, true);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${sub.id}`, 'GET /v1/prices', 'POST /v1/prices', `POST /v1/subscriptions/${sub.id}`]);
    assert.equal(fake.subs.get(sub.id).items.data[0].price.unit_amount, 500);
    await cancelNow(R, sub);
    m = fake.mark();
    r = await R.call('POST', '/billing/checkout', { plan: 'famille' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${sub.id}`, `POST /v1/subscriptions/${sub.id}`], 'prix gardé en mémoire');
    assert.equal(fake.since(m)[1].form['items[0][price]'], famillePrice);
    assert.equal(fake.calls.filter((c) => c.path === '/v1/checkout/sessions' && c.form.client_reference_id === R.id).length, 0, 'jamais de seconde session de paiement');
  }
  step('réabonnement pendant la période payée : même offre → résiliation annulée sans paiement ; autre offre → changement au prorata ; jamais de second abonnement');

  /* ---------- 4. Réabonnement : état réel de l'abonnement chez Stripe ---------- */
  {
    // Abonnement déjà terminé chez Stripe (fin de période passée, webhook pas encore reçu) : nouvelle session, même client.
    const E = await actor('termine@exemple.fr');
    const subE = await paid(E, 'individuel');
    await cancelNow(E, subE);
    Object.assign(fake.subs.get(subE.id), { status: 'canceled', ended_at: nowS() });
    let m = fake.mark();
    let r = await E.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 200, r.text); assert.equal(r.data.mode, 'stripe'); assert.ok(r.data.url);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subE.id}`, 'POST /v1/checkout/sessions']);
    assert.equal(fake.since(m)[1].form.customer, subE.customer, 'même client Stripe');
    // Abonnement inconnu de Stripe (404) : rien à reprendre, nouvelle session.
    const N = await actor('inconnu@exemple.fr');
    const subN = await paid(N, 'individuel');
    await cancelNow(N, subN);
    fake.subs.delete(subN.id);
    m = fake.mark();
    r = await N.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 200, r.text); assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subN.id}`, 'POST /v1/checkout/sessions']);
    // Paiement en attente chez Stripe (résilié localement, ou impayé) : ni reprise ni second abonnement, 409 expliqué.
    const P = await actor('impaye@exemple.fr');
    const subP = await paid(P, 'individuel');
    await cancelNow(P, subP);
    fake.subs.get(subP.id).status = 'past_due';
    m = fake.mark();
    r = await P.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 409, r.text); assert.match(r.data.error, /^Un paiement de votre abonnement est en attente de régularisation :/);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subP.id}`]);
    await stripeEvent('customer.subscription.updated', structuredClone(fake.subs.get(subP.id)));
    assert.equal((await P.me()).subscription_status, 'past_due');
    m = fake.mark();
    r = await P.call('POST', '/billing/checkout', { plan: 'famille' });
    assert.equal(r.status, 409); assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subP.id}`]);
    // Ancienne formule annuelle résiliée : elle n'est plus vendue, donc ni reprise ni doublée.
    const Y = await actor('annuel@exemple.fr');
    const subY = await paid(Y, 'individuel', { interval: 'year', amount: 5000, periodDays: 365 });
    await cancelNow(Y, subY);
    m = fake.mark();
    r = await Y.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 409, r.text); assert.match(r.data.error, /^Votre ancienne formule annuelle reste payée jusqu’au \d{1,2} \S+ \d{4} :/);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subY.id}`]);
    // Stripe injoignable ou en erreur : 502, et surtout pas de nouvelle session (on ne sait pas si l'ancien court encore).
    const X = await actor('incertain@exemple.fr');
    const subX = await paid(X, 'individuel');
    await cancelNow(X, subX);
    fake.fail('GET', `/v1/subscriptions/${subX.id}`, 500);
    m = fake.mark();
    r = await X.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 502); assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subX.id}`]);
    fake.fail('POST', `/v1/subscriptions/${subX.id}`, 500);
    r = await X.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 502); assert.equal((await X.me()).subscription_status, 'canceled', 'reprise non confirmée : rien ne change');
    assert.equal(fake.subs.get(subX.id).cancel_at_period_end, true);
    // Abonnement offert par clé qui prend le relais d'une période payée encore en cours : l'abonnement payé est repris
    // (pas de second abonnement pendant la période déjà payée).
    const K = await actor('cle-relais@exemple.fr');
    const subK = await paid(K, 'individuel');
    await cancelNow(K, subK);
    db.prepare(`UPDATE users SET subscription_status = 'active', billing_mode = 'key', billing = NULL, subscription_ends_at = ? WHERE id = ?`).run(iso(subK.current_period_end + 30 * DAY), K.id);
    m = fake.mark();
    r = await K.call('POST', '/billing/checkout', { plan: 'individuel' });
    assert.equal(r.status, 200, r.text); assert.equal(r.data.mode, 'resumed');
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subK.id}`, `POST /v1/subscriptions/${subK.id}`]);
    const uk = await K.me();
    assert.deepEqual([uk.subscription_status, uk.billing_mode, uk.subscription_ends_at], ['active', 'stripe', null]);
  }
  step('réabonnement : abonnement terminé ou inconnu chez Stripe → nouvelle session ; impayé ou ancienne formule annuelle → 409 ; Stripe en erreur → 502 sans session ; relais d’une clé → reprise');

  /* ---------- 5. Application (navigateur, 1280 et 390 px) : reprendre ou changer d'offre sans page de paiement ---------- */
  if (!playwright) console.log('  · navigateur indisponible (PLAYWRIGHT_MODULE) : vérifications de l’application ignorées');
  else {
    const W = await actor('navigateur@exemple.fr', { complete: true });
    const subW = await paid(W, 'individuel');
    await cancelNow(W, subW);
    const browser = await playwright.chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies([{ name: W.cookie.split('=')[0], value: W.cookie.split('=').slice(1).join('='), domain: 'localhost', path: '/' }]);
      // Chaque message affiché dans #toast est noté (il s'efface au bout de quelques secondes).
      await ctx.addInitScript(() => { window.__toasts = []; document.addEventListener('DOMContentLoaded', () => { const t = document.getElementById('toast'); if (t) new MutationObserver(() => { if (t.textContent) window.__toasts.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true }); }); });
      const page = await ctx.newPage();
      const problems = [];
      const toastMatching = async (re) => { try { await page.waitForFunction((src) => window.__toasts.some((x) => new RegExp(src).test(x)), re.source, { timeout: 8000 }); } catch { assert.fail(`message attendu ${re} ; reçus : ${JSON.stringify(await page.evaluate(() => window.__toasts))} (${page.url()})`); } };
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
      const layout = () => page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        sheets: [...document.querySelectorAll('.sheet')].filter((s) => s.scrollWidth > s.clientWidth + 1).length,
        small: [...document.querySelectorAll('[data-checkout]')].filter((b) => b.getBoundingClientRect().height < 44).length,
      }));
      const plansView = async () => {
        await page.goto(`${APP}/app/?v=${crypto.randomBytes(3).toString('hex')}#billing`);
        await page.waitForSelector('.plans-block .notice--info');
        return page.evaluate(() => ({
          notice: document.querySelector('.plans-block .notice--info').textContent,
          individuel: document.querySelector('[data-checkout="individuel"]').textContent,
          famille: document.querySelector('[data-checkout="famille"]').textContent,
        }));
      };
      // 1280 px : même offre → reprise.
      let v = await plansView();
      assert.match(v.notice, /^Votre abonnement Individuel reste payé jusqu’au \d{1,2} \S+ \d{4}\. Le reprendre annule la résiliation, sans nouveau paiement ; passer à l’autre offre prend effet aussitôt/);
      assert.deepEqual([v.individuel, v.famille], ['Reprendre Individuel', 'Passer à Famille']);
      assert.deepEqual(await layout(), { overflow: 0, sheets: 0, small: 0 }, '1280 px');
      let m = fake.mark();
      await page.click('[data-checkout="individuel"]');
      await toastMatching(/^Résiliation annulée\u00a0: votre abonnement Individuel continue, sans nouveau paiement\./);
      assert.ok(page.url().startsWith(APP), 'aucune redirection vers une page de paiement');
      assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subW.id}`, `POST /v1/subscriptions/${subW.id}`]);
      assert.equal((await W.me()).subscription_status, 'active');
      // 390 px : autre offre → changement au prorata.
      await cancelNow(W, subW);
      await page.setViewportSize({ width: 390, height: 844 });
      v = await plansView();
      assert.deepEqual([v.individuel, v.famille], ['Reprendre Individuel', 'Passer à Famille']);
      assert.deepEqual(await layout(), { overflow: 0, sheets: 0, small: 0 }, '390 px');
      m = fake.mark();
      await page.click('[data-checkout="famille"]');
      await toastMatching(/^Résiliation annulée, offre Famille active dès maintenant\u00a0: la différence au prorata/);
      assert.ok(page.url().startsWith(APP));
      assert.equal(sig(fake.since(m)).filter((s) => s === 'POST /v1/checkout/sessions').length, 0);
      assert.equal((await W.me()).plan, 'famille');
      assert.deepEqual(problems, [], 'aucune erreur dans la console');
      await ctx.close();
    } finally { await browser.close(); }
  }
  step('application : avis « reste payé jusqu’au… », boutons « Reprendre » et « Passer à », reprise et changement d’offre sans page de paiement, à 1280 et 390 px');

  /* ---------- 6. Webhooks livrés en retard : un événement plus ancien que le dernier appliqué est ignoré ---------- */
  // Un checkout.session.completed livré en retard (autre identifiant d'événement) réactivait un compte résilié jusqu'au
  // prochain événement ; une mise à jour ancienne défaisait une reprise ou une résiliation plus récente.
  {
    const mark = (id) => row(id).stripe_event_created;
    const T0 = nowS() - 7200;
    const checkoutOf = (a, sub, plan = 'individuel') => ({ object: 'checkout.session', mode: 'subscription', payment_status: 'paid', customer: sub.customer, subscription: sub.id, client_reference_id: a.id, metadata: { user_id: a.id, plan, billing: 'monthly' } });
    const state = async (a) => { const u = await a.me(); return [u.subscription_status, u.billing_mode]; };
    // a. Abonnement supprimé : un ancien checkout ou une ancienne mise à jour (autres identifiants) ne le réactivent pas.
    const L = await actor('retard@exemple.fr');
    const subL = await paid(L, 'individuel', { created: T0 });
    assert.equal(mark(L.id), T0, 'date (event.created) du dernier événement appliqué');
    await stripeEvent('customer.subscription.deleted', { ...structuredClone(subL), status: 'canceled', ended_at: T0 + 600 }, { created: T0 + 600 });
    assert.deepEqual(await state(L), ['canceled', 'stripe']);
    await stripeEvent('checkout.session.completed', checkoutOf(L, subL), { created: T0 + 60 });
    await stripeEvent('checkout.session.async_payment_succeeded', checkoutOf(L, subL), { created: T0 + 70 });
    await stripeEvent('customer.subscription.updated', { ...structuredClone(subL), status: 'active' }, { created: T0 + 300 });
    await stripeEvent('invoice.paid', { object: 'invoice', customer: subL.customer, subscription: subL.id }, { created: T0 + 400 });
    assert.deepEqual(await state(L), ['canceled', 'stripe'], 'aucun événement plus ancien ne réactive le compte');
    assert.equal(mark(L.id), T0 + 600);
    // Un événement plus récent s'applique, même s'il est daté de la même seconde que le dernier.
    await stripeEvent('customer.subscription.updated', { ...structuredClone(subL), status: 'active', cancel_at_period_end: false }, { created: T0 + 600 });
    assert.deepEqual(await state(L), ['active', 'stripe'], 'même seconde : appliqué');
    await stripeEvent('customer.subscription.updated', { ...structuredClone(subL), status: 'canceled', ended_at: T0 + 900 }, { created: T0 + 900 });
    assert.deepEqual(await state(L), ['canceled', 'stripe']); assert.equal(mark(L.id), T0 + 900);
    // La déduplication par identifiant reste : un événement rejoué tel quel n'est traité qu'une fois.
    const dup = `evt_dup_${crypto.randomBytes(6).toString('hex')}`;
    for (let i = 0; i < 2; i++) await stripeEvent('checkout.session.async_payment_failed', checkoutOf(L, subL), { created: T0 + 950, id: dup });
    assert.equal(journal(L.id).filter((x) => /^Paiement refusé par la banque/.test(x)).length, 1, 'rejoué : traité une fois');

    // b. Impayé régularisé : l'échec ancien livré après le paiement ne repasse pas le compte en attente.
    const I = await actor('facture-retard@exemple.fr');
    const subI = await paid(I, 'individuel', { created: T0 });
    await stripeEvent('invoice.payment_failed', { object: 'invoice', customer: subI.customer, subscription: subI.id }, { created: T0 + 100 });
    assert.deepEqual(await state(I), ['past_due', 'stripe']);
    await stripeEvent('invoice.paid', { object: 'invoice', customer: subI.customer, subscription: subI.id }, { created: T0 + 200 });
    await stripeEvent('invoice.payment_failed', { object: 'invoice', customer: subI.customer, subscription: subI.id }, { created: T0 + 150 });
    assert.deepEqual(await state(I), ['active', 'stripe'], 'échec plus ancien que le paiement : ignoré');

    // c. Ancien abonnement (garde staleSub) : ses événements, même récents, ne comptent pas pour le compte.
    const M = await actor('ancien-abonnement@exemple.fr');
    const subOld = await paid(M, 'individuel', { created: T0 });
    await stripeEvent('customer.subscription.updated', { ...structuredClone(subOld), cancel_at_period_end: true, cancel_at: subOld.current_period_end }, { created: T0 + 10 });
    const subNew = fake.addSubscription({ userId: M.id, plan: 'famille', customer: subOld.customer });
    await stripeEvent('checkout.session.completed', checkoutOf(M, subNew, 'famille'), { created: T0 + 20 });
    assert.equal(row(M.id).stripe_subscription_id, subNew.id);
    await stripeEvent('customer.subscription.deleted', { ...structuredClone(subOld), status: 'canceled', ended_at: T0 + 5000 }, { created: T0 + 5000 });
    assert.equal(mark(M.id), T0 + 20, 'un événement de l’ancien abonnement ne fait pas avancer la date');
    await stripeEvent('customer.subscription.updated', { ...structuredClone(subNew), cancel_at_period_end: true, cancel_at: subNew.current_period_end }, { created: T0 + 500 });
    assert.deepEqual(await state(M), ['canceled', 'stripe'], 'le nouvel abonnement suit son cours');

    // d. Abonnement offert par clé (garde keyRunning) qui suit un abonnement payé : la fin de l'abonnement payé est notée,
    // et son ancien checkout livré en retard ne remplace pas la clé par un abonnement terminé.
    const K = await actor('cle-retard@exemple.fr');
    const subK = await paid(K, 'individuel', { created: T0 });
    db.prepare(`UPDATE users SET subscription_status = 'active', billing_mode = 'key', billing = NULL, subscription_ends_at = ? WHERE id = ?`).run(iso(nowS() + 30 * DAY), K.id);
    await stripeEvent('customer.subscription.deleted', { ...structuredClone(subK), status: 'canceled', ended_at: T0 + 100 }, { created: T0 + 100 });
    assert.deepEqual(await state(K), ['active', 'key'], 'clé conservée');
    await stripeEvent('checkout.session.completed', checkoutOf(K, subK), { created: T0 + 50 });
    assert.deepEqual(await state(K), ['active', 'key'], 'ancien checkout : la clé reste');

    // e. Action de l'abonné (API) : la réponse de Stripe compte comme un événement daté de la réponse. L'annonce,
    // livrée en retard, d'un état antérieur ne défait ni la reprise ni la résiliation.
    const A = await actor('api-retard@exemple.fr');
    const subA = await paid(A, 'individuel', { created: T0 });
    assert.equal((await A.call('POST', '/billing/cancel', {})).status, 200);
    const cancelSeen = mark(A.id);
    assert.ok(cancelSeen >= nowS() - 5 && cancelSeen <= nowS() + 1, `date de la réponse de Stripe (${cancelSeen})`);
    await stripeEvent('customer.subscription.updated', { ...structuredClone(subA), cancel_at_period_end: false, cancel_at: null }, { created: cancelSeen - 30 });
    assert.deepEqual(await state(A), ['canceled', 'stripe'], 'état antérieur à la résiliation : ignoré');
    await wait(1100);   // la reprise est datée d'une seconde ultérieure
    assert.equal((await A.call('POST', '/billing/checkout', { plan: 'individuel' })).data.mode, 'resumed');
    assert.ok(mark(A.id) > cancelSeen);
    await stripeEvent('customer.subscription.updated', { ...structuredClone(subA), cancel_at_period_end: true, cancel_at: subA.current_period_end }, { created: cancelSeen });
    assert.deepEqual(await state(A), ['active', 'stripe'], 'annonce de la résiliation livrée après la reprise : ignorée');
  }
  step('webhooks en retard : ancien checkout, mise à jour ou facture ignorés (autre identifiant), même seconde appliquée, déduplication, ancien abonnement et clé, réponses de l’API datées');

  /* ---------- 7. Suppression du compte : abonnement annulé tout de suite, factures ouvertes annulées ---------- */
  // La suppression résiliait en fin de période (cancel_at_period_end) et seulement un abonnement « actif » ou « impayé » :
  // une facture ouverte restait prélevable, et un abonnement résilié mais encore en cours n'était pas arrêté.
  {
    const deleted = (id) => { const r = row(id); return !!r.deleted_at && r.stripe_subscription_id === null && r.email === `deleted-${id}@oubli.invalid`; };
    const remove = (a) => a.call('DELETE', '/account', { password: STRONG });
    const voided = (calls) => calls.filter((c) => c.method === 'POST' && /\/void$/.test(c.path)).map((c) => c.path.split('/')[3]).sort();
    // a. Abonnement actif, deux factures ouvertes, une payée.
    const D = await actor('suppression@exemple.fr', { complete: true });
    const subD = await paid(D, 'individuel');
    const open1 = fake.addInvoice(subD), open2 = fake.addInvoice(subD), paidInv = fake.addInvoice(subD, { status: 'paid' });
    let m = fake.mark();
    let r = await D.call('DELETE', '/account', { password: 'mauvais-mot-de-passe' });
    assert.equal(r.status, 400); assert.equal(fake.since(m).length, 0, 'mot de passe incorrect : aucun appel');
    r = await remove(D);
    assert.equal(r.status, 200, r.text);
    let calls = fake.since(m);
    assert.deepEqual(sig(calls).filter((x) => !/\/void$/.test(x)), [`GET /v1/subscriptions/${subD.id}`, `DELETE /v1/subscriptions/${subD.id}`, 'GET /v1/invoices']);
    assert.equal(calls[1].raw, '', 'annulation immédiate, sans facture finale ni prorata');
    assert.deepEqual({ subscription: calls[2].query.subscription, status: calls[2].query.status }, { subscription: subD.id, status: 'open' });
    assert.deepEqual(voided(calls), [open1.id, open2.id].sort(), 'seules les factures ouvertes sont annulées');
    assert.ok(!calls.some((c) => c.form.cancel_at_period_end), 'pas de résiliation en fin de période');
    assert.equal(fake.subs.get(subD.id).status, 'canceled');
    assert.deepEqual([fake.invoices.get(open1.id).status, fake.invoices.get(open2.id).status, fake.invoices.get(paidInv.id).status], ['void', 'void', 'paid']);
    assert.ok(deleted(D.id), 'compte supprimé et anonymisé');
    assert.equal((await D.call('GET', '/me')).data.user, null, 'session fermée');

    // b. Abonnement résilié mais encore en cours (fin de période) : arrêté tout de suite lui aussi.
    const C = await actor('suppression-resilie@exemple.fr');
    const subC = await paid(C, 'individuel');
    await cancelNow(C, subC);
    m = fake.mark();
    assert.equal((await remove(C)).status, 200);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subC.id}`, `DELETE /v1/subscriptions/${subC.id}`, 'GET /v1/invoices']);
    assert.equal(fake.subs.get(subC.id).status, 'canceled'); assert.ok(deleted(C.id));

    // c. Paiement en attente : la facture impayée n'est plus représentée.
    const P = await actor('suppression-impaye@exemple.fr');
    const subP = await paid(P, 'individuel');
    const unpaid = fake.addInvoice(subP);
    fake.subs.get(subP.id).status = 'past_due';
    await stripeEvent('customer.subscription.updated', structuredClone(fake.subs.get(subP.id)));
    assert.equal((await P.me()).subscription_status, 'past_due');
    m = fake.mark();
    assert.equal((await remove(P)).status, 200);
    assert.deepEqual(voided(fake.since(m)), [unpaid.id]);
    assert.deepEqual([fake.subs.get(subP.id).status, fake.invoices.get(unpaid.id).status], ['canceled', 'void']); assert.ok(deleted(P.id));

    // d. Stripe refuse l'annulation : 502, rien n'est supprimé ; un nouvel essai aboutit.
    const F = await actor('suppression-echec@exemple.fr');
    const subF = await paid(F, 'individuel');
    fake.fail('DELETE', `/v1/subscriptions/${subF.id}`, 500);
    r = await remove(F);
    assert.equal(r.status, 502, r.text); assert.match(r.data.error, /pas été supprimé/); assert.ok(!r.text.includes('faux Stripe'));
    assert.equal((await F.me()).email, 'suppression-echec@exemple.fr', 'compte et session intacts');
    assert.equal(row(F.id).deleted_at, null); assert.equal(fake.subs.get(subF.id).status, 'active');
    assert.equal((await remove(F)).status, 200); assert.ok(deleted(F.id)); assert.equal(fake.subs.get(subF.id).status, 'canceled');

    // e. Abonnement annulé mais facture impossible à annuler : 502, rien n'est supprimé, le compte affiche la fin de
    // l'abonnement ; le nouvel essai n'annule pas deux fois l'abonnement et annule la facture.
    const V = await actor('suppression-facture@exemple.fr');
    const subV = await paid(V, 'individuel');
    const invV = fake.addInvoice(subV);
    fake.fail('POST', `/v1/invoices/${invV.id}/void`, 500);
    r = await remove(V);
    assert.equal(r.status, 502, r.text); assert.equal(row(V.id).deleted_at, null);
    assert.equal(fake.subs.get(subV.id).status, 'canceled', 'abonnement déjà arrêté');
    const uv = await V.me();
    assert.equal(uv.subscription_status, 'canceled', 'le compte reflète l’arrêt de l’abonnement');
    m = fake.mark();
    assert.equal((await remove(V)).status, 200);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subV.id}`, 'GET /v1/invoices', `POST /v1/invoices/${invV.id}/void`], 'pas de seconde annulation');
    assert.equal(fake.invoices.get(invV.id).status, 'void'); assert.ok(deleted(V.id));

    // f. Abonnement inconnu de Stripe (404) : rien à arrêter, la suppression a lieu.
    const G = await actor('suppression-inconnu@exemple.fr');
    const subG = await paid(G, 'individuel');
    fake.subs.delete(subG.id);
    m = fake.mark();
    assert.equal((await remove(G)).status, 200);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subG.id}`]); assert.ok(deleted(G.id));

    // g. La résiliation normale reste en fin de période : bouton « Résilier » (groupe 1) et administration.
    const ADM = await actor('admin@test.fr');
    const H = await actor('resiliation-admin@exemple.fr');
    const subH = await paid(H, 'individuel');
    m = fake.mark();
    r = await ADM.call('POST', `/admin/users/${H.id}/subscription`, { status: 'canceled' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(sig(fake.since(m)), [`POST /v1/subscriptions/${subH.id}`]); assert.deepEqual(fake.since(m)[0].form, { cancel_at_period_end: 'true' });
    assert.equal(fake.subs.get(subH.id).status, 'active', 'accès jusqu’à la fin de la période');
  }
  step('suppression du compte : abonnement Stripe annulé tout de suite (même résilié en fin de période ou impayé), factures ouvertes annulées, 502 sans suppression si Stripe échoue, essai suivant sans double annulation ; résiliation normale en fin de période');

  /* ---------- 8. Aucun identifiant Stripe complet dans les réponses ---------- */
  {
    const Z = await actor('fuites@exemple.fr', { complete: true });
    const subZ = await paid(Z, 'famille');
    const ADM = await actor('admin2@exemple.fr');
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(ADM.id);
    for (const p of ['/me', '/export', '/dashboard', '/requests.csv']) assert.equal((await Z.call('GET', p)).status, 200, p);
    let r = await ADM.call('GET', `/admin/users/${Z.id}`);
    assert.equal(r.status, 200); assert.ok(r.data.user.stripe_subscription && r.data.user.stripe_subscription !== subZ.id, 'masqué dans l’administration');
    for (const p of [`/admin/users?q=${encodeURIComponent(Z.email)}`, '/admin/export.csv?what=users', '/admin/audit', '/admin/stats']) assert.equal((await ADM.call('GET', p)).status, 200, p);
    assert.ok(fake.issued.size > 50, `${fake.issued.size} identifiants émis par le faux Stripe`);
    const leaks = responses.flatMap(({ p, text }) => [...fake.issued].filter((id) => text.includes(id)).map((id) => `${p} → ${id}`));
    assert.deepEqual(leaks, [], 'aucune réponse ne contient un identifiant Stripe complet (client, abonnement, ligne, prix, produit, facture)');
    assert.ok(responses.length > 150, `${responses.length} réponses examinées`);
    assert.ok(!(serverOut + serverErr).includes(SK), 'la clé secrète n’apparaît pas dans la console du serveur');
  }
  step('aucun identifiant Stripe complet dans les réponses (abonné, export, CSV, administration masquée, erreurs 409 et 502) ni la clé secrète dans la console');

  /* ---------- 9. Webhooks : signature obligatoire, comparée en temps constant, tolérance de 5 minutes ---------- */
  {
    const S = await actor('signature@exemple.fr');
    const subS = fake.addSubscription({ userId: S.id });
    const raw = JSON.stringify({ id: `evt_${crypto.randomBytes(8).toString('hex')}`, object: 'event', type: 'checkout.session.completed', created: nowS(), data: { object: { object: 'checkout.session', mode: 'subscription', payment_status: 'paid', customer: subS.customer, subscription: subS.id, client_reference_id: S.id, metadata: { user_id: S.id, plan: 'individuel', billing: 'monthly' } } } });
    const post = (body, header, cookie) => call('POST', '/billing/webhook', undefined, { raw: body, cookie, headers: { 'content-type': 'application/json', ...(header === undefined ? {} : { 'stripe-signature': header }) } });
    const good = signed(raw), t = nowS(), v1 = good.split('v1=')[1];
    const flip = (hex) => hex.slice(0, -1) + (hex.at(-1) === '0' ? '1' : '0');
    for (const [label, body, header] of [
      ['sans en-tête', raw, undefined], ['en-tête vide', raw, ''], ['sans horodatage', raw, `v1=${v1}`], ['sans v1', raw, `t=${t}`], ['v0 seul', raw, `t=${t},v0=${v1}`],
      ['horodatage non numérique', raw, `t=abc,v1=${v1}`], ['autre secret', raw, signed(raw, t, 'whsec_autre_secret_0123456789')], ['même longueur, un caractère changé', raw, `t=${t},v1=${flip(v1)}`],
      ['signature tronquée', raw, `t=${t},v1=${v1.slice(0, 32)}`], ['corps modifié', raw.replace('"individuel"', '"famille"'), good],
      ['horodatage trop ancien', raw, signed(raw, t - 301)], ['horodatage dans le futur', raw, signed(raw, t + 301)],
    ]) {
      const res = await post(body, header);
      assert.equal(res.status, 400, `${label} : ${res.status}`); assert.equal(res.data.error, 'Signature invalide.', label);
    }
    assert.equal((await S.me()).subscription_status, 'none', 'aucun webhook refusé n’a d’effet');
    let res = await post(raw, `t=${t},v1=${flip(v1)},v1=${v1}`, S.cookie);   // rotation du secret : une des signatures suffit ; cookie ignoré
    assert.equal(res.status, 200, res.text); assert.equal((await S.me()).subscription_status, 'active');
    res = await post(raw, signed(raw, t - 290));
    assert.equal(res.status, 200, 'dans la tolérance (290 s), déjà traité : accepté et ignoré');
    // Comparaison : verifyStripeSignature passe par crypto.timingSafeEqual (temps constant), même quand la signature
    // a la bonne longueur mais un mauvais contenu. Import dans ce processus sur une base temporaire (jamais data/).
    process.env.DATABASE_PATH = path.join(tmp, 'unit.sqlite');
    const { verifyStripeSignature } = await import('../server/billing.js');
    const { closeDb } = await import('../server/db.js');
    const realEqual = crypto.timingSafeEqual;
    const seen = [];
    crypto.timingSafeEqual = (a, b) => { seen.push([Buffer.from(a).toString(), Buffer.from(b).toString().length]); return realEqual(a, b); };
    try {
      const T = 1_800_000_000, header = signed('{"a":1}', T, 'whsec_unit');
      assert.equal(verifyStripeSignature('{"a":1}', header, 'whsec_unit', T * 1000), true);
      assert.equal(verifyStripeSignature('{"a":1}', header, 'whsec_unit', (T + 300) * 1000), true, '300 s : accepté');
      assert.equal(verifyStripeSignature('{"a":1}', header, 'whsec_unit', (T + 301) * 1000), false, '301 s : refusé');
      assert.equal(verifyStripeSignature('{"a":1}', header, 'whsec_unit', (T - 301) * 1000), false, 'futur : refusé');
      const wrong = `t=${T},v1=${flip(header.split('v1=')[1])}`;
      seen.length = 0;
      assert.equal(verifyStripeSignature('{"a":1}', wrong, 'whsec_unit', T * 1000), false);
      assert.deepEqual(seen, [[flip(header.split('v1=')[1]), 64]], 'mauvaise signature de même longueur : comparée par timingSafeEqual');
      assert.equal(verifyStripeSignature('{"a":1}', header, '', T * 1000), false, 'sans secret configuré : toujours refusé');
    } finally { crypto.timingSafeEqual = realEqual; closeDb(); }
  }
  step('webhooks : signature absente, malformée, d’un autre secret, modifiée, tronquée, hors tolérance ou sur un corps modifié → 400 sans effet ; rotation acceptée ; comparaison par timingSafeEqual');

  /* ---------- 10. Abonnement d'un compte déjà supprimé : arrêté dès que Stripe l'annonce ---------- */
  // Un paiement terminé dans un onglet resté ouvert ou un webhook arrivé après la suppression laissaient un abonnement
  // prélevé sans compte pour l'arrêter. La suppression par l'administration arrête désormais l'abonnement elle-même.
  {
    const deletedRow = (id) => !!row(id).deleted_at;
    const checkoutOf = (a, sub) => ({ object: 'checkout.session', mode: 'subscription', payment_status: 'paid', customer: sub.customer, subscription: sub.id, client_reference_id: a.id, metadata: { user_id: a.id, plan: 'individuel', billing: 'monthly' } });
    const signedEvent = (type, object, id = `evt_${crypto.randomBytes(8).toString('hex')}`) => { const raw = JSON.stringify({ id, object: 'event', type, created: nowS(), data: { object } }); return () => call('POST', '/billing/webhook', undefined, { raw, headers: { 'content-type': 'application/json', 'stripe-signature': signed(raw) } }); };
    // a. Paiement terminé après la suppression du compte (session ouverte avant).
    const O = await actor('orphelin@exemple.fr');
    assert.equal((await O.call('POST', '/billing/checkout', { plan: 'individuel' })).data.mode, 'stripe');
    assert.equal((await O.call('DELETE', '/account', { password: STRONG })).status, 200);
    const subO = fake.addSubscription({ userId: O.id }), invO = fake.addInvoice(subO);
    let m = fake.mark();
    await stripeEvent('checkout.session.completed', checkoutOf(O, subO));
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subO.id}`, `DELETE /v1/subscriptions/${subO.id}`, 'GET /v1/invoices', `POST /v1/invoices/${invO.id}/void`]);
    assert.deepEqual([fake.subs.get(subO.id).status, fake.invoices.get(invO.id).status], ['canceled', 'void']);
    assert.ok(deletedRow(O.id) && row(O.id).subscription_status !== 'active', 'le compte reste supprimé');
    m = fake.mark();
    await stripeEvent('customer.subscription.updated', structuredClone(fake.subs.get(subO.id)));
    assert.deepEqual(sig(fake.since(m)), [], 'abonnement terminé : plus rien à faire');

    // b. Stripe en erreur : 500 pour que Stripe renvoie l'événement, qui est alors traité.
    const O2 = await actor('orphelin-echec@exemple.fr');
    assert.equal((await O2.call('DELETE', '/account', { password: STRONG })).status, 200);
    const subO2 = fake.addSubscription({ userId: O2.id });
    const send = signedEvent('customer.subscription.created', structuredClone(subO2));
    fake.fail('DELETE', `/v1/subscriptions/${subO2.id}`, 500);
    let r = await send();
    assert.equal(r.status, 500, r.text); assert.ok(!r.text.includes('faux Stripe'));
    assert.equal(fake.subs.get(subO2.id).status, 'active');
    r = await send();   // même événement, renvoyé par Stripe
    assert.equal(r.status, 200, r.text); assert.equal(fake.subs.get(subO2.id).status, 'canceled');

    // c. Suppression par l'administration : abonnement arrêté tout de suite, comme par l'abonné (elle résiliait en fin de
    // période) ; Stripe en erreur → 502, rien n'est supprimé. L'annonce suivante de Stripe ne déclenche plus rien.
    const ADM = await actor('admin3@exemple.fr');
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(ADM.id);
    const H = await actor('supprime-par-admin@exemple.fr');
    const subH = await paid(H, 'individuel');
    const invH = fake.addInvoice(subH);
    fake.fail('DELETE', `/v1/subscriptions/${subH.id}`, 500);
    r = await ADM.call('DELETE', `/admin/users/${H.id}`, { reason: 'demande écrite' });
    assert.equal(r.status, 502, r.text); assert.ok(!deletedRow(H.id), 'Stripe en erreur : rien n’est supprimé'); assert.equal(fake.subs.get(subH.id).status, 'active');
    m = fake.mark();
    assert.equal((await ADM.call('DELETE', `/admin/users/${H.id}`, { reason: 'demande écrite' })).status, 200);
    assert.deepEqual(sig(fake.since(m)), [`GET /v1/subscriptions/${subH.id}`, `DELETE /v1/subscriptions/${subH.id}`, 'GET /v1/invoices', `POST /v1/invoices/${invH.id}/void`], 'arrêt immédiat, sans résiliation en fin de période');
    assert.ok(deletedRow(H.id)); assert.deepEqual([fake.subs.get(subH.id).status, fake.invoices.get(invH.id).status], ['canceled', 'void']);
    m = fake.mark();
    await stripeEvent('customer.subscription.updated', structuredClone(fake.subs.get(subH.id)));
    assert.deepEqual(sig(fake.since(m)), [], 'abonnement déjà arrêté : plus rien à faire');

    // d. Pas de faux positif : un compte vivant, ou un événement sans métadonnées, ne déclenche aucun appel.
    const Live = await actor('vivant@exemple.fr');
    const subLive = await paid(Live, 'individuel');
    m = fake.mark();
    await stripeEvent('customer.subscription.updated', structuredClone(subLive));
    await stripeEvent('customer.subscription.updated', { ...structuredClone(fake.addSubscription({ userId: 'inconnu' })), metadata: {} });
    assert.deepEqual(sig(fake.since(m)), []); assert.equal(fake.subs.get(subLive.id).status, 'active');
  }
  step('compte supprimé : un abonnement annoncé ensuite (paiement tardif) est arrêté tout de suite, factures ouvertes annulées ; Stripe en erreur → 500 puis nouvel envoi traité ; suppression par l’administration : arrêt immédiat ou 502 ; aucun faux positif');

  db.close();
  assert.ok(!(serverOut + serverErr).includes(SK), 'la clé secrète n’apparaît jamais dans la console du serveur');
  console.log(`✔ Facturation Stripe validée (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr.trim()) console.error(serverErr.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000).unref(); });   // attendre l'arrêt : le serveur peut encore écrire dans tmp
  fake.server.closeAllConnections();
  await new Promise((r) => fake.server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
