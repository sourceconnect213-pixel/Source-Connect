/* Runs in <head>, before the page paints (kept out of the HTML so the Content-Security-Policy can forbid inline scripts). */
/* One address for the shop: www.sourceconnectglobal.com goes to sourceconnectglobal.com (sign-ins, carts and Google
   sign-in all belong to one address). */
(function () {
  if (location.hostname === 'www.sourceconnectglobal.com') location.replace('https://sourceconnectglobal.com' + location.pathname + location.search + location.hash);
})();
/* Decide before the page paints whether the welcome intro plays (see js/intro.js). */
(function () {
  try {
    if (/[?&]preview=1/.test(location.search)) return;
    var force = /[?&]intro=1/.test(location.search);
    var d = JSON.parse(localStorage.getItem('scg_db_v2') || 'null');
    var w = (d && d.settings && d.settings.welcome) || { on: true, mode: 'session' };
    var seen = w.mode === 'first' ? localStorage.getItem('scg_intro_seen') : sessionStorage.getItem('scg_intro_seen');
    if (force || (w.on !== false && w.mode !== 'off' && (w.mode === 'visit' || !seen))) {
      document.documentElement.classList.add('intro-on', 'intro-wait');
      var l = document.createElement('link'); l.rel = 'preload'; l.as = 'image'; l.href = 'assets/intro-emblem.webp?v=1'; document.head.appendChild(l);
      /* Safety net: if the shop cannot start (no connection, server down), never leave the visitor on the dark cover. */
      setTimeout(function () { if (!document.querySelector('.intro')) document.documentElement.classList.remove('intro-on', 'intro-wait'); }, 15000);
    }
  } catch (e) {}
})();
