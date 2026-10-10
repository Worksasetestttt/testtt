/* Oubli — module d'administration (chargé à la demande par app.js via window.Oubli.registerView). */
(function () {
  'use strict';
  var O = window.Oubli, api = O.api, esc = O.esc, toast = O.toast, chip = O.chip;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  function render() {
    return '<div class="page-head"><div><span class="mono">Administration</span><h1>Suivi global et réponses des courtiers.</h1></div><div class="btn-row"><button class="btn btn--outline btn--sm" type="button" id="admin-tick">Exécuter le planificateur</button></div></div><div id="admin-body"><span class="spinner"></span></div>';
  }
  function load() {
    api('/admin/stats').then(function (s) {
      var reqs = s.requests.map(function (r) { return '<div class="deadline"><b>' + r.n + '</b>' + chip(r.status) + '</div>'; }).join('');
      var act = s.action_required.map(function (r) { return '<div class="row" style="grid-template-columns:1fr auto"><div class="row__who"><strong>' + esc(r.broker) + '</strong><small>' + esc(r.email) + ' · OUBLI-' + esc(r.token) + '</small></div><div class="row__act"><button class="btn btn--sm" data-outcome="done" data-req="' + esc(r.id) + '" type="button">Effacée</button><button class="btn btn--outline btn--sm" data-outcome="in_progress" data-req="' + esc(r.id) + '" type="button">En cours</button><button class="btn btn--danger btn--sm" data-outcome="refused" data-req="' + esc(r.id) + '" type="button">Refus</button></div></div>'; }).join('');
      $('#admin-body').innerHTML = '<div class="stack"><section class="sheet counters"><div class="ledger__stat" style="padding-left:32px"><span class="mono">Comptes</span><span class="ledger__n">' + s.users + '</span></div><div class="ledger__stat ledger__stat--ok"><span class="mono">Abonnés actifs</span><span class="ledger__n">' + s.active + '</span></div><div class="ledger__stat"><span class="mono">Courriers</span><span class="ledger__n">' + s.mails + '</span></div></section><div class="dash-grid" style="margin-top:0"><section class="sheet"><div class="sheet__head"><h2>Actions requises à traiter</h2></div>' + (act || '<p class="empty">Rien en attente.</p>') + '</section><section class="sheet"><div class="sheet__head"><h2>Demandes par statut</h2></div><div class="deadlines">' + (reqs || '<p class="empty">Aucune</p>') + '</div></section></div><section class="sheet"><div class="sheet__head"><h2>Contacts des courtiers</h2><span class="mono">Vérifier avant tout envoi réel</span></div><div id="admin-brokers"><span class="spinner"></span></div></section></div>';
      return api('/brokers');
    }).then(function (b) {
      $('#admin-brokers').innerHTML = b.brokers.map(function (x) { return '<div class="row" style="grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) auto auto"><div class="row__who"><strong>' + esc(x.name) + '</strong><small>' + esc(x.category) + ' · ' + esc(x.jurisdiction) + '</small></div><div class="f"><input data-broker-email="' + x.id + '" value="' + esc(x.contact_email || '') + '" aria-label="Contact ' + esc(x.name) + '"></div><label class="check" style="align-items:center;font-size:.9rem"><input type="checkbox" data-broker-verified="' + x.id + '"' + (x.contact_verified ? ' checked' : '') + '> vérifié</label><button class="btn btn--outline btn--sm" type="button" data-broker-save="' + x.id + '">Enregistrer</button></div>'; }).join('');
    }).catch(function (e) { var b = $('#admin-body'); if (b) b.innerHTML = '<p class="notice">' + esc(e.message) + '</p>'; });
  }
  document.addEventListener('click', function (e) {
    if (O.params().route !== 'admin') return;
    var t = e.target.closest('button'); if (!t) return;
    if (t.id === 'admin-tick') { t.disabled = true; api('/admin/tick', { method: 'POST' }).then(function () { toast('Planificateur exécuté.'); load(); }).catch(function (err) { toast(err.message, true); }).finally(function () { t.disabled = false; }); }
    else if (t.hasAttribute('data-outcome')) { api('/admin/requests/' + t.getAttribute('data-req') + '/outcome', { body: { outcome: t.getAttribute('data-outcome') } }).then(function () { toast('Résultat enregistré.'); load(); }).catch(function (err) { toast(err.message, true); }); }
    else if (t.hasAttribute('data-broker-save')) { var id = t.getAttribute('data-broker-save'); api('/admin/brokers/' + id, { method: 'PUT', body: { contact_email: $('[data-broker-email="' + id + '"]').value, contact_verified: $('[data-broker-verified="' + id + '"]').checked } }).then(function () { toast('Contact enregistré.'); }).catch(function (err) { toast(err.message, true); }); }
  });
  O.registerView('admin', render, load);
})();
