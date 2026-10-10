/* Oubli — application cliente (vanilla JS, routage par hash, API JSON avec cookie de session). */
(function () {
  'use strict';
  var NBSP = ' ', NNBSP = ' ', SEP = NBSP + '· ';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var view = $('#view'), nav = $('#nav'), topUser = $('#top-user'), toastEl = $('#toast'), announceEl = $('#announce');
  var state = { user: null, profiles: [], config: null, dash: null, profileId: null, billing: 'annual', filter: 'all', search: '', sort: 'status', page: 1, journalAll: false };
  var PAGE = 25, JOURNAL = 8;
  var pollTimer = null, sigs = {}, searchTimer = null, resizeTimer = null;
  var MARK = '<svg viewBox="0 0 32 32" width="44" height="44" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="10.5" stroke="currentColor" stroke-width="3.2"/><path d="M3.5 17.8 L28.5 14.2" stroke="#C8471F" stroke-width="3.2" stroke-linecap="round"/></svg>';
  var COUNTRIES = { FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', NL: 'Pays-Bas', PT: 'Portugal', GB: 'Royaume-Uni', US: 'États-Unis', CA: 'Canada' };
  var SENS = { 3: 'Sensibilité élevée', 2: 'Sensibilité moyenne', 1: 'Sensibilité faible' };

  /* ---------- utilitaires ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /* Typographie française pour les textes venant du serveur : apostrophe typographique, insécable avant : ; ? ! » */
  function typo(s) { return String(s == null ? '' : s).replace(/'/g, '’').replace(/ ([:;?!»])/g, NBSP + '$1').replace(/« /g, '«' + NBSP); }
  function money(cents) { return (cents / 100).toFixed(2).replace('.', ',') + NNBSP + '€'; }
  function fmtDate(iso, opts) { if (!iso) return '—'; return new Date(iso).toLocaleDateString('fr-FR', opts || { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtDay(iso) { return fmtDate(iso, { day: 'numeric', month: 'short' }); }
  function fmtTime(iso) { return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function fmtWhen(iso) { if (!iso) return '—'; return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' à ' + new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  function plural(n, one, many) { return n + NBSP + (n > 1 ? many : one); }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function announce(msg) { if (!announceEl) return; announceEl.textContent = ''; requestAnimationFrame(function () { announceEl.textContent = msg; }); }
  function toast(msg, isError) {
    toastEl.textContent = ''; toastEl.classList.toggle('is-error', !!isError); toastEl.setAttribute('role', isError ? 'alert' : 'status');
    requestAnimationFrame(function () { toastEl.textContent = msg; });
    clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.textContent = ''; }, isError ? 8000 : 4200);
  }
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
  function statusLabel(s) { return { queued: 'À envoyer', sent: 'Envoyée', in_progress: 'En cours', action_required: 'Action requise', done: 'Terminée', refused: 'Refusée', error: 'Erreur d’envoi' }[s] || s; }
  function subLabel(s) { return { none: 'Aucun abonnement', active: 'Actif', past_due: 'Paiement en attente', canceled: 'Résilié' }[s] || s; }
  function chip(s, label) { return '<span class="chip chip--' + esc(s) + '">' + esc(label || statusLabel(s)) + '</span>'; }
  function dots(n) { var o = '<span class="dots" title="' + (SENS[n] || 'Sensibilité ' + n + ' sur 3') + '"><span class="vh">' + (SENS[n] || 'Sensibilité ' + n + ' sur 3') + '.</span>'; for (var i = 1; i <= 3; i++) o += '<i class="' + (i <= n ? 'on' : '') + '"></i>'; return o + '</span>'; }
  function field(name, label, value, attrs, hint, scope) {
    attrs = attrs || {}; var id = 'f-' + (scope ? scope + '-' : '') + name, hid = id + '-hint';
    return '<div class="f' + (attrs.full ? ' f--full' : '') + '"><label for="' + id + '">' + label + '</label><input id="' + id + '" name="' + name + '" value="' + esc(value) + '" ' + (attrs.extra || '') + (hint ? ' aria-describedby="' + hid + '"' : '') + '>' + (hint ? '<span class="hint" id="' + hid + '">' + hint + '</span>' : '') + '</div>';
  }
  function tagField(name, label, values, placeholder, hint, scope) {
    var base = (scope ? scope + '-' : '') + name;
    return '<div class="f f--full f--list" data-name="' + name + '"><span class="f__label" id="lbl-' + base + '">' + label + '</span>' +
      '<ul class="tags" role="list" aria-labelledby="lbl-' + base + '">' + (values || []).map(function (v) { return '<li class="tag"><span title="' + esc(v) + '">' + esc(v) + '</span><button type="button" aria-label="Retirer ' + esc(v) + '">×</button></li>'; }).join('') + '</ul>' +
      '<div class="tags__add"><input id="add-' + base + '" type="text" placeholder="' + esc(placeholder) + '" aria-label="Ajouter' + NBSP + ': ' + esc(label) + '" autocomplete="off"' + (hint ? ' aria-describedby="hint-' + base + '"' : '') + '><button type="button">Ajouter</button></div>' +
      (hint ? '<span class="hint" id="hint-' + base + '">' + hint + '</span>' : '') + '</div>';
  }
  function msgEl(id, style) { return '<p class="msg" id="' + id + '" role="alert" aria-atomic="true"' + (style ? ' style="' + style + '"' : '') + '></p>'; }
  function formData(form) { var o = {}; new FormData(form).forEach(function (v, k) { o[k] = v; }); return o; }
  function initials(p) { return ((p.first_name || '?')[0] + (p.last_name || '')[0] || '').toUpperCase(); }
  function fullName(p) { return ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || 'Sans nom'; }
  function onboardingDone() { var u = state.user, p = state.profiles[0]; return !!(u && p && p.first_name && p.last_name && u.mandate_signed_at && !u.mandate_revoked_at && u.subscription_status === 'active'); }
  function fileNo(id) { return 'N°' + NBSP + String(id || '').slice(0, 4).toUpperCase(); }
  function scopeOf(p) { return String(p.id || 'new').slice(0, 8); }

  /* ---------- session ---------- */
  function loadMe() {
    return api('/me').then(function (d) { state.user = d.user || null; state.profiles = d.profiles || []; return !!d.user; }).catch(function () { state.user = null; state.profiles = []; return false; });
  }
  function resetSession() { state.user = null; state.profiles = []; state.dash = null; state.profileId = null; sigs = {}; }
  function setChrome() {
    var on = !!state.user;
    nav.hidden = !on; topUser.hidden = !on;
    if (on) { $('#top-email').textContent = state.user.email; $('#nav-admin').hidden = state.user.role !== 'admin'; }
    var route = params().route;
    $$('a', nav).forEach(function (a) { var act = a.getAttribute('data-route') === route; a.classList.toggle('is-active', act); if (act) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  $('#logout').addEventListener('click', function () { api('/auth/logout', { method: 'POST' }).then(function () { resetSession(); toast('À bientôt.'); go('login'); }); });

  /* ---------- vues ---------- */
  var views = {};

  views.login = function (q) {
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Bon retour.</h1><p class="lead">Connectez-vous pour suivre vos demandes.</p>' +
      '<form id="login-form" class="sheet" novalidate><div class="sheet__body"><div class="fields">' + field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) +
      '</div>' + msgEl('msg-login-form', 'margin-top:16px') + '<button class="btn btn--block" type="submit">Se connecter</button></div></form>' +
      '<p class="switch">Pas encore de dossier' + NBSP + '? <a href="#signup">Créer un compte</a></p></section>';
  };
  views.signup = function (q) {
    var plan = state.config && state.config.plans[q.plan] ? q.plan : 'individuel', billing = q.billing === 'monthly' ? 'monthly' : 'annual';
    var p = state.config ? state.config.plans[plan] : null;
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Ouvrons votre <em>dossier</em>.</h1><p class="lead">Deux minutes pour créer le compte. Les demandes partent dès que le mandat est signé.</p>' +
      '<form id="signup-form" class="sheet" novalidate><div class="sheet__body"><input type="hidden" name="plan" value="' + esc(plan) + '"><input type="hidden" name="billing" value="' + esc(billing) + '">' +
      (p ? '<div class="offer"><span><span class="mono">Offre</span><br><strong>' + esc(p.name) + '</strong>' + SEP + (billing === 'annual' ? 'annuel' : 'mensuel') + '</span><span><strong>' + money(billing === 'annual' ? Math.round(p.annual / 12) : p.monthly) + '</strong><small class="mono--plain mono">/mois</small></span></div>' : '') +
      '<div class="fields">' + field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10' + NBSP + 'caractères.') +
      '</div>' + msgEl('msg-signup-form', 'margin-top:16px') + '<button class="btn btn--block" type="submit">Créer mon compte <span class="btn__arrow" aria-hidden="true">→</span></button></div></form>' +
      '<p class="switch">Déjà un compte' + NBSP + '? <a href="#login">Se connecter</a></p></section>';
  };

  views.onboarding = function () {
    var u = state.user, p = state.profiles[0] || {};
    var s1 = !!(p.first_name && p.last_name), s2 = !!(u.mandate_signed_at && !u.mandate_revoked_at), s3 = u.subscription_status === 'active';
    var cur = !s1 ? 1 : !s2 ? 2 : 3;
    function step(n, title, sub, done) { return '<li class="rail__step ' + (done ? 'is-done' : cur === n ? 'is-current' : '') + '"' + (cur === n ? ' aria-current="step"' : '') + '><span class="rail__n">0' + n + '</span><div><strong>' + title + '</strong><span>' + sub + '</span></div></li>'; }
    var html = '<div class="page-head"><div><span class="mono">Dossier ' + fileNo(p.id) + SEP + 'Ouverture</span><h1>Trois étapes, puis nous prenons le relais.</h1></div></div>' +
      '<div class="onb"><ol class="rail" aria-label="Étapes">' + step(1, 'Vos informations', 'Ce que les courtiers peuvent connaître de vous.', s1) + step(2, 'Le mandat', 'L’autorisation d’écrire en votre nom. Révocable.', s2) + step(3, 'L’offre', 'Satisfait ou remboursé 30' + NBSP + 'jours.', s3) + '</ol><div>';
    if (cur === 1) html += profileForm(p, true);
    else if (cur === 2) html += mandateCard(p);
    else html += '<div class="stack"><div><h2>Dernière étape' + NBSP + ': votre offre</h2><p class="lead">Les demandes partent dans la foulée.</p></div>' + plansBlock() + '</div>';
    return html + '</div></div>';
  };

  /* Les identifiants ne sont préfixés (scope) que sur la page Dossier, où plusieurs formulaires coexistent. */
  function profileForm(p, onboarding) {
    var sc = onboarding ? '' : scopeOf(p), cid = 'f-' + (sc ? sc + '-' : '') + 'country';
    return '<form class="sheet profile-form" data-id="' + esc(p.id) + '" id="profile-form-' + esc(scopeOf(p)) + '" novalidate>' +
      '<div class="sheet__head"><span class="mono">Dossier ' + fileNo(p.id) + (p.is_primary ? SEP + 'Profil principal' : SEP + 'Proche') + '</span>' + (p.updated_at && p.first_name ? '<span class="mono mono--plain">Mis à jour le ' + fmtDate(p.updated_at) + '</span>' : '') + '</div>' +
      '<div class="sheet__body"><div class="sheet__section"><h2>' + (onboarding ? 'Qui devons-nous faire oublier' + NBSP + '?' : (p.is_primary ? 'Vous' : esc(fullName(p)))) + '</h2><p class="hint">Ces informations servent uniquement à identifier vos fiches chez les courtiers. Chiffrées, jamais revendues.</p>' +
      '<div class="fields fields--2">' + field('first_name', 'Prénom', p.first_name || '', { extra: 'required autocomplete="given-name"' }, '', sc) + field('last_name', 'Nom', p.last_name || '', { extra: 'required autocomplete="family-name"' }, '', sc) +
      field('birth_date', 'Date de naissance', p.birth_date || '', { extra: 'type="date"' }, 'Distingue vos fiches de celles d’un homonyme.', sc) +
      '<div class="f"><label for="' + cid + '">Pays de résidence</label><select id="' + cid + '" name="country">' + Object.keys(COUNTRIES).map(function (c) { return '<option value="' + c + '"' + ((p.country || 'FR') === c ? ' selected' : '') + '>' + COUNTRIES[c] + '</option>'; }).join('') + '</select></div></div></div>' +
      '<div class="sheet__section"><h2>Ce qu’ils peuvent savoir de vous</h2><p class="hint">Ajoutez toutes les variantes connues' + NBSP + ': anciennes adresses, ancien numéro, adresse e-mail d’étudiant… Plus la liste est complète, plus les suppressions sont rapides.</p>' +
      '<div class="fields" style="gap:30px">' + tagField('emails', 'Adresses e-mail', p.emails, 'ajouter une adresse e-mail', '', sc) + tagField('phones', 'Numéros de téléphone', p.phones, 'ajouter un numéro', '', sc) + tagField('addresses', 'Adresses postales, actuelles et passées', p.addresses, 'ajouter une adresse postale', '', sc) + tagField('aliases', 'Autres noms utilisés', p.aliases, 'nom de naissance, surnom…', '', sc) + '</div></div>' +
      msgEl('msg-profile-' + esc(scopeOf(p)), 'margin-top:20px') + '</div>' +
      '<div class="sheet__foot"><div class="btn-row"><button class="btn" type="submit">' + (onboarding ? 'Enregistrer et continuer <span class="btn__arrow" aria-hidden="true">→</span>' : 'Enregistrer') + '</button>' + (!p.is_primary && !onboarding ? '<button class="btn btn--danger btn--sm" type="button" data-remove="' + esc(p.id) + '">Retirer du dossier</button>' : '') + '</div><span class="mono">Chiffré AES-256' + SEP + 'Hébergé en France</span></div></form>';
  }

  function mandateCard(p) {
    return '<div class="sheet" id="mandate-card"><div class="sheet__head"><span class="mono">Mandat de représentation' + SEP + 'RGPD art. 17 &amp; 21</span><span class="mono mono--plain">Version ' + esc(state.config ? state.config.mandate_version : '') + '</span></div>' +
      '<div class="sheet__body"><div class="sheet__section"><h2>L’autorisation d’écrire en votre nom</h2><p class="hint">Un courtier n’a pas à répondre à un tiers. Ce mandat nous permet d’exercer vos droits à votre place. Vous pouvez le révoquer à tout moment depuis votre dossier.</p>' +
      '<div class="mandate-text" id="mandate-text"><span class="spinner"></span> Chargement du mandat…</div></div>' +
      '<form id="mandate-form" class="sheet__section" novalidate><label class="check"><input type="checkbox" name="accepted" required aria-describedby="msg-mandate-form"> <span>J’ai lu le mandat et j’autorise Oubli à exercer mes droits d’accès, d’effacement et d’opposition auprès des courtiers en données.</span></label>' +
      '<div class="sig" style="margin-top:28px"><div class="f"><label for="f-full_name">Signez en tapant votre prénom et votre nom</label><input id="f-full_name" name="full_name" placeholder="' + esc((p.first_name || '') + ' ' + (p.last_name || '')) + '" autocomplete="off" required></div><button class="btn" type="submit">Signer électroniquement</button></div>' +
      msgEl('msg-mandate-form', 'margin-top:14px') + '</form></div></div>';
  }

  function plansBlock() {
    var plans = state.config.plans, b = state.billing, u = state.user;
    var subscribed = !!(u && u.subscription_status === 'active'), featured = u && u.plan && plans[u.plan] ? u.plan : 'individuel';
    var seg = '<div class="toolbar"><div class="btn-row"><div class="seg" role="radiogroup" aria-label="Périodicité"><button type="button" role="radio" aria-checked="' + (b === 'monthly') + '" tabindex="' + (b === 'monthly' ? 0 : -1) + '" data-billing="monthly">Mensuel</button><button type="button" role="radio" aria-checked="' + (b === 'annual') + '" tabindex="' + (b === 'annual' ? 0 : -1) + '" data-billing="annual">Annuel</button></div><span class="badge">jusqu’à −46' + NNBSP + '%</span></div>' + (state.config.billing === 'simulated' ? '<span class="mono">Paiement simulé' + SEP + 'aucune clé Stripe</span>' : '') + '</div>';
    var cards = Object.keys(plans).map(function (k) {
      var p = plans[k], cur = subscribed && u.plan === k;
      var perMonth = b === 'annual' ? Math.round(p.annual / 12) : p.monthly;
      return '<div class="sheet plan' + (k === featured ? ' plan--featured' : '') + (cur ? ' is-current' : '') + '"><div class="plan__head"><h3>' + esc(p.name) + '</h3><span class="mono">' + (p.members > 1 ? 'Jusqu’à ' + p.members + NBSP + 'personnes' : 'Une personne') + '</span></div>' +
        '<div class="plan__price"><b>' + money(perMonth) + '</b><small>/mois</small></div><p class="plan__note">' + (b === 'annual' ? 'soit ' + money(p.annual) + ' facturés une fois par an' : 'sans engagement, ' + money(p.monthly) + ' par mois') + '</p>' +
        '<ul><li>Demandes auprès de ' + (state.config.brokers || '') + NBSP + 'courtiers et annuaires</li><li>Relances automatiques à l’échéance légale</li><li>Nouvelle vérification tous les 60' + NBSP + 'à' + NBSP + '90' + NBSP + 'jours</li><li>Journal horodaté, preuves exportables</li>' + (p.members > 1 ? '<li>Un dossier par personne, une seule facture</li>' : '') + '</ul>' +
        (cur ? '<p class="notice notice--ok">Votre offre actuelle, ' + (u.billing === 'annual' ? 'annuelle' : 'mensuelle') + '.</p>' : '<button class="btn btn--block' + (subscribed || k !== featured ? ' btn--outline' : '') + '" type="button" data-checkout="' + k + '">' + (subscribed ? 'Passer à ' + esc(p.name) : 'Choisir ' + esc(p.name)) + '</button>') + '</div>';
    }).join('');
    return '<div class="plans-block">' + seg + '<div class="plans">' + cards + '</div><p class="mono" style="margin-top:18px">Prix TTC' + SEP + 'Satisfait ou remboursé 30' + NBSP + 'jours' + SEP + 'Résiliation en un clic</p></div>';
  }

  /* ---------- tableau de bord ---------- */
  function currentProfile(d) { return d.profiles.filter(function (p) { return p.id === d.profile_id; })[0] || d.profiles[0] || {}; }

  function dashHead(d) {
    var c = d.counters, prof = currentProfile(d), o = d.onboarding;
    var tabs = '';
    if (d.profiles.length > 1 || (o.max_profiles > 1 && d.profiles.length < o.max_profiles)) {
      tabs = '<div class="ptabs" role="group" aria-label="Dossier affiché">' + d.profiles.map(function (p) {
        return '<button type="button" class="ptab" aria-pressed="' + (p.id === d.profile_id) + '" data-profile="' + esc(p.id) + '"><span class="avatar avatar--sm" aria-hidden="true">' + esc(initials(p)) + '</span><span>' + esc(fullName(p)) + '</span></button>';
      }).join('') + (d.profiles.length < o.max_profiles ? '<a class="ptab ptab--add" href="#dossier"><span aria-hidden="true">+</span> Ajouter un proche</a>' : '') + '</div>';
    }
    var eyebrow = 'Dossier ' + fileNo(d.profile_id) + SEP + (d.last_activity_at ? 'Dernière activité le ' + fmtWhen(d.last_activity_at) : 'Ouvert le ' + fmtDate(prof.created_at));
    var lead;
    if (!c.total) lead = 'Les premières demandes partiront dès que le dossier sera complet.';
    else if (c.active && c.done === c.active) lead = 'Les ' + c.active + NBSP + 'courtiers surveillés ont confirmé l’effacement.' + (d.next_check_at ? ' Prochaine vérification le ' + fmtDate(d.next_check_at) + '.' : '');
    else lead = c.brokers + NBSP + 'courtiers surveillés, ' + plural(c.done, 'effacement confirmé', 'effacements confirmés') + '.' + (c.in_progress ? ' ' + plural(c.in_progress, 'réponse attendue', 'réponses attendues') + (d.next_due_at ? ' avant le ' + fmtDate(d.next_due_at) : '') + '.' : '') + (d.next_check_at ? ' Prochaine vérification le ' + fmtDate(d.next_check_at) + '.' : '');
    return tabs + '<div class="dash-head__main"><div><span class="mono">' + eyebrow + '</span><h1>' + esc(fullName(prof)) + '</h1><p class="lead">' + lead + '</p></div></div>';
  }
  function sigHead(d) { var c = d.counters; return JSON.stringify([d.profile_id, d.profiles.map(function (p) { return p.id + fullName(p); }), c.total, c.done, c.in_progress, c.active, d.next_due_at, d.next_check_at, d.last_activity_at, d.onboarding]); }

  function nextStep(d) {
    var u = d.user, c = d.counters, o = d.onboarding, prof = currentProfile(d);
    function card(kind, title, text, action) { return '<section class="next next--' + kind + '" aria-labelledby="next-h"><div class="next__body"><span class="mono">' + (kind === 'ok' ? 'Tout est en ordre' : kind === 'warn' ? 'Action requise' : 'Prochaine étape') + '</span><h2 id="next-h">' + title + '</h2><p>' + text + '</p></div>' + (action ? '<div class="next__act">' + action + '</div>' : '') + '</section>'; }
    if (!o.profile_complete) return card('todo', 'Complétez les informations de ' + esc(fullName(prof)), 'Un prénom et un nom suffisent pour commencer' + NBSP + '; chaque e-mail, numéro ou adresse ajouté aide à retrouver les fiches.', '<a class="btn" href="#dossier">Compléter le dossier</a>');
    if (!o.mandate) return card('todo', u.mandate_revoked_at ? 'Le mandat a été révoqué' : 'Signez le mandat', 'Sans mandat, nous ne pouvons pas écrire aux courtiers en votre nom. Il se signe en trente secondes et reste révocable.', '<a class="btn" href="#dossier">Signer le mandat</a>');
    if (!o.subscription) return card('todo', u.subscription_status === 'past_due' ? 'Mettez à jour votre moyen de paiement' : u.subscription_status === 'canceled' ? 'Votre abonnement est résilié' : 'Activez votre abonnement', u.subscription_status === 'past_due' ? 'Le dernier paiement a échoué. Les demandes reprennent dès que le paiement est régularisé.' : u.subscription_status === 'canceled' ? (u.subscription_ends_at ? 'Les demandes en cours continuent jusqu’au ' + fmtDate(u.subscription_ends_at) + ', puis plus aucune relance ne partira.' : 'Plus aucune demande ne part. Réactivez l’offre pour reprendre la surveillance.') : 'Les demandes partent dès que l’abonnement est actif.', '<a class="btn" href="#billing">Voir l’abonnement</a>');
    if (!c.total) return card('todo', 'Tout est prêt, les demandes partent', 'Les ' + c.brokers + NBSP + 'courriers de la première vague sont envoyés automatiquement dans la minute. Vous pouvez aussi lancer l’envoi tout de suite.', '<button class="btn" type="button" id="launch">Lancer les demandes</button>');
    if (c.action_required) return card('warn', plural(c.action_required, 'courtier attend une vérification', 'courtiers attendent une vérification') + ' de votre part', 'Ils demandent un lien de confirmation ou une pièce d’identité partielle, que nous vous avons transmis par e-mail. Suivez l’e-mail, puis cliquez sur «' + NBSP + 'Vérification faite' + NBSP + '» sur la ligne du courtier.', '<button class="btn" type="button" data-filter="action_required">Voir les demandes</button>');
    if (c.refused) return card('warn', plural(c.refused, 'courtier refuse', 'courtiers refusent') + ' l’effacement', 'Nous préparons une réclamation auprès de l’autorité de contrôle (CNIL) et une nouvelle demande partira au prochain cycle' + (d.next_check_at ? ', le ' + fmtDate(d.next_check_at) : '') + '.', '<button class="btn btn--outline" type="button" data-filter="refused">Voir les refus</button>');
    if (c.active && c.done === c.active) return card('ok', 'Tous les courtiers ont confirmé l’effacement', 'Nous revérifions chaque courtier tous les 60' + NBSP + 'à' + NBSP + '90' + NBSP + 'jours et renvoyons une demande si vos données réapparaissent.' + (d.next_check_at ? ' Prochaine vérification le ' + fmtDate(d.next_check_at) + '.' : ''), '');
    return '';
  }
  function sigNext(d) { var c = d.counters, u = d.user; return JSON.stringify([d.onboarding, c.total, c.action_required, c.refused, c.done, c.active, u.subscription_status, u.subscription_ends_at, u.mandate_revoked_at, d.next_check_at]); }

  function ledger(d) {
    var c = d.counters, circ = 2 * Math.PI * 42;
    var ring = '<svg class="ring" viewBox="0 0 96 96" role="img" aria-label="Exposition ' + d.exposure + NNBSP + '%"><circle class="track" cx="48" cy="48" r="42"/><circle class="fill" cx="48" cy="48" r="42" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (circ * (1 - d.exposure / 100)).toFixed(1) + '"/><text x="48" y="48">' + d.exposure + NNBSP + '%</text></svg>';
    return '<div class="ledger__stat"><span class="mono">Envoyées</span><span class="ledger__n num">' + c.sent + '</span><span class="ledger__sub">sur ' + c.brokers + NBSP + 'courtiers</span></div>' +
      '<div class="ledger__stat"><span class="mono">En cours</span><span class="ledger__n num">' + c.in_progress + '</span><span class="ledger__sub">' + (c.in_progress ? 'réponse attendue' : c.queued ? plural(c.queued, 'envoi à venir', 'envois à venir') : 'aucune en attente') + '</span></div>' +
      '<div class="ledger__stat' + (c.action_required ? ' ledger__stat--warn' : '') + '"><span class="mono">Action requise</span><span class="ledger__n num">' + c.action_required + '</span><span class="ledger__sub">' + (c.action_required ? 'vérification à faire' : 'rien à faire') + '</span></div>' +
      '<div class="ledger__stat ledger__stat--ok"><span class="mono">Terminées</span><span class="ledger__n num">' + c.done + '</span><span class="ledger__sub">' + (c.refused ? plural(c.refused, 'refus', 'refus') + ' à contester' : 'effacements confirmés') + '</span></div>' +
      '<div class="ledger__ring">' + ring + '<div class="ring__txt"><strong>Exposition estimée</strong><span>Part des courtiers qui n’ont pas encore confirmé l’effacement.</span></div></div>';
  }
  function sigLedger(d) { return JSON.stringify([d.counters, d.exposure]); }

  function barHtml(b, label) {
    var t = b.total || 0;
    function seg(k, n) { return n ? '<i class="bar__seg bar__seg--' + k + '" style="flex-basis:' + (n / t * 100).toFixed(2) + '%"></i>' : ''; }
    var parts = [];
    if (b.done) parts.push(plural(b.done, 'effacée', 'effacées'));
    if (b.in_progress) parts.push(b.in_progress + NBSP + 'en cours');
    if (b.action_required) parts.push(b.action_required + NBSP + 'en attente de vérification');
    if (b.refused) parts.push(plural(b.refused, 'refus', 'refus'));
    if (b.queued) parts.push(b.queued + NBSP + 'à envoyer');
    return '<div class="bar" role="img" aria-label="' + esc(label) + NBSP + ': ' + (parts.length ? esc(parts.join(', ')) : 'aucune demande') + ' sur ' + t + '">' + seg('done', b.done) + seg('in_progress', b.in_progress) + seg('action_required', b.action_required) + seg('refused', b.refused) + '</div>';
  }
  function insight(d) {
    var hist = d.exposure_history || [], cats = d.categories || [], sens = d.sensitivity || [];
    var first = hist.length ? hist[0].exposure : 100, delta = d.exposure - first;
    var chart = '<section class="sheet insight__chart" aria-labelledby="exp-h"><div class="sheet__head"><div><h2 id="exp-h">Exposition</h2><span class="mono">12 dernières semaines</span></div><p class="insight__now"><b class="num">' + d.exposure + NNBSP + '%</b><span>' + (d.counters.total ? (delta < 0 ? '−' + Math.abs(delta) + NNBSP + 'pts depuis douze semaines' : 'inchangée depuis douze semaines') : 'avant la première vague') + '</span></p></div>' +
      '<div class="chart" id="exp-chart"></div>' +
      (hist.length ? '<table class="vh"><caption>Exposition par semaine</caption><thead><tr><th scope="col">Semaine du</th><th scope="col">Exposition</th></tr></thead><tbody>' + hist.map(function (p) { return '<tr><td>' + fmtDate(p.week_start) + '</td><td>' + p.exposure + NNBSP + '%</td></tr>'; }).join('') + '</tbody></table>' : '') + '</section>';
    var legend = '<ul class="legend" role="list"><li><i class="legend__k legend__k--done"></i>Effacées</li><li><i class="legend__k legend__k--in_progress"></i>En cours</li><li><i class="legend__k legend__k--action_required"></i>Vérification</li>' + (d.counters.refused ? '<li><i class="legend__k legend__k--refused"></i>Refus</li>' : '') + '</ul>';
    var catList = cats.length ? '<ul class="cats" role="list">' + cats.map(function (b) { return '<li class="cat"><div class="cat__head"><span class="cat__name">' + esc(b.category) + '</span><span class="cat__n num"><b>' + b.done + '</b>' + NBSP + '/' + NBSP + b.total + '</span></div>' + barHtml(b, b.category) + '</li>'; }).join('') + '</ul>' : '<p class="empty empty--sm">La répartition apparaîtra après la première vague.</p>';
    var sensList = sens.length && d.counters.total ? '<ul class="sens" role="list">' + sens.map(function (b) { return b.total ? '<li class="cat"><div class="cat__head"><span class="cat__name">' + dots(b.level) + SENS[b.level] + '</span><span class="cat__n num"><b>' + b.done + '</b>' + NBSP + '/' + NBSP + b.total + '</span></div>' + barHtml(b, SENS[b.level]) + '</li>' : ''; }).join('') + '</ul>' : '';
    var right = '<section class="sheet insight__cats" aria-labelledby="cat-h"><div class="sheet__head"><div><h2 id="cat-h">Par catégorie</h2><span class="mono">effacées / surveillées</span></div>' + legend + '</div><div class="sheet__body sheet__body--tight">' + catList + (sensList ? '<h3 class="mono insight__sub">Par sensibilité</h3>' + sensList : '') + '</div></section>';
    return chart + right;
  }
  function sigInsight(d) { return JSON.stringify([d.exposure_history, d.categories, d.sensitivity, d.exposure, d.counters.total, d.counters.refused]); }

  function drawChart() {
    var host = $('#exp-chart'), d = state.dash; if (!host || !d) return;
    var pts = d.exposure_history || [];
    if (pts.length < 2) { host.innerHTML = '<p class="empty empty--sm">Historique disponible après la première vague.</p>'; return; }
    var W = Math.max(260, Math.floor(host.clientWidth || 600)), H = 210, L = 44, R = 60, T = 18, B = 30, n = pts.length;
    var x = function (i) { return L + (W - L - R) * i / (n - 1); }, y = function (v) { return T + (H - T - B) * (1 - v / 100); };
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.exposure).toFixed(1); }).join(' ');
    var area = path + ' L' + x(n - 1).toFixed(1) + ' ' + y(0).toFixed(1) + ' L' + x(0).toFixed(1) + ' ' + y(0).toFixed(1) + ' Z';
    var grid = [0, 50, 100].map(function (v) { return '<line class="chart__grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text class="chart__lbl" x="' + (L - 10) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + v + (v ? NNBSP + '%' : '') + '</text>'; }).join('');
    var xl = [0, Math.round((n - 1) / 3), Math.round(2 * (n - 1) / 3), n - 1].map(function (i) { return '<text class="chart__lbl" x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + fmtDay(pts[i].week_start) + '</text>'; }).join('');
    var last = pts[n - 1], ex = x(n - 1), ey = y(last.exposure);
    var end = '<circle class="chart__end" cx="' + ex.toFixed(1) + '" cy="' + ey.toFixed(1) + '" r="4.5"/><text class="chart__val" x="' + (ex + 12).toFixed(1) + '" y="' + (ey + 4).toFixed(1) + '">' + last.exposure + NNBSP + '%</text>';
    var summary = 'Exposition sur 12 semaines' + NBSP + ': de ' + pts[0].exposure + NNBSP + '% (semaine du ' + fmtDay(pts[0].week_start) + ') à ' + last.exposure + NNBSP + '% aujourd’hui.';
    host.innerHTML = '<svg class="chart__svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" tabindex="0" aria-label="' + esc(summary) + ' Flèches gauche et droite pour parcourir les semaines."><path class="chart__area" d="' + area + '"/>' + grid + '<path class="chart__line" d="' + path + '"/><line class="chart__cross" y1="' + T + '" y2="' + y(0).toFixed(1) + '" hidden/><circle class="chart__hover" r="4.5" hidden/>' + end + xl + '</svg><div class="chart__tip" role="status" aria-live="polite" hidden></div>';
    host._pts = pts.map(function (p, i) { return { x: x(i), y: y(p.exposure), v: p.exposure, w: p.week_start }; });
    host._size = { W: W, H: H, L: L, R: R };
    wireChart(host);
  }
  function wireChart(host) {
    var svg = $('svg', host), tip = $('.chart__tip', host), cross = $('.chart__cross', svg), dot = $('.chart__hover', svg), idx = -1;
    function show(i) {
      var p = host._pts[i]; if (!p) return; idx = i;
      cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.hidden = false;
      dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); dot.hidden = false;
      tip.textContent = ''; var b = document.createElement('b'); b.textContent = p.v + NNBSP + '%'; tip.appendChild(b); tip.appendChild(document.createTextNode(' semaine du ' + fmtDay(p.w)));
      tip.hidden = false; var left = p.x / host._size.W * 100; tip.style.left = left + '%'; tip.classList.toggle('is-right', left > 70);
    }
    function hide() { idx = -1; cross.hidden = true; dot.hidden = true; tip.hidden = true; }
    svg.addEventListener('pointermove', function (e) { var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * host._size.W, best = 0, bd = Infinity; host._pts.forEach(function (p, i) { var dd = Math.abs(p.x - px); if (dd < bd) { bd = dd; best = i; } }); show(best); });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', function (e) {
      var n = host._pts.length;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); show(idx < 0 ? n - 1 : Math.min(n - 1, idx + 1)); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); show(idx < 0 ? n - 1 : Math.max(0, idx - 1)); }
      else if (e.key === 'Home') { e.preventDefault(); show(0); } else if (e.key === 'End') { e.preventDefault(); show(n - 1); }
      else if (e.key === 'Escape') { hide(); }
    });
  }

  function filterDefs(d) {
    var c = d.counters;
    var f = [['all', 'Tous', c.active], ['action_required', 'Action requise', c.action_required], ['in_progress', 'En cours', c.in_progress + c.queued], ['done', 'Terminées', c.done]];
    if (c.refused) f.push(['refused', 'Refusées', c.refused]);
    return f;
  }
  function filtersHtml(d) { return filterDefs(d).map(function (f) { return '<button type="button" aria-pressed="' + (state.filter === f[0]) + '" data-filter="' + f[0] + '">' + f[1] + '<b>' + f[2] + '</b></button>'; }).join(''); }
  function toolsHtml(d) {
    return '<div class="tools__search"><label class="vh" for="broker-search">Rechercher un courtier ou une catégorie</label><input type="search" id="broker-search" placeholder="Rechercher un courtier, une catégorie…" value="' + esc(state.search) + '" autocomplete="off"></div>' +
      '<div class="tools__sort"><label for="broker-sort" class="mono">Trier</label><select id="broker-sort">' + [['status', 'par statut'], ['sensitivity', 'par sensibilité'], ['name', 'par nom'], ['date', 'par date']].map(function (o) { return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="filters" id="dash-filters" role="group" aria-label="Filtrer par statut">' + filtersHtml(d) + '</div>';
  }
  function matchesFilter(r) { return state.filter === 'all' || (state.filter === 'in_progress' ? (r.status === 'sent' || r.status === 'in_progress' || r.status === 'queued') : r.status === state.filter); }
  function visibleRequests(d) {
    var s = state.search.trim().toLowerCase();
    var list = d.requests.filter(matchesFilter).filter(function (r) { return !s || (r.broker + ' ' + r.category + ' ' + (r.domain || '')).toLowerCase().indexOf(s) >= 0; });
    var dateOf = function (r) { return r.completed_at || r.sent_at || r.created_at || ''; };
    if (state.sort === 'sensitivity') list.sort(function (a, b) { return b.sensitivity - a.sensitivity || a.broker.localeCompare(b.broker, 'fr'); });
    else if (state.sort === 'name') list.sort(function (a, b) { return a.broker.localeCompare(b.broker, 'fr'); });
    else if (state.sort === 'date') list.sort(function (a, b) { return dateOf(b).localeCompare(dateOf(a)) || a.broker.localeCompare(b.broker, 'fr'); });
    return list;
  }
  function emptyRows(d) {
    var c = d.counters;
    if (!d.requests.length) {
      return '<div class="empty empty--state"><span class="mono">Aucune demande pour l’instant</span><p>' + (onboardingDone() ? 'Les ' + c.brokers + NBSP + 'premiers courriers partent automatiquement dans la minute.' : 'Les demandes partent d’elles-mêmes une fois le dossier complet' + NBSP + ': informations, mandat signé et abonnement actif.') + '</p>' + (onboardingDone() ? '' : '<a class="btn btn--outline btn--sm" href="#onboarding">Terminer les étapes</a>') + '</div>';
    }
    if (state.search.trim()) return '<div class="empty empty--state"><p>Aucun courtier ne correspond à «' + NBSP + esc(state.search.trim()) + NBSP + '».</p><button type="button" class="btn btn--outline btn--sm" id="search-clear">Effacer la recherche</button></div>';
    if (state.filter === 'action_required') return '<div class="empty empty--state"><span class="mono">Rien à faire</span><p>Aucun courtier n’attend de vérification de votre part.</p></div>';
    if (state.filter === 'done') return '<div class="empty empty--state"><span class="mono">Pas encore de confirmation</span><p>Les courtiers ont un mois (RGPD) ou 45' + NBSP + 'jours (CCPA) pour répondre' + NBSP + '; nous relançons à l’échéance.</p></div>';
    if (state.filter === 'in_progress') return '<div class="empty empty--state"><span class="mono">Aucune demande en cours</span><p>' + (c.active && c.done === c.active ? 'Tous les courtiers ont confirmé l’effacement.' : 'Rien en attente de réponse.') + '</p></div>';
    return '<div class="empty empty--state"><p>Aucune demande dans cette catégorie.</p></div>';
  }
  function rowHtml(r, d) {
    var basis = (r.legal_basis === 'ccpa' ? 'CCPA' : 'RGPD art. 17') + (r.cycle > 1 ? SEP + 'cycle ' + r.cycle : '');
    var when = r.status === 'done' ? '<span>Effacée le ' + fmtDay(r.completed_at) + '</span><small>' + (r.next_check_at ? 'revérif. le ' + fmtDate(r.next_check_at) : basis) + '</small>'
      : r.status === 'refused' ? '<span>Refusée</span><small>' + (r.sent_at ? 'demande du ' + fmtDay(r.sent_at) : basis) + '</small>'
      : r.sent_at ? '<span>Envoyée le ' + fmtDay(r.sent_at) + '</span><small>' + (r.due_at ? 'réponse due le ' + fmtDay(r.due_at) : basis) + '</small>'
      : '<span>Prochain envoi</span><small>' + basis + '</small>';
    var act = r.sent_at ? '<button class="btn btn--outline btn--xs" type="button" data-mails="' + esc(r.id) + '" aria-expanded="false" aria-controls="mail-' + esc(r.id) + '">Courrier</button>' : '';
    var note = '';
    if (r.status === 'action_required') {
      var what = r.note && r.note !== 'Le courtier demande une vérification.' ? esc(typo(r.note)) + ' ' : '';
      note = '<div class="row__note row__note--warn"><p><strong>Le courtier demande une vérification avant de supprimer vos données.</strong> ' + what + 'Nous vous avons transmis sa demande par e-mail (objet «' + NBSP + 'Action requise' + NBSP + '») ' + NBSP + ': suivez le lien de confirmation ou renvoyez la pièce demandée, puis confirmez ici pour que la demande reprenne son cours.</p><button class="btn btn--xs" type="button" data-resolve="' + esc(r.id) + '">Vérification faite</button></div>';
    } else if (r.status === 'refused') {
      note = '<div class="row__note row__note--danger"><p><strong>Le courtier refuse l’effacement.</strong> ' + (r.note ? esc(typo(r.note)) + ' ' : '') + 'Prochaine étape' + NBSP + ': nous préparons une réclamation auprès de l’autorité de contrôle (CNIL) et une nouvelle demande partira ' + (r.next_check_at ? 'le ' + fmtDate(r.next_check_at) : d.next_check_at ? 'au prochain cycle, le ' + fmtDate(d.next_check_at) : 'au prochain cycle de vérification') + '.</p></div>';
    } else if (r.note && r.status !== 'done') {
      note = '<p class="row__note">' + esc(typo(r.note)) + '</p>';
    }
    return '<li class="row row--' + esc(r.status) + '" data-row="' + esc(r.id) + '">' + dots(r.sensitivity) + '<div class="row__who"><strong>' + esc(r.broker) + '</strong><small>' + esc(r.category) + '</small></div><div class="row__status">' + chip(r.status) + '</div><div class="row__when">' + when + '</div><div class="row__act">' + act + '</div>' + note + '</li>';
  }
  function rowsHtml(d) {
    var all = visibleRequests(d), list = all.slice(0, state.page * PAGE);
    if (!all.length) return emptyRows(d);
    return '<div class="row row--head" aria-hidden="true"><span>Sens.</span><span>Courtier</span><span>Statut</span><span>Suivi</span><span></span></div><ol class="rows__list" role="list">' + list.map(function (r) { return rowHtml(r, d); }).join('') + '</ol>' +
      (all.length > list.length ? '<div class="rows__more"><button type="button" class="btn btn--outline btn--sm" id="rows-more">Afficher plus</button><span class="mono mono--plain">' + list.length + ' sur ' + all.length + '</span></div>' : (all.length > PAGE ? '<div class="rows__more"><span class="mono mono--plain">' + all.length + ' sur ' + all.length + '</span></div>' : ''));
  }
  function sigRows(d) { return d.requests.map(function (r) { return [r.id, r.status, r.note, r.sent_at, r.due_at, r.completed_at, r.next_check_at, r.cycle].join('|'); }).join(';') + '#' + [state.filter, state.search, state.sort, state.page, d.next_check_at].join('|'); }

  function journalHtml(d) {
    var evs = d.events || [], list = state.journalAll ? evs : evs.slice(0, JOURNAL);
    if (!evs.length) return '<p class="empty">Rien pour l’instant.</p>';
    return '<ol class="timeline" id="timeline">' + list.map(function (e) { return '<li class="t-' + esc(e.type) + '"><time datetime="' + esc(e.created_at) + '">' + fmtTime(e.created_at) + '</time><span>' + esc(typo(e.message)) + '</span></li>'; }).join('') + '</ol>' +
      (evs.length > JOURNAL ? '<div class="sheet__more"><button type="button" class="btn btn--text" id="journal-toggle" aria-expanded="' + state.journalAll + '" aria-controls="timeline">' + (state.journalAll ? 'Réduire' : 'Tout afficher (' + evs.length + ')') + '</button></div>' : '');
  }
  function sigJournal(d) { return (d.events || []).map(function (e) { return e.id; }).join(',') + '#' + state.journalAll; }
  function deadlinesHtml(d) {
    var c = d.counters, rows = '';
    if (d.next_due_at) rows += '<div class="deadline"><b>' + fmtDate(d.next_due_at) + '</b><span>prochaine réponse due</span></div>';
    if (d.next_check_at) rows += '<div class="deadline"><b>' + fmtDate(d.next_check_at) + '</b><span>prochaine vérification</span></div>';
    if (c.queued) rows += '<div class="deadline"><b>' + c.queued + '</b><span>' + (c.queued > 1 ? 'demandes à envoyer' : 'demande à envoyer') + '</span></div>';
    return rows ? '<div class="deadlines">' + rows + '</div>' : '<p class="empty empty--sm">Aucune échéance.</p>';
  }
  function sigDeadlines(d) { return JSON.stringify([d.next_due_at, d.next_check_at, d.counters.queued]); }

  function skeleton() {
    return '<div class="dash dash--loading" aria-busy="true"><h1 class="vh">Tableau de bord</h1><p class="vh">Chargement du tableau de bord…</p><div class="skel skel--eyebrow"></div><div class="skel skel--h1"></div><div class="skel skel--lead"></div><div class="sheet skel-sheet"><div class="skel skel--n"></div><div class="skel skel--n"></div><div class="skel skel--n"></div><div class="skel skel--n"></div></div><div class="dash-grid"><div class="sheet skel-sheet skel-sheet--tall"><div class="skel skel--row"></div><div class="skel skel--row"></div><div class="skel skel--row"></div><div class="skel skel--row"></div></div><div class="sheet skel-sheet"><div class="skel skel--row"></div><div class="skel skel--row"></div></div></div></div>';
  }
  function dashShell(d) {
    sigs = { 'dash-head': sigHead(d), 'dash-next': sigNext(d), 'dash-ledger': sigLedger(d), 'dash-insight': sigInsight(d), 'dash-filters': JSON.stringify(filterDefs(d)), rows: sigRows(d), 'dash-journal': sigJournal(d), 'dash-deadlines': sigDeadlines(d) };
    return '<div class="dash" id="dash" data-profile="' + esc(d.profile_id) + '">' +
      '<header class="dash-head" id="dash-head">' + dashHead(d) + '</header>' +
      '<div id="dash-next">' + nextStep(d) + '</div>' +
      '<section class="sheet ledger" id="dash-ledger" aria-label="Synthèse">' + ledger(d) + '</section>' +
      '<div class="insight" id="dash-insight">' + insight(d) + '</div>' +
      '<div class="dash-grid"><section class="sheet" aria-labelledby="brokers-h"><div class="sheet__head"><h2 id="brokers-h">Courtiers</h2><span class="mono">' + d.counters.brokers + NBSP + 'surveillés</span></div><div class="tools" id="dash-tools">' + toolsHtml(d) + '</div><div class="rows" id="rows">' + rowsHtml(d) + '</div></section>' +
      '<aside class="stack"><section class="sheet" aria-labelledby="journal-h"><div class="sheet__head"><h2 id="journal-h">Journal</h2><a class="btn btn--outline btn--xs" href="/api/export" target="_blank" rel="noopener">Exporter<span class="vh"> le dossier (JSON, nouvel onglet)</span></a></div><div id="dash-journal">' + journalHtml(d) + '</div></section>' +
      '<section class="sheet" aria-labelledby="deadlines-h"><div class="sheet__head"><h2 id="deadlines-h">Échéances</h2></div><div id="dash-deadlines">' + deadlinesHtml(d) + '</div></section></aside></div></div>';
  }
  views.dashboard = function () { return state.dash ? dashShell(state.dash) : skeleton(); };

  /* Mise à jour en place : chaque zone n'est remplacée que si son contenu a changé et si le focus n'y est pas. */
  function patch(id, html, sig) {
    var el = document.getElementById(id); if (!el) return false;
    if (sigs[id] === sig) return false;
    var ae = document.activeElement;
    if (ae && ae !== document.body && el.contains(ae)) return false;
    if (id === 'rows' && $('.mail', el)) return false;
    sigs[id] = sig; el.innerHTML = html; return true;
  }
  function paintDash(focusSel) {
    var d = state.dash; if (!d || params().route !== 'dashboard') return;
    var root = $('#dash');
    if (!root || root.getAttribute('data-profile') !== d.profile_id) {
      var y = window.scrollY; view.innerHTML = dashShell(d); drawChart(); if (root) window.scrollTo(0, y);
      if (focusSel) { var f = $(focusSel); if (f) f.focus({ preventScroll: true }); }
      return;
    }
    var before = sigs['dash-ledger'];
    patch('dash-head', dashHead(d), sigHead(d));
    patch('dash-next', nextStep(d), sigNext(d));
    patch('dash-ledger', ledger(d), sigLedger(d));
    if (patch('dash-insight', insight(d), sigInsight(d))) drawChart();
    patch('dash-filters', filtersHtml(d), JSON.stringify(filterDefs(d)));
    $$('#dash-filters [data-filter]').forEach(function (b) { var def = filterDefs(d).filter(function (f) { return f[0] === b.getAttribute('data-filter'); })[0], n = $('b', b); if (def && n && n.textContent !== String(def[2])) n.textContent = def[2]; });
    patch('rows', rowsHtml(d), sigRows(d));
    patch('dash-journal', journalHtml(d), sigJournal(d));
    patch('dash-deadlines', deadlinesHtml(d), sigDeadlines(d));
    if (before && before !== sigs['dash-ledger']) {
      var c = d.counters, parts = [];
      if (c.done) parts.push(plural(c.done, 'effacement confirmé', 'effacements confirmés'));
      if (c.action_required) parts.push(plural(c.action_required, 'vérification à faire', 'vérifications à faire'));
      announce('Tableau de bord mis à jour' + NBSP + ': ' + (parts.length ? parts.join(', ') : c.in_progress + NBSP + 'en cours') + '.');
    }
  }
  function renderRows() {
    var d = state.dash, host = $('#rows'); if (!d || !host) return;
    sigs.rows = sigRows(d); host.innerHTML = rowsHtml(d);
    $$('#dash-filters [data-filter]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-filter') === state.filter); });
  }

  views.dossier = function () {
    var u = state.user, max = (state.config.plans[u.plan] || { members: 1 }).members;
    var members = '<section class="sheet" aria-labelledby="members-h"><div class="sheet__head"><h2 id="members-h">Personnes protégées</h2><span class="mono">' + state.profiles.length + NBSP + '/' + NBSP + max + '</span></div><div class="members">' + state.profiles.map(function (p) { var n = p.emails.length + p.phones.length + p.addresses.length; return '<div class="member"><span class="avatar" aria-hidden="true">' + esc(initials(p)) + '</span><div><strong>' + esc(fullName(p)) + '</strong><small>' + (p.is_primary ? 'Profil principal' : 'Proche') + SEP + plural(n, 'élément à effacer', 'éléments à effacer') + '</small></div><a class="btn btn--ghost" href="#profile-' + esc(p.id) + '">Modifier<span class="vh"> ' + esc(fullName(p)) + '</span></a></div>'; }).join('') +
      (state.profiles.length < max ? '<form class="member member--add" id="add-member" novalidate><span class="avatar" aria-hidden="true">+</span><div class="fields fields--2" style="gap:16px 24px">' + field('first_name', 'Prénom', '', { extra: 'required autocomplete="off"' }, '', 'new') + field('last_name', 'Nom', '', { extra: 'required autocomplete="off"' }, '', 'new') + '</div><button class="btn btn--outline btn--sm" type="submit">Ajouter un proche</button>' + msgEl('msg-add-member', 'grid-column:1/-1') + '</form>' : (max === 1 ? '<p class="empty empty--left">L’offre Individuel couvre une personne. <a href="#billing">Passer à Famille</a> pour protéger jusqu’à 5' + NBSP + 'proches.</p>' : '')) + '</div></section>';
    var forms = state.profiles.map(function (p) { return '<div id="profile-' + esc(p.id) + '" style="scroll-margin-top:90px">' + profileForm(p, false) + '</div>'; }).join('');
    var version = u.mandate_version || (state.config && state.config.mandate_version);
    var m = u.mandate_signed_at && !u.mandate_revoked_at ? '<section class="sheet" id="mandate-card" aria-labelledby="mandate-h"><div class="sheet__head"><h2 id="mandate-h">Mandat</h2><span class="stamp">Signé le ' + fmtDate(u.mandate_signed_at) + '</span></div><div class="sheet__body"><div class="mandate-text" id="mandate-text"><span class="spinner"></span></div></div><div class="sheet__foot"><div class="btn-row"><a class="btn btn--outline btn--sm" href="/api/mandate" download="mandat-oubli.json">Télécharger</a><button class="btn btn--danger btn--sm" type="button" id="revoke">Révoquer le mandat</button></div>' + (version ? '<span class="mono">Version ' + esc(version) + '</span>' : '') + '</div></section>' : mandateCard(state.profiles[0] || {});
    return '<div class="page-head"><div><span class="mono">Dossier ' + fileNo((state.profiles[0] || {}).id) + '</span><h1>Votre dossier</h1><p class="lead">Les informations qui permettent de retrouver vos fiches, et le mandat qui nous autorise à les faire effacer.</p></div></div><div class="stack">' + members + forms + m + '</div>';
  };

  views.billing = function () {
    var u = state.user;
    var status = '<section class="sheet" aria-labelledby="sub-h"><div class="sheet__head"><h2 id="sub-h">Votre abonnement</h2>' + chip(u.subscription_status, subLabel(u.subscription_status)) + '</div><div class="sheet__body"><dl class="kv"><dt>Offre</dt><dd>' + (u.plan && state.config.plans[u.plan] ? esc(state.config.plans[u.plan].name) + SEP + (u.billing === 'annual' ? 'annuel' : 'mensuel') : '—') + '</dd><dt>Paiement</dt><dd>' + (u.billing_mode === 'stripe' ? 'Carte via Stripe' : u.billing_mode === 'simulated' ? 'Simulé (environnement de test)' : '—') + '</dd>' + (u.subscription_ends_at ? '<dt>Fin d’accès</dt><dd>' + fmtDate(u.subscription_ends_at) + '</dd>' : '') + '</dl></div>' + (u.subscription_status === 'active' ? '<div class="sheet__foot"><button class="btn btn--danger btn--sm" type="button" id="cancel-sub">Résilier l’abonnement</button><span class="mono">Satisfait ou remboursé 30' + NBSP + 'jours</span></div>' : '') + '</section>';
    return '<div class="page-head"><div><span class="mono">Abonnement</span><h1>Un prix clair. Une <em>seule</em> mission.</h1></div></div><div class="stack">' + status + plansBlock() + '</div>';
  };

  views.settings = function () {
    return '<div class="page-head"><div><span class="mono">Paramètres</span><h1>Votre compte, vos données, vos droits.</h1></div></div><div class="stack">' +
      '<form class="sheet" id="pwd-form" novalidate><div class="sheet__head"><h2>Mot de passe</h2></div><div class="sheet__body"><div class="fields">' + field('current', 'Mot de passe actuel', '', { extra: 'type="password" autocomplete="current-password" required' }) + field('next', 'Nouveau mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10' + NBSP + 'caractères. Les autres sessions seront déconnectées.') + '</div>' + msgEl('msg-pwd-form', 'margin-top:16px') + '</div><div class="sheet__foot"><button class="btn btn--outline" type="submit">Changer le mot de passe</button></div></form>' +
      '<section class="sheet" aria-labelledby="data-h"><div class="sheet__head"><h2 id="data-h">Vos données chez Oubli</h2></div><div class="sheet__body"><p class="lead">Nous appliquons à nous-mêmes ce que nous demandons aux courtiers' + NBSP + ': export complet en un clic, suppression définitive sur demande.</p></div><div class="sheet__foot"><a class="btn btn--outline" href="/api/export" download="oubli-export.json">Exporter mes données (JSON)</a><span class="mono">RGPD art. 15 &amp; 20</span></div></section>' +
      '<form class="sheet" id="delete-form" novalidate><div class="sheet__head"><h2>Supprimer le compte</h2></div><div class="sheet__body"><p class="lead" style="margin-bottom:22px">Résilie l’abonnement, supprime vos profils, vos demandes et le journal. Irréversible.</p><div class="fields">' + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) + '</div>' + msgEl('msg-delete-form', 'margin-top:16px') + '</div><div class="sheet__foot"><button class="btn btn--danger" type="submit">Supprimer définitivement</button><span class="mono">RGPD art. 17</span></div></form></div>';
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
    view.focus({ preventScroll: true });
    var h = $('h1', view); if (h) announce(h.textContent);
  }
  function after(route, q) {
    if (route === 'dashboard') { drawChart(); loadDash(); pollTimer = setInterval(function () { if (!document.hidden) loadDash(); }, 6000); }
    if (route === 'onboarding' || route === 'dossier') loadMandateText();
    if (plugins[route]) plugins[route](q || {});
  }
  function loadDash(focusSel) {
    var pid = state.profileId ? '?profile_id=' + encodeURIComponent(state.profileId) : '';
    return api('/dashboard' + pid).then(function (d) { state.dash = d; state.user = d.user; state.profiles = d.profiles; state.profileId = d.profile_id; paintDash(focusSel); }).catch(function (e) { if (e.status === 401) { resetSession(); go('login'); return; } toast(e.message, true); });
  }
  function loadMandateText() {
    var box = $('#mandate-text'); if (!box) return;
    api('/mandate').then(function (m) { box.textContent = m.text || ''; }).catch(function (e) { box.textContent = e.message; });
  }

  /* ---------- interactions (délégation) ---------- */
  function busy(form, on) { form._busy = on; var b = form.querySelector('button[type="submit"]'); if (b) { b.setAttribute('aria-disabled', on ? 'true' : 'false'); b.setAttribute('aria-busy', on ? 'true' : 'false'); } }
  function lock(btn, on) { btn.setAttribute('aria-disabled', on ? 'true' : 'false'); btn.setAttribute('aria-busy', on ? 'true' : 'false'); }
  function showMsg(form, text, isErr, sel, fieldEl) {
    var m = form.querySelector(sel || '.msg'); if (!m) return;
    m.textContent = text || ''; m.classList.toggle('is-error', !!isErr);
    $$('[aria-invalid="true"]', form).forEach(function (i) { i.removeAttribute('aria-invalid'); });
    if (text && isErr && fieldEl) { fieldEl.setAttribute('aria-invalid', 'true'); var ds = (fieldEl.getAttribute('aria-describedby') || '').split(' ').filter(Boolean); if (m.id && ds.indexOf(m.id) < 0) ds.push(m.id); fieldEl.setAttribute('aria-describedby', ds.join(' ')); fieldEl.focus(); }
  }
  function arm(t, label) {
    if (t.getAttribute('data-confirm')) { clearTimeout(t._arm); t.removeAttribute('data-confirm'); t.textContent = t._label; return true; }
    t.setAttribute('data-confirm', '1'); t._label = t.textContent; t.textContent = label;
    announce(label + NBSP + ': appuyez de nouveau pour confirmer, ou Échap pour annuler.');
    t._arm = setTimeout(function () { disarm(t); }, 6000);
    t.addEventListener('blur', function () { disarm(t); }, { once: true });
    return false;
  }
  function disarm(t) { if (!t.getAttribute('data-confirm')) return; clearTimeout(t._arm); t.removeAttribute('data-confirm'); t.textContent = t._label; var f = t.closest('form'); if (f && f.id === 'delete-form') showMsg(f, ''); announce('Annulé.'); }
  function addTag(listField) {
    var input = $('.tags__add input', listField), ul = $('.tags', listField);
    var v = input.value.trim(); if (!v) return;
    if ($$('.tag span', ul).some(function (s) { return s.textContent.toLowerCase() === v.toLowerCase(); })) { input.value = ''; announce('«' + NBSP + v + NBSP + '» est déjà dans la liste.'); return; }
    var li = document.createElement('li'); li.className = 'tag';
    var span = document.createElement('span'); span.textContent = v; span.title = v;
    var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '×'; btn.setAttribute('aria-label', 'Retirer ' + v);
    li.appendChild(span); li.appendChild(btn); ul.appendChild(li);
    input.value = ''; input.focus(); announce('Ajouté' + NBSP + ': ' + v);
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
    if (f._busy) return;
    if (f.id === 'login-form' || f.id === 'signup-form') {
      var d = formData(f); busy(f, true); showMsg(f, '');
      api(f.id === 'login-form' ? '/auth/login' : '/auth/signup', { body: d }).then(function () { state.dash = null; state.profileId = null; return loadMe(); }).then(function () { toast(f.id === 'login-form' ? 'Connecté.' : 'Compte créé. Dossier ouvert.'); go(onboardingDone() ? 'dashboard' : 'onboarding'); }).catch(function (err) { showMsg(f, err.message, true, null, $('#f-password', f)); }).finally(function () { busy(f, false); });
    } else if (f.classList.contains('profile-form')) {
      var pd = profilePayload(f); busy(f, true); showMsg(f, '');
      api('/profiles/' + f.getAttribute('data-id'), { method: 'PUT', body: pd }).then(function () { return loadMe(); }).then(function () { toast('Informations enregistrées.'); if (params().route === 'onboarding') render(); else { var s = $('.sheet__head .mono--plain', f); if (s) s.textContent = 'Enregistré à l’instant'; } }).catch(function (err) { showMsg(f, err.message, true, null, $('input[name="first_name"]', f)); }).finally(function () { busy(f, false); });
    } else if (f.id === 'add-member') {
      var md = formData(f); busy(f, true); showMsg(f, '');
      api('/profiles', { body: md }).then(function () { return loadMe(); }).then(function () { state.dash = null; toast('Proche ajouté. Complétez ses informations.'); render(); }).catch(function (err) { showMsg(f, err.message, true, null, $('input[name="first_name"]', f)); }).finally(function () { busy(f, false); });
    } else if (f.id === 'mandate-form') {
      var mdd = formData(f); busy(f, true); showMsg(f, '');
      if (!f.querySelector('[name="accepted"]').checked) { showMsg(f, 'Cochez la case pour accepter le mandat.', true, null, f.querySelector('[name="accepted"]')); busy(f, false); return; }
      api('/mandate', { body: { full_name: mdd.full_name, accepted: true } }).then(function () { return loadMe(); }).then(function () { toast('Mandat signé.'); render(); if (onboardingDone()) launch(); }).catch(function (err) { showMsg(f, err.message, true, null, $('#f-full_name', f)); }).finally(function () { busy(f, false); });
    } else if (f.id === 'pwd-form') {
      var pw = formData(f); busy(f, true); showMsg(f, '');
      api('/auth/password', { body: pw }).then(function () { toast('Mot de passe changé.'); f.reset(); showMsg(f, ''); }).catch(function (err) { showMsg(f, err.message, true, null, $('#f-current', f)); }).finally(function () { busy(f, false); });
    } else if (f.id === 'delete-form') {
      var sb = f.querySelector('button[type="submit"]');
      if (!arm(sb, 'Confirmer la suppression')) { showMsg(f, 'Appuyez de nouveau sur «' + NBSP + 'Confirmer la suppression' + NBSP + '» pour effacer définitivement le compte, ou Échap pour annuler.'); return; }
      var dd = formData(f); busy(f, true); showMsg(f, '');
      api('/account', { method: 'DELETE', body: dd }).then(function () { resetSession(); toast('Compte supprimé. Vos données sont effacées.'); go('login'); }).catch(function (err) { showMsg(f, err.message, true, null, $('#f-password', f)); }).finally(function () { busy(f, false); });
    }
  });

  function launch() { return api('/requests/launch', { body: {} }).then(function (r) { if (r.created) toast(r.created + NBSP + 'demandes préparées. Première vague en cours d’envoi.'); go('dashboard'); setTimeout(loadDash, 1500); setTimeout(loadDash, 4000); }).catch(function (e) { toast(e.message, true); var b = $('#launch'); if (b) lock(b, false); }); }

  function closeMail(focusBack) {
    var open = $('.mail', view); if (!open) return false;
    var b = $('[data-mails="' + open.getAttribute('data-for') + '"]', view);
    open.remove(); if (b) { b.setAttribute('aria-expanded', 'false'); b.textContent = 'Courrier'; if (focusBack) b.focus(); }
    return true;
  }
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (e.key === 'Enter' && t.matches && t.matches('.tags__add input')) { e.preventDefault(); addTag(t.closest('.f--list')); return; }
    if (e.key === 'Escape') { if (closeMail(true)) return; var armed = $$('[data-confirm]'); if (armed.length) { armed.forEach(disarm); return; } }
    if (t.matches && t.matches('.seg [role="radio"]') && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) { e.preventDefault(); var all = $$('[role="radio"]', t.closest('.seg')), i = all.indexOf(t); all[(i + (/(Right|Down)/.test(e.key) ? 1 : all.length - 1)) % all.length].click(); }
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t) return;
    if (t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    if (t.matches('.tags__add button')) { addTag(t.closest('.f--list')); }
    else if (t.matches('.tag button')) { var li = t.closest('.tag'), nx = li.nextElementSibling || li.previousElementSibling, lf = li.closest('.f--list'), label = li.querySelector('span').textContent; li.remove(); (nx ? nx.querySelector('button') : $('.tags__add input', lf)).focus(); announce('Retiré' + NBSP + ': ' + label); }
    else if (t.hasAttribute('data-filter')) {
      e.preventDefault(); state.filter = t.getAttribute('data-filter'); state.page = 1;
      if (state.dash) { renderRows(); var n = visibleRequests(state.dash).length; announce(plural(n, 'demande affichée', 'demandes affichées') + '.'); if (!t.closest('#dash-filters')) { var fb = $('#dash-filters [data-filter="' + state.filter + '"]'); if (fb) { fb.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); fb.focus({ preventScroll: true }); } } }
    }
    else if (t.hasAttribute('data-profile')) { var pid = t.getAttribute('data-profile'); if (pid === state.profileId) return; state.profileId = pid; state.page = 1; state.search = ''; state.filter = 'all'; loadDash('.ptab[data-profile="' + pid + '"]'); }
    else if (t.id === 'rows-more') { var prev = $$('#rows .row:not(.row--head)').length; state.page += 1; renderRows(); var rows = $$('#rows .row:not(.row--head)'), first = rows[prev]; if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); } announce(plural(rows.length - prev, 'ligne ajoutée', 'lignes ajoutées') + '.'); }
    else if (t.id === 'search-clear') { state.search = ''; state.page = 1; var si = $('#broker-search'); if (si) si.value = ''; renderRows(); if (si) si.focus(); }
    else if (t.id === 'journal-toggle') { state.journalAll = !state.journalAll; var jh = $('#dash-journal'); if (jh) { sigs['dash-journal'] = sigJournal(state.dash); jh.innerHTML = journalHtml(state.dash); var jb = $('#journal-toggle'); if (jb) jb.focus(); } }
    else if (t.hasAttribute('data-billing')) { state.billing = t.getAttribute('data-billing'); var host = t.closest('.plans-block'); if (!host) { render(); return; } var y = window.scrollY; host.outerHTML = plansBlock(); window.scrollTo(0, y); var rb = $('[data-billing="' + state.billing + '"]'); if (rb) rb.focus({ preventScroll: true }); }
    else if (t.hasAttribute('data-checkout')) {
      lock(t, true);
      api('/billing/checkout', { body: { plan: t.getAttribute('data-checkout'), billing: state.billing } }).then(function (r) {
        if (r.mode === 'stripe') { location.href = r.url; return; }
        return loadMe().then(function () { state.dash = null; toast('Abonnement activé.'); if (onboardingDone()) return launch(); render(); });
      }).catch(function (err) { toast(err.message, true); lock(t, false); });
    }
    else if (t.id === 'cancel-sub') { if (!arm(t, 'Confirmer la résiliation')) return; api('/billing/cancel', { method: 'POST' }).then(loadMe).then(function () { state.dash = null; toast('Abonnement résilié.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.id === 'revoke') { if (!arm(t, 'Confirmer la révocation')) return; api('/mandate', { method: 'DELETE' }).then(loadMe).then(function () { state.dash = null; toast('Mandat révoqué.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.id === 'launch') { lock(t, true); launch(); }
    else if (t.hasAttribute('data-resolve')) { lock(t, true); api('/requests/' + t.getAttribute('data-resolve') + '/resolve', { method: 'POST' }).then(function () { toast('Merci. La demande reprend son cours.'); var row = t.closest('.row'); if (row) { var nb = $('[data-mails]', row); if (nb) nb.focus(); else view.focus(); } loadDash(); }).catch(function (err) { toast(err.message, true); lock(t, false); }); }
    else if (t.hasAttribute('data-mails')) {
      var row = t.closest('.row'), id = t.getAttribute('data-mails');
      if ($('.mail', row)) { closeMail(false); return; }
      closeMail(false); lock(t, true);
      api('/requests/' + id + '/mails').then(function (m) {
        var box = document.createElement('div'); box.className = 'mail'; box.id = 'mail-' + id; box.setAttribute('data-for', id); box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Courriers' + NBSP + '— ' + $('.row__who strong', row).textContent);
        box.innerHTML = m.mails.length ? m.mails.map(function (x) { return '<div class="mail__item"><p class="mono mono--plain">' + esc(fmtTime(x.created_at)) + SEP + 'à ' + esc(x.to_addr) + SEP + esc(x.mode === 'smtp' ? 'envoyé' : 'boîte d’envoi locale') + '</p><div class="mail-body" tabindex="0" role="region" aria-label="Courrier du ' + esc(fmtTime(x.created_at)) + '">' + esc(x.subject + '\n\n' + x.body) + '</div></div>'; }).join('') : '<p class="empty empty--sm">Aucun courrier.</p>';
        row.appendChild(box); t.setAttribute('aria-expanded', 'true'); t.textContent = 'Fermer';
      }).catch(function (err) { toast(err.message, true); }).finally(function () { lock(t, false); });
    }
    else if (t.hasAttribute('data-remove')) { if (!arm(t, 'Confirmer le retrait')) return; api('/profiles/' + t.getAttribute('data-remove'), { method: 'DELETE' }).then(loadMe).then(function () { state.dash = null; state.profileId = null; toast('Profil retiré.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.getAttribute('href') && /^#profile-/.test(t.getAttribute('href'))) { e.preventDefault(); var el = $(t.getAttribute('href')); if (el) { el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); var inp = $('input', el); if (inp) setTimeout(function () { inp.focus({ preventScroll: true }); }, reduced() ? 0 : 400); } }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'broker-search') { var v = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(function () { state.search = v; state.page = 1; renderRows(); if (state.dash) announce(plural(visibleRequests(state.dash).length, 'courtier', 'courtiers') + '.'); }, 180); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'broker-sort') { state.sort = e.target.value; state.page = 1; renderRows(); }
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { var h = $('#exp-chart'); if (h && h._size && Math.abs(h.clientWidth - h._size.W) > 8) drawChart(); }, 150); });

  /* ---------- API interne pour les modules optionnels (admin) ---------- */
  window.Oubli = { registerView: registerView, api: api, esc: esc, toast: toast, fmtDate: fmtDate, fmtTime: fmtTime, money: money, chip: chip, dots: dots, statusLabel: statusLabel, subLabel: subLabel, field: field, go: go, render: render, params: params, state: state, NBSP: NBSP, NNBSP: NNBSP, announce: announce, typo: typo, fmtDay: fmtDay, plural: plural };

  /* ---------- démarrage ---------- */
  Promise.all([api('/config').catch(function () { return { plans: { individuel: { name: 'Individuel', members: 1, monthly: 1299, annual: 8388 }, famille: { name: 'Famille', members: 5, monthly: 2499, annual: 16788 } }, billing: 'simulated', brokers: 50, mandate_version: '' }; }), loadMe()]).then(function (r) {
    state.config = r[0];
    var q = params().q; if (q.billing === 'monthly') state.billing = 'monthly';
    render();
  });
})();
