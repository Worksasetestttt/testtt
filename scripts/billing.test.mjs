// Test de la facturation Stripe contre un faux serveur Stripe (node:http) : chaque appel à l'API est enregistré (méthode,
// chemin, paramètres form-urlencoded, en-têtes) et reçoit une réponse réaliste. Le serveur Oubli tourne sur un port libre,
// avec une base temporaire, STRIPE_API_BASE pointé vers le faux Stripe et des webhooks signés comme Stripe les envoie.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';

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
  await stripeEvent('checkout.session.completed', { object: 'checkout.session', mode: 'subscription', payment_status: 'paid', customer: sub.customer, subscription: sub.id, client_reference_id: a.id, metadata: { user_id: a.id, plan, billing: 'monthly' } }, { created: opts.created });
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
