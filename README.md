# DISPATCH

Status dashboard and scheduled senders for three automated fiction email
drips, split out of Transmission so they're not blended with the album
release radar anymore:

- **Dionaea House** -- a found-footage email/SMS/forum-post drip
- **SCP Weekly** -- a sporadic weekly SCP Foundation digest
- **Ong's Hat** -- the Incunabula drip, 192 items, ~9 months

Same zero-install approach as your other apps: no local dev environment,
everything happens through the GitHub web UI and the Netlify dashboard.

## Step 1 -- Create the GitHub repo

1. On github.com, create a new repository. Name it whatever you want --
   `dispatch` is fine, or rename the whole concept, doesn't matter, nothing
   in the code depends on the repo name.
2. Upload every file from this folder into that repo through the GitHub
   web "Add file -> Upload files" flow, preserving the folder structure
   (`netlify/functions/`, `lib/`, `data/`, `content/`, `public/`,
   `scripts/`, plus `netlify.toml` and `package.json` at the root).

## Step 2 -- Connect it to Netlify

1. In the Netlify dashboard: Add new site -> Import an existing project
   -> connect to the GitHub repo you just made.
2. Build settings should auto-detect from `netlify.toml`
   (`publish = "public"`, `functions = "netlify/functions"`). No build
   command is actually needed since there's no bundling step -- the
   `echo` in `netlify.toml` is just a placeholder Netlify requires.
3. Deploy. This also automatically provisions the three scheduled
   functions and Netlify Blobs storage -- nothing extra to set up for
   either of those.

## Step 3 -- Environment variables

Site settings -> Environment variables. Add:

| Variable | Used by | Notes |
|---|---|---|
| `RESEND_API_KEY` | all three | same key you're already using |
| `DIGEST_FROM_EMAIL` | all three (fallback) | same sending address as before |
| `DIONAEA_TO_EMAIL` | Dionaea | falls back to `DIGEST_TO_EMAIL` if unset |
| `SCP_TO_EMAIL` | SCP | falls back to `DIGEST_TO_EMAIL` if unset |
| `ONGSHAT_TO_EMAIL` | Ong's Hat | falls back to `DIGEST_TO_EMAIL` if unset |
| `DIGEST_TO_EMAIL` | all three | shared fallback address |
| `DIONAEA_ACTIVATION_DATE` | Dionaea only, optional | ISO date e.g. `2026-08-01` -- day zero for Dionaea's schedule. Only needed if you want a *specific* start date. If you skip it, tapping "start chain" on the dashboard sets day zero to whatever day you clicked it. |

Everything else (cursor positions, next-send timestamps, send history,
whether a chain has been started) is tracked automatically in Netlify
Blobs -- no env vars needed for any of that.

## Step 4 -- Verify it's alive

Visit your new site's root URL -- that's the dashboard
(`public/index.html`), and it should load three cards, one per drip,
each showing "not started." That's expected on a fresh deploy: none of
the three chains send anything until you explicitly start them.

Every card has a **test next** button -- sends whatever item is
actually up next, for real, to your inbox, without touching any
schedule state. Safe to click as many times as you want, on any card,
started or not. Good first move: hit "test next" on all three before
starting anything, just to see the formatting land in your inbox.

When a card isn't started yet, it also has a **start chain** button,
with a confirmation prompt (since this is the one action that isn't
side-effect-free). Tapping it arms that drip -- the next scheduled
check will send its first real item, and every send after that
follows the normal pacing. Once started, the button disappears and the
card switches to showing its live progress meter, next-send date, and
recent history instead.

You can also do all of this by visiting the function URLs directly,
same as before:

- `https://your-site.netlify.app/.netlify/functions/dionaea-daily-check?list=1`
  then `?test_id=<id>`, or `?test_next=1`, or `?start=1`
- `https://your-site.netlify.app/.netlify/functions/scp-weekly?list=1`
  then `?test_url=<url>`, or `?test_next=1`, or `?start=1`
- `https://your-site.netlify.app/.netlify/functions/ongshat-check?test_index=<n>`,
  or `?test_next=1`, or `?start=1`

## Step 5 -- Remove the old copies from Transmission

In the Transmission repo, delete:

- `netlify/functions/dionaea-daily-check.js`
- `netlify/functions/scp-weekly.js`
- `netlify/functions/ongshat-check.js`
- `lib/buildEmailHtml.js`
- `lib/buildOngshatEmailHtml.js`
- `lib/denverTime.js` (only if nothing else in Transmission uses it --
  check first with GitHub's search-in-repo before deleting)
- `lib/fetchScpContent.js`
- `data/schedule.json`
- `data/scp-master-list.json`
- `data/scp-send-order.json`
- `data/ongshat-sequence.json`
- `content/` (the whole folder -- only Dionaea used this)
- `public/ongshat/` (the whole folder)
- `scripts/build-schedule.js`, `scripts/split-master-paste.js`,
  `scripts/generate-content-placeholders.js`

And in Transmission's `netlify.toml`, delete these three blocks:

```toml
[functions."scp-weekly"]
  schedule = "*/30 * * * *"
[functions."dionaea-daily-check"]
  schedule = "*/15 * * * *"
  included_files = ["content/*.txt"]
[functions."ongshat-check"]
  schedule = "*/30 * * * *"
```

Leave everything else in Transmission untouched -- the release-radar
functions, `lib/sendEmail.js` (Transmission still needs its own copy
for `weekly-digest`), and all the album/taste-profile data stay exactly
where they are.

## What the dashboard shows

Each card: how many have gone out vs. the total, a progress meter (once
started), the next scheduled send (date, time, and roughly how far
out), and the 10 most recent sends with their timestamps. A "test next"
button on every card, and a "start chain" button on any card that
hasn't been started yet. Refreshes on load, or tap "refresh." No login,
no build step -- it's a static page reading a JSON status endpoint.
