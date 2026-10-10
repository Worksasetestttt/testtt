// Point d'entrée : sert la landing page (/), l'application (/app) et l'API (/api).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUser } from './auth.js';
import { api, stripeWebhook } from './routes.js';
import { startScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), stripeWebhook);
app.use(express.json({ limit: '200kb' }));
app.use(attachUser);
app.use('/api', api);
app.use('/api', (err, _req, res, _next) => { console.error(err); res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: err.type === 'entity.parse.failed' ? 'JSON invalide.' : 'Erreur interne.' }); });
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));

const staticOpts = { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, extensions: ['html'] };
app.use('/assets', express.static(path.join(ROOT, 'assets'), staticOpts));
app.use('/app', express.static(path.join(ROOT, 'app'), staticOpts));
app.get(['/app', '/app/*splat'], (_req, res) => res.sendFile(path.join(ROOT, 'app', 'index.html')));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use((_req, res) => res.redirect('/'));

app.listen(PORT, () => {
  console.log(`Oubli · http://localhost:${PORT}  (landing)  ·  http://localhost:${PORT}/app/  (application)`);
  startScheduler();
});
