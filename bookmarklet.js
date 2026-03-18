(function () {
  var m = window.location.pathname.match(/\/title\/(tt\d+)/);
  var imdbId = m ? m[1] : null;
  if (!imdbId) {
    alert("Not an IMDb title page. Open a movie or TV show page first.");
    return;
  }
  var url = "https://watchlist-trailers.netlify.app/add.html?imdbId=" + encodeURIComponent(imdbId);
  var w = window.open(url, "addToWatchlist", "width=420,height=220");
  if (!w) window.location = url;
})();
