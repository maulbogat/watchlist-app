(function () {
  var m = window.location.pathname.match(/\/title\/(tt\d+)/);
  var imdbId = m ? m[1] : null;
  if (!imdbId) {
    alert("Not an IMDb title page. Open a movie or TV show page first.");
    return;
  }
  var base = "https://watchlist-trailers.netlify.app";
  var apiUrl = base + "/.netlify/functions/add-from-imdb";
  var body = { imdbId: imdbId };
  var listMatch = document.cookie.match(/bookmarklet_list_id=([^;]+)/);
  if (listMatch) body.listId = decodeURIComponent(listMatch[1].trim());
  fetch(apiUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.ok) {
        alert(data.message || "Added to watchlist!");
      } else {
        alert(data.error || "Failed to add.");
      }
    })
    .catch(function (err) {
      alert("Error: " + (err.message || "Could not reach watchlist. Sign in at " + base + " first."));
    });
})();
