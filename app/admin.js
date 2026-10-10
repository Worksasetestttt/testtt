/* Oubli — panel d'administration, chargé à la demande par app.js pour les administrateurs (window.Oubli.registerView).
   Onglets par le hash (#admin?tab=requests&status=open&page=2). Les filtres, recherches et pages d'un même onglet sont
   rechargés en place (history.pushState) sans reconstruire le rail ; changer d'onglet passe par le routeur de app.js. */
(function () {
  'use strict';
  var O = window.Oubli, api = O.api, esc = O.esc, chip = O.chip, fr = O.typo, NB = O.NBSP, NNB = O.NNBSP, SEP = NB + '· ';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var TABS = [
    ['overview', 'Vue d’ensemble', 'Abonnés, demandes, courtiers et santé du service, en un coup d’œil.'],
    ['users', 'Utilisateurs', 'Comptes, abonnements, mandats et sessions.'],
    ['keys', 'Clés d’activation', 'Abonnements offerts sans paiement' + NB + ': création par lot, activations et révocation.', 'Clés'],
    ['requests', 'Demandes', 'Toutes les demandes d’effacement, leur statut et leurs courriers.'],
    ['brokers', 'Courtiers', 'Le registre des courtiers' + NB + ': contacts, juridictions, résultats.'],
    ['mails', 'Courriers', 'Chaque courrier envoyé, avec son contenu exact.'],
    ['inbound', 'Réponses entrantes', 'Rattacher une réponse de courtier à sa demande et la qualifier.'],
    ['contacts', 'Contacts et listes', 'Messages reçus, inscrits à la lettre d’information et exports CSV.', 'Contacts'],
    ['security', 'Sécurité', 'Comptes suspendus, liste de blocage, accès support et sessions actives.'],
    ['system', 'Système', 'Configuration, annonce, planificateur et volumes de données.'],
    ['audit', 'Journal d’audit', 'Chaque action d’un administrateur, horodatée et attribuée.'],
  ];
  var TAB = {}; TABS.forEach(function (t) { TAB[t[0]] = t; });
  var BADGE = { users: ' comptes', keys: ' clés actives', requests: ' à traiter', brokers: ' contacts non vérifiés', inbound: ' réponses à vérifier', contacts: ' messages à traiter', security: ' comptes suspendus' };
  var STATUSES = ['queued', 'sent', 'in_progress', 'action_required', 'done', 'refused', 'error'];
  var OUTCOMES = [['done', 'Effacée'], ['in_progress', 'En cours'], ['action_required', 'Vérification demandée'], ['refused', 'Refus']];
  var SUBS = [['active', 'Actif'], ['past_due', 'Paiement en attente'], ['canceled', 'Résilié'], ['none', 'Aucun abonnement']];
  var JUR = [['FR', 'France'], ['EU', 'Union européenne'], ['UK', 'Royaume-Uni'], ['US', 'États-Unis'], ['CA', 'Canada'], ['CH', 'Suisse']];
  var BASES = [['rgpd', 'RGPD'], ['ccpa', 'CCPA'], ['both', 'RGPD et CCPA']];
  var SENS = [['1', 'Faible'], ['2', 'Moyenne'], ['3', 'Élevée']];
  var SORTS = [['created_desc', 'Plus récentes'], ['created_asc', 'Plus anciennes'], ['status', 'Par statut'], ['due_asc', 'Échéance proche'], ['sent_desc', 'Envoi récent'], ['broker', 'Par courtier'], ['user', 'Par abonné']];
  var ACTIONS = { 'user.role': 'Rôle modifié', 'user.subscription': 'Abonnement modifié', 'user.logout_all': 'Sessions fermées', 'user.launch': 'Demandes lancées', 'user.delete': 'Compte supprimé', 'request.outcome': 'Réponse enregistrée', 'request.resend': 'Demande renvoyée', 'request.bulk': 'Réponses groupées', 'broker.create': 'Courtier créé', 'broker.update': 'Courtier modifié', 'broker.deactivate': 'Courtier désactivé', 'broker.test_mail': 'Courrier de test', 'contact.handled': 'Message traité', 'export.csv': 'Export CSV', 'system.tick': 'Planificateur exécuté',
    'user.suspend': 'Compte suspendu', 'user.unsuspend': 'Compte réactivé', 'user.impersonate': 'Accès au compte', 'user.impersonate_stop': 'Fin de l’accès au compte', 'user.session_revoke': 'Session fermée', 'user.note': 'Note ajoutée', 'note.delete': 'Note supprimée', 'user.message': 'Message envoyé', 'user.email': 'Adresse modifiée', 'user.export': 'Données exportées', 'blocklist.add': 'Adresse bloquée', 'blocklist.remove': 'Blocage retiré', 'settings.announcement': 'Annonce modifiée', 'broker.discover': 'Recherche du contact', 'system.reports': 'Rapports mensuels envoyés', 'key.create': 'Clés d’activation créées', 'key.revoke': 'Clé d’activation révoquée', 'system.backup': 'Sauvegarde de la base', 'request.review_dismiss': 'Réponse à vérifier classée' };
  var KEYS = { count: 'nombre', plan: 'offre', days: 'jours', max_uses: 'utilisations par clé', uses: 'utilisations', expires_at: 'date limite', hint: 'indice', batch: 'lot', until: 'jusqu’au', blocked: 'adresse bloquée', pattern: 'motif bloqué', subject: 'objet', text: 'texte', level: 'niveau', removed: 'retirée', minutes: 'minutes', note_id: 'note', was: 'motif levé', stripe: 'Stripe', note: 'note', reason: 'motif', sessions: 'sessions', created: 'créées', updated: 'mises à jour', missing: 'introuvables', rows: 'lignes', to: 'destinataire', mode: 'mode', ref: 'réf.', slug: 'slug', name: 'nom', handled: 'traité', outcome: 'résultat', file: 'fichier', bytes: 'taille', ms: 'durée', failed: 'échec', sender: 'expéditeur', reviewed: 'réponse à vérifier traitée', stopped: 'demandes arrêtées' };
  var seq = 0, brokersById = {};

  /* ---------- utilitaires ---------- */
  function toast(msg, isErr) { O.toast(fr(msg), isErr); }
  function fail(e) { toast(e.message, true); }
  function curTab(q) { return TAB[q.tab] ? q.tab : 'overview'; }
  function safeId(v) { return /^[A-Za-z0-9-]{1,64}$/.test(String(v || '')) ? String(v) : ''; }
  function qs(o) { var u = new URLSearchParams(); Object.keys(o).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') u.set(k, o[k]); }); var s = u.toString(); return s ? '?' + s : ''; }
  function merge(a, b) { var o = {}; [a || {}, b || {}].forEach(function (x) { Object.keys(x).forEach(function (k) { o[k] = x[k]; }); }); return o; }
  function href(changes) { return '#admin' + qs(merge(O.params().q, changes)); }                  // même onglet, autres filtres
  function link(tab, extra) { return '#admin' + qs(merge({ tab: tab }, extra)); }                 // lien absolu vers un onglet
  function num(n) { return Number(n || 0).toLocaleString('fr-FR'); }
  function pl(n, one, many) { return num(n) + NB + (Number(n) > 1 ? many : one); }
  function pct(n) { return n == null ? '—' : n + NNB + '%'; }
  function days(n) { return n == null ? '—' : String(n).replace('.', ',') + NB + (n >= 2 ? 'jours' : 'jour'); }
  function size(b) { b = Number(b || 0); return b < 1024 ? b + NB + 'o' : b < 1048576 ? (b / 1024).toFixed(1).replace('.', ',') + NB + 'ko' : (b / 1048576).toFixed(1).replace('.', ',') + NB + 'Mo'; }
  function dur(s) { s = Number(s || 0); var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? d + NB + 'j ' + h + NB + 'h' : h ? h + NB + 'h ' + m + NB + 'min' : m + NB + 'min'; }
  function dayLabel(day) { return new Date(day + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }
  function date(iso) { return iso ? O.fmtDate(iso) : '—'; }
  function stamp(iso) { if (!iso) return '—'; var d = new Date(iso); return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  function planName(k) { var p = O.state.config && O.state.config.plans[k]; return p ? p.name : (k || '—'); }
  function planOpts() { var p = (O.state.config && O.state.config.plans) || {}; return Object.keys(p).map(function (k) { return [k, p[k].name]; }); }
  function label(list, v) { for (var i = 0; i < list.length; i++) if (String(list[i][0]) === String(v)) return list[i][1]; return v == null ? '—' : String(v); }
  function initials(s) { var p = String(s || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase(); }
  function lock(btn, on) { if (!btn) return; btn.setAttribute('aria-disabled', on ? 'true' : 'false'); btn.setAttribute('aria-busy', on ? 'true' : 'false'); }
  function short(id) { id = String(id || ''); return id.length > 12 ? id.slice(0, 8) + '…' : id; }

  /* Confirmation en deux temps (Échap, perte du focus ou 6 s annulent). */
  function arm(btn, text) {
    if (btn.hasAttribute('data-armed')) { disarm(btn, true); return true; }
    btn.setAttribute('data-armed', '1'); btn._label = btn.innerHTML; btn.textContent = text; btn.classList.add('is-confirm');
    O.announce(text + NB + ': appuyez de nouveau pour confirmer, ou Échap pour annuler.');
    btn._t = setTimeout(function () { disarm(btn); }, 6000);
    btn.addEventListener('blur', function () { disarm(btn); }, { once: true });
    return false;
  }
  function disarm(btn, silent) { if (!btn.hasAttribute('data-armed')) return; clearTimeout(btn._t); btn.removeAttribute('data-armed'); btn.classList.remove('is-confirm'); btn.innerHTML = btn._label; if (!silent) O.announce('Annulé.'); }

  /* ---------- briques HTML ---------- */
  function td(lbl, html, cls) { return '<td' + (cls ? ' class="' + cls + '"' : '') + (lbl ? ' data-label="' + esc(lbl) + '"' : '') + '>' + html + '</td>'; }
  function th(h, cls) { return '<th scope="col"' + (cls ? ' class="' + cls + '"' : '') + '>' + h + '</th>'; }
  function table(caption, heads, body, empty) {
    if (!body) return '<p class="empty empty--sm">' + empty + '</p>';
    return '<div class="tbl-wrap" data-label="' + esc(caption) + '"><table class="tbl"><caption class="vh">' + esc(caption) + '</caption><thead><tr>' + heads.join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }
  function sheet(id, title, meta, body, attrs) { return '<section class="sheet"' + (attrs || '') + ' aria-labelledby="' + id + '"><div class="sheet__head"><h2 id="' + id + '">' + title + '</h2>' + (meta || '') + '</div>' + body + '</section>'; }
  function meta(text) { return '<span class="mono">' + text + '</span>'; }
  function msg() { return '<p class="msg" role="alert" aria-atomic="true"></p>'; }
  function inp(id, lbl, name, value, attrs, hint) { return '<div class="f"><label for="' + id + '">' + lbl + '</label><input id="' + id + '" name="' + name + '" value="' + esc(value == null ? '' : value) + '"' + (attrs || '') + (hint ? ' aria-describedby="' + id + '-hint"' : '') + '>' + (hint ? '<span class="hint" id="' + id + '-hint">' + hint + '</span>' : '') + '</div>'; }
  function sel(id, lbl, name, opts, cur, attrs) { return '<div class="f"><label for="' + id + '">' + lbl + '</label><select id="' + id + '" name="' + name + '"' + (attrs || '') + '>' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(cur == null ? '' : cur) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>'; }
  function searchForm(lbl, fields) { return '<form class="adm-search" role="search" aria-label="' + esc(lbl) + '" data-adm-search novalidate>' + fields + '<button class="btn btn--outline btn--sm" type="submit" data-k="search-go">Filtrer</button></form>'; }
  function filters(lbl, key, items, cur) {
    return '<div class="filters" role="group" aria-label="' + esc(lbl) + '">' + items.map(function (it) {
      var ch = { page: null }; ch[key] = it[0];
      return '<a href="' + esc(href(ch)) + '" data-nav data-k="f-' + key + '-' + (it[0] || 'all') + '" aria-current="' + ((cur || '') === it[0]) + '">' + it[1] + (it[2] != null ? '<b>' + num(it[2]) + '</b>' : '') + '</a>';
    }).join('') + '</div>';
  }
  function pager(d, key) {
    key = key || 'page';
    var info = '<span>' + (d.pages > 1 ? 'Page ' + d.page + ' sur ' + d.pages + SEP : '') + pl(d.total, 'élément', 'éléments') + '</span>';
    if (d.pages <= 1) return '<div class="pager">' + info + '</div>';
    function btn(p, text, k) { var off = p < 1 || p > d.pages, ch = {}; ch[key] = p; return '<a class="pager__btn' + (off ? ' is-off' : '') + '" href="' + esc(off ? href({}) : href(ch)) + '" data-nav data-k="' + key + '-' + k + '"' + (off ? ' aria-disabled="true" tabindex="-1"' : '') + '>' + text + '</a>'; }
    return '<nav class="pager" aria-label="Pagination">' + info + '<div class="pager__links">' + btn(d.page - 1, '<span aria-hidden="true">←</span> Précédente', 'prev') + btn(d.page + 1, 'Suivante <span aria-hidden="true">→</span>', 'next') + '</div></nav>';
  }
  function timeline(evs) {
    if (!evs || !evs.length) return '<p class="empty empty--sm">Aucun événement.</p>';
    return '<ol class="timeline timeline--tight">' + evs.map(function (e) { return '<li class="t-' + esc(e.type) + '"><time datetime="' + esc(e.created_at) + '">' + esc(stamp(e.created_at)) + '</time><span>' + esc(fr(e.message)) + '</span></li>'; }).join('') + '</ol>';
  }
  function val(k, v) {
    if (v === true) return 'oui'; if (v === false) return 'non'; if (v == null || v === '') return '—';
    if (typeof v === 'object') return [v.status && O.subLabel(v.status), v.plan && planName(v.plan), v.billing && (v.billing === 'annual' ? 'annuel' : 'mensuel'), v.ends_at && 'fin ' + date(v.ends_at)].filter(Boolean).join(SEP) || '—';
    if ((k === 'from' || k === 'to' || k === 'outcome') && STATUSES.indexOf(v) >= 0) return O.statusLabel(v);
    if (k === 'plan') return planName(v);
    if (k === 'expires_at') return date(v);
    if (k === 'hint') return '…' + v;
    if (k === 'bytes') return size(v);
    if (k === 'ms') return num(v) + NB + 'ms';
    return String(v);
  }
  function summary(a) {
    var d = a.details || {}, out = [];
    if (d.token) out.push('OUBLI-' + d.token);
    if (d.from !== undefined || d.to !== undefined) out.push(val('from', d.from) + ' → ' + val('to', d.to));
    if (d.changes) Object.keys(d.changes).forEach(function (k) { out.push(k + NB + ': ' + val(k, d.changes[k].from) + ' → ' + val(k, d.changes[k].to)); });
    Object.keys(d).forEach(function (k) { if (['token', 'from', 'to', 'changes'].indexOf(k) < 0 && d[k] !== undefined && typeof d[k] !== 'object') out.push((KEYS[k] || k) + NB + ': ' + val(k, d[k])); });
    return out.join(SEP) || '—';
  }
  function targetLink(a) {
    var t = a.target, d = a.details || {}, p = String(a.action || '').split('.')[0];
    if (!t) return '—';
    var txt = '<span class="mono mono--plain" title="' + esc(t) + '">' + esc(d.token ? 'OUBLI-' + d.token : p === 'key' ? (d.hint ? 'clé …' + d.hint : 'lot ' + t) : d.slug || short(t)) + '</span>';
    if (p === 'user') return '<a href="' + esc(link('users', { id: t })) + '">' + txt + '</a>';
    if (p === 'key') return '<a href="' + esc(link('keys', d.hint ? { q: d.hint } : { batch: t })) + '">' + txt + '</a>';
    if (p === 'request') return '<a href="' + esc(link('requests', { q: d.token || '', open: t })) + '">' + txt + '</a>';
    if (p === 'broker') return '<a href="' + esc(link('brokers', { q: d.slug || '' })) + '">' + txt + '</a>';
    if (p === 'contact') return '<a href="' + esc(link('contacts')) + '">' + txt + '</a>';
    return txt;
  }
  function auditTable(entries, caption, empty, withTarget) {
    return table(caption, [th('Date'), th('Administrateur'), th('Action')].concat(withTarget ? [th('Cible')] : []).concat([th('Détails'), th('IP')]), entries.map(function (a) {
      return '<tr>' + td('Date', '<span class="num">' + esc(stamp(a.created_at)) + '</span>') + td('Administrateur', esc(a.admin_email || '—')) + td('Action', '<strong>' + esc(ACTIONS[a.action] || a.action) + '</strong><span class="sub">' + esc(a.action) + '</span>') +
        (withTarget ? td('Cible', targetLink(a)) : '') + td('Détails', '<span class="adm-details">' + esc(summary(a)) + '</span>') + td('IP', '<span class="mono mono--plain">' + esc(a.ip || '—') + '</span>') + '</tr>';
    }).join(''), empty);
  }

  /* Version compacte pour les colonnes étroites (fiche compte, fiche demande) : une frise plutôt qu'un tableau. */
  function auditList(entries) {
    if (!entries || !entries.length) return '<p class="empty empty--sm">Aucune action enregistrée.</p>';
    return '<ol class="timeline timeline--tight">' + entries.map(function (a) { return '<li><time datetime="' + esc(a.created_at) + '">' + esc(stamp(a.created_at)) + SEP + esc(a.admin_email || '—') + '</time><span><strong>' + esc(ACTIONS[a.action] || a.action) + '</strong>' + (summary(a) !== '—' ? SEP + esc(summary(a)) : '') + '</span></li>'; }).join('') + '</ol>';
  }

  /* Graphique en barres (une série, SVG en ligne) : barres fines à sommet arrondi, valeurs directes sur le maximum
     et le dernier jour, info-bulle au survol et au clavier, tableau de données équivalent pour les lecteurs d'écran. */
  var CH = { H: 190, L: 36, R: 12, T: 24, B: 28 };
  function niceTop(max) { var s = [4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000]; for (var i = 0; i < s.length; i++) if (max <= s[i]) return s[i]; return Math.ceil(max / 10000) * 10000; }
  // Le cadre (légende, tableau équivalent) est rendu tout de suite ; le SVG est tracé à la largeur réelle par drawBars().
  function bars(series, one, many) {
    var n = series.length; if (!n) return '<p class="empty empty--sm">Pas de données.</p>';
    var total = series.reduce(function (a, s) { return a + s.n; }, 0);
    return '<figure class="adm-chart" data-chart data-one="' + esc(one) + '" data-many="' + esc(many) + '" data-series="' + esc(JSON.stringify(series)) + '"><div class="adm-chart__plot"></div>' +
      '<div class="adm-chart__tip" role="status" aria-live="polite" hidden></div>' +
      '<figcaption><span class="mono">' + pl(total, one, many) + ' en ' + n + NB + 'jours</span><span class="mono mono--plain">' + esc(dayLabel(series[0].day)) + ' – ' + esc(dayLabel(series[n - 1].day)) + '</span></figcaption>' +
      '<table class="vh"><caption>' + esc(many) + ' par jour</caption><thead><tr><th scope="col">Jour</th><th scope="col">Nombre</th></tr></thead><tbody>' + series.map(function (s) { return '<tr><td>' + esc(dayLabel(s.day)) + '</td><td>' + num(s.n) + '</td></tr>'; }).join('') + '</tbody></table></figure>';
  }
  function drawBars(fig) {
    var plot = $('.adm-chart__plot', fig), series = fig._series, n = series.length, one = fig.getAttribute('data-one'), many = fig.getAttribute('data-many');
    var W = Math.max(240, Math.floor(plot.clientWidth || 520)), H = CH.H, L = CH.L, R = CH.R, T = CH.T, B = CH.B;
    var vals = series.map(function (s) { return s.n; }), max = Math.max.apply(null, vals), top = niceTop(Math.max(1, max)), total = vals.reduce(function (a, b) { return a + b; }, 0);
    var slot = (W - L - R) / n, bw = Math.max(4, Math.min(22, slot - 8)), imax = vals.indexOf(max);
    var y = function (v) { return T + (H - T - B) * (1 - v / top); }, y0 = y(0), f = function (v) { return v.toFixed(1); };
    var grid = [top / 2, top].filter(function (v) { return v === Math.round(v); }).map(function (v) { return '<line class="adm-chart__grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + f(y(v)) + '" y2="' + f(y(v)) + '"/><text class="adm-chart__lbl" x="' + (L - 8) + '" y="' + f(y(v) + 4) + '" text-anchor="end">' + num(v) + '</text>'; }).join('');
    var marks = series.map(function (s, i) {
      var x = L + slot * i + (slot - bw) / 2, yt = y(s.n), r = Math.min(4, y0 - yt, bw / 2);
      var bar = s.n ? '<path class="adm-chart__bar" d="M' + f(x) + ' ' + f(y0) + 'V' + f(yt + r) + 'Q' + f(x) + ' ' + f(yt) + ' ' + f(x + r) + ' ' + f(yt) + 'H' + f(x + bw - r) + 'Q' + f(x + bw) + ' ' + f(yt) + ' ' + f(x + bw) + ' ' + f(yt + r) + 'V' + f(y0) + 'Z"/>' : '';
      var v = s.n && (i === imax || i === n - 1) ? '<text class="adm-chart__val" x="' + f(x + bw / 2) + '" y="' + f(yt - 7) + '" text-anchor="middle">' + num(s.n) + '</text>' : '';
      return '<g class="adm-chart__g" data-i="' + i + '"><rect class="adm-chart__hit" x="' + f(L + slot * i) + '" y="' + T + '" width="' + f(slot) + '" height="' + f(y0 - T) + '"/>' + bar + v + '</g>';
    }).join('');
    var xl = [0, Math.floor((n - 1) / 2), n - 1].map(function (i) { return '<text class="adm-chart__lbl" x="' + f(i === 0 ? L : i === n - 1 ? W - R : L + slot * (i + 0.5)) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + esc(dayLabel(series[i].day)) + '</text>'; }).join('');
    var sum = pl(total, one, many) + ' sur ' + n + NB + 'jours' + (max ? ', au plus ' + num(max) + ' le ' + dayLabel(series[imax].day) : '') + '.';
    plot.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" tabindex="0" aria-label="' + esc(sum + ' Flèches gauche et droite pour parcourir les jours.') + '">' + grid + '<line class="adm-chart__base" x1="' + L + '" x2="' + (W - R) + '" y1="' + f(y0) + '" y2="' + f(y0) + '"/>' + marks + xl + '</svg>';
    fig._geo = { W: W, slot: slot };
  }
  function wireCharts(root) {
    $$('[data-chart]', root).forEach(function (fig) {
      fig._series = JSON.parse(fig.getAttribute('data-series') || '[]'); drawBars(fig);
      var plot = $('.adm-chart__plot', fig), tip = $('.adm-chart__tip', fig), series = fig._series, n = series.length, idx = -1, one = fig.getAttribute('data-one'), many = fig.getAttribute('data-many');
      function show(i) {
        idx = Math.max(0, Math.min(n - 1, i)); var s = series[idx], g = fig._geo, svg = $('svg', plot);
        $$('.adm-chart__g', svg).forEach(function (el) { el.classList.toggle('is-on', Number(el.getAttribute('data-i')) === idx); });
        tip.textContent = ''; var b = document.createElement('b'); b.textContent = pl(s.n, one, many); tip.appendChild(b); tip.appendChild(document.createTextNode(' ' + dayLabel(s.day)));
        var cx = CH.L + g.slot * (idx + 0.5);
        tip.hidden = false; tip.style.left = (plot.offsetLeft + cx) + 'px'; tip.classList.toggle('is-right', cx > g.W * 0.7); tip.classList.toggle('is-left', cx < g.W * 0.2);
      }
      function hide() { idx = -1; tip.hidden = true; $$('.adm-chart__g.is-on', plot).forEach(function (el) { el.classList.remove('is-on'); }); }
      plot.addEventListener('pointermove', function (e) { var r = plot.getBoundingClientRect(); show(Math.floor((e.clientX - r.left - CH.L) / fig._geo.slot)); });
      plot.addEventListener('pointerleave', hide); plot.addEventListener('focusout', hide);
      plot.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); show(idx < 0 ? n - 1 : idx + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); show(idx < 0 ? n - 1 : idx - 1); }
        else if (e.key === 'Home') { e.preventDefault(); show(0); } else if (e.key === 'End') { e.preventDefault(); show(n - 1); } else if (e.key === 'Escape') hide();
      });
    });
  }
  /* Un tableau large ne fait défiler que son conteneur : celui-ci devient alors une région focalisable au clavier. */
  function fixWraps(root) {
    $$('.tbl-wrap', root).forEach(function (w) {
      if (w.scrollWidth > w.clientWidth + 1) { w.setAttribute('tabindex', '0'); w.setAttribute('role', 'region'); w.setAttribute('aria-label', w.getAttribute('data-label') || 'Tableau'); }
      else { w.removeAttribute('tabindex'); w.removeAttribute('role'); w.removeAttribute('aria-label'); }
    });
  }

  /* ---------- Vue d'ensemble ---------- */
  function stat(lbl, n, sub, cls) { return '<div class="ledger__stat"><span class="mono">' + lbl + '</span><span class="ledger__n num' + (cls ? ' ' + cls : '') + '">' + n + '</span><span class="ledger__sub">' + sub + '</span></div>'; }
  function health(v, text) { return '<div class="deadline"><b>' + v + '</b><span>' + text + '</span></div>'; }
  function outcomeButtons(id, note) { return '<div class="btn-row adm-quick">' + [['done', 'Effacée', ''], ['in_progress', 'En cours', ' btn--outline'], ['refused', 'Refus', ' btn--danger']].map(function (o) { return '<button class="btn btn--sm' + o[2] + '" type="button" data-outcome="' + o[0] + '" data-req="' + esc(id) + '"' + (note ? ' data-note="' + esc(note) + '"' : '') + '>' + o[1] + '</button>'; }).join('') + '</div>'; }
  function vOverview(s) {
    var rs = s.requests_by_status || {}, b = s.brokers || {}, sc = s.scheduler || {}, act = s.action_required || [], unverified = (b.active || 0) - (b.verified || 0), ks = s.keys || {};
    var notes = (s.demo ? '<p class="notice notice--info">Mode démo actif' + NB + ': les réponses des courtiers sont simulées.</p>' : '') +
      (s.mail_mode === 'smtp' && unverified > 0 ? '<p class="notice">' + pl(unverified, 'courtier actif a', 'courtiers actifs ont') + ' un contact non vérifié' + NB + ': aucune demande ne leur part en SMTP réel. <a href="' + esc(link('brokers', { f: 'unverified' })) + '">Vérifier les contacts</a></p>' : '');
    var ledger = '<section class="sheet adm-ledger" aria-label="Chiffres clés">' + stat('Utilisateurs', num(s.users), s.past_due ? pl(s.past_due, 'paiement en attente', 'paiements en attente') : 'comptes ouverts') + stat('Abonnés actifs', num(s.active), s.users ? Math.round(s.active / s.users * 100) + NNB + '% des comptes' : '—') + stat('Revenu mensuel', O.money(s.mrr_cents || 0), 'récurrent, TTC', 'is-money') + stat('Courriers', num(s.mails), 'envoyés au total') + '</section>';
    var pills = sheet('adm-st-h', 'Demandes par statut', meta(pl(s.requests_total, 'demande', 'demandes')), '<div class="adm-stats">' + STATUSES.filter(function (st) { return st !== 'error' || rs.error; }).map(function (st) { return '<a class="adm-stat" href="' + esc(link('requests', { status: st })) + '"><span class="adm-stat__n num">' + num(rs[st]) + '</span>' + chip(st) + '</a>'; }).join('') + '</div>');
    var charts = '<div class="adm-grid">' + sheet('adm-c1-h', 'Inscriptions', meta('14 derniers jours'), bars(s.signups_by_day || [], 'inscription', 'inscriptions')) + sheet('adm-c2-h', 'Courriers envoyés', meta('14 derniers jours'), bars(s.mails_by_day || [], 'courrier', 'courriers')) + '</div>';
    var hp = sheet('adm-hl-h', 'Santé du service', meta((s.mail_mode === 'smtp' ? 'SMTP' : 'Boîte d’envoi locale') + SEP + (s.billing_mode === 'stripe' ? 'Stripe' : 'Paiement simulé')), '<div class="adm-health">' +
      health(pct(s.done_rate), 'des demandes envoyées sont effacées') + health(days(s.median_days_to_done), 'délai médian avant effacement') +
      health(num(b.verified) + NB + '/' + NB + num(b.active), 'contacts de courtiers vérifiés') + health(sc.last_tick_at ? esc(O.fmtTime(sc.last_tick_at)) : '—', 'dernier passage du planificateur') +
      health(num(s.contacts_open), '<a href="' + esc(link('contacts', { status: 'open' })) + '">' + (s.contacts_open > 1 ? 'messages de contact à traiter' : 'message de contact à traiter') + '</a>') + health(num(s.newsletter), (s.newsletter > 1 ? 'inscrits' : 'inscrit') + ' à la lettre d’information') +
      health(num(ks.active), '<a href="' + esc(link('keys', { status: 'active' })) + '">' + (ks.active > 1 ? 'clés d’activation actives' : 'clé d’activation active') + '</a>') + health(num(ks.subscriptions), (ks.subscriptions > 1 ? 'abonnements offerts par clé en cours' : 'abonnement offert par clé en cours') + ', hors revenu') +
      (s.suspended ? health(num(s.suspended), '<a href="' + esc(link('security')) + '">' + (s.suspended > 1 ? 'comptes suspendus' : 'compte suspendu') + '</a>') : '') + (s.support_sessions ? health(num(s.support_sessions), s.support_sessions > 1 ? 'accès support en cours' : 'accès support en cours') : '') + '</div>');
    var shown = act.slice(0, 12);
    var ar = sheet('adm-ar-h', 'Vérifications en attente', meta(pl(act.length, 'demande', 'demandes')), table('Demandes en attente de vérification', [th('Courtier'), th('Abonné'), th('<span class="vh">Réponse</span>', 'act')], shown.map(function (r) {
      return '<tr>' + td('Courtier', '<strong>' + esc(r.broker) + '</strong><span class="sub"><a href="' + esc(link('requests', { q: r.token, open: r.id })) + '">OUBLI-' + esc(r.token) + '</a></span>') + td('Abonné', esc(r.email)) + td('', outcomeButtons(r.id), 'act') + '</tr>';
    }).join(''), 'Rien en attente.') + (act.length > shown.length ? '<div class="pager"><a href="' + esc(link('requests', { status: 'action_required' })) + '">Voir les ' + num(act.length) + NB + 'demandes</a></div>' : ''));
    return notes + ledger + '<div class="adm-grid">' + hp + pills + '</div>' + charts + ar;
  }

  /* ---------- Utilisateurs ---------- */
  function mandate(u) { return u.mandate_revoked_at ? 'Révoqué le ' + date(u.mandate_revoked_at) : u.mandate_signed_at ? 'Signé le ' + date(u.mandate_signed_at) : 'Non signé'; }
  function vUsers(d, q) {
    var c = d.counts || {};
    var bar = '<div class="adm-bar">' + searchForm('Rechercher un utilisateur', inp('adm-q', 'Rechercher', 'q', q.q, ' type="search" placeholder="e-mail, nom ou identifiant" autocomplete="off" maxlength="120" data-k="q"') + sel('adm-plan', 'Offre', 'plan', [['', 'Toutes']].concat(planOpts()), q.plan, ' data-autosubmit data-k="plan"')) + '<a class="btn btn--outline btn--sm" href="/api/admin/export.csv?what=users" download>Exporter (CSV)</a></div>';
    var f = filters('Filtrer par abonnement', 'status', [['', 'Tous', c.all], ['active', 'Actifs', c.active], ['past_due', 'Paiement en attente', c.past_due], ['canceled', 'Résiliés', c.canceled], ['none', 'Sans abonnement', c.none], ['admin', 'Administrateurs', c.admin], ['suspended', 'Suspendus', c.suspended], ['deleted', 'Supprimés', c.deleted]], q.status);
    var rows = d.users.map(function (u) {
      var del = !!u.deleted_at;
      return '<tr' + (del ? ' class="is-off"' : '') + '>' + td('Compte', '<a href="' + esc(href({ id: u.id })) + '" data-nav data-k="u-' + esc(u.id) + '"><strong>' + esc(del ? 'Compte supprimé' : u.email) + '</strong></a>' + (u.role === 'admin' ? ' <span class="badge">admin</span>' : '') + (u.suspended ? ' ' + chip('refused', 'Suspendu') : '') + '<span class="sub">' + esc(u.name || (del ? short(u.id) : 'Profil non renseigné')) + '</span>') +
        td('Offre', u.plan ? esc(planName(u.plan)) + '<span class="sub">' + (u.billing_mode === 'key' ? 'offerte par clé' : u.billing === 'annual' ? 'annuel' : u.billing === 'monthly' ? 'mensuel' : '') + '</span>' : '—') + td('Abonnement', chip(u.subscription_status, O.subLabel(u.subscription_status))) +
        td('Mandat', esc(mandate(u))) + td('Demandes', '<span class="num">' + num(u.done_n) + NB + '/' + NB + num(u.requests_n) + '</span><span class="sub">effacées</span>' + (u.action_required_n ? chip('action_required', num(u.action_required_n) + ' à vérifier') : '')) + td('Créé le', '<span class="num">' + date(u.created_at) + '</span>') + '</tr>';
    }).join('');
    return bar + f + sheet('adm-users-h', 'Comptes', meta(pl(d.total, 'résultat', 'résultats')), table('Liste des comptes', [th('Compte'), th('Offre'), th('Abonnement'), th('Mandat'), th('Demandes'), th('Créé le')], rows, 'Aucun compte ne correspond.') + pager(d));
  }
  function action(title, text, button) { return '<div class="adm-action"><div><strong>' + title + '</strong><span>' + text + '</span></div>' + button + '</div>'; }
  function vUser(d) {
    var u = d.user, del = !!u.deleted_at, self = O.state.user && O.state.user.id === u.id, rs = d.requests_by_status || {};
    var head = '<div class="adm-main-title"><div><a class="adm-back" href="' + esc(link('users')) + '" data-nav data-k="back"><span aria-hidden="true">←</span> Tous les utilisateurs</a><h2>' + esc(del ? 'Compte supprimé' : u.email) + '</h2></div><div class="btn-row">' + (u.suspended ? chip('refused', 'Suspendu') : '') + chip(u.subscription_status, O.subLabel(u.subscription_status)) + (u.role === 'admin' ? '<span class="badge">administrateur</span>' : '') + '</div></div>';
    var protectedAcc = del || self || u.role === 'admin', uid = esc(u.id);
    var susp = u.suspended ? '<div class="notice adm-banner" role="status"><p><strong>Compte suspendu</strong> depuis le ' + date(u.suspended_at) + (u.suspended_until ? ', jusqu’au ' + date(u.suspended_until) : ', sans date de fin') + '.' + (u.suspended_reason ? ' Motif' + NB + ': ' + esc(fr(u.suspended_reason)) + '.' : '') + ' La connexion est refusée et aucune demande ne part.</p><button class="btn btn--sm" type="button" data-unsuspend="' + uid + '" data-k="unsuspend">Réactiver le compte</button></div>' : '';
    var keyed = u.billing_mode === 'key', ks = d.keys || [], k0 = ks[0];
    var kv = '<dl class="kv"><dt>Identifiant</dt><dd class="mono mono--plain">' + esc(u.id) + '</dd><dt>Offre</dt><dd>' + (u.plan ? esc(planName(u.plan)) + SEP + (keyed ? 'offerte par clé' : u.billing === 'annual' ? 'annuel' : 'mensuel') : '—') + '</dd><dt>Paiement</dt><dd>' + esc(u.billing_mode === 'stripe' ? 'Stripe' : u.billing_mode === 'simulated' ? 'Simulé' : u.billing_mode === 'manual' ? 'Activé par l’équipe' : keyed ? 'Clé d’activation' + (k0 ? ' …' + k0.hint : '') : '—') + (u.stripe_customer ? '<span class="adm-sub">client ' + esc(u.stripe_customer) + (u.stripe_subscription ? SEP + 'abonnement ' + esc(u.stripe_subscription) : '') + '</span>' : '') + (keyed && k0 ? '<span class="adm-sub">activée le ' + esc(date(k0.redeemed_at)) + SEP + esc(planName(k0.plan)) + ', ' + esc(pl(k0.days, 'jour', 'jours')) + (k0.note ? SEP + esc(k0.note) : '') + '</span>' : '') + '</dd>' +
      (u.subscription_ends_at ? '<dt>Fin d’accès</dt><dd>' + date(u.subscription_ends_at) + '</dd>' : '') +
      (ks.length ? '<dt>Clés utilisées</dt><dd><ul class="adm-keyuses">' + ks.map(function (k) { return '<li><a class="mono mono--plain" href="' + esc(link('keys', { q: k.hint })) + '">…' + esc(k.hint) + '</a> ' + esc(planName(k.plan)) + ', ' + esc(pl(k.days, 'jour', 'jours')) + '<span class="adm-sub">activée le ' + esc(date(k.redeemed_at)) + ', jusqu’au ' + esc(date(k.ends_at)) + (k.revoked_at ? SEP + 'clé révoquée depuis' : '') + '</span></li>'; }).join('') + '</ul></dd>' : '') + '<dt>Mandat</dt><dd>' + esc(mandate(u)) + (u.mandate_version ? '<span class="adm-sub">version ' + esc(u.mandate_version) + (u.mandate_name ? SEP + 'signé «' + NB + esc(u.mandate_name) + NB + '»' : '') + '</span>' : '') + '</dd>' +
      '<dt>Créé le</dt><dd>' + stamp(u.created_at) + '</dd>' + (del ? '<dt>Supprimé le</dt><dd>' + stamp(u.deleted_at) + '</dd>' : '') + '<dt>Sessions</dt><dd>' + pl(d.sessions_n, 'session active', 'sessions actives') + '</dd><dt>Courriers</dt><dd><a href="' + esc(link('mails', { user: u.id })) + '">' + pl(d.mails_n, 'courrier', 'courriers') + '</a></dd></dl>';
    var acts = del ? '<p class="empty empty--sm">Compte supprimé' + NB + ': aucune action possible.</p>' : '<div class="adm-actions">' +
      action('Lancer les demandes', 'Crée les demandes manquantes pour les profils complets (mandat signé et abonnement actif requis).', '<button class="btn btn--outline btn--sm" type="button" data-user-act="launch" data-user="' + esc(u.id) + '" data-k="act-launch">Lancer</button>') +
      action('Exporter ses données', 'Export RGPD complet (JSON) : profils, demandes, journal, courriers. Journalisé.', '<a class="btn btn--outline btn--sm" href="/api/admin/users/' + uid + '/export" download>Exporter</a>') +
      action('Déconnecter tous les appareils', pl(d.sessions_n, 'session active', 'sessions actives') + (self ? ' (la vôtre est conservée).' : '.'), '<button class="btn btn--outline btn--sm" type="button" data-user-act="logout" data-user="' + esc(u.id) + '" data-k="act-logout">Déconnecter</button>') +
      (self ? '' : action(u.role === 'admin' ? 'Retirer le rôle administrateur' : 'Nommer administrateur', u.role === 'admin' ? 'Le compte perd l’accès à cette administration.' : 'Accès complet à l’administration, journalisé.', '<button class="btn btn--outline btn--sm" type="button" data-user-act="role" data-role="' + (u.role === 'admin' ? 'user' : 'admin') + '" data-user="' + esc(u.id) + '" data-k="act-role">' + (u.role === 'admin' ? 'Retirer' : 'Nommer') + '</button>') +
        action('Supprimer le compte', 'Résilie l’abonnement, efface profils, demandes, courriers et journal. Irréversible.', '<button class="btn btn--danger btn--sm" type="button" data-user-act="delete" data-user="' + esc(u.id) + '" data-k="act-delete">Supprimer</button>')) + '</div>';
    var subForm = del ? '' : '<form class="adm-subform adm-subform--plain" id="adm-sub-form" data-user="' + esc(u.id) + '" novalidate><div class="fields">' +
      sel('sub-status', 'Statut', 'status', SUBS, u.subscription_status) + sel('sub-plan', 'Offre', 'plan', [['', '—']].concat(planOpts()), u.plan) + sel('sub-billing', 'Périodicité', 'billing', [['monthly', 'Mensuelle']].concat(u.billing === 'annual' ? [['annual', 'Annuelle (ancienne formule)']] : []), u.billing || 'monthly') +
      inp('sub-ends', 'Fin d’accès', 'ends_at', u.subscription_ends_at ? u.subscription_ends_at.slice(0, 10) : '', ' type="date"', keyed ? 'Abonnement offert par clé' + NB + ': il s’arrête à cette date (videz-la pour un abonnement sans limite).' : 'Pour un abonnement résilié.') + inp('sub-note', 'Note interne', 'note', '', ' maxlength="200" autocomplete="off"', 'Visible dans le journal d’audit.') + '</div>' + msg() + '<div class="btn-row"><button class="btn btn--outline btn--sm" type="submit">Enregistrer l’abonnement</button></div></form>';
    var profiles = d.profiles.map(function (p) {
      var name = ((p.first_name || '') + ' ' + (p.last_name || '')).trim(), r = p.requests || {}, open = (r.queued || 0) + (r.sent || 0) + (r.in_progress || 0);
      return '<div class="adm-profile"><span class="avatar" aria-hidden="true">' + esc(initials(name)) + '</span><div><strong>' + esc(name || 'Profil non renseigné') + '</strong><small>' + (p.is_primary ? 'Profil principal' : 'Proche') + SEP + pl(p.emails.length, 'e-mail', 'e-mails') + SEP + pl(p.phones.length, 'téléphone', 'téléphones') + SEP + pl(p.addresses.length, 'adresse', 'adresses') + SEP + esc(p.country || '') + '</small></div><div class="adm-profile__st">' + (r.done ? chip('done', num(r.done) + ' effacées') : '') + (r.action_required ? chip('action_required', num(r.action_required) + ' à vérifier') : '') + (open ? chip('sent', num(open) + ' en cours') : '') + (r.refused ? chip('refused', num(r.refused) + ' refus') : '') + '</div></div>';
    }).join('');
    var reqs = table('Demandes du compte', [th('Référence'), th('Courtier'), th('Profil'), th('Statut'), th('Envoyée')], d.requests.map(function (r) {
      return '<tr>' + td('Référence', '<a href="' + esc(link('requests', { q: r.token, open: r.id })) + '" class="mono mono--plain">' + esc(r.ref) + '</a>') + td('Courtier', esc(r.broker)) + td('Profil', esc(r.profile)) + td('Statut', chip(r.status)) + td('Envoyée', '<span class="num">' + date(r.sent_at) + '</span>') + '</tr>';
    }).join(''), 'Aucune demande.');
    var total = STATUSES.reduce(function (a, s) { return a + (rs[s] || 0); }, 0);
    var access = protectedAcc ? '' : '<form class="sheet" id="adm-imp-form" data-user="' + uid + '" aria-labelledby="adm-imp-h" novalidate><div class="sheet__head"><h2 id="adm-imp-h">Accéder au compte</h2>' + meta('Lecture seule' + SEP + '30' + NB + 'min') + '</div><div class="sheet__body"><p class="hint adm-hint">Vous voyez l’application exactement comme l’abonné, sans pouvoir rien modifier. L’accès est journalisé et apparaît dans le journal de l’abonné.</p>' +
      inp('imp-reason', 'Motif', 'reason', '', ' required maxlength="200" autocomplete="off" placeholder="ex. ticket 1234, appel du 10 octobre"') + msg() + '</div><div class="sheet__foot"><button class="btn btn--outline" type="submit">Ouvrir en lecture seule</button><span class="mono">Visible par l’abonné</span></div></form>';
    var suspend = protectedAcc || u.suspended ? '' : '<form class="sheet" id="adm-sus-form" data-user="' + uid + '" aria-labelledby="adm-sus-h" novalidate><div class="sheet__head"><h2 id="adm-sus-h">Suspendre le compte</h2>' + meta('Réversible') + '</div><div class="sheet__body"><p class="hint adm-hint">Ferme toutes les sessions, refuse la connexion et met les envois en pause. Les données sont conservées.</p><div class="fields">' +
      inp('sus-reason', 'Motif (interne)', 'reason', '', ' required maxlength="300" autocomplete="off"') + inp('sus-until', 'Jusqu’au (facultatif)', 'until', '', ' type="date"', 'Sans date, jusqu’à réactivation.') + '</div><label class="check adm-check"><input type="checkbox" name="block_email"> <span>Bloquer aussi la réinscription avec cette adresse</span></label>' + msg() +
      '</div><div class="sheet__foot"><button class="btn btn--danger" type="submit">Suspendre</button><span class="mono">Journalisé</span></div></form>';
    var write = del ? '' : '<div class="adm-grid"><form class="sheet" id="adm-msg-form" data-user="' + uid + '" aria-labelledby="adm-msg-h" novalidate><div class="sheet__head"><h2 id="adm-msg-h">Écrire à l’abonné</h2>' + meta('Envoyé à ' + esc(u.email)) + '</div><div class="sheet__body"><div class="fields">' +
      inp('msg-subject', 'Objet', 'subject', '', ' required maxlength="160" autocomplete="off"') + '<div class="f f--full"><label for="msg-body">Message</label><textarea id="msg-body" name="body" class="adm-textarea" rows="5" maxlength="5000" required></textarea></div></div>' + msg() + '</div><div class="sheet__foot"><button class="btn btn--outline" type="submit">Envoyer</button><span class="mono">Signé «' + NB + 'L’équipe Oubli' + NB + '»</span></div></form>' +
      '<form class="sheet" id="adm-mail-form" data-user="' + uid + '" aria-labelledby="adm-mail-h" novalidate><div class="sheet__head"><h2 id="adm-mail-h">Adresse de connexion</h2></div><div class="sheet__body"><div class="fields">' + inp('mail-new', 'Nouvelle adresse', 'email', '', ' type="email" required maxlength="160" autocomplete="off" spellcheck="false"', 'L’ancienne adresse est prévenue par e-mail.') + '</div>' + msg() + '</div><div class="sheet__foot"><button class="btn btn--outline" type="submit">Remplacer l’adresse</button><span class="mono">Journalisé</span></div></form></div>';
    var sessions = sheet('adm-u-se', 'Sessions', meta(pl((d.sessions || []).length, 'session ouverte', 'sessions ouvertes')), sessionsTable(d.sessions || [], false));
    var notes = sheet('adm-u-no', 'Notes internes', meta('Visibles par les administrateurs seulement'), '<div class="sheet__body">' + ((d.notes || []).length ? '<ol class="adm-notes">' + d.notes.map(function (n) { return '<li><p>' + esc(n.body) + '</p><span class="adm-sub">' + esc(n.admin_email || '—') + SEP + esc(stamp(n.created_at)) + '</span><button class="btn btn--ghost" type="button" data-note-del="' + esc(n.id) + '">Supprimer<span class="vh"> la note du ' + esc(stamp(n.created_at)) + '</span></button></li>'; }).join('') + '</ol>' : '<p class="empty empty--sm">Aucune note.</p>') +
      '<form id="adm-note-form" class="adm-noteform" data-user="' + uid + '" novalidate><div class="f f--full"><label for="note-body">Nouvelle note</label><textarea id="note-body" name="body" class="adm-textarea" rows="3" maxlength="2000"></textarea></div>' + msg() + '<button class="btn btn--outline btn--sm" type="submit" data-k="note-add">Ajouter la note</button></form></div>');
    return head + susp + '<div class="adm-grid"><div class="adm-col">' + sheet('adm-u-acc', 'Compte', '', '<div class="sheet__body">' + kv + '</div>') + (subForm ? sheet('adm-u-sub', 'Modifier l’abonnement', meta('Journalisé'), '<div class="sheet__body">' + subForm + '</div>') : '') + '</div>' + sheet('adm-u-act', 'Actions', '', '<div class="sheet__body">' + acts + '</div>') + '</div>' +
      (access || suspend ? '<div class="adm-grid">' + access + suspend + '</div>' : '') + write + sessions + notes +
      sheet('adm-u-pr', 'Personnes protégées', meta(d.profiles.length + NB + '/' + NB + (u.plan === 'famille' ? 5 : 1)), profiles || '<p class="empty empty--sm">Aucun profil.</p>') +
      sheet('adm-u-rq', 'Demandes', '<a class="btn btn--outline btn--xs" href="' + esc(link('requests', { user: u.id })) + '">Toutes (' + num(total) + ')</a>', reqs) +
      '<div class="adm-grid">' + sheet('adm-u-ev', 'Journal de l’abonné', meta('30 derniers événements'), '<div class="sheet__body sheet__body--tight">' + timeline(d.events) + '</div>') + sheet('adm-u-au', 'Actions des administrateurs', meta('Journal d’audit'), '<div class="sheet__body sheet__body--tight">' + auditList(d.audit) + '</div>') + '</div>';
  }

  function sessionsTable(list, withUser) {
    return table('Sessions ouvertes', (withUser ? [th('Compte')] : []).concat([th('Appareil'), th('IP'), th('Dernière activité'), th('Statut'), th('<span class="vh">Action</span>', 'act')]), list.map(function (x) {
      return '<tr>' + (withUser ? td('Compte', '<a href="' + esc(link('users', { id: x.user_id })) + '"><span class="ell">' + esc(x.email) + '</span></a>') : '') + td('Appareil', esc(x.device) + '<span class="sub" title="' + esc(x.user_agent) + '">ouverte le ' + esc(stamp(x.created_at)) + '</span>') + td('IP', '<span class="mono mono--plain">' + esc(x.ip || '—') + '</span>') +
        td('Dernière activité', '<span class="num">' + esc(stamp(x.last_seen_at)) + '</span>') + td('Statut', x.support_by ? chip('action_required', 'Accès support') + '<span class="sub">par ' + esc(x.support_by) + '</span>' : x.current ? chip('active', 'Votre session') : chip('sent', 'Ouverte')) +
        td('', x.current ? '' : '<button class="btn btn--outline btn--xs" type="button" data-session="' + esc(x.handle) + '" data-user="' + esc(x.user_id) + '">Fermer<span class="vh"> la session ' + esc(x.device) + '</span></button>', 'act') + '</tr>';
    }).join(''), 'Aucune session ouverte.');
  }
  function vSecurity(d) {
    var sus = sheet('adm-sc1', 'Comptes suspendus', meta(pl(d.suspended.length, 'compte', 'comptes')), table('Comptes suspendus', [th('Compte'), th('Motif'), th('Depuis'), th('Jusqu’au'), th('<span class="vh">Action</span>', 'act')], d.suspended.map(function (u) {
      return '<tr>' + td('Compte', '<a href="' + esc(link('users', { id: u.id })) + '"><strong>' + esc(u.email) + '</strong></a>') + td('Motif', '<span class="adm-details">' + esc(fr(u.suspended_reason || '—')) + '</span>') + td('Depuis', '<span class="num">' + date(u.suspended_at) + '</span>') + td('Jusqu’au', '<span class="num">' + (u.suspended_until ? date(u.suspended_until) : 'sans date') + '</span>') +
        td('', '<button class="btn btn--outline btn--xs" type="button" data-unsuspend="' + esc(u.id) + '">Réactiver<span class="vh"> ' + esc(u.email) + '</span></button>', 'act') + '</tr>';
    }).join(''), 'Aucun compte suspendu.'));
    var block = '<section class="sheet" aria-labelledby="adm-sc2"><div class="sheet__head"><h2 id="adm-sc2">Liste de blocage</h2>' + meta('Refusées à l’inscription') + '</div><div class="sheet__body sheet__body--tight"><form id="adm-block-form" class="adm-search adm-blockform" novalidate>' +
      inp('block-pattern', 'Adresse ou domaine', 'pattern', '', ' required maxlength="160" autocomplete="off" spellcheck="false" placeholder="nom@exemple.fr ou @exemple.fr"') + inp('block-reason', 'Motif', 'reason', '', ' maxlength="200" autocomplete="off"') + '<button class="btn btn--outline btn--sm" type="submit" data-k="block-add">Bloquer</button>' + msg() + '</form></div>' +
      table('Adresses et domaines bloqués', [th('Adresse ou domaine'), th('Motif'), th('Ajouté par'), th('Le'), th('<span class="vh">Action</span>', 'act')], d.blocklist.map(function (b) {
        return '<tr>' + td('Bloqué', '<span class="mono mono--plain">' + esc(b.pattern) + '</span>') + td('Motif', '<span class="adm-details">' + esc(fr(b.reason || '—')) + '</span>') + td('Ajouté par', esc(b.created_by_email || '—')) + td('Le', '<span class="num">' + date(b.created_at) + '</span>') +
          td('', '<button class="btn btn--outline btn--xs" type="button" data-block-remove="' + esc(b.id) + '">Retirer<span class="vh"> ' + esc(b.pattern) + '</span></button>', 'act') + '</tr>';
      }).join(''), 'Aucune adresse bloquée.') + '</section>';
    var imp = sheet('adm-sc3', 'Accès support récents', meta('20 derniers'), table('Accès support récents', [th('Date'), th('Administrateur'), th('Compte'), th('Motif')], d.impersonations.map(function (a) {
      return '<tr>' + td('Date', '<span class="num">' + esc(stamp(a.created_at)) + '</span>') + td('Administrateur', esc(a.admin_email || '—')) + td('Compte', a.user_email ? '<a href="' + esc(link('users', { id: a.target })) + '">' + esc(a.user_email) + '</a>' : '—') + td('Motif', '<span class="adm-details">' + esc(fr((a.details && a.details.reason) || '—')) + '</span>') + '</tr>';
    }).join(''), 'Aucun accès support.'));
    var ses = sheet('adm-sc4', 'Sessions actives', meta(pl(d.sessions_total, 'session', 'sessions') + ', 50 plus récentes'), sessionsTable(d.sessions, true));
    return sus + block + imp + ses;
  }

  /* ---------- Clés d’activation ---------- */
  // Le dernier lot créé (clés en clair) ne vit qu'en mémoire : affiché au-dessus de la liste jusqu'à « Masquer les clés »
  // ou jusqu'à la sortie de l'onglet. Le serveur ne le renverra jamais.
  var freshKeys = null;
  var KEY_ST = { active: ['active', 'Active'], used: ['sent', 'Utilisée'], expired: ['none', 'Expirée'], revoked: ['refused', 'Révoquée'] };
  var DAYS_SHORTCUTS = [30, 90, 365];
  function keyChip(st) { var k = KEY_ST[st] || ['none', st]; return chip(k[0], k[1]); }
  function shareLink(key) { return location.origin + '/app/#signup?key=' + encodeURIComponent(key); }
  function keyForm() {
    return '<form class="sheet" id="adm-key-form" aria-labelledby="adm-kf-h" novalidate><div class="sheet__head"><h2 id="adm-kf-h">Créer des clés</h2>' + meta('Abonnement offert, sans paiement') + '</div><div class="sheet__body"><div class="fields adm-keyfields">' +
      inp('key-count', 'Nombre de clés', 'count', '1', ' type="number" inputmode="numeric" min="1" max="100" step="1" required', 'De 1 à 100 par lot.') + sel('key-plan', 'Offre', 'plan', planOpts(), 'individuel') +
      '<div class="f"><label for="key-days">Durée offerte (jours)</label><input id="key-days" name="days" value="30" type="number" inputmode="numeric" min="1" max="730" step="1" required aria-describedby="key-days-hint"><span class="hint" id="key-days-hint">De 1 à 730' + NB + 'jours, comptés depuis l’activation.</span>' +
      '<div class="adm-days" role="group" aria-label="Durées courantes">' + DAYS_SHORTCUTS.map(function (n) { return '<button class="btn btn--outline btn--xs" type="button" data-key-days="' + n + '" aria-pressed="' + (n === 30) + '">' + n + NB + 'jours</button>'; }).join('') + '</div></div>' +
      inp('key-uses', 'Utilisations par clé', 'max_uses', '1', ' type="number" inputmode="numeric" min="1" max="1000" step="1" required', '1 pour une clé personnelle, jusqu’à 1' + NNB + '000.') +
      inp('key-until', 'Date limite (facultative)', 'expires_at', '', ' type="date"', 'Passé ce jour, la clé ne s’active plus.') +
      inp('key-note', 'Note', 'note', '', ' maxlength="120" autocomplete="off" placeholder="ex. amis, Noël 2026"', 'Visible par l’équipe seulement (120' + NB + 'caractères au plus).') +
      '</div>' + msg() + '</div><div class="sheet__foot"><button class="btn" type="submit">Créer les clés</button><span class="mono">Affichées une seule fois</span></div></form>';
  }
  function freshPanel(f) {
    var rows = f.keys.map(function (k, i) {
      return '<tr>' + td('Clé', '<code class="adm-key">' + esc(k.key) + '</code>') + td('Lien de partage', '<span class="adm-link">' + esc(shareLink(k.key)) + '</span>') +
        td('', '<button class="btn btn--outline btn--xs" type="button" data-key-copy="' + i + '">Copier le lien<span class="vh"> de la clé …' + esc(k.hint) + '</span></button>', 'act') + '</tr>';
    }).join('');
    var what = planName(f.plan) + SEP + pl(f.days, 'jour', 'jours') + SEP + pl(f.max_uses, 'utilisation', 'utilisations') + ' par clé' + (f.expires_at ? SEP + 'jusqu’au ' + date(f.expires_at) : '');
    return '<section class="sheet adm-fresh" aria-labelledby="adm-fresh-h" tabindex="-1" data-k="keys-fresh"><div class="sheet__head"><h2 id="adm-fresh-h">' + pl(f.keys.length, 'clé créée', 'clés créées') + '</h2>' + meta('Lot ' + esc(f.batch)) + '</div>' +
      '<div class="sheet__body sheet__body--tight"><p class="notice"><strong>Copiez-les maintenant' + NB + ':</strong> elles ne seront plus affichées. Seul leur indice (les 4' + NB + 'derniers caractères) reste visible ensuite.</p><p class="adm-sub adm-fresh__what">' + esc(what) + '</p></div>' +
      table('Clés créées et liens de partage', [th('Clé'), th('Lien de partage'), th('<span class="vh">Copier</span>', 'act')], rows, '') +
      '<div class="sheet__foot"><div class="btn-row"><button class="btn btn--sm" type="button" data-keys-copy>Copier tout</button><button class="btn btn--outline btn--sm" type="button" data-keys-csv>Télécharger (CSV)</button></div><button class="btn btn--ghost" type="button" data-keys-hide>Masquer les clés</button></div></section>';
  }
  function vKeys(d, q) {
    var c = d.counts || {};
    var bar = '<div class="adm-bar">' + searchForm('Rechercher une clé', inp('adm-q', 'Rechercher', 'q', q.q, ' type="search" placeholder="indice, note, lot ou e-mail" autocomplete="off" maxlength="120" data-k="q"')) + '</div>';
    var f = filters('Filtrer les clés par statut', 'status', [['', 'Toutes', c.all], ['active', 'Actives', c.active], ['used', 'Utilisées', c.used], ['expired', 'Expirées', c.expired], ['revoked', 'Révoquées', c.revoked]], q.status);
    var scope = /^[0-9A-F]{8}$/.test(String(q.batch || '')) ? '<p class="notice notice--info">Clés du lot ' + esc(q.batch) + SEP + '<a href="' + esc(href({ batch: null, page: null })) + '" data-nav data-k="scope-batch">retirer ce filtre</a></p>' : '';
    var rows = d.keys.map(function (k) {
      var id = esc(k.id), reds = k.redemptions || [];
      var who = reds.length ? '<ul class="adm-redeemers">' + reds.map(function (r) { return '<li>' + (r.deleted ? '<span>Compte supprimé</span>' : '<a href="' + esc(link('users', { id: r.user_id })) + '"><span class="ell">' + esc(r.email) + '</span></a>') + '<span class="sub">le ' + esc(date(r.redeemed_at)) + '</span></li>'; }).join('') +
        (k.uses > reds.length ? '<li class="sub">et ' + pl(k.uses - reds.length, 'autre compte', 'autres comptes') + '</li>' : '') + '</ul>' : '<span>Aucune activation</span>';
      var revoke = k.status === 'active' ? '<button class="btn btn--outline btn--xs adm-revoke" type="button" data-key-revoke="' + id + '" data-hint="' + esc(k.hint) + '" data-k="krev-' + id + '">Révoquer<span class="vh"> la clé …' + esc(k.hint) + '</span></button>' : '';
      return '<tr' + (k.status === 'active' ? '' : ' class="is-off"') + '>' +
        td('Indice', '<strong class="mono mono--plain adm-k" tabindex="-1" data-k="kb-' + id + '">…' + esc(k.hint) + '</strong><span class="sub">lot' + NB + esc(k.batch) + '</span>') +
        td('Offre', esc(planName(k.plan)) + '<span class="sub">' + pl(k.days, 'jour', 'jours') + '</span>') +
        td('Note', k.note ? '<span class="adm-details">' + esc(k.note) + '</span>' : '—') +
        td('Dates', '<span class="num">créée le ' + esc(date(k.created_at)) + '</span><span class="sub">' + (k.expires_at ? 'limite ' + esc(date(k.expires_at)) : 'sans date limite') + '</span>') +
        td('Statut', keyChip(k.status) + '<span class="sub num">' + num(k.uses) + NB + '/' + NB + pl(k.max_uses, 'utilisation', 'utilisations') + '</span>' + revoke) +
        td('Comptes', who) + '</tr>';
    }).join('');
    var heads = [th('Indice'), th('Offre et durée'), th('Note'), th('Création et limite'), th('Statut et utilisations'), th('Comptes')];
    return (freshKeys ? freshPanel(freshKeys) : '') + keyForm() + bar + f + scope +
      sheet('adm-keys-h', 'Clés', meta(pl(d.total, 'résultat', 'résultats') + SEP + pl(d.subscriptions, 'abonnement offert en cours', 'abonnements offerts en cours')), table('Clés d’activation', heads, rows, 'Aucune clé ne correspond.') +
        '<p class="adm-keys__foot">La révocation empêche toute nouvelle activation' + NB + '; les abonnements déjà accordés vont à leur terme (modifiables depuis la fiche du compte).</p>' + pager(d));
  }
  function csvCell(v) { var s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s; return /[",;\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function keysCsv(f) {
    var rows = f.keys.map(function (k) { return [k.key, shareLink(k.key), planName(f.plan), f.days, f.max_uses, f.expires_at ? f.expires_at.slice(0, 10) : '', f.note || '', f.batch]; });
    return '\ufeff' + [['cle', 'lien', 'offre', 'jours', 'utilisations', 'date_limite', 'note', 'lot']].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }
  function downloadText(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type })), a = document.createElement('a');
    a.href = url; a.download = name; a.hidden = true; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  // Presse-papiers (contexte sécurisé), sinon copie par sélection ; le focus revient au bouton.
  function copyText(text, okText, btn) {
    function fallback() {
      var ta = document.createElement('textarea'), ok = false; ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'vh'; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove(); if (btn) btn.focus();
      if (ok) toast(okText); else toast('Copie impossible' + NB + ': sélectionnez le texte à la main.', true);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast(okText); }, fallback); else fallback();
  }

  /* ---------- Demandes ---------- */
  function vRequests(d, q) {
    var c = d.counts || {}, open = (c.queued || 0) + (c.sent || 0) + (c.in_progress || 0) + (c.action_required || 0), all = STATUSES.reduce(function (a, s) { return a + (c[s] || 0); }, 0);
    var bar = '<div class="adm-bar">' + searchForm('Rechercher une demande', inp('adm-q', 'Rechercher', 'q', q.q, ' type="search" placeholder="référence, e-mail, courtier, nom" autocomplete="off" maxlength="120" data-k="q"') + sel('adm-sort', 'Trier', 'sort', SORTS, q.sort || 'created_desc', ' data-autosubmit data-k="sort"')) + '<a class="btn btn--outline btn--sm" href="/api/admin/export.csv?what=requests" download>Exporter (CSV)</a></div>';
    var f = filters('Filtrer par statut', 'status', [['', 'Toutes', all], ['open', 'Ouvertes', open]].concat(STATUSES.filter(function (s) { return s !== 'error' || c.error || q.status === 'error'; }).map(function (s) { return [s, O.statusLabel(s), c[s] || 0]; })).concat(c.review || q.status === 'review' ? [['review', 'À vérifier', c.review || 0]] : []), q.status);
    var scope = '';
    if (safeId(q.user)) scope += '<p class="notice notice--info">Demandes du compte ' + esc(d.requests[0] ? d.requests[0].email : short(q.user)) + SEP + '<a href="' + esc(href({ user: null, page: null })) + '" data-nav data-k="scope-user">retirer ce filtre</a></p>';
    if (q.broker) scope += '<p class="notice notice--info">Demandes adressées à ' + esc(d.requests[0] ? d.requests[0].broker : q.broker) + SEP + '<a href="' + esc(href({ broker: null, page: null })) + '" data-nav data-k="scope-broker">retirer ce filtre</a></p>';
    var bulk = '<div class="bulk" id="adm-bulk" hidden><strong id="bulk-n"></strong><label class="vh" for="bulk-outcome">Résultat à appliquer</label><select id="bulk-outcome" class="adm-select"><option value="">Résultat…</option>' + OUTCOMES.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select><label class="vh" for="bulk-note">Note</label><input id="bulk-note" class="adm-input" maxlength="300" placeholder="Note (facultative)" autocomplete="off"><button class="btn btn--sm" type="button" data-bulk-apply>Appliquer</button><button class="btn btn--ghost" type="button" data-bulk-clear>Désélectionner</button></div>';
    var rows = d.requests.map(function (r) {
      return '<tr data-req-row="' + esc(r.id) + '">' + td('', '<label class="tbl__check-l"><input type="checkbox" data-sel="' + esc(r.id) + '"><span class="vh">Sélectionner ' + esc(r.ref) + '</span></label>', 'tbl__check') +
        td('Référence', '<button type="button" class="btn btn--text adm-ref" data-req-open="' + esc(r.id) + '" data-k="req-' + esc(r.id) + '" aria-expanded="false" aria-controls="req-x-' + esc(r.id) + '"><span class="mono mono--plain">' + esc(r.ref) + '</span><span class="vh">' + NB + ': détails</span></button><span class="sub">cycle ' + r.cycle + '</span>') +
        td('Courtier', '<strong>' + esc(r.broker) + '</strong><span class="sub">' + esc(label(BASES, r.legal_basis)) + '</span>') + td('Abonné', '<span class="ell">' + esc(r.email) + '</span><span class="sub">' + esc(r.profile) + '</span>') +
        td('Statut', chip(r.status)) + td('Suivi', followup(r)) + '</tr>';
    }).join('');
    var heads = [th('<label class="tbl__check-l"><input type="checkbox" data-sel-all><span class="vh">Tout sélectionner sur cette page</span></label>', 'tbl__check'), th('Référence'), th('Courtier'), th('Abonné'), th('Statut'), th('Suivi')];
    return bar + f + scope + sheet('adm-rq-h', 'Demandes', meta(pl(d.total, 'résultat', 'résultats')), bulk + table('Liste des demandes', heads, rows, 'Aucune demande ne correspond.') + pager(d));
  }
  function followup(r) {
    var d = function (iso) { return iso ? O.fmtDate(iso, { day: 'numeric', month: 'short' }) : '—'; };
    if (r.status === 'done') return '<span class="num">Effacée le ' + d(r.completed_at) + '</span>' + (r.next_check_at ? '<span class="sub">revérif. le ' + date(r.next_check_at) + '</span>' : '');
    if (!r.sent_at) return '<span>À envoyer</span><span class="sub">créée le ' + d(r.created_at) + '</span>';
    return '<span class="num">Envoyée le ' + d(r.sent_at) + '</span>' + (r.due_at ? '<span class="sub">échéance ' + d(r.due_at) + '</span>' : '');
  }
  function vRequestDetail(d) {
    var r = d.request, b = d.broker || {}, id = esc(r.id);
    var kv = '<dl class="kv"><dt>Statut</dt><dd>' + chip(r.status) + '</dd><dt>Abonné</dt><dd><a href="' + esc(link('users', { id: r.user_id })) + '">' + esc(r.email) + '</a><span class="adm-sub">' + esc(r.profile) + '</span></dd>' +
      '<dt>Courtier</dt><dd>' + esc(b.name || r.broker) + '<span class="adm-sub">' + esc(b.domain || '') + SEP + esc(b.jurisdiction || '') + SEP + esc(label(BASES, b.legal_basis || r.legal_basis)) + '</span></dd>' +
      '<dt>Contact</dt><dd><span class="mono mono--plain">' + esc(b.contact_email || '—') + '</span> ' + (b.contact_verified ? chip('done', 'Vérifié') : chip('none', 'Non vérifié')) + '</dd>' +
      '<dt>Créée</dt><dd>' + stamp(r.created_at) + '</dd><dt>Envoyée</dt><dd>' + stamp(r.sent_at) + '</dd><dt>Échéance</dt><dd>' + date(r.due_at) + '</dd>' + (r.followup_sent_at ? '<dt>Relance</dt><dd>' + stamp(r.followup_sent_at) + '</dd>' : '') +
      (r.completed_at ? '<dt>Effacée</dt><dd>' + stamp(r.completed_at) + '</dd>' : '') + (r.next_check_at ? '<dt>Revérification</dt><dd>' + date(r.next_check_at) + '</dd>' : '') + (r.note ? '<dt>Note</dt><dd>' + esc(fr(r.note)) + '</dd>' : '') +
      (r.review_at ? '<dt>À vérifier</dt><dd>' + reviewText(r) + '</dd>' : '') + '</dl>';
    var form = '<form class="adm-outcome" data-outcome-form="' + id + '" novalidate><h3>Enregistrer une réponse</h3><fieldset class="adm-radios"><legend class="vh">Résultat</legend>' + OUTCOMES.map(function (o) { return '<label class="adm-radio"><input type="radio" name="outcome" value="' + o[0] + '"> ' + o[1] + '</label>'; }).join('') + '</fieldset>' +
      inp('out-' + id + '-note', 'Note (facultative)', 'note', '', ' maxlength="300" autocomplete="off" placeholder="ex. confirmation reçue par e-mail"') + msg() +
      '<div class="btn-row"><button class="btn btn--sm" type="submit">Enregistrer</button><button class="btn btn--outline btn--sm" type="button" data-req-resend="' + id + '">Renvoyer la demande</button></div></form>';
    var mails = d.mails.length ? d.mails.map(function (m) { return '<details class="adm-mail"><summary>' + esc(m.subject) + '<span class="sub">' + esc(stamp(m.created_at)) + SEP + 'à ' + esc(m.to_addr) + SEP + (m.mode === 'smtp' ? 'SMTP' : 'boîte d’envoi locale') + '</span></summary><div class="mail-body" tabindex="0" role="region" aria-label="' + esc('Courrier du ' + stamp(m.created_at)) + '">' + esc(m.body) + '</div></details>'; }).join('') : '<p class="empty empty--sm">Aucun courrier envoyé.</p>';
    return '<div class="adm-expand__grid"><div>' + kv + '</div>' + form + '</div><div class="adm-expand__grid"><div><h3>Courriers</h3>' + mails + '</div><div><h3>Journal</h3>' + timeline(d.events) + '</div></div>' +
      (d.audit && d.audit.length ? '<div><h3>Actions des administrateurs</h3>' + auditList(d.audit) + '</div>' : '');
  }
  function openRequest(id) {
    id = safeId(id); var row = id && $('[data-req-row="' + id + '"]'), btn = row && $('[data-req-open]', row); if (!btn) return;
    var ex = document.getElementById('req-x-' + id);
    if (ex) { ex.closest('tr').remove(); btn.setAttribute('aria-expanded', 'false'); return; }
    lock(btn, true);
    api('/admin/requests/' + id).then(function (d) {
      if (document.getElementById('req-x-' + id)) return;
      var tr = document.createElement('tr'); tr.className = 'tbl__expand';
      tr.innerHTML = '<td colspan="6"><div class="adm-expand" id="req-x-' + esc(id) + '" role="region" aria-label="' + esc('Demande ' + d.request.ref) + '">' + vRequestDetail(d) + '</div></td>';
      row.parentNode.insertBefore(tr, row.nextSibling); btn.setAttribute('aria-expanded', 'true');
    }).catch(fail).finally(function () { lock(btn, false); });
  }
  function bulkState() {
    var boxes = $$('[data-sel]'), ids = boxes.filter(function (i) { return i.checked; }).map(function (i) { return i.getAttribute('data-sel'); }), bar = $('#adm-bulk'), all = $('[data-sel-all]');
    boxes.forEach(function (i) { i.closest('tr').classList.toggle('is-selected', i.checked); });
    if (bar) { bar.hidden = !ids.length; $('#bulk-n').textContent = pl(ids.length, 'demande sélectionnée', 'demandes sélectionnées'); }
    if (all) { all.checked = !!ids.length && ids.length === boxes.length; all.indeterminate = !!ids.length && !all.checked; }
    return ids;
  }

  /* ---------- Courtiers ---------- */
  function brokerForm(b) {
    var p = b ? 'b' + b.id : 'bnew', v = b || { jurisdiction: 'FR', legal_basis: 'rgpd', sensitivity: 2, recheck_days: 60, active: 1, contact_verified: 0 };
    return '<form class="adm-expand" data-broker-form="' + (b ? b.id : 'new') + '" novalidate><div class="fields">' +
      inp(p + '-name', 'Nom', 'name', v.name, ' required maxlength="120" autocomplete="off"') + inp(p + '-slug', 'Identifiant (slug)', 'slug', v.slug, ' required maxlength="60" autocomplete="off" spellcheck="false"', 'Minuscules, chiffres et tirets.') +
      inp(p + '-domain', 'Domaine', 'domain', v.domain, ' required maxlength="120" autocomplete="off" placeholder="exemple.com" spellcheck="false"') + inp(p + '-category', 'Catégorie', 'category', v.category, ' required maxlength="60" list="adm-cats" autocomplete="off"') +
      sel(p + '-jurisdiction', 'Juridiction', 'jurisdiction', JUR, v.jurisdiction) + sel(p + '-legal_basis', 'Base légale', 'legal_basis', BASES, v.legal_basis) + sel(p + '-sensitivity', 'Sensibilité', 'sensitivity', SENS, v.sensitivity) +
      inp(p + '-recheck_days', 'Revérification (jours)', 'recheck_days', v.recheck_days, ' type="number" min="7" max="365" required') +
      inp(p + '-contact_email', 'Adresse de contact', 'contact_email', v.contact_email, ' type="email" required maxlength="160" autocomplete="off" spellcheck="false" data-contact-email', b ? 'Une nouvelle adresse doit être vérifiée de nouveau.' : '') + '</div>' +
      '<div class="adm-checks"><label class="check"><input type="checkbox" name="contact_verified"' + (v.contact_verified ? ' checked' : '') + '> <span>Contact vérifié par un administrateur (autorise l’envoi en SMTP réel)</span></label><label class="check"><input type="checkbox" name="active"' + (v.active ? ' checked' : '') + '> <span>Actif' + NB + ': inclus dans les nouvelles demandes</span></label></div>' + msg() +
      '<div class="btn-row"><button class="btn btn--sm" type="submit">' + (b ? 'Enregistrer le courtier' : 'Créer le courtier') + '</button><button class="btn btn--outline btn--sm" type="button" data-broker-cancel="' + (b ? b.id : 'new') + '">Annuler</button></div></form>';
  }
  function vBrokers(d, q) {
    brokersById = {}; d.brokers.forEach(function (b) { brokersById[b.id] = b; });
    var s = String(q.q || '').trim().toLowerCase(), f = q.f || '', cat = q.cat || '', smtp = O.state.config && O.state.config.mail === 'smtp';
    var unverified = d.brokers.filter(function (b) { return b.active && !b.contact_verified; }).length, inactive = d.brokers.length - d.active, customN = d.brokers.filter(function (b) { return b.custom; }).length;
    var list = d.brokers.filter(function (b) {
      return (!s || (b.name + ' ' + b.domain + ' ' + b.slug + ' ' + b.category + ' ' + b.contact_email).toLowerCase().indexOf(s) >= 0) && (!cat || b.category === cat) &&
        (f === 'unverified' ? b.active && !b.contact_verified : f === 'inactive' ? !b.active : f === 'active' ? !!b.active : f === 'custom' ? !!b.custom : true);
    });
    var bar = '<div class="adm-bar">' + searchForm('Rechercher un courtier', inp('adm-q', 'Rechercher', 'q', q.q, ' type="search" placeholder="nom, domaine, contact" autocomplete="off" maxlength="120" data-k="q"') + sel('adm-cat', 'Catégorie', 'cat', [['', 'Toutes']].concat(d.categories.map(function (c) { return [c, c]; })), cat, ' data-autosubmit data-k="cat"')) +
      '<button class="btn btn--sm" type="button" id="broker-new-toggle" aria-expanded="false" aria-controls="broker-new" data-k="new">Nouveau courtier</button></div>';
    var fl = filters('Filtrer les courtiers', 'f', [['', 'Tous', d.total], ['active', 'Actifs', d.active], ['unverified', 'Contact à vérifier', unverified], ['custom', 'Ajoutés par les abonnés', customN], ['inactive', 'Inactifs', inactive]], f);
    var warn = smtp && unverified ? '<p class="notice">En SMTP réel, aucun courrier ne part vers les ' + pl(unverified, 'courtier', 'courtiers') + ' dont le contact n’est pas vérifié.</p>' : '';
    var create = '<section class="sheet" id="broker-new" aria-labelledby="broker-new-h" hidden><div class="sheet__head"><h2 id="broker-new-h">Nouveau courtier</h2>' + meta('Ajouté au registre') + '</div><div class="sheet__body">' + brokerForm(null) + '</div></section>';
    var rows = list.map(function (b) {
      var id = esc(b.id);
      return '<tr data-broker-row="' + id + '"' + (b.active ? '' : ' class="is-off"') + '>' + td('Courtier', '<strong>' + esc(b.name) + '</strong>' + (b.custom ? ' ' + chip('sent', 'Ajouté') : '') + '<span class="sub">' + esc(b.domain) + SEP + esc(b.category) + '</span>') +
        td('Juridiction', '<span class="adm-jur">' + esc(b.jurisdiction) + O.dots(b.sensitivity) + '</span><span class="sub">' + esc(label(BASES, b.legal_basis)) + '</span>') +
        td('Contact', '<span class="ell mono mono--plain" title="' + esc(b.contact_email) + '">' + esc(b.contact_email) + '</span><label class="adm-verify' + (b.contact_verified ? ' is-on' : '') + '"><input type="checkbox" data-verify="' + id + '"' + (b.contact_verified ? ' checked' : '') + '> vérifié<span class="vh"> (' + esc(b.name) + ')</span></label>' + (b.custom ? '<span class="sub">' + esc(b.discovery_status === 'pending' ? 'recherche en cours' : b.contact_source === 'site' ? 'publiée par le site' : b.contact_source === 'admin' ? 'saisie par l’équipe' : 'présumée') + '</span>' + (b.contact_page ? '<a class="adm-sub" href="' + esc(b.contact_page) + '" target="_blank" rel="noopener noreferrer">page source</a>' : '') : '')) +
        td('Résultats', '<span class="num">' + num(b.done) + NB + '/' + NB + num(b.sent) + '</span><span class="sub">effacées' + (b.refused ? SEP + num(b.refused) + ' refus' : '') + (b.avg_days_to_done != null ? SEP + days(b.avg_days_to_done) : '') + '</span>') +
        td('Statut', b.active ? chip('active', 'Actif') : chip('none', 'Inactif')) +
        td('', '<div class="adm-acts">' + (b.custom ? '<button class="btn btn--outline btn--xs" type="button" data-broker-discover="' + id + '" data-k="bdisc-' + id + '">Chercher le contact<span class="vh"> de ' + esc(b.name) + '</span></button>' : '') + '<button class="btn btn--outline btn--xs" type="button" data-broker-edit="' + id + '" data-k="bedit-' + id + '" aria-expanded="false" aria-controls="b-x-' + id + '">Modifier<span class="vh"> ' + esc(b.name) + '</span></button><button class="btn btn--outline btn--xs" type="button" data-broker-test="' + id + '">Tester<span class="vh"> le contact de ' + esc(b.name) + '</span></button><button class="btn btn--' + (b.active ? 'danger' : 'outline') + ' btn--xs" type="button" data-broker-active="' + (b.active ? 0 : 1) + '" data-broker="' + id + '" data-k="bact-' + id + '">' + (b.active ? 'Désactiver' : 'Réactiver') + '<span class="vh"> ' + esc(b.name) + '</span></button></div>', 'act') + '</tr>';
    }).join('');
    return '<datalist id="adm-cats">' + d.categories.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' + bar + fl + warn + create +
      sheet('adm-br-h', 'Registre', meta(num(d.verified) + NB + '/' + NB + num(d.active) + ' contacts vérifiés'), table('Registre des courtiers', [th('Courtier'), th('Juridiction'), th('Contact'), th('Résultats'), th('Statut'), th('<span class="vh">Actions</span>', 'act')], rows, 'Aucun courtier ne correspond.') + '<div class="pager"><span>' + pl(list.length, 'courtier affiché', 'courtiers affichés') + ' sur ' + num(d.total) + '</span></div>');
  }
  // Désactivation : demandes jamais envoyées arrêtées par le serveur (réponse { stopped }).
  function stoppedText(r) { return r && r.stopped ? ', ' + pl(r.stopped, 'demande en attente arrêtée', 'demandes en attente arrêtées') : ''; }
  function brokerPayload(form) {
    var o = {}; new FormData(form).forEach(function (v, k) { o[k] = typeof v === 'string' ? v.trim() : v; });
    o.sensitivity = Number(o.sensitivity); o.recheck_days = Number(o.recheck_days);
    o.contact_verified = form.querySelector('[name="contact_verified"]').checked; o.active = form.querySelector('[name="active"]').checked;
    return o;
  }
  var FIELD_HINTS = [[/motif/i, 'reason'], [/date/i, 'until'], [/objet/i, 'subject'], [/message|note/i, 'body'], [/annonce/i, 'text'], [/domaine précédé|liste de blocage|adresse|compte existe/i, 'pattern'], [/adresse|compte existe/i, 'email'], [/slug/i, 'slug'], [/domaine/i, 'domain'], [/nom/i, 'name'], [/catégorie/i, 'category'], [/contact/i, 'contact_email'], [/revérification/i, 'recheck_days'], [/sensibilité/i, 'sensitivity'], [/juridiction/i, 'jurisdiction'], [/base légale/i, 'legal_basis']];
  function formError(form, text, field) {
    var m = $('.msg', form); if (m) { m.textContent = fr(text); m.classList.add('is-error'); }
    $$('[aria-invalid="true"]', form).forEach(function (i) { i.removeAttribute('aria-invalid'); });
    if (!field) FIELD_HINTS.some(function (h) { if (h[0].test(text)) field = form.querySelector('[name="' + h[1] + '"]'); return !!field; });
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }
  function formOk(form) { var m = $('.msg', form); if (m) { m.textContent = ''; m.classList.remove('is-error'); } $$('[aria-invalid="true"]', form).forEach(function (i) { i.removeAttribute('aria-invalid'); }); }

  /* ---------- Courriers ---------- */
  function vMails(d, q) {
    var m = d.modes || {}, total = (m.outbox || 0) + (m.smtp || 0);
    var bar = '<div class="adm-bar">' + searchForm('Rechercher un courrier', inp('adm-q', 'Rechercher', 'q', q.q, ' type="search" placeholder="destinataire, objet, e-mail, référence" autocomplete="off" maxlength="120" data-k="q"')) + '</div>';
    var f = filters('Filtrer par mode d’envoi', 'mode', [['', 'Tous', total], ['outbox', 'Boîte d’envoi locale', m.outbox || 0], ['smtp', 'SMTP', m.smtp || 0]], q.mode);
    var scope = safeId(q.user) || safeId(q.request) ? '<p class="notice notice--info">' + (safeId(q.user) ? 'Courriers du compte ' + esc(d.mails[0] ? d.mails[0].user_email || short(q.user) : short(q.user)) : 'Courriers de la demande ' + esc(d.mails[0] && d.mails[0].ref ? d.mails[0].ref : short(q.request))) + SEP + '<a href="' + esc(href({ user: null, request: null, page: null })) + '" data-nav data-k="scope">retirer ce filtre</a></p>' : '';
    var rows = d.mails.map(function (x) {
      var id = esc(x.id);
      return '<tr data-mail-row="' + id + '">' + td('Envoi', '<span class="num">' + esc(stamp(x.created_at)) + '</span><span class="sub">' + (x.mode === 'smtp' ? 'SMTP' : 'boîte locale') + SEP + size(x.size) + '</span>') +
        td('Destinataire', '<span class="ell mono mono--plain" title="' + esc(x.to_addr) + '">' + esc(x.to_addr) + '</span><span class="sub">' + (x.user_id && x.user_email ? '<a href="' + esc(link('users', { id: x.user_id })) + '">' + esc(x.user_email) + '</a>' : 'sans compte') + '</span>') + td('Objet', '<span class="ell" title="' + esc(x.subject) + '">' + esc(x.subject) + '</span>') +
        td('Référence', x.ref ? '<a class="mono mono--plain" href="' + esc(link('requests', { q: x.token, open: x.request_id })) + '">' + esc(x.ref) + '</a>' : '—') + td('', '<button class="btn btn--outline btn--xs" type="button" data-mail-open="' + id + '" aria-expanded="false" aria-controls="mail-x-' + id + '">Lire<span class="vh"> le courrier ' + esc(x.subject) + '</span></button>', 'act') + '</tr>';
    }).join('');
    return bar + f + scope + sheet('adm-ml-h', 'Courriers', meta(pl(d.total, 'résultat', 'résultats')), table('Liste des courriers', [th('Envoi'), th('Destinataire'), th('Objet'), th('Référence'), th('<span class="vh">Contenu</span>', 'act')], rows, 'Aucun courrier ne correspond.') + pager(d));
  }
  function openMail(id, btn) {
    var row = btn.closest('tr'), ex = document.getElementById('mail-x-' + id);
    if (ex) { ex.closest('tr').remove(); btn.setAttribute('aria-expanded', 'false'); return; }
    lock(btn, true);
    api('/admin/mails/' + id).then(function (d) {
      var m = d.mail, tr = document.createElement('tr'); tr.className = 'tbl__expand';
      tr.innerHTML = '<td colspan="5"><div class="adm-expand" id="mail-x-' + esc(id) + '"><dl class="kv adm-kv-grid"><dt>À</dt><dd class="mono mono--plain">' + esc(m.to_addr) + '</dd><dt>Envoyé</dt><dd>' + esc(stamp(m.created_at)) + '</dd><dt>Mode</dt><dd>' + (m.mode === 'smtp' ? 'SMTP' : 'Boîte d’envoi locale') + '</dd><dt>Message-ID</dt><dd class="mono mono--plain adm-sub">' + esc(m.message_id || '—') + '</dd></dl>' +
        '<div class="mail-body adm-mailbody" tabindex="0" role="region" aria-label="' + esc('Contenu du courrier ' + m.subject) + '">' + esc(m.subject + '\n\n' + m.body) + '</div></div></td>';
      row.parentNode.insertBefore(tr, row.nextSibling); btn.setAttribute('aria-expanded', 'true');
    }).catch(fail).finally(function () { lock(btn, false); });
  }

  /* ---------- Réponses entrantes ---------- */
  // Réponse lue comme un effacement ou un refus, mais envoyée par une adresse qui n’est ni celle du courtier ni son contact
  // vérifié : enregistrée au plus « en cours », en attente de la décision de l’équipe.
  function reviewText(r) { return 'Réponse lue comme «' + NB + esc(O.statusLabel(r.review_outcome)) + NB + '», reçue le ' + esc(stamp(r.review_at)) + ' de <span class="mono mono--plain">' + esc(r.review_from || 'expéditeur inconnu') + '</span>' + NB + ': ni le domaine du courtier ni son contact vérifié.'; }
  function vReview(d) {
    var rows = d.requests.map(function (r) {
      var id = esc(r.id);
      return '<tr>' + td('Demande', '<a class="mono mono--plain ell" href="' + esc(link('requests', { q: r.token, open: r.id })) + '">' + esc(r.ref) + '</a><span class="sub">' + esc(r.broker) + '</span>') +
        td('Abonné', '<span class="ell">' + esc(r.email) + '</span><span class="sub">statut' + NB + ': ' + esc(O.statusLabel(r.status).toLowerCase()) + '</span>') +
        td('Lecture', chip(r.review_outcome) + '<span class="sub num">' + esc(stamp(r.review_at)) + '</span>') +
        td('Expéditeur', '<span class="ell mono mono--plain" title="' + esc(r.review_from || '') + '">' + esc(r.review_from || '—') + '</span>') +
        td('', '<div class="adm-acts"><button class="btn btn--xs" type="button" data-outcome="' + esc(r.review_outcome) + '" data-req="' + id + '" data-note="réponse vérifiée par l’équipe">' + (r.review_outcome === 'refused' ? 'Confirmer le refus' : 'Confirmer l’effacement') + '<span class="vh"> (' + esc(r.ref) + ')</span></button><button class="btn btn--outline btn--xs" type="button" data-review-dismiss="' + id + '">Classer sans suite<span class="vh"> (' + esc(r.ref) + ')</span></button></div>', 'act') + '</tr>';
    }).join('');
    return sheet('adm-ibv-h', 'Réponses à vérifier', meta(pl(d.total, 'demande', 'demandes')), '<div class="sheet__body adm-prose"><p>Un effacement ou un refus ne s’enregistre seul que s’il vient du domaine du courtier, d’un sous-domaine, ou de son adresse de contact vérifiée. Sinon la demande passe au plus «' + NB + 'En cours' + NB + '» et attend votre décision' + NB + ': confirmez après avoir vérifié la réponse, ou classez-la sans suite.</p></div>' +
      table('Réponses à vérifier', [th('Demande'), th('Abonné'), th('Lecture'), th('Expéditeur'), th('<span class="vh">Actions</span>', 'act')], rows, 'Aucune réponse à vérifier.') + (d.total > d.requests.length ? '<div class="pager"><a class="adm-back" href="' + esc(link('requests', { status: 'review' })) + '">Voir les ' + num(d.total) + ' demandes à vérifier</a></div>' : ''));
  }
  function vInbound(sys, aud, rev) {
    var tok = !!(sys.env && sys.env.INBOUND_TOKEN);
    var hook = sheet('adm-ib-h', 'Réception automatique', tok ? chip('active', 'Jeton configuré') : chip('refused', 'Jeton absent'), '<div class="sheet__body adm-prose"><p>Votre fournisseur d’e-mail entrant (Postmark, Mailgun, SendGrid…) transmet chaque réponse en POST JSON <code>{from, subject, text}</code> sur <code>/api/inbound</code>, avec l’en-tête <code>X-Inbound-Token</code>. La référence <code>OUBLI-…</code> présente dans l’objet ou le corps rattache la réponse à sa demande, qui est qualifiée automatiquement.</p>' +
      (tok ? '' : '<p class="notice">Sans <code>INBOUND_TOKEN</code> (16' + NB + 'caractères minimum), le webhook refuse tout envoi' + NB + ': qualifiez les réponses à la main ci-dessous.</p>') + '</div>');
    var form = '<form class="sheet" id="inbound-form" aria-labelledby="adm-ibf-h" novalidate><div class="sheet__head"><h2 id="adm-ibf-h">Qualifier une réponse reçue</h2>' + meta('Analyse sans enregistrement') + '</div><div class="sheet__body"><div class="fields">' +
      inp('ib-token', 'Référence (facultative)', 'token', '', ' placeholder="OUBLI-XXXXXXXXXX" autocomplete="off" maxlength="24" spellcheck="false"') + inp('ib-subject', 'Objet', 'subject', '', ' maxlength="300" autocomplete="off"') +
      '<div class="f f--full"><label for="ib-text">Texte de la réponse</label><textarea id="ib-text" name="text" class="adm-textarea" rows="7" maxlength="20000" aria-describedby="ib-text-hint"></textarea><span class="hint" id="ib-text-hint">Collez l’e-mail du courtier' + NB + ': la référence est retrouvée dans le texte si vous ne la saisissez pas.</span></div></div>' + msg() + '</div>' +
      '<div class="sheet__foot"><button class="btn" type="submit">Analyser la réponse</button><span class="mono">La décision reste la vôtre</span></div></form><div id="inbound-result" aria-live="polite"></div>';
    var recent = sheet('adm-ibr-h', 'Dernières décisions sur les demandes', meta('Journal d’audit'), auditTable(aud.entries || [], 'Dernières décisions sur les demandes', 'Aucune décision enregistrée.', true));
    return vReview(rev) + hook + form + recent;
  }
  function vSim(r) {
    if (!r.matched) return '<p class="notice" role="status">' + esc(fr(r.reason || 'Aucune demande ne correspond.')) + '</p>';
    var q = r.request;
    return sheet('adm-sim-h', 'Demande ' + esc(q.ref), chip(q.status), '<div class="sheet__body"><dl class="kv"><dt>Courtier</dt><dd>' + esc(q.broker) + '</dd><dt>Abonné</dt><dd>' + esc(q.email) + SEP + esc(q.profile) + '</dd><dt>Lecture automatique</dt><dd>' + chip(r.outcome) + '</dd></dl></div>' +
      '<div class="sheet__foot"><div class="btn-row">' + OUTCOMES.map(function (o) { return '<button class="btn btn--sm' + (o[0] === r.outcome ? '' : ' btn--outline') + '" type="button" data-outcome="' + o[0] + '" data-req="' + esc(q.id) + '" data-note="réponse qualifiée par le support"><span class="vh">Enregistrer' + NB + ': </span>' + o[1] + '</button>'; }).join('') + '</div><a class="adm-back" href="' + esc(link('requests', { q: q.token, open: q.id })) + '">Ouvrir la demande</a></div>', ' id="inbound-sim"');
  }

  /* ---------- Contacts et listes ---------- */
  function vContacts(c, n, q) {
    var exp = '<section class="sheet" aria-labelledby="adm-ex-h"><div class="sheet__head"><h2 id="adm-ex-h">Exports CSV</h2>' + meta('UTF-8, séparateur virgule') + '</div><div class="sheet__body adm-exports">' + [['newsletter', 'Lettre d’information'], ['contacts', 'Messages'], ['users', 'Utilisateurs'], ['requests', 'Demandes']].map(function (e) { return '<a class="btn btn--outline btn--sm" href="/api/admin/export.csv?what=' + e[0] + '" download>' + e[1] + '</a>'; }).join('') + '</div></section>';
    var cc = c.counts || {};
    var rows = c.contacts.map(function (m) {
      var long = m.message.length > 280, id = esc(m.id);
      return '<tr' + (m.handled_at ? ' class="is-off"' : '') + '>' + td('Reçu le', '<span class="num">' + esc(stamp(m.created_at)) + '</span>') + td('Expéditeur', '<a href="mailto:' + esc(m.email) + '">' + esc(m.email) + '</a>') +
        td('Message', (m.subject ? '<strong>' + esc(m.subject) + '</strong>' : '') + (long ? '<details class="adm-msg"><summary>' + esc(m.message.slice(0, 220)) + '…</summary>' + esc(m.message.slice(220)) + '</details>' : '<p class="adm-msg">' + esc(m.message) + '</p>')) +
        td('Statut', m.handled_at ? chip('done', 'Traité le ' + date(m.handled_at)) : chip('action_required', 'À traiter')) +
        td('', '<button class="btn btn--outline btn--xs" type="button" data-contact="' + id + '" data-handled="' + !m.handled_at + '" data-k="c-' + id + '">' + (m.handled_at ? 'Rouvrir' : 'Marquer traité') + '</button>', 'act') + '</tr>';
    }).join('');
    var msgs = sheet('adm-ct-h', 'Messages reçus', '', '<div class="sheet__body sheet__body--tight">' + filters('Filtrer les messages', 'status', [['', 'Tous', (cc.open || 0) + (cc.handled || 0)], ['open', 'À traiter', cc.open], ['handled', 'Traités', cc.handled]], q.status) + '</div>' +
      table('Messages du formulaire de contact', [th('Reçu le'), th('Expéditeur'), th('Message'), th('Statut'), th('<span class="vh">Action</span>', 'act')], rows, 'Aucun message.') + pager(c));
    var subs = sheet('adm-nl-h', 'Lettre d’information', meta(pl(n.total, 'inscrit', 'inscrits')), table('Inscrits à la lettre d’information', [th('Adresse'), th('Inscrit le')], n.subscribers.map(function (s) { return '<tr>' + td('Adresse', esc(s.email)) + td('Inscrit le', '<span class="num">' + esc(stamp(s.created_at)) + '</span>') + '</tr>'; }).join(''), 'Aucun inscrit.') + pager(n, 'npage'));
    return exp + msgs + subs;
  }

  /* ---------- Système ---------- */
  function vSystem(s) {
    var m = s.modes || {}, sc = s.scheduler || {}, c = s.counts || {}, env = s.env || {};
    var warn = (m.demo && m.production ? '<p class="notice" role="alert">Mode démo actif en production' + NB + ': à désactiver immédiatement.</p>' : '') +
      (m.mail === 'smtp' && m.allow_unverified ? '<p class="notice">ALLOW_UNVERIFIED_CONTACTS est actif' + NB + ': des courriers partent vers des contacts non vérifiés.</p>' : '') +
      (m.production && !env.APP_URL ? '<p class="notice">APP_URL n’est pas défini en production.</p>' : '');
    function kv(rows, cls) { return '<div class="sheet__body"><dl class="kv' + (cls ? ' ' + cls : '') + '">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl></div>'; }
    var server = sheet('adm-sy1', 'Serveur', '', kv([['Node', esc(s.node)], ['Plateforme', esc(s.platform)], ['Démarré le', esc(stamp(s.started_at))], ['Disponibilité', dur(s.uptime_s)], ['Mémoire', num(s.memory_rss_mb) + NB + 'Mo'], ['Heure du serveur', esc(stamp(s.time))]]));
    var modes = sheet('adm-sy2', 'Modes', '', kv([['Environnement', m.production ? 'Production' : 'Développement'], ['Courrier', m.mail === 'smtp' ? 'SMTP' : 'Boîte d’envoi locale'], ['Paiement', m.billing === 'stripe' ? 'Stripe' : 'Simulé'], ['Démo', m.demo ? 'Activée' : 'Désactivée'], ['Contacts non vérifiés', m.allow_unverified ? 'Autorisés' : 'Bloqués en SMTP'], ['Base SQLite', size(s.db && s.db.bytes) + (s.db && s.db.wal ? SEP + 'WAL' : '')], ['Boîte d’envoi', '<span class="adm-sub">' + esc(s.outbox && s.outbox.dir) + '</span>' + (s.outbox && s.outbox.files != null ? pl(s.outbox.files, 'fichier', 'fichiers') : 'absente')]]));
    var sched = sheet('adm-sy3', 'Planificateur', '<div class="btn-row"><button class="btn btn--outline btn--xs" type="button" data-tick>Exécuter maintenant</button><button class="btn btn--outline btn--xs" type="button" data-reports>Rapports mensuels dus</button></div>', kv([['Intervalle', Math.round((sc.interval_ms || 0) / 1000) + NB + 's'], ['Dernier passage', esc(stamp(sc.last_tick_at))], ['Dernier passage manuel', esc(stamp(sc.last_manual_tick_at))]]));
    var vol = sheet('adm-sy4', 'Volumes', '', kv([['Utilisateurs', num(c.users) + (c.users_deleted ? '<span class="adm-sub">' + num(c.users_deleted) + ' supprimés</span>' : '')], ['Administrateurs', num(c.admins)], ['Profils', num(c.profiles)], ['Demandes', num(c.requests)], ['Événements', num(c.events)], ['Courriers', num(c.mails)], ['Sessions actives', num(c.sessions)], ['Courtiers', num(c.brokers_active) + NB + '/' + NB + num(c.brokers)], ['Lettre d’information', num(c.newsletter)], ['Messages', num(c.contacts) + (c.contacts_open ? '<span class="adm-sub">' + num(c.contacts_open) + ' à traiter</span>' : '')], ['Entrées d’audit', num(c.audit)]]));
    var bk = s.backup || {}, bl = bk.last;
    var backup = sheet('adm-sy6', 'Sauvegardes', bk.enabled ? '<div class="btn-row"><button class="btn btn--outline btn--xs" type="button" data-backup>Sauvegarder maintenant</button></div>' : chip('none', 'Désactivées'),
      bk.enabled ? kv([['Dernière', bl ? esc(stamp(bl.at)) : 'Aucune pour l’instant'], ['Taille', bl ? size(bl.bytes) : '—'], ['Conservées', num(bk.count) + NB + '/' + NB + num(bk.keep)], ['Prochaine', bk.running ? 'En cours…' : bk.next_at ? 'après le ' + esc(stamp(bk.next_at)) : 'dans l’heure'], ['Dossier', '<span class="adm-sub">' + esc(bk.dir) + '</span>']]
        .concat(bk.last_error ? [['Dernier échec', esc(stamp(bk.last_error.at)) + '<span class="adm-sub">' + esc(fr(bk.last_error.message)) + '</span>']] : []))
        : '<div class="sheet__body"><p class="hint adm-hint">' + esc(fr(bk.reason || '')) + ' Une copie quotidienne de la base, dont les ' + num(bk.keep || 7) + NB + 'plus récentes sont conservées, est faite dans BACKUP_DIR (hors des dossiers publics assets/ et app/).</p></div>');
    var envs = sheet('adm-sy5', 'Variables d’environnement', meta('Présence seulement, jamais la valeur'), '<div class="sheet__body"><ul class="adm-env" role="list">' + Object.keys(env).map(function (k) { return '<li>' + (env[k] ? chip('active', 'Définie') : chip('none', 'Absente')) + '<code>' + esc(k) + '</code></li>'; }).join('') + '</ul></div>');
    var a = s.announcement;
    var ann = '<form class="sheet" id="adm-ann-form" aria-labelledby="adm-sy0" novalidate><div class="sheet__head"><h2 id="adm-sy0">Annonce</h2>' + (a ? chip('active', 'Publiée') : chip('none', 'Aucune')) + '</div><div class="sheet__body"><p class="hint adm-hint">Bandeau affiché en haut de l’application, pour tous les visiteurs (maintenance, incident, nouveauté).</p><div class="fields">' +
      '<div class="f f--full"><label for="ann-text">Texte</label><textarea id="ann-text" name="text" class="adm-textarea" rows="2" maxlength="280">' + esc(a ? a.text : '') + '</textarea></div>' + sel('ann-level', 'Niveau', 'level', [['info', 'Information'], ['warn', 'Attention']], a ? a.level : 'info') + '</div>' + msg() +
      '</div><div class="sheet__foot"><div class="btn-row"><button class="btn btn--outline" type="submit">' + (a ? 'Mettre à jour' : 'Publier') + '</button>' + (a ? '<button class="btn btn--danger btn--sm" type="button" data-ann-remove>Retirer l’annonce</button>' : '') + '</div><span class="mono">280' + NB + 'caractères au plus</span></div></form>';
    return warn + ann + '<div class="adm-grid">' + server + modes + '</div><div class="adm-grid">' + sched + vol + '</div>' + backup + envs;
  }

  /* ---------- Journal d'audit ---------- */
  function vAudit(d, q) {
    var bar = '<div class="adm-bar">' + searchForm('Filtrer le journal', sel('adm-action', 'Action', 'action', [['', 'Toutes']].concat((d.actions || []).map(function (a) { return [a, ACTIONS[a] || a]; })), q.action, ' data-autosubmit data-k="action"') + inp('adm-target', 'Cible (identifiant exact)', 'target', q.target, ' autocomplete="off" maxlength="60" spellcheck="false" data-k="target"')) + '</div>';
    return bar + sheet('adm-au-h', 'Journal', meta(pl(d.total, 'entrée', 'entrées')), auditTable(d.entries, 'Journal d’audit des administrateurs', 'Aucune entrée.', true) + pager(d));
  }

  /* ---------- chargement, rendu, navigation ---------- */
  var VIEWS = {
    overview: function () { return api('/admin/stats').then(function (s) { setBadges(s); return vOverview(s); }); },
    users: function (q) { if (safeId(q.id)) return api('/admin/users/' + q.id).then(vUser); return api('/admin/users' + qs({ q: q.q, status: q.status, plan: q.plan, page: q.page })).then(function (d) { return vUsers(d, q); }); },
    keys: function (q) { return api('/admin/keys' + qs({ q: q.q, status: q.status, batch: q.batch, page: q.page })).then(function (d) { return vKeys(d, q); }); },
    requests: function (q) { return api('/admin/requests' + qs({ q: q.q, status: q.status, sort: q.sort, broker: q.broker, user: q.user, page: q.page })).then(function (d) { return vRequests(d, q); }); },
    brokers: function (q) { return api('/admin/brokers').then(function (d) { return vBrokers(d, q); }); },
    mails: function (q) { return api('/admin/mails' + qs({ q: q.q, mode: q.mode, user: q.user, request: q.request, page: q.page })).then(function (d) { return vMails(d, q); }); },
    inbound: function () { return Promise.all([api('/admin/system'), api('/admin/audit' + qs({ action: 'request.', per: 12 })), api('/admin/requests' + qs({ status: 'review', sort: 'review', per: 50 }))]).then(function (r) { return vInbound(r[0], r[1], r[2]); }); },
    contacts: function (q) { return Promise.all([api('/admin/contacts' + qs({ status: q.status, page: q.page })), api('/admin/newsletter' + qs({ page: q.npage }))]).then(function (r) { return vContacts(r[0], r[1], q); }); },
    security: function () { return api('/admin/security').then(vSecurity); },
    system: function () { return api('/admin/system').then(vSystem); },
    audit: function (q) { return api('/admin/audit' + qs({ action: q.action, target: q.target, page: q.page })).then(function (d) { return vAudit(d, q); }); },
  };
  function loadMain(q, focusKey) {
    var main = $('#adm-main'); if (!main) return Promise.resolve();
    var my = ++seq, t = curTab(q);
    if (t !== 'keys') freshKeys = null;   // les clés en clair ne survivent pas à la sortie de l'onglet
    main.setAttribute('aria-busy', 'true');
    return VIEWS[t](q).then(function (html) {
      if (my !== seq || !document.body.contains(main)) return;
      main.innerHTML = html; main.removeAttribute('aria-busy');
      fixWraps(main); wireCharts(main);
      if (t === 'requests' && q.open) openRequest(q.open);
      if (focusKey !== undefined) { var el = focusKey && $('[data-k="' + focusKey + '"]', main); (el && el.getAttribute('aria-disabled') !== 'true' ? el : main).focus({ preventScroll: true }); }
    }).catch(function (e) {
      if (my !== seq) return;
      main.removeAttribute('aria-busy');
      main.innerHTML = '<p class="notice" role="alert">' + esc(fr(e.message)) + '</p>';
    });
  }
  function navTo(h, focusKey) { history.pushState(null, '', h); return loadMain(O.params().q, focusKey); }
  function reload(changes, focusKey) { history.replaceState(null, '', href(changes || {})); return loadMain(O.params().q, focusKey); }
  function setBadges(s) {
    var rs = s.requests_by_status || {}, b = s.brokers || {};
    var v = { users: s.users, keys: (s.keys || {}).active, requests: (rs.action_required || 0) + (rs.error || 0), brokers: (b.active || 0) - (b.verified || 0), inbound: s.review, contacts: s.contacts_open, security: s.suspended };
    var hot = { requests: v.requests > 0, brokers: s.mail_mode === 'smtp' && v.brokers > 0, inbound: v.inbound > 0, contacts: v.contacts > 0 };
    Object.keys(v).forEach(function (k) { var el = $('[data-badge="' + k + '"]'); if (!el) return; el.innerHTML = '<span class="vh">,' + NB + '</span>' + num(v[k]) + '<span class="vh">' + BADGE[k] + '</span>'; el.hidden = !v[k]; el.classList.toggle('is-hot', !!hot[k]); });
  }
  function refreshBadges() { return api('/admin/stats').then(setBadges).catch(function () {}); }

  function render(q) {
    var t = TAB[curTab(q)];
    freshKeys = null;   // nouvelle navigation dans l'administration : les clés en clair ne sont plus affichées
    return '<div class="page-head"><div><span class="mono">Administration</span><h1>' + t[1] + '</h1><p class="lead">' + t[2] + '</p></div><div class="btn-row"><button class="btn btn--outline btn--sm" type="button" id="admin-tick">Exécuter le planificateur</button></div></div>' +
      '<div class="adm"><nav class="adm__rail" aria-label="Sections de l’administration">' + TABS.map(function (x) { return '<a class="adm__tab" href="#admin?tab=' + x[0] + '"' + (x[0] === t[0] ? ' aria-current="page"' : '') + '><span>' + (x[3] || x[1]) + '</span><b data-badge="' + x[0] + '" hidden></b></a>'; }).join('') + '</nav>' +
      '<div class="adm__main" id="adm-main" tabindex="-1" aria-busy="true"><p class="empty"><span class="spinner"></span><span class="vh">Chargement…</span></p></div></div>';
  }
  function after(q) { loadMain(q); if (curTab(q) !== 'overview') refreshBadges(); }

  /* ---------- interactions (délégation, actives seulement sur #admin) ---------- */
  function onAdmin() { return O.params().route === 'admin' && !!$('#adm-main'); }
  function done(text, focusKey, changes) { toast(text); refreshBadges(); return reload(changes || {}, focusKey); }
  function fd(f) { var o = {}; new FormData(f).forEach(function (v, k) { o[k] = typeof v === 'string' ? v.trim() : v; }); return o; }
  // Envoi d'un formulaire de la fiche compte : bouton verrouillé, erreur affichée et liée au champ, rechargement sinon.
  function send(f, path, body, okText, focusKey, opts) {
    var b = $('button[type="submit"]', f); lock(b, true); formOk(f);
    return api(path, merge({ body: body }, opts)).then(function (r) { done(typeof okText === 'function' ? okText(r) : okText, focusKey); return r; }).catch(function (err) { formError(f, err.message); lock(b, false); });
  }
  function tick(btn) { lock(btn, true); api('/admin/tick', { method: 'POST' }).then(function () { done('Planificateur exécuté.'); }).catch(fail).finally(function () { lock(btn, false); }); }

  document.addEventListener('click', function (e) {
    if (!onAdmin()) return;
    var t = e.target.closest('button, a'); if (!t || t.getAttribute('aria-disabled') === 'true') return;
    if (t.matches('a[data-nav]')) { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); navTo(t.getAttribute('href'), t.getAttribute('data-k')); }
    else if (t.id === 'admin-tick' || t.hasAttribute('data-tick')) tick(t);
    else if (t.hasAttribute('data-backup')) { lock(t, true); api('/admin/backup', { body: {} }).then(function (r) { done('Sauvegarde créée' + NB + ': ' + size(r.backup && r.backup.bytes) + '.'); }).catch(function (err) { fail(err); lock(t, false); }); }
    else if (t.hasAttribute('data-reports')) { lock(t, true); api('/admin/reports/run', { body: {} }).then(function (r) { done(pl(r.sent || 0, 'rapport mensuel envoyé', 'rapports mensuels envoyés') + (r.failed ? ', ' + r.failed + ' en échec' : '') + '.'); }).catch(function (err) { fail(err); lock(t, false); }); }
    else if (t.hasAttribute('data-outcome') && t.hasAttribute('data-req')) {
      var o = t.getAttribute('data-outcome'); lock(t, true);
      api('/admin/requests/' + encodeURIComponent(t.getAttribute('data-req')) + '/outcome', { body: { outcome: o, note: t.getAttribute('data-note') || '' } }).then(function () { done('Réponse enregistrée' + NB + ': ' + label(OUTCOMES, o).toLowerCase() + '.'); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-req-open')) openRequest(t.getAttribute('data-req-open'));
    else if (t.hasAttribute('data-review-dismiss')) {
      if (!arm(t, 'Confirmer le classement')) return;
      lock(t, true);
      api('/admin/requests/' + encodeURIComponent(t.getAttribute('data-review-dismiss')) + '/review', { method: 'DELETE', body: {} }).then(function () { done('Réponse classée sans suite' + NB + ': la demande garde son statut.'); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-req-resend')) {
      if (!arm(t, 'Confirmer le renvoi')) return;
      var rid = t.getAttribute('data-req-resend'); lock(t, true);
      api('/admin/requests/' + rid + '/resend', { body: {} }).then(function () { done('Demande remise en file' + NB + ': elle repart au prochain passage.', 'req-' + rid, { open: rid }); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-bulk-apply')) {
      var ids = bulkState(), out = $('#bulk-outcome').value;
      if (!out) { toast('Choisissez le résultat à appliquer.', true); $('#bulk-outcome').focus(); return; }
      if (!arm(t, 'Confirmer pour ' + pl(ids.length, 'demande', 'demandes'))) return;
      lock(t, true);
      api('/admin/requests/bulk', { body: { ids: ids, outcome: out, note: $('#bulk-note').value } }).then(function (r) { done(pl(r.updated, 'demande mise à jour', 'demandes mises à jour') + (r.missing && r.missing.length ? ', ' + r.missing.length + ' introuvable(s)' : '') + (r.ignored && r.ignored.length ? ', ' + pl(r.ignored.length, 'ignorée (close ou pas encore partie)', 'ignorées (closes ou pas encore parties)') : '') + '.', 'search-go'); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-bulk-clear')) { $$('[data-sel]').forEach(function (i) { i.checked = false; }); bulkState(); var a = $('[data-sel-all]'); if (a) a.focus(); }
    else if (t.hasAttribute('data-user-act')) {
      var act = t.getAttribute('data-user-act'), uid = t.getAttribute('data-user');
      if (act === 'delete' && !arm(t, 'Confirmer la suppression')) return;
      if (act === 'role' && !arm(t, 'Confirmer')) return;
      lock(t, true);
      var p = act === 'launch' ? api('/admin/users/' + uid + '/launch', { body: {} }) : act === 'logout' ? api('/admin/users/' + uid + '/logout-all', { body: {} }) : act === 'role' ? api('/admin/users/' + uid + '/role', { body: { role: t.getAttribute('data-role') } }) : api('/admin/users/' + uid, { method: 'DELETE', body: {} });
      p.then(function (r) { done(act === 'launch' ? pl(r.created, 'demande créée', 'demandes créées') + '.' : act === 'logout' ? pl(r.sessions, 'session fermée', 'sessions fermées') + '.' : act === 'role' ? 'Rôle mis à jour.' : 'Compte supprimé.', 'act-' + act); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.id === 'broker-new-toggle') { var box = $('#broker-new'), open = box.hidden; box.hidden = !open; t.setAttribute('aria-expanded', String(open)); if (open) { $('input', box).focus(); box.scrollIntoView({ block: 'nearest' }); } }
    else if (t.hasAttribute('data-broker-edit')) {
      var bid = t.getAttribute('data-broker-edit'), ex = document.getElementById('b-x-' + bid);
      if (ex) { ex.closest('tr').remove(); t.setAttribute('aria-expanded', 'false'); return; }
      var row = t.closest('tr'), tr = document.createElement('tr'); tr.className = 'tbl__expand';
      tr.innerHTML = '<td colspan="6" id="b-x-' + esc(bid) + '">' + brokerForm(brokersById[bid]) + '</td>';
      row.parentNode.insertBefore(tr, row.nextSibling); t.setAttribute('aria-expanded', 'true'); $('input', tr).focus();
    }
    else if (t.hasAttribute('data-broker-cancel')) {
      var cid = t.getAttribute('data-broker-cancel');
      if (cid === 'new') { $('#broker-new').hidden = true; var nt = $('#broker-new-toggle'); nt.setAttribute('aria-expanded', 'false'); nt.focus(); return; }
      var cx = document.getElementById('b-x-' + cid); if (cx) cx.closest('tr').remove();
      var eb = $('[data-broker-edit="' + cid + '"]'); if (eb) { eb.setAttribute('aria-expanded', 'false'); eb.focus(); }
    }
    else if (t.hasAttribute('data-broker-discover')) {
      var did = t.getAttribute('data-broker-discover'); lock(t, true); t.textContent = 'Recherche…';
      api('/admin/brokers/' + did + '/discover', { body: {} }).then(function (r) { done(r.found ? 'Contact trouvé' + NB + ': ' + r.found + '.' : 'Aucune adresse publiée trouvée (' + pl(r.pages, 'page lue', 'pages lues') + ').', 'bdisc-' + did); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-broker-test')) {
      if (!arm(t, 'Confirmer l’envoi')) return;
      lock(t, true);
      api('/admin/brokers/' + t.getAttribute('data-broker-test') + '/test-mail', { body: {} }).then(function (r) { toast('Courrier de test envoyé à ' + r.to + (r.mode === 'smtp' ? '' : ' (boîte d’envoi locale)') + ', réf. ' + r.ref + '.'); }).catch(fail).finally(function () { lock(t, false); });
    }
    else if (t.hasAttribute('data-broker-active')) {
      var on = t.getAttribute('data-broker-active') === '1', brid = t.getAttribute('data-broker');
      if (!on && !arm(t, 'Confirmer la désactivation')) return;
      lock(t, true);
      (on ? api('/admin/brokers/' + brid, { method: 'PUT', body: { active: true } }) : api('/admin/brokers/' + brid, { method: 'DELETE', body: {} })).then(function (r) { done(on ? 'Courtier réactivé' + NB + ': les demandes arrêtées repartent dans un nouveau cycle.' : 'Courtier désactivé' + NB + ': plus aucune nouvelle demande ne lui sera adressée' + stoppedText(r) + '.', 'bact-' + brid); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-mail-open')) openMail(t.getAttribute('data-mail-open'), t);
    else if (t.hasAttribute('data-unsuspend')) { lock(t, true); api('/admin/users/' + t.getAttribute('data-unsuspend') + '/unsuspend', { body: {} }).then(function () { done('Compte réactivé' + NB + ': connexion et envois rétablis.'); }).catch(function (err) { fail(err); lock(t, false); }); }
    else if (t.hasAttribute('data-session')) {
      if (!arm(t, 'Confirmer')) return;
      lock(t, true); api('/admin/users/' + t.getAttribute('data-user') + '/sessions/' + encodeURIComponent(t.getAttribute('data-session')), { method: 'DELETE', body: {} }).then(function () { done('Session fermée.'); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-note-del')) { if (!arm(t, 'Confirmer')) return; lock(t, true); api('/admin/notes/' + t.getAttribute('data-note-del'), { method: 'DELETE', body: {} }).then(function () { done('Note supprimée.', 'note-add'); }).catch(function (err) { fail(err); lock(t, false); }); }
    else if (t.hasAttribute('data-block-remove')) { if (!arm(t, 'Confirmer')) return; lock(t, true); api('/admin/blocklist/' + t.getAttribute('data-block-remove'), { method: 'DELETE', body: {} }).then(function () { done('Blocage retiré.', 'block-add'); }).catch(function (err) { fail(err); lock(t, false); }); }
    else if (t.hasAttribute('data-ann-remove')) {
      if (!arm(t, 'Confirmer le retrait')) return;
      lock(t, true); api('/admin/announcement', { method: 'DELETE', body: {} }).then(function () { O.state.config.announcement = null; O.chrome(); done('Annonce retirée.'); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-contact')) {
      var ctid = t.getAttribute('data-contact'), handled = t.getAttribute('data-handled') === 'true'; lock(t, true);
      api('/admin/contacts/' + ctid + '/handled', { body: { handled: handled } }).then(function () { done(handled ? 'Message marqué traité.' : 'Message rouvert.', 'c-' + ctid); }).catch(function (err) { fail(err); lock(t, false); });
    }
    else if (t.hasAttribute('data-key-days')) { var kd = $('#key-days'); if (kd) { kd.value = t.getAttribute('data-key-days'); syncDays(); } }
    else if (t.hasAttribute('data-keys-copy') && freshKeys) copyText(freshKeys.keys.map(function (k) { return k.key + '\t' + shareLink(k.key); }).join('\n') + '\n', pl(freshKeys.keys.length, 'clé copiée', 'clés copiées') + ' avec leur lien de partage.', t);
    else if (t.hasAttribute('data-key-copy') && freshKeys) { var fk = freshKeys.keys[Number(t.getAttribute('data-key-copy'))]; if (fk) copyText(shareLink(fk.key), 'Lien de la clé …' + fk.hint + ' copié.', t); }
    else if (t.hasAttribute('data-keys-csv') && freshKeys) { downloadText('oubli-cles-' + freshKeys.batch + '.csv', keysCsv(freshKeys), 'text/csv;charset=utf-8'); toast('Fichier CSV téléchargé' + NB + ': conservez-le en lieu sûr.'); }
    else if (t.hasAttribute('data-keys-hide')) {
      freshKeys = null; var panel = t.closest('.adm-fresh'); if (panel) panel.remove();
      var kc = $('#key-count'); if (kc) kc.focus(); O.announce('Clés masquées' + NB + ': elles ne seront plus affichées.');
    }
    else if (t.hasAttribute('data-key-revoke')) {
      if (!arm(t, 'Confirmer la révocation')) return;
      var kid = t.getAttribute('data-key-revoke'), khint = t.getAttribute('data-hint'); lock(t, true);
      api('/admin/keys/' + encodeURIComponent(kid) + '/revoke', { body: {} }).then(function () { done('Clé …' + khint + ' révoquée' + NB + ': elle ne peut plus être activée.', 'kb-' + kid); }).catch(function (err) { fail(err); lock(t, false); });
    }
  });
  /* Raccourcis de durée : le bouton correspondant à la valeur saisie est marqué enfoncé. */
  function syncDays() { var kd = $('#key-days'); if (!kd) return; $$('[data-key-days]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-key-days') === String(kd.value).trim())); }); }
  document.addEventListener('input', function (e) { if (onAdmin() && e.target.id === 'key-days') syncDays(); });

  document.addEventListener('submit', function (e) {
    if (!onAdmin()) return;
    var f = e.target; e.preventDefault();
    if (f.hasAttribute('data-adm-search')) {
      var ch = { page: null }; new FormData(f).forEach(function (v, k) { ch[k] = String(v).trim(); });
      var ae = document.activeElement; navTo(href(ch), ae && f.contains(ae) ? ae.getAttribute('data-k') || 'search-go' : 'search-go');
    } else if (f.id === 'adm-sub-form') {
      var sd = {}; new FormData(f).forEach(function (v, k) { sd[k] = String(v).trim(); }); var sb = $('button[type="submit"]', f);
      if (sd.status === 'active' && !sd.plan) { formError(f, 'Choisissez une offre pour activer l’abonnement.', $('[name="plan"]', f)); return; }
      lock(sb, true); formOk(f);
      api('/admin/users/' + f.getAttribute('data-user') + '/subscription', { body: sd }).then(function () { done('Abonnement mis à jour.'); }).catch(function (err) { formError(f, err.message, /date/i.test(err.message) ? $('[name="ends_at"]', f) : null); lock(sb, false); });
    } else if (f.hasAttribute('data-outcome-form')) {
      var rid = f.getAttribute('data-outcome-form'), oc = $('input[name="outcome"]:checked', f), btn = $('button[type="submit"]', f);
      if (!oc) { formError(f, 'Choisissez un résultat.', $('input[name="outcome"]', f)); return; }
      lock(btn, true); formOk(f);
      api('/admin/requests/' + rid + '/outcome', { body: { outcome: oc.value, note: $('[name="note"]', f).value.trim() } }).then(function () { done('Réponse enregistrée' + NB + ': ' + label(OUTCOMES, oc.value).toLowerCase() + '.', 'req-' + rid, { open: rid }); }).catch(function (err) { formError(f, err.message); lock(btn, false); });
    } else if (f.hasAttribute('data-broker-form')) {
      var id = f.getAttribute('data-broker-form'), isNew = id === 'new', bd = brokerPayload(f), b2 = $('button[type="submit"]', f);
      var missing = ['name', 'slug', 'domain', 'category', 'contact_email'].filter(function (k) { return !bd[k]; })[0];
      if (missing) { formError(f, 'Ce champ est obligatoire.', $('[name="' + missing + '"]', f)); return; }
      lock(b2, true); formOk(f);
      api(isNew ? '/admin/brokers' : '/admin/brokers/' + id, { method: isNew ? 'POST' : 'PUT', body: bd }).then(function (r) { done(isNew ? 'Courtier créé' + NB + ': ' + r.broker.name + '.' : 'Courtier enregistré' + stoppedText(r) + '.', 'bedit-' + r.broker.id, isNew ? { q: r.broker.slug, f: null, cat: null } : {}); }).catch(function (err) { formError(f, err.message); lock(b2, false); });
    } else if (f.id === 'adm-imp-form') {
      var ir = fd(f); if (ir.reason.length < 3) { formError(f, 'Indiquez le motif de l’accès.', $('[name="reason"]', f)); return; }
      var ib2 = $('button[type="submit"]', f); lock(ib2, true); formOk(f);
      api('/admin/users/' + f.getAttribute('data-user') + '/impersonate', { body: ir }).then(function () { location.hash = 'dashboard'; location.reload(); }).catch(function (err) { formError(f, err.message); lock(ib2, false); });
    } else if (f.id === 'adm-sus-form') {
      var sr = fd(f); sr.block_email = $('[name="block_email"]', f).checked;
      if (sr.reason.length < 3) { formError(f, 'Indiquez le motif de la suspension.', $('[name="reason"]', f)); return; }
      if (!arm($('button[type="submit"]', f), 'Confirmer la suspension')) return;
      send(f, '/admin/users/' + f.getAttribute('data-user') + '/suspend', sr, function (r) { return 'Compte suspendu' + NB + ': ' + pl(r.sessions, 'session fermée', 'sessions fermées') + '.'; }, 'unsuspend');
    } else if (f.id === 'adm-msg-form') {
      var mr = fd(f); if (mr.subject.length < 3) { formError(f, 'Objet trop court.'); return; } if (mr.body.length < 5) { formError(f, 'Message trop court.'); return; }
      send(f, '/admin/users/' + f.getAttribute('data-user') + '/message', mr, 'Message envoyé.');
    } else if (f.id === 'adm-mail-form') {
      var er = fd(f); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(er.email)) { formError(f, 'Adresse e-mail invalide.', $('[name="email"]', f)); return; }
      if (!arm($('button[type="submit"]', f), 'Confirmer le remplacement')) return;
      send(f, '/admin/users/' + f.getAttribute('data-user') + '/email', er, 'Adresse remplacée' + NB + ': l’ancienne adresse a été prévenue.');
    } else if (f.id === 'adm-note-form') {
      var nr = fd(f); if (!nr.body) { formError(f, 'La note est vide.'); return; }
      send(f, '/admin/users/' + f.getAttribute('data-user') + '/notes', nr, 'Note ajoutée.', 'note-add');
    } else if (f.id === 'adm-block-form') {
      var br = fd(f); br.pattern = br.pattern.toLowerCase();
      if (!/^([^\s@]+@[^\s@]+\.[^\s@]{2,}|@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})$/.test(br.pattern)) { formError(f, 'Saisissez une adresse (nom@domaine.fr) ou un domaine précédé de @ (@domaine.fr).', $('[name="pattern"]', f)); return; }
      send(f, '/admin/blocklist', br, 'Ajouté à la liste de blocage.', 'block-add');
    } else if (f.id === 'adm-ann-form') {
      var an = fd(f); if (an.text.length < 3) { formError(f, 'Annonce trop courte.', $('[name="text"]', f)); return; }
      var ab = $('button[type="submit"]', f); lock(ab, true); formOk(f);
      api('/admin/announcement', { method: 'PUT', body: an }).then(function (r) { O.state.config.announcement = r.announcement; O.chrome(); done('Annonce publiée.'); }).catch(function (err) { formError(f, err.message); lock(ab, false); });
    } else if (f.id === 'adm-key-form') {
      var kr = fd(f), kb = $('button[type="submit"]', f);
      var invalid = [['count', 1, 100, 'Nombre de clés invalide' + NB + ': de 1 à 100 par lot.'], ['days', 1, 730, 'Durée invalide' + NB + ': de 1 à 730 jours.'], ['max_uses', 1, 1000, 'Nombre d’utilisations invalide' + NB + ': de 1 à 1' + NNB + '000 par clé.']].filter(function (x) { var n = Number(kr[x[0]]); return !/^\d+$/.test(kr[x[0]]) || n < x[1] || n > x[2]; })[0];
      if (invalid) { formError(f, invalid[3], $('[name="' + invalid[0] + '"]', f)); return; }
      if (kr.note.length > 120) { formError(f, 'Note trop longue' + NB + ': 120 caractères au plus.', $('[name="note"]', f)); return; }
      lock(kb, true); formOk(f);
      api('/admin/keys', { body: { count: Number(kr.count), plan: kr.plan, days: Number(kr.days), max_uses: Number(kr.max_uses), expires_at: kr.expires_at || null, note: kr.note } }).then(function (r) {
        freshKeys = r;
        done(pl(r.keys.length, 'clé créée', 'clés créées') + NB + ': copiez-les maintenant, elles ne seront plus affichées.', 'keys-fresh', { batch: r.batch, status: null, q: null, page: null });
      }).catch(function (err) {
        var fieldName = /nombre de clés/i.test(err.message) ? 'count' : /offre/i.test(err.message) ? 'plan' : /durée/i.test(err.message) ? 'days' : /utilisations/i.test(err.message) ? 'max_uses' : /date/i.test(err.message) ? 'expires_at' : /note/i.test(err.message) ? 'note' : '';
        formError(f, err.message, fieldName ? $('[name="' + fieldName + '"]', f) : null); lock(kb, false);
      });
    } else if (f.id === 'inbound-form') {
      var ib = {}; new FormData(f).forEach(function (v, k) { ib[k] = String(v); }); var ibtn = $('button[type="submit"]', f), res = $('#inbound-result');
      if (!ib.text.trim() && !ib.subject.trim() && !ib.token.trim()) { formError(f, 'Collez au moins l’objet ou le texte de la réponse.', $('#ib-text', f)); return; }
      lock(ibtn, true); formOk(f);
      api('/admin/inbound/simulate', { body: ib }).then(function (r) { res.innerHTML = vSim(r); var first = $('button, .notice', res); if (first && first.tagName === 'BUTTON') first.focus(); }).catch(function (err) { formError(f, err.message); }).finally(function () { lock(ibtn, false); });
    }
  });

  document.addEventListener('change', function (e) {
    if (!onAdmin()) return;
    var t = e.target;
    if (t.hasAttribute('data-autosubmit') && t.form) { if (t.form.requestSubmit) t.form.requestSubmit(); else t.form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); }
    else if (t.hasAttribute('data-sel-all')) { $$('[data-sel]').forEach(function (i) { i.checked = t.checked; }); bulkState(); }
    else if (t.hasAttribute('data-sel')) bulkState();
    else if (t.hasAttribute('data-verify')) {
      var id = t.getAttribute('data-verify'), on = t.checked, lbl = t.closest('.adm-verify'); t.disabled = true;
      api('/admin/brokers/' + id, { method: 'PUT', body: { contact_verified: on } }).then(function () {
        if (brokersById[id]) brokersById[id].contact_verified = on ? 1 : 0; if (lbl) lbl.classList.toggle('is-on', on);
        toast(on ? 'Contact marqué vérifié.' : 'Contact marqué non vérifié' + NB + ': plus aucun envoi réel vers cette adresse.'); refreshBadges();
      }).catch(function (err) { t.checked = !on; fail(err); }).finally(function () { t.disabled = false; t.focus(); });
    }
  });
  document.addEventListener('input', function (e) {
    if (!onAdmin() || !e.target.hasAttribute('data-contact-email')) return;
    var f = e.target.form, b = brokersById[f && f.getAttribute('data-broker-form')], box = f && $('[name="contact_verified"]', f);
    if (b && box && e.target.value.trim().toLowerCase() !== String(b.contact_email).toLowerCase() && box.checked) { box.checked = false; O.announce('Nouvelle adresse' + NB + ': la case « contact vérifié » a été décochée.'); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && onAdmin()) $$('[data-armed]').forEach(function (b) { disarm(b); }); });
  // Retour arrière : app.js reçoit hashchange et reconstruit la vue (un écouteur popstate doublerait le chargement).
  window.addEventListener('resize', function () { if (!onAdmin()) return; fixWraps($('#adm-main')); $$('[data-chart]').forEach(function (fig) { $('.adm-chart__tip', fig).hidden = true; if (fig._geo && Math.abs($('.adm-chart__plot', fig).clientWidth - fig._geo.W) > 8) drawBars(fig); }); });

  O.registerView('admin', render, after);
})();
