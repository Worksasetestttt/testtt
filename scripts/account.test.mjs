// Test des fonctions de compte : mot de passe oublié (réponse neutre, jeton jamais stocké en clair, expiration, usage
// unique, remplacement, sessions fermées, limitation de débit, politique de mot de passe, comptes suspendus, bloqués ou
// supprimés) et appareils connectés (liste sans identifiant de session, révocation cloisonnée, « déconnecter les autres
// appareils », accès support en lecture seule), adresses acceptées à l'inscription. Serveur sur un port libre, base et
// boîte d'envoi temporaires.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-account-'));
const PORT = await freePort();
const DB = path.join(tmp, 'test.sqlite'), OUTBOX = path.join(tmp, 'outbox');
// TRUST_PROXY=1 : chaque appel peut se présenter avec sa propre IP (X-Forwarded-For), pour tester les limites par IP
// et par adresse séparément.
const env = {
  ...process.env, PORT: String(PORT), DATABASE_PATH: DB, OUTBOX_DIR: OUTBOX, DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  SESSION_SECRET: 'test-secret-for-account-suite-0123456789', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test',
  SITE_DISCOVERY: 'off', TRUST_PROXY: '1', APP_URL: 'https://oubli.test',
};
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '', serverErr = '';
server.stdout.on('data', (x) => { serverOut += x; });
server.stderr.on('data', (x) => { serverErr += x; });
const base = `http://localhost:${PORT}/api`, STRONG = 'Corde-a-linge-78!', NEW_PW = 'Nouveau-mot-2-passe!';
const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
};
let ipSeq = 0;
const freshIp = () => { ipSeq += 1; return `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; };

async function call(method, p, body, { cookie = '', ip = freshIp(), ua = '' } = {}) {
  const h = { 'x-forwarded-for': ip };
  if (cookie) h.cookie = cookie;
  if (ua) h['user-agent'] = ua;
  if (body !== undefined) h['content-type'] = 'application/json';
  const t0 = performance.now();
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(), ms = performance.now() - t0;
  let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, data, text, ms, headers: r.headers, setCookie: sc, cookie: sc ? sc.split(';')[0] : '' };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sidOf = (cookie) => cookie.split('=')[1].split('.')[0];
const handleOf = (cookie) => crypto.createHash('sha256').update(sidOf(cookie)).digest('base64url').slice(0, 16);
const me = async (cookie) => (await call('GET', '/me', undefined, { cookie })).data.user;
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };

async function signup(email, ua = '') {
  const r = await call('POST', '/auth/signup', { email, password: STRONG }, { ua });
  assert.equal(r.status, 201, `inscription ${email} : ${JSON.stringify(r.data)}`);
  return { cookie: r.cookie, id: r.data.user.id, email };
}
async function login(email, password = STRONG, ua = '') {
  const r = await call('POST', '/auth/login', { email, password }, { ua });
  return { status: r.status, cookie: r.cookie };
}
// Courriers écrits dans la boîte d'envoi (mode développement) : un fichier par message, horodaté.
const mailsTo = (addr) => (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).filter((f) => f.endsWith(`-${addr}.eml`)).sort() : []);
const resetMailsTo = (addr) => mailsTo(addr).filter((f) => /^Subject: Réinitialisation/m.test(fs.readFileSync(path.join(OUTBOX, f), 'utf8')));
// Le serveur écrit l'e-mail après sa réponse : on attend un fichier complet (signature finale), pas seulement sa création.
async function nextMail(addr, before) {
  for (let i = 0; i < 60; i++) {
    const list = mailsTo(addr);
    if (list.length > before) {
      const text = fs.readFileSync(path.join(OUTBOX, list[list.length - 1]), 'utf8');
      if (/L’équipe Oubli\n$/.test(text)) return text;
    }
    await wait(50);
  }
  throw new Error(`aucun e-mail complet reçu par ${addr}`);
}
const tokenOf = (mail) => (mail.match(/#reset\?token=([A-Za-z0-9_-]{43})\b/) || [])[1];
async function requestLink(email) {
  const before = mailsTo(email).length;
  const r = await call('POST', '/auth/forgot', { email });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = tokenOf(await nextMail(email, before));
  assert.ok(token, 'lien de réinitialisation dans l’e-mail');
  return token;
}
const reset = (token, password = NEW_PW, opts = {}) => call('POST', '/auth/reset', { token, password }, opts);

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(250); }
  const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout = 5000');
  const admin = await signup('admin@test.fr');
  let r;

  /* ---------- 1. Réponse identique, que le compte existe ou non ---------- */
  const known = ['alice@exemple.fr', 'amir@exemple.fr', 'anna@exemple.fr'], unknown = ['personne@exemple.fr', 'nobody@exemple.fr', 'inconnu@exemple.fr'];
  for (const e of known) await signup(e);
  const timesKnown = [], timesUnknown = [];
  let first = null;
  for (let i = 0; i < 3; i++) {
    for (const [email, times] of [[known[i], timesKnown], [unknown[i], timesUnknown]]) {
      const r = await call('POST', '/auth/forgot', { email });
      assert.equal(r.status, 200);
      assert.equal(r.setCookie, '', 'aucun cookie posé');
      if (!first) first = r; else { assert.deepEqual(r.data, first.data, 'même corps de réponse'); assert.equal(r.headers.get('content-length'), first.headers.get('content-length')); }
      times.push(r.ms);
    }
  }
  assert.match(first.data.message, /Si un compte Oubli est associé à cette adresse/);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok([...timesKnown, ...timesUnknown].every((ms) => ms >= 280), `durée minimale de réponse (${timesKnown.concat(timesUnknown).map(Math.round)})`);
  assert.ok(Math.abs(mean(timesKnown) - mean(timesUnknown)) < 80, `temps comparables (${Math.round(mean(timesKnown))} / ${Math.round(mean(timesUnknown))} ms)`);
  for (const e of known) await nextMail(e, 1);   // e-mail de bienvenue, puis le lien
  await wait(200);
  for (const e of known) assert.equal(resetMailsTo(e).length, 1, `lien envoyé à ${e}`);
  for (const e of unknown) assert.equal(mailsTo(e).length, 0, `aucun e-mail pour ${e}`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM mails WHERE subject LIKE 'Réinitialisation%'`).get().c, 3, 'trois courriers, tous pour des comptes existants');
  r = await call('POST', '/auth/forgot', { email: 'pas-une-adresse' }); assert.equal(r.status, 400, 'adresse mal formée');
  step('demande de lien : même statut, même corps, même durée (≥ 300 ms) que le compte existe ou non ; e-mail seulement au compte existant');

  /* ---------- 2. Jeton jamais stocké ni journalisé en clair ---------- */
  const tA = tokenOf(fs.readFileSync(path.join(OUTBOX, resetMailsTo('alice@exemple.fr')[0]), 'utf8'));
  assert.ok(tA, 'jeton dans l’e-mail envoyé');
  assert.match(fs.readFileSync(path.join(OUTBOX, resetMailsTo('alice@exemple.fr')[0]), 'utf8'), /https:\/\/oubli\.test\/app\/#reset\?token=/, 'lien construit sur APP_URL');
  const row = db.prepare('SELECT * FROM password_resets WHERE user_id = (SELECT id FROM users WHERE email = ?)').get('alice@exemple.fr');
  assert.equal(row.token_hash, sha256hex(tA), 'seule l’empreinte SHA-256 est stockée');
  assert.ok(Date.parse(row.expires_at) - Date.parse(row.created_at) === 3600000, 'expiration à une heure');
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) {
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()).includes(tA), `jeton en clair dans la table ${name}`);
  }
  const stored = db.prepare(`SELECT body FROM mails WHERE to_addr = ? AND subject LIKE 'Réinitialisation%'`).get('alice@exemple.fr').body;
  assert.match(stored, /#reset\?token=\[masqué\]/, 'lien masqué dans la table mails (administration, export RGPD)');
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  for (const f of [DB, `${DB}-wal`]) if (fs.existsSync(f)) assert.ok(!fs.readFileSync(f).includes(Buffer.from(tA)), `jeton en clair dans ${path.basename(f)}`);
  assert.ok(!serverOut.includes(tA) && !serverErr.includes(tA), 'jeton absent des journaux du serveur');
  step('jeton : empreinte SHA-256 seulement, absent de toutes les tables, des fichiers de la base et des journaux ; lien masqué dans mails');

  /* ---------- 3. Expiration ---------- */
  const bob = await signup('bob@exemple.fr');
  const tB = await requestLink(bob.email);
  db.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), bob.id);
  r = await reset(tB);
  assert.equal(r.status, 400); assert.equal(r.data.code, 'expired'); assert.match(r.data.error, /expiré/);
  assert.equal((await login(bob.email)).status, 200, 'mot de passe inchangé');
  step('lien expiré (une heure) : refusé avec un message clair, mot de passe inchangé');

  /* ---------- 4. Usage unique ---------- */
  const carla = await signup('carla@exemple.fr');
  const tC = await requestLink(carla.email);
  r = await reset(tC);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.signed_in, true); assert.ok(r.cookie, 'nouvelle session');
  r = await reset(tC, 'Encore-un-autre-77!');
  assert.equal(r.status, 400); assert.equal(r.data.code, 'used'); assert.match(r.data.error, /déjà servi/);
  assert.equal((await login(carla.email, NEW_PW)).status, 200, 'le second essai n’a rien changé');
  // Deux envois simultanés du même lien : un seul aboutit.
  const tC2 = await requestLink(carla.email);
  const both = await Promise.all([reset(tC2, 'Premier-envoi-31!'), reset(tC2, 'Second-envoi-42!')]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 400], 'un seul des deux envois simultanés aboutit');
  step('usage unique, y compris pour deux envois simultanés');

  /* ---------- 5. Un nouveau lien remplace les précédents ---------- */
  const dan = await signup('dan@exemple.fr');
  const tD1 = await requestLink(dan.email), tD2 = await requestLink(dan.email);
  assert.notEqual(tD1, tD2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ?').get(dan.id).c, 1, 'un seul jeton valable par compte');
  r = await reset(tD1);
  assert.equal(r.status, 400); assert.equal(r.data.code, 'invalid'); assert.match(r.data.error, /remplacé par un lien plus récent/);
  assert.equal((await reset(tD2)).status, 200, 'le dernier lien fonctionne');
  step('un nouveau lien invalide les précédents');

  /* ---------- 6. Réinitialisation : sessions et jetons du compte fermés, journal, avis par e-mail ---------- */
  const eve = await signup('eve@exemple.fr');
  const e2 = (await login(eve.email)).cookie;
  const tE = await requestLink(eve.email);
  const before = mailsTo(eve.email).length;
  r = await reset(tE, NEW_PW, { cookie: e2 });
  assert.equal(r.status, 200); assert.match(r.setCookie, /HttpOnly/);
  assert.equal(await me(eve.cookie), null, 'première session fermée');
  assert.equal(await me(e2), null, 'session du navigateur utilisé fermée');
  assert.equal((await me(r.cookie)).email, eve.email, 'nouvelle session ouverte');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(eve.id).c, 1, 'une seule session restante');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ? AND used_at IS NULL').get(eve.id).c, 0, 'aucun jeton encore valable');
  assert.equal((await login(eve.email)).status, 401, 'ancien mot de passe refusé');
  assert.equal((await login(eve.email, NEW_PW)).status, 200, 'nouveau mot de passe accepté');
  assert.ok(db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND type = 'account' AND message LIKE 'Mot de passe réinitialisé%'`).get(eve.id), 'événement journalisé');
  const notice = await nextMail(eve.email, before);
  assert.match(notice, /^Subject: Votre mot de passe Oubli a été changé/m); assert.match(notice, /#forgot/);
  assert.ok(!notice.includes(tE), 'l’avis ne contient pas le jeton');
  step('réinitialisation : toutes les sessions et tous les jetons du compte fermés, nouvelle session, journal, avis par e-mail');

  /* ---------- 7. Politique de mot de passe ---------- */
  const frank = await signup('frank@exemple.fr');
  const tF = await requestLink(frank.email);
  for (const [pw, re] of [['court', /au moins 10/], ['password123', /trop simple/], ['Frank-2026-secret!', /adresse e-mail/], ['a'.repeat(129), /dépasser/]]) {
    r = await reset(tF, pw);
    assert.equal(r.status, 400, pw); assert.match(r.data.error, re); assert.equal(r.data.code, undefined);
  }
  r = await call('POST', '/auth/reset', { token: tF, password: 12345678901 }); assert.equal(r.status, 400, 'mot de passe non chaîne');
  assert.equal((await reset(tF)).status, 200, 'le lien reste valable après un mot de passe refusé');
  for (const bad of ['', 'x', 'a'.repeat(43) + '!', 42]) { r = await call('POST', '/auth/reset', { token: bad, password: NEW_PW }); assert.equal(r.status, 400); assert.equal(r.data.code, 'invalid'); }
  step('mot de passe trop court, courant, contenant l’adresse ou trop long refusé (même politique qu’à l’inscription) ; jeton mal formé refusé');

  /* ---------- 8. Limitation de débit par IP et par adresse ---------- */
  const floodIp = freshIp();
  const flood = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/auth/forgot', { email: `flot${i}@exemple.fr` }, { ip: floodIp })));
  assert.ok(flood.every((x) => x.status === 200), 'dix demandes par IP acceptées');
  r = await call('POST', '/auth/forgot', { email: 'flot10@exemple.fr' }, { ip: floodIp });
  assert.equal(r.status, 429, 'onzième demande depuis la même IP'); assert.ok(Number(r.headers.get('retry-after')) > 0); assert.match(r.data.error, /Trop de tentatives/);
  const grace = await signup('grace@exemple.fr');
  for (const email of [grace.email, 'fantome@exemple.fr']) {
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/auth/forgot', { email })).status, 200, `${email} : demande ${i + 1}`);
    r = await call('POST', '/auth/forgot', { email: email.toUpperCase() });
    assert.equal(r.status, 429, `${email} : quatrième demande, depuis une autre IP et en majuscules`); assert.match(r.data.error, /^Trop de tentatives\. Réessayez dans \d+ minutes\.$/);
  }
  await wait(300);
  assert.equal(resetMailsTo(grace.email).length, 3, 'trois liens au plus par heure pour une même adresse');
  step('limitation de débit : 10 demandes par IP et 3 par adresse et par heure (429 identique, compte existant ou non)');

  /* ---------- 9. Comptes suspendus, bloqués, supprimés ou dont l'adresse a changé ---------- */
  const hugo = await signup('hugo@exemple.fr');
  assert.equal((await call('POST', `/admin/users/${hugo.id}/suspend`, { reason: 'test' }, { cookie: admin.cookie })).status, 200);
  const tH = await requestLink(hugo.email);   // suspension temporaire : le titulaire peut reprendre la main sur son mot de passe
  r = await reset(tH);
  assert.equal(r.status, 200); assert.equal(r.data.signed_in, false); assert.equal(r.data.suspended, true); assert.match(r.data.message, /suspendu/);
  assert.equal(r.cookie, '', 'aucune session ouverte pour un compte suspendu');
  assert.equal((await login(hugo.email, NEW_PW)).status, 403, 'connexion toujours refusée pendant la suspension');
  const ines = await signup('ines@exemple.fr');
  const tI = await requestLink(ines.email);
  assert.equal((await call('POST', '/admin/blocklist', { pattern: ines.email }, { cookie: admin.cookie })).status, 201);
  const ib = mailsTo(ines.email).length;
  r = await call('POST', '/auth/forgot', { email: ines.email });
  assert.equal(r.status, 200); assert.deepEqual(r.data, first.data, 'réponse neutre');
  await wait(300); assert.equal(mailsTo(ines.email).length, ib, 'aucun envoi à une adresse bloquée');
  r = await reset(tI); assert.equal(r.data.code, 'invalid', 'un lien antérieur au blocage ne vaut plus');
  const jules = await signup('jules@exemple.fr');
  await requestLink(jules.email);
  assert.equal((await call('DELETE', '/account', { password: STRONG }, { cookie: jules.cookie })).status, 200);
  { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); assert.equal(d.prepare('SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ?').get(jules.id).c, 0, 'liens du compte supprimé purgés'); d.close(); }
  const jb = mailsTo(jules.email).length;
  assert.equal((await call('POST', '/auth/forgot', { email: jules.email })).status, 200);
  await wait(300); assert.equal(mailsTo(jules.email).length, jb, 'aucun envoi pour un compte supprimé');
  const kim = await signup('kim@exemple.fr');
  const tK = await requestLink(kim.email);
  assert.equal((await call('POST', `/admin/users/${kim.id}/email`, { email: 'kim.nouvelle@exemple.fr' }, { cookie: admin.cookie })).status, 200);
  r = await reset(tK); assert.equal(r.data.code, 'invalid', 'un lien envoyé à l’ancienne adresse ne vaut plus');
  step('compte suspendu (lien envoyé, aucune session), adresse bloquée, compte supprimé, adresse changée depuis l’envoi');

  /* ---------- 10. Appareils connectés : liste sans identifiant de session ---------- */
  assert.equal((await call('GET', '/sessions')).status, 401, 'anonyme → 401');
  const lea = await signup('lea@exemple.fr', UA.mac);
  const L1 = lea.cookie, L2 = (await login(lea.email, STRONG, UA.iphone)).cookie, L3 = (await login(lea.email, STRONG, UA.windows)).cookie;
  r = await call('GET', '/sessions', undefined, { cookie: L1 });
  assert.equal(r.status, 200); assert.equal(r.data.sessions.length, 3);
  const raw = JSON.stringify(r.data);
  for (const c of [L1, L2, L3]) assert.ok(!raw.includes(sidOf(c)), 'aucun identifiant de session brut');
  for (const leak of ['Mozilla', 'user_agent', '"ip"', '"id"', '198.51.']) assert.ok(!raw.includes(leak), `fuite : ${leak}`);
  const byHandle = Object.fromEntries(r.data.sessions.map((s) => [s.handle, s]));
  assert.ok(r.data.sessions.every((s) => /^[A-Za-z0-9_-]{16}$/.test(s.handle) && s.created_at && s.last_seen_at));
  assert.equal(r.data.sessions[0].handle, handleOf(L1), 'la session courante en premier');
  assert.deepEqual([byHandle[handleOf(L1)].current, byHandle[handleOf(L2)].current, byHandle[handleOf(L3)].current], [true, false, false]);
  assert.equal(byHandle[handleOf(L1)].device, 'Chrome sur macOS');
  assert.equal(byHandle[handleOf(L2)].device, 'Safari sur iPhone');
  assert.equal(byHandle[handleOf(L3)].device, 'Firefox sur Windows');
  const adminView = (await call('GET', `/admin/users/${lea.id}`, undefined, { cookie: admin.cookie })).data.sessions.map((s) => s.handle).sort();
  assert.deepEqual(adminView, Object.keys(byHandle).sort(), 'mêmes poignées que l’administration');
  step('appareils : liste avec date de création, dernière activité, appareil approximatif, « cet appareil » ; aucune donnée brute');

  /* ---------- 11. Révocation d'une autre session ---------- */
  r = await call('DELETE', `/sessions/${handleOf(L2)}`, undefined, { cookie: L1 });
  assert.equal(r.status, 200);
  assert.equal(await me(L2), null, 'la session révoquée ne fonctionne plus');
  assert.equal((await me(L1)).email, lea.email);
  r = await call('DELETE', `/sessions/${handleOf(L1)}`, undefined, { cookie: L1 });
  assert.equal(r.status, 400, 'la session courante se ferme avec « Se déconnecter »'); assert.ok(await me(L1));
  assert.equal((await call('DELETE', `/sessions/${handleOf(L2)}`, undefined, { cookie: L1 })).status, 404, 'déjà révoquée');
  assert.equal((await call('DELETE', '/sessions/pas-une-poignee!', undefined, { cookie: L1 })).status, 404);
  assert.equal((await call('DELETE', `/sessions/${handleOf(L3)}`)).status, 401, 'anonyme → 401');
  assert.ok(db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND message = ?`).get(lea.id, 'Appareil déconnecté depuis les paramètres : Safari sur iPhone.'), 'révocation journalisée');
  step('révocation d’un autre appareil : la session ne fonctionne plus ; session courante, poignée inconnue ou anonyme refusés');

  /* ---------- 12. Impossible de révoquer la session d'un autre compte ---------- */
  const mo = await signup('mo@exemple.fr');
  r = await call('DELETE', `/sessions/${handleOf(L3)}`, undefined, { cookie: mo.cookie });
  assert.equal(r.status, 404, 'poignée d’un autre compte : introuvable');
  assert.equal((await me(L3)).email, lea.email, 'la session de l’autre compte reste ouverte');
  assert.ok(!JSON.stringify((await call('GET', '/sessions', undefined, { cookie: mo.cookie })).data).includes(handleOf(L3)), 'liste cloisonnée');
  step('cloisonnement : la session d’un autre compte ne peut être ni vue ni révoquée');

  /* ---------- 13. « Déconnecter les autres appareils » garde la session courante ---------- */
  const L4 = (await login(lea.email, STRONG, UA.iphone)).cookie;
  r = await call('POST', '/sessions/revoke-others', undefined, { cookie: L1 });
  assert.equal(r.status, 200); assert.equal(r.data.revoked, 2);
  assert.equal((await me(L1)).email, lea.email, 'session courante conservée');
  assert.equal(await me(L3), null); assert.equal(await me(L4), null);
  r = await call('GET', '/sessions', undefined, { cookie: L1 });
  assert.equal(r.data.sessions.length, 1); assert.equal(r.data.sessions[0].current, true);
  assert.equal((await call('POST', '/sessions/revoke-others', undefined, { cookie: L1 })).data.revoked, 0);
  step('« déconnecter les autres appareils » : toutes les autres sessions fermées, la session courante conservée');

  /* ---------- 14. Accès support : lecture seule ---------- */
  r = await call('POST', `/admin/users/${lea.id}/impersonate`, { reason: 'ticket 7' }, { cookie: admin.cookie });
  assert.equal(r.status, 200);
  const S = r.cookie;
  r = await call('GET', '/sessions', undefined, { cookie: S });
  assert.equal(r.status, 200, 'lecture permise');
  const sup = r.data.sessions.find((s) => s.support);
  assert.ok(sup && sup.current && sup.device === 'Accès support Oubli', 'session support signalée');
  for (const [m, p] of [['DELETE', `/sessions/${handleOf(L1)}`], ['POST', '/sessions/revoke-others'], ['POST', '/auth/forgot'], ['POST', '/auth/reset']]) {
    r = await call(m, p, m === 'POST' && p.startsWith('/auth') ? { email: lea.email, token: 'x', password: NEW_PW } : undefined, { cookie: S });
    assert.equal(r.status, 403, `${m} ${p} pendant un accès support`); assert.match(r.data.error, /lecture seule/);
  }
  assert.equal((await me(L1)).email, lea.email, 'la session de l’abonnée est intacte');
  assert.ok((await call('GET', '/sessions', undefined, { cookie: L1 })).data.sessions.some((s) => s.support && !s.current), 'l’abonnée voit l’accès support');
  step('accès support : liste visible, révocations et réinitialisation refusées (lecture seule)');

  /* ---------- 15. Adresses : l'inscription n'accepte que des adresses auxquelles on peut écrire ---------- */
  // L'inscription acceptait des adresses que l'envoi refusait ensuite (compte qui ne reçoit rien, pas même un lien de
  // réinitialisation), et l'envoi refusait l'apostrophe, pourtant permise (o'neil@…).
  const apos = await signup("o'neil@exemple.fr");
  r = await call('POST', '/auth/forgot', { email: apos.email });
  assert.equal(r.status, 200);
  const mailsOf = () => db.prepare('SELECT subject, error FROM mails WHERE to_addr = ? ORDER BY id').all(apos.email);
  for (let i = 0; i < 60 && mailsOf().length < 2; i++) await wait(50);
  assert.equal(mailsOf().length, 2, 'bienvenue et réinitialisation'); assert.ok(mailsOf().every((m) => m.error === null), JSON.stringify(mailsOf()));
  for (const bad of ['a,b@exemple.fr', 'a;b@exemple.fr', '<a@exemple.fr>', '"a"@exemple.fr', 'a(b)@exemple.fr', 'a\\b@exemple.fr', 'a@exemple', 'a@exemple.f', "a@o'neil.fr"]) {
    assert.equal((await call('POST', '/auth/signup', { email: bad, password: STRONG })).status, 400, `inscription refusée : ${bad}`);
  }
  r = await call('POST', '/contact', { email: 'a,b@exemple.fr', message: 'Bonjour, une question.' });
  assert.equal(r.status, 400, 'formulaire de contact : même règle');
  db.close();
  step('adresses : apostrophe acceptée et courriers envoyés ; virgule, point-virgule, chevrons, guillemets, parenthèses ou domaine incomplet refusés dès l’inscription');

  console.log(`✔ Comptes validés (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  if (serverErr.trim()) console.error(serverErr.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000).unref(); });   // attendre l'arrêt : le serveur peut encore écrire dans tmp
  fs.rmSync(tmp, { recursive: true, force: true });
}
