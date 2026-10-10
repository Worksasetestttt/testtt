# Contrat d'intégration (flotte d'agents parallèles) — Oubli

Dépôt : /home/user/testtt (Node 22 ESM, Express 5, node:sqlite, zéro dépendance native). NE PAS commiter, NE PAS pousser : l'orchestrateur s'en charge.
Chaque agent ne modifie QUE les fichiers qu'il possède. Un changement nécessaire ailleurs est décrit dans le rapport final, section « Demandes d'intégration ».

## Propriété des fichiers
- SÉCURITÉ   : server/auth.js, server/index.js, server/routes.js, server/util.js, scripts/security.test.mjs (nouveau), package.json (scripts uniquement), .env.example
- BUGS SERVEUR : server/scheduler.js, server/billing.js, server/mailer.js, server/templates.js, server/db.js, server/brokers.json, scripts/smoke.mjs
- ADMIN      : server/admin.js, app/admin.js, app/admin.css, scripts/admin.test.mjs (nouveau)
- UI/DASHBOARD : app/app.js, app/app.css, app/index.html, server/dashboard.js
- Personne : index.html, assets/*, README.md, Dockerfile (l'orchestrateur les met à jour à la fin).

## Contrats stables (ne pas casser)
- server/util.js exporte : EMAIL (regex), clean(v,max), arr(v,max), publicUser(u), parseProfile(p), wrap(fn). Ajouts possibles, signatures existantes inchangées.
- server/auth.js exporte : hashPassword, verifyPassword, createSession(res,user,req), destroySession(req,res), attachUser, requireAuth, requireAdmin, rateLimit({windowMs,max}), isAdminEmail. (La sécurité peut rendre hashPassword/verifyPassword asynchrones : dans ce cas routes.js est adapté par le même agent ; les autres modules ne les utilisent pas.)
- server/routes.js monte le routeur admin : `api.use('/admin', requireAuth, requireAdmin, admin)` (import { admin } from './admin.js'). Le tableau de bord : `api.get('/dashboard', requireAuth, (req,res) => res.json(buildDashboard(fresh(req), req.query.profile_id)))` (import { buildDashboard } from './dashboard.js').
- server/scheduler.js exporte : launchProfile(user, profile) → {created, reason}, applyOutcome(request, outcome, note) (async), tick() (async), ref(r) → 'OUBLI-<token>', DEMO (bool).
- server/db.js exporte : db, q{get,all,run}, now(), addDays(iso, n), logEvent(user_id, type, message, extra?).
- scripts/smoke.mjs utilise : GET /api/admin/stats → {users, active, requests:[{status,n}], mails, action_required:[...]} et POST /api/admin/requests/:id/outcome {outcome, note}. L'admin garde ces deux points compatibles.
- Client : app/app.js expose `window.Oubli = { registerView(name, renderFn, afterFn), api(path,{method,body}), esc, toast(msg,isError), fmtDate(iso,opts), fmtTime(iso), money(cents), chip(status,label), dots(n), statusLabel, subLabel, field(name,label,value,attrs,hint), go(hash), render(), params() → {route, q}, state, NBSP, NNBSP }`.
  Quand un administrateur ouvre #admin, app.js injecte /app/admin.css puis /app/admin.js ; admin.js appelle `window.Oubli.registerView('admin', render(q) → html, after(q))`. Les sous-onglets admin passent par le hash : `#admin?tab=users&page=2` (lu via params().q). admin.js attache ses propres écouteurs (délégation sur document, actifs seulement si params().route === 'admin').
- Classes CSS réutilisables (app/app.css) : .page-head, .sheet/.sheet__head/.sheet__body/.sheet__section/.sheet__foot, .row/.row--head/.row__who/.row__when/.row__act/.row__note, .chip.chip--<status>, .btn/.btn--outline/.btn--ghost/.btn--sm/.btn--danger/.btn--block, .f (champ souligné)/.fields, .ledger/.ledger__stat/.ledger__n, .mono, .notice, .filters, .kv, .empty, .spinner, .stack, .dash-grid, .vh (visually hidden).

## Environnement de test
- Ports réservés : UI 3081, ADMIN 3082, SÉCURITÉ 3083, BUGS 3084. Chaque agent lance son serveur ainsi (depuis /home/user/testtt) :
  `PORT=308X DATABASE_PATH=<scratchpad>/<agent>/db.sqlite OUTBOX_DIR=<scratchpad>/<agent>/outbox DEMO_MODE=true SCHEDULER_INTERVAL_MS=4000 ADMIN_EMAILS=admin@test.fr SESSION_SECRET=dev-secret nohup node --disable-warning=ExperimentalWarning server/index.js > <scratchpad>/<agent>/server.log 2>&1 & echo $! > <scratchpad>/<agent>/server.pid`
  Arrêt : `kill $(cat <scratchpad>/<agent>/server.pid)`. JAMAIS `pkill -f` (tue le shell de l'agent). Pour relancer après modification : kill puis relancer.
  Si le serveur refuse de démarrer à cause d'un fichier que vous ne possédez pas (un autre agent l'édite en ce moment), attendez 30 s et réessayez ; ne corrigez pas les fichiers des autres.
- Playwright : `require('/opt/node-tools/node_modules/playwright')` (chromium installé, ne pas lancer `playwright install`). Scripts et captures UNIQUEMENT sous <scratchpad>/<agent>/.
- Tests : `set -o pipefail; npm test` (ne pas faire confiance au code de sortie d'un pipe sans pipefail).
- Pas de nouvelle dépendance npm. Copie en français avec typographie correcte (espace insécable U+00A0 avant : ; ? ! » et après «, apostrophe typographique ’, « » pour les citations, « 12,99 € »).
- Aucun identifiant de modèle d'IA dans le code, les commentaires ou les commits.
