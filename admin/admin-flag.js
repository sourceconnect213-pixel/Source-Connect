/* Tells the shared scripts they run inside the admin (kept out of the HTML for the Content-Security-Policy). */
window.SCG_ADMIN = true;
/* One address for the shop: www.sourceconnectglobal.com goes to sourceconnectglobal.com (sign-ins, carts and Google
   sign-in all belong to one address). */
(function () {
  if (location.hostname === 'www.sourceconnectglobal.com') location.replace('https://sourceconnectglobal.com' + location.pathname + location.search + location.hash);
})();

