# Google Maps Setup — Instructions for PlastaGo

**Purpose:** allow the PlastaGo platform to show a map to drivers, resolve site addresses to precise locations, and order the stops on a run.

**Audience:** whoever manages PlastaGo's Google account and billing. No technical background needed.

**Time required:** approximately 20 minutes.

**Cost:** effectively nothing for normal use. One of the three APIs is free; the other two are charged per request and Google includes a monthly free allowance that covers a typical month's bookings. Section 8 caps the spend so a bug can never produce a surprise bill.

**What we need back:** two API keys. Section 9 has the exact values to send.

---

## 0. Before you start

**A credit card is required.** Google will not issue a working Maps key unless billing is enabled on the project — even for the free API. Steps in section 3 will not charge you, and section 8 puts a hard ceiling on the parts that can.

**Use a company Google account, not a personal one.** The project should outlive any individual. PlastaGo keeps ownership of the billing account and can revoke our access at any time; we only ever receive the key values.

**Two things we need to give you first:**

| We supply | Used in | If you don't have it yet |
|---|---|---|
| Your real web addresses | Section 3, step 4 | Use the two we suggest and tell us if they differ |
| The API server's IP address | Section 7, step 3 | Leave the restriction as **None** and tell us, so we set it before go-live |

---

## 1. What this is for, and what it is not

Three separate features depend on Google. They are being switched on in stages, but one setup covers all three — so it is worth doing once, properly.

| Feature | What it does | Status |
|---|---|---|
| **The driver's map** | Shows the route to the site *inside* the app, so the driver never leaves PlastaGo mid-run and lose the photo and weight prompts | Switching on now |
| **Finding the actual address** | Turns "Lot 42, 18 Ashworth Bvd, Kellyville" into a precise location, saved on the job | Switching on now |
| **Ordering the run** | Puts a run's stops into the shortest driving order | Ready for later |

**Why the third one has to wait.** Today a job is pinned to the *middle of its suburb*, not to the house. Kellyville is several kilometres across, so a driver can be well away from the site. Route optimisation cannot work at all on suburb centres — which is why precise addresses come first.

**Not requested:** access to any Google Workspace data, your email, your files, your calendar, or anything about your users. This is a metered map service and nothing else.

---

## 2. What you will end up with

**Two keys, not one.** They are deliberately separate.

| | Key 1 — Browser | Key 2 — Server |
|---|---|---|
| **Used by** | The driver's phone | Our API server only |
| **Google APIs** | Maps Embed API | Geocoding API, Route Optimization API |
| **Locked to** | Your web addresses | The server's IP address |
| **Cost** | Free | Charged per request |
| **Visibility** | **Public** — readable by anyone using the app | **Private** — treat like a password |

**Why they cannot be merged.** Key 1 is compiled into the app that runs on the phone, so it is public by definition. A single shared key would mean a publicly-readable credential that also holds permission to spend money. Two keys costs nothing extra.

---

## 3. Set up the project

1. Go to <https://console.cloud.google.com> and sign in.

2. Click the project dropdown at the top of the page → **New project**. Name it `plastago` → **Create**.

3. Wait for it to finish, then **confirm `plastago` is the project selected in the dropdown**. Everything below happens inside it.

4. Go to **Billing** → **Link a billing account**. Add a card and link it to the `plastago` project.

> A common failure is linking billing to a *different* project than the one holding the keys. If the map does not work later, check this first.

---

## 4. Create the browser key

1. **APIs & Services** → **Library** → search **Maps Embed API** → **Enable**.

   Enable only this one for now.

2. **APIs & Services** → **Credentials** → **Create credentials** → **API key**.

   A key appears in a popup, starting `AIza…`. **Copy it before closing the popup.**

3. Click **Edit API key**. Change the name to **PlastaGo — Browser**.

4. Under **Application restrictions**, choose **Websites** and add:

   ```
   http://localhost:*/*
   https://portal.plastago.com.au/*
   https://drivers.plastago.com.au/*
   ```

   Use your real addresses if they differ, and tell us what they are.

5. Under **API restrictions**, choose **Restrict key** and tick **Maps Embed API** only.

6. **Save.**

### ⚠️ Do not skip step 4

The browser key is visible to anyone who views the app's source. That is normal and safe **only because of this restriction**. Left unrestricted, someone could use your key on their own website and Google would bill you for it. Restricted to your domains, it is worthless to anyone else.

Confirm on the Credentials list that the key shows a restriction rather than "None". Changes take a few minutes to propagate.

---

## 5. Enable the two paid APIs

1. **APIs & Services** → **Library** → search **Geocoding API** → **Enable**.

   This is the one that turns a written address into a precise location.

2. **APIs & Services** → **Library** → search **Route Optimization API** → **Enable**.

   Enabling it now costs nothing — you are only charged when it is called, and nothing calls it yet. It saves a second trip through this process later.

---

## 6. Create the server key

1. **APIs & Services** → **Credentials** → **Create credentials** → **API key**. Copy it.

2. Click **Edit API key** and set the name to **PlastaGo — Server**.

3. Under **Application restrictions**, choose **IP addresses** and paste the server IP we gave you.

   If you do not have it yet, leave this as **None** and tell us — we will set it before go-live rather than leave it open.

4. Under **API restrictions**, choose **Restrict key** and tick **Geocoding API** and **Route Optimization API** — nothing else.

5. **Save.**

---

## 7. Confirm both keys exist

The Credentials page should now list exactly two keys:

| Name | Restrictions |
|---|---|
| PlastaGo — Browser | Websites · Maps Embed API |
| PlastaGo — Server | IP addresses · Geocoding, Route Optimization |

Neither should read "None" under restrictions, with the one documented exception in section 6 step 3.

---

## 8. Cap the spending

Two independent safety nets. Please set both.

### A hard quota ceiling

**APIs & Services** → **Geocoding API** → **Quotas & System Limits**

Find the daily request limit and set it to **500 per day**. That is far more than PlastaGo books in a day, and it means a bug or a misuse cannot run away.

### A budget alert

**Billing** → **Budgets & alerts** → **Create budget**

A monthly budget of **AU$50** with email alerts at 50% and 100% is a reasonable starting point.

### What the real cost should be

One address lookup per job booked. Google includes a monthly free allowance that covers a normal month's bookings, so the likely bill is **zero or a few dollars**. The cap exists for the abnormal month, not the normal one.

Google's pricing changes from time to time — check the current rates at <https://mapsplatform.google.com/pricing/> if you want the exact figures.

---

## 9. What to send back

These are the exact variable names the application expects. Fill in the values and send them to the development team.

```dotenv
# ── Key 1 · Browser ─────────────────────────────────────
# Goes in the web and driver apps.
VITE_GOOGLE_MAPS_EMBED_KEY=AIza...

# ── Key 2 · Server ──────────────────────────────────────
# Goes on the API server only. Treat as a password.
GOOGLE_MAPS_SERVER_KEY=AIza...

# ── Also tell us ────────────────────────────────────────
# The Google Cloud project name you used
GOOGLE_CLOUD_PROJECT=plastago

# The web addresses you allowed in section 4, if they
# differ from the two we suggested
ALLOWED_DOMAINS=portal.plastago.com.au, drivers.plastago.com.au

# Did you set an IP restriction on the server key?
SERVER_KEY_IP_RESTRICTED=yes / no
```

### ⚠️ Please do not send Key 2 by email or chat

The server key is a live credential. Send it through a password manager's secure share, or send Key 1 by email and Key 2 by a separate channel such as a phone call or SMS.

If it does go out in plain text, just say so — we will rotate it, which takes two minutes.

### Where each one is installed

| Variable | Which key | Installed in |
|---|---|---|
| `VITE_GOOGLE_MAPS_EMBED_KEY` | Key 1 · Browser | `apps/web/.env`, `apps/driver/.env` |
| `GOOGLE_MAPS_SERVER_KEY` | Key 2 · Server | `apps/api/.env` |

The last row is why the keys cannot be merged: anything named `VITE_…` is compiled into the app that runs on the phone.

---

## 10. Questions you may have

**What happens until the keys arrive?**
Nothing breaks. The driver's screen shows the written address, the lot number and an "Open in the maps app" button — which is how it works today. Jobs stay pinned to the suburb. The moment the keys are installed, the map appears and new bookings start saving precise locations.

**Will old jobs get precise locations too?**
Not automatically. Existing jobs keep the suburb pin they were booked with, because a job's record is deliberately frozen at booking. We can run a one-off backfill over open jobs if you want it — just ask.

**Can we use one key for everything?**
Technically yes, and we strongly advise against it. See section 2.

**Who should own the Google account?**
PlastaGo, not us and not an individual. You keep control of the billing and can revoke our access at any time.

**Is a suburb-level pin really a problem?**
It is fine for the dispatch board, which groups work by suburb anyway. It is not fine for a driver — the pin can be kilometres from the site. In a brand-new estate the lot number stays the most reliable identifier regardless, which is why it is printed *above* the map rather than below it.

**The map still is not showing after we sent the key.**
Usually one of three things:

1. Restrictions take a few minutes to propagate.
2. The domain in section 4 does not match the address the app is actually served from.
3. Billing is linked to a different project than the one holding the key.

Send us a screenshot of the Credentials page and we will spot it.

---

## 11. How to revoke access

At any time, in one step:

**APIs & Services** → **Credentials** → select the key → **Delete**.

The affected feature degrades to its no-key behaviour described in section 10. Nothing else in PlastaGo is affected.
