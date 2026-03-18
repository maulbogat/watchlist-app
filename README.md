# movie-trailer-site

A personal movie/show watchlist with YouTube trailers, filters, and Firestore-backed catalog + watched status.

## Run locally

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173`. (YouTube embeds can fail when opened via `file://`.)

## Firebase setup

1. **Enable Authentication** → Sign-in method → Google → Enable
2. **Create Firestore Database** → Start in production mode
3. **Deploy Firestore rules** from `firestore.rules`:
   ```bash
   firebase deploy --only firestore:rules
   ```
   Or paste the rules in Firebase Console → Firestore → Rules

4. **Movie catalog** is stored in Firestore. To add/update movies, edit the `catalog/movies` document in Firebase Console → Firestore.

## Netlify deployment (bookmarklet)

For the IMDb bookmarklet to add titles to the catalog, set `FIREBASE_SERVICE_ACCOUNT` in Netlify → Site settings → Environment variables:

```bash
base64 -i serviceAccountKey.json | tr -d '\n'
```

Paste the output as the value. The bookmarklet calls `/.netlify/functions/add-from-imdb` to add movies and deduplicate.

## Features

- Movie catalog stored in Firestore
- To Watch / Watched tabs
- Filter by Movies, Series, or Both
- Mark titles as watched (persists across devices via Google sign-in)
- Checkmark on watched cards
- Service chips (Netflix, Prime Video, etc.)
