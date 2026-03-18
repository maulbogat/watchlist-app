/**
 * Fetch title data from OMDb API by IMDb ID.
 * Run: OMDB_API_KEY=yourkey node scripts/fetch-omdb.js tt7235466
 */
const id = process.argv[2] || "tt7235466";
const key = process.env.OMDB_API_KEY;
if (!key) {
  console.error("Set OMDB_API_KEY: OMDB_API_KEY=yourkey node scripts/fetch-omdb.js tt7235466");
  process.exit(1);
}
const url = `https://www.omdbapi.com/?i=${encodeURIComponent(id)}&apikey=${key}`;
fetch(url)
  .then((r) => r.json())
  .then((data) => {
    if (data.Response === "False") {
      console.error(data.Error || "OMDb lookup failed");
      process.exit(1);
    }
    console.log(JSON.stringify(data, null, 2));
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
