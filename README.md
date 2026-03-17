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

4. **Upload movie catalog** (one-time):
   - Firebase Console → Project Settings → Service Accounts → Generate new private key
   - Save as `serviceAccountKey.json` in project root (already in .gitignore)
   - Run: `npm install && npm run upload-catalog`
   - To add/update movies: edit `data.json` and run `npm run upload-catalog` again

## Features

- Movie catalog stored in Firestore
- To Watch / Watched tabs
- Filter by Movies, Series, or Both
- Mark titles as watched (persists across devices via Google sign-in)
- Checkmark on watched cards
- Service chips (Netflix, Prime Video, etc.)
