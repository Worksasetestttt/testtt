// Test de la double authentification (TOTP, RFC 6238) et du verrouillage de connexion : mise en place en deux temps
// (clé, puis premier code), secret chiffré en base (AES-256-GCM, clé dérivée de SESSION_SECRET), codes de secours hachés
// à usage unique, connexion en deux étapes sans session avant le code, anti-rejeu, désactivation, réinitialisation du
// mot de passe sans session, obligation pour l'administration en production, verrouillage par couple (adresse, client)
// et plafond global par adresse. Les codes TOTP sont calculés ici avec node:crypto, indépendamment du serveur.
// Chaque serveur tourne sur un port libre, avec une base et une boîte d'envoi temporaires (jamais data/).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';
import * as serverTotp from '../server/totp.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-2fa-'));
const STRONG = 'Corde-a-linge-78!', NEW_PW = 'Nouveau-mot-2-passe!';
const SECRET = 'test-secret-for-twofactor-suite-0123456789';
const LOCK_MSG = /^Trop de tentatives\. Réessayez dans \d+ minutes\.$/;
const RECOVERY = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const servers = [];
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- TOTP (RFC 4226 et 6238), calculé dans le test ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) {
    const v = B32.indexOf(ch); if (v < 0) throw new Error(`base32 invalide : ${ch}`);
    value = ((value << 5) | v) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = ((value << 8) | byte) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}
function hotp(key, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30000);
const totp = (secret, s = stepNow()) => hotp(b32decode(secret), s);
// Code faux : aucun des codes valables autour de maintenant.
function wrongCode(secret) {
  const valid = new Set([-2, -1, 0, 1, 2].map((d) => totp(secret, stepNow() + d)));
  for (;;) { const c = String(crypto.randomInt(1000000)).padStart(6, '0'); if (!valid.has(c)) return c; }
}
// Code neuf : un pas plus récent que le dernier accepté (anti-rejeu) et dans la fenêtre du serveur (±1 pas).
async function freshCode(u) {
  const s = Math.max(u.lastStep + 1, stepNow());
  while (s > stepNow() + 1) await wait(250);
  u.lastStep = s; u.lastCode = totp(u.secret, s);
  return u.lastCode;
}

/* ---------- Serveurs et appels ---------- */
async function startServer(name, extra = {}) {
  const port = await freePort();
  const dir = path.join(tmp, name);
  const env = {
    ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'test.sqlite'), OUTBOX_DIR: path.join(dir, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SESSION_SECRET: SECRET, ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test',
    SITE_DISCOVERY: 'off', TRUST_PROXY: '1', APP_URL: 'https://oubli.test', ADMIN_REQUIRE_2FA: '', ADMIN_EMAIL_VERIFICATION: '', ...extra,
  };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { name, proc, out: '', err: '', dbPath: env.DATABASE_PATH, outbox: env.OUTBOX_DIR, base: `http://localhost:${port}/api` };
  proc.stdout.on('data', (d) => { s.out += d; });
  proc.stderr.on('data', (d) => { s.err += d; });
  servers.push(s);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(s.base + '/health')).ok) break; } catch {} await wait(150); }
  s.db = new DatabaseSync(s.dbPath); s.db.exec('PRAGMA busy_timeout = 5000');
  return s;
}
// TRUST_PROXY=1 : chaque appel se présente avec sa propre IP (X-Forwarded-For), sauf si `ip` est donnée.
let ipSeq = 0;
const freshIp = () => { ipSeq += 1; return `198.51.${100 + Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; };
async function call(s, method, p, body, { cookie = '', ip = freshIp() } = {}) {
  const h = { 'x-forwarded-for': ip };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(s.base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { _t: text }; }
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, data, text, headers: r.headers, setCookie: sc, cookie: sc ? sc.split(';')[0] : '' };
}
const login = (s, email, password = STRONG, opts) => call(s, 'POST', '/auth/login', { email, password }, opts);
const second = (s, challenge, code, opts) => call(s, 'POST', '/auth/login/2fa', { challenge, code }, opts);
const me = async (s, cookie) => (await call(s, 'GET', '/me', undefined, { cookie })).data.user;
const sessionsOf = (s, id) => s.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(id).c;
async function signup(s, email) {
  const r = await call(s, 'POST', '/auth/signup', { email, password: STRONG });
  assert.equal(r.status, 201, `inscription ${email} : ${JSON.stringify(r.data)}`);
  return { cookie: r.cookie, id: r.data.user.id, email, lastStep: 0 };
}
// Compte protégé : inscription, clé de configuration, premier code. Retourne aussi la clé et les codes de secours.
async function enrolled(s, email) {
  const u = await signup(s, email);
  let r = await call(s, 'POST', '/auth/2fa/setup', { password: STRONG }, { cookie: u.cookie });
  assert.equal(r.status, 200, `mise en place ${email} : ${JSON.stringify(r.data)}`);
  u.secret = r.data.secret;
  r = await call(s, 'POST', '/auth/2fa/enable', { code: await freshCode(u) }, { cookie: u.cookie });
  assert.equal(r.status, 200, `activation ${email} : ${JSON.stringify(r.data)}`);
  u.codes = r.data.recovery_codes;
  return u;
}
// Courriers de la boîte d'envoi (mode développement) : lien de réinitialisation.
const mailsTo = (s, addr) => (fs.existsSync(s.outbox) ? fs.readdirSync(s.outbox).filter((f) => f.endsWith(`-${addr}.eml`)).sort() : []);
async function resetToken(s, email) {
  const before = mailsTo(s, email).length;
  assert.equal((await call(s, 'POST', '/auth/forgot', { email })).status, 200);
  for (let i = 0; i < 80; i++) {
    const list = mailsTo(s, email);
    if (list.length > before) {
      const text = fs.readFileSync(path.join(s.outbox, list[list.length - 1]), 'utf8');
      const m = text.match(/#reset\?token=([A-Za-z0-9_-]{43})\b/);
      if (m && /L’équipe Oubli\n$/.test(text)) return m[1];
    }
    await wait(50);
  }
  throw new Error(`aucun lien de réinitialisation reçu par ${email}`);
}

try {
  /* ---------- 1. Algorithme : vecteurs de référence des RFC 4226 et 6238 ---------- */
  const rfcKey = Buffer.from('12345678901234567890');
  ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'].forEach((c, i) => {
    assert.equal(hotp(rfcKey, i), c, `HOTP ${i} (test)`);
    assert.equal(serverTotp.hotp(rfcKey, i), c, `HOTP ${i} (serveur)`);
  });
  for (const [t, c] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(hotp(rfcKey, Math.floor(t / 30)), c, `TOTP t=${t} (test)`);
    assert.equal(serverTotp.totpAt(rfcKey, t * 1000), c, `TOTP t=${t} (serveur)`);
  }
  for (const [raw, enc] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.equal(serverTotp.base32Encode(Buffer.from(raw)), enc, `base32 « ${raw} »`);
    assert.equal(b32encode(Buffer.from(raw)), enc);
  }
  // Fenêtre de ±1 pas (30 s) et anti-rejeu : un pas déjà accepté, ou plus ancien, est refusé.
  const t0 = 1111111111000, s0 = Math.floor(t0 / 30000);
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0), 0, t0), s0, 'pas courant');
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0 - 1), 0, t0), s0 - 1, 'pas précédent');
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0 + 1), 0, t0), s0 + 1, 'pas suivant');
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0 - 2), 0, t0), null, 'deux pas de retard');
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0 + 2), 0, t0), null, 'deux pas d’avance');
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0), s0, t0), null, 'pas déjà utilisé');
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0 - 1), s0, t0), null, 'pas plus ancien que le dernier utilisé');
  assert.equal(serverTotp.matchTotp(rfcKey, hotp(rfcKey, s0 + 1), s0, t0), s0 + 1, 'pas plus récent accepté');
  for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456]) assert.equal(serverTotp.matchTotp(rfcKey, bad, 0, t0), null, `saisie ${bad}`);
  step('algorithme : vecteurs RFC 4226 / 6238 (test et serveur), base32, fenêtre de ±1 pas, anti-rejeu');

  const S = await startServer('main');
  let r;

  /* ---------- 2. Mise en place : mot de passe, clé, lien otpauth, premier code, codes de secours ---------- */
  const alice = await signup(S, 'alice@exemple.fr');
  assert.equal((await call(S, 'GET', '/auth/2fa')).status, 401, 'anonyme → 401');
  assert.equal((await call(S, 'POST', '/auth/2fa/setup', { password: STRONG })).status, 401, 'mise en place anonyme → 401');
  r = await call(S, 'GET', '/auth/2fa', undefined, { cookie: alice.cookie });
  assert.equal(r.status, 200); assert.equal(r.data.enabled, false); assert.equal(r.data.pending, false); assert.equal(r.data.admin_required, false);
  r = await call(S, 'POST', '/auth/2fa/setup', {}, { cookie: alice.cookie });
  assert.equal(r.status, 400, 'mot de passe exigé pour commencer');
  r = await call(S, 'POST', '/auth/2fa/setup', { password: 'Mauvais-mot-de-passe-1' }, { cookie: alice.cookie });
  assert.equal(r.status, 400); assert.match(r.data.error, /Mot de passe incorrect/);
  r = await call(S, 'POST', '/auth/2fa/enable', { code: '123456' }, { cookie: alice.cookie });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'no_setup', 'confirmation sans clé affichée');
  r = await call(S, 'POST', '/auth/2fa/setup', { password: STRONG }, { cookie: alice.cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const firstSecret = r.data.secret;
  r = await call(S, 'POST', '/auth/2fa/setup', { password: STRONG }, { cookie: alice.cookie });
  assert.equal(r.status, 200); assert.notEqual(r.data.secret, firstSecret, 'une nouvelle mise en place remplace la clé non confirmée');
  alice.secret = r.data.secret;
  assert.match(alice.secret, /^[A-Z2-7]{32}$/, 'clé base32 de 160 bits');
  assert.equal(r.data.otpauth, `otpauth://totp/Oubli:${encodeURIComponent(alice.email)}?secret=${alice.secret}&issuer=Oubli`, 'lien otpauth');
  r = await call(S, 'GET', '/auth/2fa', undefined, { cookie: alice.cookie });
  assert.equal(r.data.pending, true); assert.equal(r.data.enabled, false); assert.ok(!r.text.includes(alice.secret), 'l’état ne renvoie pas la clé');
  const other = await login(S, alice.email);
  assert.equal(other.status, 200); assert.ok(other.cookie, 'clé non confirmée : la connexion reste sans code');
  r = await call(S, 'POST', '/auth/2fa/enable', { code: wrongCode(alice.secret) }, { cookie: alice.cookie });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'invalid_code', 'code faux');
  r = await call(S, 'POST', '/auth/2fa/enable', { code: totp(firstSecret) }, { cookie: alice.cookie });
  assert.equal(r.status, 400, 'code de la clé remplacée');
  r = await call(S, 'POST', '/auth/2fa/enable', { code: totp(alice.secret, stepNow() - 3) }, { cookie: alice.cookie });
  assert.equal(r.status, 400, 'code hors de la fenêtre de ±30 s');
  r = await call(S, 'POST', '/auth/2fa/enable', { code: await freshCode(alice) }, { cookie: alice.cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  alice.codes = r.data.recovery_codes;
  assert.equal(alice.codes.length, 10, 'dix codes de secours'); assert.equal(new Set(alice.codes).size, 10, 'tous différents');
  assert.ok(alice.codes.every((c) => RECOVERY.test(c)), `format XXXX-XXXX-XXXX : ${alice.codes.join(' ')}`);
  assert.equal(await me(S, other.cookie), null, 'les autres sessions sont fermées à l’activation');
  assert.equal((await me(S, alice.cookie)).email, alice.email, 'la session courante est conservée');
  r = await call(S, 'GET', '/auth/2fa', undefined, { cookie: alice.cookie });
  assert.equal(r.data.enabled, true); assert.equal(r.data.pending, false); assert.equal(r.data.recovery_remaining, 10); assert.ok(r.data.enabled_at);
  assert.equal((await call(S, 'POST', '/auth/2fa/setup', { password: STRONG }, { cookie: alice.cookie })).status, 409, 'déjà active : pas de nouvelle clé');
  assert.equal((await call(S, 'POST', '/auth/2fa/enable', { code: totp(alice.secret) }, { cookie: alice.cookie })).status, 409);
  const adm = await signup(S, 'admin@test.fr');
  r = await call(S, 'GET', '/admin/stats', undefined, { cookie: adm.cookie });
  assert.equal(r.status, 200, 'hors production, l’administration reste ouverte sans double authentification (ADMIN_REQUIRE_2FA inactif)');
  r = await call(S, 'GET', `/admin/users/${alice.id}`, undefined, { cookie: adm.cookie });
  assert.equal(r.status, 200); assert.equal(r.data.user.two_factor, true, 'l’administration voit que la double authentification est active');
  for (const [p, c] of [['/auth/2fa', alice.cookie], ['/me', alice.cookie], ['/export', alice.cookie], ['/dashboard', alice.cookie], [`/admin/users/${alice.id}`, adm.cookie]]) {
    const x = await call(S, 'GET', p, undefined, { cookie: c });
    assert.equal(x.status, 200, p);
    assert.ok(!x.text.includes(alice.secret) && !alice.codes.some((code) => x.text.includes(code)), `clé ou code de secours renvoyé par ${p}`);
  }
  assert.ok(S.db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND type = 'account' AND message LIKE 'Double authentification activée%'`).get(alice.id), 'activation journalisée');
  step('mise en place : mot de passe exigé, clé base32 de 160 bits et lien otpauth, premier code, 10 codes de secours, autres sessions fermées, clé jamais renvoyée');

  /* ---------- 3. Stockage : secret chiffré, codes de secours hachés ---------- */
  S.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  const row = S.db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(alice.id);
  assert.match(row.secret_enc, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{27}$/, 'format v1.iv.tag.chiffré (IV de 96 bits, étiquette de 128 bits)');
  const raw = b32decode(alice.secret);
  for (const f of [S.dbPath, `${S.dbPath}-wal`]) {
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    assert.ok(!buf.includes(Buffer.from(alice.secret)) && !buf.includes(raw), `clé en clair dans ${path.basename(f)}`);
    for (const c of alice.codes) assert.ok(!buf.includes(Buffer.from(c)) && !buf.includes(Buffer.from(c.replace(/-/g, ''))), `code de secours en clair dans ${path.basename(f)}`);
  }
  // Une copie de la base ne suffit pas : il faut aussi SESSION_SECRET (HKDF-SHA256), et le chiffré est lié au compte.
  const open = (sessionSecret, userId) => {
    const [, iv, tag, ct] = row.secret_enc.split('.');
    const key = Buffer.from(crypto.hkdfSync('sha256', sessionSecret, 'oubli', 'totp-secret:v1', 32));
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAAD(Buffer.from(`totp:${userId}`)); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  };
  assert.deepEqual(open(SECRET, alice.id), raw, 'déchiffrable avec la clé dérivée de SESSION_SECRET');
  assert.throws(() => open('un-autre-secret-de-session-0123456789', alice.id), 'indéchiffrable sans SESSION_SECRET');
  assert.throws(() => open(SECRET, crypto.randomUUID()), 'chiffré lié au compte (données associées)');
  const hashes = S.db.prepare('SELECT code_hash FROM totp_recovery_codes WHERE user_id = ?').all(alice.id).map((x) => x.code_hash);
  assert.equal(hashes.length, 10); assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), 'empreintes SHA-256');
  assert.ok(!(S.out + S.err).includes(alice.secret) && !alice.codes.some((c) => (S.out + S.err).includes(c)), 'ni clé ni code dans les journaux du serveur');
  step('stockage : clé chiffrée (AES-256-GCM, IV aléatoire, clé dérivée de SESSION_SECRET, liée au compte), absente des fichiers .sqlite et -wal ; codes de secours hachés');

  /* ---------- 4. Connexion en deux étapes : aucune session avant le code ---------- */
  const bob = await enrolled(S, 'bob@exemple.fr');
  const ivA = row.secret_enc.split('.')[1], ivB = S.db.prepare('SELECT secret_enc FROM user_totp WHERE user_id = ?').get(bob.id).secret_enc.split('.')[1];
  assert.notEqual(ivA, ivB, 'IV tiré au hasard pour chaque clé');
  const n0 = sessionsOf(S, bob.id);
  r = await login(S, bob.email);
  assert.equal(r.status, 200); assert.equal(r.data.two_factor, true); assert.equal(r.setCookie, '', 'aucun cookie après le mot de passe seul');
  assert.equal(r.data.user, undefined, 'aucune donnée du compte avant le code');
  assert.match(r.data.challenge, /^[A-Za-z0-9_-]{43}$/, 'jeton de 256 bits');
  const ttl = Date.parse(r.data.expires_at) - Date.now();
  assert.ok(ttl > 4 * 60000 && ttl <= 5 * 60000 + 2000, `jeton valable 5 minutes (${ttl} ms)`);
  assert.equal(sessionsOf(S, bob.id), n0, 'aucune session ouverte par le mot de passe seul');
  assert.ok(!JSON.stringify(S.db.prepare('SELECT * FROM login_challenges').all()).includes(r.data.challenge), 'jeton stocké sous forme d’empreinte');
  let ch = r.data.challenge;
  r = await second(S, ch, wrongCode(bob.secret));
  assert.equal(r.status, 401); assert.equal(r.data.code, 'invalid_code'); assert.equal(r.setCookie, ''); assert.equal(sessionsOf(S, bob.id), n0);
  r = await second(S, ch, await freshCode(bob));
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.setCookie, /HttpOnly/); assert.equal(r.data.user.email, bob.email);
  assert.equal((await me(S, r.cookie)).email, bob.email, 'session ouverte après le code');
  assert.equal(sessionsOf(S, bob.id), n0 + 1);
  r = await second(S, ch, totp(bob.secret));
  assert.equal(r.status, 401); assert.equal(r.data.code, 'challenge_expired', 'jeton à usage unique');
  ch = (await login(S, bob.email)).data.challenge;
  r = await second(S, ch, bob.lastCode);
  assert.equal(r.status, 401); assert.equal(r.data.code, 'invalid_code', 'code déjà utilisé refusé (anti-rejeu)');
  S.db.prepare('UPDATE login_challenges SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), bob.id);
  r = await second(S, ch, wrongCode(bob.secret));
  assert.equal(r.status, 401); assert.equal(r.data.code, 'challenge_expired', 'jeton expiré'); assert.match(r.data.error, /mot de passe/);
  ch = (await login(S, bob.email)).data.challenge;
  for (let i = 1; i <= 4; i++) { r = await second(S, ch, wrongCode(bob.secret)); assert.equal(r.data.code, 'invalid_code', `essai ${i}`); }
  r = await second(S, ch, wrongCode(bob.secret));
  assert.equal(r.status, 401); assert.equal(r.data.code, 'challenge_expired', 'cinquième code faux : le jeton est détruit'); assert.match(r.data.error, /Trop de codes incorrects/);
  r = await second(S, ch, totp(bob.secret, bob.lastStep + 1));
  assert.equal(r.data.code, 'challenge_expired', 'même un bon code ne sert plus avec ce jeton');
  for (const bad of [undefined, 42, '', 'x'.repeat(43), ['a']]) {
    r = await call(S, 'POST', '/auth/login/2fa', { challenge: bad, code: '123456' });
    assert.equal(r.status, 401, `jeton ${JSON.stringify(bad)}`); assert.equal(r.data.code, 'challenge_expired');
  }
  ch = (await login(S, bob.email)).data.challenge;
  for (const bad of ['abcdef', { a: 1 }]) { r = await second(S, ch, bad); assert.equal(r.status, 401); assert.equal(r.data.code, 'invalid_code', `code ${JSON.stringify(bad)}`); }
  step('connexion en deux étapes : ni cookie ni session avant le code, jeton haché de 5 minutes à usage unique, 5 essais, code rejoué refusé');

  /* ---------- 5. Codes de secours : usage unique, saisie tolérante, renouvellement ---------- */
  ch = (await login(S, alice.email)).data.challenge;
  r = await second(S, ch, alice.codes[0]);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.recovery_remaining, 9); assert.ok(r.cookie);
  assert.ok(S.db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND message LIKE 'Connexion avec un code de secours%'`).get(alice.id), 'code de secours journalisé');
  ch = (await login(S, alice.email)).data.challenge;
  r = await second(S, ch, alice.codes[0]);
  assert.equal(r.status, 401); assert.equal(r.data.code, 'invalid_code', 'un code de secours ne sert qu’une fois');
  r = await second(S, ch, ` ${alice.codes[1].toLowerCase().replace(/-/g, ' ')} `);
  assert.equal(r.status, 200, 'casse, espaces et tirets indifférents'); assert.equal(r.data.recovery_remaining, 8);
  assert.equal((await call(S, 'GET', '/auth/2fa', undefined, { cookie: alice.cookie })).data.recovery_remaining, 8);
  r = await call(S, 'POST', '/auth/2fa/recovery', { password: STRONG }, { cookie: alice.cookie });
  assert.equal(r.status, 400, 'renouvellement : code exigé');
  r = await call(S, 'POST', '/auth/2fa/recovery', { password: 'Mauvais-mot-de-passe-1', code: alice.codes[2] }, { cookie: alice.cookie });
  assert.equal(r.status, 400); assert.match(r.data.error, /Mot de passe incorrect/);
  r = await call(S, 'POST', '/auth/2fa/recovery', { password: STRONG, code: wrongCode(alice.secret) }, { cookie: alice.cookie });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'invalid_code');
  r = await call(S, 'POST', '/auth/2fa/recovery', { password: STRONG, code: alice.codes[2] }, { cookie: alice.cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const renewed = r.data.recovery_codes;
  assert.equal(renewed.length, 10); assert.ok(renewed.every((c) => RECOVERY.test(c) && !alice.codes.includes(c)), 'dix nouveaux codes');
  ch = (await login(S, alice.email)).data.challenge;
  assert.equal((await second(S, ch, alice.codes[3])).status, 401, 'les anciens codes ne valent plus');
  r = await second(S, ch, renewed[0]);
  assert.equal(r.status, 200); assert.equal(r.data.recovery_remaining, 9);
  assert.ok(S.db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND message LIKE 'Nouveaux codes de secours%'`).get(alice.id), 'renouvellement journalisé');
  step('codes de secours : usage unique, saisie tolérante, restants affichés, renouvellement (mot de passe et code) qui invalide les anciens');

  /* ---------- 6. Désactivation : mot de passe et code obligatoires ---------- */
  r = await call(S, 'POST', '/auth/2fa/disable', {}, { cookie: alice.cookie });
  assert.equal(r.status, 400, 'mot de passe et code exigés');
  r = await call(S, 'POST', '/auth/2fa/disable', { password: STRONG }, { cookie: alice.cookie });
  assert.equal(r.status, 400, 'code exigé');
  r = await call(S, 'POST', '/auth/2fa/disable', { password: 'Mauvais-mot-de-passe-1', code: totp(alice.secret, alice.lastStep + 1) }, { cookie: alice.cookie });
  assert.equal(r.status, 400); assert.match(r.data.error, /Mot de passe incorrect/);
  r = await call(S, 'POST', '/auth/2fa/disable', { password: STRONG, code: wrongCode(alice.secret) }, { cookie: alice.cookie });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'invalid_code');
  r = await call(S, 'POST', '/auth/2fa/disable', { password: STRONG, code: alice.lastCode }, { cookie: alice.cookie });
  assert.equal(r.status, 400, 'code déjà utilisé (activation) refusé');
  assert.equal((await call(S, 'GET', '/auth/2fa', undefined, { cookie: alice.cookie })).data.enabled, true, 'toujours active après les refus');
  r = await call(S, 'POST', '/auth/2fa/disable', { password: STRONG, code: await freshCode(alice) }, { cookie: alice.cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call(S, 'GET', '/auth/2fa', undefined, { cookie: alice.cookie });
  assert.equal(r.data.enabled, false); assert.equal(r.data.pending, false); assert.equal(r.data.recovery_remaining, 0);
  assert.equal(S.db.prepare('SELECT COUNT(*) AS c FROM user_totp WHERE user_id = ?').get(alice.id).c, 0, 'clé supprimée');
  assert.equal(S.db.prepare('SELECT COUNT(*) AS c FROM totp_recovery_codes WHERE user_id = ?').get(alice.id).c, 0, 'codes supprimés');
  r = await login(S, alice.email);
  assert.equal(r.status, 200); assert.ok(r.cookie, 'connexion directe une fois désactivée'); assert.equal(r.data.two_factor, undefined);
  assert.ok(S.db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND message LIKE 'Double authentification désactivée%'`).get(alice.id), 'désactivation journalisée');
  assert.equal((await call(S, 'POST', '/auth/2fa/disable', { password: STRONG, code: '123456' }, { cookie: alice.cookie })).status, 409, 'rien à désactiver');
  step('désactivation : mot de passe et code (ni faux ni rejoué) obligatoires, clé et codes supprimés, journalisée');

  /* ---------- 7. Réinitialisation du mot de passe : aucune session sans le code ---------- */
  const carol = await enrolled(S, 'carol@exemple.fr');
  const early = (await login(S, carol.email)).data.challenge;   // jeton obtenu avec l'ancien mot de passe
  const token = await resetToken(S, carol.email);
  r = await call(S, 'POST', '/auth/reset', { token, password: NEW_PW });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.signed_in, false); assert.equal(r.data.two_factor, true);
  assert.match(r.data.message, /double authentification/);
  assert.equal(r.setCookie, '', 'aucune session ouverte sans le code');
  assert.equal(sessionsOf(S, carol.id), 0, 'toutes les sessions fermées, aucune ouverte');
  assert.equal(await me(S, carol.cookie), null);
  r = await second(S, early, wrongCode(carol.secret));
  assert.equal(r.data.code, 'challenge_expired', 'un jeton antérieur à la réinitialisation ne vaut plus');
  assert.equal((await login(S, carol.email)).status, 401, 'ancien mot de passe refusé');
  r = await login(S, carol.email, NEW_PW);
  assert.equal(r.data.two_factor, true, 'nouveau mot de passe : le code reste demandé');
  r = await second(S, r.data.challenge, await freshCode(carol));
  assert.equal(r.status, 200); assert.equal((await me(S, r.cookie)).email, carol.email);
  const carolSession = r.cookie, pending = (await login(S, carol.email, NEW_PW)).data.challenge;
  assert.equal((await call(S, 'POST', '/auth/password', { current: NEW_PW, next: 'Encore-un-mot-2-passe!' }, { cookie: carolSession })).status, 200);
  r = await second(S, pending, wrongCode(carol.secret));
  assert.equal(r.data.code, 'challenge_expired', 'changement de mot de passe depuis les paramètres : jetons en cours invalidés');
  // Compte suspendu : la suspension n'est révélée qu'après le mot de passe et le code.
  const sue = await enrolled(S, 'sue@exemple.fr');
  assert.equal((await call(S, 'POST', `/admin/users/${sue.id}/suspend`, { reason: 'test' }, { cookie: adm.cookie })).status, 200);
  r = await login(S, sue.email);
  assert.equal(r.status, 200); assert.equal(r.data.two_factor, true, 'mot de passe seul : rien ne trahit la suspension');
  r = await second(S, r.data.challenge, await freshCode(sue));
  assert.equal(r.status, 403); assert.match(r.data.error, /suspendu/); assert.equal(r.setCookie, '', 'aucune session pour un compte suspendu');
  step('réinitialisation : signed_in:false, aucune session sans le code, jetons antérieurs invalidés (comme après un changement de mot de passe), puis connexion en deux étapes ; suspension annoncée après le code seulement');

  /* ---------- 8. Verrouillage par couple (adresse, client) ---------- */
  const dave = await signup(S, 'dave@exemple.fr');
  const ipA = '203.0.113.10', ipB = '203.0.113.20';
  for (let i = 1; i <= 10; i++) { r = await login(S, dave.email, `Mauvais-mot-${i}-x!`, { ip: ipA }); assert.equal(r.status, 401, `échec ${i}`); assert.equal(r.data.error, 'E-mail ou mot de passe incorrect.'); }
  r = await login(S, dave.email, STRONG, { ip: ipA });
  assert.equal(r.status, 429, 'ce client est bloqué, même avec le bon mot de passe'); assert.ok(Number(r.headers.get('retry-after')) > 0); assert.match(r.data.error, LOCK_MSG);
  const lockedMsg = r.data.error;
  r = await login(S, dave.email, STRONG, { ip: ipB });
  assert.equal(r.status, 200, 'un autre client se connecte normalement : un tiers ne bloque plus le compte'); assert.ok(r.cookie);
  assert.equal((await login(S, dave.email, STRONG, { ip: ipA })).status, 429, 'la connexion d’un autre client ne débloque pas le premier');
  for (let i = 1; i <= 10; i++) assert.equal((await login(S, dave.email, `Mauvais-mot-${i}-y!`, { ip: `2001:db8:1:2::${i.toString(16)}` })).status, 401);
  assert.equal((await login(S, dave.email, STRONG, { ip: '2001:db8:1:2:ffff:ffff:ffff:1' })).status, 429, 'IPv6 : tout le /64 compte comme un seul client');
  assert.equal((await login(S, dave.email, STRONG, { ip: '2001:db8:1:3::1' })).status, 200, 'IPv6 : un autre /64 reste libre');
  for (let i = 1; i <= 10; i++) assert.equal((await login(S, 'fantome@exemple.fr', `Mauvais-mot-${i}-z!`, { ip: ipA })).status, 401);
  r = await login(S, 'fantome@exemple.fr', STRONG, { ip: ipA });
  assert.equal(r.status, 429, 'adresse inconnue : même verrouillage'); assert.equal(r.data.error, lockedMsg, 'message identique : aucun indice sur l’existence du compte');
  // Les codes faux de la seconde étape comptent dans le même verrouillage.
  const erin = await enrolled(S, 'erin@exemple.fr');
  const ipC = '203.0.113.30';
  for (let n = 0; n < 10;) {
    const c = (await login(S, erin.email, STRONG, { ip: ipC })).data.challenge;
    assert.ok(c, `jeton ${n}`);
    for (let i = 0; i < 5; i++, n++) assert.equal((await second(S, c, wrongCode(erin.secret), { ip: ipC })).status, 401);
  }
  r = await login(S, erin.email, STRONG, { ip: ipC });
  assert.equal(r.status, 429, 'dix codes faux bloquent ce client'); assert.match(r.data.error, LOCK_MSG);
  r = await login(S, erin.email, STRONG, { ip: '203.0.113.31' });
  assert.equal(r.data.two_factor, true, 'un autre client reste libre');
  r = await second(S, r.data.challenge, await freshCode(erin), { ip: '203.0.113.31' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Plafond propre à la seconde étape : 20 codes faux par quart d'heure pour un compte, tous clients confondus.
  const gus = await enrolled(S, 'gus@exemple.fr');
  for (const ip of ['203.0.113.40', '203.0.113.41', '203.0.113.42', '203.0.113.43']) {
    const c = (await login(S, gus.email, STRONG, { ip })).data.challenge;
    for (let i = 0; i < 5; i++) assert.equal((await second(S, c, wrongCode(gus.secret), { ip })).status, 401);
  }
  r = await login(S, gus.email, STRONG, { ip: '203.0.113.44' });
  assert.equal(r.data.two_factor, true, 'le mot de passe ne révèle rien du blocage de la seconde étape');
  r = await second(S, r.data.challenge, totp(gus.secret, Math.max(gus.lastStep + 1, stepNow())), { ip: '203.0.113.44' });
  assert.equal(r.status, 429, 'vingt codes faux répartis bloquent la seconde étape du compte'); assert.match(r.data.error, LOCK_MSG);
  step('verrouillage par couple (adresse, client) : 10 échecs bloquent ce client seulement (IPv4, ou /64 en IPv6), codes faux comptés, message neutre ; 20 codes faux par compte bloquent la seconde étape');

  /* ---------- 9. Plafond global par adresse ---------- */
  const flood = (email, count, base) => Promise.all(Array.from({ length: count }, async (_, c) => {
    for (let i = 0; i < 10; i++) { const x = await login(S, email, `Faux-mdp-${c}-${i}-w!`, { ip: `${base}.${c + 1}` }); assert.equal(x.status, 401, `${email} client ${c} échec ${i}`); }
  }));
  const hank = await signup(S, 'hank@exemple.fr');
  await flood(hank.email, 10, '192.0.2');
  r = await login(S, hank.email, STRONG, { ip: '192.0.2.200' });
  assert.equal(r.status, 429, '100 échecs répartis : l’adresse est bloquée pour tous'); assert.ok(Number(r.headers.get('retry-after')) > 0); assert.match(r.data.error, LOCK_MSG);
  await flood('inconnu@exemple.fr', 10, '192.0.3');
  r = await login(S, 'inconnu@exemple.fr', STRONG, { ip: '192.0.3.200' });
  assert.equal(r.status, 429, 'adresse inconnue : même plafond'); assert.equal(r.data.error, lockedMsg, 'message neutre');
  const ivy = await signup(S, 'ivy@exemple.fr');
  await flood(ivy.email, 5, '192.0.4');
  assert.equal((await login(S, ivy.email, STRONG, { ip: '192.0.4.100' })).status, 200, 'sous le plafond, l’abonnée se connecte');
  await flood(ivy.email, 5, '192.0.5');
  assert.equal((await login(S, ivy.email, STRONG, { ip: '192.0.5.100' })).status, 429, 'une connexion réussie ne remet pas le plafond global à zéro');
  step('plafond global : 100 échecs par quart d’heure depuis plusieurs clients bloquent l’adresse pour tous, compte existant ou non, sans remise à zéro par une connexion réussie');

  /* ---------- 10. Limitation de débit de la seconde étape ---------- */
  const ipD = '203.0.113.50';
  for (let i = 0; i < 30; i++) assert.equal((await call(S, 'POST', '/auth/login/2fa', { challenge: crypto.randomBytes(32).toString('base64url'), code: '123456' }, { ip: ipD })).status, 401);
  r = await call(S, 'POST', '/auth/login/2fa', { challenge: crypto.randomBytes(32).toString('base64url'), code: '123456' }, { ip: ipD });
  assert.equal(r.status, 429, 'trente essais par quart d’heure et par client'); assert.ok(Number(r.headers.get('retry-after')) > 0);
  step('seconde étape limitée en débit : 30 essais par quart d’heure et par client');

  /* ---------- 11. Suppression du compte : clé et codes effacés ---------- */
  assert.equal((await call(S, 'DELETE', '/account', { password: STRONG }, { cookie: bob.cookie })).status, 200);
  for (const t of ['user_totp', 'totp_recovery_codes', 'login_challenges']) assert.equal(S.db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`).get(bob.id).c, 0, `${t} purgée`);
  step('suppression du compte : clé, codes de secours et jetons de connexion effacés');

  /* ---------- 12. Administration : ADMIN_REQUIRE_2FA ---------- */
  {
    const P = await startServer('prod', { NODE_ENV: 'production', SESSION_SECRET: 'prod-secret-for-twofactor-suite-0123456789abcdef', ADMIN_EMAILS: 'chef@test.fr' });
    const chef = await signup(P, 'chef@test.fr');
    assert.match(chef.cookie, /^__Host-oubli_sid=/, 'serveur en mode production');
    P.db.prepare(`UPDATE users SET role = 'admin', email_verified_at = ? WHERE id = ?`).run(new Date().toISOString(), chef.id);   // comme « npm run admin -- promote »
    for (const [m, p] of [['GET', '/admin/stats'], ['GET', '/admin/users'], ['POST', '/admin/tick']]) {
      r = await call(P, m, p, m === 'POST' ? {} : undefined, { cookie: chef.cookie });
      assert.equal(r.status, 403, `${m} ${p}`); assert.equal(r.data.code, 'two_factor_required'); assert.match(r.data.error, /double authentification/);
    }
    const member = await signup(P, 'membre@test.fr');
    r = await call(P, 'GET', '/admin/stats', undefined, { cookie: member.cookie });
    assert.equal(r.status, 403); assert.equal(r.data.code, undefined, 'un non-administrateur reçoit le refus habituel');
    assert.equal((await call(P, 'GET', '/auth/2fa', undefined, { cookie: chef.cookie })).data.admin_required, true, 'obligation signalée à l’administrateur');
    let x = await call(P, 'POST', '/auth/2fa/setup', { password: STRONG }, { cookie: chef.cookie });
    chef.secret = x.data.secret;
    x = await call(P, 'POST', '/auth/2fa/enable', { code: await freshCode(chef) }, { cookie: chef.cookie });
    assert.equal(x.status, 200); chef.codes = x.data.recovery_codes;
    assert.equal((await call(P, 'GET', '/admin/stats', undefined, { cookie: chef.cookie })).status, 200, 'administration ouverte une fois la double authentification active');
    x = await login(P, chef.email);
    assert.equal(x.data.two_factor, true);
    x = await second(P, x.data.challenge, await freshCode(chef));
    assert.equal(x.status, 200); assert.match(x.cookie, /^__Host-oubli_sid=/);
    const chef2 = x.cookie;
    assert.equal((await call(P, 'GET', '/admin/stats', undefined, { cookie: chef2 })).status, 200);
    // Accès support : la session ouverte est celle de l'abonné, en lecture seule (règles existantes).
    x = await call(P, 'POST', `/admin/users/${member.id}/impersonate`, { reason: 'ticket 42' }, { cookie: chef2 });
    assert.equal(x.status, 200, JSON.stringify(x.data));
    const sup = x.cookie;
    x = await call(P, 'GET', '/admin/stats', undefined, { cookie: sup });
    assert.equal(x.status, 403); assert.equal(x.data.code, undefined, 'accès support : pas d’administration');
    x = await call(P, 'POST', '/auth/2fa/setup', { password: STRONG }, { cookie: sup });
    assert.equal(x.status, 403); assert.match(x.data.error, /lecture seule/);
    assert.equal((await call(P, 'GET', '/auth/2fa', undefined, { cookie: sup })).status, 200, 'consultation permise');
    x = await call(P, 'POST', '/auth/2fa/disable', { password: STRONG, code: chef.codes[0] }, { cookie: chef2 });
    assert.equal(x.status, 200);
    x = await call(P, 'GET', '/admin/stats', undefined, { cookie: chef2 });
    assert.equal(x.status, 403); assert.equal(x.data.code, 'two_factor_required', 'désactivée : l’administration se referme');
    const F = await startServer('force', { ADMIN_REQUIRE_2FA: 'on' });
    const fadm = await signup(F, 'admin@test.fr');
    x = await call(F, 'GET', '/admin/stats', undefined, { cookie: fadm.cookie });
    assert.equal(x.status, 403); assert.equal(x.data.code, 'two_factor_required', 'ADMIN_REQUIRE_2FA=on hors production');
  }
  step('administration : en production (ou ADMIN_REQUIRE_2FA=on), 403 two_factor_required tant que la double authentification n’est pas active ; accès support inchangé');

  for (const s of servers) assert.ok(!/TypeError|RangeError|ReferenceError|→ 500/.test(s.err), `erreurs serveur (${s.name}) :\n${s.err}`);
  console.log(`✔ Double authentification et verrouillage validés (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err.trim()) console.error(`[${s.name}]`, s.err.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  for (const s of servers) { try { s.db?.close(); } catch {} }
  // Attendre l'arrêt de chaque serveur avant de supprimer le dossier temporaire où il écrit encore.
  await Promise.all(servers.map((s) => (s.proc.exitCode !== null ? null : new Promise((r) => { s.proc.once('exit', r); s.proc.kill(); setTimeout(r, 5000).unref(); }))));
  fs.rmSync(tmp, { recursive: true, force: true });
}
