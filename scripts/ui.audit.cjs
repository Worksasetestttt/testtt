// Audit navigateur de l'application (Playwright, hors `npm test` : Playwright n'est pas une dépendance du projet).
// Démarre son propre serveur sur une base temporaire, crée une abonnée avec des réponses variées de courtiers, puis
// vérifie à 1280 et 390 px : tableau de bord, tuiles, tiroir de détail, plainte, « Vérification faite », raccourci « / »,
// focus pendant le rafraîchissement, autres vues, onglets de l'administration. Échoue (code 1) au premier constat.
//   npm run test:ui                      (Playwright cherché dans node_modules, puis dans /opt/node-tools)
//   PLAYWRIGHT_MODULE=/chemin/playwright npm run test:ui
//   UI_SHOTS=dossier npm run test:ui     (captures d'écran dans ce dossier)
const { spawn } = require('node:child_process');
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
const STRONG = 'Corde-a-linge-78!';
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
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: path.join(tmp, 'ui.sqlite'), OUTBOX_DIR: path.join(tmp, 'outbox'), DEMO_MODE: 'false', SMTP_URL: '', STRIPE_SECRET_KEY: '', SESSION_SECRET: 'ui-audit-secret-0123456789abcdef0123', ADMIN_EMAILS: 'admin@test.fr', SCHEDULER_INTERVAL_MS: '600000', NODE_ENV: 'test', SITE_DISCOVERY: 'off' };
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
    const small = await page.evaluate(() => [...document.querySelectorAll('main button, main a, main input, main select, dialog[open] button, dialog[open] a, dialog[open] input, dialog[open] summary')].filter((e) => {
      if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') return false;
      const r = e.getBoundingClientRect(); if (!r.width) return false;
      if (e.classList.contains('row__open')) return false;   // toute la ligne est la cible
      const after = getComputedStyle(e, '::after'); const ext = after && after.content !== 'none' && after.position === 'absolute';
      return !ext && (r.height < 43.5 || r.width < 24);
    }).map((e) => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + '×' + Math.round(e.getBoundingClientRect().height)).slice(0, 10));
    if (small.length) note(`${name} : cibles tactiles sous 44 px : ${small.join(', ')}`); else ok(`${name} : cibles tactiles d’au moins 44 px`);
  }
}

async function scenario(browser, width) {
  console.log(`— ${width} px`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 } }), page = await ctx.newPage(), errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(BASE + '/app/#login'); await page.waitForSelector('#login-form');
  await api(page, 'POST', '/auth/signup', { email: `ines.${width}@exemple.fr`, password: STRONG, plan: 'famille' });
  const pid = (await api(page, 'GET', '/me')).data.profiles[0].id;
  await api(page, 'PUT', '/profiles/' + pid, { first_name: 'Inès', last_name: 'Garnier', emails: ['ines.garnier@exemple.fr'] });
  await api(page, 'POST', '/profiles', { first_name: 'Louis', last_name: 'Garnier' });
  await api(page, 'POST', '/mandate', { full_name: 'Inès Garnier', accepted: true });
  await api(page, 'POST', '/billing/checkout', { plan: 'famille' });
  await api(page, 'POST', '/requests/launch', {});
  const actx = await browser.newContext(), ap = await actx.newPage(); await ap.goto(BASE + '/app/#login');
  if ((await api(ap, 'POST', '/auth/login', { email: 'admin@test.fr', password: STRONG })).status !== 200) await api(ap, 'POST', '/auth/signup', { email: 'admin@test.fr', password: STRONG });
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
  await page.keyboard.type('a'); await wait(6800);
  if (await page.evaluate(() => document.activeElement && document.activeElement.id) !== 'broker-search') note('focus perdu pendant le rafraîchissement'); else ok('focus conservé pendant le rafraîchissement');
  for (const route of ['report', 'dossier', 'billing', 'settings']) {
    await page.goto(BASE + '/app/#' + route); await wait(1000); await shot(page, `${route}-${width}`, true);
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) note(`#${route} : débordement horizontal`);
  }
  ok('rapport, dossier, abonnement, paramètres affichés');
  // Administration
  await ap.setViewportSize({ width, height: 900 });
  ap.on('console', (m) => { if (m.type() === 'error') errors.push('admin : ' + m.text()); }); ap.on('pageerror', (e) => errors.push('admin : ' + e.message));
  await ap.goto(BASE + '/app/?admin=1#admin'); await ap.waitForSelector('.adm__tab', { timeout: 15000 });
  const tabs = await ap.$$eval('.adm__tab', (a) => a.map((x) => x.getAttribute('href')));
  for (const t of tabs) { await ap.goto(BASE + '/app/' + t); await wait(700); if (await ap.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) note(`admin ${t} : débordement horizontal`); }
  ok(`${tabs.length} onglets d’administration affichés`);
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
