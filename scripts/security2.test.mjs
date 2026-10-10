// Tests de sécurité, seconde série (audit) : découverte des sites ajoutés (expressions à coût quadratique).
// Les groupes réseau démarrent leurs propres serveurs sur des ports libres, avec une base et une boîte d'envoi temporaires.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { discoverContact } from '../server/sitediscovery.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oubli-sec2-'));
const servers = [];
let passed = 0;
const step = (name) => { passed += 1; console.log(`  ✔ ${name}`); };
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
