# Family Medical Records — how it all fits together

A reference for future-you. Read the map first, then look up whichever piece
you need to change.

---

## 1. The map

Four accounts. Each does one job.

```
                          ┌─────────────────────────────┐
   YOUR PHONE / LAPTOP    │  fmr-v.cavishal5666         │
   ────────────────────►  │       .workers.dev          │
                          └──────────────┬──────────────┘
                                         │
                        ┌────────────────▼────────────────┐
                        │  CLOUDFLARE ZERO TRUST (Access) │
                        │  vishal-fmr-team                │
                        │      .cloudflareaccess.com      │
                        │  "Is this email allowed in?"    │
                        └────────────────┬────────────────┘
                                         │ signed JWT
                        ┌────────────────▼────────────────┐
                        │  CLOUDFLARE WORKER  "fmr-v"     │
                        │  The whole application.         │
                        │  Verifies the token, decides    │
                        │  what you may see, answers.     │
                        └──┬──────────┬────────┬──────────┘
                           │          │        │
             ┌─────────────▼──┐  ┌────▼─────┐  │
             │  D1 "fmr"      │  │ R2       │  │
             │  the database  │  │"fmr-docs"│  │
             │  every value,  │  │ the      │  │
             │  date, name    │  │ scans,   │  │
             │                │  │ encrypted│  │
             └────────────────┘  └──────────┘  │
                                               │
                        ┌──────────────────────▼──────────┐
                        │  QUEUE "fmr-ocr"                │
                        │  holds uploads waiting to be    │
                        │  read, so nothing blocks you    │
                        └──────────────┬──────────────────┘
                                       │
                        ┌──────────────▼──────────────────┐
                        │  GOOGLE AI STUDIO (Gemini)      │
                        │  reads the scan, returns values │
                        └─────────────────────────────────┘

   GITHUB  shan19297376/fmr-v  ──────► Cloudflare rebuilds on every commit
   (the code; no data ever lives here)
```

**The one sentence version:** GitHub holds the code, Cloudflare runs it, Access
guards the door, D1 holds the data, R2 holds the scans, and Gemini reads them.

---

## 2. What each account is for

### GitHub — `github.com/shan19297376/fmr-v`

The code. Nothing else. No medical data, no passwords, no keys.

**Why it exists:** Cloudflare watches this repository. Commit a file and a
rebuild starts within seconds. It's how updates reach you without you running
anything.

**When you touch it:** every time a file changes.

> Note there are two repos. `fmr` was the original; `fmr-v` is the copy
> Cloudflare made and the one it builds from. **Only `fmr-v` matters.** Delete
> `fmr` when convenient.

### Cloudflare — `dash.cloudflare.com`

Five separate things live here, all free at your volume.

| Thing | Name | What it does |
|---|---|---|
| Worker | `fmr-v` | The application. Everything runs here. |
| D1 | `fmr` | The database. Every test value, medicine, date, name. |
| R2 | `fmr-docs` | The scans, encrypted before storage. |
| Queue | `fmr-ocr` | The waiting room for uploads being read. |
| Zero Trust | `vishal-fmr-team` | The login wall. |

**When you touch it:** to add or remove who can log in, to change a secret, or
to read the logs when something breaks.

### Google Cloud — project `family-medical-records-507408`

**Now only holds a leftover OAuth client you no longer use.** When documents
were going to live in your Drive, this project authorised that. Since scans
moved to R2, nothing here is active.

**You can leave it alone.** Don't delete the project — the Gemini key is
associated with your Google account, not this project, but there's no benefit
to tidying and a small risk in it.

### Google AI Studio — `aistudio.google.com/apikey`

Issues the Gemini key that reads your documents. One key, stored as a Cloudflare
secret.

**When you touch it:** only if reading starts failing with a 401 or 403, which
means the key was revoked or rotated.

---

## 3. What happens when you upload a report

Worth understanding, because almost every problem shows up somewhere along here.

1. **You pick files and tap Upload.** The app asks the Worker to open a "job".
2. **Each file goes to the Worker one at a time.** The Worker hashes it, checks
   the hash against every document already filed (that's the duplicate warning),
   encrypts it with `DOC_ENCRYPTION_KEY`, and writes it to R2 under a random id.
3. **The Worker puts a message on the queue and answers you immediately.** This
   is why you can upload the next report straight away.
4. **A separate Worker run picks the message up.** It pulls the file back out of
   R2, decrypts it, and sends it to Gemini with instructions to transcribe and
   never interpret.
5. **Gemini returns structured values** — tests, medicines, diagnoses,
   follow-ups, bills, and the patient's name as printed.
6. **The Worker works out who it belongs to.** It compares the printed name
   against your family, handling titles and reordered names. No match, and it
   creates a new person and flags it for you.
7. **The job flips to "Ready to check".** Nothing is in your records yet.
8. **You review and tap File it.** Only now do rows land in the database, the
   timeline, and the trends.

**Where it can fail, and what it means:**

| Symptom | Almost always |
|---|---|
| Upload errors instantly | R2 bucket missing, or `DOC_ENCRYPTION_KEY` unset/too short |
| Stuck on "Waiting" | Queue consumer not deployed — check the last build succeeded |
| "Failed" with a Gemini error | Bad or expired `GEMINI_API_KEY`, or a model name that has moved on |
| "Failed" saying too long | A single PDF with too many pages. Split it. |
| Wrong person | Rename or merge from the person's chip at the top |

---

## 4. The four secrets

Worker → Settings → Variables and Secrets. All type **Secret**.

| Name | Where it came from | If it's wrong |
|---|---|---|
| `ACCESS_AUD` | Zero Trust → Applications → your app → Overview | Everyone is locked out |
| `GEMINI_API_KEY` | aistudio.google.com/apikey | Reading fails; everything else works |
| `DOC_ENCRYPTION_KEY` | You invented it. 32+ characters | **Scans become unreadable forever** |
| ~~`GOOGLE_CLIENT_ID`~~ / ~~`SECRET`~~ | Google Cloud | No longer used — safe to delete |

**`DOC_ENCRYPTION_KEY` is the one that can't be recovered.** The database
survives without it; the PDFs don't. It should be in your password manager.

There is also one plain variable in `wrangler.jsonc`, not a secret:
`ACCESS_TEAM_DOMAIN`, which must exactly match your Zero Trust team domain.
Change one without the other and every login is rejected with no useful error.

---

## 5. Controlling who gets in

Two layers, and they do different jobs.

**Layer 1 — Cloudflare Access decides who reaches the app at all.**
Zero Trust → Access → Applications → Family Medical Records → Policies →
`Family` → Include → Emails.

Add an email, they can log in. Remove it, they're out immediately, on every
device. This is your real access control.

**Layer 2 — the `app_users` table decides what they see once inside.**
The first person ever to log in becomes `owner` automatically — that's you.
Everyone after that needs a row, with a role:

- `owner` — everything, including deleting and merging people
- `member` — normal use
- `viewer` — read only

There's no screen for this yet. To add someone properly: put their email in the
Access policy, then add their row via
Cloudflare → Storage & Databases → D1 → `fmr` → Console:

```sql
INSERT INTO app_users (email, role, display_name)
VALUES ('someone@example.com', 'member', 'Their Name');
```

To limit someone to one person's records, set `scope_person_id` to that
person's id.

---

## 6. Making a change to the app

The loop is the same every time:

1. Edit the file on GitHub (`fmr-v`), or upload a replacement.
2. Commit.
3. Cloudflare rebuilds automatically — watch Worker → Deployments.
4. If the build fails, the log names the file and line.

**Adding a database column** needs a numbered migration file in `migrations/`.
They run in order and only once each. Never edit one that has already run;
add the next number instead.

**What lives where in the code:**

| File | Owns |
|---|---|
| `src/index.ts` | Login, permissions, all the API routes, the queue reader |
| `src/canonical.ts` | Test-name standardisation and unit conversion |
| `src/gemini.ts` | The prompt and schema sent to Gemini |
| `src/approve.ts` | Turning a reviewed extraction into filed records |
| `src/records.ts` | Editing, deleting, follow-ups, home readings |
| `src/events.ts` | Episodes of care |
| `src/handout.ts` | The doctor handout page |
| `src/export.ts` | The spreadsheet and the scans archive |
| `src/storage.ts` | Encryption, R2, file naming |
| `src/format.ts` | Dates. `dd-mmm-yyyy` is decided here and nowhere else |
| `public/index.html` | The entire app you see |
| `migrations/*.sql` | The database structure |

---

## 7. When something breaks

**Read the actual error first.** Worker → Observability → Logs. Reproduce the
problem in another tab and the entry appears within seconds.

**Login problems** are nearly always one of two mismatches: `ACCESS_TEAM_DOMAIN`
in `wrangler.jsonc` versus your real Zero Trust team domain, or `ACCESS_AUD`
versus the AUD tag on the application.

**Nothing deployed?** Check you edited `fmr-v` and not `fmr`.

**Data looks wrong?** Every edit is recorded in the `corrections` table with who,
when, before, after and why. Every significant action is in `audit_log`. Both
readable from the D1 console.

**Lost something?** D1 keeps 30 days of point-in-time restore. Storage &
Databases → D1 → `fmr` → Time Travel.

---

## 8. Getting your data out

Neither of these is stored anywhere; both are built on demand.

**Settings → Spreadsheet** — one .xlsx, eight sheets, filters and frozen
headers, numbers stored as numbers. Both the canonical test name and the name as
printed, so any value traces back to its report.

**Settings → All scans** — a zip foldered by person and year:
`Reena/2026/2026-03-11_Reena_Lab-Test_Dr-Lals-PathLabs_a1b2c3d4.pdf`

Take those two files and you can walk away from this app entirely. That was a
design goal, not an afterthought.

---

## 9. On your phone

Open the app in Chrome → ⋮ → **Add to Home screen**. It installs an icon and
opens full-screen with no browser bar. Your login lasts a month.

It is not in any app store and doesn't need to be.

---

## 10. Running costs

₹0 at your volume, and the headroom is large:

| | Free allowance | You use, roughly |
|---|---|---|
| Worker requests | 100,000/day | a few hundred |
| Database writes | 100,000/day | a couple of thousand on a busy day |
| Database size | 5 GB | megabytes |
| Scan storage | 10 GB | ~1–3 MB per scan |
| Background jobs | 10,000/day | a handful |
| People who can log in | 50 | 4–8 |

The only one worth watching over the years is R2 storage. At 2 MB a scan, 10 GB
is roughly five thousand documents.

## 11. Reminders and medicines

Two tables drive everything under **Due**.

`reminders` holds anything with a date attached. Rows arrive three ways:

- **From a filed report.** Any follow-up instruction with a due date becomes a
  reminder the moment you tap "File it".
- **From the nightly sweep.** The cron trigger looks 14 days ahead for open
  follow-ups and medicines about to run out, and creates or updates reminders.
  It is idempotent, so it cannot pile up duplicates.
- **By hand**, from the Add a reminder button, optionally repeating.

`medicines.status` is the honest bit. `active` means an end date says so or you
said so. `unknown` means the prescription printed no end date, and the app will
not claim it is current — it lists these separately and asks. That is why the
doctor handout no longer shows finished antibiotic courses as ongoing.

To change how far ahead the sweep looks, edit `refreshReminders` in
`src/care.ts`. To change when it runs, edit the cron line in `wrangler.jsonc`
(currently 21:30 UTC, which is 03:00 IST).

## 12. Bulk upload

On the Add screen, "These are separate reports" changes the behaviour:

- **Unticked** — every file is treated as pages of one report. Five scans of a
  six-page discharge summary go in as one record.
- **Ticked** — each file becomes its own job, read separately.
- **Ticked plus "Group them"** — the jobs share a `batch_id`, and the first one
  you approve creates an episode of care that the rest join. This is what you
  want when clearing a folder from one hospital admission.

The episode is named from the facility and date on the first report approved.
Rename it any time from Episodes.

## 13. Automatic filing

The default on the Add screen is **File them for me**. Drop ten documents from
the last two years and the app reads each one, works out whose it is, works out
which episode of care it belongs to, and files it. Nothing to fill in.

**How documents get grouped.** Each filed document looks for an existing episode
for that person within 14 days. Same facility widens the window to 28 days,
because a prescription, the lab report it asked for and the pharmacy bill are
typically days apart. A different facility keeps the narrow window, because two
hospitals in one fortnight are usually two different things. No match, and it
starts an episode named from the facility and date. These appear in Episodes
marked "grouped" so you can rename, split or merge them.

Change the window in `settings`:

```sql
UPDATE settings SET value = 21 WHERE key = "episode_window_days";
```

**When it refuses.** A document stops for review when the reader could not match
the name, could not read a date, got nothing out of the page, or flagged more
than three fields as unclear. Those sit in "Being read" with the reason showing.
This is deliberate: a report filed under the wrong person or with no date looks
like a record but is not one, and is harder to find later than one that never
got filed.

**Checking its work.** Everything filed automatically appears under "Filed
automatically" on the Add screen, newest first, with counts of what was
captured. Tap any row to correct or delete it. Every automatic filing is in
`audit_log` with action `auto_filed`.

**Categories** come from the reader: Prescription, Lab Test, Bill / Insurance,
Doctor Visit, Discharge Summary and the rest. They drive both the record type
and which folder the scan is named for in the export.

---

## 14. Vishal AI — the platform split

As of schema version 8 this is no longer one app. It is a shell with apps on it,
of which Family Health Records is the first.

**Tables have owners.** `core_` for anything a future app needs — people,
documents, jobs, reminders, audit, settings, access. `health_` for anything only
the medical app cares about — test results, medicines, episodes, panels. A table
name now tells you who owns it, so a second app cannot quietly couple itself to
the first.

**Routes match.** `/api/core/*` and `/api/health/*`. A URL tells you which app
owns the endpoint.

**The frontend is a shell plus modules.**

```
public/
  index.html      the frame: header, nav, main
  app.css         the design system, shared by every app
  shell.js        sign-in, launcher, routing, back button, people,
                  and the toolkit apps import (api, cache, sheet, dates)
  apps/
    health.js     screens only
```

`shell.js` owns navigation, the person switcher and the URL. `apps/health.js`
declares its screens and tabs in a manifest at the bottom of the file and
nothing else. It never touches the header or the router directly.

**Adding a second app** is one file shaped like `health.js`, one line in the
shell\u2019s `APPS`, one row in `core_apps`, and `health_`-style prefixes for any
tables it needs. No framework to learn, because there is no framework \u2014 just a
convention.

URLs are `#/health/tests?parameter=HbA1c`. The app opens whichever app you used
last; the launcher sits behind the avatar in the header.

**What was deliberately not built:** a plugin system, a config-driven app
registry, an abstraction layer for apps that do not exist. The seams are there;
the second app can decide what the framework should be, because the second app
always changes your mind about the first design.

## 15. Uploading, and the review queue

Four rows on the Add screen, nothing else:

| Row | What it does |
|---|---|
| **Files** | The scans. |
| **Whose** | Defaults to the person selected at the top. "Work it out from the documents" reads the name off each page instead. |
| **Episode** | Sort automatically, an existing episode, a new one, or leave ungrouped. |
| **Type** | **Bulk** \u2014 each file is its own document. **Individual** \u2014 all the files are pages of one document. |
| Date | Only used where a document has no readable date. |

**Your choice of person always wins.** If you say Vishal and a document clearly
reads a different name you already have on file, it is still filed under Vishal
\u2014 but it stops in Review with both names showing, so a misfile is visible rather
than silent.

**Review is permanent, not an error path.** Handwritten prescriptions, faint
photographs and old photocopies are normal, and they all land here with a badge
on the tab. The review sheet has two shapes:

- The reader got something \u2014 you check and correct the date, type, person and
  episode, then file.
- The reader got nothing \u2014 you fill in who, when, what type, which episode and a
  line about what it is. The scan is filed and findable. Structured values can
  be added later through the normal edit path if that document turns out to
  matter.

Either way "View scan" opens the original alongside, so you are never guessing.
