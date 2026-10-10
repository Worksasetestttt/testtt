# CLAUDE.md — guide pour reprendre le projet Oubli

Oubli est un service « type Incogni » : il envoie, suit et relance des demandes d'effacement (art. 17 RGPD, CCPA) auprès de courtiers en données. Le dépôt contient la landing page, l'application abonné (`/app`) et l'API (`/api`). Tout le texte visible est en français.

## Règles de travail

- Branche unique : `claude/incogni-landing-page-lcupn4`. Ne pousse jamais ailleurs.
- Ne crée pas de pull request sauf demande explicite.
- Commite et pousse après chaque étape validée (`git push -u origin claude/incogni-landing-page-lcupn4`), pas seulement à la fin.
- Ne mets aucun identifiant de modèle d'IA dans le code, les commentaires ou les commits. Un simple `Claude-Session:` suffit comme pied de commit.
- Pas de nouvelle dépendance npm. Le serveur utilise `node:sqlite` (Node 22.13 ou plus), Express 5 et nodemailer seulement (compression, cache, sauvegardes : modules de Node).
- N'arrête jamais un serveur avec `pkill -f` : il peut tuer ton propre shell. Utilise un pidfile ou `ss -ltnp | grep ':PORT '`.
- Avec un pipe, active `set -o pipefail` avant `npm test | tail`, sinon un échec passe inaperçu.

## Commandes

```bash
npm install
npm start                    # http://localhost:3000 (landing) et /app/ (application)
DEMO_MODE=true npm start     # les courtiers « répondent » après environ 45 s
npm test                     # dix suites (voir package.json) ; npm run test:<suite> pour une seule
npm run test:ui              # audit navigateur, hors npm test
PORT=3081 node server/index.js
```

Sans `.env`, le serveur tourne en mode développement : abonnement simulé, courriers écrits dans `data/outbox/`, démo désactivée. Les tests utilisent une base temporaire et ne touchent pas à `data/`.

## Carte du dépôt

| Fichier | Rôle |
|---|---|
| `index.html`, `assets/` | Landing statique. Ne la modifie que si on te le demande. |
| `server/index.js` | Point d'entrée Express : en-têtes de sécurité (CSP, COOP, CORP), webhook Stripe en corps brut, compression de l'API, garde CSRF, fichiers statiques (`static.js`), 404 JSON, arrêt propre sur SIGTERM. |
| `server/compress.js`, `server/static.js`, `server/health.js` | Compression brotli/gzip et ETag (`sendJsonConditional`) ; fichiers texte servis depuis la mémoire, précompressés, versionnés `?v=empreinte` ; santé de `/api/health`. |
| `server/backup.js`, `server/backup-worker.js` | Sauvegardes SQLite (`VACUUM INTO`, fil séparé), `BACKUP_DIR`, 7 gardées. |
| `server/routes.js` | Routes `/api` publiques et abonné. Monte le routeur admin. |
| `server/admin.js` | Routeur `/api/admin`, protégé par `requireAuth` et `requireAdmin`. `classifyReply` (lecture des réponses des courtiers) est partagé avec `/api/inbound`. |
| `server/account.js` | Mot de passe oublié (`password_resets`), appareils connectés, confirmation de l'adresse d'un administrateur (`email_verifications`, `sendAdminVerification`). Monté par `routes.js`. |
| `server/keys.js` | Clés d'activation (`activation_keys`, `key_redemptions`) : `createKeys`, `redeemKey`, `revokeKey`, `keyStatus`. |
| `server/dashboard.js` | `buildDashboard(user, profileId)` : JSON du tableau de bord (compteurs calculés sur le cycle en cours de chaque courtier ; statut virtuel `stopped` pour une demande arrêtée par la révocation du mandat, `isStopped`), `complaintReady(r)`, `exportData(u)` (sans `last_error`). |
| `server/sites.js`, `server/sitediscovery.js` | Sites ajoutés par les abonnés (`addSite`, `relaunchRequest`, `runDiscovery`) et recherche du contact sur le site, derrière une garde SSRF (`safeFetch`, `guardedLookup`, `isPublicIp`). |
| `server/reports.js` | Rapport mensuel par e-mail (`runMonthlyReports`, `startReports`). |
| `server/util.js` | Helpers partagés : `EMAIL`, `clean`, `arr`, `publicUser`, `parseProfile`, `wrap`, `sessionHandle`, `deviceLabel`. |
| `server/auth.js` | scrypt, sessions en base, cookie signé HMAC, limitation de débit (`rateLimit({ by })`), `requireAdmin`, promotion des administrateurs (`ADMIN_VERIFY`, `adminPending`, `promoteIfAdmin`). |
| `server/db.js` | Schéma SQLite, index, seed des courtiers depuis `server/brokers.json`. |
| `server/scheduler.js` | Envoi, relances à 30 j (RGPD) ou 45 j (CCPA), nouveau cycle après 60 à 90 j, simulation en démo, fin des abonnements par clé (`expireKeySubscriptions`). `applyOutcome` renvoie `{ applied, error? }`. |
| `server/billing.js` | Stripe Checkout en REST (sans SDK), webhooks signés, abonnement simulé. Formule unique, mensuelle, sans engagement : 5 € par mois (Individuel), 9,99 € par mois (Famille). Plus d’offre annuelle (`BILLING_PERIODS`) ; les anciens comptes « annual » restent lisibles. |
| `server/mailer.js`, `server/templates.js` | Courriers (SMTP ou boîte d'envoi locale). `sendMail({ redact })` masque un secret dans la table `mails`. `MANDATE_VERSION` est exporté et utilisé par l'API. |
| `app/index.html`, `app/app.js`, `app/app.css` | Application abonné en JS vanilla, routage par hash. |
| `app/admin.js`, `app/admin.css` | Panel d’administration (11 onglets, dont « Clés »). Chargé à la demande par `app.js` uniquement pour les administrateurs. Classes préfixées `adm-` (ne pas réutiliser `.chart`, déjà pris par le tableau de bord). |
| `scripts/smoke.mjs` | Parcours complet de bout en bout. |
| `scripts/security.test.mjs` | Tests de sécurité : en-têtes, cookies, autorisations, limitation de débit, webhooks. |
| `scripts/admin.test.mjs` | Tests de l’API d’administration : autorisations, comptes, demandes, courtiers, exports, audit. |
| `scripts/ui.audit.cjs` | Audit navigateur (`npm run test:ui`, hors `npm test`) : écrans de connexion, offre et clé, tableau de bord (tiroir, plainte, focus, 304), vues, onglets et fiche admin, à 1280 et 390 px (débordement, ids, cibles de 44 px), sur un serveur (port attribué par le système) et une base temporaires. Relance-le après toute modification de l’interface. |
| `scripts/sites.test.mjs`, `scripts/features.test.mjs` | Sites ajoutés (SSRF, découverte, règle d’envoi, erreurs SMTP internes) ; fonctions du tableau de bord (détail, CSV, rapport mensuel, refus, plainte, relance, demandes arrêtées). |
| `scripts/security2.test.mjs`, `scripts/account.test.mjs`, `scripts/keys.test.mjs`, `scripts/perf.test.mjs`, `scripts/regressions.test.mjs` | Sécurité (seconde série, dont un serveur en mode production) ; comptes ; clés d’activation ; performance et fiabilité ; régressions des bugs corrigés. |
| `docs/handoff/` | Rapports des relectures (bureau, accessibilité, mobile) et contrat de découpage des fichiers. Lis-les avant de toucher l'interface. |

### Contrats à ne pas casser

- `server/util.js`, `server/auth.js`, `server/scheduler.js` et `server/db.js` exportent des fonctions utilisées ailleurs. Ajoute des exports, ne change pas les signatures sans mettre à jour tous les appelants.
- `window.Oubli` (exposé par `app/app.js`) sert au module admin : `registerView`, `api`, `esc`, `toast`, `fmtDate`, `chip`, `params`, `state`, `subActive`, etc. Ajoute, ne renomme pas. Une erreur de `api()` porte `status` et `code` (codes `invalid`, `expired`, `used` des liens).
- Exports ajoutés : `scheduler.js` (`subscriptionActive`, `hasAccess`, `expireKeySubscriptions`, `schedulerState`, `stopScheduler`), `db.js` (`dbPing`, `closeDb`), `reports.js` (`stopReports`), `auth.js` (`ADMIN_VERIFY`, `adminPending`), `account.js` (`sendAdminVerification`).
- `scripts/smoke.mjs` attend `GET /api/admin/stats` avec les champs `users`, `active`, `requests`, `mails`, `action_required`, et `POST /api/admin/requests/:id/outcome`.
- Les ids `#f-first_name`, `#f-last_name`, `#f-birth_date`, `#f-country`, `#add-emails` restent non scopés sur l'écran d'onboarding (le script de test les utilise).

## Conventions d'interface

- Palette : papier `#F6F1E8`, encre `#1C1915`, vermillon `#C8471F`. Définie en tokens CSS dans `:root`.
- Polices : Fraunces (titres), Instrument Sans (texte), DM Mono (libellés et métadonnées).
- Composants existants à réutiliser : `.sheet`, `.row`, `.chip`, `.btn` (`--outline`, `--ghost`, `--sm`, `--danger`), `.f` (champ souligné), `.ledger`, `.filters`, `.notice`, `.empty`, `.page-head`, `.vh` (texte masqué visuellement).
- Typographie française : espace insécable (U+00A0) avant `:` `;` `?` `!` et dans `« »`, espace fine insécable (U+202F) pour les séparateurs de milliers, apostrophe typographique `’`, « 12,99 € ».
- `[hidden]{display:none!important}` est indispensable : sans lui, un `display` d'auteur masque l'attribut `hidden`.
- Accessibilité : chaque champ a un `<label>` unique (attention aux ids dupliqués quand le même formulaire est rendu plusieurs fois). Les messages d'erreur ont `role="alert"`. Ne fais pas de `aria-live` sur `<main>`. Les mouvements respectent `prefers-reduced-motion`.
- Mobile : pas de débordement horizontal à 360, 390, 768, 820 et 1024 px, ni sur le document ni sur un `.sheet`. Les cibles tactiles font au moins 44 px.
- Le tableau de bord se rafraîchit toutes les 6 s. Ne remplace jamais toute la vue pendant le rafraîchissement : cela fait perdre le focus. Chaque zone a une signature (`sigs`) et n’est remplacée que si elle change et que le focus n’y est pas (`patch`). `loadDash(focusSel, force)` : une requête à la fois, la plus récente l’emporte, recul en cas d’erreur.
- Le détail d’une demande est un `<dialog id="drawer">` modal (app/index.html). Pendant qu’il est ouvert, le reste de la page est inerte : `#toast` et `#announce` sont déplacés dans le tiroir puis remis à la fermeture, sinon les messages ne seraient ni visibles ni annoncés. Le tiroir ne se rafraîchit pas pendant une saisie (`drawerIdle`).
- `readOnly()` (accès support) masque les actions d’écriture du tableau de bord ; le serveur les refuse de toute façon.
- `statusLabel('done')` vaut « Effacée » (application, administration et CSV) ; `stopped` vaut « Arrêtée » (demande en file arrêtée par la révocation du mandat : `refused` en base, jamais présentée comme un refus).
- Abonnement : un abonnement offert par clé (`billing_mode 'key'`) s’arrête à `subscription_ends_at`. Teste `subscriptionActive`/`hasAccess` côté serveur et `subActive` côté client, jamais `subscription_status === 'active'` seul. `onboarding.access` (résilié mais payé jusqu’à une date future compris) décide de l’ajout de sites.
- Fichiers statiques : n’ajoute pas de `?v=` à la main dans le HTML (versionnement automatique par `static.js`). Un script en ligne modifié demande un redémarrage : la CSP est calculée au démarrage.
- `/api/dashboard` répond 304 quand l’ETag correspond : la comparaison est faite dans la route (`sendJsonConditional`), car `fetch` ajoute `Cache-Control: no-cache` aux requêtes conditionnelles manuelles.
- Un texte `.vh` (position absolue) dans un conteneur défilant déborde de la page si ce conteneur n’est pas positionné : `.tbl-wrap` est en `position: relative` pour cette raison.
- Accès support : la garde de `server/index.js` refuse toute méthode non sûre quand `req.impersonator` est défini, sauf `SUPPORT_ALLOWED` (retour et déconnexion). Une nouvelle route d’écriture est donc bloquée par défaut pendant un accès support : n’ajoutez une exception que délibérément.
- Une suspension se vérifie par `isSuspended(u)` (`auth.js`) ; le planificateur applique la même règle dans `isEligible`. Gardez les deux alignés.

## Sécurité

- `SESSION_SECRET` est obligatoire en production (au moins 32 caractères). Ne le journalise jamais.
- Le cookie de session est HttpOnly, SameSite=Lax, et `Secure` en production.
- Les mots de passe sont hachés avec scrypt. Ne stocke ni ne renvoie jamais `password_hash`, les ids Stripe ou les identifiants de session.
- Le webhook Stripe et `/api/inbound` ne lisent pas les cookies. Ils vérifient leur signature ou leur jeton (comparaison à temps constant).
- En SMTP réel, le planificateur n'écrit qu'aux courtiers dont le contact est vérifié par un administrateur. Seule exception (`canMail` dans scheduler.js, réglable par `AUTO_SEND_SITE_CONTACTS`) : l’adresse publiée par un site ajouté par un abonné sur son propre domaine.
- `DEMO_MODE` ne doit jamais être activé en production.
- Administrateurs : en production (`ADMIN_VERIFY`), une adresse de `ADMIN_EMAILS` n’obtient le rôle qu’après avoir prouvé sa boîte (lien `#verify` ou réinitialisation par e-mail, `email_verified_at`). Ne réintroduis pas de promotion sans cette preuve.
- Secrets envoyés par e-mail (liens de réinitialisation et de confirmation) : empreinte SHA-256 seule en base, jeton masqué dans `mails` (`redact`). Clés d’activation : empreinte et indice seulement, affichées une seule fois, jamais journalisées.
- Limitation de débit : la clé est le motif de la route (casse et barre finale ignorées) et le client (IPv4, ou /64 en IPv6). Une route à identifiant a donc un seul compteur par client.
- Découverte des sites : aucune répétition non bornée sur le HTML lu (coût quadratique sur un serveur mono-processus) ; `timeoutMs` borne la durée totale d’une lecture ; `isPublicIp` juge une IPv6 sur sa valeur. Un courtier personnalisé se retrouve par nom d’hôte exact, jamais par slug.
- Le message brut d’un échec SMTP reste dans `last_error` (administration) ; le journal, la note et l’export de l’abonné gardent un texte générique.
- CSV : `csvCell` neutralise aussi les formules après une virgule ou un point-virgule (Excel en français découpe sur « ; »).
- La base n’est pas chiffrée par l’application : n’affiche aucune promesse de chiffrement (« AES-256 ») dans l’interface.

## État du chantier

Fait et poussé :
- Landing page, application abonné en style dossier, backend complet (inscription, profils, mandat, abonnement, demandes, relances, réponses, export, suppression).
- Correctifs des trois relectures (`docs/handoff/`) et accessibilité : vérifiés au navigateur à 1280 et 390 px (débordements à 360–1280 px, ids, labels, focus pendant le rafraîchissement, erreurs annoncées).
- Tableau de bord : exposition sur 12 semaines, catégories, sensibilité, recherche, tri, filtres avec compteurs, « Afficher plus », journal de 8 entrées.
- Panel d’administration complet (vue d’ensemble, utilisateurs, demandes, courtiers, courriers, réponses entrantes, contacts, sécurité, système, audit) et `scripts/admin.test.mjs` (16 groupes).
- Outils de support : suspension, liste de blocage, accès au compte en lecture seule, sessions par compte, notes internes, message, changement d’adresse, export RGPD par l’admin, annonce globale.
- Formule unique à 5 € (Individuel) et 9,99 € (Famille) par mois ; sites ajoutés en collant une adresse ; rapport mensuel ; rapport imprimable et CSV.
- Tableau de bord refondu (synthèse, tiroir de détail, activité groupée, analyse) ; un refus programme un nouveau cycle ; plainte prête à déposer ; relance « données réapparues » ; demandes « Arrêtées » après une révocation du mandat.
- Clés d’activation (abonnements offerts) : onglet « Clés », lien `#signup?key=`, cumul des durées, expiration automatique.
- Comptes : mot de passe oublié, appareils connectés, avis par e-mail après un changement de mot de passe, confirmation de l’adresse des administrateurs en production.
- Audit de sécurité (découverte des sites, limitation de débit, courtiers personnalisés, CSV, erreurs SMTP), chasse aux bugs (17 correctifs, `regressions.test.mjs`), performance (compression, cache, ETag, santé, sauvegardes, arrêt propre).
- `npm test` passe (dix suites) ; `npm run test:ui` passe à 1280 et 390 px. README à jour.

Pistes suivantes (non commencées) :
- Typographie des textes produits par le serveur (erreurs d’API, journal, courriers) : espaces ordinaires avant « : » et quelques apostrophes droites (ex. `routes.js`, message de l’offre Individuel). Le client corrige l’affichage du journal et des messages de l’administration avec `typo()`, pas le contenu des courriers. La plainte (`complaintDraft`) applique déjà la typographie française (`frTypo`).
- La landing annonce « 420+ courtiers » (le registre en contient 50), « AES-256 » (la base n’est pas chiffrée) et « Hébergé en France » (dépend de l’hébergeur). À aligner avant toute publication ; la landing ne se modifie que sur demande.
- Authentification à deux facteurs pour les administrateurs ; vérification de l’adresse de tous les abonnés (inscription : 409 « compte existant » révèle encore l’existence d’un compte).
- Stripe : un réabonnement pendant une période déjà payée crée un second abonnement (proposition : reprendre l’existant) ; un `checkout.session.completed` rejoué en retard réactive le compte jusqu’à l’événement `deleted` (ignorer les événements plus anciens que le dernier traité) ; la suppression de compte résilie en fin de période plutôt qu’immédiatement.
- Planificateur : les nouveaux courtiers du registre ne reçoivent pas de demande pour les abonnés existants (`autoLaunch` ne traite que les profils sans demande) ; les demandes en file d’un courtier désactivé restent « À envoyer » ; un courrier peut partir deux fois avec deux instances (réserver la demande avant l’envoi).
- Verrouillage de connexion par adresse seulement (un tiers peut bloquer un compte) ; `/api/inbound` accepte tout expéditeur qui connaît une référence ; scrypt N=2^14 (OWASP recommande 2^17) ; l’indice de 4 caractères d’une clé ramène sa recherche à 40 bits depuis une copie de la base.

## Pièges connus

- Le module `node:sqlite` est encore expérimental : garde `--disable-warning=ExperimentalWarning` dans les scripts.
- Les lignes du tableau de bord doivent garder une grille stable : un libellé trop long fait déborder la colonne.
- Une règle `.rail__step span` a une spécificité qui masque les numéros de l'onboarding : utilise des sélecteurs précis.
- Le navigateur Playwright est déjà installé (`/opt/pw-browsers`) ; n'exécute pas `playwright install`. Le module se charge depuis `/opt/node-tools/node_modules/playwright`.
- Tests : `/billing/checkout` est limité à 10 appels par quart d’heure et `/auth/signup` à 20 par heure (par client) ; les suites tirent leur port au hasard entre 3900 et 6000 et peuvent entrer en collision si plusieurs tournent en même temps (l’audit navigateur prend un port du système). Attends l’arrêt du serveur avant de supprimer le dossier temporaire.
- Un chemin d’installation contenant un dossier caché (`.claude/worktrees`) n’empêche plus de servir l’application (`static.js`) ; si tu sers un fichier toi-même, utilise `res.sendFile(nom, { root })`, jamais un chemin absolu.
