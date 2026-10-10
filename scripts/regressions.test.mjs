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
// Abonné complet : profil, mandat, abonnement activé par l'administration (sans passer par /billing/checkout, limité à
// 10 appels par quart d'heure et par adresse), demandes lancées.
async function member(s, { plan = 'individuel', subscribe = true, launch = true, first = 'Léa', last = 'Moreau' } = {}) {
  const email = `abonne${++seq}@exemple.fr`;
  const r = await s.call('POST', '/auth/signup', { email, password: STRONG, plan });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cookie = r.cookie;
  const me = await s.call('GET', '/me', undefined, cookie);
  await s.call('PUT', `/profiles/${me.data.profiles[0].id}`, { first_name: first, last_name: last }, cookie);
  await s.call('POST', '/mandate', { full_name: `${first} ${last}`, accepted: true }, cookie);
  if (subscribe) assert.equal((await s.call('POST', `/admin/users/${me.data.user.id}/subscription`, { status: 'active', plan, billing: 'monthly' }, await adminOf(s))).status, 200);
  if (subscribe && launch) assert.ok((await s.call('POST', '/requests/launch', {}, cookie)).data.created > 0, 'demandes lancées');
  return { cookie, id: me.data.user.id, email, pid: me.data.profiles[0].id };
}
// Laisse partir les passages programmés (setTimeout de 10 ms après un lancement ou un ajout de site) : un passage qui
// envoie beaucoup de courriers en boîte d'envoi locale occupe le serveur et peut retarder ces minuteurs au-delà d'un
// passage manuel. Deux passages espacés garantissent qu'aucun ne reste en attente avant que le test ne modifie la base.
async function settle(s) { for (let i = 0; i < 2; i++) { await wait(60); await s.call('POST', '/admin/tick', {}, await adminOf(s)); } }
async function adminOf(s) {
  if (s.admin) return s.admin;
  let r = await s.call('POST', '/auth/login', { email: 'admin@test.fr', password: STRONG });
  if (r.status !== 200) r = await s.call('POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG });
  s.admin = r.cookie;
  return s.admin;
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

  /* ---------- Serveur principal (boîte d'envoi locale, paiement simulé, webhooks entrants et Stripe) ---------- */
  const S = await start('main');
  const ADM = await adminOf(S);
  const db = S.sql();
  const mailsOf = (id, like = '%') => db.prepare('SELECT subject, body FROM mails WHERE request_id = ? AND subject LIKE ? ORDER BY id').all(id, like);
  const reqRow = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

  /* ---------- 2. Lecture des réponses entrantes ---------- */
  // L'objet « Re: Demande d’effacement de données personnelles… » (que le courrier demande de conserver) et le texte
  // cité contiennent « effacement », « supprimer » : toute réponse était lue comme une confirmation d'effacement.
  {
    const A = await member(S);
    await settle(S);
    const sent = db.prepare(`SELECT id, token FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at`).all(A.id);
    const subject = (r) => mailsOf(r.id)[0].subject;
    const quoteFr = '\n\nLe 3 oct. 2026 à 10:00, Oubli <demandes@oubli.example> a écrit :\n> 2. de supprimer l’ensemble de ces données (article 17 du RGPD, « droit à l’effacement ») ;\n> Identité de la personne concernée :';
    const quoteEn = '\n\nOn Sat, Oct 3, 2026 at 10:00 AM Oubli <demandes@oubli.example> wrote:\n> 2. delete all such data, including profiles, derived data, identifiers and backups;';
    const cases = [
      ['Re: ', 'Bonjour,\nAvant toute suppression, merci de confirmer l’identité de la personne concernée (copie d’une pièce d’identité).\nCordialement', 'action_required'],
      ['RE: ', `Hello,\nPlease verify your identity using the link below.${quoteEn}`, 'action_required'],
      ['Re: ', 'Nous ne pouvons pas donner suite : ces données sont nécessaires au respect de nos obligations légales.', 'refused'],
      ['TR: ', `Nous avons bien reçu votre demande ; elle est en cours de traitement.${quoteFr}`, 'in_progress'],
      ['Re: ', 'Bonjour, vos données ont été supprimées de nos bases.', 'done'],
      ['Re: ', 'Après vérification, nous ne détenons aucune donnée concernant cette personne.', 'done'],
      ['Re: ', 'Thank you. Your request will be processed within 30 days.', 'in_progress'],
      ['Re: ', `We have deleted all records relating to this person.${quoteEn}`, 'done'],
    ];
    for (const [i, [prefix, text, expected]] of cases.entries()) {
      const r = await inbound(S, prefix + subject(sent[i]), text);
      assert.equal(r.status, 200); assert.equal(r.data.outcome, expected, `réponse « ${text.split('\n')[0]} » : ${r.data.outcome} au lieu de ${expected}`);
      assert.equal(reqRow(sent[i].id).status, expected, 'statut enregistré');
    }
    // Relance : son objet contient aussi « demande d’effacement ».
    const r = await inbound(S, `Re: Relance — demande d’effacement sans réponse [OUBLI-${sent[8].token}]`, 'Nous traitons votre demande.');
    assert.equal(r.data.outcome, 'in_progress');
    // La qualification par le support lit la réponse de la même façon (sans rien enregistrer).
    const sim = await S.call('POST', '/admin/inbound/simulate', { subject: 'Re: ' + subject(sent[9]), text: cases[0][1] }, ADM);
    assert.equal(sim.data.outcome, 'action_required'); assert.equal(reqRow(sent[9].id).status, 'sent');
  }
  step('réponses entrantes : objet « Re: Demande d’effacement… » et texte cité ignorés ; vérification, refus, accusé, absence de données reconnus');

  /* ---------- 3. Réponse tardive ou sans objet : la machine à états ne recule pas ---------- */
  // Un accusé de réception arrivé après la confirmation faisait repasser la demande « en cours » (revérification
  // perdue, relance envoyée au courtier qui avait effacé) ; « en cours » sur une demande en file la bloquait à jamais.
  {
    const A = await member(S);
    await settle(S);
    const [d1, d2, d3] = db.prepare(`SELECT id, token FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at LIMIT 3`).all(A.id);
    await S.call('POST', `/admin/requests/${d1.id}/outcome`, { outcome: 'done', note: 'confirmé' }, ADM);
    const check = reqRow(d1.id).next_check_at;
    let r = await inbound(S, `Réf. OUBLI-${d1.token}`, 'Nous avons bien reçu votre message.');
    assert.equal(r.status, 200); assert.equal(r.data.applied, false, 'accusé tardif ignoré');
    assert.equal(reqRow(d1.id).status, 'done'); assert.equal(reqRow(d1.id).next_check_at, check, 'revérification conservée');
    db.prepare('UPDATE requests SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), d1.id);
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(mailsOf(d1.id, 'Relance%').length, 0, 'aucune relance au courtier qui a confirmé');
    await S.call('POST', `/admin/requests/${d2.id}/outcome`, { outcome: 'refused' }, ADM);
    await inbound(S, `Réf. OUBLI-${d2.token}`, 'Accusé de réception automatique.');
    assert.equal(reqRow(d2.id).status, 'refused'); assert.ok(reqRow(d2.id).next_check_at, 'nouvelle demande toujours programmée');
    r = await S.call('POST', `/admin/requests/${d3.id}/outcome`, { outcome: 'in_progress' }, ADM);
    assert.equal(r.status, 200, 'accusé de réception sur une demande envoyée : appliqué'); assert.equal(reqRow(d3.id).status, 'in_progress');
    // Demande jamais envoyée : « en cours » ou « vérification » n'ont pas de sens et la bloqueraient.
    const B = await member(S);
    await settle(S);
    const q1 = db.prepare(`SELECT id FROM requests WHERE user_id = ? ORDER BY created_at LIMIT 1`).get(B.id);
    db.prepare(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL WHERE id = ?`).run(q1.id);   // pas encore partie
    const before = mailsOf(q1.id).length;
    r = await S.call('POST', `/admin/requests/${q1.id}/outcome`, { outcome: 'in_progress' }, ADM);
    assert.equal(r.status, 409, 'refusé avec explication'); assert.ok(r.data.error);
    r = await S.call('POST', '/admin/requests/bulk', { ids: [q1.id, d3.id], outcome: 'action_required' }, ADM);
    assert.equal(r.data.updated, 1); assert.equal(r.data.ignored.length, 1);
    assert.equal(reqRow(q1.id).status, 'queued');
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(q1.id).status, 'sent', 'la demande part normalement'); assert.equal(mailsOf(q1.id).length, before + 1);
  }
  step('réponse tardive ou sans objet : un accusé ne rouvre ni un effacement ni un refus, « en cours » refusé sur une demande non envoyée');

  /* ---------- 4. Stripe : réabonnement, puis événements de l'ancien abonnement ---------- */
  // Le compte était retrouvé par son identifiant client : la fin de l'ancien abonnement (updated « canceled »,
  // deleted, dernière facture impayée) résiliait le nouvel abonnement payé et rétablissait l'ancienne offre.
  {
    const X = await member(S, { subscribe: false, launch: false });
    const u = () => db.prepare('SELECT subscription_status AS status, subscription_ends_at AS ends, stripe_subscription_id AS sub, plan FROM users WHERE id = ?').get(X.id);
    const cust = `cus_reg${seq}`, end = Math.floor(Date.now() / 1000) + 20 * 86400, nowS = Math.floor(Date.now() / 1000);
    const checkout = (sub, plan) => stripeEvent(S, 'checkout.session.completed', { mode: 'subscription', payment_status: 'paid', customer: cust, subscription: sub, client_reference_id: X.id, metadata: { user_id: X.id, plan, billing: 'monthly' } });
    await checkout('sub_old', 'individuel');
    await stripeEvent(S, 'customer.subscription.updated', { id: 'sub_old', customer: cust, status: 'active', cancel_at_period_end: true, cancel_at: end, current_period_end: end, metadata: { user_id: X.id, plan: 'individuel' } });
    assert.equal(u().status, 'canceled', 'résiliation à la fin de la période');
    await checkout('sub_new', 'famille');
    assert.deepEqual({ ...u() }, { status: 'active', ends: null, sub: 'sub_new', plan: 'famille' }, 'réabonnement');
    await stripeEvent(S, 'customer.subscription.updated', { id: 'sub_old', customer: cust, status: 'canceled', ended_at: nowS, metadata: { user_id: X.id, plan: 'individuel' } });
    await stripeEvent(S, 'customer.subscription.deleted', { id: 'sub_old', customer: cust, status: 'canceled', ended_at: nowS, metadata: { user_id: X.id } });
    await stripeEvent(S, 'invoice.payment_failed', { customer: cust, subscription: 'sub_old' });
    assert.deepEqual({ ...u() }, { status: 'active', ends: null, sub: 'sub_new', plan: 'famille' }, 'la fin de l’ancien abonnement ne touche pas au nouveau');
    // Le nouvel abonnement suit son cours normal (format de facture récent : abonnement sous parent.subscription_details).
    await stripeEvent(S, 'invoice.payment_failed', { customer: cust, parent: { subscription_details: { subscription: 'sub_new' } } });
    assert.equal(u().status, 'past_due');
    await stripeEvent(S, 'invoice.paid', { customer: cust, subscription: 'sub_new' });
    assert.equal(u().status, 'active');
    await stripeEvent(S, 'customer.subscription.deleted', { id: 'sub_new', customer: cust, status: 'canceled', ended_at: nowS });
    assert.equal(u().status, 'canceled');
  }
  step('Stripe : la fin d’un ancien abonnement (updated, deleted, facture) ne résilie plus le nouvel abonnement');

  /* ---------- 5. Changement d'offre : limite de personnes et abonnement Stripe en cours ---------- */
  // Passer de Famille à Individuel avec trois profils était accepté : les proches restaient protégés sans être payés.
  // En mode Stripe, « Passer à Famille » sur un abonnement actif renvoyait un 502 générique (« Réessayez… »).
  const ST = await start('stripe', { STRIPE_SECRET_KEY: 'sk_test_regression_dummy' });
  {
    const F = await member(S, { plan: 'famille' });
    const p2 = (await S.call('POST', '/profiles', { first_name: 'Paul', last_name: 'Moreau' }, F.cookie)).data.profile;
    const p3 = (await S.call('POST', '/profiles', { first_name: 'Zoé', last_name: 'Moreau' }, F.cookie)).data.profile;
    let r = await S.call('POST', '/billing/checkout', { plan: 'individuel' }, F.cookie);
    assert.equal(r.status, 409, JSON.stringify(r.data)); assert.match(r.data.error, /3 personnes/); assert.match(r.data.error, /Individuel/);
    assert.equal((await S.call('GET', '/me', undefined, F.cookie)).data.user.plan, 'famille', 'offre inchangée');
    await S.call('DELETE', `/profiles/${p2.id}`, undefined, F.cookie); await S.call('DELETE', `/profiles/${p3.id}`, undefined, F.cookie);
    r = await S.call('POST', '/billing/checkout', { plan: 'individuel' }, F.cookie);
    assert.equal(r.status, 200); assert.equal((await S.call('GET', '/me', undefined, F.cookie)).data.user.plan, 'individuel');
    // Stripe : abonnement actif, changement d'offre → message explicite (aucun appel à Stripe).
    const P = (await ST.call('POST', '/auth/signup', { email: 'stripe-actif@exemple.fr', password: STRONG, plan: 'individuel' }));
    ST.sql().prepare(`UPDATE users SET subscription_status = 'active', billing_mode = 'stripe', plan = 'individuel', stripe_customer_id = 'cus_x', stripe_subscription_id = 'sub_x' WHERE email = 'stripe-actif@exemple.fr'`).run();
    r = await ST.call('POST', '/billing/checkout', { plan: 'famille' }, P.cookie);
    assert.equal(r.status, 409, JSON.stringify(r.data)); assert.match(r.data.error, /déjà actif/);
  }
  step('changement d’offre : Individuel refusé tant que le dossier compte plus d’une personne ; Stripe actif → message explicite (409)');

  /* ---------- 6. Suppression d'un compte : l'abonnement est toujours résilié ---------- */
  // Un abonnement « paiement en attente » n'était pas résilié (Stripe continue de prélever un compte supprimé), et
  // une résiliation Stripe en échec n'empêchait pas la suppression : le client était prélevé sans compte pour l'arrêter.
  {
    const P = await member(S, { launch: false });
    await S.call('POST', `/admin/users/${P.id}/subscription`, { status: 'past_due' }, ADM);
    let r = await S.call('DELETE', '/account', { password: STRONG }, P.cookie);
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(P.id).subscription_status, 'canceled', 'abonnement en attente de paiement résilié');
    const Q = await member(S, { launch: false });
    await S.call('POST', `/admin/users/${Q.id}/subscription`, { status: 'past_due' }, ADM);
    r = await S.call('DELETE', `/admin/users/${Q.id}`, {}, ADM); assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(Q.id).subscription_status, 'canceled');
    // Stripe injoignable ou refus (clé factice) : rien n'est supprimé, l'abonné peut réessayer.
    const T = await ST.call('POST', '/auth/signup', { email: 'stripe-sup@exemple.fr', password: STRONG, plan: 'individuel' });
    ST.sql().prepare(`UPDATE users SET subscription_status = 'past_due', billing_mode = 'stripe', stripe_customer_id = 'cus_y', stripe_subscription_id = 'sub_y' WHERE email = 'stripe-sup@exemple.fr'`).run();
    r = await ST.call('DELETE', '/account', { password: STRONG }, T.cookie);
    assert.equal(r.status, 502, JSON.stringify(r.data)); assert.match(r.data.error, /pas été supprimé/);
    assert.equal((await ST.call('GET', '/me', undefined, T.cookie)).data.user?.email, 'stripe-sup@exemple.fr', 'compte et session intacts');
    const STA = await adminOf(ST);
    r = await ST.call('DELETE', `/admin/users/${T.data.user.id}`, {}, STA);
    assert.equal(r.status, 502); assert.equal(ST.sql().prepare('SELECT deleted_at FROM users WHERE id = ?').get(T.data.user.id).deleted_at, null);
  }
  step('suppression : abonnement en attente de paiement résilié ; échec de la résiliation Stripe → rien n’est supprimé (502)');

  /* ---------- 7. Mandat re-signé : les demandes arrêtées par la révocation repartent ---------- */
  // La re-signature ne relançait rien côté serveur (seul le client appelait /requests/launch, et seulement avec un
  // abonnement « actif ») et les sites ajoutés par l'abonné restaient « refusés » pour toujours.
  {
    const M = await member(S);
    const site = await S.call('POST', '/sites', { url: 'https://annuaire-perso.fr/fiche/lea-moreau' }, M.cookie);
    assert.equal(site.status, 201);
    await settle(S);
    const stopped = db.prepare('SELECT id, broker_id FROM requests WHERE user_id = ? ORDER BY created_at LIMIT 4').all(M.id).concat([{ id: site.data.request_id, broker_id: site.data.broker.id }]);
    for (const x of stopped) db.prepare(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL WHERE id = ?`).run(x.id);
    await S.call('DELETE', '/mandate', undefined, M.cookie);
    for (const x of stopped) { const r = reqRow(x.id); assert.equal(r.status, 'refused'); assert.match(r.note, /^Mandat révoqué/); }
    // Abonnement résilié mais payé jusqu'à une date future : toujours éligible, mais le client ne relance pas.
    await S.call('POST', `/admin/users/${M.id}/subscription`, { status: 'canceled', ends_at: new Date(Date.now() + 10 * 86400000).toISOString() }, ADM);
    const r = await S.call('POST', '/mandate', { full_name: 'Léa Moreau', accepted: true }, M.cookie);
    assert.equal(r.status, 200);
    await S.call('POST', '/admin/tick', {}, ADM);
    for (const x of stopped) {
      const next = db.prepare('SELECT status, cycle, source_url FROM requests WHERE profile_id = ? AND broker_id = ? ORDER BY cycle DESC LIMIT 1').get(M.pid, x.broker_id);
      assert.equal(next.cycle, 2, 'nouveau cycle après re-signature'); assert.equal(next.status, 'sent');
    }
    const relaunchedSite = db.prepare('SELECT id, source_url FROM requests WHERE profile_id = ? AND broker_id = ? AND cycle = 2').get(M.pid, site.data.broker.id);
    assert.equal(relaunchedSite.source_url, 'https://annuaire-perso.fr/fiche/lea-moreau', 'la fiche signalée reste citée');
    assert.match(mailsOf(relaunchedSite.id)[0].body, /annuaire-perso\.fr\/fiche\/lea-moreau/);
  }
  step('mandat re-signé : nouveau cycle pour les demandes arrêtées, sites ajoutés compris (fiche citée), sans dépendre du client');

  /* ---------- 8. Revérification d'un site ajouté : la fiche reste citée ---------- */
  {
    const M = await member(S, { launch: false });
    const site = await S.call('POST', '/sites', { url: 'https://pages-perso.fr/profil/lea' }, M.cookie);
    await S.call('POST', '/admin/tick', {}, ADM);
    await S.call('POST', `/admin/requests/${site.data.request_id}/outcome`, { outcome: 'done' }, ADM);
    db.prepare('UPDATE requests SET next_check_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), site.data.request_id);
    await S.call('POST', '/admin/tick', {}, ADM);   // revérification : nouvelle demande en file
    await S.call('POST', '/admin/tick', {}, ADM);   // envoi au passage suivant
    const next = db.prepare('SELECT id, cycle, status, source_url FROM requests WHERE profile_id = ? AND broker_id = ? ORDER BY cycle DESC LIMIT 1').get(M.pid, site.data.broker.id);
    assert.equal(next.cycle, 2); assert.equal(next.status, 'sent');
    assert.equal(next.source_url, 'https://pages-perso.fr/profil/lea'); assert.match(mailsOf(next.id)[0].body, /pages-perso\.fr\/profil\/lea/);
  }
  step('revérification d’un site ajouté : le nouveau courrier cite toujours l’adresse de la fiche');

  /* ---------- 9. « Renvoyer » (administration) : compteur d'échecs et recul remis à zéro ---------- */
  // Le renvoi gardait attempts et next_attempt_at : une demande en erreur repassait en erreur au premier échec, et une
  // demande en recul attendait la fin du recul au lieu de partir.
  {
    const M = await member(S);
    await settle(S);
    const [x1] = db.prepare(`SELECT id FROM requests WHERE user_id = ? AND status = 'sent' LIMIT 1`).all(M.id);
    db.prepare(`UPDATE requests SET attempts = 3, next_attempt_at = ?, last_error = 'Délai d’envoi dépassé.' WHERE id = ?`).run(new Date(Date.now() + 3600000).toISOString(), x1.id);
    let r = await S.call('POST', `/admin/requests/${x1.id}/resend`, {}, ADM); assert.equal(r.status, 200);
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(x1.id).status, 'sent', 'renvoyée tout de suite'); assert.equal(mailsOf(x1.id, 'Demande%').length, 2);
    // SMTP fermé : une demande en erreur renvoyée a de nouveau droit à tous ses essais.
    const SM = await start('smtp-closed', { SMTP_URL: 'smtp://127.0.0.1:9', ALLOW_UNVERIFIED_CONTACTS: 'true', MAIL_TIMEOUT_MS: '1000' });
    const SMA = await adminOf(SM);
    const N = await member(SM);
    await settle(SM);
    const sdb = SM.sql();
    const e1 = sdb.prepare(`SELECT id FROM requests WHERE user_id = ? LIMIT 1`).get(N.id);
    sdb.prepare(`UPDATE requests SET status = 'error', attempts = 6, next_attempt_at = NULL, last_error = 'refus SMTP' WHERE id = ?`).run(e1.id);
    r = await SM.call('POST', `/admin/requests/${e1.id}/resend`, {}, SMA); assert.equal(r.status, 200);
    await SM.call('POST', '/admin/tick', {}, SMA);
    const row = sdb.prepare('SELECT status, attempts FROM requests WHERE id = ?').get(e1.id);
    assert.equal(row.status, 'queued', 'un échec après renvoi ne repasse pas aussitôt en erreur'); assert.equal(row.attempts, 1);
    sdb.close(); await SM.stop();
  }
  step('renvoi par l’administration : départ immédiat malgré un recul en cours, essais remis à zéro après une erreur');

  /* ---------- 10. Relance : relecture de la demande avant chaque envoi ---------- */
  // followUps envoyait la relance d'après la liste lue au début du passage : une demande effacée pendant le passage
  // (envoi SMTP lent, réponse reçue entre-temps) recevait quand même « Relance — demande sans réponse ».
  {
    const net = await import('node:net');
    const smtp = net.createServer((sock) => {
      let buf = '', data = false;
      sock.write('220 faux-smtp ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (data) {
            const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return;
            const msg = buf.slice(0, end); buf = buf.slice(end + 5); data = false;
            // Objet éventuellement encodé (RFC 2047, Q ou B) et replié sur plusieurs lignes.
            const subj = ((msg.match(/^Subject:(.*(?:\r\n[ \t].*)*)/mi) || [])[1] || '').replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_, enc, txt) => (enc.toLowerCase() === 'b' ? Buffer.from(txt, 'base64').toString('utf8') : txt.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))));
            setTimeout(() => sock.write('250 OK\r\n'), /Relance/.test(subj) ? 1500 : 0);
            continue;
          }
          const i = buf.indexOf('\r\n'); if (i < 0) return;
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-faux-smtp\r\n250 OK\r\n');
          else if (cmd === 'DATA') { data = true; sock.write('354 Suite\r\n'); }
          else if (cmd === 'QUIT') { sock.end('221 Au revoir\r\n'); return; }
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((res) => smtp.listen(0, '127.0.0.1', res));
    const SL = await start('smtp-slow', { SMTP_URL: `smtp://127.0.0.1:${smtp.address().port}`, ALLOW_UNVERIFIED_CONTACTS: 'true' });
    try {
      const SLA = await adminOf(SL);
      const N = await member(SL);
      await settle(SL);
      const sdb = SL.sql();
      const [f1, f2] = sdb.prepare(`SELECT id FROM requests WHERE user_id = ? AND status = 'sent' ORDER BY created_at LIMIT 2`).all(N.id);
      sdb.prepare('UPDATE requests SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86400000).toISOString(), f1.id);
      sdb.prepare('UPDATE requests SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), f2.id);
      const ticking = SL.call('POST', '/admin/tick', {}, SLA);
      await wait(600);   // la relance de f1 est en cours d'envoi (1,5 s)
      const r = await SL.call('POST', `/admin/requests/${f2.id}/outcome`, { outcome: 'done', note: 'confirmé pendant le passage' }, SLA);
      assert.equal(r.status, 200);
      await ticking;
      assert.equal(sdb.prepare(`SELECT COUNT(*) AS c FROM mails WHERE request_id = ? AND subject LIKE 'Relance%'`).get(f1.id).c, 1, 'relance de f1 envoyée');
      assert.equal(sdb.prepare(`SELECT COUNT(*) AS c FROM mails WHERE request_id = ? AND subject LIKE 'Relance%'`).get(f2.id).c, 0, 'aucune relance pour la demande effacée pendant le passage');
      sdb.close();
    } finally { await SL.stop(); smtp.close(); }
  }
  step('relance : la demande est relue avant l’envoi, aucune relance vers un courtier qui vient de confirmer');

  /* ---------- 11. Profil : une mise à jour partielle ne touche pas aux champs absents ---------- */
  // birth_date absent du corps de PUT /profiles/:id effaçait la date de naissance (les autres champs étaient conservés).
  {
    const M = await member(S, { subscribe: false });
    let r = await S.call('PUT', `/profiles/${M.pid}`, { birth_date: '1990-05-01' }, M.cookie); assert.equal(r.data.profile.birth_date, '1990-05-01');
    r = await S.call('PUT', `/profiles/${M.pid}`, { phones: ['+33 6 11 22 33 44'] }, M.cookie);
    assert.equal(r.status, 200); assert.equal(r.data.profile.birth_date, '1990-05-01', 'date conservée'); assert.equal(r.data.profile.first_name, 'Léa');
    r = await S.call('PUT', `/profiles/${M.pid}`, { birth_date: '' }, M.cookie); assert.equal(r.data.profile.birth_date, null, 'effacement explicite');
  }
  step('profil : la date de naissance n’est plus effacée par une mise à jour qui ne la mentionne pas');

  console.log(`✔ Régressions validées (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err.trim()) console.error(`[${s.name}]`, s.err.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((s) => s.stop()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
