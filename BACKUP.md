# Firestore Backup Setup

The daily backup job runs via GitHub Actions and saves a full Firestore snapshot to `backups/firestore-backup.json`.

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
