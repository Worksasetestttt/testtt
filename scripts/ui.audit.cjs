// Audit navigateur de l'application (Playwright, hors `npm test` : Playwright n'est pas une dépendance du projet).
// Démarre son propre serveur sur une base temporaire, crée une abonnée avec des réponses variées de courtiers, puis
// vérifie à 1280 et 390 px : tableau de bord, tuiles, tiroir de détail, plainte, « Vérification faite », raccourci « / »,
// focus pendant le rafraîchissement, autres vues, double authentification (paramètres, étape « code » de la connexion,
// code de secours, réinitialisation), onglets de l'administration (après l'invitation à activer la double
// authentification, exigée ici comme en production). Échoue (code 1) au premier constat.
//   npm run test:ui                      (Playwright cherché dans node_modules, puis dans /opt/node-tools)
//   PLAYWRIGHT_MODULE=/chemin/playwright npm run test:ui
//   UI_SHOTS=dossier npm run test:ui     (captures d'écran dans ce dossier)
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function loadPlaywright() {
  for (const m of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) {
    try { return require(m); } catch { /* suivant */ }
  }
  console.error('✘ Playwright introuvable : définissez PLAYWRIGHT_MODULE (le navigateur doit déjà être installé).');
  process.exit(2);
}
const pw = loadPlaywright();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-ui-'));
const STRONG = 'Corde-a-linge-78!', RENEWED = 'Nouvelle-phrase-solide-42';
const OUTBOX = path.join(tmp, 'outbox');
// Codes TOTP (RFC 6238 : HMAC-SHA1, 6 chiffres, 30 s) calculés ici à partir de la clé affichée par l'application.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32decode = (s) => { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) { v = ((v << 5) | B32.indexOf(ch)) & 0xffff; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const stepNow = () => Math.floor(Date.now() / 30000);
function totp(secret, step = stepNow()) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  return String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function wrongCode(secret) { const valid = new Set([-1, 0, 1, 2].map((d) => totp(secret, stepNow() + d))); for (;;) { const c = String(crypto.randomInt(1000000)).padStart(6, '0'); if (!valid.has(c)) return c; } }
// Lien de réinitialisation reçu dans la boîte d'envoi locale (fichier complet : signature finale).
async function resetToken(email, before) {
  for (let i = 0; i < 80; i++) {
    const list = fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).filter((f) => f.endsWith(`-${email}.eml`)).sort() : [];
    if (list.length > before) {
      const text = fs.readFileSync(path.join(OUTBOX, list[list.length - 1]), 'utf8'), m = text.match(/#reset\?token=([A-Za-z0-9_-]{43})/);
      if (m && /L’équipe Oubli\n$/.test(text)) return m[1];
    }
    await wait(100);
  }
  throw new Error(`aucun lien de réinitialisation pour ${email}`);
}
const mailCount = (email) => (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).filter((f) => f.endsWith(`-${email}.eml`)).length : 0);
const SHOTS = process.env.UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// Port attribué par le système (plage éphémère) : les suites de `npm test` tirent le leur au hasard entre 3900 et 6000 et
// peuvent tourner en même temps. Sur un port déjà pris, notre serveur s'arrêterait et l'audit parlerait à un autre.
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
let BASE = '', server = null, serverErr = '', stopping = false;
async function startServer() {
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  // ADMIN_REQUIRE_2FA=on : l'administration exige la double authentification, comme en production (un administrateur
  // par largeur, pour voir l'invitation à l'activer aux deux largeurs).
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: path.join(tmp, 'ui.sqlite'), OUTBOX_DIR: OUTBOX, DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', SESSION_SECRET: 'ui-audit-secret-0123456789abcdef0123', ADMIN_EMAILS: 'adm.1280@exemple.fr,adm.390@exemple.fr', ADMIN_REQUIRE_2FA: 'on', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off' };
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', (x) => { serverErr += x; });
  server.on('exit', (code, sig) => { if (!stopping) note(`le serveur de l’audit s’est arrêté (code ${code ?? sig})`); });
  for (let i = 0; i < 60 && server.exitCode === null; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* démarrage */ } await wait(250); }
  if (server.exitCode !== null) throw new Error('serveur de l’audit arrêté au démarrage');
}
const findings = [];
const note = (s) => { findings.push(s); console.log('  ✘ ' + s); }, ok = (s) => console.log('  ✔ ' + s), wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name, full = false) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full }) : null);

async function api(page, method, p, body) {
  return page.evaluate(async ([m, u, b]) => { const r = await fetch('/api' + u, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); let d = {}; try { d = await r.json(); } catch (e) { /* vide */ } return { status: r.status, data: d }; }, [method, p, body]);
}
// Débordement horizontal (document et feuilles) de 360 à 1280 px, identifiants dupliqués ; cibles tactiles à 390 px.
async function layout(page, name, width) {
  const bad = [];
  for (const w of [360, 390, 768, 820, 1024, 1280]) {
    await page.setViewportSize({ width: w, height: 900 }); await wait(200);
    const r = await page.evaluate(() => {
      const ids = {}; document.querySelectorAll('[id]').forEach((e) => { ids[e.id] = (ids[e.id] || 0) + 1; });
      const doc = document.documentElement;
      return { dup: Object.keys(ids).filter((k) => ids[k] > 1), over: doc.scrollWidth > doc.clientWidth ? doc.scrollWidth : 0,
        sheets: [...document.querySelectorAll('.sheet')].filter((s) => s.offsetParent && s.scrollWidth > s.clientWidth + 1).map((s) => s.className.split(' ').slice(0, 2).join('.')) };
    });
    if (r.dup.length) note(`${name} à ${w} px : identifiants dupliqués ${r.dup.join(', ')}`);
    if (r.over) bad.push(`${w} px (document ${r.over})`); if (r.sheets.length) bad.push(`${w} px (${r.sheets.join(', ')})`);
  }
  await page.setViewportSize({ width, height: 900 }); await wait(200);
  if (bad.length) note(`${name} : débordement à ${bad.join(', ')}`); else ok(`${name} : aucun débordement de 360 à 1280 px`);
  if (width <= 400) {
    const small = await page.evaluate(() => [...document.querySelectorAll('header a, header button, main button, main a, main input, main select, main summary, dialog[open] button, dialog[open] a, dialog[open] input, dialog[open] summary')].filter((e) => {
      if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') return false;
      if (e.classList.contains('row__open')) return false;   // toute la ligne est la cible
      // Case à cocher ou bouton radio dans son libellé : c'est le libellé entier qu'on touche.
      const box = e.matches('input[type=checkbox], input[type=radio]') && e.closest('label') ? e.closest('label') : e;
      const r = box.getBoundingClientRect(); if (!r.width) return false;
      const after = getComputedStyle(e, '::after'); const ext = after && after.content !== 'none' && after.position === 'absolute';
      return !ext && (r.height < 43.5 || r.width < 24);
    }).map((e) => (e.id || e.className || e.tagName) + ' « ' + (e.textContent || e.name || '').trim().slice(0, 24) + ' » ' + Math.round(e.getBoundingClientRect().width) + '×' + Math.round(e.getBoundingClientRect().height)).slice(0, 10));
    if (small.length) note(`${name} : cibles tactiles sous 44 px : ${small.join(', ')}`); else ok(`${name} : cibles tactiles d’au moins 44 px`);
  }
}

async function scenario(browser, width) {
  console.log(`— ${width} px`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 } }), page = await ctx.newPage(), errors = [];
  // Erreur HTTP provoquée exprès (code faux) : une réponse et son message console sont tolérés, une seule fois.
  const allowed = [], allow = (p) => allowed.push({ p, http: 1, con: 1 });
  const take = (url, kind) => { let p = ''; try { p = new URL(url).pathname; } catch { /* pas d'adresse */ } const a = allowed.find((x) => x.p === p && x[kind] > 0); if (a) a[kind] -= 1; return !!a; };
  page.on('console', (m) => { if (m.type() === 'error' && !take((m.location() || {}).url, 'con')) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !take(r.url(), 'http')) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  for (const route of ['login', 'signup', 'forgot', 'reset', 'verify', 'unsubscribe']) {
    await page.goto(`${BASE}/app/?auth=${width}#${route}`); await page.waitForSelector('.auth'); await shot(page, `${route}-${width}`, true);
    await layout(page, `#${route}`, width);
  }
  const octx = await browser.newContext({ viewport: { width, height: 900 } }), op = await octx.newPage();
  op.on('pageerror', (e) => errors.push('ouverture : ' + e.message));
  await op.goto(BASE + '/app/#login'); await op.waitForSelector('#login-form');
  await api(op, 'POST', '/auth/signup', { email: `lea.${width}@exemple.fr`, password: STRONG, plan: 'individuel' });
  const opid = (await api(op, 'GET', '/me')).data.profiles[0].id;
  await api(op, 'PUT', '/profiles/' + opid, { first_name: 'Léa', last_name: 'Fontaine' });
  await api(op, 'POST', '/mandate', { full_name: 'Léa Fontaine', accepted: true });
  await op.goto(`${BASE}/app/?offre=${width}#onboarding`); await op.waitForSelector('.keybox__sum'); await op.click('.keybox__sum');
  if (!(await op.$('#key-input:visible'))) note('le bloc « Vous avez une clé d’activation ? » ne s’ouvre pas');
  await shot(op, `offre-${width}`, true);
  await layout(op, 'ouverture : offre et clé d’activation', width);
  await octx.close();
  await page.goto(BASE + '/app/#login'); await page.waitForSelector('#login-form');
  await api(page, 'POST', '/auth/signup', { email: `ines.${width}@exemple.fr`, password: STRONG, plan: 'famille' });
  const pid = (await api(page, 'GET', '/me')).data.profiles[0].id;
  await api(page, 'PUT', '/profiles/' + pid, { first_name: 'Inès', last_name: 'Garnier', emails: ['ines.garnier@exemple.fr'] });
  await api(page, 'POST', '/profiles', { first_name: 'Louis', last_name: 'Garnier' });
  await api(page, 'POST', '/mandate', { full_name: 'Inès Garnier', accepted: true });
  await api(page, 'POST', '/billing/checkout', { plan: 'famille' });
  await api(page, 'POST', '/requests/launch', {});
  const actx = await browser.newContext({ viewport: { width, height: 900 } }), ap = await actx.newPage(); await ap.goto(BASE + '/app/#login');
  await api(ap, 'POST', '/auth/signup', { email: `adm.${width}@exemple.fr`, password: STRONG });
  // Double authentification exigée : le panel laisse place à une invitation claire, puis s'ouvre une fois activée.
  await ap.goto(`${BASE}/app/?gate=${width}#admin`); await ap.waitForSelector('.adm-gate', { timeout: 15000 });
  const gate = await ap.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, rail: !!document.querySelector('.adm__rail'), cta: (document.querySelector('.adm-gate .btn') || {}).getAttribute?.('href') }));
  if (gate.focus !== 'adm-gate-h' || gate.rail || gate.cta !== '#settings?twofa=1') note(`administration protégée : ${JSON.stringify(gate)}`); else ok('administration protégée : invitation vers les paramètres, focus sur la carte');
  await shot(ap, `admin-gate-${width}`, true);
  await layout(ap, 'administration : double authentification requise', width);
  const adminKey = (await api(ap, 'POST', '/auth/2fa/setup', { password: STRONG })).data.secret;
  if ((await api(ap, 'POST', '/auth/2fa/enable', { code: totp(adminKey) })).status !== 200) note('double authentification de l’administrateur non activée');
  await api(ap, 'POST', '/admin/tick', {}); await wait(800);
  const sent = (await api(page, 'GET', '/dashboard?profile_id=' + pid)).data.requests.filter((x) => x.status === 'sent');
  const plan = [...Array(12).fill('done'), 'action_required', 'refused', ...Array(5).fill('in_progress')];
  for (let i = 0; i < plan.length && i < sent.length; i++) await api(ap, 'POST', `/admin/requests/${sent[i].id}/outcome`, { outcome: plan[i], note: plan[i] === 'refused' ? 'Données conservées pour obligations légales' : '' });

  await page.goto(BASE + '/app/?audit=' + width + '#dashboard'); await page.waitForSelector('#dash-overview', { timeout: 15000 });
  await page.fill('#addsite-url', `https://annuaire-${width}.example-pages.fr/fiche/ines-garnier`);
  await page.click('#addsite-form button[type=submit]'); await page.waitForSelector('.row__open'); await wait(900);
  await shot(page, `dash-${width}`, true);
  await layout(page, 'tableau de bord', width);
  await page.click('button.tile--done'); await wait(300);
  if (await page.getAttribute('#dash-filters [data-filter="done"]', 'aria-pressed') !== 'true') note('la tuile « Effacées » ne filtre pas la liste'); else ok('tuile « Effacées » → filtre');
  await page.click('.row--done .row__open'); await page.waitForSelector('dialog#drawer[open] .dstatus', { timeout: 8000 }); await wait(400);
  if (!(await page.evaluate(() => document.getElementById('drawer').contains(document.activeElement)))) note('focus hors du tiroir à l’ouverture'); else ok('tiroir ouvert, focus à l’intérieur');
  await shot(page, `drawer-${width}`);
  await layout(page, 'tiroir de détail', width);
  await page.keyboard.press('Escape'); await wait(300);
  if (!(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('row__open')))) note('Échap ne rend pas le focus à la ligne'); else ok('Échap ferme le tiroir et rend le focus à la ligne');
  await page.click('#dash-filters [data-filter="all"]'); await wait(300);
  const complaint = await page.$('.row--refused [data-section="complaint"]');
  if (!complaint) note('pas de « Préparer la plainte » sur la ligne refusée');
  else { await complaint.click(); await page.waitForSelector('#complaint-box .mail-body', { timeout: 8000 }); if (!/Plainte contre/.test(await page.textContent('#complaint-box .mail-body'))) note('texte de plainte absent'); else ok('plainte rédigée dans le tiroir'); await page.click('#drawer [data-close]'); await wait(300); }
  const ar = await page.$('.row--action_required .row__open');
  if (ar) { await ar.click(); await page.waitForSelector('#drawer [data-resolve]', { timeout: 8000 }); await page.click('#drawer [data-resolve]'); await wait(1500); if (/Action requise/.test(await page.textContent('#drawer .dstatus .chip'))) note('« Vérification faite » sans effet'); else ok('« Vérification faite » depuis le tiroir'); await page.keyboard.press('Escape'); await wait(300); }
  await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('/');
  if (await page.evaluate(() => document.activeElement && document.activeElement.id) !== 'broker-search') note('« / » ne place pas le focus dans la recherche'); else ok('« / » → recherche');
  // Rafraîchissement : le focus reste dans la recherche, et une donnée inchangée revient en 304 sans corps (ETag).
  const polls = [], onPoll = (r) => { if (new URL(r.url()).pathname === '/api/dashboard') polls.push(r.status()); };
  page.on('response', onPoll);
  await page.keyboard.type('a'); await wait(6800);
  page.off('response', onPoll);
  if (await page.evaluate(() => document.activeElement && document.activeElement.id) !== 'broker-search') note('focus perdu pendant le rafraîchissement'); else ok('focus conservé pendant le rafraîchissement');
  if (!polls.includes(304)) note(`rafraîchissement sans réponse 304 (${polls.join(', ') || 'aucune requête'})`); else ok('rafraîchissement conditionnel : 304 quand rien ne change');
  for (const route of ['report', 'dossier', 'billing', 'settings']) {
    await page.goto(BASE + '/app/#' + route); await wait(1000); await shot(page, `${route}-${width}`, true);
    await layout(page, `#${route}`, width);
  }
  // Double authentification de l'abonnée : mise en place depuis les paramètres (clé, premier code, codes de secours).
  const email = `ines.${width}@exemple.fr`;
  await page.waitForSelector('#tfa-start'); await page.click('#tfa-start'); await page.waitForSelector('#f-tfa-password');
  await page.fill('#f-tfa-password', STRONG); await page.click('#tfa-setup-form button[type=submit]'); await page.waitForSelector('#tfa-secret');
  const key = (await page.textContent('#tfa-secret')).trim(), otpauth = await page.getAttribute('#tfa-open', 'href');
  if (!/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/.test(key) || !otpauth.startsWith(`otpauth://totp/Oubli:${encodeURIComponent(email)}?secret=${key.replace(/ /g, '')}&issuer=Oubli`)) note(`clé de configuration ou lien otpauth : ${key} · ${otpauth}`);
  if (await page.evaluate(() => document.activeElement && document.activeElement.id) !== 'tfa-step-h') note('double authentification : focus hors du titre de l’étape 2'); else ok('double authentification : clé groupée par 4, lien otpauth, focus sur l’étape 2');
  await shot(page, `tfa-key-${width}`, true);
  await layout(page, 'paramètres : clé de double authentification', width);
  await page.fill('#f-tfa-code', totp(key)); await page.click('#tfa-enable-form button[type=submit]'); await page.waitForSelector('#tfa-codes-h');
  const recovery = await page.$$eval('.tfa-codes code', (c) => c.map((x) => x.textContent));
  if (recovery.length !== 10 || await page.evaluate(() => document.activeElement && document.activeElement.id) !== 'tfa-codes-h') note(`codes de secours : ${recovery.length} affichés`); else ok('10 codes de secours affichés une fois, focus sur leur titre');
  await shot(page, `tfa-codes-${width}`, true);
  await layout(page, 'paramètres : codes de secours', width);
  await page.click('#tfa-codes-done'); await page.waitForSelector('#tfa-regen');
  await layout(page, 'paramètres : double authentification active', width);
  // Connexion en deux étapes : aucune session avant le code ; code faux annoncé ; code de secours. L'horloge du navigateur
  // est avancée d'une heure pendant la connexion : l'étape « code » doit s'afficher quand même (le serveur juge l'expiration).
  await page.click('#logout'); await page.waitForSelector('#login-form');
  await page.evaluate(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 3600000; });
  await page.fill('#f-email', email); await page.fill('#f-password', STRONG); await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#code-form', { timeout: 8000 });
  await page.evaluate(() => { Date.now = window.__realNow; });
  const cs = await page.evaluate(() => { const i = document.getElementById('f-code'); return { focus: document.activeElement === i, mode: i.getAttribute('inputmode'), ac: i.getAttribute('autocomplete'), link: (document.getElementById('code-switch') || {}).textContent }; });
  if (!cs.focus || cs.mode !== 'numeric' || cs.ac !== 'one-time-code' || cs.link !== 'Utiliser un code de secours') note(`étape « code » : ${JSON.stringify(cs)}`); else ok('étape « code » : focus, inputmode="numeric", autocomplete="one-time-code", « Utiliser un code de secours »');
  if ((await api(page, 'GET', '/me')).data.user) note('session ouverte avant le code');
  await shot(page, `login-code-${width}`, true);
  await layout(page, '#login : étape « code »', width);
  allow('/api/auth/login/2fa');
  await page.fill('#f-code', wrongCode(key.replace(/ /g, ''))); await page.click('#code-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('msg-code-form').textContent.length > 0);
  const ce = await page.evaluate(() => { const m = document.getElementById('msg-code-form'), i = document.getElementById('f-code'); return { role: m.getAttribute('role'), focus: document.activeElement === i, invalid: i.getAttribute('aria-invalid'), text: m.textContent }; });
  if (ce.role !== 'alert' || !ce.focus || ce.invalid !== 'true' || !/^Code incorrect ou déjà utilisé\u00a0: /.test(ce.text)) note(`code faux mal annoncé : ${JSON.stringify(ce)}`); else ok('code faux : message role="alert", aria-invalid, focus sur le champ');
  await page.click('#code-switch'); await page.waitForSelector('label[for="f-code"]');
  if (await page.textContent('label[for="f-code"]') !== 'Code de secours') note('« Utiliser un code de secours » sans effet');
  await layout(page, '#login : code de secours', width);
  await page.fill('#f-code', recovery[0]); await page.click('#code-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('code-form'), null, { timeout: 8000 });
  if (!(await api(page, 'GET', '/me')).data.user) note('pas de session après le code de secours'); else ok('connexion avec un code de secours');
  // Réinitialisation du mot de passe : aucune session sans le code, retour à la connexion avec un message.
  const mailsBefore = mailCount(email);
  await api(page, 'POST', '/auth/forgot', { email });
  await page.goto(`${BASE}/app/?reset=${width}#reset?token=${await resetToken(email, mailsBefore)}`); await page.waitForSelector('#reset-form');
  await page.fill('#f-password', RENEWED); await page.fill('#f-confirm', RENEWED); await page.click('#reset-form button[type=submit]');
  await page.waitForFunction(() => /double authentification/.test((document.getElementById('msg-login-form') || {}).textContent || ''), null, { timeout: 8000 });
  if ((await api(page, 'GET', '/me')).data.user || !/#login$/.test(page.url())) note('réinitialisation : session ouverte sans le code, ou pas de retour à la connexion'); else ok('réinitialisation : retour à la connexion, aucune session sans le code');
  await page.fill('#f-email', email); await page.fill('#f-password', RENEWED); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#code-form');
  await page.click('#code-switch'); await page.fill('#f-code', recovery[1]); await page.click('#code-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('code-form'), null, { timeout: 8000 });
  // Administration
  await ap.setViewportSize({ width, height: 900 });
  ap.on('console', (m) => { if (m.type() === 'error') errors.push('admin : ' + m.text()); }); ap.on('pageerror', (e) => errors.push('admin : ' + e.message));
  await ap.goto(BASE + '/app/?admin=1#admin'); await ap.waitForSelector('.adm__tab', { timeout: 15000 });
  const tabs = await ap.$$eval('.adm__tab', (a) => a.map((x) => x.getAttribute('href')));
  for (const t of tabs) { await ap.goto(BASE + '/app/' + t); await wait(700); if (await ap.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) note(`admin ${t} : débordement horizontal`); }
  ok(`${tabs.length} onglets d’administration affichés`);
  const uid = (await api(page, 'GET', '/me')).data.user.id;
  await ap.goto(`${BASE}/app/#admin?tab=users&id=${uid}`); await ap.waitForSelector('.adm-back', { timeout: 10000 }); await wait(500); await shot(ap, `admin-user-${width}`, true);
  await layout(ap, 'administration : fiche du compte', width);
  const errs = [...new Set(errors)];
  if (errs.length) note('erreurs console ou HTTP : ' + errs.join(' | ')); else ok('aucune erreur console ni HTTP');
  await actx.close(); await ctx.close();
}

(async () => {
  let browser;
  try {
    await startServer();
    browser = await pw.chromium.launch();
    for (const w of [1280, 390]) await scenario(browser, w);
  } catch (e) {
    note('exception : ' + e.message);
    if (serverErr.trim()) console.error(serverErr.split('\n').slice(-10).join('\n'));
  } finally {
    if (browser) await browser.close();
    stopping = true; if (server) server.kill(); fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(findings.length ? `✘ Audit navigateur : ${findings.length} constat(s).` : '✔ Audit navigateur propre (1280 et 390 px).');
  process.exitCode = findings.length ? 1 : 0;
})();
