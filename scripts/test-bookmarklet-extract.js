/**
 * Test title extraction on an IMDb title page.
 * Open https://www.imdb.com/title/tt7456722/ (or any title), open DevTools Console,
 * paste this script, and run it to see what each selector finds.
 */
(function () {
  console.log("=== IMDb Title Extraction Test ===\n");

  var heroTitle = document.querySelector("[data-testid='hero__pageTitle']");
  console.log("1. [data-testid='hero__pageTitle']:", heroTitle ? heroTitle.textContent.trim() : "NOT FOUND");

  var heroTitleBlock = document.querySelector("[data-testid='hero-title-block__title']");
  console.log("2. [data-testid='hero-title-block__title']:", heroTitleBlock ? heroTitleBlock.textContent.trim() : "NOT FOUND");

  var h1 = document.querySelector("h1");
  if (h1) {
    console.log("3. h1.textContent:", h1.textContent.trim());
    var firstSpan = h1.querySelector("span");
    console.log("4. h1 first span:", firstSpan ? firstSpan.textContent.trim() : "N/A");
    var spans = h1.querySelectorAll("span");
    spans.forEach(function (s, i) {
      if (s.textContent.trim()) console.log("   span[" + i + "]:", JSON.stringify(s.textContent.trim()));
    });
  } else {
    console.log("3. h1: NOT FOUND");
  }

  var metaTitle = document.querySelector('meta[property="og:title"]');
  console.log("5. og:title:", metaTitle ? metaTitle.content : "NOT FOUND");

  console.log("\n--- Simulated extraction result ---");
  var title = "";
  if (heroTitle && heroTitle.textContent) {
    title = heroTitle.textContent.trim();
    console.log("Using: hero__pageTitle ->", title);
  } else if (h1) {
    var firstSpan = h1.querySelector("span");
    if (firstSpan && firstSpan.textContent && !/[•|⭐]/.test(firstSpan.textContent)) {
      title = firstSpan.textContent.trim();
      console.log("Using: h1 first span ->", title);
    } else {
      var h1Text = (h1.textContent || "").trim();
      h1Text = h1Text.split("|")[0].split("•")[0].trim();
      h1Text = h1Text.replace(/\s*⭐\s*[\d.]*\s*$/i, "").trim();
      title = h1Text.replace(/\s*\([^)]*\)\s*$/, "").trim();
      console.log("Using: h1 stripped ->", title);
    }
  } else if (metaTitle && metaTitle.content) {
    var raw = metaTitle.content.split(" - ")[0].split("|")[0].trim();
    title = raw.replace(/\s*⭐\s*[\d.]*\s*$/i, "").trim();
    title = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
    console.log("Using: og:title stripped ->", title);
  }
  console.log("FINAL TITLE:", title || "(empty)");
})();
