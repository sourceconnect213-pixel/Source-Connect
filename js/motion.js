/* =========================================================
   Source Connect Global — small animations that answer what the shopper does.
   Loaded after app.js. It only watches and decorates: carts, orders and payments are handled by app.js
   exactly as before, and nothing here runs when the device asks for reduced motion (the result of each
   action is still shown, just without movement).
   - Add to cart: the product picture flies to the cart, the cart answers with a bump, the button says "Added".
   - Proceed to checkout: a delivery truck with a parcel drives across the button, then checkout opens.
   - Placing an order: the truck keeps driving inside the button until the shop answers (marked busy).
   - Wishlist: the heart pops.
   ========================================================= */
(function () {
  'use strict';
  var SCG = window.SCG; if (!SCG || !SCG.getCart) return;
  var reduce = function () { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; };
  var EASE_IN_OUT = 'cubic-bezier(.55, 0, .2, 1)';
  var TRUCK = '<svg class="truck" viewBox="0 0 48 28" aria-hidden="true"><rect class="t-box" x="2" y="7" width="26" height="14" rx="2"/><path class="t-cab" d="M28 11h9l6 6v4H28z"/><rect class="t-parcel" x="8" y="2" width="12" height="9" rx="1.5"/><path class="t-tape" d="M14 2v9"/><circle class="t-wheel" cx="10" cy="22" r="3.5"/><circle class="t-wheel" cx="36" cy="22" r="3.5"/><path class="t-win" d="M31 13h4l3 3h-7z"/></svg>';

  var count = function () { return SCG.getCart().reduce(function (s, l) { return s + (+l.qty || 0); }, 0); };
  var visible = function (el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== 'hidden'; };
  function cartTarget() {
    var list = [document.querySelector('.bottom-nav a[href="#cart"]'), document.getElementById('cartCount') && document.getElementById('cartCount').closest('a, button')];
    for (var i = 0; i < list.length; i++) if (visible(list[i])) return list[i];
    return null;
  }
  function bump(el) { if (!el) return; el.classList.remove('cart-hit'); void el.offsetWidth; el.classList.add('cart-hit'); setTimeout(function () { el.classList.remove('cart-hit'); }, 600); }

  /* ---------- add to cart ---------- */
  var before = 0;
  document.addEventListener('click', function (e) { if (e.target.closest('[data-add], #addCart, #buyNow')) before = count(); }, true);   // before app.js adds
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-add], #addCart'); if (!btn) return;
    var was = before;
    // app.js may register its own click handler after this file (once the shop data has loaded), so look at the
    // cart only after every handler of this click has run
    setTimeout(function () { if (count() > was) celebrate(btn); }, 0);   // nothing added = out of stock / all already in the cart
  });
  function celebrate(btn) {
    var target = cartTarget();
    var src = btn.closest('.card') ? btn.closest('.card').querySelector('.media img, .media .pic') : document.querySelector('#big img, #big .pic, #big svg');
    added(btn);
    if (reduce() || !target || !src || !src.getBoundingClientRect().width || !document.body.animate) { bump(target); return; }
    fly(src, target);
  }
  function added(btn) {
    if (btn.dataset.motionLabel) return;
    var label = btn.innerHTML; btn.dataset.motionLabel = '1';
    btn.classList.add('just-added');
    btn.innerHTML = '<svg class="ok-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Added';
    setTimeout(function () { btn.innerHTML = label; btn.classList.remove('just-added'); delete btn.dataset.motionLabel; }, 1300);
  }
  function fly(src, target) {
    var a = src.getBoundingClientRect(), b = target.getBoundingClientRect();
    var size = Math.min(96, Math.max(48, a.width * .5));
    var ghost = document.createElement('div'); ghost.className = 'fly-ghost'; ghost.setAttribute('aria-hidden', 'true');
    ghost.appendChild(src.cloneNode(true));
    ghost.style.width = ghost.style.height = size + 'px';
    ghost.style.left = (a.left + a.width / 2 - size / 2) + 'px'; ghost.style.top = (a.top + a.height / 2 - size / 2) + 'px';
    document.body.appendChild(ghost);
    var dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    var lift = Math.min(-60, dy * .35 - 80);   // an arc: up first, then down into the cart
    var anim = ghost.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: 'translate(' + dx * .45 + 'px,' + lift + 'px) scale(.75)', opacity: 1, offset: .45 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.18)', opacity: .35 }
    ], { duration: 720, easing: EASE_IN_OUT });
    anim.onfinish = anim.oncancel = function () { ghost.remove(); bump(target); };
  }

  /* ---------- wishlist heart ---------- */
  document.addEventListener('click', function (e) {
    var w = e.target.closest('[data-wish]'); if (!w || reduce()) return;
    var id = w.dataset.wish;
    setTimeout(function () {   // after app.js has saved it; every heart for this product answers
      Array.prototype.forEach.call(document.querySelectorAll('[data-wish="' + id + '"]'), function (h) {
        h.classList.remove('pop'); void h.offsetWidth; h.classList.add('pop');
        setTimeout(function () { h.classList.remove('pop'); }, 600);
      });
    }, 0);
  });

  /* ---------- proceed to checkout: the truck drives off with the parcel ---------- */
  document.addEventListener('click', function (e) {
    var go = e.target.closest('a.btn[href="#checkout"]');
    if (!go || reduce() || go.classList.contains('driving') || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    drive(go, false);
    setTimeout(function () { location.hash = 'checkout'; }, 900);
  });
  function drive(btn, loop) {
    btn.classList.add('driving'); if (loop) btn.classList.add('loop');
    if (!btn.querySelector('.truck-lane')) btn.insertAdjacentHTML('beforeend', '<span class="truck-lane" aria-hidden="true">' + TRUCK + '</span>');
  }
  function park(btn) { btn.classList.remove('driving', 'loop'); var l = btn.querySelector('.truck-lane'); if (l) l.remove(); }

  /* ---------- placing an order: the truck keeps going until the shop answers ---------- */
  new MutationObserver(function () {
    var b = document.getElementById('placeBtn'); if (!b) return;
    var busy = /Placing/.test(b.textContent);
    if (busy && !b.classList.contains('loop')) { b.setAttribute('aria-busy', 'true'); if (!reduce()) drive(b, true); }
    if (!busy && b.getAttribute('aria-busy') === 'true') { b.removeAttribute('aria-busy'); park(b); }
  }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true, characterData: true });
})();
