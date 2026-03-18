(function () {
  var script = document.currentScript;
  var base = script ? (function (u) {
    try { return new URL(u).origin; } catch (e) { return ""; }
  })(script.src) : "";
  if (!base) base = "https://watchlist-trailers.netlify.app";

  var m = window.location.pathname.match(/\/title\/(tt\d+)/);
  var imdbId = m ? m[1] : null;
  if (!imdbId) {
    alert("Not an IMDb title page. Open a movie or TV show page first.");
    return;
  }

  var title = "";
  var year = "";
  var type = "movie";
  var genre = "";
  var thumb = "";

  var heroTitle = document.querySelector("[data-testid='hero__pageTitle']") || document.querySelector("[data-testid='hero-title-block__title']");
  if (heroTitle && heroTitle.textContent) {
    title = heroTitle.textContent.trim();
  }
  if (!title) {
    var h1 = document.querySelector("h1");
    if (h1) {
      var firstSpan = h1.querySelector("span");
      if (firstSpan && firstSpan.textContent && !/[•|⭐]/.test(firstSpan.textContent)) {
        title = firstSpan.textContent.trim();
      }
      if (!title) {
        var h1Text = (h1.textContent || "").trim();
        h1Text = h1Text.split("|")[0].split("•")[0].trim();
        h1Text = h1Text.replace(/\s*⭐\s*[\d.]*\s*$/i, "").trim();
        title = h1Text.replace(/\s*\([^)]*\)\s*$/, "").trim();
      }
    }
  }
  if (!title) {
    var metaTitle = document.querySelector('meta[property="og:title"]');
    if (metaTitle && metaTitle.content) {
      var raw = metaTitle.content.split(" - ")[0].split("|")[0].trim();
      title = raw.replace(/\s*⭐\s*[\d.]*\s*$/i, "").trim();
      title = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
    }
  }
  if (!title) title = "Unknown";

  if (!year) {
    var metaEl = document.querySelector("[data-testid='hero-title-block__metadata']");
    if (metaEl && metaEl.textContent) {
      var parts = metaEl.textContent.split(/[•·]/).map(function (p) { return p.trim(); });
      for (var i = 0; i < parts.length; i++) {
        var ym = parts[i].match(/^(\d{4})(?:[–\-]\s*\d{0,4})?$/);
        if (ym) { year = ym[1]; break; }
      }
    }
  }
  if (!year) {
    var yInPage = (document.body && document.body.innerText || "").match(/\b(19|20)\d{2}(?:[–\-]\s*(?:19|20)\d{2})?[–\-]?\b/);
    if (yInPage) year = (yInPage[0].match(/\d{4}/) || [""])[0];
  }
  if (!year && document.querySelector('meta[property="og:title"]')) {
    var raw = document.querySelector('meta[property="og:title"]').content;
    var yParen = raw.match(/\([^)]*?(\d{4})(?:[–\-]\s*(\d{4})?)?[–\-]?[^)]*\)/);
    if (yParen) year = yParen[1];
  }

  var bodyText = (document.body && document.body.innerText) || "";
  if (/TV Series|TV Mini Series|TV Movie|TV Special|TV Short/i.test(bodyText)) type = "show";

  var genreEl = document.querySelector("[data-testid='storyline-genres']");
  if (genreEl) {
    var links = genreEl.querySelectorAll("a");
    genre = Array.from(links).map(function (a) { return (a.textContent || "").trim(); }).filter(Boolean).join(" / ");
  }

  var poster = document.querySelector("[data-testid='hero-media__poster'] img, .ipc-poster img, [data-testid='hero-media__poster'] img");
  if (poster && poster.src) thumb = poster.src;

  var payload = { imdbId: imdbId, title: title, year: year || null, type: type, genre: genre || "", thumb: thumb || null };

  var apiUrl = base + "/.netlify/functions/add-from-imdb";
  fetch(apiUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
