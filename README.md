# Oubli — retrait automatisé de données personnelles

Service « type Incogni » : une landing page, une application abonné et une API qui envoient, suivent et relancent des demandes d'effacement (art. 17 RGPD, CCPA) auprès des courtiers en données et des sites de recherche de personnes.

> Marque et données fictives (prix, avis, chiffres du tableau de bord) : à remplacer avant mise en production.

## Démarrer en 30 secondes

```bash
npm install
npm start          # http://localhost:3000  (landing)  ·  http://localhost:3000/app/  (application)
npm test           # parcours complet automatisé
```

Sans fichier `.env`, le serveur tourne en mode développement : abonnement simulé (pas de Stripe), e-mails écrits dans `data/outbox/` au lieu d'être envoyés, et mode démo désactivé. Pour voir le pipeline « vivre » (les courtiers répondent en quelques minutes), lancez `DEMO_MODE=true npm start`.

Parcours : créer un compte → renseigner les informations à faire effacer → signer le mandat → choisir une offre → les demandes partent, le tableau de bord suit les réponses, relance à l'échéance légale et renvoie une demande tous les 60 à 90 jours.

## Architecture

| Dossier | Rôle |
|---|---|
| `index.html`, `assets/` | Landing page statique (HTML/CSS/JS, Google Fonts uniquement). |
| `app/` | Application abonné : inscription, dossier, mandat, tableau de bord, abonnement, paramètres, admin. Vanilla JS, routage par hash. |
| `server/index.js` | Serveur Express 5 : fichiers statiques + API `/api`. |
| `server/db.js` | SQLite via `node:sqlite` (Node ≥ 22.13, aucune dépendance native). Schéma créé automatiquement, registre de courtiers chargé depuis `server/brokers.json`. |
| `server/auth.js` | Mots de passe scrypt, sessions en base, cookie HttpOnly signé, limitation de débit. |
| `server/routes.js` | API JSON (voir ci-dessous). |
| `server/scheduler.js` | Planificateur : envoi des demandes, relances à l'échéance (30 j RGPD / 45 j CCPA), nouveau cycle après 60–90 j, simulation en démo. |
| `server/templates.js` | Courriers (FR + EN) : demande d'effacement, relance, mandat, notifications. |
| `server/mailer.js` | SMTP (nodemailer) ou boîte d'envoi locale. |
| `server/billing.js` | Stripe Checkout + webhooks (API REST, sans SDK) ou abonnement simulé. |
| `scripts/smoke.mjs` | Test de bout en bout sur une base temporaire. |

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
| `GET /api/admin/stats`, `POST /api/admin/requests/:id/outcome`, `PUT /api/admin/brokers/:id`, `POST /api/admin/tick` | Administration. |

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
