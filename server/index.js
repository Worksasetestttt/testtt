// Point d'entrée : sert la landing page (/), l'application (/app) et l'API (/api).
// Chaîne de sécurité : en-têtes (CSP, COOP, CORP…) → corps brut du webhook Stripe (sans cookie) → JSON borné →
// session (sauf routes à jeton) → garde CSRF (Content-Type + Origin/Referer) → corps objet → routes → 404/erreurs JSON.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUser } from './auth.js';
import { api, stripeWebhook } from './routes.js';
import { startScheduler } from './scheduler.js';
import { HttpError, isPlainObject } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
// Origine publique de l'application (APP_URL) : acceptée en plus de l'hôte de la requête pour le contrôle d'origine.
const APP_ORIGIN = (() => { try { return new URL(process.env.APP_URL || '').origin; } catch { return null; } })();

const app = express();
app.disable('x-powered-by');
// TRUST_PROXY : nombre de proxys de confiance (1 derrière Render/Fly/Nginx), ou une liste d'adresses/CIDR pour Express.
const TP = String(process.env.TRUST_PROXY || '').trim();
app.set('trust proxy', TP ? (/^\d+$/.test(TP) ? Number(TP) : /^(true|yes)$/i.test(TP) ? 1 : TP) : false);
// Paramètres de requête : chaînes simples uniquement (pas de tableaux ni d'objets imbriqués), 200 caractères maximum.
app.set('query parser', (s) => {
  const out = {};
  try { for (const [k, v] of new URLSearchParams(s)) { if (k.startsWith('__') || k in out) continue; out[k] = v.slice(0, 200); } } catch { /* ignoré */ }
  return out;
});

/* ---------- En-têtes de sécurité ---------- */
// Les scripts en ligne des pages HTML sont autorisés par empreinte SHA-256 (calculée au démarrage sur le fichier servi).
const INLINE_SCRIPT = /<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const inlineScriptHashes = (file) => {
  try { return [...fs.readFileSync(file, 'utf8').matchAll(INLINE_SCRIPT)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`); }
  catch { return []; }
};
const SCRIPT_HASHES = [...new Set([...inlineScriptHashes(path.join(ROOT, 'index.html')), ...inlineScriptHashes(path.join(ROOT, 'app', 'index.html'))])];
const CSP = [
  "default-src 'self'",
  `script-src 'self'${SCRIPT_HASHES.length ? ` ${SCRIPT_HASHES.join(' ')}` : ''}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "object-src 'none'",
  ...(PROD ? ['upgrade-insecure-requests'] : []),
].join('; ');

app.use((req, res, next) => {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

/* ---------- API ---------- */
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
// Webhook Stripe : monté avant la session et l'analyse JSON → corps brut, cookies ignorés, signature seule.
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), stripeWebhook);
app.use('/api', express.json({ limit: '200kb' }));

// Routes authentifiées par jeton : les cookies y sont ignorés (aucune session attachée, pas de garde CSRF).
const TOKEN_ROUTES = new Set(['/api/inbound', '/api/billing/webhook']);
app.use((req, res, next) => {
  if (TOKEN_ROUTES.has(req.path.toLowerCase().replace(/\/+$/, ''))) { req.user = null; req.sessionId = null; req.tokenRoute = true; return next(); }
  attachUser(req, res, next);
});

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const sameOrigin = (req, value) => {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (APP_ORIGIN && u.origin === APP_ORIGIN) return true;
  const host = String(req.headers.host || '').toLowerCase();
  return !!host && u.host.toLowerCase() === host;
};
// Garde CSRF : les méthodes non sûres n'acceptent que du JSON (un formulaire HTML ne peut pas en produire)
// et, lorsque le navigateur fournit Origin ou Referer, l'origine doit être la nôtre.
app.use('/api', (req, res, next) => {
  if (!UNSAFE.has(req.method) || req.tokenRoute) return next();
  const ct = req.headers['content-type'];
  const hasBody = (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'];
  if ((ct !== undefined || hasBody) && String(ct || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return res.status(415).json({ error: 'Le corps de la requête doit être au format JSON (Content-Type : application/json).' });
  }
  const { origin, referer } = req.headers;
  if ((origin !== undefined && !sameOrigin(req, origin)) || (referer !== undefined && !sameOrigin(req, referer))) {
    return res.status(403).json({ error: 'Origine de la requête refusée.' });
  }
  next();
});
// Corps : toujours un objet JSON simple (absent → {}), jamais un tableau, une chaîne ou null.
app.use('/api', (req, res, next) => {
  if (!UNSAFE.has(req.method)) return next();
  if (req.body === undefined) { req.body = {}; return next(); }
  if (!isPlainObject(req.body)) return res.status(400).json({ error: 'Corps de requête invalide : un objet JSON est attendu.' });
  next();
});
app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// Gestionnaire d'erreurs : les erreurs client (4xx) reçoivent un message générique ou celui d'une HttpError ;
// les erreurs internes sont journalisées avec l'identifiant de requête et jamais détaillées au client.
const CLIENT_MESSAGES = { 400: 'Requête invalide.', 404: 'Route inconnue.', 405: 'Méthode non autorisée.', 413: 'Corps de requête trop volumineux.', 415: 'Format de requête non pris en charge.', 429: 'Trop de requêtes.' };
const PARSER_MESSAGES = { 'entity.parse.failed': 'JSON invalide.', 'entity.too.large': 'Corps de requête trop volumineux.', 'encoding.unsupported': 'Encodage non pris en charge.', 'charset.unsupported': 'Jeu de caractères non pris en charge.', 'request.aborted': 'Requête interrompue.' };
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 400 && status < 500) {
    const msg = (err instanceof HttpError && err.message) || PARSER_MESSAGES[err?.type] || CLIENT_MESSAGES[status] || 'Requête invalide.';
    return res.status(status).json({ error: msg });
  }
  console.error(`[api] ${req.method} ${req.originalUrl} → 500 (réf. ${req.id})`, err);
  res.status(500).json({ error: `Erreur interne. Référence : ${req.id}` });
});

/* ---------- Pages et ressources statiques ---------- */
const staticOpts = { maxAge: PROD ? '1h' : 0, extensions: ['html'], dotfiles: 'ignore' };
app.use('/assets', express.static(path.join(ROOT, 'assets'), staticOpts));
app.use('/app', express.static(path.join(ROOT, 'app'), staticOpts));
app.get(['/app', '/app/*splat'], (_req, res) => res.sendFile(path.join(ROOT, 'app', 'index.html')));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use((_req, res) => res.redirect('/'));
// Erreur hors API (chemin indéchiffrable, fichier illisible…) : page minimale sans détail.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) console.error(`[web] ${req.method} ${req.originalUrl} → 500 (réf. ${req.id})`, err);
  res.status(status).type('text/plain; charset=utf-8').send(status >= 500 ? `Erreur interne. Référence : ${req.id}` : 'Requête invalide.');
});

/* ---------- Processus ---------- */
process.on('unhandledRejection', (reason) => { console.error('[process] promesse rejetée non gérée :', reason); });
process.on('uncaughtException', (err) => { console.error('[process] exception non interceptée, arrêt propre :', err); shutdown(1); });

const server = app.listen(PORT, () => {
  console.log(`Oubli · http://localhost:${PORT}  (landing)  ·  http://localhost:${PORT}/app/  (application)`);
  startScheduler();
});
server.headersTimeout = 20000;   // en-têtes complets sous 20 s
server.requestTimeout = 60000;   // requête complète sous 60 s
server.keepAliveTimeout = 5000;

let stopping = false;
function shutdown(code) {
  if (stopping) return; stopping = true;
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
