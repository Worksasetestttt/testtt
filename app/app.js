/* Oubli — application cliente (vanilla JS, routage par hash, API JSON avec cookie de session). */
(function () {
  'use strict';
  var NBSP = ' ', NNBSP = ' ';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var view = $('#view'), nav = $('#nav'), topUser = $('#top-user'), toastEl = $('#toast');
  var state = { user: null, profiles: [], config: null, dash: null, profileId: null, billing: 'annual', plan: 'individuel' };
  var pollTimer = null;

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
  function dots(n) { var o = '<span class="dots" aria-label="Sensibilité ' + n + ' sur 3">'; for (var i = 1; i <= 3; i++) o += '<span class="' + (i <= n ? 'on' : '') + '">●</span>'; return o + '</span>'; }
  function field(name, label, value, attrs, hint) { return '<div class="field' + (attrs && attrs.full ? ' field--full' : '') + '"><label for="f-' + name + '">' + label + '</label>' + ((attrs && attrs.textarea) ? '<textarea id="f-' + name + '" name="' + name + '" ' + (attrs.extra || '') + '>' + esc(value) + '</textarea>' : '<input id="f-' + name + '" name="' + name + '" value="' + esc(value) + '" ' + ((attrs && attrs.extra) || '') + '>') + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>'; }
  function formData(form) { var o = {}; new FormData(form).forEach(function (v, k) { o[k] = v; }); return o; }
  function onboardingDone() { var u = state.user, p = state.profiles[0]; return !!(u && p && p.first_name && p.last_name && u.mandate_signed_at && !u.mandate_revoked_at && u.subscription_status === 'active'); }

  /* ---------- session ---------- */
  function loadMe() {
    return api('/me').then(function (d) { state.user = d.user || null; state.profiles = d.profiles || []; return !!d.user; }).catch(function () { state.user = null; state.profiles = []; return false; });
  }
  function setChrome() {
    var on = !!state.user;
    nav.hidden = !on; topUser.hidden = !on;
    if (on) { $('#top-email').textContent = state.user.email; $('#nav-admin').hidden = state.user.role !== 'admin'; }
    var route = params().route;
    nav.querySelectorAll('a').forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('data-route') === route); });
  }
  $('#logout').addEventListener('click', function () { api('/auth/logout', { method: 'POST' }).then(function () { state.user = null; toast('À bientôt.'); go('login'); }); });

  /* ---------- vues ---------- */
  var views = {};

  views.login = function (q) {
    return '<section class="auth card"><h1>Bon retour.</h1><p class="lead">Connectez-vous pour suivre vos demandes.</p>' +
      '<form id="login-form" class="stack" novalidate>' + field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) +
      '<p class="msg" id="form-msg"></p><button class="btn btn--block" type="submit">Se connecter</button></form>' +
      '<p class="switch">Pas encore de dossier&nbsp;? <a href="#signup">Créer un compte</a></p></section>';
  };
  views.signup = function (q) {
    var plan = state.config && state.config.plans[q.plan] ? q.plan : 'individuel', billing = q.billing === 'monthly' ? 'monthly' : 'annual';
    var p = state.config ? state.config.plans[plan] : null;
    return '<section class="auth card"><h1>Ouvrons votre <em>dossier</em>.</h1><p class="lead">Deux minutes pour créer le compte. Les demandes partent dès que le mandat est signé.</p>' +
      '<form id="signup-form" class="stack" novalidate><input type="hidden" name="plan" value="' + esc(plan) + '"><input type="hidden" name="billing" value="' + esc(billing) + '">' +
      (p ? '<p class="notice notice--info">Offre choisie&nbsp;: <strong>' + esc(p.name) + '</strong> · ' + (billing === 'annual' ? 'annuel · ' + money(Math.round(p.annual / 12)) + '/mois' : 'mensuel · ' + money(p.monthly) + '/mois') + ' · modifiable ensuite.</p>' : '') +
      field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10 caractères.') +
      '<p class="msg" id="form-msg"></p><button class="btn btn--block" type="submit">Créer mon compte</button></form>' +
      '<p class="switch">Déjà un compte&nbsp;? <a href="#login">Se connecter</a></p></section>';
  };

  views.onboarding = function () {
    var u = state.user, p = state.profiles[0] || {};
    var s1 = !!(p.first_name && p.last_name), s2 = !!(u.mandate_signed_at && !u.mandate_revoked_at), s3 = u.subscription_status === 'active';
    var cur = !s1 ? 1 : !s2 ? 2 : 3;
    function step(n, label, done) { return '<div class="step ' + (done ? 'is-done' : cur === n ? 'is-current' : '') + '"><span class="step__n">' + (done ? '✓' : n) + '</span>' + label + '</div>'; }
    var html = '<div class="page-head"><div><h1>Trois étapes, puis nous prenons le relais.</h1><p class="lead">Les informations que vous saisissez servent uniquement à identifier vos fiches chez les courtiers. Elles sont chiffrées et jamais revendues.</p></div></div>' +
      '<div class="stepper">' + step(1, 'Vos informations', s1) + step(2, 'Mandat', s2) + step(3, 'Offre', s3) + '</div>';
    if (cur === 1) html += profileForm(p, true);
    else if (cur === 2) html += mandateCard(p);
    else html += '<div class="stack"><div class="card card--flat notice notice--info" style="border:0">Dernière étape&nbsp;: choisissez votre offre. Satisfait ou remboursé pendant 30&nbsp;jours, résiliable en un clic.</div>' + plansBlock() + '</div>';
    return html;
  };

  function profileForm(p, onboarding) {
    return '<form class="card stack profile-form" data-id="' + esc(p.id) + '" novalidate><div class="card__head"><h2>' + (onboarding ? 'Qui devons-nous faire oublier&nbsp;?' : (p.is_primary ? 'Vous' : esc(p.first_name + ' ' + p.last_name))) + '</h2>' + (p.is_primary ? '<span class="badge">Profil principal</span>' : '') + '</div>' +
      '<div class="form-grid">' + field('first_name', 'Prénom', p.first_name || '', { extra: 'required autocomplete="given-name"' }) + field('last_name', 'Nom', p.last_name || '', { extra: 'required autocomplete="family-name"' }) +
      field('birth_date', 'Date de naissance', p.birth_date || '', { extra: 'type="date"' }, 'Aide les courtiers à vous distinguer d’un homonyme.') +
      '<div class="field"><label for="f-country">Pays de résidence</label><select id="f-country" name="country">' + ['FR', 'BE', 'CH', 'LU', 'DE', 'ES', 'IT', 'NL', 'PT', 'GB', 'US', 'CA'].map(function (c) { return '<option value="' + c + '"' + ((p.country || 'FR') === c ? ' selected' : '') + '>' + ({ FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', NL: 'Pays-Bas', PT: 'Portugal', GB: 'Royaume-Uni', US: 'États-Unis', CA: 'Canada' })[c] + '</option>'; }).join('') + '</select></div>' +
      field('emails', 'Adresses e-mail à retirer', (p.emails || []).join('\n'), { textarea: true, full: true }, 'Une par ligne. Toutes les adresses que les courtiers peuvent connaître.') +
      field('phones', 'Numéros de téléphone', (p.phones || []).join('\n'), { textarea: true }, 'Une par ligne.') +
      field('addresses', 'Adresses postales (actuelles et anciennes)', (p.addresses || []).join('\n'), { textarea: true }, 'Une par ligne.') +
      field('aliases', 'Autres noms (nom de naissance, surnoms)', (p.aliases || []).join('\n'), { textarea: true, full: true }) +
      '</div><p class="msg" id="form-msg"></p><div class="btn-row"><button class="btn" type="submit">' + (onboarding ? 'Enregistrer et continuer' : 'Enregistrer') + '</button>' + (!p.is_primary && !onboarding ? '<button class="btn btn--danger btn--sm" type="button" data-remove="' + esc(p.id) + '">Retirer du dossier</button>' : '') + '</div></form>';
  }

  function mandateCard(p) {
    return '<div class="card stack" id="mandate-card"><div class="card__head"><h2>Le mandat qui nous autorise à écrire en votre nom</h2><span class="mono">Version ' + esc(state.config ? state.config.mandate_version : '') + '</span></div>' +
      '<div class="mandate-text" id="mandate-text"><span class="spinner"></span> Chargement du mandat…</div>' +
      '<form id="mandate-form" class="stack" novalidate><label class="check"><input type="checkbox" name="accepted" required> <span>J’ai lu le mandat et j’autorise Oubli à exercer mes droits d’accès, d’effacement et d’opposition auprès des courtiers en données. Je peux le révoquer à tout moment.</span></label>' +
      field('full_name', 'Signez en tapant votre prénom et votre nom', '', { extra: 'placeholder="' + esc((p.first_name || '') + ' ' + (p.last_name || '')) + '" autocomplete="off" required' }) +
      '<p class="msg" id="form-msg"></p><div class="btn-row"><button class="btn" type="submit">Signer électroniquement</button></div></form></div>';
  }

  function plansBlock() {
    var plans = state.config.plans, b = state.billing, u = state.user;
    var seg = '<div class="toolbar"><div class="seg" role="radiogroup" aria-label="Périodicité"><button type="button" role="radio" aria-checked="' + (b === 'monthly') + '" data-billing="monthly">Mensuel</button><button type="button" role="radio" aria-checked="' + (b === 'annual') + '" data-billing="annual">Annuel <span class="badge">jusqu’à −46' + NNBSP + '%</span></button></div>' + (state.config.billing === 'simulated' ? '<span class="mono">Paiement simulé (aucune clé Stripe configurée)</span>' : '') + '</div>';
    var cards = Object.keys(plans).map(function (k) {
      var p = plans[k], cur = u && u.subscription_status === 'active' && u.plan === k;
      var perMonth = b === 'annual' ? Math.round(p.annual / 12) : p.monthly;
      return '<div class="card plan' + (cur ? ' is-current' : '') + '"><div class="card__head"><h3>' + esc(p.name) + '</h3><span class="mono">' + (p.members > 1 ? 'Jusqu’à ' + p.members + ' personnes' : 'Une personne') + '</span></div>' +
        '<div class="plan__price">' + money(perMonth) + ' <small>/mois</small></div><p class="mono">' + (b === 'annual' ? 'soit ' + money(p.annual) + ' facturés par an' : 'sans engagement, ' + money(p.monthly) + ' par mois') + '</p>' +
        '<ul><li>Demandes auprès de ' + (state.config.brokers || '') + ' courtiers et annuaires</li><li>Relances automatiques à l’échéance légale</li><li>Nouvelle vérification tous les 60 à 90 jours</li><li>Journal horodaté, preuves exportables</li>' + (p.members > 1 ? '<li>Un dossier par personne, une seule facture</li>' : '') + '</ul>' +
        (cur ? '<p class="notice notice--ok">Votre offre actuelle (' + (u.billing === 'annual' ? 'annuelle' : 'mensuelle') + ').</p>' : '<button class="btn btn--block' + (k === 'famille' ? ' btn--outline' : '') + '" type="button" data-checkout="' + k + '">' + (u && u.subscription_status === 'active' ? 'Passer à ' + esc(p.name) : 'Choisir ' + esc(p.name)) + '</button>') + '</div>';
    }).join('');
    return seg + '<div class="plans">' + cards + '</div><p class="mono" style="margin-top:14px">Prix TTC · Satisfait ou remboursé 30 jours · Résiliation en un clic</p>';
  }

  views.dashboard = function () {
    var d = state.dash; if (!d) return '<div class="empty"><span class="spinner"></span></div>';
    var c = d.counters, u = d.user;
    var warn = '';
    if (u.subscription_status !== 'active') warn = '<div class="notice">' + (u.subscription_status === 'past_due' ? 'Votre dernier paiement a échoué : mettez à jour votre moyen de paiement pour que les demandes continuent.' : u.subscription_status === 'canceled' ? 'Abonnement résilié' + (u.subscription_ends_at ? ' : les demandes continuent jusqu’au ' + fmtDate(u.subscription_ends_at) + '.' : '.') : 'En attente de confirmation du paiement. Les demandes partiront automatiquement dès que l’abonnement sera actif.') + ' <a href="#billing">Voir l’abonnement</a></div>';
    if (u.mandate_revoked_at) warn += '<div class="notice">Mandat révoqué : plus aucune demande n’est envoyée. <a href="#dossier">Signer un nouveau mandat</a></div>';
    var profSel = d.profiles.length > 1 ? '<label class="mono" for="profile-select">Dossier de&nbsp;</label><select id="profile-select">' + d.profiles.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === d.profile_id ? ' selected' : '') + '>' + esc(p.first_name + ' ' + p.last_name) + '</option>'; }).join('') + '</select>' : '';
    var circ = 2 * Math.PI * 52;
    var ring = '<svg class="ring" viewBox="0 0 120 120" role="img" aria-label="Exposition ' + d.exposure + ' %"><circle class="track" cx="60" cy="60" r="52"/><circle class="fill" cx="60" cy="60" r="52" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (circ * (1 - d.exposure / 100)).toFixed(1) + '"/><text x="60" y="56">' + d.exposure + NNBSP + '%</text><text class="lbl" x="60" y="78">EXPOSITION</text></svg>';
    var rows = d.requests.map(function (r) {
      var action = r.status === 'action_required' ? '<button class="btn btn--sm" type="button" data-resolve="' + esc(r.id) + '">Vérification faite</button>' : '';
      var when = r.status === 'done' ? 'Effacée le ' + fmtDate(r.completed_at) + (r.next_check_at ? ' · revérif. ' + fmtDate(r.next_check_at) : '') : r.sent_at ? 'Envoyée le ' + fmtDate(r.sent_at) + (r.due_at ? ' · réponse due le ' + fmtDate(r.due_at) : '') : 'Prochain envoi';
      return '<tr><td><strong>' + esc(r.broker) + '</strong><span class="sub">' + esc(r.category) + ' · ' + esc(r.domain) + '</span></td><td>' + dots(r.sensitivity) + '</td><td>' + chip(r.status) + (r.note ? '<span class="sub">' + esc(r.note) + '</span>' : '') + '</td><td><span class="sub" style="font-size:.85rem;color:var(--text)">' + when + '</span><span class="sub">' + (r.legal_basis === 'ccpa' ? 'CCPA' : r.legal_basis === 'both' ? 'RGPD · CCPA' : 'RGPD art. 17') + ' · cycle ' + r.cycle + ' · ' + esc(r.ref) + '</span></td><td class="row-actions">' + action + (r.sent_at ? '<button class="btn btn--ghost btn--sm" type="button" data-mails="' + esc(r.id) + '">Courrier</button>' : '') + '</td></tr>';
    }).join('');
    var journal = d.events.map(function (e) { return '<li><time datetime="' + esc(e.created_at) + '">' + fmtTime(e.created_at) + '</time><span class="t-' + esc(e.type) + '">' + esc(e.message) + '</span></li>'; }).join('');
    return '<div class="page-head"><div><h1>Dossier n<sup>o</sup>' + NBSP + esc(d.profile_id.slice(0, 4).toUpperCase()) + ' — ' + esc((d.profiles.find(function (p) { return p.id === d.profile_id; }) || {}).first_name || '') + '</h1><p class="lead">' + (c.total ? 'Mis à jour ' + fmtTime(new Date().toISOString()) + '. ' : '') + (d.next_check_at ? 'Prochaine vérification le ' + fmtDate(d.next_check_at) + '.' : c.total ? 'Les courtiers ont un mois (RGPD) ou 45 jours (CCPA) pour répondre.' : 'Les premières demandes partiront dès que le dossier sera complet.') + '</p></div><div class="btn-row">' + profSel + (c.total === 0 && onboardingDone() ? '<button class="btn" type="button" id="launch">Lancer les demandes</button>' : '') + '</div></div>' + warn +
      '<div class="stack"><div class="counters"><div class="counter"><span class="mono">Demandes envoyées</span><span class="counter__n">' + c.sent + '</span><span class="counter__sub">sur ' + c.brokers + ' courtiers surveillés</span></div><div class="counter"><span class="mono">En cours</span><span class="counter__n">' + c.in_progress + '</span><span class="counter__sub">réponse attendue</span></div><div class="counter' + (c.action_required ? ' counter--warn' : '') + '"><span class="mono">Action requise</span><span class="counter__n">' + c.action_required + '</span><span class="counter__sub">' + (c.action_required ? 'vérification à faire' : 'rien à faire') + '</span></div><div class="counter counter--ok"><span class="mono">Terminées</span><span class="counter__n">' + c.done + '</span><span class="counter__sub">effacements confirmés</span></div></div>' +
      '<div class="grid-2"><div class="card exposure">' + ring + '<div class="exposure__txt"><strong>Exposition estimée</strong><span class="lead" style="font-size:.95rem">Part des courtiers surveillés qui n’ont pas encore confirmé l’effacement. Elle baisse à chaque confirmation et remonte si une fiche réapparaît.</span></div></div>' +
      '<div class="card"><div class="card__head"><h2>Journal</h2><span class="mono">Horodaté · exportable</span></div>' + (journal ? '<ul class="journal">' + journal + '</ul>' : '<p class="empty">Rien pour l’instant.</p>') + '</div></div>' +
      '<div><div class="toolbar"><h2>Courtiers</h2><span class="mono">' + c.total + ' demandes · ' + c.queued + ' à envoyer</span></div>' + (rows ? '<div class="table-wrap"><table><thead><tr><th>Courtier</th><th>Sensibilité</th><th>Statut</th><th>Suivi</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="card empty">Aucune demande pour ce dossier.' + (onboardingDone() ? '' : ' <a href="#onboarding">Terminer les étapes</a>') + '</div>') + '</div></div>';
  };

  views.dossier = function () {
    var u = state.user, max = (state.config.plans[u.plan] || { members: 1 }).members;
    var forms = state.profiles.map(function (p) { return profileForm(p, false); }).join('');
    var add = state.profiles.length < max ? '<form class="card card--flat stack" id="add-member" novalidate><h3>Ajouter un proche</h3><div class="form-grid">' + field('first_name', 'Prénom', '', { extra: 'required' }) + field('last_name', 'Nom', '', { extra: 'required' }) + '</div><p class="msg" id="form-msg-add"></p><div><button class="btn btn--outline" type="submit">Ajouter au dossier</button></div></form>' : (max === 1 ? '<p class="notice notice--info">L’offre Individuel couvre une personne. <a href="#billing">Passer à Famille</a> pour protéger jusqu’à 5 proches.</p>' : '');
    var m = u.mandate_signed_at && !u.mandate_revoked_at ? '<div class="card stack" id="mandate-card"><div class="card__head"><h2>Mandat</h2><span class="stamp">Signé le ' + fmtDate(u.mandate_signed_at) + '</span></div><div class="mandate-text" id="mandate-text"><span class="spinner"></span></div><div class="btn-row"><a class="btn btn--outline btn--sm" href="/api/mandate" download="mandat-oubli.json">Télécharger</a><button class="btn btn--danger btn--sm" type="button" id="revoke">Révoquer le mandat</button></div></div>' : mandateCard(state.profiles[0] || {});
    return '<div class="page-head"><div><h1>Votre dossier</h1><p class="lead">Les informations servent à identifier vos fiches chez les courtiers. Plus elles sont complètes, plus les suppressions sont rapides.</p></div></div><div class="stack">' + forms + add + m + '</div>';
  };

  views.billing = function () {
    var u = state.user;
    var status = '<div class="card"><div class="card__head"><h2>Votre abonnement</h2>' + chip(u.subscription_status, subLabel(u.subscription_status)) + '</div><dl class="kv"><dt>Offre</dt><dd>' + (u.plan ? esc(state.config.plans[u.plan].name) + ' · ' + (u.billing === 'annual' ? 'annuel' : 'mensuel') : '—') + '</dd><dt>Paiement</dt><dd>' + (u.billing_mode === 'stripe' ? 'Carte via Stripe' : u.billing_mode === 'simulated' ? 'Simulé (environnement de test)' : '—') + '</dd>' + (u.subscription_ends_at ? '<dt>Fin d’accès</dt><dd>' + fmtDate(u.subscription_ends_at) + '</dd>' : '') + '</dl>' + (u.subscription_status === 'active' ? '<div class="btn-row" style="margin-top:18px"><button class="btn btn--danger btn--sm" type="button" id="cancel-sub">Résilier</button><span class="mono">Satisfait ou remboursé 30 jours</span></div>' : '') + '</div>';
    return '<div class="page-head"><div><h1>Abonnement</h1><p class="lead">Un prix clair, une seule mission. Changez d’offre à tout moment.</p></div></div><div class="stack">' + status + plansBlock() + '</div>';
  };

  views.settings = function () {
    return '<div class="page-head"><div><h1>Paramètres</h1><p class="lead">Votre compte, vos données, vos droits.</p></div></div><div class="grid-2">' +
      '<form class="card stack" id="pwd-form" novalidate><h2>Mot de passe</h2>' + field('current', 'Mot de passe actuel', '', { extra: 'type="password" autocomplete="current-password" required' }) + field('next', 'Nouveau mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10 caractères. Les autres sessions seront déconnectées.') + '<p class="msg" id="form-msg"></p><div><button class="btn btn--outline" type="submit">Changer</button></div></form>' +
      '<div class="stack"><div class="card stack"><h2>Vos données chez Oubli</h2><p class="lead" style="font-size:.95rem">Nous appliquons à nous-mêmes ce que nous demandons aux courtiers : export complet en un clic, suppression définitive sur demande.</p><div class="btn-row"><a class="btn btn--outline btn--sm" href="/api/export" download="oubli-export.json">Exporter mes données (JSON)</a></div></div>' +
      '<form class="card stack" id="delete-form" novalidate><h2>Supprimer le compte</h2><p class="lead" style="font-size:.95rem">Résilie l’abonnement, supprime vos profils, vos demandes et le journal. Irréversible.</p>' + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) + '<p class="msg" id="form-msg-del"></p><div><button class="btn btn--danger" type="submit">Supprimer définitivement</button></div></form></div></div>';
  };

  views.admin = function () {
    return '<div class="page-head"><div><h1>Administration</h1><p class="lead">Suivi global, traitement des réponses, contacts des courtiers.</p></div><div class="btn-row"><button class="btn btn--outline btn--sm" type="button" id="admin-tick">Exécuter le planificateur</button></div></div><div id="admin-body"><span class="spinner"></span></div>';
  };

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
    if (route === 'admin') loadAdmin();
  }
  function loadDash() {
    var pid = state.profileId ? '?profile_id=' + encodeURIComponent(state.profileId) : '';
    api('/dashboard' + pid).then(function (d) { state.dash = d; state.user = d.user; state.profiles = d.profiles; if (params().route === 'dashboard') { var y = window.scrollY; view.innerHTML = views.dashboard(); window.scrollTo(0, y); } }).catch(function (e) { toast(e.message, true); });
  }
  function loadMandateText() {
    var box = $('#mandate-text'); if (!box) return;
    api('/mandate').then(function (m) { box.textContent = m.text || ''; }).catch(function (e) { box.textContent = e.message; });
  }
  function loadAdmin() {
    api('/admin/stats').then(function (s) {
      var reqs = s.requests.map(function (r) { return '<li>' + chip(r.status) + ' ' + r.n + '</li>'; }).join('');
      var act = s.action_required.map(function (r) { return '<tr><td>' + esc(r.broker) + '<span class="sub">' + esc(r.email) + ' · OUBLI-' + esc(r.token) + '</span></td><td class="row-actions"><button class="btn btn--sm" data-outcome="done" data-req="' + esc(r.id) + '" type="button">Effacée</button><button class="btn btn--outline btn--sm" data-outcome="in_progress" data-req="' + esc(r.id) + '" type="button">En cours</button><button class="btn btn--danger btn--sm" data-outcome="refused" data-req="' + esc(r.id) + '" type="button">Refus</button></td></tr>'; }).join('');
      $('#admin-body').innerHTML = '<div class="stack"><div class="counters"><div class="counter"><span class="mono">Comptes</span><span class="counter__n">' + s.users + '</span></div><div class="counter counter--ok"><span class="mono">Abonnés actifs</span><span class="counter__n">' + s.active + '</span></div><div class="counter"><span class="mono">Courriers</span><span class="counter__n">' + s.mails + '</span></div></div><div class="card"><h2>Demandes par statut</h2><ul class="journal" style="margin-top:12px">' + (reqs || '<li>Aucune</li>') + '</ul></div><div class="card"><h2>Actions requises à traiter</h2>' + (act ? '<div class="table-wrap" style="margin-top:12px"><table><tbody>' + act + '</tbody></table></div>' : '<p class="empty">Rien en attente.</p>') + '</div><div class="card"><h2>Contacts des courtiers</h2><p class="lead" style="font-size:.95rem;margin:8px 0 12px">En SMTP réel, seuls les contacts vérifiés reçoivent des demandes. Vérifiez chaque adresse (page « privacy » du courtier) puis cochez-la.</p><div id="admin-brokers"><span class="spinner"></span></div></div></div>';
      return api('/brokers');
    }).then(function (b) {
      var rows = b.brokers.map(function (x) { return '<tr><td><strong>' + esc(x.name) + '</strong><span class="sub">' + esc(x.category) + ' · ' + esc(x.jurisdiction) + '</span></td><td><input class="input" data-broker-email="' + x.id + '" value="' + esc(x.contact_email || '') + '" aria-label="Contact ' + esc(x.name) + '"></td><td><label class="check" style="align-items:center"><input type="checkbox" data-broker-verified="' + x.id + '"' + (x.contact_verified ? ' checked' : '') + '> vérifié</label></td><td><button class="btn btn--outline btn--sm" type="button" data-broker-save="' + x.id + '">Enregistrer</button></td></tr>'; }).join('');
      $('#admin-brokers').innerHTML = '<div class="table-wrap"><table><tbody>' + rows + '</tbody></table></div>';
    }).catch(function (e) { $('#admin-body').innerHTML = '<p class="notice">' + esc(e.message) + '</p>'; });
  }

  /* ---------- interactions (délégation) ---------- */
  function busy(form, on) { var b = form.querySelector('button[type="submit"]'); if (b) b.disabled = on; }
  function showMsg(form, text, isErr, id) { var m = form.querySelector(id || '.msg'); if (m) { m.textContent = text || ''; m.classList.toggle('is-error', !!isErr); } }

  document.addEventListener('submit', function (e) {
    var f = e.target; e.preventDefault();
    if (f.id === 'login-form' || f.id === 'signup-form') {
      var d = formData(f); busy(f, true); showMsg(f, '');
      api(f.id === 'login-form' ? '/auth/login' : '/auth/signup', { body: d }).then(function () { return loadMe(); }).then(function () { toast(f.id === 'login-form' ? 'Connecté.' : 'Compte créé. Dossier ouvert.'); go(onboardingDone() ? 'dashboard' : 'onboarding'); }).catch(function (err) { showMsg(f, err.message, true); }).finally(function () { busy(f, false); });
    } else if (f.classList.contains('profile-form')) {
      var pd = formData(f); busy(f, true); showMsg(f, '');
      api('/profiles/' + f.getAttribute('data-id'), { method: 'PUT', body: pd }).then(function () { return loadMe(); }).then(function () { toast('Informations enregistrées.'); render(); }).catch(function (err) { showMsg(f, err.message, true); }).finally(function () { busy(f, false); });
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

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t) return;
    if (t.hasAttribute('data-billing')) { state.billing = t.getAttribute('data-billing'); render(); }
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
      var tr = t.closest('tr'); var next = tr.nextElementSibling;
      if (next && next.classList.contains('mail-row')) { next.remove(); return; }
      api('/requests/' + t.getAttribute('data-mails') + '/mails').then(function (m) {
        var row = document.createElement('tr'); row.className = 'mail-row';
        row.innerHTML = '<td colspan="5">' + (m.mails.length ? m.mails.map(function (x) { return '<p class="mono" style="margin:6px 0">' + esc(fmtTime(x.created_at)) + ' · à ' + esc(x.to_addr) + ' · ' + esc(x.mode === 'smtp' ? 'envoyé' : 'boîte d’envoi locale') + '</p><div class="mail-body">' + esc(x.subject + '\n\n' + x.body) + '</div>'; }).join('') : '<p class="empty">Aucun courrier.</p>') + '</td>';
        tr.after(row);
      }).catch(function (err) { toast(err.message, true); });
    }
    else if (t.hasAttribute('data-remove')) { if (!t.getAttribute('data-confirm')) { t.setAttribute('data-confirm', '1'); t.textContent = 'Confirmer le retrait'; return; } api('/profiles/' + t.getAttribute('data-remove'), { method: 'DELETE' }).then(loadMe).then(function () { toast('Profil retiré.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.id === 'admin-tick') { t.disabled = true; api('/admin/tick', { method: 'POST' }).then(function () { toast('Planificateur exécuté.'); loadAdmin(); }).finally(function () { t.disabled = false; }); }
    else if (t.hasAttribute('data-outcome')) { api('/admin/requests/' + t.getAttribute('data-req') + '/outcome', { body: { outcome: t.getAttribute('data-outcome') } }).then(function () { toast('Résultat enregistré.'); loadAdmin(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.hasAttribute('data-broker-save')) { var id = t.getAttribute('data-broker-save'); api('/admin/brokers/' + id, { method: 'PUT', body: { contact_email: $('[data-broker-email="' + id + '"]').value, contact_verified: $('[data-broker-verified="' + id + '"]').checked } }).then(function () { toast('Contact enregistré.'); }).catch(function (err) { toast(err.message, true); }); }
  });
  document.addEventListener('change', function (e) { if (e.target.id === 'profile-select') { state.profileId = e.target.value; loadDash(); } });
  window.addEventListener('hashchange', render);

  /* ---------- démarrage ---------- */
  Promise.all([api('/config').catch(function () { return { plans: { individuel: { name: 'Individuel', members: 1, monthly: 1299, annual: 8388 }, famille: { name: 'Famille', members: 5, monthly: 2499, annual: 16788 } }, billing: 'simulated', brokers: 50 }; }), loadMe()]).then(function (r) {
    state.config = r[0];
    var q = params().q; if (q.billing === 'monthly') state.billing = 'monthly';
    render();
  });
})();
