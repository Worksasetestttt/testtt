/* Biffe — main.js
   Vanilla, classic script (defer). Only transform / opacity / clip-path animate.
   Modules: utils · nav · menu · reveal · counters · rings · hero timeline ·
   marquee · stamps · wipe groups · method mini-UIs · bento spotlight ·
   pricing · FAQ · CTA final. */
(function () {
  'use strict';

  var d = document;
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); };
  var reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var RM = function () { return reducedMQ.matches; };
  var hasIO = 'IntersectionObserver' in window;
  var finePointer = window.matchMedia('(pointer: fine)').matches;
  var NNBSP = ' ';

  /* ------------------------------------------------------------------ utils */
  function onEnter(el, cb, opts) {
    opts = opts || {};
    if (!el) return;
    if (!hasIO) { cb(el); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { io.unobserve(en.target); cb(en.target); }
      });
    }, { threshold: opts.threshold == null ? 0.15 : opts.threshold, rootMargin: opts.rootMargin || '0px' });
    io.observe(el);
  }

  function fmt(v, dec, intLen) {
    var s = Math.abs(v).toFixed(dec || 0);
    var parts = s.split('.');
    var i = parts[0];
    if (intLen) i = i.length < intLen ? new Array(intLen - i.length + 1).join('0') + i : i;
    i = i.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
    return parts.length > 1 ? i + ',' + parts[1] : i;
  }

  /* ---------------------------------------------------------- digit engine */
  function renderNum(el, str) {
    el.innerHTML = '';
    var k = 0;
    for (var idx = 0; idx < str.length; idx++) {
      var ch = str[idx];
      var isDigit = /\d/.test(ch);
      var dg = d.createElement('span');
      dg.className = 'dg' + (isDigit ? '' : ' sep');
      dg.style.setProperty('--k', isDigit ? k++ : 0);
      var inn = d.createElement('span');
      inn.className = 'dg-in';
      var i = d.createElement('i');
      i.textContent = ch;
      inn.appendChild(i);
      dg.appendChild(inn);
      el.appendChild(dg);
    }
  }

  function numText(el) {
    return $$('.dg', el).map(function (dg) { return dg.textContent; }).join('');
  }

  function setNum(el, str) {
    renderNum(el, str);
    el.classList.add('is-ready');
    el.classList.add('is-born');
  }

  /* value climbs with 1 - 2^(-10t); digits are born from ink blocks */
  function countUp(el, dur) {
    if (!el || el.dataset.counted) return;
    el.dataset.counted = '1';
    var target = parseFloat(el.dataset.count);
    var dec = +(el.dataset.decimals || 0);
    var intLen = String(Math.floor(target)).length;
    var finalStr = fmt(target, dec);
    if (RM()) { setNum(el, finalStr); return; }
    renderNum(el, fmt(0, dec, intLen));
    el.classList.add('is-ready');
    requestAnimationFrame(function () { el.classList.add('is-born'); });
    var glyphs = $$('.dg-in > i', el);
    var t0 = performance.now();
    dur = dur || 1200;
    function frame(now) {
      var t = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(2, -10 * t);
      var v = t >= 1 ? target : target * e;
      var str = fmt(v, dec, intLen);
      for (var i = 0; i < glyphs.length; i++) glyphs[i].textContent = str[i];
      if (t < 1) requestAnimationFrame(frame);
      else setNum(el, finalStr);
    }
    requestAnimationFrame(frame);
  }

  /* roll from the current digits to newStr (right-aligned columns) */
  function rollTo(el, newStr) {
    var oldStr = numText(el);
    if (oldStr === newStr) return;
    if (RM()) { setNum(el, newStr); return; }
    var n = Math.max(oldStr.length, newStr.length);
    var pad = function (s) { return new Array(n - s.length + 1).join('\u0000') + s; };
    var o = pad(oldStr), w = pad(newStr);
    el.innerHTML = '';
    var rolling = [];
    for (var idx = 0; idx < n; idx++) {
      var oc = o[idx] === '\u0000' ? '' : o[idx];
      var nc = w[idx] === '\u0000' ? '' : w[idx];
      var dg = d.createElement('span');
      dg.className = 'dg' + (/\d/.test(nc || oc) ? '' : ' sep');
      dg.style.setProperty('--k', idx);
      var inn = d.createElement('span');
      inn.className = 'dg-in';
      var i1 = d.createElement('i'); i1.textContent = oc;
      var i2 = d.createElement('i'); i2.textContent = nc;
      inn.appendChild(i1); inn.appendChild(i2);
      dg.appendChild(inn);
      el.appendChild(dg);
      if (oc !== nc) { dg.style.width = i1.offsetWidth + 'px'; rolling.push({ dg: dg, inn: inn, i2: i2 }); }
    }
    el.classList.add('is-ready');
    el.classList.add('is-born');
    void el.offsetWidth;
    rolling.forEach(function (r, j) {
      r.dg.style.width = r.i2.offsetWidth + 'px';
      r.inn.style.transitionDelay = (j * 40) + 'ms';
      r.inn.style.transform = 'translateY(-1em)';
    });
    setTimeout(function () { setNum(el, newStr); }, 300 + rolling.length * 40 + 60);
  }

  /* -------------------------------------------------------------- rings */
  function buildRing(svg) {
    var N = 60, cx = 40, cy = 40, r = 36, len = 6.5;
    var done = +svg.dataset.done, prog = +svg.dataset.prog, total = +svg.dataset.total;
    var nDone = Math.round(N * done / total), nProg = Math.round(N * prog / total);
    var html = '';
    for (var i = 0; i < N; i++) {
      var a = (-90 + i * 360 / N) * Math.PI / 180;
      var x1 = cx + (r - len) * Math.cos(a), y1 = cy + (r - len) * Math.sin(a);
      var x2 = cx + r * Math.cos(a), y2 = cy + r * Math.sin(a);
      var cls = i < nDone ? 'done' : (i < nDone + nProg ? 'prog' : 'rest');
      html += '<line class="tk ' + cls + '" x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '" style="--k:' + i + '"/>';
    }
    svg.innerHTML = html;
  }

  /* -------------------------------------------------------------- chips */
  var SVG_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_EXCL = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.5v6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="8" cy="12.6" r="1.3" fill="currentColor"/></svg>';
  var SVG_ROTATE = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13 1.8v3.4H9.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHIP = {
    queued:   ['chip-queued',   'À envoyer'],
    sent:     ['chip-sent',     '<i class="dot"></i>Envoyée'],
    progress: ['chip-progress', '<i class="dot"></i>En cours'],
    done:     ['chip-done',     SVG_CHECK + 'Terminée'],
    action:   ['chip-action',   SVG_EXCL + 'Action requise'],
    relance:  ['chip-relance',  SVG_ROTATE + 'Relancée']
  };
  function setChip(el, state) {
    var c = CHIP[state];
    el.className = 'chip ' + c[0];
    el.innerHTML = c[1];
    el.dataset.chip = state;
  }

  /* ------------------------------------------------- smooth anchors */
  function initAnchors() {
    d.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      var id = a.getAttribute('href').slice(1);
      var target = id ? d.getElementById(id) : d.body;
      if (!target) return;
      e.preventDefault();
      var top = id ? target.getBoundingClientRect().top + window.pageYOffset - 80 : 0;
      try { window.scrollTo({ top: top, behavior: RM() ? 'auto' : 'smooth' }); } catch (err) { window.scrollTo(0, top); }
      if (id && history.pushState) history.pushState(null, '', '#' + id);
      if (id) setTimeout(function () { if (target.tabIndex < 0) target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }, RM() ? 0 : 500);
    });
  }

  /* ---------------------------------------------------------------- nav */
  function initNav() {
    var header = $('.site-header');
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    var counter = $('[data-nav-counter]');
    var links = $$('[data-nav-link]');
    var secs = $$('[data-sec]');
    if (!hasIO || !counter) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        counter.textContent = en.target.dataset.sec;
        var id = en.target.id;
        links.forEach(function (a) { a.classList.toggle('is-active', a.dataset.navLink === id); });
      });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
    secs.forEach(function (s) { io.observe(s); });
  }

  /* --------------------------------------------------------- mobile menu */
  function initMenu() {
    var menu = $('#mobile-menu');
    var openBtn = $('[data-menu-open]');
    var closeBtn = $('[data-menu-close]');
    if (!menu || !openBtn) return;
    var lastFocus = null;
    var focusables = function () { return $$('a[href], button:not([disabled])', menu); };

    function open() {
      lastFocus = d.activeElement;
      menu.hidden = false;
      requestAnimationFrame(function () { requestAnimationFrame(function () { menu.classList.add('is-open'); }); });
      openBtn.setAttribute('aria-expanded', 'true');
      d.body.classList.add('menu-open');
      closeBtn.focus();
    }
    function close(restoreFocus) {
      if (menu.hidden) return;
      menu.classList.add('is-closing');
      openBtn.setAttribute('aria-expanded', 'false');
      d.body.classList.remove('menu-open');
      setTimeout(function () { menu.hidden = true; menu.classList.remove('is-open'); menu.classList.remove('is-closing'); }, 200);
      if (restoreFocus !== false) (lastFocus || openBtn).focus();
    }
    openBtn.addEventListener('click', open);
    closeBtn.addEventListener('click', function () { close(); });
    $$('[data-menu-link]').forEach(function (a) { a.addEventListener('click', function () { close(false); }); });
    menu.addEventListener('click', function (e) { if (e.target === menu || e.target.classList.contains('mobile-menu-nav')) close(); });
    menu.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = focusables();
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    window.matchMedia('(min-width: 1024px)').addEventListener('change', function (e) { if (e.matches) close(false); });
  }

  /* ------------------------------------------------------------- reveal */
  var NO_HEAD = { UL: 1, OL: 1, DL: 1, TABLE: 1, TBODY: 1, TR: 1 };
  function revealEl(el) {
    var i = parseFloat(getComputedStyle(el).getPropertyValue('--i')) || 0;
    el.style.setProperty('--rw', el.offsetWidth + 'px');
    if (!NO_HEAD[el.tagName]) {
      var head = d.createElement('i');
      head.className = 'wipe-head';
      head.setAttribute('aria-hidden', 'true');
      el.appendChild(head);
      head.addEventListener('animationend', function () { head.remove(); }, { once: true });
      setTimeout(function () { if (head.parentNode) head.remove(); }, 1200 + i * 70);
    }
    el.classList.add('is-in');
    setTimeout(function () { el.classList.add('is-done'); }, 760 + i * 70);
  }
  function initReveal() {
    var els = $$('.reveal');
    if (RM() || !hasIO) { els.forEach(function (el) { el.classList.add('is-in'); el.classList.add('is-done'); }); return; }
    var pending = els.slice();
    var reveal = function (el) {
      var i = pending.indexOf(el);
      if (i === -1) return;
      pending.splice(i, 1);
      io.unobserve(el);
      revealEl(el);
    };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) reveal(en.target); });
    }, { threshold: 0, rootMargin: '0px 0px -8% 0px' }); // threshold 0: the clipped box is a 1px sliver
    els.forEach(function (el) { io.observe(el); });
    // insurance for fast flicks / programmatic jumps: rect check on scroll
    var ticking = false;
    var check = function () {
      ticking = false;
      if (!pending.length) return;
      var vh = window.innerHeight * 0.92;
      pending.slice().forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < vh && r.bottom > 0) reveal(el);
      });
    };
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(check); } }, { passive: true });
  }

  /* ----------------------------------------------------------- counters */
  function initCounters() {
    // pre-render every counter as ink blocks (visible, not yet born)
    $$('.num[data-count]').forEach(function (el) {
      var target = parseFloat(el.dataset.count), dec = +(el.dataset.decimals || 0);
      renderNum(el, fmt(target, dec));
      el.classList.add('is-ready');
      if (RM()) el.classList.add('is-born');
    });
    $$('[data-count-group]').forEach(function (g) {
      onEnter(g, function () { $$('.num[data-count]', g).forEach(function (n) { countUp(n); }); }, { threshold: 0.2 });
    });
    $$('.num[data-count]').forEach(function (n) {
      if (n.closest('[data-count-group]') || n.closest('[data-hero-dossier]')) return;
      onEnter(n, function () { countUp(n); }, { threshold: 0.5 });
    });
  }

  function initRings() {
    $$('[data-ring]').forEach(function (svg) {
      buildRing(svg);
      if (svg.closest('[data-hero-dossier]')) return;
      onEnter(svg, function () { svg.classList.add('is-filled'); }, { threshold: 0.4 });
    });
  }

  /* ------------------------------------------------------ hero timeline */
  function initHero() {
    var dossier = $('[data-hero-dossier]');
    if (!dossier) return;
    var fiche = $('[data-fiche]', dossier);
    var stamp = $('[data-stamp="vendu"]', dossier);
    var status = $('[data-status]', dossier);
    var chip = $('[data-hero-chip]', dossier);
    var ring = $('[data-ring]', dossier);
    var nums = { sent: $('[data-hero-num="sent"]', dossier), prog: $('[data-hero-num="prog"]', dossier), done: $('[data-hero-num="done"]', dossier) };
    var R = function (k) { return $('[data-r="' + k + '"]', fiche); };
    var redacts = $$('.redact, .cover', fiche);
    var STATUS_DONE = 'Effacée · 09/10/2026 · art. 17 RGPD';
    var STATUS_BACK = 'Fiche réapparue — relance automatique';
    var STATUS_DONE2 = 'Effacée · 02/12/2026 · relance nº 2';

    $$('[data-chip]', dossier).forEach(function (c) { setChip(c, c.dataset.chip); });

    function setStatus(text, kind) {
      status.textContent = text;
      status.classList.toggle('is-accent', kind === 'accent');
      status.classList.add('is-on');
    }

    if (RM()) {
      redacts.forEach(function (r) { if (!r.classList.contains('cover')) r.classList.add('is-redacted'); });
      stamp.classList.add('is-on');
      setChip(chip, 'done');
      setStatus(STATUS_DONE, 'success');
      ring.classList.add('is-filled');
      return;
    }

    var timers = [], running = false, started = false, inView = false;
    var at = function (t, fn) { timers.push(setTimeout(fn, t)); };
    var redact = function (k) { R(k).classList.add('is-redacted'); };
    var reRedact = function (k) {
      var el = R(k);
      el.classList.add('no-trans');
      el.classList.remove('is-redacted'); el.classList.remove('is-faded');
      void el.offsetWidth;
      el.classList.remove('no-trans');
      el.classList.add('is-redacted');
    };
    function clearState() {
      fiche.classList.add('no-trans');
      redacts.forEach(function (r) { r.classList.remove('is-redacted'); r.classList.remove('is-faded'); });
      stamp.classList.remove('is-on');
      status.classList.remove('is-on'); status.classList.remove('is-accent');
      setChip(chip, 'queued');
      setNum(nums.done, '221'); setNum(nums.prog, '97');
      void fiche.offsetWidth;
      fiche.classList.remove('is-clearing'); fiche.classList.remove('no-trans');
    }
    var steps = [
      [600,   function () { stamp.classList.add('is-on'); }],
      [1400,  function () { setChip(chip, 'sent'); }],
      [3200,  function () { setChip(chip, 'progress'); }],
      [5000,  function () { setChip(chip, 'done'); }],
      [5200,  function () { redact('adresse'); }],
      [5380,  function () { redact('tel'); }],
      [5560,  function () { redact('proches'); }],
      [5740,  function () { redact('revenu'); }],
      [5920,  function () { redact('age'); }],
      [6100,  function () { redact('name'); }],
      [6420,  function () { redact('stamp'); }],
      [6900,  function () { setStatus(STATUS_DONE, 'success'); }],
      [7200,  function () { rollTo(nums.done, '222'); rollTo(nums.prog, '96'); }],
      [9600,  function () { R('adresse').classList.add('is-faded'); R('tel').classList.add('is-faded'); setStatus(STATUS_BACK, 'accent'); setChip(chip, 'relance'); }],
      [11600, function () { reRedact('adresse'); setTimeout(function () { reRedact('tel'); }, 180); setChip(chip, 'done'); setStatus(STATUS_DONE2, 'success'); }],
      [14000, function () { fiche.classList.add('is-clearing'); }],
      [14320, function () { clearState(); }],
      [14360, function () { run(); }]
    ];
    function run() {
      timers.forEach(clearTimeout); timers = [];
      steps.forEach(function (s) { at(s[0], s[1]); });
    }
    function start() {
      if (running) return;
      running = true;
      if (!started) {
        started = true;
        Object.keys(nums).forEach(function (k) { countUp(nums[k]); });
        ring.classList.add('is-filled');
      } else {
        fiche.classList.add('is-clearing');
        clearState();
      }
      run();
    }
    function stop() {
      if (!running) return;
      running = false;
      timers.forEach(clearTimeout); timers = [];
    }
    if (hasIO) {
      new IntersectionObserver(function (entries) {
        inView = entries[0].isIntersecting;
        if (inView && !d.hidden) start(); else stop();
      }, { threshold: 0.4 }).observe(dossier);
    } else { inView = true; start(); }
    d.addEventListener('visibilitychange', function () { if (d.hidden) stop(); else if (inView) start(); });
  }

  /* ------------------------------------------------------------ marquee */
  function initMarquee() {
    $$('.mq-track').forEach(function (track) {
      var items = $$('.mq-item', track);
      items.forEach(function (li) {
        var c = li.cloneNode(true);
        c.setAttribute('aria-hidden', 'true');
        c.setAttribute('data-clone', '');
        var sr = c.querySelector('.sr-only'); if (sr) sr.remove();
        track.appendChild(c);
      });
    });
  }

  /* ------------------------------------------------------------- stamps */
  function initStamps() {
    $$('.stamp[data-slam]').forEach(function (s) {
      if (s.dataset.slam === 'form') return; // sequenced in step 01
      if (RM()) { s.classList.add('is-on'); return; }
      onEnter(s, function () { setTimeout(function () { s.classList.add('is-on'); }, 520); }, { threshold: 0.6 });
    });
  }

  /* -------------------------------------------------------- wipe groups */
  function initWipeGroups() {
    $$('[data-wipe-group]').forEach(function (g) {
      var st = +(g.dataset.stagger || 0);
      var items = $$('.strike, .strike-ml, .redact', g).filter(function (el) { return !el.hasAttribute('data-manual') && !el.closest('.mq-item'); });
      if (RM()) { items.forEach(function (el) { el.classList.add('is-on'); }); return; }
      onEnter(g, function () {
        items.forEach(function (el, i) { setTimeout(function () { el.classList.add('is-on'); }, 520 + i * st); });
      }, { threshold: 0.25 });
    });
  }

  /* -------------------------------------------------------- dissolve text */
  function dissolve(el) {
    if (!el || el.dataset.done) return;
    el.dataset.done = '1';
    var from = el.textContent.trim().slice(0, 80);
    var to = (el.dataset.to || from).slice(0, 80);
    var bar = function () {
      el.innerHTML = '';
      var s = d.createElement('span'); s.className = 'redact'; s.textContent = to; el.appendChild(s);
      return s;
    };
    if (RM()) { bar().classList.add('is-redacted'); return; }
    var split = function (txt) {
      el.innerHTML = '';
      var frag = d.createDocumentFragment();
      for (var i = 0; i < txt.length; i++) {
        var s = d.createElement('span'); s.className = 'ch';
        s.textContent = txt[i] === ' ' ? ' ' : txt[i];
        s.style.setProperty('--d', Math.round(Math.random() * 600) + 'ms');
        frag.appendChild(s);
      }
      el.appendChild(frag);
      return $$('.ch', el);
    };
    var a = split(from);
    requestAnimationFrame(function () { a.forEach(function (s) { s.classList.add('is-dissolved'); }); });
    setTimeout(function () { a.forEach(function (s) { if (s.textContent !== ' ') s.textContent = '·'; }); }, 600);
    setTimeout(function () {
      var b = split(to);
      b.forEach(function (s) { s.classList.add('is-dissolved'); });
      requestAnimationFrame(function () { requestAnimationFrame(function () { b.forEach(function (s) { s.classList.remove('is-dissolved'); }); }); });
      setTimeout(function () {
        var s = bar();
        requestAnimationFrame(function () { requestAnimationFrame(function () { s.classList.add('is-redacted'); }); });
      }, 950);
    }, 950);
  }

  /* -------------------------------------------------- method mini-UIs */
  function initSteps() {
    var form = $('[data-step-form]');
    if (form) {
      var fields = $$('[data-type]', form), sig = $('.ui-signature', form), stamp = $('[data-slam="form"]', form);
      var finish = function () { fields.forEach(function (f) { f.textContent = f.dataset.type; }); sig.classList.add('is-drawn'); stamp.classList.add('is-on'); };
      if (RM()) finish();
      else onEnter(form, function () {
        var i = 0;
        var typeField = function () {
          if (i >= fields.length) { sig.classList.add('is-drawn'); setTimeout(function () { stamp.classList.add('is-on'); }, 980); return; }
          var f = fields[i++], txt = f.dataset.type, j = 0;
          f.classList.add('is-typing');
          var tick = function () {
            f.textContent = txt.slice(0, ++j);
            if (j < txt.length) setTimeout(tick, 18 + Math.random() * 30);
            else { f.classList.remove('is-typing'); setTimeout(typeField, 200); }
          };
          setTimeout(tick, 180);
        };
        setTimeout(typeField, 350);
      }, { threshold: 0.5 });
    }

    var cycle = $('[data-step-cycle]');
    if (cycle) {
      var ticks = $('[data-ticks]', cycle);
      var html = '';
      for (var t = 0; t < 12; t++) html += '<i' + (t === 0 || t === 4 || t === 8 ? ' class="is-mark"' : '') + '></i>';
      ticks.innerHTML = html;
      var tk = $$('i', ticks), demo = $('[data-dissolve]', cycle);
      if (RM()) { tk.forEach(function (i) { i.classList.add('is-on'); }); dissolve(demo); }
      else onEnter(cycle, function () {
        tk.forEach(function (i, k) { setTimeout(function () { i.classList.add('is-on'); }, 400 + k * 60); });
        setTimeout(function () { dissolve(demo); }, 1250);
      }, { threshold: 0.5 });
    }
  }

  /* ---------------------------------------------------- bento spotlight */
  function initSpotlight() {
    if (!finePointer || RM()) return;
    $$('[data-spot]').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--x', (e.clientX - r.left) + 'px');
        card.style.setProperty('--y', (e.clientY - r.top) + 'px');
      });
    });
  }

  /* ------------------------------------------------------------ pricing */
  function initPricing() {
    var sw = $('[data-billing-switch]');
    if (!sw) return;
    var opts = $$('[data-billing]'), plans = $$('[data-plan]'), stamp = $('[data-billing-stamp]');
    var annual = true;
    try { if (localStorage.getItem('biffe-billing') === 'monthly') annual = false; } catch (e) { /* storage unavailable */ }
    function apply(a, animate) {
      annual = a;
      sw.setAttribute('aria-checked', String(a));
      opts.forEach(function (o) {
        var on = (o.dataset.billing === 'annual') === a;
        o.classList.toggle('is-active', on);
        o.setAttribute('aria-pressed', String(on));
      });
      plans.forEach(function (p) {
        var num = $('[data-plan-num]', p);
        var val = a ? p.dataset.annual : p.dataset.monthly;
        if (animate) rollTo(num, val); else setNum(num, val);
        var billed = $('[data-plan-billed]', p);
        billed.textContent = a ? p.dataset.billedAnnual : p.dataset.billedMonthly;
        billed.classList.toggle('is-monthly', !a);
        $('[data-plan-old]', p).classList.toggle('is-hidden', !a);
      });
      if (stamp) {
        stamp.classList.remove('is-on');
        stamp.classList.toggle('is-off', !a);
        if (a) { void stamp.offsetWidth; stamp.classList.add('is-on'); }
      }
      try { localStorage.setItem('biffe-billing', a ? 'annual' : 'monthly'); } catch (e) { /* ignore */ }
    }
    apply(annual, false);
    sw.addEventListener('click', function () { apply(!annual, true); });
    opts.forEach(function (o) { o.addEventListener('click', function () { apply(o.dataset.billing === 'annual', true); }); });
  }

  /* ---------------------------------------------------------------- FAQ */
  function initFaq() {
    var items = $$('.faq-item');
    if (!items.length) return;
    function setOpen(item, open) {
      item.classList.toggle('is-open', open);
      $('.faq-q', item).setAttribute('aria-expanded', String(open));
      if (open) { var demo = $('[data-dissolve]', item); if (demo) setTimeout(function () { dissolve(demo); }, 300); }
    }
    items.forEach(function (item) {
      $('.faq-q', item).addEventListener('click', function () {
        var isOpen = item.classList.contains('is-open');
        items.forEach(function (o) { if (o !== item && o.classList.contains('is-open')) setOpen(o, false); });
        setOpen(item, !isOpen);
      });
    });
    function openHash() {
      var h = location.hash.slice(1);
      if (!h) return;
      var item = d.getElementById(h);
      if (item && item.classList.contains('faq-item')) items.forEach(function (o) { setOpen(o, o === item); });
    }
    openHash();
    window.addEventListener('hashchange', openHash);
  }

  /* --------------------------------------------------------- CTA final */
  function initCta() {
    var btn = $('[data-cta-main]'), name = $('[data-cta-name]');
    if (!btn || !name) return;
    if (RM()) { name.classList.add('is-on'); return; }
    var on = function () { name.classList.add('is-on'); };
    var off = function () { name.classList.remove('is-on'); };
    btn.addEventListener('mouseenter', on); btn.addEventListener('mouseleave', off);
    btn.addEventListener('focus', on); btn.addEventListener('blur', off);
  }

  /* ----------------------------------------------------------- bootstrap */
  function init() {
    $$('[data-chip]').forEach(function (c) { if (!c.closest('[data-hero-dossier]')) setChip(c, c.dataset.chip); });
    initAnchors();
    initNav();
    initMenu();
    initCounters();
    initRings();
    initReveal();
    initHero();
    initMarquee();
    initStamps();
    initWipeGroups();
    initSteps();
    initSpotlight();
    initPricing();
    initFaq();
    initCta();
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init); else init();
})();
