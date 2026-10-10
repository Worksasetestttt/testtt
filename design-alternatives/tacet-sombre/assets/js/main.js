/* Tacet — main.js (vanilla, no dependencies) */
(function () {
  'use strict';

  var doc = document;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var hasIO = 'IntersectionObserver' in window;
  var NNBSP = ' ';
  var easeOut = function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); };

  function fmt(n) {
    var s = String(Math.round(n));
    var out = '';
    while (s.length > 3) { out = NNBSP + s.slice(-3) + out; s = s.slice(0, -3); }
    return s + out;
  }
  function onVisible(el, cb, threshold) {
    if (!hasIO) { cb(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); cb(); } });
    }, { threshold: threshold == null ? 0.35 : threshold });
    io.observe(el);
  }
  function animateNumber(from, to, duration, onUpdate, onDone) {
    if (reduceMotion) { onUpdate(to); if (onDone) onDone(); return; }
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      onUpdate(from + (to - from) * easeOut(t));
      if (t < 1) requestAnimationFrame(frame); else if (onDone) onDone();
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ Nav */
  var nav = doc.querySelector('.nav');
  var spyLinks = Array.prototype.slice.call(doc.querySelectorAll('.nav__links a[data-spy]'));
  var rature = doc.querySelector('.nav__rature');
  var navTicking = false;
  function onScrollNav() {
    if (navTicking) return;
    navTicking = true;
    requestAnimationFrame(function () {
      nav.classList.toggle('is-scrolled', window.scrollY > 10);
      navTicking = false;
    });
  }
  window.addEventListener('scroll', onScrollNav, { passive: true });
  onScrollNav();

  function setActiveLink(link) {
    spyLinks.forEach(function (a) { a.classList.toggle('is-active', a === link); });
    if (!rature) return;
    if (!link) { rature.classList.remove('is-on'); return; }
    rature.style.left = link.offsetLeft + 12 + 'px';
    rature.style.width = link.offsetWidth - 24 + 'px';
    rature.classList.add('is-on');
  }
  if (hasIO && spyLinks.length) {
    var spyMap = {};
    spyLinks.forEach(function (a) { spyMap[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) setActiveLink(spyMap[e.target.id]); });
    }, { rootMargin: '-40% 0px -55% 0px' });
    Object.keys(spyMap).forEach(function (id) { var s = doc.getElementById(id); if (s) spy.observe(s); });
    var heroEl = doc.querySelector('.hero');
    if (heroEl) new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) setActiveLink(null); });
    }, { rootMargin: '-40% 0px -55% 0px' }).observe(heroEl);
    window.addEventListener('resize', function () { var cur = doc.querySelector('.nav__links a.is-active'); if (cur) setActiveLink(cur); });
  }

  /* ---------------------------------------------------------- Mobile menu */
  var burger = doc.querySelector('.nav__burger');
  var menu = doc.getElementById('mobile-menu');
  var lastFocus = null;
  function menuFocusables() { return Array.prototype.slice.call(menu.querySelectorAll('a, button')); }
  function openMenu() {
    lastFocus = doc.activeElement;
    menu.hidden = false;
    burger.setAttribute('aria-expanded', 'true');
    doc.body.classList.add('menu-open');
    var f = menuFocusables(); if (f[0]) f[0].focus();
  }
  function closeMenu(restore) {
    menu.hidden = true;
    burger.setAttribute('aria-expanded', 'false');
    doc.body.classList.remove('menu-open');
    if (restore !== false) burger.focus();
  }
  if (burger && menu) {
    burger.addEventListener('click', function () { menu.hidden ? openMenu() : closeMenu(); });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) closeMenu(false); });
    doc.addEventListener('keydown', function (e) {
      if (menu.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
      if (e.key === 'Tab') {
        var f = menuFocusables().concat([burger]);
        var first = burger, last = f[f.length - 2];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    window.matchMedia('(min-width: 1024px)').addEventListener('change', function (m) { if (m.matches && !menu.hidden) closeMenu(false); });
  }

  /* --------------------------------------------------------- H1 rature */
  var rw = doc.getElementById('rature-word');
  if (rw && !reduceMotion) {
    setTimeout(function () {
      rw.classList.add('is-sweeping');
      setTimeout(function () {
        rw.classList.remove('is-sweeping');
        rw.classList.add('is-struck', 'is-retracting');
        setTimeout(function () { rw.classList.remove('is-retracting'); }, 440);
        setTimeout(function () { rw.classList.remove('is-struck'); }, 900 + 420);
      }, 540);
    }, 520);
  }

  /* ------------------------------------------- Product window perspective */
  var wrap = doc.querySelector('.window-wrap');
  var wide = window.matchMedia('(min-width: 768px)');
  if (wrap && !reduceMotion) {
    var pTick = false;
    function updateP() {
      if (pTick) return; pTick = true;
      requestAnimationFrame(function () {
        var p = wide.matches ? Math.min(1, Math.max(0, window.scrollY / 240)) : 1;
        wrap.style.setProperty('--p', p.toFixed(3));
        pTick = false;
      });
    }
    window.addEventListener('scroll', updateP, { passive: true });
    updateP();
  } else if (wrap) { wrap.style.setProperty('--p', '1'); }

  /* ------------------------------------------------------------ Rings */
  function buildTicks(ring) {
    var svg = ring.querySelector('svg');
    var g = ring.querySelector('.ring__ticks');
    if (!g || g.childNodes.length) return;
    var vb = svg.viewBox.baseVal; var c = vb.width / 2; var rOuter = c - 1; var len = ring.classList.contains('ring--lg') ? 6 : 3;
    var ns = 'http://www.w3.org/2000/svg';
    for (var i = 0; i < 24; i++) {
      var a = (i / 24) * Math.PI * 2;
      var l = doc.createElementNS(ns, 'line');
      l.setAttribute('x1', (c + Math.cos(a) * rOuter).toFixed(2)); l.setAttribute('y1', (c + Math.sin(a) * rOuter).toFixed(2));
      l.setAttribute('x2', (c + Math.cos(a) * (rOuter - len)).toFixed(2)); l.setAttribute('y2', (c + Math.sin(a) * (rOuter - len)).toFixed(2));
      g.appendChild(l);
    }
  }
  function setRing(ring, pct) {
    var bar = ring.querySelector('.ring__bar');
    var r = parseFloat(bar.getAttribute('r')); var C = 2 * Math.PI * r;
    bar.style.strokeDasharray = C.toFixed(2);
    bar.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(2);
    var v = ring.querySelector('[data-ring-val]'); if (v) v.textContent = String(Math.round(pct));
  }
  Array.prototype.forEach.call(doc.querySelectorAll('[data-ring]'), function (ring) {
    buildTicks(ring);
    var from = parseFloat(ring.getAttribute('data-from')), to = parseFloat(ring.getAttribute('data-to'));
    setRing(ring, from);
    var ms = ring.hasAttribute('data-milestones') ? Array.prototype.slice.call(ring.parentNode.querySelectorAll('.milestones li')) : [];
    onVisible(ring, function () {
      animateNumber(from, to, 1800, function (v) {
        setRing(ring, v);
        ms.forEach(function (li) { if (v <= parseFloat(li.getAttribute('data-ms')) + 0.5) li.classList.add('is-on'); });
      });
    }, 0.4);
  });

  /* ----------------------------------------------------- Generic counters */
  Array.prototype.forEach.call(doc.querySelectorAll('[data-count]'), function (el) {
    if (el.hasAttribute('data-roll')) return; // hero tiles handled by the mock
    var to = parseFloat(el.getAttribute('data-count'));
    el.textContent = fmt(to);
    el.setAttribute('aria-hidden', 'true');
    var sr = doc.createElement('span'); sr.className = 'visually-hidden'; sr.textContent = fmt(to);
    el.parentNode.insertBefore(sr, el.nextSibling);
    onVisible(el, function () { animateNumber(0, to, 1400, function (v) { el.textContent = fmt(v); }); });
  });

  /* ------------------------------------------------------------ Mock */
  var ROWS = [
    { name: 'Acxiom', cat: 'Marketing', data: ['nom', 'adresse', 'e-mail'], risk: 'high', status: 'done' },
    { name: 'Spokeo', cat: 'Recherche de personnes', data: ['nom', 'adresse', 'téléphone'], risk: 'high', status: 'progress' },
    { name: 'Whitepages', cat: 'Recherche de personnes', data: ['nom', 'adresse'], risk: 'mid', status: 'sent' },
    { name: 'LiveRamp', cat: 'Marketing', data: ['e-mail', 'identifiants pub'], risk: 'mid', status: 'progress' },
    { name: 'Radaris', cat: 'Recherche de personnes', data: ['nom', 'âge', 'proches'], risk: 'high', status: 'action' },
    { name: 'Epsilon', cat: 'Marketing', data: ['adresse', 'segments'], risk: 'low', status: 'done' },
    { name: 'BeenVerified', cat: 'Recherche de personnes', data: ['nom', 'adresse', 'téléphone'], risk: 'high', status: 'sent' }
  ];
  var STATUS = { sent: 'Envoyée', progress: 'En cours', done: 'Terminée', action: 'Action requise' };
  var RISK = { high: 'Élevé', mid: 'Moyen', low: 'Faible' };
  var rowsEl = doc.getElementById('mock-rows');
  var logEl = doc.getElementById('mock-log');
  var windowEl = doc.getElementById('product');
  var counts = { sent: 412, progress: 137, done: 268 };
  var tiles = {};
  Array.prototype.forEach.call(doc.querySelectorAll('[data-roll]'), function (t) { tiles[t.getAttribute('data-roll')] = t; });

  function statusChip(status, name) {
    var wrapEl = doc.createElement('span'); wrapEl.className = 'mock-row__status';
    var chip = doc.createElement('span'); chip.className = 'status status--' + status; chip.textContent = STATUS[status];
    wrapEl.appendChild(chip);
    if (status === 'action') { var b = doc.createElement('span'); b.className = 'mini-btn'; b.textContent = 'Vérifier'; wrapEl.appendChild(b); }
    return wrapEl;
  }
  function renderRow(r) {
    var row = doc.createElement('div'); row.className = 'mock-row' + (r.status === 'done' ? ' is-done' : ''); row.setAttribute('data-name', r.name);
    var n = doc.createElement('span'); n.className = 'mock-row__name'; n.textContent = r.name;
    var c = doc.createElement('span'); c.className = 'mock-row__cat'; c.textContent = r.cat;
    var d = doc.createElement('span'); d.className = 'mock-row__data';
    r.data.forEach(function (x) { var ch = doc.createElement('span'); ch.className = 'chip'; ch.textContent = x; d.appendChild(ch); });
    var k = doc.createElement('span'); k.className = 'risk risk--' + r.risk; k.textContent = RISK[r.risk];
    row.appendChild(n); row.appendChild(c); row.appendChild(d); row.appendChild(k); row.appendChild(statusChip(r.status, r.name));
    return row;
  }
  function renderTable(rows) {
    rowsEl.innerHTML = '';
    rows.forEach(function (r) { rowsEl.appendChild(renderRow(r)); });
  }
  function setTile(key, val) {
    var t = tiles[key]; if (!t) return;
    if (reduceMotion || !t.firstChild) { t.textContent = fmt(val); return; }
    var old = t.firstChild;
    var holder = doc.createElement('span'); holder.className = 'roll'; holder.textContent = fmt(val);
    holder.style.transform = 'translateY(' + (val > counts[key] ? '110%' : '-110%') + ')';
    if (old.nodeType === 3) { var w = doc.createElement('span'); w.className = 'roll'; w.textContent = old.textContent; t.replaceChild(w, old); old = w; }
    t.appendChild(holder); holder.style.position = 'absolute'; holder.style.left = '0'; holder.style.top = '0';
    requestAnimationFrame(function () {
      old.style.transform = 'translateY(' + (val > counts[key] ? '-110%' : '110%') + ')';
      holder.style.transform = 'none';
      setTimeout(function () { if (old.parentNode === t) t.removeChild(old); holder.style.position = ''; }, 380);
    });
  }

  var logTime = { h: 14, m: 2 };
  var logQueue = [
    '14:02|Demande art. 17 RGPD envoyée → Spokeo',
    '14:02|Preuve d’envoi archivée (#A1F3)',
    '13:58|Radaris : vérification demandée',
    '13:41|LiveRamp : suppression confirmée',
    '13:40|Relance programmée J+60 → Intelius',
    '13:12|Scan hebdomadaire : 2 nouvelles fiches'
  ];
  function pushLog(t, m) {
    if (!logEl) return;
    var li = doc.createElement('li');
    var ts = doc.createElement('span'); ts.className = 't'; ts.textContent = t;
    var ms = doc.createElement('span'); ms.className = 'm'; ms.textContent = m;
    var last = logEl.querySelector('.cursor'); if (last) last.parentNode.removeChild(last);
    var cur = doc.createElement('span'); cur.className = 'cursor'; ms.appendChild(cur);
    li.appendChild(ts); li.appendChild(ms); logEl.appendChild(li);
    while (logEl.children.length > 6) logEl.removeChild(logEl.firstChild);
  }
  function nextTime() { logTime.m += 1; if (logTime.m > 59) { logTime.m = 0; logTime.h = (logTime.h + 1) % 24; } return (logTime.h < 10 ? '0' : '') + logTime.h + ':' + (logTime.m < 10 ? '0' : '') + logTime.m; }

  if (rowsEl) {
    var state = ROWS.map(function (r) { return { name: r.name, cat: r.cat, data: r.data, risk: r.risk, status: r.status }; });
    if (reduceMotion) { state[2].status = 'done'; counts = { sent: 412, progress: 136, done: 269 }; }
    renderTable(state);
    // initial journal (oldest first, as listed reversed)
    logQueue.slice().reverse().forEach(function (l) { var p = l.split('|'); pushLog(p[0], p[1]); });

    // counters at entry
    Object.keys(tiles).forEach(function (k) { tiles[k].textContent = reduceMotion ? fmt(counts[k]) : '0'; });
    var started = false;
    onVisible(windowEl, function () {
      if (started) return; started = true;
      Object.keys(tiles).forEach(function (k) {
        var t = tiles[k]; animateNumber(0, counts[k], 1400, function (v) { t.textContent = fmt(v); });
      });
      if (!reduceMotion) setTimeout(startLoop, 2200);
    }, 0.2);

    var timer = null, inView = true, busy = false;
    var NEXT = { sent: 'progress', progress: 'done' };
    function tick() {
      if (busy) return;
      var rows = Array.prototype.slice.call(rowsEl.children);
      var target = null;
      for (var i = 0; i < rows.length; i++) {
        var name = rows[i].getAttribute('data-name');
        var s = state.filter(function (x) { return x.name === name; })[0];
        if (s.status === 'sent' || s.status === 'progress') { target = { row: rows[i], s: s }; break; }
      }
      if (!target) { softReset(); return; }
      busy = true;
      var s = target.s, row = target.row, from = s.status, to = NEXT[from];
      var chipWrap = row.querySelector('.mock-row__status'); var chip = chipWrap.querySelector('.status');
      chip.classList.add('is-fading');
      setTimeout(function () {
        var fresh = statusChip(to, s.name); var newChip = fresh.querySelector('.status'); newChip.classList.add('is-fading');
        row.replaceChild(fresh, chipWrap);
        requestAnimationFrame(function () { requestAnimationFrame(function () { newChip.classList.remove('is-fading'); }); });
        s.status = to;
        if (to === 'progress') { setTile('progress', counts.progress + 1); counts.progress += 1; pushLog(nextTime(), s.name + ' : accusé de réception reçu'); }
        if (to === 'done') {
          row.classList.add('is-done');
          setTile('progress', counts.progress - 1); counts.progress -= 1;
          setTile('done', counts.done + 1); counts.done += 1;
          pushLog(nextTime(), s.name + ' : suppression confirmée');
          setTimeout(function () {
            var h = row.offsetHeight; var siblingsAfter = Array.prototype.slice.call(rowsEl.children).slice(Array.prototype.indexOf.call(rowsEl.children, row) + 1);
            row.classList.add('is-moving'); row.style.transform = 'translateY(' + (siblingsAfter.length * h) + 'px)';
            siblingsAfter.forEach(function (sb) { sb.classList.add('is-moving'); sb.style.transform = 'translateY(-' + h + 'px)'; });
            setTimeout(function () {
              [row].concat(siblingsAfter).forEach(function (el) { el.classList.remove('is-moving'); el.style.transform = ''; });
              rowsEl.appendChild(row);
              busy = false;
            }, 520);
          }, 1000);
        } else { busy = false; }
      }, 240);
    }
    function softReset() {
      busy = true;
      rowsEl.classList.add('is-resetting');
      setTimeout(function () {
        state = ROWS.map(function (r) { return { name: r.name, cat: r.cat, data: r.data, risk: r.risk, status: r.status }; });
        renderTable(state);
        var p0 = 137, d0 = 268;
        setTile('progress', p0); setTile('done', d0); counts.progress = p0; counts.done = d0;
        pushLog(nextTime(), 'Scan hebdomadaire : 2 nouvelles fiches');
        rowsEl.classList.remove('is-resetting');
        busy = false;
      }, 420);
    }
    function startLoop() { if (timer) return; timer = setInterval(function () { if (inView && !doc.hidden) tick(); }, 2800); }
    function stopLoop() { if (timer) { clearInterval(timer); timer = null; } }
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) stopLoop(); else if (started) startLoop(); });
    if (hasIO) new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { inView = e.isIntersecting; if (!inView) stopLoop(); else if (started) startLoop(); });
    }, { threshold: 0.05 }).observe(windowEl);
  }

  /* -------------------------------------------------------- Reveals */
  var revealEls = Array.prototype.slice.call(doc.querySelectorAll('[data-reveal]'));
  function revealed(el) {
    el.classList.add('is-visible');
    if (el.classList.contains('step')) { /* glyph fill + visuals via .is-visible */ }
    if (el.classList.contains('bento__card')) {
      var strikes = el.querySelectorAll('.strike');
      Array.prototype.forEach.call(strikes, function (s, i) { setTimeout(function () { s.classList.add('is-struck'); }, 500 + i * 160); });
    }
    if (el.classList.contains('cmp')) {
      Array.prototype.forEach.call(el.querySelectorAll('.cmp__row .strike'), function (s, i) { setTimeout(function () { s.classList.add('is-struck'); }, 300 + i * 90); });
    }
    if (el.classList.contains('problem__visual')) {
      var fiche = el.querySelector('.fiche');
      var lines = fiche.querySelectorAll('.strike');
      Array.prototype.forEach.call(lines, function (s, i) { setTimeout(function () { s.classList.add('is-struck'); }, 600 + i * 120); });
      setTimeout(function () { fiche.classList.add('is-done'); }, 600 + lines.length * 120 + 200);
    }
  }
  if (reduceMotion || !hasIO) {
    revealEls.forEach(function (el) { el.classList.add('is-visible'); Array.prototype.forEach.call(el.querySelectorAll('.strike'), function (s) { s.classList.add('is-struck'); }); if (el.classList.contains('problem__visual')) el.querySelector('.fiche').classList.add('is-done'); });
  } else {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { rio.unobserve(e.target); revealed(e.target); } });
    }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });
    revealEls.forEach(function (el) { rio.observe(el); });
  }

  /* ------------------------------------------------------- Spotlight */
  if (!coarse) {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-spot]'), function (card) {
      var ticking = false;
      card.addEventListener('pointermove', function (e) {
        if (ticking) return; ticking = true;
        requestAnimationFrame(function () {
          var r = card.getBoundingClientRect();
          card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
          card.style.setProperty('--my', (e.clientY - r.top) + 'px');
          ticking = false;
        });
      });
    });
  }

  /* --------------------------------------------------------- Marquee */
  var BROKERS = ['Acxiom', 'Spokeo', 'Whitepages', 'LiveRamp', 'Epsilon', 'Radaris', 'BeenVerified', 'Intelius', 'Pipl', 'PeopleFinders', 'TruePeopleSearch', 'Experian Marketing', 'Oracle Data Cloud', 'Lotame', 'ZoomInfo', 'Clearbit', 'FastPeopleSearch', 'MyLife', 'Nuwber', 'SpyFly'];
  var tracks = doc.querySelectorAll('[data-marquee]');
  var tipId = 0;
  Array.prototype.forEach.call(tracks, function (track, ti) {
    var list = ti === 0 ? BROKERS : BROKERS.slice(10).concat(BROKERS.slice(0, 10));
    var html = '';
    for (var rep = 0; rep < 2; rep++) {
      list.forEach(function (name) {
        var hidden = rep === 1 ? ' aria-hidden="true" tabindex="-1"' : '';
        html += '<span class="marquee__item"><button type="button" class="broker"' + hidden + '>' + name + '</button><svg class="glyph" aria-hidden="true" focusable="false"><use href="#tacet-glyph"/></svg></span>';
      });
    }
    track.innerHTML = html;
  });
  function showTip(btn) {
    hideTips();
    var id = 'tip-' + (++tipId);
    var tip = doc.createElement('span'); tip.className = 'tooltip'; tip.setAttribute('role', 'tooltip'); tip.id = id;
    tip.textContent = 'Demande type : art. 17 RGPD · délai légal 1 mois';
    btn.parentNode.insertBefore(tip, btn.nextSibling);
    btn.setAttribute('aria-describedby', id);
    requestAnimationFrame(function () { tip.classList.add('is-visible'); });
  }
  function hideTips() {
    Array.prototype.forEach.call(doc.querySelectorAll('.tooltip'), function (t) { t.parentNode.removeChild(t); });
    Array.prototype.forEach.call(doc.querySelectorAll('.broker[aria-describedby]'), function (b) { b.removeAttribute('aria-describedby'); });
  }
  var marquee = doc.getElementById('marquee');
  if (marquee) {
    marquee.addEventListener('pointerover', function (e) { var b = e.target.closest('.broker'); if (b) showTip(b); });
    marquee.addEventListener('pointerout', function (e) { var b = e.target.closest('.broker'); if (b && !b.contains(e.relatedTarget)) hideTips(); });
    marquee.addEventListener('focusin', function (e) { var b = e.target.closest('.broker'); if (b) showTip(b); });
    marquee.addEventListener('focusout', function () { hideTips(); });
    marquee.addEventListener('click', function (e) { var b = e.target.closest('.broker'); if (b) showTip(b); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideTips(); });
  }

  /* --------------------------------------------------------- Pricing */
  var toggle = doc.getElementById('billing-toggle');
  var plans = doc.querySelector('.plans');
  var toggleWrap = doc.querySelector('.toggle-wrap');
  function applyBilling(annual, animate) {
    toggle.setAttribute('aria-checked', annual ? 'true' : 'false');
    plans.setAttribute('data-billing', annual ? 'annual' : 'monthly');
    toggleWrap.classList.toggle('is-monthly', !annual);
    doc.getElementById('toggle-label-a').classList.toggle('is-on', annual);
    doc.getElementById('toggle-label-m').classList.toggle('is-on', !annual);
    Array.prototype.forEach.call(plans.querySelectorAll('.plan'), function (plan) {
      var price = plan.querySelector('[data-price]');
      var val = price.getAttribute(annual ? 'data-annual' : 'data-monthly');
      var roll = price.querySelector('.price__roll'); var cur = roll.querySelector('.price__cur');
      var billed = plan.querySelector('[data-billed]');
      billed.textContent = billed.getAttribute(annual ? 'data-annual-text' : 'data-monthly-text');
      if (cur.textContent === val) return;
      if (!animate || reduceMotion) { cur.textContent = val; return; }
      var nxt = doc.createElement('span'); nxt.className = 'price__cur is-in'; nxt.textContent = val; nxt.style.position = 'absolute'; nxt.style.left = '0'; nxt.style.top = '0';
      cur.classList.add('is-out'); roll.appendChild(nxt);
      setTimeout(function () { roll.removeChild(cur); nxt.classList.remove('is-in'); nxt.style.position = ''; }, 240);
    });
    try { sessionStorage.setItem('tacet-billing', annual ? 'annual' : 'monthly'); } catch (e) { /* storage unavailable */ }
  }
  if (toggle && plans) {
    var saved = null; try { saved = sessionStorage.getItem('tacet-billing'); } catch (e) { saved = null; }
    applyBilling(saved !== 'monthly', false);
    toggle.addEventListener('click', function () { applyBilling(toggle.getAttribute('aria-checked') !== 'true', true); });
    toggle.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); applyBilling(false, true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); applyBilling(true, true); }
    });
    Array.prototype.forEach.call(doc.querySelectorAll('.toggle__label'), function (l) {
      l.addEventListener('click', function () { applyBilling(l.id === 'toggle-label-a', true); });
    });
  }

  /* ------------------------------------------------------------- FAQ */
  var items = Array.prototype.slice.call(doc.querySelectorAll('.faq__item'));
  function closeItem(d) {
    if (!d.open) return;
    d.classList.remove('is-open');
    d.querySelector('.faq__summary').setAttribute('aria-expanded', 'false');
    if (reduceMotion) { d.open = false; return; }
    var panel = d.querySelector('.faq__panel');
    var done = function () { panel.removeEventListener('transitionend', done); if (!d.classList.contains('is-open')) d.open = false; };
    panel.addEventListener('transitionend', done);
    setTimeout(done, 320);
  }
  function openItem(d) {
    items.forEach(function (o) { if (o !== d) closeItem(o); });
    d.open = true;
    d.querySelector('.faq__summary').setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () { requestAnimationFrame(function () { d.classList.add('is-open'); }); });
    if (history.replaceState) { try { history.replaceState(null, '', '#' + d.id); } catch (e) { /* file:// may refuse */ } }
  }
  items.forEach(function (d) {
    var s = d.querySelector('.faq__summary');
    s.setAttribute('aria-expanded', d.open ? 'true' : 'false');
    s.setAttribute('role', 'button');
    s.addEventListener('click', function (e) {
      e.preventDefault();
      if (d.open && d.classList.contains('is-open')) closeItem(d); else openItem(d);
    });
    s.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); s.click(); } });
  });
  if (location.hash) { var target = doc.getElementById(location.hash.slice(1)); if (target && target.classList.contains('faq__item')) openItem(target); }
  window.addEventListener('hashchange', function () { var t = doc.getElementById(location.hash.slice(1)); if (t && t.classList.contains('faq__item') && !t.open) openItem(t); });

  /* ------------------------------------------------ Smooth anchors */
  doc.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    var id = a.getAttribute('href').slice(1);
    var target = id === 'top' ? doc.body : doc.getElementById(id);
    if (!target) return;
    e.preventDefault();
    if (target.classList.contains('faq__item') && !target.open) openItem(target);
    var y = id === 'top' ? 0 : target.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: Math.max(0, y), behavior: reduceMotion ? 'auto' : 'smooth' });
    try { history.pushState(null, '', '#' + id); } catch (err) { /* file:// */ }
    if (id !== 'top') {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  });

  /* ------------------------------------------------ Sticky mobile CTA */
  var sticky = doc.getElementById('sticky-cta');
  var hero = doc.querySelector('.hero');
  var pricing = doc.getElementById('tarifs');
  if (sticky && hero && pricing && hasIO) {
    var pastHero = false, onPricing = false;
    var link = sticky.querySelector('a');
    function updateSticky() {
      var on = pastHero && !onPricing && window.matchMedia('(max-width: 767px)').matches;
      sticky.classList.toggle('is-on', on);
      sticky.setAttribute('aria-hidden', on ? 'false' : 'true');
      link.tabIndex = on ? 0 : -1;
      doc.body.classList.toggle('has-sticky-cta', on);
    }
    new IntersectionObserver(function (entries) { entries.forEach(function (e) { pastHero = !e.isIntersecting && e.boundingClientRect.bottom < 0; updateSticky(); }); }, { threshold: 0 }).observe(hero);
    new IntersectionObserver(function (entries) { entries.forEach(function (e) { onPricing = e.isIntersecting; updateSticky(); }); }, { threshold: 0.1 }).observe(pricing);
    window.addEventListener('resize', updateSticky);
  }
})();
