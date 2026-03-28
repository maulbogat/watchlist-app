(function () {
  var m = window.location.pathname.match(/\/title\/(tt\d+)/);
  var imdbId = m ? m[1] : null;
  if (!imdbId) {
    alert("Not an IMDb title page. Open a movie or TV show page first.");
    return;
  }
  var origin = "https://watchlist.maulbogat.com";
  var url = origin + "/add.html?imdbId=" + encodeURIComponent(imdbId) + "&embed=1";
  var popup = window.open(url, "addToWatchlist", "width=420,height=220,menubar=no,toolbar=no,location=no,status=no");
  if (!popup) {
    alert("Popup blocked. Allow popups for this site and try again.");
    return;
  }
  var checkClosed = setInterval(function () {
    if (popup.closed) {
      clearInterval(checkClosed);
      window.removeEventListener("message", handleMessage);
    }
  }, 200);
  var timeoutId = setTimeout(function () {
    clearInterval(checkClosed);
    window.removeEventListener("message", handleMessage);
    if (!popup.closed) popup.close();
    showToast("Timed out. Sign in on the watchlist first.", true);
  }, 15000);
  function handleMessage(e) {
    var okOrigin =
      e.origin === "https://watchlist.maulbogat.com" ||
      /^https?:\/\/localhost(:\d+)?$/.test(e.origin);
    if (!okOrigin || !e.data || e.data.type !== "add-result") return;
    clearTimeout(timeoutId);
    clearInterval(checkClosed);
    window.removeEventListener("message", handleMessage);
    if (!popup.closed) popup.close();
    var msg = e.data.ok ? (e.data.message || "Added to watchlist!") : (e.data.error || "Failed to add.");
    showToast(msg, !e.data.ok);
  }
  function showToast(msg, isError) {
    var toast = document.createElement("div");
    toast.style.cssText = "position:fixed;bottom:20px;right:20px;padding:12px 20px;background:#131317;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:14px;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.4)";
    toast.textContent = msg;
    if (isError) toast.style.color = "#e74c3c";
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) document.body.removeChild(toast); }, 3000);
  }
  window.addEventListener("message", handleMessage);
})();
