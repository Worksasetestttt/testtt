/* Oubli — application cliente (vanilla JS, routage par hash, API JSON avec cookie de session). */
(function () {
  'use strict';
  var NBSP = ' ', NNBSP = ' ', SEP = NBSP + '· ';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var view = $('#view'), nav = $('#nav'), topUser = $('#top-user'), toastEl = $('#toast'), announceEl = $('#announce');
  var state = { user: null, impersonation: null, profiles: [], config: null, dash: null, profileId: null, filter: 'all', search: '', sort: 'status', page: 1, journalAll: false, catsAll: false };
  var PAGE = 15, JOURNAL = 8;
  var pollTimer = null, sigs = {}, searchTimer = null, resizeTimer = null, barKey = null, noticeKey = null;
  var MARK = '<svg viewBox="0 0 32 32" width="44" height="44" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="10.5" stroke="currentColor" stroke-width="3.2"/><path d="M3.5 17.8 L28.5 14.2" stroke="#C8471F" stroke-width="3.2" stroke-linecap="round"/></svg>';
  var COUNTRIES = { FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', NL: 'Pays-Bas', PT: 'Portugal', GB: 'Royaume-Uni', US: 'États-Unis', CA: 'Canada' };
  var SENS = { 3: 'Sensibilité élevée', 2: 'Sensibilité moyenne', 1: 'Sensibilité faible' };

  /* ---------- utilitaires ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /* Typographie française pour les textes venant du serveur : apostrophe typographique, insécable avant : ; ? ! » */
  function typo(s) { return String(s == null ? '' : s).replace(/'/g, '’').replace(/ ([:;?!»])/g, NBSP + '$1').replace(/« /g, '«' + NBSP); }
  function money(cents) { return (cents % 100 ? (cents / 100).toFixed(2).replace('.', ',') : String(cents / 100)) + NNBSP + '€'; }   // « 5 € », « 9,99 € »
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
      return r.text().then(function (t) {
        var d; try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { error: 'Réponse invalide du serveur.' }; }
        if (!r.ok) {
          var err = new Error(d.error || ('Erreur ' + r.status)); err.status = r.status; err.code = d.code || null;
          // Session expirée ou fermée ailleurs : retour à la connexion, quel que soit l'écran (pas seulement le tableau de bord).
          if (r.status === 401 && state.user && path !== '/auth/login') { resetSession(); toast('Session expirée' + NBSP + ': reconnectez-vous.', true); go('login'); }
          throw err;
        }
        return d;
      });
    });
  }
  function params() { var h = location.hash.slice(1), i = h.indexOf('?'); var out = { route: i < 0 ? h : h.slice(0, i), q: {} }; if (i >= 0) new URLSearchParams(h.slice(i + 1)).forEach(function (v, k) { out.q[k] = v; }); return out; }
  function go(hash) { if (location.hash === '#' + hash) render(); else location.hash = hash; }
  function statusLabel(s) { return { queued: 'À envoyer', sent: 'Envoyée', in_progress: 'En cours', action_required: 'Action requise', done: 'Effacée', refused: 'Refusée', error: 'Erreur d’envoi', stopped: 'Arrêtée' }[s] || s; }
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
  /* Abonnement actif. Un abonnement offert par clé d'activation cesse à sa date de fin (même règle que le serveur). */
  function subActive(u) { return !!(u && u.subscription_status === 'active' && (u.billing_mode !== 'key' || (u.subscription_ends_at && Date.parse(u.subscription_ends_at) > Date.now()))); }
  function onboardingDone() { var u = state.user, p = state.profiles[0]; return !!(u && p && p.first_name && p.last_name && u.mandate_signed_at && !u.mandate_revoked_at && subActive(u)); }
  /* Page d'accueil après connexion : un administrateur sans abonnement va à l'administration, pas à l'ouverture de dossier. */
  function home() { return onboardingDone() ? 'dashboard' : state.user && state.user.role === 'admin' && !state.user.mandate_signed_at && !subActive(state.user) ? 'admin' : 'onboarding'; }
  /* Clé d'activation reçue par un lien de partage (#signup?key=…) : gardée pour la session (sessionStorage, ou en mémoire
     si le stockage est refusé) jusqu'à l'étape « offre », où elle est proposée. Jamais envoyée ailleurs qu'à /billing/redeem. */
  var KEY_STORE = 'oubli.activation-key', memKey = '';
  function pendingKey() { var v = memKey; try { v = sessionStorage.getItem(KEY_STORE) || memKey; } catch (e) { /* stockage indisponible */ } return v || ''; }
  function setPendingKey(v) { memKey = v || ''; try { if (v) sessionStorage.setItem(KEY_STORE, v); else sessionStorage.removeItem(KEY_STORE); } catch (e) { /* stockage indisponible */ } }
  function keyNotice() { return pendingKey() ? '<p class="notice notice--ok key-note">Clé d’activation reçue' + NBSP + ': elle vous sera proposée à la dernière étape, et l’abonnement démarrera sans paiement.</p>' : ''; }
  var LONG = { day: 'numeric', month: 'long', year: 'numeric' };
  var KEY_FMT = ['OUBLI', 'XXXX', 'XXXX', 'XXXX'].join('\u2011');   // traits d'union insécables : le format ne se coupe pas
  function fileNo(id) { return 'N°' + NBSP + String(id || '').slice(0, 4).toUpperCase(); }
  function scopeOf(p) { return String(p.id || 'new').slice(0, 8); }

  /* ---------- session ---------- */
  function loadMe() {
    return api('/me').then(function (d) { state.user = d.user || null; state.profiles = d.profiles || []; state.impersonation = d.impersonation || null; return !!d.user; }).catch(function () { state.user = null; state.profiles = []; state.impersonation = null; return false; });
  }
  function resetSession() { state.user = null; state.impersonation = null; state.profiles = []; state.dash = null; state.profileId = null; sigs = {}; dashTag = null; }
  function setChrome() {
    var on = !!state.user;
    nav.hidden = !on; topUser.hidden = !on;
    if (on) { $('#top-email').textContent = state.user.email; $('#nav-admin').hidden = state.user.role !== 'admin'; }
    var route = params().route;
    $$('a', nav).forEach(function (a) { var act = a.getAttribute('data-route') === route; a.classList.toggle('is-active', act); if (act) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    setBars();
  }
  /* Bandeaux : accès support (un administrateur consulte ce compte, en lecture seule) et annonce de l'équipe.
     Reconstruits seulement quand leur contenu change, pour ne pas voler le focus. */
  function setBars() {
    var imp = state.user && state.impersonation, sb = $('#support-bar'), key = imp ? state.user.email + '|' + imp.expires_at : '';
    document.body.classList.toggle('is-support', !!imp);
    if (key !== barKey) {
      barKey = key; sb.hidden = !imp;
      sb.innerHTML = imp ? '<div class="support-bar__inner"><p><strong>Accès support</strong>' + SEP + 'vous consultez le compte de ' + esc(state.user.email) + ' en lecture seule, jusqu’à ' + new Date(imp.expires_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '.</p><button class="btn btn--sm" type="button" id="support-stop">Revenir à l’administration</button></div>' : '';
    }
    var a = state.config && state.config.announcement, sn = $('#site-notice'), nk = a ? a.level + '|' + a.text : '';
    if (nk !== noticeKey) {
      noticeKey = nk; sn.hidden = !a; sn.classList.toggle('site-notice--warn', !!(a && a.level === 'warn'));
      sn.innerHTML = a ? '<p class="site-notice__inner">' + esc(typo(a.text)) + '</p>' : '';
    }
  }
  function backToAdmin(r) { location.hash = r && r.admin ? 'admin' : 'login'; location.reload(); }
  $('#logout').addEventListener('click', function () { api('/auth/logout', { method: 'POST' }).then(function (r) { if (r && 'admin' in r) return backToAdmin(r); resetSession(); toast('À bientôt.'); go('login'); }); });

  /* ---------- vues ---------- */
  var views = {};

  views.login = function (q) {
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Bon retour.</h1><p class="lead">Connectez-vous pour suivre vos demandes.</p>' + keyNotice() +
      '<form id="login-form" class="sheet" novalidate><div class="sheet__body"><div class="fields">' + field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) +
      '</div><p class="auth__forgot"><a class="auth__link" href="#forgot" id="forgot-link">Mot de passe oublié' + NBSP + '?</a></p>' + msgEl('msg-login-form', 'margin-top:8px') + '<button class="btn btn--block" type="submit">Se connecter</button></div></form>' +
      '<p class="switch">Pas encore de dossier' + NBSP + '? <a class="auth__link" href="#signup">Créer un compte</a></p></section>';
  };
  views.signup = function (q) {
    var plan = state.config && state.config.plans[q.plan] ? q.plan : 'individuel';
    var p = state.config ? state.config.plans[plan] : null;
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Ouvrons votre <em>dossier</em>.</h1><p class="lead">Deux minutes pour créer le compte. Les demandes partent dès que le mandat est signé.</p>' + keyNotice() +
      '<form id="signup-form" class="sheet" novalidate><div class="sheet__body"><input type="hidden" name="plan" value="' + esc(plan) + '">' +
      (p && !pendingKey() ? '<div class="offer"><span><span class="mono">Offre</span><br><strong>' + esc(p.name) + '</strong>' + SEP + 'sans engagement</span><span><strong>' + money(p.monthly) + '</strong><small class="mono--plain mono">/mois</small></span></div>' : '') +
      '<div class="fields">' + field('email', 'Adresse e-mail', q.email || '', { extra: 'type="email" autocomplete="email" required' }) + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10' + NBSP + 'caractères.') +
      '</div>' + msgEl('msg-signup-form', 'margin-top:16px') + '<button class="btn btn--block" type="submit">Créer mon compte <span class="btn__arrow" aria-hidden="true">→</span></button></div></form>' +
      '<p class="switch">Déjà un compte' + NBSP + '? <a class="auth__link" href="#login">Se connecter</a></p></section>';
  };

  /* ---------- mot de passe oublié ---------- */
  /* Le serveur répond la même chose que le compte existe ou non : l'écran de confirmation reste neutre. */
  views.forgot = function () {
    var email = state.forgotEmail || ''; state.forgotEmail = '';
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Mot de passe oublié' + NBSP + '?</h1><p class="lead">Indiquez l’adresse de votre compte' + NBSP + ': nous vous envoyons un lien pour choisir un nouveau mot de passe.</p>' +
      '<div id="forgot-box">' + forgotForm(email) + '</div><p class="switch"><a class="auth__link" href="#login">Retour à la connexion</a></p></section>';
  };
  function forgotForm(email) {
    return '<form id="forgot-form" class="sheet" novalidate><div class="sheet__body"><div class="fields">' + field('email', 'Adresse e-mail', email, { extra: 'type="email" autocomplete="email" required' }) + '</div>' +
      msgEl('msg-forgot-form', 'margin-top:16px') + '<button class="btn btn--block" type="submit">Recevoir le lien</button></div></form>';
  }
  function forgotDone(email) {
    return '<div class="sheet"><div class="sheet__body auth__state"><h2 id="auth-state-h" tabindex="-1">Vérifiez votre boîte de réception</h2>' +
      '<p>Si un compte Oubli est associé à <strong class="auth__email">' + esc(email) + '</strong>, un e-mail vient de partir avec un lien pour choisir un nouveau mot de passe. Le lien est valable une heure et ne sert qu’une fois.</p>' +
      '<p class="hint">Rien reçu d’ici quelques minutes' + NBSP + '? Regardez dans les courriers indésirables et vérifiez l’adresse saisie.</p>' +
      '<button class="btn btn--outline btn--block" type="button" id="forgot-again" data-email="' + esc(email) + '">Faire une nouvelle demande</button></div></div>';
  }
  var RESET_TOKEN = /^[A-Za-z0-9_-]{43}$/;
  views.reset = function (q) {
    var ok = RESET_TOKEN.test(q.token || '');
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Nouveau mot de passe</h1><div id="reset-box">' +
      (ok ? '<p class="lead">Choisissez le nouveau mot de passe de votre compte. Par sécurité, tous vos appareils seront déconnectés.</p>' + resetForm() : resetState('incomplete')) +
      '</div><p class="switch"><a class="auth__link" href="#login">Retour à la connexion</a></p></section>';
  };
  function resetForm() {
    return '<form id="reset-form" class="sheet" novalidate><div class="sheet__body"><div class="fields">' +
      field('password', 'Nouveau mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10' + NBSP + 'caractères, sans votre adresse e-mail.') +
      field('confirm', 'Confirmez le mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }) + '</div>' +
      msgEl('msg-reset-form', 'margin-top:16px') + '<button class="btn btn--block" type="submit">Enregistrer le mot de passe</button></div></form>';
  }
  /* Lien inutilisable (incomplet, expiré, déjà servi, remplacé) ou compte suspendu après le changement (message du serveur). */
  var RESET_STATES = {
    incomplete: ['Ce lien est incomplet', 'L’adresse ouverte ne contient pas de jeton de réinitialisation valide. Ouvrez le lien complet depuis l’e-mail reçu, ou demandez-en un nouveau.'],
    expired: ['Ce lien a expiré', 'Un lien de réinitialisation n’est valable qu’une heure. Demandez-en un nouveau' + NBSP + ': il arrive en quelques instants.'],
    used: ['Ce lien a déjà servi', 'Un lien de réinitialisation ne sert qu’une fois. Si vous venez de choisir un nouveau mot de passe, connectez-vous avec lui' + NBSP + '; sinon, demandez un nouveau lien.'],
    invalid: ['Ce lien n’est plus valable', 'Il a peut-être été remplacé par un lien plus récent' + NBSP + ': utilisez le dernier e-mail reçu, ou demandez un nouveau lien.'],
    suspended: ['Mot de passe changé', ''],
  };
  function resetState(code, message) {
    var dead = code !== 'suspended', s = RESET_STATES[code] || RESET_STATES.invalid, title = s[0], text = message || s[1];
    return '<div class="sheet"><div class="sheet__body auth__state"><h2 id="auth-state-h" tabindex="-1">' + title + '</h2><p>' + esc(text) + '</p>' +
      (dead ? '<a class="btn btn--block" href="#forgot">Recevoir un nouveau lien</a>' : '<a class="btn btn--outline btn--block" href="#login">Retour à la connexion</a>') + '</div></div>';
  }
  /* ---------- confirmation de l'adresse d'un administrateur (#verify?token=…) ---------- */
  /* En production, une adresse de ADMIN_EMAILS n'ouvre l'administration qu'après ce lien (server/account.js). */
  views.verify = function (q) {
    var pending = RESET_TOKEN.test(q.token || '');
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Confirmation de l’adresse</h1><div id="verify-box">' +
      (pending ? '<div class="sheet"><div class="sheet__body auth__state"><p><span class="spinner"></span> Vérification du lien…</p></div></div>' : verifyState(q.done ? 'used' : 'invalid')) +
      '</div><p class="switch"><a class="auth__link" href="#' + (state.user ? home() : 'login') + '">' + (state.user ? 'Retour à l’application' : 'Retour à la connexion') + '</a></p></section>';
  };
  var VERIFY_STATES = {
    admin: ['Accès administrateur activé', 'Votre adresse est confirmée' + NBSP + ': l’administration est maintenant accessible depuis votre compte.'],
    done: ['Adresse confirmée', 'Votre adresse e-mail est confirmée.'],
    used: ['Adresse déjà confirmée', 'Ce lien a déjà servi' + NBSP + ': votre adresse est confirmée.'],
    expired: ['Ce lien a expiré', 'Un lien de confirmation est valable 24' + NBSP + 'heures. Reconnectez-vous' + NBSP + ': un nouveau lien vous sera envoyé.'],
    invalid: ['Ce lien n’est pas valable', 'Il est incomplet ou a été remplacé par un lien plus récent' + NBSP + ': utilisez le dernier e-mail reçu.'],
  };
  function verifyState(code) {
    var s = VERIFY_STATES[code] || VERIFY_STATES.invalid;
    var cta = code === 'admin' ? '<a class="btn btn--block" href="#' + (state.user ? 'admin' : 'login') + '">' + (state.user ? 'Ouvrir l’administration' : 'Se connecter') + '</a>'
      : /^(expired|invalid)$/.test(code) && !state.user ? '<a class="btn btn--outline btn--block" href="#login">Se connecter</a>' : '';
    return '<div class="sheet"><div class="sheet__body auth__state"><h2 id="auth-state-h" tabindex="-1">' + s[0] + '</h2><p>' + s[1] + '</p>' + cta + '</div></div>';
  }
  function runVerify(q) {
    if (!RESET_TOKEN.test(q.token || '')) return;
    api('/auth/verify', { body: { token: q.token } }).then(function (r) {
      history.replaceState(null, '', location.pathname + location.search + '#verify?done=1');   // le jeton sort de l'adresse et de l'historique
      return (state.user ? loadMe() : Promise.resolve()).then(function () { if (state.user) setChrome(); var box = $('#verify-box'); if (box) swapState(box, verifyState(r.admin ? 'admin' : 'done')); });   // setChrome : lien « Admin » de l'en-tête
    }).catch(function (err) { var box = $('#verify-box'); if (box) swapState(box, verifyState(/^(invalid|expired|used)$/.test(err.code || '') ? err.code : 'invalid')); });
  }

  /* ---------- désinscription du rapport mensuel (#unsubscribe?u=…&t=…), lien reçu par e-mail, sans session ---------- */
  /* La page demande une confirmation : un antivirus ou un aperçu qui suit le lien ne désinscrit personne. */
  function unsubQs(q) { return /^[A-Za-z0-9_-]{1,64}$/.test(q.u || '') && /^[A-Za-z0-9_-]{43}$/.test(q.t || '') ? new URLSearchParams({ u: q.u, t: q.t }).toString() : ''; }
  views.unsubscribe = function (q) {
    var ok = !!unsubQs(q);
    return '<section class="auth"><div class="auth__mark">' + MARK + '</div><h1>Rapport mensuel</h1><div id="unsub-box">' +
      (q.done ? unsubState('done') : ok ? '<div class="sheet"><div class="sheet__body auth__state"><p>Ne plus recevoir le rapport mensuel par e-mail' + NBSP + '? Les alertes «' + NBSP + 'action requise' + NBSP + '» restent envoyées' + NBSP + ': elles demandent une intervention de votre part.</p><button class="btn btn--block" type="button" id="unsub-go">Me désinscrire</button></div></div>' : unsubState('invalid')) +
      '</div><p class="switch"><a class="auth__link" href="#' + (state.user ? 'settings' : 'login') + '">' + (state.user ? 'Gérer mes notifications' : 'Se connecter') + '</a></p></section>';
  };
  function unsubState(code, text) {
    var done = code === 'done';
    return '<div class="sheet"><div class="sheet__body auth__state"><h2 id="auth-state-h" tabindex="-1">' + (done ? 'Désinscription enregistrée' : 'Ce lien n’est pas valable') + '</h2><p>' +
      esc(text || (done ? 'Vous ne recevrez plus le rapport mensuel. Vous pouvez le réactiver à tout moment dans vos paramètres.' : 'Il est incomplet ou ne correspond à aucun compte' + NBSP + ': désactivez le rapport depuis vos paramètres.')) + '</p></div></div>';
  }

  /* Remplace le contenu d'une zone (formulaire → état) : le focus va au titre, le message suit en annonce polie. */
  function swapState(box, html) {
    box.innerHTML = html;
    var h = $('#auth-state-h', box), p = $('.auth__state > p', box);
    if (h) h.focus();
    if (p) announce(p.textContent);
  }

  views.onboarding = function () {
    var u = state.user, p = state.profiles[0] || {};
    var s1 = !!(p.first_name && p.last_name), s2 = !!(u.mandate_signed_at && !u.mandate_revoked_at), s3 = subActive(u);
    var cur = !s1 ? 1 : !s2 ? 2 : 3;
    function step(n, title, sub, done) { return '<li class="rail__step ' + (done ? 'is-done' : cur === n ? 'is-current' : '') + '"' + (cur === n ? ' aria-current="step"' : '') + '><span class="rail__n">0' + n + '</span><div><strong>' + title + '</strong><span>' + sub + '</span></div></li>'; }
    var html = '<div class="page-head"><div><span class="mono">Dossier ' + fileNo(p.id) + SEP + 'Ouverture</span><h1>Trois étapes, puis nous prenons le relais.</h1></div></div>' +
      '<div class="onb"><ol class="rail" aria-label="Étapes">' + step(1, 'Vos informations', 'Ce que les courtiers peuvent connaître de vous.', s1) + step(2, 'Le mandat', 'L’autorisation d’écrire en votre nom. Révocable.', s2) + step(3, 'L’offre', 'Satisfait ou remboursé 30' + NBSP + 'jours.', s3) + '</ol><div>';
    if (cur === 1) html += keyNotice() + profileForm(p, true);
    else if (cur === 2) html += keyNotice() + mandateCard(p);
    else html += '<div class="stack"><div><h2>Dernière étape' + NBSP + ': votre offre</h2><p class="lead">' + (pendingKey() ? 'Activez la clé reçue, ou choisissez une offre' + NBSP + ': les demandes partent dans la foulée.' : 'Les demandes partent dans la foulée.') + '</p></div>' + (pendingKey() ? keyBlock() + plansBlock() : plansBlock() + keyBlock()) + '</div>';
    return html + '</div></div>';
  };

  /* Clé d'activation (abonnement offert) : bloc discret replié, ouvert et pré-rempli quand une clé a été reçue par lien. */
  function keyBlock() {
    var u = state.user, pk = pendingKey(), keyed = u.billing_mode === 'key' && subActive(u);
    var hint = keyed ? 'Une nouvelle clé prolonge votre abonnement offert' + NBSP + '; une clé Famille vous fait passer à l’offre Famille.' : 'La clé se présente sous la forme ' + KEY_FMT + NBSP + ': l’abonnement démarre aussitôt, sans paiement.';
    return '<details class="keybox"' + (pk ? ' open' : '') + '><summary class="keybox__sum">Vous avez une clé d’activation' + NBSP + '?</summary>' +
      '<form id="key-form" class="keybox__form" novalidate>' + (pk ? '<p class="notice notice--ok">Une clé d’activation vous a été transmise' + NBSP + ': vérifiez-la, puis activez-la pour démarrer sans paiement.</p>' : '') +
      '<div class="keybox__row"><div class="f"><label for="key-input">Clé d’activation</label><input id="key-input" name="key" value="' + esc(pk) + '" placeholder="OUBLI-XXXX-XXXX-XXXX" maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="key-hint"><span class="hint" id="key-hint">' + hint + '</span></div>' +
      '<button class="btn" type="submit">Activer</button></div>' + msgEl('msg-key-form') + '</form></details>';
  }

  /* Les identifiants ne sont préfixés (scope) que sur la page Dossier, où plusieurs formulaires coexistent. */
  function profileForm(p, onboarding) {
    var sc = onboarding ? '' : scopeOf(p), cid = 'f-' + (sc ? sc + '-' : '') + 'country';
    return '<form class="sheet profile-form" data-id="' + esc(p.id) + '" id="profile-form-' + esc(scopeOf(p)) + '" novalidate>' +
      '<div class="sheet__head"><span class="mono">Dossier ' + fileNo(p.id) + (p.is_primary ? SEP + 'Profil principal' : SEP + 'Proche') + '</span>' + (p.updated_at && p.first_name ? '<span class="mono mono--plain">Mis à jour le ' + fmtDate(p.updated_at) + '</span>' : '') + '</div>' +
      '<div class="sheet__body"><div class="sheet__section"><h2>' + (onboarding ? 'Qui devons-nous faire oublier' + NBSP + '?' : (p.is_primary ? 'Vous' : esc(fullName(p)))) + '</h2><p class="hint">Ces informations servent uniquement à identifier vos fiches chez les courtiers. Jamais revendues, exportables et supprimables à tout moment.</p>' +
      '<div class="fields fields--2">' + field('first_name', 'Prénom', p.first_name || '', { extra: 'required autocomplete="given-name"' }, '', sc) + field('last_name', 'Nom', p.last_name || '', { extra: 'required autocomplete="family-name"' }, '', sc) +
      field('birth_date', 'Date de naissance', p.birth_date || '', { extra: 'type="date"' }, 'Distingue vos fiches de celles d’un homonyme.', sc) +
      '<div class="f"><label for="' + cid + '">Pays de résidence</label><select id="' + cid + '" name="country">' + Object.keys(COUNTRIES).map(function (c) { return '<option value="' + c + '"' + ((p.country || 'FR') === c ? ' selected' : '') + '>' + COUNTRIES[c] + '</option>'; }).join('') + '</select></div></div></div>' +
      '<div class="sheet__section"><h2>Ce qu’ils peuvent savoir de vous</h2><p class="hint">Ajoutez toutes les variantes connues' + NBSP + ': anciennes adresses, ancien numéro, adresse e-mail d’étudiant… Plus la liste est complète, plus les suppressions sont rapides.</p>' +
      '<div class="fields" style="gap:30px">' + tagField('emails', 'Adresses e-mail', p.emails, 'ajouter une adresse e-mail', '', sc) + tagField('phones', 'Numéros de téléphone', p.phones, 'ajouter un numéro', '', sc) + tagField('addresses', 'Adresses postales, actuelles et passées', p.addresses, 'ajouter une adresse postale', '', sc) + tagField('aliases', 'Autres noms utilisés', p.aliases, 'nom de naissance, surnom…', '', sc) + '</div></div>' +
      msgEl('msg-profile-' + esc(scopeOf(p)), 'margin-top:20px') + '</div>' +
      '<div class="sheet__foot"><div class="btn-row"><button class="btn" type="submit">' + (onboarding ? 'Enregistrer et continuer <span class="btn__arrow" aria-hidden="true">→</span>' : 'Enregistrer') + '</button>' + (!p.is_primary && !onboarding ? '<button class="btn btn--danger btn--sm" type="button" data-remove="' + esc(p.id) + '">Retirer du dossier</button>' : '') + '</div><span class="mono">Jamais revendues' + SEP + 'RGPD art. 15 &amp; 17</span></div></form>';
  }

  function mandateCard(p) {
    return '<div class="sheet" id="mandate-card"><div class="sheet__head"><span class="mono">Mandat de représentation' + SEP + 'RGPD art. 17 &amp; 21</span><span class="mono mono--plain">Version ' + esc(state.config ? state.config.mandate_version : '') + '</span></div>' +
      '<div class="sheet__body"><div class="sheet__section"><h2>L’autorisation d’écrire en votre nom</h2><p class="hint">Un courtier n’a pas à répondre à un tiers. Ce mandat nous permet d’exercer vos droits à votre place. Vous pouvez le révoquer à tout moment depuis votre dossier.</p>' +
      '<div class="mandate-text" id="mandate-text"><span class="spinner"></span> Chargement du mandat…</div></div>' +
      '<form id="mandate-form" class="sheet__section" novalidate><label class="check"><input type="checkbox" name="accepted" required aria-describedby="msg-mandate-form"> <span>J’ai lu le mandat et j’autorise Oubli à exercer mes droits d’accès, d’effacement et d’opposition auprès des courtiers en données.</span></label>' +
      '<div class="sig" style="margin-top:28px"><div class="f"><label for="f-full_name">Signez en tapant votre prénom et votre nom</label><input id="f-full_name" name="full_name" placeholder="' + esc((p.first_name || '') + ' ' + (p.last_name || '')) + '" autocomplete="off" required></div><button class="btn" type="submit">Signer électroniquement</button></div>' +
      msgEl('msg-mandate-form', 'margin-top:14px') + '</form></div></div>';
  }

  /* Offres : formule unique, mensuelle et sans engagement. */
  function plansBlock() {
    var plans = state.config.plans, u = state.user;
    var subscribed = subActive(u), featured = u && u.plan && plans[u.plan] ? u.plan : 'individuel';
    var cards = Object.keys(plans).map(function (k) {
      var p = plans[k], cur = subscribed && u.plan === k;
      return '<div class="sheet plan' + (k === featured ? ' plan--featured' : '') + (cur ? ' is-current' : '') + '"><div class="plan__head"><h3>' + esc(p.name) + '</h3><span class="mono">' + (p.members > 1 ? 'Jusqu’à ' + p.members + NBSP + 'personnes' : 'Une personne') + '</span></div>' +
        '<div class="plan__price"><b>' + money(p.monthly) + '</b><small>/mois</small></div><p class="plan__note">' + (p.members > 1 ? 'Moins de 2' + NNBSP + '€ par personne pour cinq proches' : 'Sans engagement, résiliable en un clic') + '</p>' +
        '<ul><li>Demandes auprès de ' + (state.config.brokers || '') + NBSP + 'courtiers et annuaires</li><li>Vos propres sites ajoutés en collant leur adresse</li><li>Relances automatiques à l’échéance légale</li><li>Nouvelle vérification tous les 60' + NBSP + 'à' + NBSP + '90' + NBSP + 'jours</li><li>Rapport mensuel par e-mail</li><li>Journal horodaté, preuves exportables</li>' + (p.members > 1 ? '<li>Un dossier par personne, une seule facture</li>' : '') + '</ul>' +
        (cur ? '<p class="notice notice--ok">Votre offre actuelle' + (u.billing === 'annual' ? ' (ancienne formule annuelle)' : '') + '.</p>' : '<button class="btn btn--block' + (subscribed || k !== featured ? ' btn--outline' : '') + '" type="button" data-checkout="' + k + '">' + (subscribed ? 'Passer à ' + esc(p.name) : 'Choisir ' + esc(p.name)) + '</button>') + '</div>';
    }).join('');
    return '<div class="plans-block">' + (state.config.billing === 'simulated' ? '<div class="toolbar"><span class="mono">Paiement simulé' + SEP + 'aucune clé Stripe</span></div>' : '') + '<div class="plans">' + cards + '</div><p class="mono" style="margin-top:18px">Prix TTC' + SEP + 'Sans engagement' + SEP + 'Satisfait ou remboursé 30' + NBSP + 'jours' + SEP + 'Résiliation en un clic</p></div>';
  }

  /* ---------- tableau de bord ---------- */
  function currentProfile(d) { return d.profiles.filter(function (p) { return p.id === d.profile_id; })[0] || d.profiles[0] || {}; }
  function readOnly() { return !!state.impersonation; }   // accès support : consultation seulement
  function canAddSite(d) { return !!(d.sites && d.onboarding.mandate && (d.onboarding.access || d.onboarding.subscription) && !readOnly()); }
  /* Pastille d'initiale : la teinte suit la catégorie, pour repérer d'un coup d'œil les courtiers de même nature. */
  var HUES = [16, 35, 150, 195, 222, 262, 320, 95];
  function hueOf(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return HUES[h % HUES.length]; }
  function mark(name, cat, big) { var n = String(name || '?').replace(/^www\./i, ''); return '<span class="mark' + (big ? ' mark--lg' : '') + '" style="--h:' + hueOf(cat || n) + '" aria-hidden="true">' + esc(n.charAt(0).toUpperCase()) + '</span>'; }
  function basisLabel(r) { return r.legal_basis === 'ccpa' ? 'CCPA' : r.legal_basis === 'both' ? 'RGPD et CCPA' : 'RGPD'; }
  function rowById(id) { return state.dash ? state.dash.requests.filter(function (r) { return r.id === id; })[0] || null : null; }

  /* Indicateur « en direct » : le tableau de bord se rafraîchit seul ; hors ligne, il le dit et réessaie. */
  var live = { state: 'ok', text: 'En direct' };
  function setLive(st, text) {
    live.state = st; live.text = text;
    var el = $('#dash-live'); if (el && (el.getAttribute('data-state') !== st || el.textContent !== text)) { el.setAttribute('data-state', st); el.textContent = text; }
  }

  function dashHead(d) {
    var c = d.counters, prof = currentProfile(d), o = d.onboarding, tabs = '';
    if (d.profiles.length > 1 || (o.max_profiles > 1 && d.profiles.length < o.max_profiles)) {
      tabs = '<div class="ptabs" role="group" aria-label="Dossier affiché">' + d.profiles.map(function (p) {
        return '<button type="button" class="ptab" aria-pressed="' + (p.id === d.profile_id) + '" data-profile="' + esc(p.id) + '"><span class="avatar avatar--sm" aria-hidden="true">' + esc(initials(p)) + '</span><span>' + esc(fullName(p)) + '</span></button>';
      }).join('') + (d.profiles.length < o.max_profiles && !readOnly() ? '<a class="ptab ptab--add" href="#dossier"><span aria-hidden="true">+</span> Ajouter un proche</a>' : '') + '</div>';
    }
    var lead;
    if (!c.total) lead = 'Les premières demandes partent dès que le dossier est complet.';
    else if (c.active && c.done === c.active) lead = 'Tous les courtiers ont confirmé l’effacement.' + (d.next_check_at ? ' Prochaine vérification le ' + fmtDate(d.next_check_at) + '.' : '');
    else lead = plural(c.active, 'courtier ou site suivi', 'courtiers et sites suivis') + (d.last_activity_at ? SEP + 'dernière activité le ' + fmtWhen(d.last_activity_at) : '') + '.';
    var acts = '<div class="dash-head__acts">' + (canAddSite(d) ? '<button type="button" class="btn btn--sm" id="jump-addsite"><span aria-hidden="true">+</span>' + NBSP + 'Ajouter un site</button>' : '') + '<a class="btn btn--outline btn--sm" href="#report">Rapport</a></div>';
    return tabs + '<div class="dash-head__main"><div class="dash-head__id"><p class="mono dash-eyebrow"><span>Dossier ' + fileNo(d.profile_id) + '</span><span class="live" id="dash-live" data-state="' + live.state + '">' + esc(live.text) + '</span></p><h1>' + esc(fullName(prof)) + '</h1><p class="lead">' + lead + '</p></div>' + acts + '</div>';
  }
  function sigHead(d) { var c = d.counters; return JSON.stringify([d.profile_id, d.profiles.map(function (p) { return p.id + fullName(p); }), c.total, c.done, c.active, d.next_check_at, d.last_activity_at, d.onboarding, !!d.sites, readOnly()]); }

  function nextStep(d) {
    var u = d.user, c = d.counters, o = d.onboarding, prof = currentProfile(d);
    function card(kind, title, text, action) { return '<section class="next next--' + kind + '" aria-labelledby="next-h"><span class="next__ico" aria-hidden="true">' + (kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '→') + '</span><div class="next__body"><span class="mono">' + (kind === 'ok' ? 'Tout est en ordre' : kind === 'warn' ? 'Action requise' : 'Prochaine étape') + '</span><h2 id="next-h">' + title + '</h2><p>' + text + '</p></div>' + (action ? '<div class="next__act">' + action + '</div>' : '') + '</section>'; }
    if (!o.profile_complete) return card('todo', 'Complétez les informations de ' + esc(fullName(prof)), 'Un prénom et un nom suffisent pour commencer' + NBSP + '; chaque e-mail, numéro ou adresse ajouté aide à retrouver les fiches.', '<a class="btn" href="#dossier">Compléter le dossier</a>');
    if (!o.mandate) return card('todo', u.mandate_revoked_at ? 'Le mandat a été révoqué' : 'Signez le mandat', 'Sans mandat, nous ne pouvons pas écrire aux courtiers en votre nom. Il se signe en trente secondes et reste révocable.', '<a class="btn" href="#dossier">Signer le mandat</a>');
    // Abonnement inactif : paiement en attente, résilié (accès jusqu'à la fin de période), terminé (date passée, y compris un
    // abonnement offert par clé que le balayage n'a pas encore clos) ou jamais souscrit.
    var st = u.subscription_status, ends = u.subscription_ends_at, keyed = u.billing_mode === 'key', past = !!ends && Date.parse(ends) <= Date.now();
    if (!o.subscription) {
      var ended = st === 'canceled' ? !ends || past : keyed && past;
      // Résilié mais payé jusqu'à une date future : le service continue, une vérification demandée passe d'abord.
      if (!(st === 'canceled' && !ended && c.action_required)) return card('todo',
        st === 'past_due' ? 'Mettez à jour votre moyen de paiement' : ended ? (keyed ? 'Votre abonnement offert est terminé' : 'Votre abonnement est terminé') : st === 'canceled' ? 'Votre abonnement est résilié' : 'Activez votre abonnement',
        st === 'past_due' ? 'Le dernier paiement a échoué. Les demandes reprennent dès que le paiement est régularisé.'
          : ended ? (ends ? 'Il a pris fin le ' + fmtDate(ends) + NBSP + ': plus' : 'Plus') + ' aucune demande ni relance ne part. ' + (keyed ? 'Choisissez une offre ou activez une nouvelle clé' : 'Choisissez une offre') + ' pour reprendre la surveillance.'
          : st === 'canceled' ? 'Les demandes en cours continuent jusqu’au ' + fmtDate(ends) + ', puis plus aucune relance ne partira.'
          : 'Les demandes partent dès que l’abonnement est actif.',
        '<a class="btn" href="#billing">' + (ended || st === 'none' ? 'Choisir une offre' : 'Voir l’abonnement') + '</a>');
    }
    if (!c.total) return card('todo', 'Tout est prêt, les demandes partent', 'Les ' + c.brokers + NBSP + 'courriers de la première vague partent automatiquement dans la minute. Vous pouvez aussi lancer l’envoi tout de suite.', readOnly() ? '' : '<button class="btn" type="button" id="launch">Lancer les demandes</button>');
    if (c.action_required) return card('warn', plural(c.action_required, 'courtier attend', 'courtiers attendent') + ' une vérification de votre part', 'Ils demandent un lien de confirmation ou une pièce d’identité partielle, transmis par e-mail. Suivez l’e-mail, puis cliquez sur «' + NBSP + 'Vérification faite' + NBSP + '» sur la ligne du courtier.', '<button class="btn" type="button" data-filter="action_required">Voir les demandes</button>');
    if (keyed && ends && Date.parse(ends) - Date.now() < 7 * 864e5) return card('todo', 'Votre abonnement offert se termine le ' + fmtDate(ends), 'Ensuite, plus aucune demande ni relance ne partira. Choisissez une offre ou activez une nouvelle clé pour continuer sans interruption.', '<a class="btn" href="#billing">Voir l’abonnement</a>');
    if (c.refused) {
      var nx = d.requests.filter(function (r) { return r.status === 'refused' && r.next_check_at; }).map(function (r) { return r.next_check_at; }).sort()[0];
      return card('warn', plural(c.refused, 'courtier refuse', 'courtiers refusent') + ' l’effacement', 'Une nouvelle demande partira automatiquement' + (nx ? ' le ' + fmtDate(nx) : '') + '. Vous pouvez aussi déposer une plainte auprès de l’autorité de protection des données' + NBSP + ': le texte est prêt dans le détail de chaque refus.', '<button class="btn btn--outline" type="button" data-filter="refused">Voir les refus</button>');
    }
    if (c.active && c.done === c.active) return card('ok', 'Tous les courtiers ont confirmé l’effacement', 'Nous revérifions chaque courtier tous les 60' + NBSP + 'à' + NBSP + '90' + NBSP + 'jours et renvoyons une demande si vos données réapparaissent.' + (d.next_check_at ? ' Prochaine vérification le ' + fmtDate(d.next_check_at) + '.' : ''), '');
    return '';
  }
  function sigNext(d) { var c = d.counters, u = d.user; return JSON.stringify([d.onboarding, c.total, c.action_required, c.refused, c.done, c.active, u.subscription_status, u.subscription_ends_at, u.billing_mode, u.mandate_revoked_at, d.next_check_at, readOnly(), d.requests.filter(function (r) { return r.status === 'refused'; }).map(function (r) { return r.next_check_at; }).join()]); }

  /* Synthèse : anneau des statuts (exposition au centre), tuiles qui filtrent la liste, frise du cycle légal. */
  var PART = { done: 'effacées', action_required: 'en attente de votre vérification', in_progress: 'en attente de réponse', queued: 'à envoyer', stopped: 'arrêtées (mandat révoqué)', refused: 'refusées' };
  function donut(d) {
    var c = d.counters, total = c.active || 0, R = 62, C = 2 * Math.PI * R, off = 0, segs = '';
    var parts = [['done', c.done], ['action_required', c.action_required], ['in_progress', c.in_progress], ['queued', c.queued + (c.error || 0)], ['stopped', c.stopped || 0], ['refused', c.refused]].filter(function (p) { return p[1] > 0; });
    var gap = parts.length > 1 ? 3 : 0;
    if (total) parts.forEach(function (p) {
      var len = C * p[1] / total, dash = Math.max(0.5, len - gap);
      segs += '<circle class="donut__seg donut__seg--' + p[0] + '" cx="80" cy="80" r="' + R + '" stroke-dasharray="' + dash.toFixed(2) + ' ' + (C - dash).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '"/>'; off += len;
    });
    var label = 'Exposition estimée' + NBSP + ': ' + (total ? d.exposure + NNBSP + '%. ' + parts.map(function (p) { return p[1] + NBSP + PART[p[0]]; }).join(', ') + ', sur ' + total + '.' : 'pas encore de demande.');
    return '<svg class="donut" viewBox="0 0 160 160" role="img" aria-label="' + esc(label) + '"><circle class="donut__track" cx="80" cy="80" r="' + R + '"/><g transform="rotate(-90 80 80)">' + segs + '</g><text class="donut__n" x="80" y="80">' + (total ? d.exposure + NNBSP + '%' : '—') + '</text><text class="donut__l" x="80" y="104">exposition</text></svg>';
  }
  function scoreText(d) {
    var c = d.counters, total = c.active || 0, hist = d.exposure_history || [], first = hist.length ? hist[0].exposure : d.exposure, delta = d.exposure - first;
    var trend = !c.total ? '' : delta < 0 ? '<span class="trend trend--down">−' + Math.abs(delta) + NNBSP + 'pts en 12' + NBSP + 'semaines</span>' : delta > 0 ? '<span class="trend trend--up">+' + delta + NNBSP + 'pts en 12' + NBSP + 'semaines</span>' : '<span class="trend">Stable sur 12' + NBSP + 'semaines</span>';
    var title = !c.total ? 'Votre dossier est prêt' : c.done === total ? 'Tous les effacements sont confirmés' : !c.done ? 'Demandes en cours chez ' + plural(total, 'courtier', 'courtiers') : plural(c.done, 'effacement confirmé', 'effacements confirmés') + ' sur ' + total;
    return '<div class="ov__txt"><p class="mono">Exposition estimée</p><h2 class="ov__title" id="ov-h">' + title + '</h2><p class="ov__sub">L’exposition est la part des courtiers qui n’ont pas encore confirmé l’effacement de vos données.</p>' + trend + '</div>';
  }
  function tiles(d) {
    var c = d.counters, open = c.in_progress + c.queued + (c.error || 0);
    var defs = [
      ['done', 'Effacées', c.done, c.done ? 'confirmées par écrit' : 'aucune pour l’instant'],
      ['in_progress', 'En cours', open, d.next_due_at ? 'première échéance le ' + fmtDay(d.next_due_at) : c.queued ? plural(c.queued, 'envoi imminent', 'envois imminents') : 'aucune en attente'],
      ['action_required', 'Action requise', c.action_required, c.action_required ? 'une vérification vous attend' : 'rien à faire'],
      ['refused', 'Refusées', c.refused, c.refused ? 'nouvelle demande programmée' : 'aucun refus'],
    ];
    return defs.map(function (t) {
      var inner = '<span class="tile__top"><i class="tile__k tile__k--' + t[0] + '" aria-hidden="true"></i><span class="tile__l">' + t[1] + '</span></span><span class="tile__n num">' + t[2] + '</span><span class="tile__s">' + t[3] + '</span>';
      return t[2] ? '<button type="button" class="tile tile--' + t[0] + '" data-filter="' + t[0] + '">' + inner + '<span class="vh">' + NBSP + ': afficher ces demandes</span></button>' : '<div class="tile tile--' + t[0] + ' tile--zero">' + inner + '</div>';
    }).join('');
  }
  function cycleHtml(d) {
    var c = d.counters, u = d.user, reqs = d.requests, sent = reqs.filter(function (r) { return r.sent_at; });
    var first = sent.map(function (r) { return r.sent_at; }).sort()[0], follow = reqs.filter(function (r) { return r.followup_sent_at; });
    var pendingFollow = follow.filter(function (r) { return r.status === 'sent' || r.status === 'in_progress'; }).length, toSend = c.queued + (c.error || 0);
    var steps = [
      ['Mandat signé', u.mandate_signed_at ? 'le ' + fmtDay(u.mandate_signed_at) : 'à signer', u.mandate_signed_at && !u.mandate_revoked_at ? 'done' : 'current'],
      ['Demandes envoyées', !c.total ? 'en préparation' : sent.length + ' sur ' + c.active + (first ? SEP + 'dès le ' + fmtDay(first) : ''), !c.total ? 'todo' : toSend ? 'current' : 'done'],
      ['Réponses des courtiers', c.in_progress ? 'première échéance le ' + fmtDay(d.next_due_at) : sent.length ? 'toutes reçues' : 'un mois pour répondre', c.in_progress ? 'current' : sent.length ? 'done' : 'todo'],
      ['Relances', follow.length ? plural(follow.length, 'relance envoyée', 'relances envoyées') : 'à l’échéance, si besoin', pendingFollow ? 'current' : follow.length ? 'done' : 'todo'],
      ['Revérification', d.next_check_at ? 'le ' + fmtDay(d.next_check_at) : 'tous les 60 à 90' + NBSP + 'jours', c.active && c.done === c.active ? 'current' : 'todo'],
    ];
    var cur = false;
    return '<ol class="cycle" aria-label="Étapes du dossier">' + steps.map(function (s) {
      var aria = s[2] === 'current' && !cur ? ' aria-current="step"' : ''; if (aria) cur = true;
      return '<li class="cycle__step is-' + s[2] + '"' + aria + '><span class="cycle__dot" aria-hidden="true"></span><span class="cycle__t">' + s[0] + '</span><span class="cycle__d">' + s[1] + '</span><span class="vh">' + (s[2] === 'done' ? ' (terminé)' : s[2] === 'current' ? ' (en cours)' : ' (à venir)') + '</span></li>';
    }).join('') + '</ol>';
  }
  function overview(d) { return '<div class="ov__score">' + donut(d) + scoreText(d) + '</div><div class="ov__tiles">' + tiles(d) + '</div>' + cycleHtml(d); }
  function sigOverview(d) { return JSON.stringify([d.counters, d.exposure, (d.exposure_history || [])[0], d.next_due_at, d.next_check_at, d.user.mandate_signed_at, d.user.mandate_revoked_at, d.requests.map(function (r) { return (r.sent_at ? 1 : 0) + (r.followup_sent_at ? 2 : 0); }).join(''), d.requests.map(function (r) { return r.sent_at || ''; }).sort()[0]]); }

  /* Liste des courtiers et sites */
  function filterDefs(d) {
    var c = d.counters;
    var f = [['all', 'Tous', c.active], ['action_required', 'Action requise', c.action_required], ['in_progress', 'En cours', c.in_progress + c.queued + (c.error || 0)], ['done', 'Effacées', c.done]];
    if (c.refused) f.push(['refused', 'Refusées', c.refused]);
    if (d.sites && d.sites.count) f.push(['sites', 'Sites ajoutés', d.sites.count]);
    return f;
  }
  function filtersHtml(d) { return filterDefs(d).map(function (f) { return '<button type="button" aria-pressed="' + (state.filter === f[0]) + '" data-filter="' + f[0] + '">' + f[1] + '<b>' + f[2] + '</b></button>'; }).join(''); }
  function toolsHtml() {
    return '<div class="tools__search"><label class="vh" for="broker-search">Rechercher un courtier, un site ou une catégorie</label><input type="search" id="broker-search" placeholder="Rechercher…" value="' + esc(state.search) + '" autocomplete="off" aria-keyshortcuts="/"><kbd class="tools__kbd" aria-hidden="true">/</kbd></div>' +
      '<div class="tools__sort"><label for="broker-sort" class="vh">Trier la liste</label><select id="broker-sort">' + [['status', 'Par statut'], ['sensitivity', 'Par sensibilité'], ['name', 'Par nom'], ['date', 'Par date']].map(function (o) { return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
  }
  function matchesFilter(r) { return state.filter === 'all' || (state.filter === 'sites' ? !!r.custom : state.filter === 'in_progress' ? /^(sent|in_progress|queued|error)$/.test(r.status) : r.status === state.filter); }
  function visibleRequests(d) {
    var s = state.search.trim().toLowerCase();
    var list = d.requests.filter(matchesFilter).filter(function (r) { return !s || (r.broker + ' ' + r.category + ' ' + (r.domain || '')).toLowerCase().indexOf(s) >= 0; });
    var dateOf = function (r) { return r.completed_at || r.sent_at || r.created_at || ''; };
    var rank = function (r) { return r.status === 'action_required' ? 0 : r.complaint ? 1 : { error: 2, in_progress: 3, sent: 4, queued: 5, stopped: 6, refused: 6, done: 7 }[r.status]; };
    if (state.sort === 'status') list.sort(function (a, b) { return rank(a) - rank(b) || b.sensitivity - a.sensitivity || a.broker.localeCompare(b.broker, 'fr'); });
    else if (state.sort === 'sensitivity') list.sort(function (a, b) { return b.sensitivity - a.sensitivity || a.broker.localeCompare(b.broker, 'fr'); });
    else if (state.sort === 'name') list.sort(function (a, b) { return a.broker.localeCompare(b.broker, 'fr'); });
    else if (state.sort === 'date') list.sort(function (a, b) { return dateOf(b).localeCompare(dateOf(a)) || a.broker.localeCompare(b.broker, 'fr'); });
    return list;
  }
  function emptyRows(d) {
    var c = d.counters;
    if (!d.requests.length) return '<div class="empty empty--state"><span class="mono">Aucune demande pour l’instant</span><p>' + (onboardingDone() ? 'Les ' + c.brokers + NBSP + 'premiers courriers partent automatiquement dans la minute.' : 'Les demandes partent d’elles-mêmes une fois le dossier complet' + NBSP + ': informations, mandat signé et abonnement actif.') + '</p>' + (onboardingDone() ? '' : '<a class="btn btn--outline btn--sm" href="#onboarding">Terminer les étapes</a>') + '</div>';
    if (state.search.trim()) return '<div class="empty empty--state"><p>Aucun courtier ne correspond à «' + NBSP + esc(state.search.trim()) + NBSP + '».</p><button type="button" class="btn btn--outline btn--sm" id="search-clear">Effacer la recherche</button></div>';
    if (state.filter === 'action_required') return '<div class="empty empty--state"><span class="mono">Rien à faire</span><p>Aucun courtier n’attend de vérification de votre part.</p></div>';
    if (state.filter === 'done') return '<div class="empty empty--state"><span class="mono">Pas encore de confirmation</span><p>Les courtiers ont un mois (RGPD) ou 45' + NBSP + 'jours (CCPA) pour répondre' + NBSP + '; nous relançons à l’échéance.</p></div>';
    if (state.filter === 'in_progress') return '<div class="empty empty--state"><span class="mono">Aucune demande en cours</span><p>' + (c.active && c.done === c.active ? 'Tous les courtiers ont confirmé l’effacement.' : 'Rien en attente de réponse.') + '</p></div>';
    return '<div class="empty empty--state"><p>Aucune demande dans cette catégorie.</p></div>';
  }
  function whenHtml(r) {
    if (r.status === 'done') return '<span>Effacée le ' + fmtDay(r.completed_at) + '</span><small>' + (r.next_check_at ? 'revérification le ' + fmtDay(r.next_check_at) : basisLabel(r)) + '</small>';
    if (r.status === 'stopped') return '<span>Demande arrêtée</span><small>mandat révoqué</small>';
    if (r.status === 'refused') return '<span>Refus du courtier</span><small>' + (r.next_check_at ? 'nouvelle demande le ' + fmtDay(r.next_check_at) : basisLabel(r)) + '</small>';
    if (r.status === 'action_required') return '<span>Vérification à faire</span><small>' + (r.sent_at ? 'demande du ' + fmtDay(r.sent_at) : basisLabel(r)) + '</small>';
    if (r.status === 'error') return '<span>Envoi en attente</span><small>contact en cours de vérification</small>';
    if (r.sent_at) return '<span>' + (r.due_at ? 'Réponse due le ' + fmtDay(r.due_at) : 'Envoyée le ' + fmtDay(r.sent_at)) + '</span><small>' + (r.followup_sent_at ? 'relancée le ' + fmtDay(r.followup_sent_at) : 'envoyée le ' + fmtDay(r.sent_at)) + '</small>';
    return '<span>' + (r.custom && r.site && r.site.status === 'searching' ? 'Recherche du contact' : 'Envoi imminent') + '</span><small>' + basisLabel(r) + (r.cycle > 1 ? SEP + 'cycle ' + r.cycle : '') + '</small>';
  }
  function rowNote(r) {
    var ro = readOnly();
    if (r.status === 'action_required') {
      var what = r.note && r.note !== 'Le courtier demande une vérification.' ? esc(typo(r.note)).replace(/([^.!?…])$/, '$1.') + ' ' : '';
      return '<div class="row__note row__note--warn"><p>' + what + 'Suivez les instructions reçues par e-mail (objet «' + NBSP + 'Action requise' + NBSP + '»), puis confirmez ici.</p>' + (ro ? '' : '<button class="btn btn--xs" type="button" data-resolve="' + esc(r.id) + '">Vérification faite<span class="vh"> pour ' + esc(r.broker) + '</span></button>') + '</div>';
    }
    if (r.complaint) return '<div class="row__note row__note--danger"><p>' + (r.status === 'refused' ? 'Plainte prête à déposer' + (r.next_check_at ? SEP + 'nouvelle demande le ' + fmtDate(r.next_check_at) : '') : 'Relance restée sans réponse' + NBSP + ': plainte prête à déposer') + '.</p><button class="btn btn--xs btn--outline" type="button" data-open="' + esc(r.id) + '" data-section="complaint" aria-haspopup="dialog">Préparer la plainte<span class="vh"> contre ' + esc(r.broker) + '</span></button></div>';
    if (r.custom || r.source_url) return siteNote(r);
    return '';
  }
  // Site ajouté par l'abonné : où en est le contact, et lien vers la fiche signalée.
  function siteNote(r) {
    var s = r.site || {}, txt = '', contact = s.contact ? esc(s.contact) : '';
    if (r.custom && (r.status === 'queued' || r.status === 'error')) txt = s.status === 'searching' ? 'Recherche du contact sur le site…' : s.status === 'review' ? 'Notre équipe vérifie le contact avant l’envoi.' : s.status === 'found' ? 'Contact publié par le site' + NBSP + ': ' + contact : s.status === 'presumed' ? 'Envoi à l’adresse présumée ' + contact : '';
    else if (r.custom && r.status !== 'done') txt = s.status === 'found' ? 'Contact publié par le site' + NBSP + ': ' + contact : s.status === 'presumed' || s.status === 'review' ? 'Adresse présumée' + NBSP + ': ' + contact : '';
    var link = r.source_url ? '<a class="row__url" href="' + esc(r.source_url) + '" target="_blank" rel="noopener noreferrer">Fiche signalée<span class="vh"> (nouvel onglet)</span></a>' : '';
    return txt || link ? '<p class="row__note row__note--site">' + (txt ? '<span>' + txt + '</span>' : '') + link + '</p>' : '';
  }
  function rowHtml(r) {
    var meta = dots(r.sensitivity) + '<span>' + esc(r.category) + '</span>' + (r.domain && r.domain !== r.broker ? '<span class="row__dom">' + esc(r.domain) + '</span>' : '');
    return '<li class="row row--' + esc(r.status) + '" data-row="' + esc(r.id) + '">' + mark(r.broker, r.category) +
      '<div class="row__who"><button type="button" class="row__open" data-open="' + esc(r.id) + '" aria-haspopup="dialog">' + esc(r.broker) + '<span class="vh">' + NBSP + ': voir le détail</span></button><small>' + meta + '</small></div>' +
      '<div class="row__status">' + chip(r.status) + '</div><div class="row__when">' + whenHtml(r) + '</div><span class="row__chev" aria-hidden="true"></span>' + rowNote(r) + '</li>';
  }
  function rowsHtml(d) {
    var all = visibleRequests(d), list = all.slice(0, state.page * PAGE);
    if (!all.length) return emptyRows(d);
    return '<div class="row row--head" aria-hidden="true"><span></span><span>Courtier</span><span>Statut</span><span>Suivi</span><span></span></div><ol class="rows__list" role="list">' + list.map(rowHtml).join('') + '</ol>' +
      (all.length > list.length ? '<div class="rows__more"><button type="button" class="btn btn--outline btn--sm" id="rows-more">Afficher plus</button><span class="mono mono--plain">' + list.length + ' sur ' + all.length + '</span></div>' : (all.length > PAGE ? '<div class="rows__more"><span class="mono mono--plain">' + all.length + ' sur ' + all.length + '</span></div>' : ''));
  }
  function rowSig(r) { return [r.id, r.status, r.note, r.sent_at, r.due_at, r.completed_at, r.next_check_at, r.followup_sent_at, r.cycle, r.source_url, r.complaint, r.site ? r.site.status + r.site.contact : ''].join('|'); }
  function sigRows(d) { return d.requests.map(rowSig).join(';') + '#' + [state.filter, state.search, state.sort, state.page, readOnly()].join('|'); }

  /* Activité : groupée par jour ; une rafale d'événements du même type (envois, confirmations…) tient en une ligne. */
  var FEED_GROUPS = { sent: ['demande d’effacement envoyée', 'demandes d’effacement envoyées'], done: ['effacement confirmé', 'effacements confirmés'], followup: ['relance envoyée', 'relances envoyées'], recheck: ['nouvelle demande', 'nouvelles demandes'], in_progress: ['accusé de réception', 'accusés de réception'] };
  function dayKey(iso) { var t = new Date(iso); return t.getFullYear() + '-' + t.getMonth() + '-' + t.getDate(); }
  function dayLabel(iso) {
    var t = new Date(iso), n = new Date(), diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
    if (diff === 0) return 'Aujourd’hui';
    if (diff === 1) return 'Hier';
    var s = t.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function feedEntries(d) {
    var names = {}, groups = [], out = [];
    d.requests.forEach(function (r) { names[r.id] = r.broker; });
    (d.events || []).forEach(function (e) {
      var g = groups[groups.length - 1], k = dayKey(e.created_at);
      if (g && FEED_GROUPS[e.type] && g.type === e.type && g.day === k) g.items.push(e); else groups.push({ type: e.type, day: k, items: [e] });
    });
    groups.forEach(function (g) {
      if (g.items.length < 3) { g.items.forEach(function (e) { out.push({ type: e.type, at: e.created_at, html: esc(typo(e.message)) }); }); return; }
      var who = [], n = g.items.length, lbl = FEED_GROUPS[g.type];
      g.items.forEach(function (e) { var nm = names[e.request_id]; if (nm && who.indexOf(nm) < 0) who.push(nm); });
      var shown = who.slice(0, 3), rest = n - shown.length;
      out.push({ type: g.type, at: g.items[0].created_at, html: '<b>' + n + NBSP + lbl[1] + '</b>' + (shown.length ? NBSP + ': ' + shown.map(esc).join(', ') + (rest > 0 ? ' et ' + plural(rest, 'autre', 'autres') : '') : '') + '.' });
    });
    return out;
  }
  function journalHtml(d) {
    var all = feedEntries(d), list = state.journalAll ? all : all.slice(0, JOURNAL), html = '', day = null;
    if (!all.length) return '<p class="empty empty--sm">Rien pour l’instant.</p>';
    list.forEach(function (x) {
      var k = dayKey(x.at);
      if (k !== day) { if (day !== null) html += '</ol>'; day = k; html += '<h3 class="feed__day">' + dayLabel(x.at) + '</h3><ol class="feed" role="list">'; }
      html += '<li class="feed__item t-' + esc(x.type) + '"><time datetime="' + esc(x.at) + '">' + new Date(x.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '</time><p>' + x.html + '</p></li>';
    });
    return '<div id="timeline">' + html + '</ol></div>' + (all.length > JOURNAL ? '<div class="sheet__more"><button type="button" class="btn btn--text" id="journal-toggle" aria-expanded="' + state.journalAll + '" aria-controls="timeline">' + (state.journalAll ? 'Réduire' : 'Tout afficher (' + all.length + ')') + '</button></div>' : '');
  }
  function sigJournal(d) { return (d.events || []).map(function (e) { return e.id; }).join(',') + '#' + state.journalAll + '#' + dayKey(new Date().toISOString()); }

  /* Ajouter un site (colonne latérale) */
  function siteCount(d) { return plural(d.sites.count, 'site ajouté', 'sites ajoutés') + ' sur ' + d.sites.max + ' pour ce profil'; }
  function addSiteHtml(d) {
    if (!canAddSite(d)) return '';
    return '<section class="sheet addsite" id="addsite" aria-labelledby="addsite-h"><div class="addsite__head"><span class="addsite__ico" aria-hidden="true">+</span><div><h2 id="addsite-h">Un site manque' + NBSP + '?</h2><p>Collez l’adresse de la page où apparaissent vos informations' + NBSP + ': nous trouvons le contact et la demande part toute seule.</p></div></div>' +
      '<form id="addsite-form" class="addsite__form" novalidate><div class="f"><label for="addsite-url">Adresse de la page</label><input id="addsite-url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://exemple.fr/fiche/votre-nom" required></div><button class="btn btn--block" type="submit">Demander l’effacement</button>' + msgEl('msg-addsite-form') + '</form><p class="mono mono--plain addsite__count" id="addsite-count">' + siteCount(d) + '</p></section>';
  }

  /* Analyse : exposition dans le temps, répartition par catégorie et par sensibilité */
  var SENS_SHORT = { 3: 'Élevée', 2: 'Moyenne', 1: 'Faible' };
  function barHtml(b, label) {
    var t = b.total || 0, rest = t - b.done - b.action_required - b.refused, parts = [];
    function seg(k, n) { return n ? '<i class="bar__seg bar__seg--' + k + '" style="width:' + (n / t * 100).toFixed(2) + '%"></i>' : ''; }
    if (b.done) parts.push(plural(b.done, 'effacée', 'effacées'));
    if (b.action_required) parts.push(b.action_required + NBSP + 'en attente de vérification');
    if (b.refused) parts.push(plural(b.refused, 'refus', 'refus'));
    if (rest > 0) parts.push(rest + NBSP + 'en cours');
    return '<div class="bar" role="img" aria-label="' + esc(label) + NBSP + ': ' + (parts.length ? esc(parts.join(', ')) : 'aucune demande') + ' sur ' + t + '">' + seg('done', b.done) + seg('action_required', b.action_required) + seg('refused', b.refused) + '</div>';
  }
  function catsHtml(d) {
    var cats = d.categories || [], list = state.catsAll ? cats : cats.slice(0, 6);
    if (!cats.length) return '<p class="empty empty--sm">La répartition apparaîtra après la première vague.</p>';
    return '<ul class="cats" role="list">' + list.map(function (b) { return '<li class="cat"><div class="cat__head"><span class="cat__name">' + esc(b.category) + '</span><span class="cat__n num"><b>' + b.done + '</b>' + NNBSP + '/' + NNBSP + b.total + '</span></div>' + barHtml(b, b.category) + '</li>'; }).join('') + '</ul>' +
      (cats.length > 6 ? '<button type="button" class="btn btn--text cats__more" id="cats-toggle" aria-expanded="' + !!state.catsAll + '">' + (state.catsAll ? 'Réduire' : 'Afficher les ' + cats.length + ' catégories') + '</button>' : '');
  }
  function insight(d) {
    var hist = d.exposure_history || [], c = d.counters, first = hist.length ? hist[0].exposure : 100, delta = d.exposure - first;
    var table = hist.length ? '<table class="vh"><caption>Exposition par semaine</caption><thead><tr><th scope="col">Semaine du</th><th scope="col">Exposition</th></tr></thead><tbody>' + hist.map(function (p) { return '<tr><td>' + fmtDate(p.week_start) + '</td><td>' + p.exposure + NNBSP + '%</td></tr>'; }).join('') + '</tbody></table>' : '';
    var chart = '<section class="sheet chart-card" aria-labelledby="exp-h"><div class="card-head"><div><h2 id="exp-h">Évolution de l’exposition</h2><p class="mono">12 dernières semaines</p></div><p class="chart-card__now"><b class="num">' + (c.total ? d.exposure + NNBSP + '%' : '—') + '</b><span>' + (!c.total ? 'avant la première vague' : delta < 0 ? '−' + Math.abs(delta) + NNBSP + 'pts' : delta > 0 ? '+' + delta + NNBSP + 'pts' : 'stable') + '</span></p></div><div class="chart" id="exp-chart"></div>' + table + '</section>';
    var legend = '<ul class="legend" role="list"><li><i class="legend__k legend__k--done"></i>Effacées</li><li><i class="legend__k legend__k--action_required"></i>Vérification</li>' + (c.refused ? '<li><i class="legend__k legend__k--refused"></i>Refus</li>' : '') + '<li><i class="legend__k legend__k--rest"></i>En cours</li></ul>';
    var sens = (d.sensitivity || []).filter(function (b) { return b.total; });
    var sensHtml = sens.length && c.total ? '<h3 class="mono insight__sub">Par sensibilité</h3><div class="sens-tiles">' + sens.map(function (b) { return '<div class="stile">' + dots(b.level) + '<span class="stile__l">' + SENS_SHORT[b.level] + '</span><span class="stile__n num"><b>' + b.done + '</b>' + NNBSP + '/' + NNBSP + b.total + '</span></div>'; }).join('') + '</div>' : '';
    var cats = '<section class="sheet cats-card" aria-labelledby="cat-h"><div class="card-head"><div><h2 id="cat-h">Par catégorie</h2><p class="mono">effacées / suivies</p></div>' + legend + '</div><div class="cats-card__body"><div id="dash-cats">' + catsHtml(d) + '</div>' + sensHtml + '</div></section>';
    return chart + cats;
  }
  function sigInsight(d) { return JSON.stringify([d.exposure_history, d.categories, d.sensitivity, d.exposure, d.counters.total, d.counters.refused, !!state.catsAll]); }

  function drawChart() {
    var host = $('#exp-chart'), d = state.dash; if (!host || !d) return;
    var pts = d.exposure_history || [];
    if (pts.length < 2 || !d.counters.total) { host.innerHTML = '<p class="empty empty--sm">L’historique apparaîtra après la première vague.</p>'; return; }
    var W = Math.max(260, Math.floor(host.clientWidth || 600)), H = 200, L = 40, R = 52, T = 16, B = 28, n = pts.length;
    var x = function (i) { return L + (W - L - R) * i / (n - 1); }, y = function (v) { return T + (H - T - B) * (1 - v / 100); };
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.exposure).toFixed(1); }).join(' ');
    var area = path + ' L' + x(n - 1).toFixed(1) + ' ' + y(0).toFixed(1) + ' L' + x(0).toFixed(1) + ' ' + y(0).toFixed(1) + ' Z';
    var grid = [0, 50, 100].map(function (v) { return '<line class="chart__grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text class="chart__lbl" x="' + (L - 10) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + v + (v ? NNBSP + '%' : '') + '</text>'; }).join('');
    var xl = [0, Math.round((n - 1) / 3), Math.round(2 * (n - 1) / 3), n - 1].map(function (i) { return '<text class="chart__lbl" x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + fmtDay(pts[i].week_start) + '</text>'; }).join('');
    var last = pts[n - 1], ex = x(n - 1), ey = y(last.exposure);
    var end = '<circle class="chart__end" cx="' + ex.toFixed(1) + '" cy="' + ey.toFixed(1) + '" r="4.5"/><text class="chart__val" x="' + (ex + 10).toFixed(1) + '" y="' + (ey + 4).toFixed(1) + '">' + last.exposure + NNBSP + '%</text>';
    var summary = 'Exposition sur 12 semaines' + NBSP + ': de ' + pts[0].exposure + NNBSP + '% (semaine du ' + fmtDay(pts[0].week_start) + ') à ' + last.exposure + NNBSP + '% aujourd’hui.';
    host.innerHTML = '<svg class="chart__svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" tabindex="0" aria-label="' + esc(summary) + ' Flèches gauche et droite pour parcourir les semaines."><defs><linearGradient id="exp-fill" x1="0" y1="0" x2="0" y2="1"><stop class="chart__stop" offset="0"/><stop class="chart__stop chart__stop--end" offset="1"/></linearGradient></defs><path class="chart__area" d="' + area + '"/>' + grid + '<path class="chart__line" d="' + path + '"/><line class="chart__cross" y1="' + T + '" y2="' + y(0).toFixed(1) + '" hidden/><circle class="chart__hover" r="4.5" hidden/>' + end + xl + '</svg><div class="chart__tip" role="status" aria-live="polite" hidden></div>';
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
      tip.hidden = false; var left = p.x / host._size.W * 100; tip.style.left = left + '%'; tip.classList.toggle('is-right', left > 70); tip.classList.toggle('is-left', left < 18);
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

  /* ---------- tiroir de détail d'une demande (<dialog> modal) ---------- */
  var drawer = $('#drawer'), drawerFor = null, drawerSig = null, drawerTrigger = null, complaintText = '';
  function statusSentence(r) {
    var ccpa = r.legal_basis === 'ccpa', motive = r.note && !/^(Refus du courtier|réponse reçue de|Mandat révoqué)/i.test(r.note) ? r.note : '';
    switch (r.status) {
      case 'queued': return r.custom && r.site && r.site.status === 'searching' ? 'Nous cherchons le contact du site' + NBSP + '; la demande part dès qu’il est connu.' : r.custom && r.site && r.site.status === 'review' ? 'Notre équipe vérifie l’adresse de contact du site avant l’envoi.' : 'La demande est prête' + NBSP + ': elle part dans la minute.';
      case 'stopped': return 'Demande arrêtée avant son envoi' + NBSP + ': vous avez révoqué le mandat. Elle repartira dans un nouveau cycle dès que vous le signerez de nouveau.';
      case 'error': return 'L’envoi a échoué plusieurs fois' + NBSP + ': notre équipe vérifie l’adresse du courtier, puis la demande repart.';
      case 'sent': return 'Le courtier a jusqu’au ' + fmtDate(r.due_at) + ' pour répondre (' + (ccpa ? '45' + NBSP + 'jours, CCPA' : 'un mois, article' + NBSP + '12 du RGPD') + '). Sans réponse, nous le relançons.';
      case 'in_progress': return r.followup_sent_at ? 'Délai légal dépassé' + NBSP + ': nous avons relancé le courtier le ' + fmtDate(r.followup_sent_at) + (r.complaint ? '. Sans réponse depuis, vous pouvez déposer une plainte.' : '.') : 'Le courtier traite la demande' + (r.due_at ? NBSP + '; réponse attendue avant le ' + fmtDate(r.due_at) : '') + '.';
      case 'action_required': return 'Le courtier demande une vérification avant d’effacer vos données' + (r.note && r.note !== 'Le courtier demande une vérification.' ? ' (' + esc(typo(r.note)) + ')' : '') + '. Suivez les instructions reçues par e-mail, puis confirmez ici.';
      case 'done': return 'Effacement confirmé le ' + fmtDate(r.completed_at) + '. ' + (r.next_check_at ? 'Nous revérifierons le ' + fmtDate(r.next_check_at) + ' et renverrons une demande si vos données réapparaissent.' : 'Nous revérifions régulièrement ce courtier.');
      case 'refused': return 'Le courtier a refusé l’effacement' + (motive ? NBSP + ': «' + NBSP + esc(typo(motive)) + NBSP + '»' : '') + '. ' + (r.next_check_at ? 'Une nouvelle demande partira le ' + fmtDate(r.next_check_at) + '. ' : '') + (r.complaint ? 'Vous pouvez aussi déposer une plainte.' : '');
    }
    return '';
  }
  function requestSteps(r) {
    var answered = r.status === 'done' || r.status === 'refused', s = [];
    s.push(['Demande préparée', fmtDay(r.created_at), 'done']);
    if (r.status === 'stopped') s.push(['Envoi arrêté', 'mandat révoqué', 'skip'], ['Nouvelle demande', 'dès la nouvelle signature du mandat', 'todo']);
    else {
      s.push(['Envoyée au courtier', r.sent_at ? fmtWhen(r.sent_at) : r.status === 'error' ? 'envoi en échec' : r.custom && r.site && r.site.status === 'searching' ? 'dès que le contact est connu' : 'dans la minute', r.sent_at ? 'done' : 'current']);
      if (r.status === 'action_required') s.push(['Vérification demandée', 'à faire de votre côté', 'current']);
      s.push(['Relance', r.followup_sent_at ? fmtDay(r.followup_sent_at) : answered ? 'pas nécessaire' : r.due_at ? 'le ' + fmtDay(r.due_at) + ' sans réponse' : 'à l’échéance, si besoin', r.followup_sent_at ? 'done' : answered ? 'skip' : 'todo']);
      s.push([r.status === 'refused' ? 'Refus du courtier' : 'Effacement confirmé', r.status === 'done' ? fmtDay(r.completed_at) : r.status === 'refused' ? 'refus reçu' : r.due_at ? 'attendu avant le ' + fmtDay(r.due_at) : 'après l’envoi', r.status === 'done' ? 'done' : r.status === 'refused' ? 'bad' : r.sent_at && r.status !== 'action_required' ? 'current' : 'todo']);
      s.push([r.status === 'refused' ? 'Nouvelle demande' : 'Revérification', r.next_check_at ? 'le ' + fmtDay(r.next_check_at) : r.recheck_days ? 'tous les ' + r.recheck_days + NBSP + 'jours après l’effacement' : '—', 'todo']);
    }
    return '<ol class="steps">' + s.map(function (x) { return '<li class="steps__i is-' + x[2] + '"><span class="steps__dot" aria-hidden="true"></span><span class="steps__t">' + x[0] + '<span class="vh">' + (x[2] === 'done' ? ' (fait)' : x[2] === 'current' ? ' (en cours)' : x[2] === 'bad' ? ' (refus)' : x[2] === 'skip' ? ' (sans objet)' : ' (à venir)') + '</span></span><span class="steps__d">' + x[1] + '</span></li>'; }).join('') + '</ol>';
  }
  var JURIS = { FR: 'France', EU: 'Union européenne', UK: 'Royaume-Uni', US: 'États-Unis', CH: 'Suisse', CA: 'Canada' };
  function drawerActions(r) {
    if (readOnly()) return '';
    var a = '';
    if (r.status === 'action_required') a += '<button class="btn btn--sm" type="button" data-resolve="' + esc(r.id) + '" data-k="resolve">Vérification faite</button>';
    if (r.complaint) a += '<button class="btn btn--sm" type="button" data-complaint="' + esc(r.id) + '" data-k="complaint" aria-expanded="false" aria-controls="complaint-box">Préparer la plainte</button>';
    if (r.status === 'done' || r.status === 'refused') a += '<button class="btn btn--outline btn--sm" type="button" data-relaunch-open="' + esc(r.id) + '" data-k="relaunch" aria-expanded="false" aria-controls="relaunch-form">Mes données sont réapparues</button>';
    if (!a) return '';
    return '<div class="dact">' + a + '</div><div id="complaint-box" class="complaint" hidden></div>' +
      (r.status === 'done' || r.status === 'refused' ? '<form id="relaunch-form" class="relaunch" data-id="' + esc(r.id) + '" novalidate hidden><p>Une nouvelle demande d’effacement part tout de suite. Si vous avez retrouvé la fiche, indiquez son adresse' + NBSP + ': elle sera citée dans le courrier.</p><div class="f"><label for="relaunch-url">Adresse de la fiche (facultatif)</label><input id="relaunch-url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://' + esc(r.domain || 'exemple.fr') + '/…"></div><button class="btn btn--sm" type="submit" data-k="relaunch-go">Envoyer une nouvelle demande</button>' + msgEl('msg-relaunch-form') + '</form>' : '');
  }
  function drawerBody(r, m) {
    var q2 = m.request;
    var facts = [['Référence', '<code>' + esc(q2.ref) + '</code><button type="button" class="btn btn--text" data-copy="' + esc(q2.ref) + '" data-k="copy">Copier<span class="vh"> la référence</span></button>'], ['Base légale', r.legal_basis === 'ccpa' ? 'CCPA' : r.legal_basis === 'both' ? 'RGPD (article' + NBSP + '17) et CCPA' : 'RGPD, article' + NBSP + '17'], ['Juridiction', esc(JURIS[r.jurisdiction] || r.jurisdiction || '—')], ['Sensibilité', dots(r.sensitivity) + ' ' + (SENS[r.sensitivity] || '')], ['Cycle', r.cycle > 1 ? 'cycle ' + r.cycle : 'premier envoi']];
    if (q2.source_url) facts.push(['Fiche signalée', '<a href="' + esc(q2.source_url) + '" target="_blank" rel="noopener noreferrer">' + esc(q2.source_url.replace(/^https?:\/\//, '')) + '<span class="vh"> (nouvel onglet)</span></a>']);
    if (r.custom && r.site && r.site.contact) facts.push(['Contact', esc(r.site.contact) + (r.site.status === 'found' ? ' (publié par le site)' : ' (adresse présumée)')]);
    var hist = m.events.length ? '<ol class="hist">' + m.events.map(function (e) { return '<li class="t-' + esc(e.type) + '"><time datetime="' + esc(e.created_at) + '">' + fmtTime(e.created_at) + '</time><span>' + esc(typo(e.message)) + '</span></li>'; }).join('') + '</ol>' : '<p class="dempty">Aucun événement pour l’instant.</p>';
    var mails = m.mails.length ? m.mails.map(function (x) { return '<details class="letter"><summary><span class="letter__s">' + esc(x.subject) + '</span><span class="letter__m">' + esc(fmtTime(x.created_at)) + SEP + 'à ' + esc(x.to_addr) + (x.mode === 'smtp' ? '' : SEP + 'boîte d’envoi locale') + '</span></summary><div class="mail-body" tabindex="0" role="region" aria-label="Courrier du ' + esc(fmtTime(x.created_at)) + '">' + esc(x.body) + '</div></details>'; }).join('') : '<p class="dempty">Pas encore de courrier envoyé.</p>';
    return '<div class="dstatus">' + chip(r.status) + '<p>' + statusSentence(r) + '</p></div>' + drawerActions(r) +
      '<section class="dsec" aria-labelledby="ds-steps"><h3 class="dsec__t" id="ds-steps">Étapes</h3>' + requestSteps(r) + '</section>' +
      '<section class="dsec" aria-labelledby="ds-facts"><h3 class="dsec__t" id="ds-facts">Informations</h3><dl class="facts">' + facts.map(function (f) { return '<div><dt>' + f[0] + '</dt><dd>' + f[1] + '</dd></div>'; }).join('') + '</dl></section>' +
      '<section class="dsec" aria-labelledby="ds-hist"><h3 class="dsec__t" id="ds-hist">Historique</h3>' + hist + '</section>' +
      '<section class="dsec" aria-labelledby="ds-mails"><h3 class="dsec__t" id="ds-mails">Courriers' + (m.mails.length ? ' (' + m.mails.length + ')' : '') + '</h3>' + mails + '</section>';
  }
  function drawerFrame(r) {
    return '<div class="drawer__inner"><header class="drawer__head">' + mark(r.broker, r.category, true) + '<div class="drawer__id"><p class="mono">' + esc(r.category) + '</p><h2 id="drawer-title" tabindex="-1" autofocus>' + esc(r.broker) + '</h2>' + (r.domain ? '<a class="drawer__domain" href="https://' + esc(r.domain) + '" target="_blank" rel="noopener noreferrer">' + esc(r.domain) + '<span class="vh"> (site du courtier, nouvel onglet)</span></a>' : '') + '</div><button type="button" class="drawer__close" data-close data-k="close" aria-label="Fermer le détail"></button></header><div class="drawer__body" id="drawer-body"><p class="dempty"><span class="spinner"></span> Chargement…</p></div></div>';
  }
  function openDrawer(id, trigger, section) {
    var r = rowById(id); if (!r || !drawer) return;
    drawerFor = id; drawerSig = null; complaintText = ''; drawerTrigger = trigger || null;
    drawer.innerHTML = drawerFrame(r);
    drawer.appendChild(toastEl); drawer.appendChild(announceEl);   // un modal rend le reste de la page inerte : les messages suivent le tiroir
    if (!drawer.open) drawer.showModal();
    var title = $('#drawer-title', drawer); if (title && document.activeElement !== title) title.focus();
    loadDrawer(id, section);
  }
  function loadDrawer(id, section, keepFocus) {
    return api('/requests/' + id + '/details').then(function (m) {
      var body = $('#drawer-body', drawer), r = rowById(id); if (drawerFor !== id || !drawer.open || !body || !r) return;
      var ae = document.activeElement, k = keepFocus && ae && body.contains(ae) ? ae.getAttribute('data-k') : null, open = $$('details[open]', body).map(function (x) { return $$('details', body).indexOf(x); });
      body.innerHTML = drawerBody(r, m); drawerSig = rowSig(r);
      $$('details', body).forEach(function (x, i) { if (open.indexOf(i) >= 0) x.open = true; });
      if (ae && !document.contains(ae)) { var f = k && $('[data-k="' + k + '"]', body); (f || $('#drawer-title', drawer)).focus(); }
      if (section === 'complaint') loadComplaint(id, true);
    }).catch(function (e) { var body = $('#drawer-body', drawer); if (body && drawerFor === id) body.innerHTML = '<p class="notice" role="alert">' + esc(e.message) + '</p>'; });
  }
  function closeDrawer() { if (drawer && drawer.open) drawer.close(); }
  // Pas de rafraîchissement du tiroir pendant une saisie ou la lecture de la plainte : on ne perd ni le texte ni la position.
  function drawerIdle() { var f = $('#relaunch-form', drawer), b = $('#complaint-box', drawer); return !(f && !f.hidden) && !(b && !b.hidden); }
  if (drawer) {
    drawer.addEventListener('close', function () {
      var id = drawerFor; drawerFor = null; drawerSig = null; complaintText = '';
      document.body.appendChild(announceEl); document.body.appendChild(toastEl);
      var t = drawerTrigger; drawerTrigger = null;
      if (!t || !document.contains(t)) t = id ? $('.row__open[data-open="' + id + '"]') : null;
      if (t) t.focus({ preventScroll: true }); else view.focus({ preventScroll: true });
    });
    drawer.addEventListener('click', function (e) { if (e.target === drawer) closeDrawer(); });   // clic sur le fond
  }
  function loadComplaint(id, scroll) {
    var box = $('#complaint-box', drawer), btn = $('[data-complaint]', drawer); if (!box) return;
    if (!box.hidden && complaintText) { box.hidden = true; if (btn) btn.setAttribute('aria-expanded', 'false'); return; }
    box.hidden = false; box.innerHTML = '<p class="dempty"><span class="spinner"></span> Rédaction de la plainte…</p>'; if (btn) { btn.setAttribute('aria-expanded', 'true'); lock(btn, true); }
    api('/requests/' + id + '/complaint').then(function (c) {
      if (drawerFor !== id) return;
      complaintText = c.subject + '\n\n' + c.text;
      var of = c.authority.name.replace(/^le /, 'du ').replace(/^les /, 'des ').replace(/^(?!du |des )/, 'de ');   // « de la CNIL », « du Préposé… »
      box.innerHTML = '<h3 class="dsec__t">Plainte auprès ' + esc(of) + '</h3><p>Rédigée en votre nom, à partir de votre dossier. Copiez-la dans le formulaire de plainte ' + esc(of) + ' et joignez la copie de la demande (section Courriers).</p><div class="mail-body" tabindex="0" role="region" aria-label="Texte de la plainte">' + esc(complaintText) + '</div><div class="btn-row"><button class="btn btn--sm" type="button" id="complaint-copy" data-k="cp-copy">Copier le texte</button><a class="btn btn--outline btn--sm" href="' + esc(c.authority.url) + '" target="_blank" rel="noopener noreferrer">Déposer la plainte (' + esc(c.authority.short) + ')<span class="vh">, site officiel, nouvel onglet</span></a></div>';
      if (scroll) box.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      announce('Texte de la plainte prêt.');
    }).catch(function (e) { box.innerHTML = '<p class="notice" role="alert">' + esc(e.message) + '</p>'; }).finally(function () { if (btn) lock(btn, false); });
  }
  function copyText(text, done) {
    function ok() { toast(done); }
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'vh';
      (drawer && drawer.open ? drawer : document.body).appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) ok(); else throw new Error(); } catch (e) { toast('Copie impossible' + NBSP + ': sélectionnez le texte et copiez-le.', true); }
      ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }

  function skeleton() {
    return '<div class="dash dash--loading" aria-busy="true"><h1 class="vh">Tableau de bord</h1><p class="vh">Chargement du tableau de bord…</p><div class="skel skel--eyebrow"></div><div class="skel skel--h1"></div><div class="skel skel--lead"></div>' +
      '<div class="sheet skel-ov"><div class="skel skel--donut"></div><div class="skel-ov__tiles"><div class="skel skel--tile"></div><div class="skel skel--tile"></div><div class="skel skel--tile"></div><div class="skel skel--tile"></div></div></div>' +
      '<div class="dash-main"><div class="sheet skel-list"><div class="skel skel--row"></div><div class="skel skel--row"></div><div class="skel skel--row"></div><div class="skel skel--row"></div><div class="skel skel--row"></div></div><div class="sheet skel-list"><div class="skel skel--row"></div><div class="skel skel--row"></div></div></div></div>';
  }
  function dashShell(d) {
    sigs = { 'dash-head': sigHead(d), 'dash-next': sigNext(d), 'dash-overview': sigOverview(d), 'dash-insight': sigInsight(d), 'dash-filters': JSON.stringify(filterDefs(d)), rows: sigRows(d), 'dash-journal': sigJournal(d) };
    return '<div class="dash" id="dash" data-profile="' + esc(d.profile_id) + '">' +
      '<header class="dash-head" id="dash-head">' + dashHead(d) + '</header>' +
      '<div id="dash-next">' + nextStep(d) + '</div>' +
      '<section class="sheet ov" id="dash-overview" aria-labelledby="ov-h">' + overview(d) + '</section>' +
      '<div class="dash-main"><section class="sheet list" aria-labelledby="brokers-h"><div class="list__head"><div class="list__title"><h2 id="brokers-h">Courtiers et sites</h2><p class="mono" id="brokers-count">' + plural(d.counters.active, 'suivi', 'suivis') + '</p></div><div class="tools" id="dash-tools">' + toolsHtml() + '</div></div>' +
      '<div class="filters" id="dash-filters" role="group" aria-label="Filtrer par statut">' + filtersHtml(d) + '</div><div class="rows" id="rows">' + rowsHtml(d) + '</div></section>' +
      '<div class="dash-side">' + addSiteHtml(d) + '<section class="sheet activity" aria-labelledby="journal-h"><div class="card-head"><h2 id="journal-h">Activité</h2>' + (readOnly() ? '' : '<a class="btn btn--text" href="/api/export" target="_blank" rel="noopener">Exporter<span class="vh"> le dossier (JSON, nouvel onglet)</span></a>') + '</div><div id="dash-journal">' + journalHtml(d) + '</div></section></div></div>' +
      '<div class="dash-analysis" id="dash-insight">' + insight(d) + '</div></div>';
  }
  views.dashboard = function () { return state.dash ? dashShell(state.dash) : skeleton(); };

  /* Mise à jour en place : chaque zone n'est remplacée que si son contenu a changé et si le focus n'y est pas. */
  function patch(id, html, sig) {
    var el = document.getElementById(id); if (!el) return false;
    if (sigs[id] === sig) return false;
    var ae = document.activeElement;
    if (ae && ae !== document.body && el.contains(ae)) return false;
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
    var before = sigs['dash-overview'];
    patch('dash-head', dashHead(d), sigHead(d));
    patch('dash-next', nextStep(d), sigNext(d));
    patch('dash-overview', overview(d), sigOverview(d));
    if (patch('dash-insight', insight(d), sigInsight(d))) drawChart();
    patch('dash-filters', filtersHtml(d), JSON.stringify(filterDefs(d)));
    $$('#dash-filters [data-filter]').forEach(function (b) { var def = filterDefs(d).filter(function (f) { return f[0] === b.getAttribute('data-filter'); })[0], n = $('b', b); if (def && n && n.textContent !== String(def[2])) n.textContent = def[2]; });
    patch('rows', rowsHtml(d), sigRows(d));
    patch('dash-journal', journalHtml(d), sigJournal(d));
    var cnt = $('#addsite-count'); if (cnt && d.sites && cnt.textContent !== siteCount(d)) cnt.textContent = siteCount(d);
    var bc = $('#brokers-count'), bct = plural(d.counters.active, 'suivi', 'suivis'); if (bc && bc.textContent !== bct) bc.textContent = bct;
    if (drawer && drawer.open && drawerFor && drawerIdle()) { var r = rowById(drawerFor); if (r && drawerSig && rowSig(r) !== drawerSig) loadDrawer(drawerFor, null, true); }
    if (before && before !== sigs['dash-overview']) {
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
    var u = state.user, keyed = u.billing_mode === 'key', live = subActive(u), ends = u.subscription_ends_at;
    var ended = keyed && !live && !(ends && Date.parse(ends) > Date.now());   // abonnement offert arrivé à son terme
    var endRow = !ends ? '' : keyed && live ? '<dt>Accès</dt><dd><strong>Activé par clé jusqu’au ' + fmtDate(ends, LONG) + '</strong></dd>' : '<dt>Fin d’accès</dt><dd>' + (ended ? 'Abonnement offert terminé le ' + fmtDate(ends, LONG) : fmtDate(ends)) + '</dd>';
    /* « Résilier » est masqué pour un abonnement offert : aucun paiement à arrêter, il s'arrête de lui-même (voir server/keys.js). */
    var foot = keyed && live ? '<div class="sheet__foot"><p class="key-foot">Rien à résilier' + NBSP + ': l’abonnement offert s’arrête de lui-même le ' + fmtDate(ends, LONG) + '. Pour suspendre les demandes, révoquez le mandat depuis votre <a href="#dossier">dossier</a>.</p></div>'
      : live || u.subscription_status === 'past_due' ? '<div class="sheet__foot"><button class="btn btn--danger btn--sm" type="button" id="cancel-sub">Résilier l’abonnement</button><span class="mono">Satisfait ou remboursé 30' + NBSP + 'jours</span></div>' : '';
    var status = '<section class="sheet" aria-labelledby="sub-h"><div class="sheet__head"><h2 id="sub-h">Votre abonnement</h2>' + (ended ? chip('canceled', 'Terminé') : chip(u.subscription_status, subLabel(u.subscription_status))) + '</div><div class="sheet__body"><dl class="kv"><dt>Offre</dt><dd>' + (u.plan && state.config.plans[u.plan] ? esc(state.config.plans[u.plan].name) + SEP + (keyed ? 'offerte par clé' : u.billing === 'annual' ? 'annuel (ancienne formule)' : 'mensuel') : '—') + '</dd><dt>Paiement</dt><dd>' + (u.billing_mode === 'stripe' ? 'Carte via Stripe' : u.billing_mode === 'simulated' ? 'Simulé (environnement de test)' : keyed ? 'Clé d’activation, sans paiement' : '—') + '</dd>' + endRow + '</dl></div>' + foot + '</section>';
    var swap = keyed && live ? '<p class="notice notice--info">Souscrire une offre payante remplace l’abonnement offert, sans report des jours restants.</p>' : '';
    return '<div class="page-head"><div><span class="mono">Abonnement</span><h1>Un prix clair. Une <em>seule</em> mission.</h1></div></div><div class="stack">' + status + (pendingKey() || (keyed && live) ? keyBlock() + swap + plansBlock() : plansBlock() + keyBlock()) + '</div>';
  };

  /* Rapport imprimable du dossier affiché (et export CSV) : impression navigateur ou « Enregistrer en PDF ». */
  views.report = function () {
    return '<div class="page-head report-head"><div><span class="mono" id="report-eyebrow">Rapport</span><h1>Rapport d’effacement</h1><p class="lead" id="report-lead">Préparation du rapport…</p></div>' +
      '<div class="btn-row no-print"><button class="btn" type="button" id="report-print">Imprimer ou enregistrer en PDF</button><a class="btn btn--outline" id="report-csv" href="/api/requests.csv" download>Télécharger (CSV)</a><a class="btn btn--ghost" href="#dashboard">Retour au tableau de bord</a></div></div><div id="report-body" class="stack"><span class="spinner"></span></div>';
  };
  function reportHtml(d) {
    var c = d.counters, u = d.user, prof = currentProfile(d);
    var list = d.requests.slice().sort(function (a, b) { return a.broker.localeCompare(b.broker, 'fr'); });
    var kv = [['Personne', esc(fullName(prof))], ['Mandat', u.mandate_signed_at ? 'signé le ' + fmtDate(u.mandate_signed_at) + (u.mandate_revoked_at ? ', révoqué le ' + fmtDate(u.mandate_revoked_at) : '') : 'non signé'], ['Courtiers surveillés', String(c.brokers)], ['Sites ajoutés', String(d.sites ? d.sites.count : 0)], ['Effacements confirmés', String(c.done)], ['Demandes en cours', String(c.in_progress + c.queued)], ['Vérifications à faire', String(c.action_required)], ['Refus', String(c.refused)], ['Exposition estimée', d.exposure + NNBSP + '%'], ['Prochaine vérification', d.next_check_at ? fmtDate(d.next_check_at) : '—']];
    var rows = list.map(function (r) {
      return '<tr><td><strong>' + esc(r.broker) + '</strong>' + (r.custom ? '<small>site ajouté</small>' : '') + '</td><td data-label="Catégorie">' + esc(r.category) + '</td><td>' + chip(r.status) + '</td><td data-label="Envoyée">' + (r.sent_at ? fmtDate(r.sent_at) : '—') + '</td><td data-label="Suivi">' + (r.status === 'done' ? 'effacée le ' + fmtDate(r.completed_at) : r.due_at ? 'due le ' + fmtDate(r.due_at) : '—') + '</td><td class="mono mono--plain" data-label="Réf.">' + esc(r.ref) + '</td></tr>';
    }).join('');
    return '<section class="sheet" aria-labelledby="rep-sum"><div class="sheet__head"><h2 id="rep-sum">Synthèse</h2><span class="mono">' + plural(c.total, 'demande', 'demandes') + '</span></div><div class="sheet__body"><dl class="kv kv--2">' + kv.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl></div></section>' +
      '<section class="sheet" aria-labelledby="rep-list"><div class="sheet__head"><h2 id="rep-list">Demandes</h2><span class="mono">cycle en cours</span></div>' + (rows ? '<div class="report-wrap"><table class="report-table"><caption class="vh">Demandes d’effacement par courtier</caption><thead><tr><th scope="col">Courtier ou site</th><th scope="col">Catégorie</th><th scope="col">Statut</th><th scope="col">Envoyée</th><th scope="col">Suivi</th><th scope="col">Référence</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="empty">Aucune demande pour l’instant.</p>') + '</section>' +
      '<p class="mono mono--plain report-foot">Demandes adressées par Oubli au nom de ' + esc(fullName(prof)) + ', en vertu du mandat de représentation (RGPD art. 17 et 21, CCPA). Chaque courrier et chaque réponse sont horodatés dans le journal du dossier.</p>';
  }
  function loadReport() {
    var pid = state.profileId ? '?profile_id=' + encodeURIComponent(state.profileId) : '';
    api('/dashboard' + pid).then(function (d) {
      state.dash = d; state.profileId = d.profile_id;
      var body = $('#report-body'); if (!body || params().route !== 'report') return;
      var prof = currentProfile(d);
      $('#report-eyebrow').textContent = 'Rapport' + SEP + 'Dossier ' + fileNo(d.profile_id);
      $('#report-lead').textContent = fullName(prof) + SEP + 'édité le ' + fmtWhen(new Date().toISOString());
      $('#report-csv').setAttribute('href', '/api/requests.csv?profile_id=' + encodeURIComponent(d.profile_id));
      body.innerHTML = reportHtml(d);
    }).catch(function (e) { if (e.status === 401) { resetSession(); go('login'); return; } var b = $('#report-body'); if (b) b.innerHTML = '<p class="notice" role="alert">' + esc(e.message) + '</p>'; });
  }

  views.settings = function () {
    return '<div class="page-head"><div><span class="mono">Paramètres</span><h1>Votre compte, vos données, vos droits.</h1></div></div><div class="stack">' +
      '<form class="sheet" id="pwd-form" novalidate><div class="sheet__head"><h2>Mot de passe</h2></div><div class="sheet__body"><div class="fields">' + field('current', 'Mot de passe actuel', '', { extra: 'type="password" autocomplete="current-password" required' }) + field('next', 'Nouveau mot de passe', '', { extra: 'type="password" autocomplete="new-password" minlength="10" required' }, 'Au moins 10' + NBSP + 'caractères. Les autres sessions seront déconnectées.') + '</div>' + msgEl('msg-pwd-form', 'margin-top:16px') + '</div><div class="sheet__foot"><button class="btn btn--outline" type="submit">Changer le mot de passe</button></div></form>' +
      '<section class="sheet" id="devices" aria-labelledby="devices-h"><div class="sheet__head"><h2 id="devices-h" tabindex="-1">Appareils connectés</h2><span class="mono" id="devices-count"></span></div><div class="sheet__body" id="devices-body"><p class="devices__note"><span class="spinner"></span> Chargement des appareils…</p></div>' +
      '<div class="sheet__foot" id="devices-foot" hidden><button class="btn btn--outline btn--sm" type="button" id="revoke-others">Déconnecter les autres appareils</button><span class="mono">Une session dure 30' + NBSP + 'jours au plus</span></div></section>' +
      '<section class="sheet" aria-labelledby="notif-h"><div class="sheet__head"><h2 id="notif-h">Notifications</h2></div><div class="sheet__body"><label class="check"><input type="checkbox" id="pref-report"' + (state.user.monthly_report !== false ? ' checked' : '') + '> <span>Recevoir chaque mois un rapport par e-mail' + NBSP + ': effacements confirmés, demandes en cours, vérifications à faire.</span></label><p class="hint notif-hint">Les alertes «' + NBSP + 'action requise' + NBSP + '» restent envoyées' + NBSP + ': elles demandent une intervention de votre part.</p></div></section>' +
      '<section class="sheet" aria-labelledby="data-h"><div class="sheet__head"><h2 id="data-h">Vos données chez Oubli</h2></div><div class="sheet__body"><p class="lead">Nous appliquons à nous-mêmes ce que nous demandons aux courtiers' + NBSP + ': export complet en un clic, suppression définitive sur demande.</p></div><div class="sheet__foot"><a class="btn btn--outline" href="/api/export" download="oubli-export.json">Exporter mes données (JSON)</a><span class="mono">RGPD art. 15 &amp; 20</span></div></section>' +
      '<form class="sheet" id="delete-form" novalidate><div class="sheet__head"><h2>Supprimer le compte</h2></div><div class="sheet__body"><p class="lead" style="margin-bottom:22px">Résilie l’abonnement, supprime vos profils, vos demandes et le journal. Irréversible.</p><div class="fields">' + field('password', 'Mot de passe', '', { extra: 'type="password" autocomplete="current-password" required' }) + '</div>' + msgEl('msg-delete-form', 'margin-top:16px') + '</div><div class="sheet__foot"><button class="btn btn--danger" type="submit">Supprimer définitivement</button><span class="mono">RGPD art. 17</span></div></form></div>';
  };

  /* ---------- appareils connectés (Paramètres) ---------- */
  /* Une session n'est connue ici que par sa poignée (empreinte) ; sa dernière activité est connue à l'heure près. */
  function deviceMeta(s) {
    function t(iso, txt) { return '<time datetime="' + esc(iso) + '">' + txt + '</time>'; }
    var since = (s.support ? 'Ouvert le ' : 'Connecté le ') + t(s.created_at, fmtDate(s.created_at));
    var act = s.support ? 'lecture seule, jusqu’à ' + t(s.expires_at, new Date(s.expires_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))
      : s.current ? 'actif en ce moment'
      : Date.now() - Date.parse(s.last_seen_at) < 3600000 ? 'actif dans l’heure'
      : 'dernière activité le ' + t(s.last_seen_at, fmtWhen(s.last_seen_at));
    return since + SEP + act;
  }
  function devicesHtml(list) {
    var others = list.filter(function (s) { return !s.current; }).length;
    return '<ul class="devices" role="list">' + list.map(function (s) {
      return '<li class="device"><div class="device__main"><p class="device__name"><strong>' + esc(s.device) + '</strong>' + (s.current ? '<span class="chip chip--active">Cet appareil</span>' : '') + '</p><p class="device__meta">' + deviceMeta(s) + '</p></div>' +
        (s.current ? '' : '<button class="btn btn--outline btn--sm" type="button" data-session="' + esc(s.handle) + '" data-device="' + esc(s.device) + '">Déconnecter<span class="vh"> ' + esc(s.device) + ', connecté le ' + fmtDate(s.created_at) + '</span></button>') + '</li>';
    }).join('') + '</ul>' + (others ? '' : '<p class="devices__note">Aucun autre appareil n’est connecté à votre compte.</p>');
  }
  /* focus (facultatif) : rang du bouton « Déconnecter » à reprendre après une révocation ; à défaut, le titre de la section. */
  function loadDevices(focus) {
    return api('/sessions').then(function (r) {
      var body = $('#devices-body'); if (!body || params().route !== 'settings') return;
      var list = r.sessions || [], others = list.filter(function (s) { return !s.current; }).length;
      body.innerHTML = devicesHtml(list);
      $('#devices-count').textContent = plural(list.length, 'appareil', 'appareils');
      $('#devices-foot').hidden = !others;
      if (typeof focus === 'number') { var bs = $$('[data-session]', body); (bs[Math.min(focus, bs.length - 1)] || $('#devices-h')).focus(); }
    }).catch(function (e) {
      if (e.status === 401) { resetSession(); go('login'); return; }
      var body = $('#devices-body'); if (body) body.innerHTML = '<p class="notice" role="alert">' + esc(e.message) + '</p>';
    });
  }

  /* ---------- interactions : mot de passe oublié, réinitialisation, appareils ---------- */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.id !== 'forgot-form' && f.id !== 'reset-form') return;
    e.preventDefault();
    if (f._busy) return;
    if (f.id === 'forgot-form') {
      var em = $('#f-email', f), email = em.value.trim();
      if (!email) { showMsg(f, 'Indiquez l’adresse e-mail de votre compte.', true, null, em); return; }
      busy(f, true); showMsg(f, '');
      api('/auth/forgot', { body: { email: email } }).then(function () { swapState($('#forgot-box'), forgotDone(email)); }).catch(function (err) { showMsg(f, typo(err.message), true, null, em); }).finally(function () { busy(f, false); });
    } else {
      var pw = $('#f-password', f), pw2 = $('#f-confirm', f);
      if (!pw.value) { showMsg(f, 'Choisissez un nouveau mot de passe.', true, null, pw); return; }
      if (pw.value !== pw2.value) { showMsg(f, 'Les deux mots de passe ne correspondent pas.', true, null, pw2); return; }
      busy(f, true); showMsg(f, '');
      api('/auth/reset', { body: { token: params().q.token || '', password: pw.value } }).then(function (r) {
        if (!r.signed_in) { swapState($('#reset-box'), resetState('suspended', r.message)); return; }
        state.dash = null; state.profileId = null;
        return loadMe().then(function () { toast('Mot de passe changé. Vous êtes connecté.'); location.replace('#' + home()); });   // le lien sort de l'historique
      }).catch(function (err) {
        if (/^(invalid|expired|used)$/.test(err.code || '')) { swapState($('#reset-box'), resetState(err.code)); return; }
        showMsg(f, typo(err.message), true, null, pw);   // messages de la politique de mot de passe (auth.js) : espace insécable avant « : »
      }).finally(function () { busy(f, false); });
    }
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t || t.getAttribute('aria-disabled') === 'true') return;
    if (t.id === 'forgot-link') { var le = $('#f-email'); state.forgotEmail = le ? le.value.trim() : ''; }   // adresse reprise, sans passer par l'URL
    else if (t.id === 'unsub-go') {
      var uq = unsubQs(params().q); if (!uq) return;
      lock(t, true);
      api('/unsubscribe/report?' + uq, { method: 'POST', body: {} }).then(function () {
        if (state.user) state.user.monthly_report = false;
        history.replaceState(null, '', location.pathname + location.search + '#unsubscribe?done=1');   // le jeton sort de l'adresse et de l'historique
        swapState($('#unsub-box'), unsubState('done'));
      }).catch(function (err) { swapState($('#unsub-box'), unsubState('invalid', typo(err.message))); });
    }
    else if (t.id === 'forgot-again') { var box = $('#forgot-box'); box.innerHTML = forgotForm(t.getAttribute('data-email') || ''); $('#f-email', box).focus(); }
    else if (t.hasAttribute('data-session')) {
      var rank = $$('#devices-body [data-session]').indexOf(t), label = t.getAttribute('data-device');
      lock(t, true);
      api('/sessions/' + encodeURIComponent(t.getAttribute('data-session')), { method: 'DELETE' }).then(function () { toast('Appareil déconnecté' + NBSP + ': ' + label + '.'); return loadDevices(rank); })
        .catch(function (err) { toast(typo(err.message), true); lock(t, false); if (err.status === 404) loadDevices(rank); });
    }
    else if (t.id === 'revoke-others') {
      lock(t, true);
      api('/sessions/revoke-others', { method: 'POST' }).then(function (r) { toast(r.revoked > 1 ? r.revoked + NBSP + 'appareils déconnectés.' : r.revoked ? 'Un appareil déconnecté.' : 'Aucun autre appareil n’était connecté.'); return loadDevices(0); })
        .catch(function (err) { toast(typo(err.message), true); }).finally(function () { lock(t, false); });
    }
  });

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
    clearInterval(pollTimer); closeDrawer();
    /* Lien de partage d'une clé d'activation : la clé est mise de côté et retirée de l'adresse (et de l'historique). */
    if (p.q.key !== undefined) {
      setPendingKey(String(p.q.key).trim().slice(0, 40)); delete p.q.key;
      var rest = new URLSearchParams(p.q).toString();
      history.replaceState(null, '', location.pathname + location.search + '#' + (p.route || route) + (rest ? '?' + rest : ''));
    }
    if (route === 'billing-success') { toast('Paiement confirmé. Les demandes partent automatiquement.'); location.hash = 'dashboard'; return; }
    // Sans session : connexion, inscription, mot de passe oublié et réinitialisation. Avec une session, #reset reste ouvert
    // (le lien reçu par e-mail vaut pour son compte, qui peut être un autre que celui connecté).
    if (!state.user && !/^(login|signup|forgot|reset|verify|unsubscribe)$/.test(route)) { location.hash = 'login' + (location.hash.indexOf('?') > 0 ? location.hash.slice(location.hash.indexOf('?')) : ''); return; }
    if (state.user && /^(login|signup|forgot)$/.test(route)) { location.hash = pendingKey() && onboardingDone() ? 'billing' : home(); return; }
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
    if (route === 'dashboard') { drawChart(); loadDash(null, true); pollTimer = setInterval(function () { if (!document.hidden && Date.now() >= retryAt) loadDash(); }, 6000); }
    if (route === 'onboarding' || route === 'dossier') loadMandateText();
    if (route === 'report') loadReport();
    if (route === 'settings') loadDevices();
    if (route === 'verify') runVerify(q || {});
    if (plugins[route]) plugins[route](q || {});
  }
  /* Requête du tableau de bord : une seule à la fois (sauf demande explicite), la plus récente l'emporte. En cas d'échec,
     nouvel essai espacé (12 s, 24 s… 1 min au plus) et indicateur « hors ligne », au lieu d'une erreur toutes les 6 s. */
  /* Réponse conditionnelle : le serveur renvoie 304 sans corps quand rien n'a changé depuis le dernier ETag reçu. */
  var dashSeq = 0, dashBusy = false, fails = 0, retryAt = 0, dashTag = null;
  function fetchDash(pid) {
    var h = {}; if (dashTag && state.dash) h['If-None-Match'] = dashTag;
    return fetch('/api/dashboard' + pid, { credentials: 'same-origin', headers: h }).then(function (r) {
      if (r.status === 304) return null;
      return r.text().then(function (t) {
        var d; try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { error: 'Réponse invalide du serveur.' }; }
        if (!r.ok) { var err = new Error(d.error || ('Erreur ' + r.status)); err.status = r.status; throw err; }
        dashTag = r.headers.get('ETag'); return d;
      });
    });
  }
  function loadDash(focusSel, force) {
    if (dashBusy && !force) return Promise.resolve();
    var seq = ++dashSeq, pid = state.profileId ? '?profile_id=' + encodeURIComponent(state.profileId) : '';
    dashBusy = true;
    return fetchDash(pid).then(function (d) {
      if (seq !== dashSeq) return;
      if (fails) announce('Connexion rétablie.');
      fails = 0; retryAt = 0; setLive('ok', 'En direct');
      var err = $('#dash-error'); if (err) err.remove();
      if (!d) { if (focusSel) paintDash(focusSel); return; }   // 304 : rien de neuf
      state.dash = d; state.user = d.user; state.profiles = d.profiles; state.profileId = d.profile_id; paintDash(focusSel);
    }).catch(function (e) {
      if (seq !== dashSeq) return;
      if (e.status === 401) { resetSession(); go('login'); return; }
      fails += 1; retryAt = Date.now() + Math.min(60000, 6000 * Math.pow(2, fails));
      if (e.status) { setLive('off', 'Erreur du serveur'); if (fails === 1) toast(e.message, true); }
      else { setLive('off', 'Hors ligne'); if (fails === 1) announce('Connexion perdue' + NBSP + ': nouvel essai automatique.'); }
      var sk = $('.dash--loading'); if (sk && !$('#dash-error')) sk.insertAdjacentHTML('afterbegin', '<p class="notice" id="dash-error" role="alert">Le tableau de bord ne répond pas pour l’instant. Nouvel essai automatique dans quelques secondes.</p>');
    }).finally(function () { if (seq === dashSeq) dashBusy = false; });
  }
  window.addEventListener('online', function () { if (state.user && params().route === 'dashboard') { retryAt = 0; loadDash(null, true); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state.user && params().route === 'dashboard' && Date.now() >= retryAt) loadDash(); });
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
      var adminMail = false;
      api(f.id === 'login-form' ? '/auth/login' : '/auth/signup', { body: d }).then(function (r) { adminMail = r && r.admin_verification; state.dash = null; state.profileId = null; return loadMe(); }).then(function () {
        toast(adminMail === 'outbox' ? 'Accès administrateur en attente' + NBSP + ': aucun serveur d’envoi n’est configuré, lancez «' + NBSP + 'npm run admin -- promote ' + d.email + NBSP + '» sur le serveur.'
          : adminMail ? 'Pour activer l’accès administrateur, ouvrez le lien de confirmation envoyé à ' + d.email + '.' : f.id === 'login-form' ? 'Connecté.' : 'Compte créé. Dossier ouvert.', adminMail === 'outbox'); go(pendingKey() && onboardingDone() ? 'billing' : home()); }).catch(function (err) { showMsg(f, err.message, true, null, $('#f-password', f)); }).finally(function () { busy(f, false); });
    } else if (f.id === 'key-form') {
      var ki = $('#key-input', f), kv = ki.value.trim();
      if (!kv) { showMsg(f, 'Saisissez la clé reçue, sous la forme ' + KEY_FMT + '.', true, null, ki); return; }
      busy(f, true); showMsg(f, '');
      api('/billing/redeem', { body: { key: kv } }).then(function (r) {
        setPendingKey('');
        var plan = state.config.plans[r.plan], text = 'Abonnement ' + (plan ? plan.name : r.plan) + (r.extended ? ' prolongé' : ' activé') + ' jusqu’au ' + fmtDate(r.ends_at, LONG) + (r.launched ? NBSP + ': ' + plural(r.launched, 'demande préparée', 'demandes préparées') : '') + '.';
        return loadMe().then(function () {
          state.dash = null; toast(text);
          if (params().route === 'onboarding' && onboardingDone()) { go('dashboard'); setTimeout(loadDash, 1500); setTimeout(loadDash, 4000); } else render();
        });
      }).catch(function (err) {
        if (err.status === 400 || err.status === 404 || err.status === 410) setPendingKey('');   // clé inutilisable : on ne la repropose plus
        showMsg(f, err.message, true, null, ki);
      }).finally(function () { busy(f, false); });
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
    } else if (f.id === 'addsite-form') {
      var su = $('#addsite-url', f), sv = su.value.trim();
      if (!sv) { showMsg(f, 'Collez l’adresse d’un site ou d’une page.', true, null, su); return; }
      busy(f, true); showMsg(f, '');
      api('/sites', { body: { url: sv, profile_id: state.profileId } }).then(function (r) {
        var b = r.broker.name;
        var text = r.status === 'already' ? b + ' fait déjà partie de vos demandes' + NBSP + ': l’adresse de la fiche a été ajoutée au dossier.' : r.status === 'relaunched' ? 'Fiche signalée chez ' + b + NBSP + ': une nouvelle demande d’effacement part.' : r.registry ? b + ' ajouté à votre dossier' + NBSP + ': la demande part.' : 'Site ajouté' + NBSP + ': nous cherchons le contact de ' + b + ', la demande part dès qu’il est connu.';
        su.value = ''; showMsg(f, text);
        state.filter = 'all'; state.search = ''; state.page = 1; var si = $('#broker-search'); if (si) si.value = '';
        return loadDash(null, true);
      }).catch(function (err) { showMsg(f, err.message, true, null, su); }).finally(function () { busy(f, false); });
    } else if (f.id === 'relaunch-form') {
      var ru = $('#relaunch-url', f), rid = f.getAttribute('data-id'), rb = (rowById(rid) || {}).broker || 'ce courtier';
      busy(f, true); showMsg(f, '');
      api('/requests/' + rid + '/relaunch', { body: { url: ru.value.trim() } }).then(function (r) {
        toast('Nouvelle demande enregistrée pour ' + rb + NBSP + ': elle part dans la minute.');
        closeDrawer();
        return loadDash(null, true).then(function () { var nb = $('.row__open[data-open="' + r.request_id + '"]'); if (nb) nb.focus(); });
      }).catch(function (err) { showMsg(f, err.message, true, null, ru); }).finally(function () { busy(f, false); });
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

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (e.key === 'Enter' && t.matches && t.matches('.tags__add input')) { e.preventDefault(); addTag(t.closest('.f--list')); return; }
    if (e.key === 'Escape') { var armed = $$('[data-confirm]'); if (armed.length) { armed.forEach(disarm); return; } }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && params().route === 'dashboard' && !(drawer && drawer.open) && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) { var bs = $('#broker-search'); if (bs) { e.preventDefault(); bs.focus(); bs.select(); } }
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t) return;
    if (t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    if (t.id === 'report-print') { window.print(); return; }
    if (t.id === 'support-stop') { lock(t, true); api('/auth/impersonate/stop', { method: 'POST' }).then(backToAdmin).catch(function () { backToAdmin(null); }); }
    else if (t.matches('.tags__add button')) { addTag(t.closest('.f--list')); }
    else if (t.matches('.tag button')) { var li = t.closest('.tag'), nx = li.nextElementSibling || li.previousElementSibling, lf = li.closest('.f--list'), label = li.querySelector('span').textContent; li.remove(); (nx ? nx.querySelector('button') : $('.tags__add input', lf)).focus(); announce('Retiré' + NBSP + ': ' + label); }
    else if (t.hasAttribute('data-filter')) {
      e.preventDefault(); state.filter = t.getAttribute('data-filter'); state.page = 1;
      if (state.dash) { renderRows(); var n = visibleRequests(state.dash).length; announce(plural(n, 'demande affichée', 'demandes affichées') + '.'); if (!t.closest('#dash-filters')) { var fb = $('#dash-filters [data-filter="' + state.filter + '"]'); if (fb) { fb.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); fb.focus({ preventScroll: true }); } } }
    }
    else if (t.hasAttribute('data-profile')) { var pid = t.getAttribute('data-profile'); if (pid === state.profileId) return; state.profileId = pid; state.page = 1; state.search = ''; state.filter = 'all'; loadDash('.ptab[data-profile="' + pid + '"]', true); }
    else if (t.hasAttribute('data-open')) { e.preventDefault(); openDrawer(t.getAttribute('data-open'), t, t.getAttribute('data-section')); }
    else if (t.hasAttribute('data-close')) { closeDrawer(); }
    else if (t.id === 'jump-addsite') { var as = $('#addsite'), ai = $('#addsite-url'); if (as) { as.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }); if (ai) setTimeout(function () { ai.focus({ preventScroll: true }); }, reduced() ? 0 : 350); } }
    else if (t.hasAttribute('data-complaint')) { loadComplaint(t.getAttribute('data-complaint')); }
    else if (t.id === 'complaint-copy') { copyText(complaintText, 'Texte de la plainte copié.'); }
    else if (t.hasAttribute('data-copy')) { copyText(t.getAttribute('data-copy'), 'Référence copiée.'); }
    else if (t.hasAttribute('data-relaunch-open')) { var rf = $('#relaunch-form', drawer); if (rf) { rf.hidden = !rf.hidden; t.setAttribute('aria-expanded', String(!rf.hidden)); if (!rf.hidden) $('#relaunch-url', rf).focus(); } }
    else if (t.id === 'cats-toggle') { state.catsAll = !state.catsAll; var ch = $('#dash-cats'); if (ch && state.dash) { ch.innerHTML = catsHtml(state.dash); sigs['dash-insight'] = sigInsight(state.dash); var tb = $('#cats-toggle'); if (tb) tb.focus(); } }
    else if (t.id === 'rows-more') { var prev = $$('#rows .row:not(.row--head)').length; state.page += 1; renderRows(); var rows = $$('#rows .row:not(.row--head)'), first = rows[prev]; if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); } announce(plural(rows.length - prev, 'ligne ajoutée', 'lignes ajoutées') + '.'); }
    else if (t.id === 'search-clear') { state.search = ''; state.page = 1; var si = $('#broker-search'); if (si) si.value = ''; renderRows(); if (si) si.focus(); }
    else if (t.id === 'journal-toggle') { state.journalAll = !state.journalAll; var jh = $('#dash-journal'); if (jh) { sigs['dash-journal'] = sigJournal(state.dash); jh.innerHTML = journalHtml(state.dash); var jb = $('#journal-toggle'); if (jb) jb.focus(); } }
    else if (t.hasAttribute('data-checkout')) {
      lock(t, true);
      api('/billing/checkout', { body: { plan: t.getAttribute('data-checkout'), billing: 'monthly' } }).then(function (r) {
        if (r.mode === 'stripe') { location.href = r.url; return; }
        return loadMe().then(function () { state.dash = null; toast('Abonnement activé.'); if (onboardingDone()) return launch(); render(); });
      }).catch(function (err) { toast(err.message, true); lock(t, false); });
    }
    else if (t.id === 'cancel-sub') { if (!arm(t, 'Confirmer la résiliation')) return; api('/billing/cancel', { method: 'POST' }).then(loadMe).then(function () { state.dash = null; toast('Abonnement résilié.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.id === 'revoke') { if (!arm(t, 'Confirmer la révocation')) return; api('/mandate', { method: 'DELETE' }).then(loadMe).then(function () { state.dash = null; toast('Mandat révoqué.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.id === 'launch') { lock(t, true); launch(); }
    else if (t.hasAttribute('data-resolve')) {
      var rid2 = t.getAttribute('data-resolve'), inDrawer = !!(drawer && drawer.contains(t)); lock(t, true);
      api('/requests/' + rid2 + '/resolve', { method: 'POST' }).then(function () {
        toast('Merci. La demande reprend son cours.');
        if (!inDrawer) { var row = t.closest('.row'), nb = row && $('.row__open', row); if (nb) nb.focus(); }
        return loadDash(null, true).then(function () { if (inDrawer && drawerFor === rid2) loadDrawer(rid2); });
      }).catch(function (err) { toast(err.message, true); lock(t, false); });
    }
    else if (t.hasAttribute('data-remove')) { if (!arm(t, 'Confirmer le retrait')) return; api('/profiles/' + t.getAttribute('data-remove'), { method: 'DELETE' }).then(loadMe).then(function () { state.dash = null; state.profileId = null; toast('Profil retiré.'); render(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.getAttribute('href') && /^#profile-/.test(t.getAttribute('href'))) { e.preventDefault(); var el = $(t.getAttribute('href')); if (el) { el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); var inp = $('input', el); if (inp) setTimeout(function () { inp.focus({ preventScroll: true }); }, reduced() ? 0 : 400); } }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'broker-search') { var v = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(function () { state.search = v; state.page = 1; renderRows(); if (state.dash) announce(plural(visibleRequests(state.dash).length, 'courtier', 'courtiers') + '.'); }, 180); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'broker-sort') { state.sort = e.target.value; state.page = 1; renderRows(); }
    if (e.target.id === 'pref-report') {
      var box = e.target, on = box.checked; box.disabled = true;
      api('/preferences', { method: 'PUT', body: { monthly_report: on } }).then(function (r) { state.user = r.user; toast(on ? 'Rapport mensuel activé.' : 'Rapport mensuel désactivé.'); }).catch(function (err) { box.checked = !on; toast(err.message, true); }).finally(function () { box.disabled = false; box.focus(); });
    }
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { var h = $('#exp-chart'); if (h && h._size && Math.abs(h.clientWidth - h._size.W) > 8) drawChart(); }, 150); });

  /* ---------- API interne pour les modules optionnels (admin) ---------- */
  window.Oubli = { chrome: setChrome, registerView: registerView, api: api, esc: esc, toast: toast, fmtDate: fmtDate, fmtTime: fmtTime, money: money, chip: chip, dots: dots, statusLabel: statusLabel, subLabel: subLabel, field: field, go: go, render: render, params: params, state: state, NBSP: NBSP, NNBSP: NNBSP, announce: announce, typo: typo, fmtDay: fmtDay, plural: plural, subActive: subActive };

  /* ---------- démarrage ---------- */
  Promise.all([api('/config').catch(function () { return { plans: { individuel: { name: 'Individuel', members: 1, monthly: 500 }, famille: { name: 'Famille', members: 5, monthly: 999 } }, billing: 'simulated', brokers: 50, mandate_version: '' }; }), loadMe()]).then(function (r) {
    state.config = r[0];
    render();
  });
})();
