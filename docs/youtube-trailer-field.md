# `youtubeId` field (TMDB trailers)

- **Real value** — YouTube **video id** from TMDB `videos` (same picker as `sync-metadata-from-tmdb-id.js`).
- **`NONE`** — TMDB has no YouTube trailer for this title, or the row has no `tmdbId`, or TMDB detail fetch failed.
- **Legacy `SEARCH`** — Treated like `NONE` in the UI (no in-app trailer resolution).

## Playback

The site **does not** call Netlify to resolve a trailer on click. It only embeds when `youtubeId` is a real id; otherwise it shows **“No trailer available”** (optional IMDb link).

## Populate / refresh all rows

```bash
node scripts/backup-firestore.js
node scripts/backfill-youtube-from-tmdb.js backups/firestore-backup.json
node scripts/restore-from-backup.js backups/firestore-backup.json
```

Requires `TMDB_API_KEY` in `.env`.
