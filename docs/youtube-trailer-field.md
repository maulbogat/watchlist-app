# `youtubeId` field (TMDB trailers)

- **Real value** — YouTube **video id** from TMDB `videos` (same picker as `sync-metadata-from-tmdb-id.js`). Must match the usual **11-character** YouTube id format.
- **`null`** — TMDB has no YouTube trailer for this title, the row has no `tmdbId`, TMDB fetch failed, or the stored value was not a valid id.

The app treats a title as playable only if `youtubeId` matches `^[a-zA-Z0-9_-]{11}$` (see `lib/youtube-trailer-id.js`).

## Playback

The site **does not** call Netlify to resolve a trailer on click. It only embeds when `youtubeId` is a real id; otherwise it shows **“No trailer available”** (optional IMDb link).

## Populate / refresh all rows

```bash
node scripts/backup-firestore.js
node scripts/backfill-youtube-from-tmdb.js backups/firestore-backup.json
node scripts/restore-from-backup.js backups/firestore-backup.json
```

Requires `TMDB_API_KEY` in `.env`.

## Normalize invalid `youtubeId` values in a backup

Sets non-playable values (legacy placeholders, empty strings, etc.) to `null`:

```bash
node scripts/backup-firestore.js
node scripts/migrate-invalid-youtube-ids-to-null.js backups/firestore-backup.json
node scripts/restore-from-backup.js backups/firestore-backup.json
```
