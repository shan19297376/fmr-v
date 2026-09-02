# Family Medical Records — Setup

**No terminal. No Node.js. No commands.** Four accounts, some clicking, about 25 minutes.
Everything below is free. Nothing asks for a card.

Your login page will be **vishal.cloudflareaccess.com**.
Your files stay in **your own Google Drive**, in a folder called `Family Medical Records`.

---

## Step 1 — GitHub account (3 min)

You need this only because the Deploy button puts a copy of the code in your
account, so future updates deploy themselves.

1. Go to **https://github.com/signup**
2. Sign up with your usual email. Verify it.
3. Done. You never have to open GitHub again.

---

## Step 2 — Cloudflare account (4 min)

1. Go to **https://dash.cloudflare.com/sign-up**
2. Sign up. Verify the email.
3. If it asks you to add a website or domain, **skip it**. You don't need one.

---

## Step 3 — Let the app write to your Google Drive (10 min)

This is the only fiddly part. Do it once and never again.

1. Go to **https://console.cloud.google.com/**
2. Top of the page, click the project dropdown → **New Project**.
   Name it `Family Medical Records`. Click **Create**. Wait for it to switch over.
3. In the search bar at the top, type `Google Drive API`. Open it. Click **Enable**.
4. Search for `OAuth consent screen` and open it.
   - User type: **External**. Click Create.
   - App name: `Family Medical Records`
   - User support email: your email
   - Developer contact: your email
   - **Save and Continue** through Scopes (add nothing) and Test users.
   - Back on the summary page, click **Publish App** → confirm.
     *(This is safe. We only ask for the `drive.file` permission, which lets the
     app touch files it created itself and nothing else in your Drive. Google
     does not require a review for that.)*
5. Search for `Credentials` and open it.
   - **Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `FMR Worker`
   - Under **Authorised redirect URIs**, click Add URI and paste:
     `https://fmr.YOURNAME.workers.dev/auth/google/callback`
     *(You'll get your real address in Step 5. For now put this in, and we'll
     correct it after deployment — it takes ten seconds.)*
   - Click **Create**.
6. A box appears with a **Client ID** and a **Client Secret**.
   Copy both into a notepad file. You need them in Step 5.

---

## Step 4 — Gemini API key (2 min)

You probably have one from the old app. Otherwise:

1. Go to **https://aistudio.google.com/apikey**
2. **Create API key**. Copy it into your notepad.

---

## Step 5 — Deploy (4 min)

1. Open the repository link I'll send you and click the big **Deploy to Cloudflare** button.
2. It asks to connect your GitHub — click through and authorise.
3. It shows a **Configure resources** screen. It has already worked out that the
   app needs a database and a queue. Leave the names as they are. Click next.
4. It asks for secrets. Paste:
   - `GEMINI_API_KEY` → your Gemini key
   - `GOOGLE_CLIENT_ID` → from Step 3
   - `GOOGLE_CLIENT_SECRET` → from Step 3
   - `ACCESS_AUD` → **leave blank for now**, you'll fill it in Step 6
5. Click **Deploy**. Wait two or three minutes. It builds the app, creates the
   database, loads the structure, loads all 241 test-name mappings from your old
   app, and gives you an address like `https://fmr-abc.YOURNAME.workers.dev`.

**Copy that address.** Then go back to Google Cloud Console → Credentials →
click your `FMR Worker` client → fix the redirect URI to your real address
(`https://<your real address>/auth/google/callback`) → Save.

> At this moment the app is live but **anyone with the address can open it.**
> Do Step 6 before you put any real data in.

---

## Step 6 — Lock the front door (6 min)

1. Cloudflare dashboard → **Zero Trust** in the left sidebar.
2. First time, it asks for a team name. Enter **`vishal`**.
   Your login page becomes `vishal.cloudflareaccess.com`.
3. Choose the **Free** plan (covers 50 users, permanently, ₹0).
4. **Settings → Authentication → Login methods → Add new → One-time PIN.**
   This lets family members log in with a code emailed to them. No passwords.
5. **Access → Applications → Add an application → Self-hosted.**
   - Application name: `Family Medical Records`
   - Session duration: 1 month (so nobody re-logs-in daily)
   - Public hostname: paste your `workers.dev` address from Step 5
   - Next.
6. **Add a policy:**
   - Policy name: `Family`
   - Action: **Allow**
   - Include → **Emails** → add each person's email, one line each. Start with
     your own. Add Reena and the others now or later.
   - Save.
7. Back on the application's page, find **Application Audience (AUD) Tag** — a
   long string of letters and numbers. Copy it.
8. Cloudflare dashboard → **Workers & Pages** → your `fmr` worker →
   **Settings → Variables and Secrets** → find `ACCESS_AUD` → paste the tag → **Save**.

Now open your app address in a private browser window. You should be stopped by
a Cloudflare login page. **If you see the app without logging in, stop and tell
me** — something in Step 6 didn't take.

---

## Step 7 — First run (3 min)

1. Open your app address and log in with your email + the code you receive.
2. Because you're the first person in, you automatically become the **owner**.
3. Click **Connect Google**. It bounces you to Google, asks permission to manage
   files the app creates, and comes back. This creates the
   `Family Medical Records` folder in your Drive.
4. Add your family members: Vishal, Reena, Madhu, Surjeet.
5. Upload one lab report as a test. It should return immediately and show
   "Reading in the background". Refresh after a minute to see the extraction.

---

## Adding or removing people later

| To do this | Go here |
|---|---|
| Let someone in | Zero Trust → Access → Applications → your app → Policy → add their email |
| Remove someone instantly | Same place, delete their email |
| Give a doctor read-only access to one person | Inside the app: Share → pick person → set expiry |
| See everything as a spreadsheet | Open the `Family Medical Records — Mirror` sheet in your Drive |

---

## What this costs

Nothing, at your volume. For reference, the free allowances are 100,000 Worker
requests per day, 5 GB of database, 100,000 database writes per day, 10,000
background jobs per day, and 50 Access users. A busy day for your family is
maybe 500 requests and 2,000 writes.

Your scanned documents use your existing 15 GB of Google Drive, same as today.

---

## What's still coming (Part 3)

The code you're deploying has the login, the database, the read screens and the
non-blocking upload working. Still to build:

- the Gemini reading step inside the background queue
- the review-and-approve screen
- the Google Sheet mirror sync
- the doctor handout with expiring share links
- the one-time import of your existing records from the old Sheet and Drive

You can deploy now and I'll ship those as updates — because of the GitHub
connection, they deploy themselves and you don't have to do anything.
