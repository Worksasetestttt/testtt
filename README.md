# Oubli — retrait automatisé de données personnelles

Service « type Incogni » : une landing page, une application abonné et une API qui envoient, suivent et relancent des demandes d'effacement (art. 17 RGPD, CCPA) auprès des courtiers en données et des sites de recherche de personnes.

> Marque et données fictives (prix, avis, chiffres du tableau de bord) : à remplacer avant mise en production.

## Démarrer en 30 secondes

```bash
npm install
npm start          # http://localhost:3000  (landing)  ·  http://localhost:3000/app/  (application)
npm test           # trois suites : parcours complet, sécurité, administration
```

Sans fichier `.env`, le serveur tourne en mode développement : abonnement simulé (pas de Stripe), e-mails écrits dans `data/outbox/` au lieu d'être envoyés, et mode démo désactivé. Pour voir le pipeline « vivre » (les courtiers répondent en quelques minutes), lancez `DEMO_MODE=true npm start`.

Parcours : créer un compte → renseigner les informations à faire effacer → signer le mandat → choisir une offre → les demandes partent, le tableau de bord suit les réponses, relance à l'échéance légale et renvoie une demande tous les 60 à 90 jours.

## Architecture

| Dossier | Rôle |
|---|---|
| `index.html`, `assets/` | Landing page statique (HTML/CSS/JS, Google Fonts uniquement). |
| `app/index.html`, `app/app.js`, `app/app.css` | Application abonné : inscription, dossier, mandat, tableau de bord, abonnement, paramètres. Vanilla JS, routage par hash. |
| `app/admin.js`, `app/admin.css` | Panel d'administration, chargé à la demande pour les administrateurs uniquement. |
| `server/index.js` | Serveur Express 5 : en-têtes de sécurité, garde CSRF, webhook Stripe en corps brut, fichiers statiques, API `/api`. |
| `server/routes.js` | API publique et abonné (voir ci-dessous). |
| `server/admin.js` | API d'administration `/api/admin`, journal d'audit. |
| `server/dashboard.js` | Données du tableau de bord : compteurs, exposition sur 12 semaines, catégories, sensibilité. |
| `server/util.js` | Validation des entrées, sérialisation publique (sans secret), helpers partagés. |
| `server/db.js` | SQLite via `node:sqlite` (Node ≥ 22.13, aucune dépendance native). Schéma créé automatiquement, registre de courtiers chargé depuis `server/brokers.json`. |
| `server/auth.js` | Mots de passe scrypt, sessions en base, cookie HttpOnly signé, limitation de débit. |
| `server/scheduler.js` | Planificateur : envoi des demandes, relances à l'échéance (30 j RGPD / 45 j CCPA), nouveau cycle après 60–90 j, simulation en démo. |
| `server/templates.js` | Courriers (FR + EN) : demande d'effacement, relance, mandat, notifications. |
| `server/mailer.js` | SMTP (nodemailer) ou boîte d'envoi locale. |
| `server/billing.js` | Stripe Checkout + webhooks (API REST, sans SDK) ou abonnement simulé. |
| `scripts/smoke.mjs` | Test de bout en bout sur une base temporaire. |
| `scripts/security.test.mjs` | Test de sécurité : en-têtes, cookies, CSRF, autorisations, verrouillage, débit, sessions, webhooks. |
| `scripts/admin.test.mjs` | Test de l'administration : autorisations, comptes, demandes, courtiers, exports, audit. |

## Configuration (`.env`)

Copiez `.env.example` en `.env`. Variables principales :

- `SESSION_SECRET` (obligatoire en production), `APP_URL`, `PORT`, `TRUST_PROXY`.
- `SMTP_URL` (`smtps://user:pass@smtp.exemple.fr:465`), `MAIL_FROM`, `MAIL_REPLY_TO`.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (événements `checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted` vers `/api/billing/webhook`).
- `INBOUND_TOKEN` : jeton du webhook `/api/inbound` qui reçoit les réponses des courtiers (depuis Postmark, Mailgun, SendGrid Inbound Parse… en POST JSON `{from, subject, text}`). La référence `OUBLI-XXXXXXXXXX` présente dans l'objet rattache la réponse à la demande.
- `ADMIN_EMAILS` : comptes ayant accès à `/app/#admin` et `/api/admin/*`.
- `DEMO_MODE` : ne jamais activer en production.

### Sécurité des envois réels

Les adresses de contact du registre (`privacy@domaine`) sont une convention, **non vérifiées**. En SMTP réel, le planificateur n'écrit qu'aux courtiers dont le contact a été vérifié par un administrateur (`/app/#admin`), sauf si `ALLOW_UNVERIFIED_CONTACTS=true`.

## API

Toutes les réponses sont en JSON ; les erreurs ont la forme `{ "error": "message" }`. Session par cookie.

| Méthode & route | Description |
|---|---|
| `GET /api/health`, `GET /api/config` | État du service, offres, nombre de courtiers. |
| `POST /api/auth/signup` · `/login` · `/logout` · `GET /api/me` · `POST /api/auth/password` | Compte et session. |
| `GET/POST /api/profiles`, `PUT/DELETE /api/profiles/:id` | Personnes protégées (1 en Individuel, 5 en Famille). |
| `GET/POST/DELETE /api/mandate` | Mandat électronique : aperçu, signature (nom tapé + acceptation), révocation. |
| `GET /api/brokers` | Registre public des courtiers surveillés. |
| `POST /api/requests/launch` | Crée les demandes du cycle 1 pour les profils complets. |
| `GET /api/dashboard?profile_id=` | Compteurs, exposition, demandes, journal, état d'onboarding. |
| `POST /api/requests/:id/resolve`, `GET /api/requests/:id/mails` | Vérification fournie par l'abonné ; courriers envoyés. |
| `POST /api/billing/checkout` · `/cancel` · `/webhook` | Abonnement (Stripe ou simulé). |
| `POST /api/inbound` | Réponses des courtiers (webhook e-mail entrant). |
| `GET /api/export`, `DELETE /api/account` | Export RGPD et suppression définitive. |
| `POST /api/newsletter`, `POST /api/contact` | Formulaires de la landing. |
| `GET /api/admin/*`, `POST/PUT/DELETE /api/admin/*` | Administration (réservée aux comptes `admin`, voir ci-dessous). |

### Routes d'administration

| Méthode & route | Description |
|---|---|
| `GET /api/admin/stats` | Chiffres clés, revenu mensuel, demandes par statut, séries sur 14 jours, santé du service. |
| `GET /api/admin/users?q=&status=&plan=&page=`, `GET /api/admin/users/:id` | Comptes et fiche détaillée (profils, demandes, journal, audit). |
| `POST /api/admin/users/:id/role` · `/subscription` · `/logout-all` · `/launch`, `DELETE /api/admin/users/:id` | Rôle, abonnement manuel, fermeture des sessions, lancement des demandes, suppression. |
| `GET /api/admin/requests?q=&status=&sort=&broker=&user=&page=`, `GET /api/admin/requests/:id` | Demandes (par identifiant ou référence `OUBLI-…`). |
| `POST /api/admin/requests/:id/outcome` · `/resend`, `POST /api/admin/requests/bulk` | Réponse d'un courtier, renvoi, réponses groupées (100 au plus). |
| `GET/POST /api/admin/brokers`, `PUT/DELETE /api/admin/brokers/:id`, `POST /api/admin/brokers/:id/test-mail` | Registre des courtiers : création, édition, désactivation, courrier de test. |
| `GET /api/admin/mails`, `GET /api/admin/mails/:id` | Courriers envoyés et leur contenu. |
| `POST /api/admin/inbound/simulate` | Rattache une réponse collée à sa demande et propose un résultat, sans rien enregistrer. |
| `GET /api/admin/contacts`, `POST /api/admin/contacts/:id/handled`, `GET /api/admin/newsletter` | Messages du formulaire de contact, lettre d'information. |
| `GET /api/admin/export.csv?what=users\|requests\|contacts\|newsletter` | Exports CSV (UTF-8 avec BOM, formules neutralisées). |
| `GET /api/admin/system`, `GET /api/admin/audit`, `POST /api/admin/tick` | Configuration (présence des variables seulement), journal d'audit, passage du planificateur. |

## Panel d'administration

Accès : `/app/#admin`, pour les adresses listées dans `ADMIN_EMAILS` (le rôle est attribué à l'inscription ou à la connexion suivante). Un administrateur sans abonnement arrive directement sur l'administration après la connexion. Le code du panel n'est téléchargé que par les administrateurs.

| Onglet | Contenu |
|---|---|
| Vue d'ensemble | Utilisateurs, abonnés actifs, revenu mensuel récurrent, courriers ; demandes par statut ; inscriptions et courriers sur 14 jours ; santé du service (taux d'effacement, délai médian, contacts vérifiés, dernier passage du planificateur) ; vérifications en attente, à traiter en un clic. |
| Utilisateurs | Recherche (e-mail, nom, identifiant), filtres par abonnement avec compteurs, fiche : abonnement manuel, rôle, sessions, lancement des demandes, suppression, profils, journal de l'abonné, actions des administrateurs. |
| Demandes | Filtres par statut, tri, recherche par référence, fiche dépliable (réponse, renvoi, courriers, journal), sélection groupée. |
| Courtiers | Registre : édition, création, contact vérifié, courrier de test, désactivation. Une nouvelle adresse de contact perd sa vérification, sauf confirmation explicite. |
| Courriers | Tous les courriers envoyés, filtrables, avec leur contenu exact. |
| Réponses entrantes | État du webhook `/api/inbound` et qualification manuelle d'une réponse collée. |
| Contacts | Messages reçus (à traiter, traités), inscrits à la lettre d'information, exports CSV. |
| Système | Version de Node, modes (courrier, paiement, démo), planificateur, volumes, variables d'environnement (présence seulement). |
| Journal d'audit | Chaque action d'un administrateur, horodatée, attribuée et filtrable par action ou par cible. |

Les filtres et les pages se rechargent sans perdre le focus ; les actions destructrices demandent une seconde confirmation (Échap annule). Sous 768 px, les tableaux passent en cartes.

## Sécurité

- **En-têtes** : CSP stricte (scripts du même domaine, scripts en ligne autorisés par empreinte SHA-256), `frame-ancestors 'none'`, COOP, CORP, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en production. Réponses de l'API en `no-store`.
- **Sessions** : cookie HttpOnly, `SameSite=Lax`, signé HMAC, `Secure` et préfixe `__Host-` en production. Sessions en base : 30 jours au plus, 14 jours d'inactivité, 10 par compte. `SESSION_SECRET` (32 caractères au moins) est obligatoire en production.
- **Mots de passe** : scrypt, 10 à 128 caractères, mots de passe courants et contenant l'e-mail refusés. Verrouillage après 10 échecs, sans révéler l'existence du compte.
- **CSRF** : les méthodes non sûres n'acceptent que du JSON et vérifient `Origin` ou `Referer`.
- **Entrées** : corps JSON bornés et typés, requêtes paramétrées, jokers `LIKE` échappés, pagination plafonnée, limitation de débit par route.
- **Données** : aucune réponse ne contient de haché, d'identifiant de session ni d'identifiant Stripe complet (masqués dans l'administration). Exports CSV protégés contre l'injection de formules.
- **Webhooks** : Stripe par signature, `/api/inbound` par jeton (16 caractères au moins), comparaisons à temps constant, cookies ignorés.
- **Administration** : `requireAuth` + `requireAdmin` sur tout `/api/admin`, au moins un administrateur conservé, pas de modification de son propre rôle, chaque mutation écrite dans `admin_audit`.

## Tests

```bash
npm test                 # smoke.mjs, puis security.test.mjs, puis admin.test.mjs
npm run test:security    # sécurité seule
npm run test:admin       # administration seule
```

Chaque suite démarre son propre serveur sur un port libre avec une base temporaire : `data/` n'est jamais touché. Dans un pipe, activez `set -o pipefail` pour que l'échec d'une suite ne passe pas inaperçu.

Le parcours navigateur (inscription, dossier, mandat, offre, tableau de bord, dossier à deux profils, abonnement, paramètres, puis chaque onglet de l'administration) a été vérifié avec Playwright à 1280 et 390 px : aucun débordement horizontal à 360, 390, 768, 820, 1024 et 1280 px, ni sur la page ni sur les feuilles, aucun identifiant dupliqué, un libellé par champ, focus conservé pendant le rafraîchissement du tableau de bord, aucune erreur console.

## Déploiement

```bash
docker build -t oubli .
docker run -p 3000:3000 -v oubli-data:/srv/oubli/data --env-file .env oubli
```

Fonctionne tel quel sur Render, Fly.io, Railway ou un VPS derrière Nginx (`TRUST_PROXY=1`). La base SQLite vit dans `data/` : montez un volume persistant et sauvegardez-le.

## Avant la mise en production

1. Remplacer la marque, les mentions légales, l'adresse de la société (`COMPANY_*`) et les contenus d'exemple de la landing (avis, chiffres).
2. Vérifier les adresses de contact des courtiers et compléter le registre (`server/brokers.json` ou admin).
3. Configurer SMTP + domaine d'envoi (SPF/DKIM), le webhook entrant et Stripe.
4. Ajouter l'authentification à deux facteurs et la vérification d'e-mail si nécessaire ; mettre en place sauvegardes et journalisation.
