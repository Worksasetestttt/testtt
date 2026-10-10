/* Oubli — « La rature » · interactions
   Vanilla JS, aucune dépendance. Tout est désactivé proprement sous prefers-reduced-motion. */
(function () {
  'use strict';

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduced = !!(reducedMQ && reducedMQ.matches);
  /* Lecture « vivante » de la préférence : un changement en cours de visite est pris en compte */
  if (reducedMQ && reducedMQ.addEventListener) reducedMQ.addEventListener('change', function (e) { reduced = e.matches; });
  var hasIO = 'IntersectionObserver' in window;
  var NNBSP = ' ', NBSP = ' ';
  var fmt = (function () {
    try { var f = new Intl.NumberFormat('fr-FR'); return function (n) { return f.format(n).replace(/[   ]/g, NNBSP); }; }
    catch (e) { return function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP); }; }
  })();
  var easeOut = function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); };
  var PLANS = { individuel: { name: 'Individuel', monthly: '12,99', annual: '6,99' }, famille: { name: 'Famille', monthly: '24,99', annual: '13,99' } };
  var chosenPlan = 'individuel';

  /* ---------- Observateur générique (fallback : tout visible) ---------- */
  function observe(els, cb, opts) {
    if (!els.length) return;
    if (!hasIO) { els.forEach(function (el) { cb(el); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); cb(en.target); } });
    }, opts || { threshold: 0.15 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Compteurs ---------- */
  function countTo(el, to, dur, done) {
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = (el.getAttribute('data-suffix') || '').replace(/&nbsp;/g, NBSP);
    var from = parseFloat(el.getAttribute('data-from') || '0');
    if (reduced || dur <= 0) { el.textContent = prefix + fmt(to) + suffix; if (done) done(); return; }
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      var v = Math.round(from + (to - from) * easeOut(t));
      el.textContent = prefix + fmt(v) + suffix;
      if (t < 1) requestAnimationFrame(frame); else { el.textContent = prefix + fmt(to) + suffix; if (done) done(); }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- Ancres : défilement doux (JS plutôt que CSS, pour rester pilotable) ---------- */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    var target = id ? document.getElementById(id) : document.documentElement;
    if (!target) return;
    e.preventDefault();
    if (a.hasAttribute('data-plan')) choosePlan(a.getAttribute('data-plan'));
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    try { if (history.pushState) history.pushState(null, '', '#' + id); } catch (err) { /* file:// */ }
    var focusEl = id === 'commencer' ? $('#signup-email') : target;
    if (!/^(a|button|input|select|textarea)$/i.test(focusEl.tagName) && !focusEl.hasAttribute('tabindex')) focusEl.setAttribute('tabindex', '-1');
    focusEl.focus({ preventScroll: true });
    if (/^faq-\d+$/.test(id)) window.dispatchEvent(new Event('hashchange'));
  });

  /* ---------- Nav ---------- */
  var nav = $('.nav');
  var ticking = false;
  function onScroll() {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () {
      nav.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var navLinks = $$('[data-nav]');
  if (hasIO && navLinks.length) {
    var map = {};
    navLinks.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var visible = {};
    var navIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      var activeId = Object.keys(map).filter(function (id) { return visible[id]; })[0];
      navLinks.forEach(function (a) { a.classList.toggle('is-active', !!activeId && map[activeId] === a); });
    }, { rootMargin: '-40% 0px -55% 0px' });
    Object.keys(map).forEach(function (id) { var s = document.getElementById(id); if (s) navIO.observe(s); });
  }

  /* ---------- Menu mobile ---------- */
  var burger = $('.burger'), menu = $('#menu-mobile');
  var lastFocus = null;
  function focusables(root) {
    return $$('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])', root).filter(function (el) { return el.offsetParent !== null; });
  }
  function openMenu() {
    lastFocus = document.activeElement;
    menu.hidden = false;
    burger.setAttribute('aria-expanded', 'true');
    burger.setAttribute('aria-label', 'Fermer le menu');
    document.body.classList.add('menu-open');
    var f = focusables(menu); if (f.length) f[0].focus();
  }
  function closeMenu() {
    menu.hidden = true;
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Ouvrir le menu');
    document.body.classList.remove('menu-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  if (burger && menu) {
    burger.addEventListener('click', function () { menu.hidden ? openMenu() : closeMenu(); });
    $$('a', menu).forEach(function (a) { a.addEventListener('click', closeMenu); });
    document.addEventListener('keydown', function (e) {
      if (menu.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
      if (e.key === 'Tab') {
        var f = focusables(menu); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); burger.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); burger.focus(); }
        else if (!e.shiftKey && document.activeElement === burger) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === burger) { e.preventDefault(); last.focus(); }
      }
    });
    window.matchMedia('(min-width: 900px)').addEventListener('change', function (e) { if (e.matches && !menu.hidden) closeMenu(); });
  }

  /* ---------- Folio de marge ---------- */
  var folio = $('#folio-num');
  if (folio && hasIO) {
    var folioIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var v = en.target.getAttribute('data-folio') || '';
        if (folio.textContent === v) return;
        folio.classList.add('is-fading');
        setTimeout(function () { folio.textContent = v; folio.classList.remove('is-fading'); }, reduced ? 0 : 200);
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    $$('[data-folio]').forEach(function (s) { folioIO.observe(s); });
  }

  /* ---------- Hero : chorégraphie ---------- */
  var dash = $('#dash');
  var state = { sent: 137, pending: 41, done: 96 };
  var live = $('#dash-live');
  function announce() {
    if (live) live.textContent = state.sent + ' demandes envoyées, ' + state.pending + ' en cours, ' + state.done + ' terminées.';
  }
  function setRing(animate) {
    var pct = Math.round(state.done / state.sent * 100);
    var fill = $('#ring-fill'), txt = $('#ring-pct');
    if (fill) { fill.style.strokeDashoffset = String(1 - pct / 100); }
    if (txt) txt.textContent = pct + NBSP + '%';
  }
  function statEl(key) { return $('#stat-' + key + ' .stat__val'); }
  function bump(key, delta) {
    state[key] += delta;
    var el = statEl(key);
    if (el) { el.setAttribute('data-from', String(state[key] - delta)); countTo(el, state[key], 500); }
    if (key === 'sent') { var m = $('#dash-more-n'); if (m) m.textContent = String(state.sent); }
    setRing();
    announce();
  }

  function heroIntro() {
    /* Chorégraphie resserrée : tout est en place avant 1,1 s, la rature est tracée à ~760 ms */
    var at = function (ms, fn) { setTimeout(fn, reduced ? 0 : ms); };
    var lines = $$('.h1__line');
    $('.eyebrow--hero') && $('.eyebrow--hero').classList.add('is-in');
    lines.forEach(function (l, i) { at(i * 80, function () { l.classList.add('is-in'); }); });
    at(120, function () { $('.hero__copy').classList.add('is-in'); });
    at(200, function () { $('#fig1').classList.add('is-in'); });
    at(300, function () {
      ['sent', 'pending', 'done'].forEach(function (k) {
        var el = statEl(k); if (!el) return;
        el.setAttribute('data-from', '0');
        countTo(el, state[k], 650);
      });
      var fill = $('#ring-fill');
      if (fill) { fill.classList.add('is-zero'); void fill.getBoundingClientRect(); fill.classList.remove('is-zero'); setRing(); }
      setTimeout(announce, 900);
    });
    at(340, function () { var r = $('#rature-hero'); if (r) r.classList.add('is-drawn'); });
    at(350, function () {
      $$('#dash-rows .row').forEach(function (r, i) { at(i * 45, function () { r.classList.add('is-in'); }); });
    });
    at(400, function () { $('#fig1-legend').classList.add('is-in'); });
    at(780, function () {
      layoutAnnotations();
      $$('.mark-n').forEach(function (m, i) { at(i * 100, function () { m.classList.add('is-in'); var g = $('#fig1-lines g[data-n="' + m.getAttribute('data-n') + '"]'); if (g) g.classList.add('is-drawn'); }); });
      at(400, function () { drawn = true; });
    });
  }

  /* ---------- Annotations de la Fig. 1 (hairlines calculées en px) ---------- */
  var wrap = $('#fig1-wrap'), lines = $('#fig1-lines'), drawn = false;
  var SVGNS = 'http://www.w3.org/2000/svg';
  function layoutAnnotations() {
    if (!wrap || !lines || window.innerWidth < 1024) return;
    var wr = wrap.getBoundingClientRect();
    lines.setAttribute('viewBox', '0 0 ' + wr.width + ' ' + wr.height);
    while (lines.firstChild) lines.removeChild(lines.firstChild);
    $$('.mark-n').forEach(function (m) {
      var target = $(m.getAttribute('data-target'));
      if (!target) return;
      var tr = target.getBoundingClientRect();
      var side = m.getAttribute('data-side');
      var cy = tr.top - wr.top + tr.height / 2;
      var mx = side === 'left' ? 10 : wr.width - 10;
      var ex = side === 'left' ? tr.left - wr.left - 8 : tr.right - wr.left + 8;
      var sx = side === 'left' ? 20 : wr.width - 20;
      m.style.left = mx + 'px'; m.style.top = cy + 'px';
      var g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('data-n', m.getAttribute('data-n'));
      if (drawn || reduced) g.setAttribute('class', 'is-drawn');
      var ln = document.createElementNS(SVGNS, 'line');
      ln.setAttribute('x1', sx); ln.setAttribute('y1', cy); ln.setAttribute('x2', ex); ln.setAttribute('y2', cy); ln.setAttribute('pathLength', '1');
      var dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', ex); dot.setAttribute('cy', cy); dot.setAttribute('r', '1.75');
      g.appendChild(ln); g.appendChild(dot); lines.appendChild(g);
    });
  }
  function hot(n, on) {
    var m = $('.mark-n[data-n="' + n + '"]'), g = $('#fig1-lines g[data-n="' + n + '"]'), li = $('.legend__item[data-for="' + n + '"]');
    if (m) { m.classList.toggle('is-hot', on); var t = $(m.getAttribute('data-target')); if (t) t.classList.toggle('is-target', on); }
    if (g) g.classList.toggle('is-hot', on);
    if (li) li.classList.toggle('is-hot', on);
  }
  $$('.legend__item').forEach(function (li) {
    var n = li.getAttribute('data-for');
    li.addEventListener('mouseenter', function () { hot(n, true); });
    li.addEventListener('mouseleave', function () { hot(n, false); });
  });
  $$('.mark-n').forEach(function (m) {
    var n = m.getAttribute('data-n');
    m.addEventListener('mouseenter', function () { hot(n, true); });
    m.addEventListener('mouseleave', function () { hot(n, false); });
  });
  var rlTimer;
  window.addEventListener('resize', function () { clearTimeout(rlTimer); rlTimer = setTimeout(layoutAnnotations, 120); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(layoutAnnotations, 50); });

  /* ---------- Boucle « vivante » du tableau de bord ---------- */
  var POOL = [
    { name: 'LexisNexis', cat: 'Risque & identité', sens: 3 },
    { name: 'Whitepages', cat: 'Annuaire', sens: 3 },
    { name: 'Epsilon', cat: 'Fidélité', sens: 2 },
    { name: 'Radaris', cat: 'Recherche de personnes', sens: 3 },
    { name: 'ZoomInfo', cat: 'B2B', sens: 1 },
    { name: 'Intelius', cat: 'Recherche de personnes', sens: 3 },
    { name: 'Clearbit', cat: 'B2B', sens: 1 },
    { name: 'TruthFinder', cat: 'Vérification', sens: 3 }
  ];
  var poolIx = 0, loopTimer = null, cardVisible = true, rows = $('#dash-rows');
  var SENS_TXT = { 1: 'identifiant publicitaire', 2: 'adresse, âge', 3: 'adresse, âge, proches' };
  function makeRow(b) {
    var li = document.createElement('li');
    li.className = 'row'; li.setAttribute('data-status', 'sent');
    var dots = '';
    for (var i = 1; i <= 3; i++) dots += '<i' + (i <= b.sens ? ' class="on"' : '') + '></i>';
    li.innerHTML =
      '<span class="row__sens" title="Sensibilité ' + b.sens + '/3' + NNBSP + ': ' + SENS_TXT[b.sens] + '"><span class="vh">Sensibilité ' + b.sens + ' sur 3.</span>' + dots + '</span>' +
      '<span class="row__who"><strong></strong><span class="row__cat"></span></span>' +
      '<span class="row__status"><span class="chip chip--sent">Envoyée</span></span>';
    $('strong', li).textContent = b.name;
    $('.row__cat', li).textContent = b.cat;
    return li;
  }
  function setChip(row, status) {
    var holder = $('.row__status', row);
    row.setAttribute('data-status', status);
    var chip = document.createElement('span');
    chip.className = 'chip ' + (status === 'done' ? 'chip--done stamp-anim' : status === 'pending' ? 'chip--pending' : 'chip--sent');
    chip.textContent = status === 'done' ? 'Terminée' : status === 'pending' ? 'En cours' : 'Envoyée';
    holder.innerHTML = ''; holder.appendChild(chip);
    if (status === 'done') { void chip.getBoundingClientRect(); chip.classList.add('is-stamped'); }
  }
  function tick() {
    if (!rows || document.hidden || !cardVisible) return;
    var pending = $('.row[data-status="pending"]', rows);
    if (pending) {
      setChip(pending, 'done');
      pending.classList.add('is-flash');
      setTimeout(function () { pending.classList.remove('is-flash'); }, 600);
      bump('pending', -1); bump('done', 1);
    }
    setTimeout(function () {
      var first = $('.row', rows);
      if (!first) return;
      /* FLIP : la première ligne sort du flux et s'efface ; les autres (et la nouvelle) glissent de 48 px vers le haut — transform/opacity uniquement */
      var fresh = makeRow(POOL[poolIx++ % POOL.length]);
      fresh.classList.add('is-in');
      rows.appendChild(fresh);
      first.classList.add('is-leaving');
      var movers = $$('.row', rows).filter(function (r) { return r !== first; });
      movers.forEach(function (r) { r.classList.add('is-shift'); });
      void rows.getBoundingClientRect();
      requestAnimationFrame(function () { requestAnimationFrame(function () { movers.forEach(function (r) { r.classList.add('is-shifting'); }); }); });
      bump('sent', 1);
      setTimeout(function () {
        if (first.parentNode) first.parentNode.removeChild(first);
        movers.forEach(function (r) { r.classList.remove('is-shift'); r.classList.remove('is-shifting'); });
        layoutAnnotations();
      }, 460);
    }, 1600);
    setTimeout(function () {
      var sent = $('.row[data-status="sent"]', rows);
      if (sent) { setChip(sent, 'pending'); bump('pending', 1); }
    }, 4200);
  }
  function startLoop() { if (reduced || loopTimer) return; loopTimer = setInterval(tick, 7000); }
  function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }
  document.addEventListener('visibilitychange', function () { document.hidden ? stopLoop() : startLoop(); });
  if (dash && hasIO) {
    new IntersectionObserver(function (entries) {
      cardVisible = entries[0].isIntersecting;
      cardVisible ? startLoop() : stopLoop();
    }, { threshold: 0.2 }).observe(dash);
  }

  if (dash) {
    heroIntro();
    if (!reduced) setTimeout(startLoop, 4000);
    else { setRing(); announce(); }
  }

  /* ---------- Reveals ---------- */
  observe($$('.reveal'), function (el) { el.classList.add('is-in'); }, { threshold: 0.15 });

  /* ---------- Grands chiffres & compteurs du comparatif ---------- */
  observe($$('.figure__num.num, .cmp__big .num'), function (el) {
    var to = parseFloat(el.getAttribute('data-count'));
    if (!isNaN(to)) countTo(el, to, 1100);
  }, { threshold: 0.5 });

  /* ---------- Ratures de section ---------- */
  observe($$('.rature--scroll'), function (el) { setTimeout(function () { el.classList.add('is-drawn'); }, 250); }, { threshold: 0.6 });

  /* ---------- Fiche caviardée ---------- */
  var sheet = $('#sheet');
  if (sheet) {
    observe([sheet], function () {
      var bars = $$('.redact', sheet).sort(function (a, b) { return a.getAttribute('data-order') - b.getAttribute('data-order'); });
      bars.forEach(function (b, i) { setTimeout(function () { b.classList.add('is-on'); }, reduced ? 0 : i * 120); });
      setTimeout(function () { var s = $('#sheet-stamp'); if (s) s.classList.add('is-stamped'); }, reduced ? 0 : bars.length * 120 + 380 + 200);
    }, { threshold: 0.4 });
  }

  /* ---------- Timeline Fonctionnement ---------- */
  var steps = $$('.step'), fill = $('#steps-fill'), rail = $('.steps__rail');
  if (steps.length && hasIO) {
    var stepIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        steps.forEach(function (s) { s.classList.remove('is-active'); });
        en.target.classList.add('is-active'); en.target.classList.add('is-seen');
        if (fill && rail) {
          var rr = rail.getBoundingClientRect(), sr = en.target.getBoundingClientRect();
          var ratio = rr.height ? Math.max(0, Math.min(1, (sr.top - rr.top + sr.height * 0.6) / rr.height)) : 1;
          fill.style.transform = 'scaleY(' + ratio.toFixed(4) + ')';
        }
        if (en.target.id === 'etape-3') { var st = $('#step3-stamp'); if (st) setTimeout(function () { st.classList.add('is-stamped'); }, reduced ? 0 : 350); }
      });
    }, { rootMargin: '-35% 0px -45% 0px' });
    steps.forEach(function (s) { stepIO.observe(s); });
    /* « vu » (signature, tampon) avec une fenêtre plus large que « actif », pour ne jamais rater une étape */
    observe(steps, function (el) {
      el.classList.add('is-seen');
      if (el.id === 'etape-3') { var st = $('#step3-stamp'); if (st) setTimeout(function () { st.classList.add('is-stamped'); }, reduced ? 0 : 350); }
    }, { threshold: 0.3 });
  } else {
    steps.forEach(function (s) { s.classList.add('is-active'); s.classList.add('is-seen'); });
    var st3 = $('#step3-stamp'); if (st3) st3.classList.add('is-stamped');
    if (fill) fill.style.transform = 'scaleY(1)';
  }

  /* ---------- Fig. 3 : anneau d'exposition (78 % → 23 %, jalons J0 / J+30 / J+90) ---------- */
  var expo = $('#expo-ring');
  if (expo) {
    var ticks = $('#expo-ticks'), efill = $('#expo-fill'), eval_ = $('#expo-val');
    var from = parseFloat(expo.getAttribute('data-from')), to = parseFloat(expo.getAttribute('data-to'));
    var ms = $$('.milestones li');
    if (ticks && !ticks.childNodes.length) {
      for (var i = 0; i < 24; i++) {
        var a = i / 24 * Math.PI * 2, c = 100, ro = 97, len = i % 6 === 0 ? 7 : 4;
        var l = document.createElementNS(SVGNS, 'line');
        l.setAttribute('x1', (c + Math.cos(a) * ro).toFixed(2)); l.setAttribute('y1', (c + Math.sin(a) * ro).toFixed(2));
        l.setAttribute('x2', (c + Math.cos(a) * (ro - len)).toFixed(2)); l.setAttribute('y2', (c + Math.sin(a) * (ro - len)).toFixed(2));
        ticks.appendChild(l);
      }
    }
    function setExpo(v) {
      if (efill) efill.style.strokeDashoffset = String(1 - v / 100);
      if (eval_) eval_.textContent = String(Math.round(v));
      ms.forEach(function (li) { li.classList.toggle('is-on', v <= parseFloat(li.getAttribute('data-ms')) + 0.5); });
    }
    setExpo(reduced ? to : from);
    observe([expo], function () {
      if (reduced) { setExpo(to); return; }
      var start = null, dur = 1800;
      (function frame(ts) {
        if (start === null) start = ts;
        var t = Math.min(1, (ts - start) / dur);
        setExpo(from + (to - from) * easeOut(t));
        if (t < 1) requestAnimationFrame(frame); else setExpo(to);
      })(performance.now());
    }, { threshold: 0.4 });
  }

  /* ---------- Toggle tarifs ---------- */
  var billing = $('#billing');
  if (billing) {
    var opts = $$('.toggle__opt', billing), badge = $('#badge-save');
    var current = 'annual';
    /* Mémoire de visite seulement (sessionStorage) : un visiteur qui revient retrouve l'annuel par défaut */
    try { var saved = sessionStorage.getItem('oubli-billing'); if (saved === 'monthly' || saved === 'annual') current = saved; } catch (e) { /* stockage indisponible */ }
    function render(period, animate) {
      billing.setAttribute('data-period', period);
      opts.forEach(function (o) {
        var on = o.getAttribute('data-period') === period;
        o.setAttribute('aria-checked', on ? 'true' : 'false');
        o.setAttribute('tabindex', on ? '0' : '-1');
      });
      $$('.price').forEach(function (p) {
        var num = $('[data-price]', p), was = $('[data-was]', p), note = $('[data-note]', p);
        var val = p.getAttribute(period === 'annual' ? 'data-annual' : 'data-monthly') + NBSP + '€';
        var noteTxt = note.getAttribute(period === 'annual' ? 'data-annual-note' : 'data-monthly-note');
        was.classList.toggle('is-hidden', period !== 'annual');
        if (!animate || reduced) { num.textContent = val; note.innerHTML = noteTxt; return; }
        num.classList.add('is-out');
        setTimeout(function () {
          num.textContent = val; note.innerHTML = noteTxt;
          num.classList.remove('is-out'); num.classList.add('is-in-from');
          void num.getBoundingClientRect();
          num.classList.remove('is-in-from'); num.classList.add('is-in');
          setTimeout(function () { num.classList.remove('is-in'); }, 240);
        }, 220);
      });
      if (animate && period === 'annual' && badge && !reduced) { badge.classList.remove('is-pulse'); void badge.getBoundingClientRect(); badge.classList.add('is-pulse'); }
      try { sessionStorage.setItem('oubli-billing', period); } catch (e) { /* ignore */ }
      syncSignup();
    }
    render(current, false);
    opts.forEach(function (o) {
      o.addEventListener('click', function () { var p = o.getAttribute('data-period'); if (p !== billing.getAttribute('data-period')) render(p, true); });
      o.addEventListener('keydown', function (e) {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
        e.preventDefault();
        var p = billing.getAttribute('data-period') === 'annual' ? 'monthly' : 'annual';
        render(p, true);
        var target = opts.filter(function (x) { return x.getAttribute('data-period') === p; })[0]; if (target) target.focus();
      });
    });
  }

  /* ---------- FAQ ---------- */
  var items = $$('.faq__item');
  if (items.length) {
    items.forEach(function (d) { d.removeAttribute('name'); });
    function openItem(d) {
      d.open = true;
      requestAnimationFrame(function () { requestAnimationFrame(function () { d.classList.add('is-open'); }); });
    }
    function closeItem(d) {
      if (!d.open) return;
      d.classList.remove('is-open');
      if (reduced) { d.open = false; return; }
      var body = $('.faq__body', d);
      var onEnd = function (e) { if (e.propertyName === 'grid-template-rows') { d.open = false; body.removeEventListener('transitionend', onEnd); } };
      body.addEventListener('transitionend', onEnd);
      setTimeout(function () { if (!d.classList.contains('is-open')) { d.open = false; body.removeEventListener('transitionend', onEnd); } }, 320);
    }
    items.forEach(function (d) {
      $('summary', d).addEventListener('click', function (e) {
        e.preventDefault();
        if (d.open && d.classList.contains('is-open')) { closeItem(d); return; }
        items.forEach(function (o) { if (o !== d) closeItem(o); });
        openItem(d);
      });
      if (d.open) d.classList.add('is-open');
    });
    function fromHash() {
      var h = location.hash;
      if (!/^#faq-\d+$/.test(h)) return;
      var d = $(h); if (!d || !d.classList.contains('faq__item')) return;
      items.forEach(function (o) { if (o !== d) closeItem(o); });
      openItem(d);
    }
    window.addEventListener('hashchange', fromHash);
    fromHash();
  }

  /* ---------- CTA final : rature du mark ---------- */
  var finalMark = $('.final__mark');
  if (finalMark) observe([$('#cta-final')], function () { finalMark.classList.add('is-drawn'); }, { threshold: 0.4 });

  /* ---------- Formulaire « Commencer » : l'offre choisie suit les cartes et la périodicité ---------- */
  function syncSignup() {
    var p = PLANS[chosenPlan]; if (!p) return;
    var period = billing ? billing.getAttribute('data-period') || 'annual' : 'annual';
    var price = p[period === 'annual' ? 'annual' : 'monthly'] + NBSP + '€/mois';
    var n = $('#signup-plan-name'), per = $('#signup-plan-period'), pp = $('#signup-plan-price'), bp = $('#signup-price');
    if (n) n.textContent = p.name;
    if (per) per.textContent = period === 'annual' ? 'annuel' : 'mensuel';
    if (pp) pp.textContent = price;
    if (bp) bp.textContent = price;
  }
  function choosePlan(id) { if (PLANS[id]) { chosenPlan = id; syncSignup(); } }
  syncSignup();
  var signup = $('#commencer');
  if (signup) {
    var sInput = $('#signup-email'), sMsg = $('#signup-msg'), sBtn = $('#signup-btn');
    signup.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = sInput.value.trim();
      var ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && sInput.checkValidity();
      if (!ok) {
        sInput.setAttribute('aria-invalid', 'true');
        sMsg.classList.add('is-error'); sMsg.textContent = 'Adresse invalide.';
        sInput.focus();
        return;
      }
      sInput.removeAttribute('aria-invalid');
      sMsg.classList.remove('is-error'); sMsg.textContent = 'Ouverture du dossier…';
      sBtn.disabled = true;
      var period = billing ? billing.getAttribute('data-period') || 'annual' : 'annual';
      var appUrl = '/app/#signup?email=' + encodeURIComponent(v) + '&plan=' + encodeURIComponent(chosenPlan) + '&billing=' + encodeURIComponent(period);
      /* Avec le serveur : ouverture du dossier dans l'application. Page servie seule (aperçu statique) : confirmation simulée. */
      var simulate = function () {
        sBtn.disabled = false;
        sMsg.innerHTML = '';
        var s = document.createElement('span'); s.className = 'stamp stamp--small stamp-anim'; s.textContent = 'Dossier ouvert';
        sMsg.appendChild(s); sMsg.appendChild(document.createTextNode(' Nous vous écrivons pour signer le mandat. Première vague sous 48' + NBSP + 'h.'));
        void s.getBoundingClientRect(); s.classList.add('is-stamped');
        sInput.value = '';
      };
      if (window.fetch && location.protocol !== 'file:') {
        fetch('/api/health', { cache: 'no-store' }).then(function (r) { if (r.ok) window.location.href = appUrl; else simulate(); }).catch(simulate);
      } else setTimeout(simulate, 600);
    });
    sInput.addEventListener('input', function () { if (sMsg.classList.contains('is-error')) { sMsg.textContent = ''; sMsg.classList.remove('is-error'); sInput.removeAttribute('aria-invalid'); } });
  }

  /* ---------- CTA mobile persistant : après le hero, retiré sur Tarifs et sur le formulaire ---------- */
  var sticky = $('#sticky-cta'), heroSec = $('#hero'), pricingSec = $('#tarifs'), finalSec = $('#cta-final');
  if (sticky && heroSec && pricingSec && hasIO) {
    var pastHero = false, onPricing = false, onFinal = false, stickyLink = $('a', sticky);
    var narrowMQ = window.matchMedia('(max-width: 767px)');
    function updateSticky() {
      var on = pastHero && !onPricing && !onFinal && narrowMQ.matches && (!menu || menu.hidden);
      sticky.classList.toggle('is-on', on);
      sticky.setAttribute('aria-hidden', on ? 'false' : 'true');
      stickyLink.tabIndex = on ? 0 : -1;
      document.body.classList.toggle('has-sticky-cta', on);
    }
    new IntersectionObserver(function (entries) { entries.forEach(function (en) { pastHero = !en.isIntersecting && en.boundingClientRect.bottom < 0; }); updateSticky(); }, { threshold: 0 }).observe(heroSec);
    new IntersectionObserver(function (entries) { entries.forEach(function (en) { onPricing = en.isIntersecting; }); updateSticky(); }, { threshold: 0.1 }).observe(pricingSec);
    if (finalSec) new IntersectionObserver(function (entries) { entries.forEach(function (en) { onFinal = en.isIntersecting; }); updateSticky(); }, { threshold: 0.1 }).observe(finalSec);
    window.addEventListener('resize', updateSticky);
    /* Le menu mobile masque le CTA ; on suit son attribut hidden (clic, Échap, lien) */
    if (menu && 'MutationObserver' in window) new MutationObserver(updateSticky).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* ---------- Newsletter ---------- */
  var form = $('#newsletter');
  if (form) {
    var input = $('#news-email'), msg = $('#news-msg'), btn = $('#news-btn');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      var ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && input.checkValidity();
      if (!ok) {
        input.setAttribute('aria-invalid', 'true');
        msg.classList.add('is-error'); msg.textContent = 'Adresse invalide.';
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
      msg.classList.remove('is-error'); msg.textContent = 'Envoi…';
      btn.disabled = true;
      var done = function () {
        btn.disabled = false;
        msg.innerHTML = '';
        var s = document.createElement('span'); s.className = 'stamp stamp--small stamp-anim'; s.textContent = 'Inscrit';
        msg.appendChild(s); msg.appendChild(document.createTextNode(' À bientôt.'));
        void s.getBoundingClientRect(); s.classList.add('is-stamped');
        input.value = '';
      };
      var fail = function () { btn.disabled = false; msg.classList.add('is-error'); msg.textContent = 'Inscription impossible pour le moment. Réessayez plus tard.'; };
      if (window.fetch && location.protocol !== 'file:') {
        fetch('/api/newsletter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: v }) }).then(function (r) { if (r.ok) done(); else fail(); }).catch(fail);
      } else setTimeout(done, 600);
    });
    input.addEventListener('input', function () { if (msg.classList.contains('is-error')) { msg.textContent = ''; msg.classList.remove('is-error'); input.removeAttribute('aria-invalid'); } });
  }
})();
