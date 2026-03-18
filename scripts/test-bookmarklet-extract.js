/**
 * Test bookmarklet extraction logic on an IMDb URL.
 * Run: node scripts/test-bookmarklet-extract.js <imdb-url>
 */
const url = process.argv[2] || "https://www.imdb.com/title/tt7456722/";
const imdbMatch = url.match(/\/title\/(tt\d+)/);
if (!imdbMatch) {
  console.error("Invalid IMDb URL");
  process.exit(1);
}
const imdb = imdbMatch[1];

async function run() {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  const html = await res.text();
  if (html.length < 100) {
    console.log("Warning: Received very little HTML (" + html.length + " chars). IMDb may block server requests.");
    console.log("The bookmarklet runs in the browser and sees the fully rendered page.");
  }

  // Simulate bookmarklet extraction
  let title = "",
    year = "",
    type = "movie",
    genre = "",
    thumb = "",
    youtubeId = "";

  // document.title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const dt = titleMatch ? titleMatch[1].replace(/\s*-\s*IMDb$/i, "") : "";
  if (/TV\s*(Mini\s*)?Series|Documentary\s*Series/i.test(dt)) type = "show";
  const ym = dt.match(/(\d{4})/);
  if (ym) year = ym[1];

  // hero-title-block__title
  const titleBlockMatch = html.match(/data-testid="hero-title-block__title"[^>]*>([^<]+)</);
  if (titleBlockMatch) {
    title = titleBlockMatch[1]
      .replace(/\s*-\s*IMDb$/i, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
  }

  // og:title fallback
  if (!title) {
    const ogMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    if (ogMatch) {
      const s = ogMatch[1].replace(/\s*-\s*IMDb$/i, "");
      const yx = s.match(/(\d{4})/);
      if (yx) year = yx[1];
      if (/TV\s*(Mini\s*)?Series/i.test(s)) type = "show";
      title = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
    }
  }

  // document.title fallback for title
  if (!title && dt) {
    const dm = dt.match(/^(.+?)\s*\(/);
    if (dm) title = dm[1].trim();
  }

  // hero-title-block__metadata
  const metaMatch = html.match(/data-testid="hero-title-block__metadata"[^>]*>([\s\S]*?)<\/div>/);
  if (metaMatch) {
    const yt = metaMatch[1].replace(/<[^>]+>/g, " ");
    if (!year) {
      const yy = yt.match(/(\d{4})/);
      if (yy) year = yy[1];
    }
    if (/TV\s*(Mini\s*)?Series|Documentary\s*Series/i.test(yt)) type = "show";
  }

  // genre links
  const genreMatches = html.matchAll(/<a[^>]*href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)<\/a>/g);
  const genres = [...genreMatches].map((m) => m[1].trim()).filter(Boolean);
  if (genres.length) genre = [...new Set(genres)].slice(0, 5).join(" / ");

  // poster
  const posterMatch = html.match(/data-testid="hero-media__poster"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
  if (posterMatch) thumb = posterMatch[1];
  if (!thumb) {
    const amazonMatch = html.match(/<img[^>]*src="(https:\/\/[^"]*media-amazon[^"]+)"/);
    if (amazonMatch) thumb = amazonMatch[1];
  }

  // youtube
  const ytMatch = html.match(/youtube\.com\/watch\?[^"'\s]*v=([a-zA-Z0-9_-]{11})|youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (ytMatch) youtubeId = ytMatch[1] || ytMatch[2];

  console.log("Extracted data for", url);
  console.log("---");
  console.log("imdbId:", imdb);
  console.log("title:", title || "(empty)");
  console.log("year:", year || "(empty)");
  console.log("type:", type);
  console.log("genre:", genre || "(empty)");
  console.log("thumb:", thumb ? thumb.substring(0, 60) + "..." : "(empty)");
  console.log("youtubeId:", youtubeId || "(empty)");
  console.log("---");
  console.log("Payload to API:", JSON.stringify({ imdbId: imdb, title: title || "Unknown", year: year || null, type, genre: genre || null, thumb: thumb || null, youtubeId: youtubeId || null }, null, 2));

  // Debug: show raw matches if available
  if (titleMatch) console.log("\n[Debug] document.title:", titleMatch[1].substring(0, 80));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
