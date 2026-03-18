# movie-trailer-site

A personal movie/show watchlist with YouTube trailers, filters, and Firestore. Each account has its own list.

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

4. **Movie lists** are stored per user in `users/{uid}`. Users add titles via the bookmarklet; no shared catalog is needed for new users.

## Netlify deployment (bookmarklet)

For the IMDb bookmarklet to add titles from imdb.com:

1. Set `FIREBASE_SERVICE_ACCOUNT` in Netlify → Site settings → Environment variables:
   ```bash
   base64 -i serviceAccountKey.json | tr -d '\n'
   ```
   Paste the output as the value.

2. Set `OMDB_API_KEY` in Netlify → Site settings → Environment variables. Get a free key at [omdbapi.com](https://www.omdbapi.com/apikey.aspx).

3. Set `TMDB_API_KEY` in Netlify → Site settings → Environment variables (for trailer lookup when playing). Get a free key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).

4. Visit `/bookmarklet.html` on your deployed site, drag the button to your bookmarks bar, then sign in with Google. When on an IMDb title page, click the bookmarklet to add it to your watchlist.

## Multi-user support

Multiple people can use the app with their own Google accounts. Each account has its own list of titles—items added via the bookmarklet go only to that account's list.

## Shared lists

Create shared lists that multiple people can add to and update together:

1. **Create:** Use the list dropdown → "+ Create shared list" → enter a name
2. **Share:** Copy the link shown and send it to others
3. **Join:** Others open the link while signed in to join the list
4. **Add items:** When viewing a shared list, the bookmarklet adds to that list (sign in and switch to the shared list first)

Deploy Firestore rules: `firebase deploy --only firestore:rules`

**Verify in Firebase Console:**

1. **Authentication → Sign-in method** → Google → Enabled
2. **Authentication → Settings → Authorized domains** → Add your Netlify URL (e.g. `watchlist-trailers.netlify.app`) and `localhost` for local dev
3. **Firestore rules** (in `firestore.rules`) — users can only read/write their own `users/{uid}` data

The header shows the signed-in user's email so family members know whose account they're using on shared devices.

## Features

- Per-user lists (each account has its own titles)
- To Watch / Watched tabs
- Filter by Movies, Series, or Both
- Mark titles as watched (persists across devices via Google sign-in)
- Checkmark on watched cards
- Service chips (Netflix, Prime Video, etc.)
