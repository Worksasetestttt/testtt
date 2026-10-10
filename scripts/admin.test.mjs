// Test de l'administration : démarre le serveur sur un port libre avec une base temporaire et vérifie le routeur
// /api/admin (autorisations, contrats utilisés par smoke.mjs, comptes, demandes, courtiers, courriers, réponses
// entrantes, contacts, exports CSV, système, journal d'audit) et l'absence de secrets dans les réponses.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-admin-'));
const PORT = 4600 + Math.floor(Math.random() * 300);
const OUTBOX = path.join(tmp, 'outbox');
const SECRET = 'test-secret-for-admin-suite-0123456789';
const env = {
  ...process.env, PORT: String(PORT), DATABASE_PATH: path.join(tmp, 'test.sqlite'), OUTBOX_DIR: OUTBOX, DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  SESSION_SECRET: SECRET, ADMIN_EMAILS: 'admin@test.fr', INBOUND_TOKEN: '', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test',
};
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });
const origin = `http://localhost:${PORT}`;
const base = `${origin}/api`;
const STRONG = 'Corde-a-linge-78!';

async function call(method, p, body, { cookie = '', headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { _text: text }; }
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, data, headers: r.headers, cookie: sc ? sc.split(';')[0] : '', text };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function signup(email, extra = {}) {
  const r = await call('POST', '/auth/signup', { email, password: STRONG, ...extra });
  assert.equal(r.status, 201, `inscription ${email} : ${JSON.stringify(r.data)}`);
  return { cookie: r.cookie, user: r.data.user };
}
const noSecrets = (obj, label) => {
  const s = JSON.stringify(obj);
  for (const bad of ['password_hash', 'stripe_customer_id', 'stripe_subscription_id', 'mandate_ip', 'scrypt$', SECRET]) assert.ok(!s.includes(bad), `${label} : fuite de ${bad}`);
};
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }

  /* ---------- Préparation : un administrateur, un abonné actif avec demandes, un compte sans abonnement ---------- */
  const admin = await signup('admin@test.fr');
  assert.equal(admin.user.role, 'admin');
  const A = await signup('alice@exemple.fr', { plan: 'famille', billing: 'annual' });
  const B = await signup('bruno@exemple.fr', { plan: 'individuel' });
  const AC = { cookie: A.cookie }, AD = { cookie: admin.cookie }, BC = { cookie: B.cookie };
  let r = await call('GET', '/me', undefined, AC);
  r = await call('PUT', `/profiles/${r.data.profiles[0].id}`, { first_name: 'Alice', last_name: 'Martin', emails: ['alice@exemple.fr'] }, AC); assert.equal(r.status, 200);
  r = await call('POST', '/mandate', { full_name: 'Alice Martin', accepted: true }, AC); assert.equal(r.status, 200);
  r = await call('POST', '/billing/checkout', { plan: 'famille', billing: 'annual' }, AC); assert.equal(r.status, 400, 'formule unique : plus d’offre annuelle');
  r = await call('POST', '/billing/checkout', { plan: 'famille' }, AC); assert.equal(r.data.mode, 'simulated');
  r = await call('POST', '/requests/launch', {}, AC); assert.ok(r.data.created >= 50, JSON.stringify(r.data));
  await call('POST', '/contact', { email: 'prospect@exemple.fr', subject: 'Question', message: '=HYPERLINK("http://x") couvrez-vous la Belgique ?' });
  await call('POST', '/newsletter', { email: 'lettre@exemple.fr' });
  await wait(1200); // premier passage du planificateur : envoi des demandes

  /* ---------- 1. Autorisations ---------- */
  const GETS = ['/admin/stats', '/admin/users', '/admin/requests', '/admin/brokers', '/admin/mails', '/admin/contacts', '/admin/newsletter', '/admin/system', '/admin/audit', '/admin/export.csv?what=users'];
  for (const p of GETS) {
    assert.equal((await call('GET', p)).status, 401, `anonyme ${p}`);
    assert.equal((await call('GET', p, undefined, BC)).status, 403, `abonné ${p}`);
    assert.equal((await call('GET', p, undefined, AD)).status, p.includes('export') ? 200 : 200, `admin ${p}`);
  }
  for (const [m, p] of [['POST', '/admin/tick'], ['POST', '/admin/brokers'], ['PUT', '/admin/brokers/1'], ['POST', '/admin/requests/bulk'], ['DELETE', `/admin/users/${A.user.id}`]]) {
    assert.equal((await call(m, p, {}, BC)).status, 403, `abonné ${m} ${p}`);
  }
  r = await call('POST', '/admin/tick', {}, { ...AD, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403, 'CSRF : origine étrangère refusée sur /admin');
  step('autorisations : anonyme → 401, abonné → 403 (lecture et écriture), administrateur → 200 ; CSRF refusé');

  /* ---------- 2. Vue d'ensemble (contrat de smoke.mjs) ---------- */
  r = await call('POST', '/admin/tick', {}, AD); assert.equal(r.status, 200); assert.ok(r.data.at);
  r = await call('GET', '/admin/stats', undefined, AD);
  const s = r.data;
  assert.equal(typeof s.users, 'number'); assert.equal(s.users, 3); assert.equal(s.active, 1); assert.equal(typeof s.mails, 'number');
  assert.ok(Array.isArray(s.requests) && s.requests.every((x) => typeof x.status === 'string' && typeof x.n === 'number'));
  assert.ok(Array.isArray(s.action_required));
  assert.equal(s.mrr_cents, 999, 'MRR : un abonnement Famille à 9,99 €');
  assert.equal(s.signups_by_day.length, 14); assert.equal(s.mails_by_day.length, 14);
  assert.equal(s.signups_by_day.at(-1).n, 3, 'trois inscriptions aujourd’hui');
  assert.ok(s.brokers.total >= 50 && s.brokers.verified === 0);
  assert.ok(s.scheduler.last_tick_at && s.scheduler.last_manual_tick_at, 'dates du planificateur exposées');
  assert.equal(s.contacts_open, 1); assert.equal(s.newsletter, 1);
  step('vue d’ensemble : champs attendus par smoke.mjs + MRR, séries sur 14 jours, planificateur');

  /* ---------- 3. Comptes ---------- */
  r = await call('GET', '/admin/users?q=alice', undefined, AD);
  assert.equal(r.data.total, 1); assert.equal(r.data.users[0].email, 'alice@exemple.fr'); assert.equal(r.data.users[0].name, 'Alice Martin');
  assert.ok(r.data.users[0].requests_n >= 50); noSecrets(r.data, '/admin/users');
  r = await call('GET', '/admin/users?q=%25', undefined, AD); assert.equal(r.data.total, 0, 'le joker % est échappé');
  r = await call('GET', '/admin/users?per=1000', undefined, AD); assert.equal(r.data.per, 100, 'pagination plafonnée');
  r = await call('GET', '/admin/users?status=active', undefined, AD); assert.equal(r.data.total, 1); assert.equal(r.data.counts.all, 3); assert.equal(r.data.counts.admin, 1);
  r = await call('GET', `/admin/users/${A.user.id}`, undefined, AD);
  assert.equal(r.status, 200); assert.equal(r.data.profiles.length, 1); assert.ok(r.data.requests.length > 0); assert.ok(r.data.sessions_n >= 1); noSecrets(r.data, '/admin/users/:id');
  assert.equal((await call('GET', '/admin/users/pas-un-uuid', undefined, AD)).status, 404);
  step('comptes : recherche, joker échappé, pagination plafonnée, filtres avec compteurs, fiche sans secret');

  r = await call('POST', `/admin/users/${admin.user.id}/role`, { role: 'user' }, AD); assert.equal(r.status, 400, 'pas de changement de son propre rôle');
  r = await call('POST', `/admin/users/${B.user.id}/role`, { role: 'superuser' }, AD); assert.equal(r.status, 400);
  r = await call('POST', `/admin/users/${B.user.id}/role`, { role: 'admin' }, AD); assert.equal(r.data.user.role, 'admin');
  assert.equal((await call('GET', '/admin/stats', undefined, BC)).status, 200, 'promotion effective immédiatement');
  r = await call('POST', `/admin/users/${B.user.id}/role`, { role: 'user' }, AD); assert.equal(r.data.user.role, 'user');
  assert.equal((await call('GET', '/admin/stats', undefined, BC)).status, 403);
  step('rôles : promotion et rétrogradation effectives, propre rôle et rôle inconnu refusés');

  r = await call('POST', `/admin/users/${B.user.id}/subscription`, { status: 'gratuit' }, AD); assert.equal(r.status, 400);
  r = await call('POST', `/admin/users/${B.user.id}/subscription`, { status: 'active', plan: 'famille', billing: 'monthly', note: 'geste commercial' }, AD);
  assert.equal(r.status, 200); assert.equal(r.data.user.subscription_status, 'active'); assert.equal(r.data.user.billing_mode, 'manual');
  r = await call('POST', `/admin/users/${B.user.id}/subscription`, { status: 'canceled', ends_at: '2031-12-31' }, AD);
  assert.equal(r.data.user.subscription_status, 'canceled'); assert.ok(r.data.user.subscription_ends_at.startsWith('2031-12-31'));
  r = await call('POST', `/admin/users/${B.user.id}/subscription`, { status: 'canceled', ends_at: 'demain' }, AD); assert.equal(r.status, 400);
  r = await call('GET', '/dashboard', undefined, BC); assert.ok(r.data.events.some((e) => /résilié par l’équipe/.test(e.message)), 'l’abonné voit l’action dans son journal');
  step('abonnement : activation manuelle, résiliation datée, valeurs invalides refusées, trace côté abonné');

  const A2 = (await call('POST', '/auth/login', { email: 'alice@exemple.fr', password: STRONG })).cookie;
  r = await call('POST', `/admin/users/${A.user.id}/logout-all`, {}, AD); assert.ok(r.data.sessions >= 2);
  r = await call('GET', '/me', undefined, { cookie: A2 }); assert.equal(r.data.user, null, 'sessions de l’abonné fermées');
  const AL = { cookie: (await call('POST', '/auth/login', { email: 'alice@exemple.fr', password: STRONG })).cookie };
  r = await call('POST', `/admin/users/${A.user.id}/launch`, {}, AD); assert.equal(r.status, 200); assert.equal(r.data.created, 0, 'rien à relancer : toutes les demandes existent déjà');
  step('sessions : déconnexion de tous les appareils ; lancement idempotent');

  /* ---------- 4. Demandes ---------- */
  r = await call('GET', '/admin/requests?status=sent&per=5&sort=due_asc', undefined, AD);
  assert.equal(r.status, 200); assert.equal(r.data.requests.length, 5); assert.ok(r.data.requests.every((x) => x.status === 'sent')); assert.equal(r.data.sort, 'due_asc');
  const [r1, r2, r3] = r.data.requests;
  r = await call('GET', `/admin/requests?q=${r1.ref}`, undefined, AD); assert.equal(r.data.total, 1, 'recherche par référence OUBLI-…');
  r = await call('GET', '/admin/requests?sort=1;DROP', undefined, AD); assert.equal(r.data.sort, 'created_desc', 'tri inconnu ignoré');
  r = await call('GET', '/admin/requests?status=error', undefined, AD); assert.equal(r.status, 200); assert.equal(r.data.total, 0);
  r = await call('GET', `/admin/requests/${r1.ref}`, undefined, AD); assert.equal(r.data.request.id, r1.id, 'détail par référence');
  assert.ok(r.data.mails.length >= 1 && r.data.broker.contact_email);
  r = await call('POST', `/admin/requests/${r1.id}/outcome`, { outcome: 'effacé' }, AD); assert.equal(r.status, 400);
  r = await call('POST', `/admin/requests/${r1.id}/outcome`, { outcome: 'done', note: 'confirmé par téléphone' }, AD); assert.equal(r.data.request.status, 'done');
  r = await call('GET', `/admin/requests/${r1.id}`, undefined, AD); assert.ok(r.data.request.next_check_at, 'revérification programmée'); assert.equal(r.data.audit[0].action, 'request.outcome');
  r = await call('POST', `/admin/requests/${r1.id}/resend`, {}, AD); assert.equal(r.data.request.status, 'queued');
  r = await call('POST', '/admin/requests/bulk', { ids: [], outcome: 'done' }, AD); assert.equal(r.status, 400);
  r = await call('POST', '/admin/requests/bulk', { ids: Array.from({ length: 101 }, () => r2.id), outcome: 'done' }, AD); assert.equal(r.status, 400);
  r = await call('POST', '/admin/requests/bulk', { ids: [r2.id, r3.ref, 'OUBLI-0000000000'], outcome: 'action_required', note: 'pièce demandée' }, AD);
  assert.equal(r.data.updated, 2); assert.deepEqual(r.data.missing, ['OUBLI-0000000000']);
  r = await call('GET', '/dashboard', undefined, AL); assert.equal(r.data.counters.action_required, 2, 'l’abonné voit les vérifications demandées');
  r = await call('GET', '/admin/stats', undefined, AD); assert.equal(r.data.action_required.length, 2);
  step('demandes : filtres, tri borné, recherche par référence, réponse, renvoi, réponses groupées (introuvables signalées)');

  /* ---------- 5. Courtiers ---------- */
  r = await call('GET', '/admin/brokers', undefined, AD);
  const fr = r.data.brokers.find((b) => b.jurisdiction === 'FR');
  assert.ok(fr, 'le registre contient un courtier français'); assert.ok(r.data.jurisdictions.includes('FR'));
  r = await call('PUT', `/admin/brokers/${fr.id}`, { ...fr, recheck_days: 75 }, AD);
  assert.equal(r.status, 200, `édition complète d’un courtier FR : ${JSON.stringify(r.data)}`); assert.equal(r.data.broker.recheck_days, 75);
  r = await call('PUT', `/admin/brokers/${fr.id}`, { contact_verified: true }, AD); assert.equal(r.data.broker.contact_verified, 1);
  r = await call('PUT', `/admin/brokers/${fr.id}`, { contact_email: 'nouveau-dpo@exemple.fr' }, AD); assert.equal(r.data.broker.contact_verified, 0, 'nouvelle adresse : vérification retirée');
  r = await call('PUT', `/admin/brokers/${fr.id}`, { contact_email: 'dpo@exemple.fr', contact_verified: true }, AD); assert.equal(r.data.broker.contact_verified, 1, 'sauf confirmation explicite');
  r = await call('PUT', `/admin/brokers/${fr.id}`, { jurisdiction: 'ZZ' }, AD); assert.equal(r.status, 400);
  const nb = { slug: 'annuaire-test', name: 'Annuaire Test', domain: 'https://annuaire-test.fr/contact', category: 'Annuaire', jurisdiction: 'FR', legal_basis: 'rgpd', sensitivity: 2, recheck_days: 60, contact_email: 'privacy@annuaire-test.fr' };
  r = await call('POST', '/admin/brokers', { ...nb, slug: 'Pas Un Slug' }, AD); assert.equal(r.status, 400);
  r = await call('POST', '/admin/brokers', nb, AD); assert.equal(r.status, 201); assert.equal(r.data.broker.domain, 'annuaire-test.fr', 'domaine normalisé'); assert.equal(r.data.broker.contact_verified, 0);
  const newId = r.data.broker.id;
  r = await call('POST', '/admin/brokers', nb, AD); assert.equal(r.status, 409, 'slug unique');
  const before = fs.readdirSync(OUTBOX).length;
  r = await call('POST', `/admin/brokers/${newId}/test-mail`, {}, AD); assert.equal(r.data.mode, 'outbox'); assert.match(r.data.ref, /^OUBLI-TEST-/);
  assert.equal(fs.readdirSync(OUTBOX).length, before + 1, 'courrier de test écrit dans la boîte d’envoi');
  r = await call('DELETE', `/admin/brokers/${newId}`, {}, AD); assert.equal(r.data.broker.active, 0);
  r = await call('GET', '/brokers'); assert.ok(!JSON.stringify(r.data).includes('privacy@annuaire-test.fr'), 'registre public sans adresse de contact');
  step('courtiers : édition d’un courtier FR, vérification retirée au changement d’adresse, création, slug unique, test, désactivation');

  /* ---------- 6. Courriers ---------- */
  r = await call('GET', `/admin/mails?request=${r1.id}`, undefined, AD); assert.ok(r.data.total >= 1); assert.equal(r.data.mails[0].ref, r1.ref);
  r = await call('GET', '/admin/mails?mode=outbox&per=2', undefined, AD); assert.equal(r.data.mails.length, 2); assert.ok(r.data.modes.outbox > 2);
  const mid = r.data.mails[0].id;
  r = await call('GET', `/admin/mails/${mid}`, undefined, AD); assert.ok(r.data.mail.body.length > 20);
  assert.equal((await call('GET', '/admin/mails/abc', undefined, AD)).status, 404);
  step('courriers : filtres par demande et par mode, lecture du contenu, identifiant invalide → 404');

  /* ---------- 7. Réponses entrantes (qualification sans enregistrement) ---------- */
  r = await call('POST', '/admin/inbound/simulate', { subject: `Re: ${r2.ref}`, text: 'Your data has been deleted.' }, AD);
  assert.equal(r.data.matched, true); assert.equal(r.data.outcome, 'done'); assert.equal(r.data.request.id, r2.id);
  r = await call('GET', `/admin/requests/${r2.id}`, undefined, AD); assert.equal(r.data.request.status, 'action_required', 'l’analyse n’enregistre rien');
  r = await call('POST', '/admin/inbound/simulate', { token: r3.ref.toLowerCase(), text: 'Please confirm your identity.' }, AD); assert.equal(r.data.outcome, 'action_required');
  r = await call('POST', '/admin/inbound/simulate', { text: 'Bonjour, sans référence.' }, AD); assert.equal(r.data.matched, false);
  r = await call('POST', '/admin/inbound/simulate', { text: 'Re: OUBLI-ABCDEF0123' }, AD); assert.equal(r.data.matched, false); assert.match(r.data.reason, /inconnue/);
  step('réponses entrantes : rattachement par référence (objet ou champ), classification, aucune écriture');

  /* ---------- 8. Contacts, lettre d'information, exports CSV ---------- */
  r = await call('GET', '/admin/contacts?status=open', undefined, AD); assert.equal(r.data.total, 1);
  const cid = r.data.contacts[0].id;
  r = await call('POST', `/admin/contacts/${cid}/handled`, {}, AD); assert.ok(r.data.contact.handled_at);
  r = await call('GET', '/admin/contacts?status=open', undefined, AD); assert.equal(r.data.total, 0); assert.equal(r.data.counts.handled, 1);
  r = await call('POST', `/admin/contacts/${cid}/handled`, { handled: false }, AD); assert.equal(r.data.contact.handled_at, null);
  r = await call('GET', '/admin/newsletter', undefined, AD); assert.equal(r.data.subscribers[0].email, 'lettre@exemple.fr');
  r = await call('GET', '/admin/export.csv?what=users', undefined, AD);
  assert.match(r.headers.get('content-type'), /^text\/csv/); assert.match(r.headers.get('content-disposition'), /oubli-users-\d{4}-\d{2}-\d{2}\.csv/);
  const raw = Buffer.from(await (await fetch(`${base}/admin/export.csv?what=users`, { headers: { cookie: admin.cookie } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM UTF-8 (Excel)'); assert.ok(r.text.startsWith('id,email,role'), 'en-têtes'); assert.ok(!r.text.includes('password_hash') && !r.text.includes('scrypt$'));
  r = await call('GET', '/admin/export.csv?what=contacts', undefined, AD); assert.ok(r.text.includes(`"'=HYPERLINK(""http://x"") couvrez-vous la Belgique ?"`), 'formule neutralisée');
  assert.equal((await call('GET', '/admin/export.csv?what=sessions', undefined, AD)).status, 400);
  step('contacts : traité / rouvert ; lettre d’information ; CSV (BOM, sans secret, injection de formule neutralisée)');

  /* ---------- 9. Système ---------- */
  r = await call('GET', '/admin/system', undefined, AD);
  assert.equal(r.data.env.SESSION_SECRET, true); assert.equal(r.data.env.SMTP_URL, false); noSecrets(r.data, '/admin/system');
  assert.ok(Object.values(r.data.env).every((v) => typeof v === 'boolean'), 'présence seulement, jamais la valeur');
  assert.equal(r.data.modes.mail, 'outbox'); assert.ok(r.data.scheduler.last_tick_at); assert.ok(r.data.counts.requests > 0);
  step('système : variables d’environnement en présence seulement, modes, planificateur, volumes');

  /* ---------- 10. Suspension, liste de blocage, pause du planificateur ---------- */
  const C = await signup('chloe@exemple.fr');
  assert.equal((await call('POST', `/admin/users/${C.user.id}/suspend`, { reason: '' }, AD)).status, 400, 'motif obligatoire');
  assert.equal((await call('POST', `/admin/users/${admin.user.id}/suspend`, { reason: 'test' }, AD)).status, 400, 'pas d’auto-suspension');
  await call('POST', `/admin/users/${B.user.id}/role`, { role: 'admin' }, AD);
  assert.equal((await call('POST', `/admin/users/${B.user.id}/suspend`, { reason: 'test' }, AD)).status, 400, 'un administrateur se rétrograde d’abord');
  await call('POST', `/admin/users/${B.user.id}/role`, { role: 'user' }, AD);
  assert.equal((await call('POST', `/admin/users/${C.user.id}/suspend`, { reason: 'fraude', until: '2000-01-01' }, AD)).status, 400, 'date de fin passée refusée');
  r = await call('POST', `/admin/users/${C.user.id}/suspend`, { reason: 'fraude au paiement', block_email: true }, AD);
  assert.equal(r.status, 200); assert.equal(r.data.user.suspended, true); assert.ok(r.data.sessions >= 1);
  assert.equal((await call('GET', '/me', undefined, { cookie: C.cookie })).data.user, null, 'sessions du compte suspendu fermées');
  r = await call('POST', '/auth/login', { email: 'chloe@exemple.fr', password: STRONG }); assert.equal(r.status, 403); assert.match(r.data.error, /suspendu/);
  r = await call('POST', '/auth/login', { email: 'chloe@exemple.fr', password: 'Mauvais-mot-de-passe-1' }); assert.equal(r.status, 401, 'suspension jamais révélée sans le bon mot de passe');
  r = await call('GET', '/admin/users?status=suspended', undefined, AD); assert.equal(r.data.total, 1); assert.equal(r.data.counts.suspended, 1);
  r = await call('GET', '/admin/security', undefined, AD); assert.equal(r.data.suspended[0].email, 'chloe@exemple.fr'); assert.ok(r.data.blocklist.some((b) => b.pattern === 'chloe@exemple.fr'));
  assert.equal((await call('POST', '/auth/signup', { email: 'Chloe@Exemple.fr', password: STRONG })).status, 403, 'adresse bloquée à l’inscription');
  assert.equal((await call('POST', '/admin/blocklist', { pattern: 'spam' }, AD)).status, 400);
  r = await call('POST', '/admin/blocklist', { pattern: '@Spam.example', reason: 'robots' }, AD); assert.equal(r.status, 201); const blockId = r.data.entry.id;
  assert.equal((await call('POST', '/admin/blocklist', { pattern: '@spam.example' }, AD)).status, 409);
  assert.equal((await call('POST', '/auth/signup', { email: 'robot@spam.example', password: STRONG })).status, 403, 'domaine bloqué');
  assert.equal((await call('DELETE', `/admin/blocklist/${blockId}`, {}, AD)).status, 200);
  assert.equal((await call('POST', '/auth/signup', { email: 'robot@spam.example', password: STRONG })).status, 201, 'domaine débloqué');
  r = await call('POST', `/admin/users/${C.user.id}/unsuspend`, {}, AD); assert.equal(r.data.user.suspended, false);
  assert.equal((await call('POST', '/auth/login', { email: 'chloe@exemple.fr', password: STRONG })).status, 200, 'connexion rétablie');
  // Planificateur : une demande en file d'un compte suspendu ne part pas ; elle part après la réactivation.
  r = await call('POST', `/admin/users/${A.user.id}/suspend`, { reason: 'vérification d’identité' }, AD); assert.equal(r.status, 200);
  assert.equal((await call('POST', `/admin/requests/${r1.id}/resend`, {}, AD)).data.request.status, 'queued');
  await wait(300); await call('POST', '/admin/tick', {}, AD);
  assert.equal((await call('GET', `/admin/requests/${r1.id}`, undefined, AD)).data.request.status, 'queued', 'aucun envoi pendant la suspension');
  await call('POST', `/admin/users/${A.user.id}/unsuspend`, {}, AD); await call('POST', '/admin/tick', {}, AD);
  assert.equal((await call('GET', `/admin/requests/${r1.id}`, undefined, AD)).data.request.status, 'sent', 'envoi repris après réactivation');
  step('suspension : motif, date, sessions fermées, connexion refusée sans oracle, envois en pause ; liste de blocage (adresse, domaine)');

  /* ---------- 11. Accès support en lecture seule ---------- */
  assert.equal((await call('POST', `/admin/users/${A.user.id}/impersonate`, {}, AD)).status, 400, 'motif obligatoire');
  assert.equal((await call('POST', `/admin/users/${admin.user.id}/impersonate`, { reason: 'test' }, AD)).status, 400);
  await call('POST', `/admin/users/${B.user.id}/role`, { role: 'admin' }, AD);
  assert.equal((await call('POST', `/admin/users/${B.user.id}/impersonate`, { reason: 'test' }, AD)).status, 400, 'jamais sur un autre administrateur');
  await call('POST', `/admin/users/${B.user.id}/role`, { role: 'user' }, AD);
  r = await call('POST', `/admin/users/${A.user.id}/impersonate`, { reason: 'ticket 42' }, AD);
  assert.equal(r.status, 200); assert.ok(r.cookie && r.cookie !== admin.cookie);
  assert.ok(Date.parse(r.data.expires_at) - Date.now() <= 30 * 60000 + 2000, 'trente minutes au plus');
  const S = { cookie: r.cookie };
  r = await call('GET', '/me', undefined, S); assert.equal(r.data.user.email, 'alice@exemple.fr'); assert.equal(r.data.impersonation.admin_email, 'admin@test.fr');
  r = await call('GET', '/dashboard', undefined, S); assert.equal(r.status, 200); assert.ok(r.data.events.some((e) => /Accès support/.test(e.message)), 'l’abonné voit l’accès dans son journal');
  const pidA = r.data.profiles[0].id;
  for (const [m, p, b] of [['PUT', `/profiles/${pidA}`, { first_name: 'X' }], ['POST', '/auth/password', { current: STRONG, next: 'Autre-mot-de-passe-9' }], ['POST', '/mandate', { full_name: 'Alice Martin', accepted: true }], ['DELETE', '/mandate', {}], ['POST', '/billing/cancel', {}], ['DELETE', '/account', { password: STRONG }], ['POST', '/auth/logout-all', {}]]) {
    r = await call(m, p, b, S); assert.equal(r.status, 403, `lecture seule : ${m} ${p}`); assert.match(r.data.error, /lecture seule/);
  }
  assert.equal((await call('GET', '/export', undefined, S)).status, 403, 'export complet réservé à l’administration');
  assert.equal((await call('GET', '/admin/stats', undefined, S)).status, 403, 'pas de droits admin pendant l’accès');
  r = await call('GET', `/admin/users/${A.user.id}`, undefined, AD); assert.ok(r.data.sessions.some((x) => x.support_by === 'admin@test.fr'));
  r = await call('POST', '/auth/impersonate/stop', {}, S); assert.equal(r.data.admin, true);
  assert.equal((await call('GET', '/me', undefined, { cookie: r.cookie })).data.user.role, 'admin', 'retour à la session administrateur');
  assert.equal((await call('GET', '/me', undefined, S)).data.user, null, 'session support fermée');
  r = await call('POST', `/admin/users/${A.user.id}/impersonate`, { reason: 'ticket 43' }, AD);
  r = await call('POST', '/auth/logout', {}, { cookie: r.cookie }); assert.equal(r.data.admin, true, 'se déconnecter ramène à l’administration');
  assert.equal((await call('GET', '/admin/stats', undefined, AD)).status, 200, 'session administrateur intacte');
  step('accès support : motif, 30 min, jamais sur un admin, lecture seule (7 actions refusées, export exclu), retour à l’admin, trace côté abonné');

  /* ---------- 12. Sessions, notes, message, adresse, export, annonce ---------- */
  const A3 = (await call('POST', '/auth/login', { email: 'alice@exemple.fr', password: STRONG })).cookie;
  r = await call('GET', `/admin/users/${A.user.id}`, undefined, AD);
  const rawId = A3.split('=')[1].split('.')[0];
  assert.ok(!JSON.stringify(r.data).includes(rawId), 'identifiant de session jamais exposé'); assert.ok(r.data.sessions.every((x) => /^[A-Za-z0-9_-]{16}$/.test(x.handle) && !('id' in x)));
  const target = r.data.sessions[0];
  assert.equal((await call('DELETE', `/admin/users/${A.user.id}/sessions/${target.handle}`, {}, AD)).status, 200);
  assert.equal((await call('GET', '/me', undefined, { cookie: A3 })).data.user, null, 'session fermée');
  assert.equal((await call('DELETE', `/admin/users/${A.user.id}/sessions/${target.handle}`, {}, AD)).status, 404);
  assert.equal((await call('POST', `/admin/users/${A.user.id}/notes`, { body: ' ' }, AD)).status, 400);
  r = await call('POST', `/admin/users/${A.user.id}/notes`, { body: 'Appel le 10/10 : souhaite ajouter son conjoint.' }, AD); assert.equal(r.status, 201);
  const noteId = r.data.note.id;
  assert.equal((await call('GET', `/admin/users/${A.user.id}`, undefined, AD)).data.notes[0].admin_email, 'admin@test.fr');
  assert.equal((await call('DELETE', `/admin/notes/${noteId}`, {}, AD)).status, 200);
  r = await call('POST', `/admin/users/${A.user.id}/message`, { subject: 'Suivi de votre demande Acxiom', body: 'Bonjour Alice, votre demande chez Acxiom est confirmée.' }, AD); assert.equal(r.data.mode, 'outbox');
  r = await call('GET', `/admin/mails?user=${A.user.id}&q=Suivi de votre demande`, undefined, AD); assert.equal(r.data.total, 1);
  assert.equal((await call('POST', `/admin/users/${A.user.id}/email`, { email: 'chloe@exemple.fr' }, AD)).status, 400, 'adresse bloquée');
  assert.equal((await call('POST', `/admin/users/${A.user.id}/email`, { email: 'bruno@exemple.fr' }, AD)).status, 409, 'adresse déjà prise');
  r = await call('POST', `/admin/users/${A.user.id}/email`, { email: 'Alice.Martin@exemple.fr' }, AD); assert.equal(r.data.user.email, 'alice.martin@exemple.fr');
  assert.equal((await call('POST', '/auth/login', { email: 'alice.martin@exemple.fr', password: STRONG })).status, 200, 'connexion avec la nouvelle adresse');
  await wait(100);
  r = await call('GET', `/admin/mails?q=${encodeURIComponent('adresse de connexion')}`, undefined, AD); assert.equal(r.data.mails[0].to_addr, 'alice@exemple.fr', 'ancienne adresse prévenue');
  r = await call('GET', `/admin/users/${A.user.id}/export`, undefined, AD);
  assert.match(r.headers.get('content-disposition'), /attachment/); assert.ok(r.data.requests.length >= 50); noSecrets(r.data, '/admin/users/:id/export');
  assert.equal((await call('PUT', '/admin/announcement', { text: '' }, AD)).status, 400);
  r = await call('PUT', '/admin/announcement', { text: 'Maintenance ce soir de 22 h à 23 h.', level: 'warn' }, AD); assert.equal(r.data.announcement.level, 'warn');
  assert.equal((await call('GET', '/config')).data.announcement.text, 'Maintenance ce soir de 22 h à 23 h.');
  await call('DELETE', '/admin/announcement', {}, AD); assert.equal((await call('GET', '/config')).data.announcement, null);
  step('sessions (poignées sans identifiant, fermeture), notes, message, changement d’adresse (ancienne prévenue), export par l’admin, annonce');

  /* ---------- 13. Suppression d'un compte et journal d'audit ---------- */
  assert.equal((await call('DELETE', `/admin/users/${admin.user.id}`, {}, AD)).status, 400, 'pas d’auto-suppression depuis l’administration');
  r = await call('DELETE', `/admin/users/${B.user.id}`, { reason: 'demande écrite' }, AD); assert.equal(r.status, 200);
  r = await call('GET', '/me', undefined, BC); assert.equal(r.data.user, null, 'sessions du compte supprimé détruites');
  assert.equal((await call('POST', '/auth/login', { email: 'bruno@exemple.fr', password: STRONG })).status, 401);
  assert.equal((await call('DELETE', `/admin/users/${B.user.id}`, {}, AD)).status, 400, 'déjà supprimé');
  r = await call('GET', '/admin/audit?per=100', undefined, AD);
  const actions = new Set(r.data.entries.map((e) => e.action));
  for (const a of ['system.tick', 'user.role', 'user.subscription', 'user.logout_all', 'user.launch', 'request.outcome', 'request.resend', 'request.bulk', 'broker.update', 'broker.create', 'broker.test_mail', 'broker.deactivate', 'contact.handled', 'export.csv', 'user.delete', 'user.suspend', 'user.unsuspend', 'blocklist.add', 'blocklist.remove', 'user.impersonate', 'user.impersonate_stop', 'user.session_revoke', 'user.note', 'note.delete', 'user.message', 'user.email', 'user.export', 'settings.announcement']) assert.ok(actions.has(a), `audit : ${a}`);
  assert.ok(r.data.entries.every((e) => e.admin_email === 'admin@test.fr' && e.created_at));
  r = await call('GET', '/admin/audit?action=broker.', undefined, AD); assert.ok(r.data.entries.length >= 4 && r.data.entries.every((e) => e.action.startsWith('broker.')));
  r = await call('GET', `/admin/audit?target=${B.user.id}`, undefined, AD); assert.ok(r.data.entries.some((e) => e.action === 'user.delete' && e.details.reason === 'demande écrite'));
  step('suppression : sessions détruites, connexion impossible ; audit complet, attribué, filtrable par action et par cible');

  console.log(`✔ Administration validée (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr.trim()) console.error(serverErr.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000).unref(); });   // attendre l'arrêt : le serveur peut encore écrire dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
