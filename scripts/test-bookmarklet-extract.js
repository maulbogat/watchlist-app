/**
 * Test IMDb ID extraction on an IMDb title page.
 * Open any IMDb title page (e.g. imdb.com/title/tt7235466/), open DevTools Console,
 * paste this script, and run it.
 */
(function () {
  var m = window.location.pathname.match(/\/title\/(tt\d+)/);
  var imdbId = m ? m[1] : null;
  console.log("IMDb ID:", imdbId || "NOT FOUND (not an IMDb title page)");
})();
