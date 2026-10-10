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
    await S.call('POST', '/admin/tick', {}, ADM);
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
    await S.call('POST', '/admin/tick', {}, ADM);
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
    const B = await member(S, { launch: false });
    await S.call('POST', '/requests/launch', {}, B.cookie);
    const q1 = db.prepare(`SELECT id FROM requests WHERE user_id = ? ORDER BY created_at LIMIT 1`).get(B.id);
    db.prepare(`UPDATE requests SET status = 'queued', sent_at = NULL, due_at = NULL WHERE id = ?`).run(q1.id);
    r = await S.call('POST', `/admin/requests/${q1.id}/outcome`, { outcome: 'in_progress' }, ADM);
    assert.equal(r.status, 409, 'refusé avec explication'); assert.ok(r.data.error);
    r = await S.call('POST', '/admin/requests/bulk', { ids: [q1.id, d3.id], outcome: 'action_required' }, ADM);
    assert.equal(r.data.updated, 1); assert.equal(r.data.ignored.length, 1);
    assert.equal(reqRow(q1.id).status, 'queued');
    await S.call('POST', '/admin/tick', {}, ADM);
    assert.equal(reqRow(q1.id).status, 'sent', 'la demande part normalement'); assert.equal(mailsOf(q1.id).length, 1);
  }
  step('réponse tardive ou sans objet : un accusé ne rouvre ni un effacement ni un refus, « en cours » refusé sur une demande non envoyée');

  console.log(`✔ Régressions validées (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err.trim()) console.error(`[${s.name}]`, s.err.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((s) => s.stop()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
