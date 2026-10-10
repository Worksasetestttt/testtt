/* Oubli — application cliente (vanilla JS, routage par hash, API JSON avec cookie de session). */
(function () {
  'use strict';
  var NBSP = ' ', NNBSP = ' ';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var view = $('#view'), nav = $('#nav'), topUser = $('#top-user'), toastEl = $('#toast');
  var state = { user: null, profiles: [], config: null, dash: null, profileId: null, billing: 'annual', filter: 'all' };
  var pollTimer = null;
  var MARK = '<svg viewBox="0 0 32 32" width="44" height="44" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="10.5" stroke="currentColor" stroke-width="3.2"/><path d="M3.5 17.8 L28.5 14.2" stroke="#C8471F" stroke-width="3.2" stroke-linecap="round"/></svg>';
  var COUNTRIES = { FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', NL: 'Pays-Bas', PT: 'Portugal', GB: 'Royaume-Uni', US: 'États-Unis', CA: 'Canada' };

  /* ---------- utilitaires ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(cents) { return (cents / 100).toFixed(2).replace('.', ',') + NNBSP + '€'; }
  function fmtDate(iso, opts) { if (!iso) return '—'; return new Date(iso).toLocaleDateString('fr-FR', opts || { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtTime(iso) { return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function toast(msg, isError) { toastEl.textContent = msg; toastEl.classList.toggle('is-error', !!isError); toastEl.hidden = false; clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.hidden = true; }, 4200); }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch('/api' + path, init).then(function (r) {
      return r.text().then(function (t) { var d; try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { error: 'Réponse invalide du serveur.' }; } if (!r.ok) { var err = new Error(d.error || ('Erreur ' + r.status)); err.status = r.status; throw err; } return d; });
    });
  }
  function params() { var h = location.hash.slice(1), i = h.indexOf('?'); var out = { route: i < 0 ? h : h.slice(0, i), q: {} }; if (i >= 0) new URLSearchParams(h.slice(i + 1)).forEach(function (v, k) { out.q[k] = v; }); return out; }
  function go(hash) { if (location.hash === '#' + hash) render(); else location.hash = hash; }
  function statusLabel(s) { return { queued: 'À envoyer', sent: 'Envoyée', in_progress: 'En cours', action_required: 'Action requise', done: 'Terminée', refused: 'Refusée' }[s] || s; }
  function subLabel(s) { return { none: 'Aucun abonnement', active: 'Actif', past_due: 'Paiement en attente', canceled: 'Résilié' }[s] || s; }
  function chip(s, label) { return '<span class="chip chip--' + esc(s) + '">' + esc(label || statusLabel(s)) + '</span>'; }
  function dots(n) { var o = '<span class="dots" title="Sensibilité ' + n + ' sur 3"><span class="vh">Sensibilité ' + n + ' sur 3.</span>'; for (var i = 1; i <= 3; i++) o += '<i class="' + (i <= n ? 'on' : '') + '"></i>'; return o + '</span>'; }
  function field(name, label, value, attrs, hint) { attrs = attrs || {}; return '<div class="f' + (attrs.full ? ' f--full' : '') + '"><label for="f-' + name + '">' + label + '</label><input id="f-' + name + '" name="' + name + '" value="' + esc(value) + '" ' + (attrs.extra || '') + '>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>'; }
  function tagField(name, label, values, placeholder, hint) {
    return '<div class="f f--full f--list" data-name="' + name + '"><span class="f__label" id="lbl-' + name + '">' + label + '</span>' +
      '<ul class="tags" aria-labelledby="lbl-' + name + '">' + (values || []).map(function (v) { return '<li class="tag"><span>' + esc(v) + '</span><button type="button" aria-label="Retirer ' + esc(v) + '">×</button></li>'; }).join('') + '</ul>' +
      '<div class="tags__add"><input id="add-' + name + '" type="text" placeholder="' + esc(placeholder) + '" aria-label="' + esc(placeholder) + '" autocomplete="off"><button type="button">Ajouter</button></div>' +
      (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
  }
  function formData(form) { var o = {}; new FormData(form).forEach(function (v, k) { o[k] = v; }); return o; }
  function initials(p) { return ((p.first_name || '?')[0] + (p.last_name || '')[0] || '').toUpperCase(); }
  function onboardingDone() { var u = state.user, p = state.profiles[0]; return !!(u && p && p.first_name && p.last_name && u.mandate_signed_at && !u.mandate_revoked_at && u.subscription_status === 'active'); }
  function fileNo(id) { return 'Nº' + NBSP + String(id || '').slice(0, 4).toUpperCase(); }

  /* ---------- session ---------- */
  function loadMe() {
    return api('/me').then(function (d) { state.user = d.user || null; state.profiles = d.profiles || []; return !!d.user; }).catch(function () { state.user = null; state.profiles = []; return false; });
  }
  function setChrome() {
    var on = !!state.user;
    nav.hidden = !on; topUser.hidden = !on;
    if (on) { $('#top-email').textContent = state.user.email; $('#nav-admin').hidden = state.user.role !== 'admin'; }
    var route = params().route;
    $$('a', nav).forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('data-route') === route); });
  }
  $('#logout').addEventListener('click', function () { api('/auth/logout', { method: 'POST' }).then(function () { state.user = null; toast('À bientôt.'); go('login'); }); });

  /* ---------- vues ---------- */
  var views = {};

  views.login = function (q) {
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Bon retour.</h1><p class="lead">Connectez-vous pour suivre vos demandes.</p>' +
      '<form id="login-form" class="sheet" novalidate><div class="sheet__body"><div class="fields">' + field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) +
      '</div><p class="msg" id="form-msg" style="margin-top:16px"></p><button class="btn btn--block" type="submit">Se connecter</button></div></form>' +
      '<p class="switch">Pas encore de dossier&nbsp;? <a href="#signup">Créer un compte</a></p></section>';
  };
  views.signup = function (q) {
    var plan = state.config && state.config.plans[q.plan] ? q.plan : 'individuel', billing = q.billing === 'monthly' ? 'monthly' : 'annual';
    var p = state.config ? state.config.plans[plan] : null;
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Ouvrons votre <em>dossier</em>.</h1><p class="lead">Deux minutes pour créer le compte. Les demandes partent dès que le mandat est signé.</p>' +
      '<form id="signup-form" class="sheet" novalidate><div class="sheet__body"><input type="hidden" name="plan" value="' + esc(plan) + '"><input type="hidden" name="billing" value="' + esc(billing) + '">' +
      (p ? '<div class="offer"><span><span class="mono">Offre</span><br><strong>' + esc(p.name) + '</strong> · ' + (billing === 'annual' ? 'annuel' : 'mensuel') + '</span><span><strong>' + money(billing === 'annual' ? Math.round(p.annual / 12) : p.monthly) + '</strong><small class="mono--plain mono">/mois</small></span></div>' : '') +
      '<div class="fields">' + field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10 caractères.') +
      '</div><p class="msg" id="form-msg" style="margin-top:16px"></p><button class="btn btn--block" type="submit">Créer mon compte <span class="btn__arrow" aria-hidden="true">→</span></button></div></form>' +
      '<p class="switch">Déjà un compte&nbsp;? <a href="#login">Se connecter</a></p></section>';
  };

  views.onboarding = function () {
    var u = state.user, p = state.profiles[0] || {};
    var s1 = !!(p.first_name && p.last_name), s2 = !!(u.mandate_signed_at && !u.mandate_revoked_at), s3 = u.subscription_status === 'active';
    var cur = !s1 ? 1 : !s2 ? 2 : 3;
    function step(n, title, sub, done) { return '<li class="rail__step ' + (done ? 'is-done' : cur === n ? 'is-current' : '') + '"><span class="rail__n">0' + n + '</span><div><strong>' + title + '</strong><span>' + sub + '</span></div></li>'; }
    var html = '<div class="page-head"><div><span class="mono">Dossier ' + fileNo(p.id) + ' · Ouverture</span><h1>Trois étapes, puis nous prenons le relais.</h1></div></div>' +
      '<div class="onb"><ol class="rail">' + step(1, 'Vos informations', 'Ce que les courtiers peuvent connaître de vous.', s1) + step(2, 'Le mandat', 'L’autorisation d’écrire en votre nom. Révocable.', s2) + step(3, 'L’offre', 'Satisfait ou remboursé 30 jours.', s3) + '</ol><div>';
    if (cur === 1) html += profileForm(p, true);
    else if (cur === 2) html += mandateCard(p);
    else html += '<div class="stack"><p class="lead">Dernière étape&nbsp;: choisissez votre offre. Les demandes partent dans la foulée.</p>' + plansBlock() + '</div>';
    return html + '</div></div>';
  };

  function profileForm(p, onboarding) {
    return '<form class="sheet profile-form" data-id="' + esc(p.id) + '" novalidate>' +
      '<div class="sheet__head"><span class="mono">Dossier ' + fileNo(p.id) + (p.is_primary ? ' · Profil principal' : ' · Proche') + '</span>' + (p.updated_at && p.first_name ? '<span class="mono mono--plain">Mis à jour le ' + fmtDate(p.updated_at) + '</span>' : '') + '</div>' +
      '<div class="sheet__body"><div class="sheet__section"><h2>' + (onboarding ? 'Qui devons-nous faire oublier&nbsp;?' : (p.is_primary ? 'Vous' : esc(p.first_name + ' ' + p.last_name))) + '</h2><p class="hint">Ces informations servent uniquement à identifier vos fiches chez les courtiers. Chiffrées, jamais revendues.</p>' +
      '<div class="fields">' + field('first_name', 'Prénom', p.first_name || '', { extra: 'required autocomplete="given-name"' }) + field('last_name', 'Nom', p.last_name || '', { extra: 'required autocomplete="family-name"' }) +
      field('birth_date', 'Date de naissance', p.birth_date || '', { extra: 'type="date"' }, 'Distingue vos fiches de celles d’un homonyme.') +
      '<div class="f"><label for="f-country">Pays de résidence</label><select id="f-country" name="country">' + Object.keys(COUNTRIES).map(function (c) { return '<option value="' + c + '"' + ((p.country || 'FR') === c ? ' selected' : '') + '>' + COUNTRIES[c] + '</option>'; }).join('') + '</select></div></div></div>' +
      '<div class="sheet__section"><h2>Ce qu’ils peuvent savoir de vous</h2><p class="hint">Ajoutez toutes les variantes connues&nbsp;: anciennes adresses, ancien numéro, adresse e-mail d’étudiant… Plus la liste est complète, plus les suppressions sont rapides.</p>' +
      '<div class="fields" style="gap:30px">' + tagField('emails', 'Adresses e-mail', p.emails, 'ajouter une adresse e-mail') + tagField('phones', 'Numéros de téléphone', p.phones, 'ajouter un numéro') + tagField('addresses', 'Adresses postales, actuelles et passées', p.addresses, 'ajouter une adresse postale') + tagField('aliases', 'Autres noms utilisés', p.aliases, 'nom de naissance, surnom…') + '</div></div>' +
      '<p class="msg" id="form-msg" style="margin-top:20px"></p></div>' +
      '<div class="sheet__foot"><div class="btn-row"><button class="btn" type="submit">' + (onboarding ? 'Enregistrer et continuer <span class="btn__arrow" aria-hidden="true">→</span>' : 'Enregistrer') + '</button>' + (!p.is_primary && !onboarding ? '<button class="btn btn--ghost" type="button" data-remove="' + esc(p.id) + '">Retirer du dossier</button>' : '') + '</div><span class="mono">Chiffré AES-256 · Hébergé en France</span></div></form>';
  }

  function mandateCard(p) {
    return '<div class="sheet" id="mandate-card"><div class="sheet__head"><span class="mono">Mandat de représentation · RGPD art. 17 &amp; 21</span><span class="mono mono--plain">Version ' + esc(state.config ? state.config.mandate_version : '') + '</span></div>' +
      '<div class="sheet__body"><div class="sheet__section"><h2>L’autorisation d’écrire en votre nom</h2><p class="hint">Un courtier n’a pas à répondre à un tiers. Ce mandat nous permet d’exercer vos droits à votre place. Vous pouvez le révoquer à tout moment depuis votre dossier.</p>' +
      '<div class="mandate-text" id="mandate-text"><span class="spinner"></span> Chargement du mandat…</div></div>' +
      '<form id="mandate-form" class="sheet__section" novalidate><label class="check"><input type="checkbox" name="accepted" required> <span>J’ai lu le mandat et j’autorise Oubli à exercer mes droits d’accès, d’effacement et d’opposition auprès des courtiers en données.</span></label>' +
      '<div class="sig" style="margin-top:28px"><div class="f"><label for="f-full_name">Signez en tapant votre prénom et votre nom</label><input id="f-full_name" name="full_name" placeholder="' + esc((p.first_name || '') + ' ' + (p.last_name || '')) + '" autocomplete="off" required></div><button class="btn" type="submit">Signer électroniquement</button></div>' +
      '<p class="msg" id="form-msg" style="margin-top:14px"></p></form></div></div>';
  }

  function plansBlock() {
    var plans = state.config.plans, b = state.billing, u = state.user;
    var seg = '<div class="toolbar"><div class="btn-row"><div class="seg" role="radiogroup" aria-label="Périodicité"><button type="button" role="radio" aria-checked="' + (b === 'monthly') + '" data-billing="monthly">Mensuel</button><button type="button" role="radio" aria-checked="' + (b === 'annual') + '" data-billing="annual">Annuel</button></div><span class="badge">jusqu’à −46' + NNBSP + '%</span></div>' + (state.config.billing === 'simulated' ? '<span class="mono">Paiement simulé · aucune clé Stripe</span>' : '') + '</div>';
    var cards = Object.keys(plans).map(function (k) {
      var p = plans[k], cur = u && u.subscription_status === 'active' && u.plan === k;
      var perMonth = b === 'annual' ? Math.round(p.annual / 12) : p.monthly;
      return '<div class="sheet plan' + (k === 'individuel' ? ' plan--featured' : '') + (cur ? ' is-current' : '') + '"><div class="plan__head"><h3>' + esc(p.name) + '</h3><span class="mono">' + (p.members > 1 ? 'Jusqu’à ' + p.members + ' personnes' : 'Une personne') + '</span></div>' +
        '<div class="plan__price"><b>' + money(perMonth) + '</b><small>/mois</small></div><p class="plan__note">' + (b === 'annual' ? 'soit ' + money(p.annual) + ' facturés une fois par an' : 'sans engagement, ' + money(p.monthly) + ' par mois') + '</p>' +
        '<ul><li>Demandes auprès de ' + (state.config.brokers || '') + ' courtiers et annuaires</li><li>Relances automatiques à l’échéance légale</li><li>Nouvelle vérification tous les 60 à 90 jours</li><li>Journal horodaté, preuves exportables</li>' + (p.members > 1 ? '<li>Un dossier par personne, une seule facture</li>' : '') + '</ul>' +
        (cur ? '<p class="notice notice--ok">Votre offre actuelle, ' + (u.billing === 'annual' ? 'annuelle' : 'mensuelle') + '.</p>' : '<button class="btn btn--block' + (k === 'famille' ? ' btn--outline' : '') + '" type="button" data-checkout="' + k + '">' + (u && u.subscription_status === 'active' ? 'Passer à ' + esc(p.name) : 'Choisir ' + esc(p.name)) + '</button>') + '</div>';
    }).join('');
    return seg + '<div class="plans">' + cards + '</div><p class="mono" style="margin-top:18px">Prix TTC · Satisfait ou remboursé 30 jours · Résiliation en un clic</p>';
  }

  function rowsHtml(d) {
    var list = d.requests.filter(function (r) { return state.filter === 'all' || (state.filter === 'in_progress' ? (r.status === 'sent' || r.status === 'in_progress' || r.status === 'queued') : r.status === state.filter); });
    if (!list.length) return '<p class="empty">' + (d.requests.length ? 'Aucune demande dans cette catégorie.' : 'Aucune demande pour ce dossier.' + (onboardingDone() ? '' : ' <a href="#onboarding">Terminer les étapes</a>')) + '</p>';
    return '<div class="row row--head"><span>Sens.</span><span>Courtier</span><span>Statut</span><span>Suivi</span><span></span></div>' + list.map(function (r) {
      var basis = (r.legal_basis === 'ccpa' ? 'CCPA' : 'RGPD art. 17') + (r.cycle > 1 ? ' · cycle ' + r.cycle : '');
      var when = r.status === 'done' ? '<span>Effacée le ' + fmtDate(r.completed_at) + '</span><small>' + (r.next_check_at ? 'revérification le ' + fmtDate(r.next_check_at) : basis) + '</small>'
        : r.sent_at ? '<span>Envoyée le ' + fmtDate(r.sent_at) + '</span><small>' + (r.due_at ? 'réponse due le ' + fmtDate(r.due_at) : basis) + '</small>'
        : '<span>Prochain envoi</span><small>' + basis + '</small>';
      var act = (r.status === 'action_required' ? '<button class="btn btn--sm" type="button" data-resolve="' + esc(r.id) + '">Vérification faite</button>' : '') + (r.sent_at ? '<button class="btn btn--ghost" type="button" data-mails="' + esc(r.id) + '">Courrier</button>' : '');
      return '<div class="row" data-row="' + esc(r.id) + '">' + dots(r.sensitivity) + '<div class="row__who"><strong>' + esc(r.broker) + '</strong><small>' + esc(r.category) + '</small></div><div>' + chip(r.status) + '</div><div class="row__when">' + when + '</div><div class="row__act">' + act + '</div>' + (r.note && r.status !== 'done' ? '<p class="row__note">' + esc(r.note) + '</p>' : '') + '</div>';
    }).join('');
  }

  views.dashboard = function () {
    var d = state.dash; if (!d) return '<p class="empty"><span class="spinner"></span></p>';
    var c = d.counters, u = d.user, prof = d.profiles.find(function (p) { return p.id === d.profile_id; }) || {};
    var warn = '';
    if (u.subscription_status !== 'active') warn = '<div class="notice" style="margin-bottom:24px">' + (u.subscription_status === 'past_due' ? 'Votre dernier paiement a échoué : mettez à jour votre moyen de paiement pour que les demandes continuent.' : u.subscription_status === 'canceled' ? 'Abonnement résilié' + (u.subscription_ends_at ? ' : les demandes continuent jusqu’au ' + fmtDate(u.subscription_ends_at) + '.' : '.') : 'En attente de confirmation du paiement. Les demandes partiront dès que l’abonnement sera actif.') + ' <a href="#billing">Voir l’abonnement</a></div>';
    if (u.mandate_revoked_at) warn += '<div class="notice" style="margin-bottom:24px">Mandat révoqué : plus aucune demande n’est envoyée. <a href="#dossier">Signer un nouveau mandat</a></div>';
    if (c.action_required) warn += '<div class="notice" style="margin-bottom:24px"><strong>' + c.action_required + ' courtier' + (c.action_required > 1 ? 's demandent' : ' demande') + ' une vérification</strong> avant de supprimer vos données (lien de confirmation ou pièce d’identité partielle, envoyés par e-mail). <a href="#dashboard" data-filter="action_required">Voir lesquels</a></div>';
    var profSel = d.profiles.length > 1 ? '<label class="vh" for="profile-select">Dossier de</label><select id="profile-select">' + d.profiles.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === d.profile_id ? ' selected' : '') + '>' + esc(p.first_name + ' ' + p.last_name) + '</option>'; }).join('') + '</select>' : '';
    var circ = 2 * Math.PI * 42;
    var ring = '<svg class="ring" viewBox="0 0 96 96" role="img" aria-label="Exposition ' + d.exposure + ' %"><circle class="track" cx="48" cy="48" r="42"/><circle class="fill" cx="48" cy="48" r="42" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (circ * (1 - d.exposure / 100)).toFixed(1) + '"/><text x="48" y="48">' + d.exposure + NNBSP + '%</text></svg>';
    var filters = [['all', 'Tous', c.total], ['action_required', 'Action requise', c.action_required], ['in_progress', 'En cours', c.in_progress + c.queued], ['done', 'Terminées', c.done]].map(function (f) { return '<button type="button" aria-pressed="' + (state.filter === f[0]) + '" data-filter="' + f[0] + '">' + f[1] + '<b>' + f[2] + '</b></button>'; }).join('');
    var journal = d.events.slice(0, 14).map(function (e) { return '<li class="t-' + esc(e.type) + '"><time datetime="' + esc(e.created_at) + '">' + fmtTime(e.created_at) + '</time><span>' + esc(e.message) + '</span></li>'; }).join('');
    var nextDue = d.requests.filter(function (r) { return r.due_at && (r.status === 'sent' || r.status === 'in_progress'); }).map(function (r) { return r.due_at; }).sort()[0];
    return '<header class="dash-head"><div><span class="mono">Dossier ' + fileNo(d.profile_id) + ' · mis à jour à ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '</span><h1>' + esc((prof.first_name || '') + ' ' + (prof.last_name || '')) + '</h1><p class="lead">' + (c.total ? c.brokers + ' courtiers surveillés. ' + (d.next_check_at ? 'Prochaine vérification le ' + fmtDate(d.next_check_at) + '.' : 'Les courtiers ont un mois (RGPD) ou 45 jours (CCPA) pour répondre.') : 'Les premières demandes partiront dès que le dossier sera complet.') + '</p></div><div class="dash-head__actions">' + profSel + (c.total === 0 && onboardingDone() ? '<button class="btn" type="button" id="launch">Lancer les demandes</button>' : '') + '</div></header>' + warn +
      '<section class="sheet ledger" aria-label="Synthèse"><div class="ledger__stat"><span class="mono">Envoyées</span><span class="ledger__n num">' + c.sent + '</span><span class="ledger__sub">sur ' + c.brokers + ' courtiers</span></div><div class="ledger__stat"><span class="mono">En cours</span><span class="ledger__n num">' + c.in_progress + '</span><span class="ledger__sub">réponse attendue</span></div><div class="ledger__stat' + (c.action_required ? ' ledger__stat--warn' : '') + '"><span class="mono">Action requise</span><span class="ledger__n num">' + c.action_required + '</span><span class="ledger__sub">' + (c.action_required ? 'vérification à faire' : 'rien à faire') + '</span></div><div class="ledger__stat ledger__stat--ok"><span class="mono">Terminées</span><span class="ledger__n num">' + c.done + '</span><span class="ledger__sub">effacements confirmés</span></div><div class="ledger__ring">' + ring + '<div class="ring__txt"><strong>Exposition estimée</strong><span>Part des courtiers qui n’ont pas encore confirmé l’effacement.</span></div></div></section>' +
      '<div class="dash-grid"><section class="sheet" aria-label="Courtiers"><div class="sheet__head"><h2>Courtiers</h2><div class="filters">' + filters + '</div></div><div class="rows" id="rows">' + rowsHtml(d) + '</div></section>' +
      '<aside class="stack"><section class="sheet" aria-label="Journal"><div class="sheet__head"><h2>Journal</h2><span class="mono">Horodaté</span></div>' + (journal ? '<ol class="timeline">' + journal + '</ol>' : '<p class="empty">Rien pour l’instant.</p>') + '</section>' +
      '<section class="sheet" aria-label="Échéances"><div class="sheet__head"><h2>Échéances</h2></div><div class="deadlines"><div class="deadline"><b>' + (nextDue ? fmtDate(nextDue) : '—') + '</b><span>prochaine réponse due</span></div><div class="deadline"><b>' + (d.next_check_at ? fmtDate(d.next_check_at) : '—') + '</b><span>prochaine vérification</span></div><div class="deadline"><b>' + c.queued + '</b><span>demandes à envoyer</span></div></div></section></aside></div>';
  };

  views.dossier = function () {
    var u = state.user, max = (state.config.plans[u.plan] || { members: 1 }).members;
    var members = '<section class="sheet"><div class="sheet__head"><h2>Personnes protégées</h2><span class="mono">' + state.profiles.length + ' / ' + max + '</span></div><div class="members">' + state.profiles.map(function (p) { return '<div class="member"><span class="avatar" aria-hidden="true">' + esc(initials(p)) + '</span><div><strong>' + esc((p.first_name || '—') + ' ' + (p.last_name || '')) + '</strong><small>' + (p.is_primary ? 'Profil principal' : 'Proche') + ' · ' + (p.emails.length + p.phones.length + p.addresses.length) + ' éléments à effacer</small></div><a class="btn btn--ghost" href="#profile-' + esc(p.id) + '">Modifier</a></div>'; }).join('') +
      (state.profiles.length < max ? '<form class="member" id="add-member" novalidate style="align-items:end"><span class="avatar" aria-hidden="true">+</span><div class="fields" style="grid-template-columns:1fr 1fr;gap:16px 24px">' + field('first_name', 'Prénom', '', { extra: 'required' }) + field('last_name', 'Nom', '', { extra: 'required' }) + '</div><button class="btn btn--outline btn--sm" type="submit">Ajouter un proche</button><p class="msg" id="form-msg-add" style="grid-column:1/-1"></p></form>' : (max === 1 ? '<p class="empty" style="padding:20px 32px;text-align:left">L’offre Individuel couvre une personne. <a href="#billing">Passer à Famille</a> pour protéger jusqu’à 5 proches.</p>' : '')) + '</div></section>';
    var forms = state.profiles.map(function (p) { return '<div id="profile-' + esc(p.id) + '" style="scroll-margin-top:90px">' + profileForm(p, false) + '</div>'; }).join('');
    var m = u.mandate_signed_at && !u.mandate_revoked_at ? '<section class="sheet" id="mandate-card"><div class="sheet__head"><h2>Mandat</h2><span class="stamp">Signé le ' + fmtDate(u.mandate_signed_at) + '</span></div><div class="sheet__body"><div class="mandate-text" id="mandate-text"><span class="spinner"></span></div></div><div class="sheet__foot"><div class="btn-row"><a class="btn btn--outline btn--sm" href="/api/mandate" download="mandat-oubli.json">Télécharger</a><button class="btn btn--ghost" type="button" id="revoke">Révoquer le mandat</button></div><span class="mono">Version ' + esc(u.mandate_version || '') + '</span></div></section>' : mandateCard(state.profiles[0] || {});
    return '<div class="page-head"><div><span class="mono">Dossier ' + fileNo((state.profiles[0] || {}).id) + '</span><h1>Votre dossier</h1><p class="lead">Les informations qui permettent de retrouver vos fiches, et le mandat qui nous autorise à les faire effacer.</p></div></div><div class="stack">' + members + forms + m + '</div>';
  };

  views.billing = function () {
    var u = state.user;
    var status = '<section class="sheet"><div class="sheet__head"><h2>Votre abonnement</h2>' + chip(u.subscription_status, subLabel(u.subscription_status)) + '</div><div class="sheet__body"><dl class="kv"><dt>Offre</dt><dd>' + (u.plan ? esc(state.config.plans[u.plan].name) + ' · ' + (u.billing === 'annual' ? 'annuel' : 'mensuel') : '—') + '</dd><dt>Paiement</dt><dd>' + (u.billing_mode === 'stripe' ? 'Carte via Stripe' : u.billing_mode === 'simulated' ? 'Simulé (environnement de test)' : '—') + '</dd>' + (u.subscription_ends_at ? '<dt>Fin d’accès</dt><dd>' + fmtDate(u.subscription_ends_at) + '</dd>' : '') + '</dl></div>' + (u.subscription_status === 'active' ? '<div class="sheet__foot"><button class="btn btn--ghost" type="button" id="cancel-sub">Résilier l’abonnement</button><span class="mono">Satisfait ou remboursé 30 jours</span></div>' : '') + '</section>';
    return '<div class="page-head"><div><span class="mono">Abonnement</span><h1>Un prix clair. Une <em>seule</em> mission.</h1></div></div><div class="stack">' + status + '<div>' + plansBlock() + '</div></div>';
  };

  views.settings = function () {
    return '<div class="page-head"><div><span class="mono">Paramètres</span><h1>Votre compte, vos données, vos droits.</h1></div></div><div class="stack">' +
      '<form class="sheet" id="pwd-form" novalidate><div class="sheet__head"><h2>Mot de passe</h2></div><div class="sheet__body"><div class="fields">' + field('current', 'Mot de passe actuel', '', { extra: 'type="password" autocomplete="current-password" required' }) + field('next', 'Nouveau mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10 caractères. Les autres sessions seront déconnectées.') + '</div><p class="msg" id="form-msg" style="margin-top:16px"></p></div><div class="sheet__foot"><button class="btn btn--outline" type="submit">Changer le mot de passe</button></div></form>' +
      '<section class="sheet"><div class="sheet__head"><h2>Vos données chez Oubli</h2></div><div class="sheet__body"><p class="lead">Nous appliquons à nous-mêmes ce que nous demandons aux courtiers&nbsp;: export complet en un clic, suppression définitive sur demande.</p></div><div class="sheet__foot"><a class="btn btn--outline" href="/api/export" download="oubli-export.json">Exporter mes données (JSON)</a><span class="mono">RGPD art. 15 &amp; 20</span></div></section>' +
      '<form class="sheet" id="delete-form" novalidate><div class="sheet__head"><h2>Supprimer le compte</h2></div><div class="sheet__body"><p class="lead" style="margin-bottom:22px">Résilie l’abonnement, supprime vos profils, vos demandes et le journal. Irréversible.</p><div class="fields">' + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) + '</div><p class="msg" id="form-msg-del" style="margin-top:16px"></p></div><div class="sheet__foot"><button class="btn btn--danger" type="submit">Supprimer définitivement</button><span class="mono">RGPD art. 17</span></div></form></div>';
  };

  /* Vue admin : le code d'administration (app/admin.js + app/admin.css) n'est chargé que pour les administrateurs. */
  var plugins = {}, adminLoaded = false;
  function loadAdminAssets() {
    if (adminLoaded) return; adminLoaded = true;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/app/admin.css'; document.head.appendChild(l);
    var sc = document.createElement('script'); sc.src = '/app/admin.js'; sc.onerror = function () { adminLoaded = false; toast('Impossible de charger l’administration.', true); }; document.body.appendChild(sc);
  }
  views.admin = function () { loadAdminAssets(); return '<div class="page-head"><div><span class="mono">Administration</span><h1>Chargement…</h1></div></div><span class="spinner"></span>'; };
  function registerView(name, renderFn, afterFn) { views[name] = renderFn; plugins[name] = afterFn || null; if (params().route === name) render(); }

  /* ---------- rendu & routage ---------- */
  function render() {
    var p = params(), route = p.route || (state.user ? 'dashboard' : 'login');
    clearInterval(pollTimer);
    if (route === 'billing-success') { toast('Paiement confirmé. Les demandes partent automatiquement.'); location.hash = 'dashboard'; return; }
    if (!state.user && !/^(login|signup)$/.test(route)) { location.hash = 'login' + (location.hash.indexOf('?') > 0 ? location.hash.slice(location.hash.indexOf('?')) : ''); return; }
    if (state.user && /^(login|signup)$/.test(route)) { location.hash = onboardingDone() ? 'dashboard' : 'onboarding'; return; }
    if (state.user && route === 'dashboard' && !onboardingDone() && !(state.dash && state.dash.counters.total)) { if (!state.user.mandate_signed_at || !state.profiles[0].first_name) { location.hash = 'onboarding'; return; } }
    if (route === 'admin' && (!state.user || state.user.role !== 'admin')) { location.hash = 'dashboard'; return; }
    if (!views[route]) { location.hash = state.user ? 'dashboard' : 'login'; return; }
    setChrome();
    view.innerHTML = views[route](p.q);
    after(route, p.q);
    window.scrollTo(0, 0);
  }
  function after(route, q) {
    if (route === 'dashboard') { loadDash(); pollTimer = setInterval(loadDash, 6000); }
    if (route === 'onboarding' || route === 'dossier') loadMandateText();
    if (plugins[route]) plugins[route](q || {});
  }
  function loadDash() {
    var pid = state.profileId ? '?profile_id=' + encodeURIComponent(state.profileId) : '';
    api('/dashboard' + pid).then(function (d) { state.dash = d; state.user = d.user; state.profiles = d.profiles; if (params().route === 'dashboard' && !$('.mail')) { var y = window.scrollY; view.innerHTML = views.dashboard(); window.scrollTo(0, y); } }).catch(function (e) { toast(e.message, true); });
  }
  function loadMandateText() {
    var box = $('#mandate-text'); if (!box) return;
    api('/mandate').then(function (m) { box.textContent = m.text || ''; }).catch(function (e) { box.textContent = e.message; });
  }

  /* ---------- interactions (délégation) ---------- */
  function busy(form, on) { var b = form.querySelector('button[type="submit"]'); if (b) b.disabled = on; }
  function showMsg(form, text, isErr, id) { var m = form.querySelector(id || '.msg'); if (m) { m.textContent = text || ''; m.classList.toggle('is-error', !!isErr); } }
  function addTag(listField) {
    var input = $('.tags__add input', listField), ul = $('.tags', listField);
    var v = input.value.trim(); if (!v) return;
    var li = document.createElement('li'); li.className = 'tag';
    var span = document.createElement('span'); span.textContent = v;
    var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '×'; btn.setAttribute('aria-label', 'Retirer ' + v);
    li.appendChild(span); li.appendChild(btn); ul.appendChild(li);
    input.value = ''; input.focus();
  }
  function profilePayload(form) {
    var d = formData(form);
    $$('.f--list', form).forEach(function (lf) {
      var pending = $('.tags__add input', lf); if (pending && pending.value.trim()) addTag(lf);
      d[lf.getAttribute('data-name')] = $$('.tag span', lf).map(function (s) { return s.textContent; });
    });
    return d;
  }

  document.addEventListener('submit', function (e) {
    var f = e.target; e.preventDefault();
    if (f.id === 'login-form' || f.id === 'signup-form') {
      var d = formData(f); busy(f, true); showMsg(f, '');
      api(f.id === 'login-form' ? '/auth/login' : '/auth/signup', { body: d }).then(function () { return loadMe(); }).then(function () { toast(f.id === 'login-form' ? 'Connecté.' : 'Compte créé. Dossier ouvert.'); go(onboardingDone() ? 'dashboard' : 'onboarding'); }).catch(function (err) { showMsg(f, err.message, true); }).finally(function () { busy(f, false); });
    } else if (f.classList.contains('profile-form')) {
      var pd = profilePayload(f); busy(f, true); showMsg(f, '');
      api('/profiles/' + f.getAttribute('data-id'), { method: 'PUT', body: pd }).then(function () { return loadMe(); }).then(function () { toast('Informations enregistrées.'); if (params().route === 'onboarding') render(); else { var s = $('.sheet__head .mono--plain', f); if (s) s.textContent = 'Enregistré à l’instant'; } }).catch(function (err) { showMsg(f, err.message, true); }).finally(function () { busy(f, false); });
    } else if (f.id === 'add-member') {
      var md = formData(f); busy(f, true);
      api('/profiles', { body: md }).then(function () { return loadMe(); }).then(function () { toast('Proche ajouté. Complétez ses informations.'); render(); }).catch(function (err) { showMsg(f, err.message, true, '#form-msg-add'); }).finally(function () { busy(f, false); });
    } else if (f.id === 'mandate-form') {
      var mdd = formData(f); busy(f, true); showMsg(f, '');
      if (!f.querySelector('[name="accepted"]').checked) { showMsg(f, 'Cochez la case pour accepter le mandat.', true); busy(f, false); return; }
      api('/mandate', { body: { full_name: mdd.full_name, accepted: true } }).then(function () { return loadMe(); }).then(function () { toast('Mandat signé.'); render(); if (onboardingDone()) launch(); }).catch(function (err) { showMsg(f, err.message, true); }).finally(function () { busy(f, false); });
    } else if (f.id === 'pwd-form') {
      var pw = formData(f); busy(f, true);
      api('/auth/password', { body: pw }).then(function () { toast('Mot de passe changé.'); f.reset(); showMsg(f, ''); }).catch(function (err) { showMsg(f, err.message, true); }).finally(function () { busy(f, false); });
    } else if (f.id === 'delete-form') {
      if (!f.getAttribute('data-confirm')) { f.setAttribute('data-confirm', '1'); showMsg(f, 'Cliquez une seconde fois pour confirmer la suppression définitive.', true, '#form-msg-del'); return; }
      var dd = formData(f); busy(f, true);
      api('/account', { method: 'DELETE', body: dd }).then(function () { state.user = null; toast('Compte supprimé. Vos données sont effacées.'); go('login'); }).catch(function (err) { showMsg(f, err.message, true, '#form-msg-del'); f.removeAttribute('data-confirm'); }).finally(function () { busy(f, false); });
    }
  });

  function launch() { return api('/requests/launch', { body: {} }).then(function (r) { if (r.created) toast(r.created + ' demandes préparées. Première vague en cours d’envoi.'); go('dashboard'); setTimeout(loadDash, 1500); setTimeout(loadDash, 4000); }).catch(function (e) { toast(e.message, true); }); }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('.tags__add input')) { e.preventDefault(); addTag(e.target.closest('.f--list')); }
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t) return;
    if (t.matches('.tags__add button')) { addTag(t.closest('.f--list')); }
    else if (t.matches('.tag button')) { t.closest('.tag').remove(); }
    else if (t.hasAttribute('data-filter')) { e.preventDefault(); state.filter = t.getAttribute('data-filter'); if (state.dash) { var rows = $('#rows'); if (rows) { rows.innerHTML = rowsHtml(state.dash); $$('.filters button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-filter') === state.filter); }); if (t.closest('.notice')) rows.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } }
    else if (t.hasAttribute('data-billing')) { state.billing = t.getAttribute('data-billing'); render(); }
    else if (t.hasAttribute('data-checkout')) {
      t.disabled = true;
      api('/billing/checkout', { body: { plan: t.getAttribute('data-checkout'), billing: state.billing } }).then(function (r) {
        if (r.mode === 'stripe') { location.href = r.url; return; }
        return loadMe().then(function () { toast('Abonnement activé.'); if (onboardingDone()) return launch(); render(); });
      }).catch(function (err) { toast(err.message, true); t.disabled = false; });
    }
    else if (t.id === 'cancel-sub') { if (!t.getAttribute('data-confirm')) { t.setAttribute('data-confirm', '1'); t.textContent = 'Confirmer la résiliation'; return; } api('/billing/cancel', { method: 'POST' }).then(loadMe).then(function () { toast('Abonnement résilié.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.id === 'revoke') { if (!t.getAttribute('data-confirm')) { t.setAttribute('data-confirm', '1'); t.textContent = 'Confirmer la révocation'; return; } api('/mandate', { method: 'DELETE' }).then(loadMe).then(function () { toast('Mandat révoqué.'); render(); }); }
    else if (t.id === 'launch') { t.disabled = true; launch(); }
    else if (t.hasAttribute('data-resolve')) { t.disabled = true; api('/requests/' + t.getAttribute('data-resolve') + '/resolve', { method: 'POST' }).then(function () { toast('Merci. La demande reprend son cours.'); loadDash(); }).catch(function (err) { toast(err.message, true); t.disabled = false; }); }
    else if (t.hasAttribute('data-mails')) {
      var row = t.closest('.row'), open = $('.mail', row);
      if (open) { open.remove(); return; }
      api('/requests/' + t.getAttribute('data-mails') + '/mails').then(function (m) {
        var box = document.createElement('div'); box.className = 'mail';
        box.innerHTML = m.mails.length ? m.mails.map(function (x) { return '<p class="mono mono--plain">' + esc(fmtTime(x.created_at)) + ' · à ' + esc(x.to_addr) + ' · ' + esc(x.mode === 'smtp' ? 'envoyé' : 'boîte d’envoi locale') + '</p><div class="mail-body">' + esc(x.subject + '\n\n' + x.body) + '</div>'; }).join('') : '<p class="empty">Aucun courrier.</p>';
        row.appendChild(box);
      }).catch(function (err) { toast(err.message, true); });
    }
    else if (t.hasAttribute('data-remove')) { if (!t.getAttribute('data-confirm')) { t.setAttribute('data-confirm', '1'); t.textContent = 'Confirmer le retrait'; return; } api('/profiles/' + t.getAttribute('data-remove'), { method: 'DELETE' }).then(loadMe).then(function () { toast('Profil retiré.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.getAttribute('href') && /^#profile-/.test(t.getAttribute('href'))) { e.preventDefault(); var el = $(t.getAttribute('href')); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); var inp = $('input', el); if (inp) setTimeout(function () { inp.focus({ preventScroll: true }); }, 400); } }
  });
  document.addEventListener('change', function (e) { if (e.target.id === 'profile-select') { state.profileId = e.target.value; loadDash(); } });
  window.addEventListener('hashchange', render);

  /* ---------- API interne pour les modules optionnels (admin) ---------- */
  window.Oubli = { registerView: registerView, api: api, esc: esc, toast: toast, fmtDate: fmtDate, fmtTime: fmtTime, money: money, chip: chip, dots: dots, statusLabel: statusLabel, subLabel: subLabel, field: field, go: go, render: render, params: params, state: state, NBSP: NBSP, NNBSP: NNBSP };

  /* ---------- démarrage ---------- */
  Promise.all([api('/config').catch(function () { return { plans: { individuel: { name: 'Individuel', members: 1, monthly: 1299, annual: 8388 }, famille: { name: 'Famille', members: 5, monthly: 2499, annual: 16788 } }, billing: 'simulated', brokers: 50, mandate_version: '' }; }), loadMe()]).then(function (r) {
    state.config = r[0];
    var q = params().q; if (q.billing === 'monthly') state.billing = 'monthly';
    render();
  });
})();
