// Tests de sécurité, seconde série (audit) : découverte des sites ajoutés (expressions à coût quadratique, durée totale
// d'une lecture).
// Les groupes réseau démarrent leurs propres serveurs sur des ports libres, avec une base et une boîte d'envoi temporaires.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { discoverContact, safeFetch } from '../server/sitediscovery.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-sec2-'));
const servers = [];
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };

try {
  /* ---------- 1. Découverte : une page hostile ne bloque pas le serveur ---------- */
  // Le serveur est mono-processus : une expression à coût quadratique sur une page de 600 Ko gèle toutes les requêtes
  // pendant des minutes. Chaque page ci-dessous prenait plusieurs secondes ; elles doivent être lues en quelques millisecondes.
  const hostile = [
    ['balises <title jamais fermées', '<title'.repeat(30000)],
    ['espaces sans [at]', `${' '.repeat(60000)}x`],
    ['liens <a jamais fermés', '<a'.repeat(40000)],
  ];
  for (const [label, html] of hostile) {
    const t = await elapsed(() => discoverContact('piege.fr', { fetchPage: async (url) => ({ url, html }), maxPages: 1 }));
    assert.ok(t < 1000, `découverte bloquante (${label}) : ${Math.round(t)} ms`);
  }
  const big = `${'<title'.repeat(20000)}${' '.repeat(100000)}${'<a'.repeat(50000)}${'<a href="'.repeat(20000)}${'x@'.repeat(30000)}${'a'.repeat(100000)}`.slice(0, 600000);
  const tBig = await elapsed(() => discoverContact('piege.fr', { fetchPage: async (url) => ({ url, html: big }), maxPages: 1 }));
  assert.ok(tBig < 2000, `page hostile de 600 Ko : ${Math.round(tBig)} ms`);
  const ok = await discoverContact('site.fr', { fetchPage: async (url) => ({ url, html: url === 'https://site.fr/' ? '<title>Site</title><a class="x" data-href="/faux" href="/infos/mentions">Mentions légales</a>' : 'Écrivez à rgpd [at] site.fr' }) });
  assert.equal(ok.email, 'rgpd@site.fr'); assert.equal(ok.page, 'https://site.fr/infos/mentions'); assert.equal(ok.title, 'Site');
  step('découverte : pages hostiles de 600 Ko lues en temps linéaire, extraction et liens légaux inchangés');

  /* ---------- 2. Découverte : durée totale d'une lecture plafonnée ---------- */
  // Un site qui envoie un octet toutes les 200 ms ne déclenche jamais le délai d'inactivité : sans plafond de durée totale,
  // la connexion (et la recherche du contact) reste ouverte indéfiniment.
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/rapide') return res.end('<title>Rapide</title>');
    const drip = setInterval(() => res.write('a'), 200);
    res.on('close', () => clearInterval(drip));
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const realRequest = http.request;
  // La connexion est redirigée vers le serveur local (la garde réseau refuserait 127.0.0.1) ; la logique de safeFetch est inchangée.
  http.request = (u, opts, cb) => realRequest.call(http, { host: '127.0.0.1', port: slow.address().port, path: u.pathname, method: 'GET', headers: opts.headers, timeout: opts.timeout }, cb);
  let guard;
  try {
    const t0 = Date.now();
    const outcome = await Promise.race([
      safeFetch('http://lent.example.com/', { timeoutMs: 800 }).then(() => 'résolue', (e) => `rejetée : ${e.message}`),
      new Promise((r) => { guard = setTimeout(() => r('toujours en cours'), 4000); }),
    ]);
    assert.match(outcome, /^rejetée : Délai dépassé/, `lecture au goutte-à-goutte : ${outcome} après ${Date.now() - t0} ms`);
    assert.ok(Date.now() - t0 < 2500, `délai total non respecté : ${Date.now() - t0} ms`);
    const fast = await safeFetch('http://rapide.example.com/rapide', { timeoutMs: 800 });
    assert.equal(fast.html, '<title>Rapide</title>', 'une réponse rapide est lue normalement');
  } finally { clearTimeout(guard); http.request = realRequest; slow.closeAllConnections(); slow.close(); }
  step('découverte : une réponse au goutte-à-goutte est coupée à la durée totale prévue');

  for (const s of servers) assert.ok(!/TypeError|RangeError|→ 500/.test(s.err), `erreurs serveur :\n${s.err}`);
  console.log(`✔ Sécurité (seconde série) validée (${passed} groupes de vérifications).`);
} catch (e) {
  console.error('✘ Échec :', e.message);
  for (const s of servers) if (s.err) console.error(s.err.slice(-1500));
  process.exitCode = 1;
} finally {
  for (const s of servers) s.proc.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
