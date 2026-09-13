# Content Shrimp — Distribution Setup & First Test (plain-English guide)

This is the new "auto-posting" layer. It is **brand new and turned OFF**. Nothing about your
working app has changed. We add it carefully, test it on a throwaway account first, and only
turn it on when you've seen it work.

There are two parts:

- **Part 1 — First proof (do this first).** Post one harmless text post to a **test** social
  account, straight from your computer. **No deploy. No database needed.** This proves your
  Publer key works and our posting code works.
- **Part 2 — Database prep.** A bit of setup in Supabase so the app itself can post later.
  We do this *before* wiring it into the app — and I'll ask before any deploy.

A few words you'll see:
- **Publer** = the tool that actually posts to Instagram/Facebook/etc. We send it the content.
- **API key** = a secret password that lets our code talk to Publer. Keep it private.
- **Terminal** = the black "command" window (Terminal on Mac). You paste commands and press Enter.
- **Deploy** = pushing changes to the live website. We are **not** doing this yet.

---

## PART 1 — First proof: one text post to a TEST account (no deploy)

### 1.1 — Make a throwaway test account in Publer
1. In Publer, connect a social account you don't mind posting test junk to (a private/secondary
   Instagram, a test Facebook page, a personal LinkedIn — anything you can delete a post from).
   This is your **test account**.

### 1.2 — Get your Publer API key
1. In Publer go to **Settings → Access & Login → API Keys** (Publer API needs a **Business** plan).
2. Click **Create API Key**, tick the scopes **workspaces**, **accounts**, **posts**, create it,
   and **copy the key** (Publer only shows it once).
3. Keep that key in a note for the next steps. **Do not paste it to me** — you'll use it yourself.

### 1.3 — Open Terminal in the project folder
1. Open the **Terminal** app.
2. Type this and press Enter (this moves into your project folder):
   ```
   cd ~/boring-content-engine-deploy
   ```

### 1.4 — See your accounts (and copy your test account's id)
Paste this, but replace `PASTE_YOUR_KEY` with your real key, then press Enter:
```
PUBLER_API_KEY=PASTE_YOUR_KEY node api/_publish/test-publer-post.js list
```
**What you should see:** a list of your **WORKSPACES** and **ACCOUNTS**, each with a long id.
- Copy the **workspace id** you want to use.
- Copy the **id of your TEST account** (the one you're OK posting test junk to).

If you instead see an error about "Business", your Publer plan doesn't include API access yet.

### 1.5 — Post the test text post
Paste this, replacing the three CAPS parts (key, workspace id, test account id). Keep the quotes
around the message:
```
PUBLER_API_KEY=PASTE_YOUR_KEY PUBLER_WORKSPACE_ID=PASTE_WORKSPACE_ID node api/_publish/test-publer-post.js post PASTE_TEST_ACCOUNT_ID "Test from Content Shrimp 🦐 — please ignore"
```
**What you should see:** a `RESULT` block ending in `✅ Posted. Check your test account.`

### 1.6 — Confirm and tell me
Open your test account (or Publer's "Posted" list) and confirm the post appeared. Then tell me
**"first post landed"** (or paste the RESULT text — it contains no secrets). You can delete the
test post afterward. 🎉 That's the whole loop proven, with nothing deployed.

---

## PART 2 — Database prep (do before we wire it into the app)

This sets up the storage the app will use to remember connections and what's been posted. It does
**not** post anything and does **not** change your live app.

### 2.1 — Run the 3 new database files in Supabase
1. Open your project at **supabase.com → your project → SQL Editor**.
2. Click **New query**. Open the file `sql/brand-connections.sql` from the project folder, copy
   **all** its text, paste into the editor, click **Run**. You should see "Success".
3. Repeat for `sql/publish-jobs.sql`.
4. Repeat for `sql/brand-autopublish.sql`.
   *(Order matters: connections first, then publish-jobs, then autopublish.)*

**What this does, plainly:** creates three new tables — one to store which posting tools each brand
connected, one to record every post we make (so we can **never double-post**), and one for the
future auto-pilot switch (off by default).

### 2.2 — Create the public image bucket
1. In Supabase go to **Storage → Buckets → New bucket**.
2. Name it exactly: `published-media`
3. Turn **Public bucket** ON. Create it.

**Why:** when we post a picture (statement/carousel), it has to live at a public web address so
Publer can fetch it. This bucket is that home.

### 2.3 — Add one secret setting
1. Make a long random password (any ~40+ random characters). On Mac you can run in Terminal:
   ```
   openssl rand -base64 32
   ```
   and copy the output.
2. In **Vercel → your project → Settings → Environment Variables**, add:
   - Name: `APP_ENC_KEY`  — Value: the random text you just made.
3. While there, confirm `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` already exist (they do today).

**Why:** `APP_ENC_KEY` scrambles your saved Publer/WordPress passwords so they're unreadable even
inside the database. (These settings only take effect on the next deploy — which we will **not**
do until you say go.)

---

## What happens after Part 1 + Part 2

Once your first text post has landed and the database prep is done, the next steps (each with your
go-ahead) are:
1. A **private test deploy** (a temporary copy at its own link — your real site untouched) so the
   app's own "Publish" button can post. I will **ask first**.
2. First **image** post (we'll watch the Publer media step together — the one detail I flagged).
3. WordPress (drafts first). 4. Wix last.

Reminder of the safety rules in force: nothing posts publicly without you choosing it, the test
account comes first, the system can never double-post, and no deploy happens without your explicit
"yes."
