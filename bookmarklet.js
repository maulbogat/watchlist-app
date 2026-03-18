(function () {
  var m = window.location.pathname.match(/\/title\/(tt\d+)/);
  var imdbId = m ? m[1] : null;
  if (!imdbId) {
    alert("Not an IMDb title page. Open a movie or TV show page first.");
    return;
  }
  var url = "https://watchlist-trailers.netlify.app/add.html?imdbId=" + encodeURIComponent(imdbId) + "&embed=1";
  var iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.style.cssText = "position:fixed;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);
  var timeoutId = setTimeout(function () {
    if (iframe.parentNode) {
      window.removeEventListener("message", handleMessage);
      document.body.removeChild(iframe);
      showToast("Timed out. Sign in on the watchlist first.", true);
    }
  }, 15000);
  function handleMessage(e) {
    var okOrigin = e.origin === "https://watchlist-trailers.netlify.app" || /^https?:\/\/localhost(:\d+)?$/.test(e.origin);
    if (!okOrigin || !e.data || e.data.type !== "add-result") return;
    clearTimeout(timeoutId);
    window.removeEventListener("message", handleMessage);
    if (iframe.parentNode) document.body.removeChild(iframe);
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
