# Trailer / thumbnail doesn’t match the title

## Root cause (fixed in code)

TMDB’s `/find?external_source=imdb_id` can return **both** `movie_results` and `tv_results` for a single IMDb id. The old logic used `movie?.id ?? tv?.id`, which **always chose the movie** when both existed.

TV miniseries and docuseries (e.g. *Crime Scene: The Vanishing at the Cecil Hotel*) are **TV on TMDB**. If a film was also present in `movie_results`, the app loaded the **wrong** TMDB detail → wrong YouTube trailer, poster thumb, and genres (e.g. Drishyam trailer on a Cecil Hotel card).

### What we changed

1. **`netlify/functions/add-from-imdb.js`**  
   - Chooses movie vs TV using **OMDb `Type`** when both exist (`movie` vs `series`/`episode`).  
   - If OMDb isn’t available, **prefers TV** when both exist (safer for miniseries).

2. **`app.js`**  
   - Trailers play only from **stored** `youtubeId` (TMDB key) or show **no trailer**; see `docs/youtube-trailer-field.md`.

3. **`scripts/backfill-tmdb-from-imdb.js`** & **`scripts/add-tmdb-ids-from-imdb.js`**  
   - Same disambiguation using the row’s **`type`** (`movie` vs `show`) when both TMDB results exist.

## Fixing bad rows already in Firestore

After deploying the Netlify function:

1. Back up: `node scripts/backup-firestore.js`
2. Refresh metadata + thumb + trailer from IMDb (uses fixed picker + row `type`):  
   `node scripts/backfill-tmdb-from-imdb.js backups/firestore-backup.json`
3. Restore: `node scripts/restore-from-backup.js backups/firestore-backup.json`

Or run `sync-metadata-from-tmdb-id.js` once items have correct **`tmdbId`** / **`tmdbMedia`** from backfill.

## Wrong genre text (e.g. “Comedy / Drama” for a documentary)

That was a symptom of the wrong TMDB entity (movie row). Re-running backfill as above replaces `genre`, `thumb`, and `youtubeId` from the correct TV detail.
