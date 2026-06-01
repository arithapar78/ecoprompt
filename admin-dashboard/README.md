# EcoPrompt Admin Dashboard

A private analytics dashboard for viewing anonymous usage stats. No prompt text is ever collected or shown.

---

## Setup: Admin Key

The `getAnalyticsStats` Cloud Function reads the admin key from the environment variable `ADMIN_DASHBOARD_KEY`.

### Option A — `.env` file (recommended for Firebase 2nd gen)

Firebase Functions v2 supports a `.env` file inside `functions/`. Open `functions/.env` and replace the placeholder:

```
ADMIN_DASHBOARD_KEY=replace-with-a-long-random-password
```

Use a long random string (e.g. output of `openssl rand -hex 32`). This file is already gitignored — it will never be committed.

### Option B — Firebase CLI secret (for production)

If you prefer storing the key as a Firebase secret:

```bash
firebase functions:secrets:set ADMIN_DASHBOARD_KEY
```

Then add `secretEnvironmentVariables: ["ADMIN_DASHBOARD_KEY"]` to the function options in `functions/index.js`. See Firebase docs for secrets.

---

## Deploy the Function

```bash
cd /path/to/ecopromptv2
firebase deploy --only functions
```

After deploy, Firebase prints the URLs for both functions, e.g.:

```
✔  functions[us-east1-trackOptimizationEvent]: https://trackevent-xxx-ue.a.run.app
✔  functions[us-east1-getAnalyticsStats]: https://getanalyticsstats-xxx-ue.a.run.app
```

Copy the `getAnalyticsStats` URL.

---

## Configure the Dashboard

Open `admin-dashboard/dashboard.js` and paste the URL:

```js
const STATS_ENDPOINT = "https://getanalyticsstats-xxx-ue.a.run.app";
```

---

## Using the Dashboard

1. Open `admin-dashboard/index.html` in Chrome (you can open it as a local file: `File → Open File`).
2. Enter your admin key in the **Admin Key** field and click **Save Key** (stored in `localStorage` only — never sent anywhere except the Cloud Function header).
3. Choose a range: **Today**, **This Month**, or **All Time**.
4. Click **Refresh**.

---

## Security Notes

- The admin key is never in the frontend source code — you type it in at runtime.
- The Cloud Function rejects requests without the correct key with HTTP 403.
- `functions/.env` is gitignored and will not be committed.
- No prompt text, emails, names, or IPs are ever stored or returned.
- Users appear only as anonymous labels: u1, u2, u3, …

---

## Files

| File | Purpose |
|---|---|
| `admin-dashboard/index.html` | Dashboard HTML page |
| `admin-dashboard/dashboard.css` | Dashboard styles |
| `admin-dashboard/dashboard.js` | Fetch + render logic |
| `functions/index.js` | Cloud Functions (trackOptimizationEvent + getAnalyticsStats) |
| `functions/.env` | Local env file with admin key (gitignored) |
