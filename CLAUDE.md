# CLAUDE.md — guide pour reprendre le projet Oubli

Oubli est un service « type Incogni » : il envoie, suit et relance des demandes d'effacement (art. 17 RGPD, CCPA) auprès de courtiers en données. Le dépôt contient la landing page, l'application abonné (`/app`) et l'API (`/api`). Tout le texte visible est en français.

## Règles de travail

- Branche unique : `claude/incogni-landing-page-lcupn4`. Ne pousse jamais ailleurs.
- Ne crée pas de pull request sauf demande explicite.
- Commite et pousse après chaque étape validée (`git push -u origin claude/incogni-landing-page-lcupn4`), pas seulement à la fin.
- Ne mets aucun identifiant de modèle d'IA dans le code, les commentaires ou les commits. Un simple `Claude-Session:` suffit comme pied de commit.
- Pas de nouvelle dépendance npm. Le serveur utilise `node:sqlite` (Node 22.13 ou plus) et Express 5 seulement.
- N'arrête jamais un serveur avec `pkill -f` : il peut tuer ton propre shell. Utilise un pidfile ou `ss -ltnp | grep ':PORT '`.
- Avec un pipe, active `set -o pipefail` avant `npm test | tail`, sinon un échec passe inaperçu.

## Commandes

```bash
npm install
npm start                    # http://localhost:3000 (landing) et /app/ (application)
DEMO_MODE=true npm start     # les courtiers « répondent » après environ 45 s
npm test                     # smoke.mjs (parcours complet), security.test.mjs, admin.test.mjs
PORT=3081 node server/index.js
```

Sans `.env`, le serveur tourne en mode développement : abonnement simulé, courriers écrits dans `data/outbox/`, démo désactivée. Les tests utilisent une base temporaire et ne touchent pas à `data/`.

## Carte du dépôt

| Fichier | Rôle |
|---|---|
| `index.html`, `assets/` | Landing statique. Ne la modifie que si on te le demande. |
| `server/index.js` | Point d'entrée Express : en-têtes de sécurité (CSP, COOP, CORP), webhook Stripe en corps brut, garde CSRF, fichiers statiques, 404 JSON. |
| `server/routes.js` | Routes `/api` publiques et abonné. Monte le routeur admin. |
| `server/admin.js` | Routeur `/api/admin`, protégé par `requireAuth` et `requireAdmin`. |
| `server/dashboard.js` | `buildDashboard(user, profileId)` : JSON du tableau de bord. |
| `server/util.js` | Helpers partagés : `EMAIL`, `clean`, `arr`, `publicUser`, `parseProfile`, `wrap`. |
| `server/auth.js` | scrypt, sessions en base, cookie signé HMAC, limitation de débit, `requireAdmin`. |
| `server/db.js` | Schéma SQLite, index, seed des courtiers depuis `server/brokers.json`. |
| `server/scheduler.js` | Envoi, relances à 30 j (RGPD) ou 45 j (CCPA), nouveau cycle après 60 à 90 j, simulation en démo. |
| `server/billing.js` | Stripe Checkout en REST (sans SDK), webhooks signés, abonnement simulé. Prix : 12,99 € par mois ou 83,88 € par an (Individuel), 24,99 € ou 167,88 € (Famille). |
| `server/mailer.js`, `server/templates.js` | Courriers (SMTP ou boîte d'envoi locale). `MANDATE_VERSION` est exporté et utilisé par l'API. |
| `app/index.html`, `app/app.js`, `app/app.css` | Application abonné en JS vanilla, routage par hash. |
| `app/admin.js`, `app/admin.css` | Panel d’administration (9 onglets). Chargé à la demande par `app.js` uniquement pour les administrateurs. Classes préfixées `adm-` (ne pas réutiliser `.chart`, déjà pris par le tableau de bord). |
| `scripts/smoke.mjs` | Parcours complet de bout en bout. |
| `scripts/security.test.mjs` | Tests de sécurité : en-têtes, cookies, autorisations, limitation de débit, webhooks. |
| `scripts/admin.test.mjs` | Tests de l’API d’administration : autorisations, comptes, demandes, courtiers, exports, audit. |
| `docs/handoff/` | Rapports des relectures (bureau, accessibilité, mobile) et contrat de découpage des fichiers. Lis-les avant de toucher l'interface. |

### Contrats à ne pas casser

- `server/util.js`, `server/auth.js`, `server/scheduler.js` et `server/db.js` exportent des fonctions utilisées ailleurs. Ajoute des exports, ne change pas les signatures sans mettre à jour tous les appelants.
- `window.Oubli` (exposé par `app/app.js`) sert au module admin : `registerView`, `api`, `esc`, `toast`, `fmtDate`, `chip`, `params`, `state`, etc. Ajoute, ne renomme pas.
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
- Le tableau de bord se rafraîchit toutes les 6 s. Ne remplace jamais toute la vue pendant le rafraîchissement : cela fait perdre le focus.
- Un texte `.vh` (position absolue) dans un conteneur défilant déborde de la page si ce conteneur n’est pas positionné : `.tbl-wrap` est en `position: relative` pour cette raison.
- Accès support : la garde de `server/index.js` refuse toute méthode non sûre quand `req.impersonator` est défini, sauf `SUPPORT_ALLOWED` (retour et déconnexion). Une nouvelle route d’écriture est donc bloquée par défaut pendant un accès support : n’ajoutez une exception que délibérément.
- Une suspension se vérifie par `isSuspended(u)` (`auth.js`) ; le planificateur applique la même règle dans `isEligible`. Gardez les deux alignés.

## Sécurité

- `SESSION_SECRET` est obligatoire en production (au moins 32 caractères). Ne le journalise jamais.
- Le cookie de session est HttpOnly, SameSite=Lax, et `Secure` en production.
- Les mots de passe sont hachés avec scrypt. Ne stocke ni ne renvoie jamais `password_hash`, les ids Stripe ou les identifiants de session.
- Le webhook Stripe et `/api/inbound` ne lisent pas les cookies. Ils vérifient leur signature ou leur jeton (comparaison à temps constant).
- En SMTP réel, le planificateur n'écrit qu'aux courtiers dont le contact est vérifié par un administrateur.
- `DEMO_MODE` ne doit jamais être activé en production.
- Vérifie dans `server/index.js` et `server/auth.js` l'état réel de la protection CSRF et de la CSP avant de les considérer comme acquises : le chantier de sécurité a été interrompu.

## État du chantier

Fait et poussé :
- Landing page, application abonné en style dossier, backend complet (inscription, profils, mandat, abonnement, demandes, relances, réponses, export, suppression).
- Correctifs des trois relectures (`docs/handoff/`) et accessibilité : vérifiés au navigateur à 1280 et 390 px (débordements à 360–1280 px, ids, labels, focus pendant le rafraîchissement, erreurs annoncées).
- Tableau de bord : exposition sur 12 semaines, catégories, sensibilité, recherche, tri, filtres avec compteurs, « Afficher plus », journal de 8 entrées.
- Panel d’administration complet (vue d’ensemble, utilisateurs, demandes, courtiers, courriers, réponses entrantes, contacts, sécurité, système, audit) et `scripts/admin.test.mjs` (16 groupes).
- Outils de support : suspension, liste de blocage, accès au compte en lecture seule, sessions par compte, notes internes, message, changement d’adresse, export RGPD par l’admin, annonce globale.
- `npm test` passe (trois suites). README à jour.

Pistes suivantes (non commencées) :
- Scripts Playwright versionnés dans le dépôt (les vérifications navigateur ont été faites hors dépôt).
- Typographie des textes produits par le serveur (erreurs d’API, journal, courriers) : espaces ordinaires avant « : » et quelques apostrophes droites (ex. `routes.js`, message de l’offre Individuel). Le client corrige l’affichage du journal et des messages de l’administration avec `typo()`, pas le contenu des courriers.
- Authentification à deux facteurs pour les administrateurs.

## Pièges connus

- Le module `node:sqlite` est encore expérimental : garde `--disable-warning=ExperimentalWarning` dans les scripts.
- Les lignes du tableau de bord doivent garder une grille stable : un libellé trop long fait déborder la colonne.
- Une règle `.rail__step span` a une spécificité qui masque les numéros de l'onboarding : utilise des sélecteurs précis.
- Le navigateur Playwright est déjà installé (`/opt/pw-browsers`) ; n'exécute pas `playwright install`. Le module se charge depuis `/opt/node-tools/node_modules/playwright`.
