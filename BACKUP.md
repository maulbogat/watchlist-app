# Firestore Backup Setup

**Two backups:** (1) **GitHub Actions** commits a JSON snapshot to `backups/firestore-backup.json` (this doc). (2) **Google Cloud Storage** holds **native Firestore exports** from **Cloud Scheduler** job **`firestore-daily-export`** (**4:00 UTC** daily) into bucket **`movie-trailer-site-backups`** (**europe-west1**), **OAuth** via **`firestore-scheduler`**; a **30-day** lifecycle rule deletes older objects. Open the bucket and job from **Admin → Service Links** or the GCP console.

The daily **GitHub** job runs via GitHub Actions and saves a full Firestore snapshot to `backups/firestore-backup.json`.

**Disable without editing the workflow:** set **`githubBackupEnabled`** to **`false`** on **`meta/jobConfig`** (Admin → System Status → GitHub Backup → Disable). The script exits immediately; the Actions run still completes successfully without updating the JSON file.

## One-time setup

### 1. Get your Firebase service account key

1. Open [Firebase Console](https://console.firebase.google.com) → your project
2. Go to **Project settings** (gear icon) → **Service accounts**
3. Click **Generate new private key**
4. Save the JSON file (keep it secure; do not commit it)

### 2. Encode the key as base64

On macOS/Linux:

```bash
base64 -i path/to/your-service-account.json | tr -d '\n' | pbcopy
```

Or without pbcopy (prints to terminal):

```bash
base64 -i path/to/your-service-account.json | tr -d '\n'
```

Copy the entire output.

### 3. Add the secret to GitHub

1. Open your repo on GitHub
2. Go to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `FIREBASE_SERVICE_ACCOUNT`
5. Value: paste the base64 string from step 2
6. Click **Add secret**

### 4. Push the workflow

Commit and push the `.github/workflows/backup.yml` file. The workflow will run:

- **Daily** at 6:00 UTC
- **Manually** from the Actions tab → "Daily Firestore Backup" → "Run workflow"

## Restore from backup

**v4 backups** also restore **allowedUsers**, **invites**, **phoneIndex**, and **upcomingChecks**. Overwriting **allowedUsers** or **phoneIndex** changes app access and WhatsApp-linked numbers—read the warning at the top of `scripts/restore-from-backup.js` before running a full restore.

To restore locally (requires Firebase credentials):

```bash
# Preview what would be restored (no changes)
node scripts/restore-from-backup.js --dry-run

# Restore (overwrites Firestore data)
node scripts/restore-from-backup.js
```

Use a specific backup file:

```bash
node scripts/restore-from-backup.js backups/firestore-backup-2025-03-20.json
```

## Backup location

Backups are committed to `backups/firestore-backup.json` in the repo. Git history keeps previous versions if you need to roll back.

## Admin page (latest run + GCP links)

Signed-in **admin** users can see the latest GitHub Actions run for **Daily Firestore Backup** on the in-app **Admin** page. The API route **`/api/admin/external-status?service=github`** calls the GitHub API (default repository **`maulbogat/watchlist`** when **`GITHUB_REPO`** is unset); for **private** repos or steadier rate limits, set optional **`GITHUB_TOKEN`** (PAT with `actions: read`) and optional **`GITHUB_REPO`** (`owner/name`) in Vercel (or local `.env`) environment variables.

**Service Links** on the same page also open **Google Cloud Storage** (**`movie-trailer-site-backups`**) and **Cloud Scheduler** ( **`firestore-daily-export`** ) for the native export path — no app env vars for those (see **`docs/environment.md`**).
