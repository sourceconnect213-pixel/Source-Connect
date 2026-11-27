/* Seller Center menu: find a page by typing (Ctrl K / ⌘ K), and a narrow icon-only menu on computers.
   Only the look of the menu changes; links still go where they always went, and pages hidden by permissions
   stay hidden (they carry the "hidden" attribute; the search only adds or removes its own class). */
(function () {
  'use strict';
  var nav = document.getElementById('sideNav'), box = document.getElementById('sideSearch'), none = document.getElementById('sideNone');
  var shell = document.getElementById('shell'), mini = document.getElementById('sideMini'), key = document.getElementById('sideKey');
  if (!nav || !box || !shell || !mini) return;
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  if (key) key.textContent = isMac ? '⌘ K' : 'Ctrl K';
  var label = function (a) { var t = a.cloneNode(true); Array.prototype.forEach.call(t.querySelectorAll('.pill'), function (p) { p.remove(); }); return t.textContent.replace(/\s+/g, ' ').trim(); };
  var links = function () { return Array.prototype.slice.call(nav.querySelectorAll('a[data-v]')); };

  function filter() {
    var q = box.value.trim().toLowerCase(), shown = 0;
    links().forEach(function (a) { var hit = !q || label(a).toLowerCase().indexOf(q) > -1; a.classList.toggle('nf', !hit); if (hit && !a.hidden) shown++; });
    // a section title shows only while one of its pages shows
    var labels = nav.querySelectorAll('.side-label');
    Array.prototype.forEach.call(labels, function (l) {
      var any = false;
      for (var n = l.nextElementSibling; n && !n.classList.contains('side-label'); n = n.nextElementSibling) if (n.matches('a[data-v]') && !n.hidden && !n.classList.contains('nf')) { any = true; break; }
      l.classList.toggle('nf', !any);
    });
    if (none) none.hidden = shown > 0;
  }
  box.addEventListener('input', filter);
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); var first = links().filter(function (a) { return !a.hidden && !a.classList.contains('nf'); })[0]; if (first) { location.hash = first.getAttribute('href').replace(/^#/, ''); box.value = ''; filter(); box.blur(); } }
    if (e.key === 'Escape') { box.value = ''; filter(); box.blur(); }
  });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K') && !shell.hidden) {
      e.preventDefault();
      if (shell.classList.contains('side-mini')) setMini(false);
      var side = document.getElementById('side'); if (side && innerWidth <= 900) side.classList.add('open');
      box.focus(); box.select();
    }
  });

  // narrow menu (computers only); remembered on this device
  function setMini(on) {
    shell.classList.toggle('side-mini', on);
    mini.setAttribute('aria-pressed', on ? 'true' : 'false');
    var t = on ? 'Make the menu wide' : 'Make the menu narrow'; mini.setAttribute('aria-label', t); mini.title = t;
    links().forEach(function (a) { if (on) { a.title = label(a); a.setAttribute('aria-label', label(a)); } else { a.removeAttribute('title'); a.removeAttribute('aria-label'); } });
    try { localStorage.setItem('scg_side_mini', on ? '1' : '0'); } catch (e) {}
  }
  mini.addEventListener('click', function () { setMini(!shell.classList.contains('side-mini')); });
  var saved = null; try { saved = localStorage.getItem('scg_side_mini'); } catch (e) {}
  if (saved === '1') setMini(true);
  // links added later (permissions, owner pages) get their name as a tooltip too
  new MutationObserver(function () { if (shell.classList.contains('side-mini')) links().forEach(function (a) { if (!a.title) { a.title = label(a); a.setAttribute('aria-label', label(a)); } }); filter(); }).observe(nav, { childList: true });
})();

/* Dashboard numbers (that page only) count up from zero when they first appear (money keeps its "Rs." and thousands separators).
   Skipped when the device asks for reduced motion; the final number is always the one the server sent. */
(function () {
  'use strict';
  var view = document.getElementById('view'); if (!view || !window.requestAnimationFrame) return;
  var reduce = function () { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; };
  function countUp(el) {
    if (el.dataset.counted) return; el.dataset.counted = '1';
    var m = /^(\D*?)(\d{1,3}(?:,\d{3})*|\d+)(\D*)$/.exec(el.textContent.trim()); if (!m) return;
    var end = +m[2].replace(/,/g, ''); if (!isFinite(end) || end < 2 || reduce()) return;
    var final = el.textContent, t0 = null, dur = Math.min(1100, 500 + String(end).length * 90);
    var fmt = function (n) { return m[1] + n.toLocaleString('en-US') + m[3]; };
    el.setAttribute('aria-label', final.trim());
    (function step(t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);   // decelerates into the real value
      if (!el.isConnected) return;
      el.textContent = p < 1 ? fmt(Math.round(end * e)) : final;
      if (p < 1) requestAnimationFrame(step); else el.removeAttribute('aria-label');
    })(performance.now());
  }
  // the Dashboard only: Sales & Profit and other reports show their exact numbers straight away
  var onDashboard = function () { var h = location.hash.replace('#', '').split('/')[0]; return !h || h === 'dashboard'; };
  new MutationObserver(function () { if (onDashboard()) Array.prototype.forEach.call(view.querySelectorAll('.stats .stat b'), countUp); }).observe(view, { childList: true, subtree: true });
})();
