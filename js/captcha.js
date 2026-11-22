/* Bot protection (Cloudflare Turnstile) for sign-up, sign-in and password changes.
   Off until a site key is set in js/config.js (TURNSTILE_SITE_KEY). When it is on, Supabase Auth refuses those requests
   without a fresh token, so this file must load on every page that signs people in.
   - The widget stays invisible unless Cloudflare needs the person to click ("interaction-only").
   - Each token is used once: a new one is made for every attempt. */
(function (global) {
  var KEY = global.SCG_CAPTCHA_KEY || '';
  var ready = null, box = null, wid = null;
  function load() {
    if (ready) return ready;
    ready = new Promise(function (ok, no) {
      if (global.turnstile) return ok(global.turnstile);
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = function () { global.turnstile ? ok(global.turnstile) : no(new Error('The security check could not start.')); };
      s.onerror = function () { ready = null; no(new Error('The security check could not load. Check your internet connection and try again.')); };
      document.head.appendChild(s);
    });
    return ready;
  }
  // a fresh token (or null when bot protection is off)
  function token() {
    if (!KEY) return Promise.resolve(null);
    return load().then(function (ts) {
      return new Promise(function (ok, no) {
        if (!box) { box = document.createElement('div'); box.className = 'captcha-box'; document.body.appendChild(box); }
        var done = false, timer = setTimeout(function () { if (!done) { done = true; no(new Error('The security check took too long. Please try again.')); } }, 60000);
        var finish = function (fn, v) { if (done) return; done = true; clearTimeout(timer); fn(v); };
        if (wid !== null) { try { ts.remove(wid); } catch (e) {} wid = null; }
        wid = ts.render(box, { sitekey: KEY, appearance: 'interaction-only', 'refresh-expired': 'manual',
          callback: function (t) { finish(ok, t); },
          'error-callback': function () { finish(no, new Error('The security check failed. Please try again.')); return true; },
          'expired-callback': function () { finish(no, new Error('The security check expired. Please try again.')); } });
      });
    });
  }
  global.SCGCaptcha = { on: !!KEY, token: token };
})(window);
