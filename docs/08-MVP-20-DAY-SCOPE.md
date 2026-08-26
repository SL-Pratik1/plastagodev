# The 20-Day MVP — Complete Scope Definition (Knowledge Base 08)

> ## ✅ SCOPE LOCKED — final agreed position
>
> | | |
> |---|---|
> | **Timeline** | **20 working days** (was 14) |
> | **Team** | **2 developers on web · 1 developer on mobile** |
> | **Features** | **35 of 51** agreed IN |
> | **Integrations** | **6** — Xero · Twilio · Google Maps · MS365 · MS365 Outlook · Mistral AI OCR |
> | **Authentication** | Email OTP · SMS OTP |
> | **Driver app** | ⭐ **Flutter native AND React PWA — both complete.** Resolves background GPS |
> | **Stack** | **MongoDB Atlas (Sydney) · Express · React + Vite · Flutter · BullMQ + Redis · Render** — see §6A |
>
> **What changed from the 14-day scope:**
> - ➕ **IN:** F22 (driver performance) · F43 (vehicle maintenance + rego) · F46 (preferred
>   pickup times, restored) · F53 (driver training records) · F65 (2-way reschedule)
> - ➕ **IN:** **I6 MS365 Outlook + I8 Mistral OCR** → the **automated PO-from-email pipeline**
>   moves from v1.1 into scope. This was the client's stated core pain
> - ➖ **OUT:** F27 (post-job follow-up emails) · F41 (driver job feedback) · F32 (customer
>   document upload)
> - ⬆️ **Restored:** M9.6 financial summary — the 20-day budget absorbs it
> - ✅ **Risk 7 resolved by decision:** native app for background GPS, PWA alongside it

> **What this document is:** the single end-to-end definition of what we will build, ship
> and put into production in 20 days — organised by **module** (the big things), with every
> **feature**, **integration**, **authentication method** and **user workflow** explicitly
> marked IN or OUT, described in plain language, and illustrated with a concrete example.
>
> **What it is for:** it is simultaneously (a) the scoping decision, (b) the build brief for
> the dev team, and (c) the basis of the conversation with Matthew Browne about what he is
> and is not getting on day 20.
>
> **The governing constraint, stated plainly:** this is **not** a greenfield build. It is
> the **replacement of a working TMS (TransVirtual) that has processed 5,079 jobs and
> currently invoices ~$55–65k per month**. On day 21 the business must still bill correctly.
> Every scope decision below is made against that constraint, not against the wish list.

---

## Table of contents

1. [The honest headline](#1-the-honest-headline)
2. [Terminology — clearing up three confusions in the brief](#2-terminology--clearing-up-three-confusions-in-the-brief)
3. [Go-live strategy: staged cutover](#3-go-live-strategy-staged-cutover)
4. [The three scope calls worth arguing for](#4-the-three-scope-calls-worth-arguing-for)
5. [The eight things that will blow the deadline](#5-the-eight-things-that-will-blow-the-deadline)
6. [The modules — what we are actually building](#6-the-modules--what-we-are-actually-building)
   - [M1 · Platform Foundation](#m1--platform-foundation)
   - [M2 · Admin & Office Console](#m2--admin--office-console)
   - [M3 · Allocation & Dispatch](#m3--allocation--dispatch)
   - [M4 · Driver App](#m4--driver-app)
   - [M5 · Customer Portal & Enrolment](#m5--customer-portal--enrolment)  ·  *incl. enrolment (ex-M11)*
   - [M6 · Pricing & Rate Card Engine](#m6--pricing--rate-card-engine)
   - [M7 · Invoicing & Finance](#m7--invoicing--finance)
   - [M8 · Notifications & Communications](#m8--notifications--communications)
   - [M9 · Reporting, Dashboards & Certificates](#m9--reporting-dashboards--certificates)
   - [M10 · Data Migration & Cutover](#m10--data-migration--cutover)
6A. [Technical architecture & stack](#6a-technical-architecture--stack)
7. [Scope summary — Features](#7-scope-summary--features)
8. [Scope summary — Integrations](#8-scope-summary--integrations)
9. [Scope summary — Authentication](#9-scope-summary--authentication)
10. [Scope summary — User Workflows (all 109)](#10-scope-summary--user-workflows-all-109)
11. [Out of scope — v1.1, v2 and drop](#11-out-of-scope--v11-v2-and-drop)
12. [Question register](#12-question-register)
13. [The 20-day plan — design lock, then two backends](#13-the-20-day-plan--design-lock-then-two-backends)
14. [How to present this to the client](#14-how-to-present-this-to-the-client)
15. [Cross-references](#15-cross-references)

---

## 1. The honest headline

**35 of 51 features, in 20 working days, with 3 developers.** That is now the agreed scope,
and it is materially more ambitious than the original 14-day cut.

The full original ask was 51 features × 7 personas × 8 integrations × 109 listed workflows,
plus a WYSIWYG report designer, plus migration of three years of data. What has been agreed is
a deliberate, negotiated subset — and the extra six days bought three things that were
previously deferred: the **AI PO-ingestion pipeline**, a **native driver app**, and the
**fleet/driver-compliance features** (F22, F43, F53).

What ships in 20 days is a complete, coherent product that:

1. **Replaces the six screens PlastaGo actually live in every day.** We know exactly which
   six, because they pinned them as favourites in TransVirtual: create a job, find a job,
   approve driver charges, action futile pickups, invoices, where are my drivers (`06-` §3).
2. **Delivers the two things TransVirtual cannot do** — a real customer portal, and
   automated recycling certificates.
3. **Bills correctly from day one**, validated against their own historical invoices before
   we switch anything over.

**Eleven modules. 35 of 51 features. 78 of 109 workflows.** Everything else is explicitly
deferred with a reason and a version number.

> ⚠️ **The honest read on capacity.** 20 days × 3 devs ≈ **60 developer-days**. The added scope
> (AI PO pipeline, native app, F22/F43/F53) is roughly **10–13 developer-days**, against
> **+18 developer-days** of extra capacity. It fits — but not loosely, and two items carry
> external dependencies we do not control: **Apple Developer enrolment** (Risk 8) and **OCR
> extraction accuracy** (Risk 9).

---

## 2. Terminology — clearing up three confusions in the brief

The feature list contains some wording that will cause the wrong thing to be built if taken
literally. Resolving these **reduces** scope while **increasing** what the client gets.

### 2.1 Two different apps, two different answers

**The decision is now split by audience** — and it is worth stating clearly because the brief
used "mobile app" for both.

| Surface | Build | Why |
|---|---|---|
| **Customer portal** (F21) | **PWA only** | Site supervisors will not install anything. Matt: *"I don't think anyone's going to install a PlastaGo app onto their phone — it's like a website that's phone compatible"* |
| **Driver app** | ⭐ **Native AND PWA** | **Background GPS.** Not reliably available to a PWA and effectively unavailable on iOS — and Troy is on an iPhone. The native build solves it; the PWA is the fallback and the fast-iteration path |

> **F21 specifically still means PWA.** The customer-facing "mobile app" is the portal (M5),
> mobile-responsive and installable to the home screen. **No native customer app.**

There is no need for a native iOS/Android app **for customers**, and building one would be a
mistake (app-store review alone can consume a meaningful slice of the sprint).

**What we build instead:** the **Customer Portal** (M5) as a **Progressive Web App** — a
mobile-responsive web application that a site supervisor opens in their phone browser and
can "Add to Home Screen" so it behaves like an app (own icon, full screen, no browser
chrome, works offline for viewing).

**Why this is better, not a compromise:**
- **Zero install friction.** A site supervisor receives an SMS with a link, taps it, logs in
  with a one-time code, and books a pickup. No app store, no password, no IT involvement.
- **Instant updates.** No release cycle, no users stuck on old versions.
- **One codebase** for desktop office users and phone-based site supervisors.
- The client's own spec already says **"v1.0 Progressive Web App"** on the cover page — so
  this matches their stated intent; only the F21 wording is loose.

**Therefore F21 is not a separate feature.** It is absorbed into M5.

**The driver app is the exception.** It ships as **both**: a native shell (for background
location, and for reliable camera/storage on older devices) **and** the same PWA underneath.
Both are **offline-first** — drivers work in greenfield estates with poor coverage. See M4 and
Risk 8 for the distribution mechanics.

### 2.2 "Feature" vs "Module" — how this document is organised

The 51-item feature list is flat, which makes it look like 51 separate things to build.
It isn't. Most items are **capabilities within a larger surface**.

For example, these seven "features" are all just *the Customer Portal*:

> F9 (customer portal) · F18 (view job history) · F21 (mobile app to submit requests) ·
> F26 (customer dashboard) · F28 (request urgent pickup) · F32 (submit documents) ·
> F46 (set preferred pickup times)

Building "the Customer Portal" once delivers all seven. This document therefore groups
everything into **10 modules**, each with a description of what the module *is*, followed by
its individual feature items with descriptions and examples.

### 2.3 Many "workflows" are the same screen viewed by a different role

The workflow list includes, separately:

> W65 — *Office Worker · tracking job delays and reasons*
> W108 — *Allocator · Track job pickup delays*
> W120 — *Allocator · tracking job delays and reasons*
> F30 / F54 — *tracking job delays / pickup delays and notifications*

These are **one capability** (delay reason capture and reporting) appearing four times.
Roughly **80 of the 109 listed workflows are permutations of ~30 real screens.**

**Do not treat the workflow list as a backlog.** Treated literally it triples the apparent
scope for zero added function. Section 10 maps every W-number to the module that delivers it.

---

## 3. Go-live strategy: staged cutover

| Phase | What happens |
|---|---|
| **Days 1–20** | Build · migrate · **run the pricing regression harness continuously** |
| **Day 20 — GO LIVE** | The new system becomes *the* system for intake, allocation, driver execution, customer portal, notifications and invoicing → Xero |
| **Days 21–34** | TransVirtual retained **read-only** as safety net and historical archive. Every invoice spot-checked in week 1 |
| **~Day 34** | TransVirtual cancelled |

**Why not kill TransVirtual on day 20:** it costs a few hundred dollars for a fortnight, and
it removes the single catastrophic risk — discovering an undocumented pricing rule *after*
cutover with no fallback and no way to bill. This is professional practice, not hedging, and
an operations director will respect it being said out loud.

---

## 4. The three scope calls worth arguing for

These are the three places where we should **push back on the brief**. Each one saves days,
and each one gives the client a better outcome than what they asked for. They should be
agreed **in writing before build starts**.

---

### Scope Call 1 — Split the invoice template requirement in two

**What Matt asked for**

> *"They also want to be able to create and maintain custom Invoicing Templates… sometimes
> even on a per-job basis."*
> *"Below is a screenshot of what the report designer looks like. **I don't need an exact
> replica of this, but being able to change and edit all the same things is important to
> us.**"*

The tool in that screenshot is **Stimulsoft Reports** — a full commercial banded report
designer with data sources, business objects, variables, functions, expression bands and
drag-and-drop layout. Rebuilding it is a product in its own right, not a feature.

> ### ⚠️ REVISED after Call 2 — Matt wants the opposite split
> An earlier version of this call recommended *"build resolution, defer authoring."*
> **Call 2 shows he wants close to the reverse** (`09-` §21):
>
> **On resolution — he does NOT want it:**
> > *"I **don't need this level of granularity** necessarily. Once we pick an invoice, we're
> > pretty much — most of our customers will comply."*
>
> **On authoring — he does, and he built the current templates himself:**
> > *"Will I be able to **edit the layout of my invoices** in this system?"*
> > *"This is obviously something **I've set up before all myself** just to suit our needs."*
>
> He also uses the same designer for **operational reports**, not only invoices.

**The revised split**

| Capability | Verdict | Rationale |
|---|---|---|
| **Template *resolution*** — priority + data filter | ⬇️ **SIMPLIFY to per-customer template assignment** | Matt explicitly doesn't need the granularity. **This is now cheaper than originally planned** — assign a template to an account, done |
| **Branding & content control** — logo, colours, company details, terms, bank details, footer, visible columns | ✅ **IN — 14 days** | Still the bulk of the real editing need |
| **Template *authoring*** — layout editing | ⚠️ **DECISION REQUIRED — see below** | Genuinely wanted. Full band designer is weeks |

**Three honest options for authoring, to put to Matt**

1. **Constrained editor** — logo, colours, company details, terms, bank details, footer text,
   visible columns, free text blocks. Covers most real edits. **~1–2 days.**
2. **We maintain templates for him** under the support plan he has already signalled he'll
   take: *"I'd probably be looking at [being] on that for at least six to 12 months."*
   **Zero build cost**, small ongoing cost, and he gets exactly what he asks for each time.
3. **Full band designer** — weeks. Not a 20-day item under any reading.

> **A dedicated session on this was already agreed on Call 2:** *"we're probably going to have
> some questions around this specific piece… we'll probably have a session to flesh that out
> closer to the time."* **Hold it before build starts.** This remains the largest scope risk
> (Risk 5) — just for a different reason than originally written.

---

### Scope Call 2 — Don't literally embed the app in the Simvoly website

**What Matt asked for**

> *"They've got an existing Website, can we 'bolt' this PWA onto their existing website?
> Shared User Credentials. 'All-in-one' experience. They don't want to re-build the website
> because it ranks quite high in the SEO space so they don't want to lose traffic."*

**The goals are all correct. The mechanism is not.**

Simvoly is a closed drag-and-drop website builder with **no API, no server-side hooks and no
session sharing** (`02-` §2). Its pages are client-side rendered. Genuinely embedding an
authenticated application inside it means iframes and cross-domain session hacks — fragile,
slow, and actively hostile to an offline-first driver app.

**What we do instead**

| Goal | How it's met |
|---|---|
| *Don't lose SEO* | The marketing site **stays exactly where it is**. Not one page touched. **Zero SEO risk** — strictly lower risk than modifying it |
| *All-in-one experience* | App at **`app.plastago.com.au`**, matching brand, fonts, colours and logo. Header and footer link both ways. To a user it is one product |
| *Shared credentials* | **Single sign-on across all surfaces** — customer portal, admin console, and **both driver builds (native + PWA)**. One identity, one login, one place to manage users |
| *Keep the booking page* | `plastago.com.au/book-a-pickup` **stays live as a public page** and gains two CTAs: *"I have an account → Book now"* and *"New to PlastaGo → Get started"* |

> **✅ RESOLVED.** On the earlier discovery call Matt floated replacing the site
> (*"hopefully we can replace the website"*, `[transcript 09:40]`) and Decoded replied *"we
> probably will rebuild the website."* **That position was superseded.** The later email of
> **14 Aug 2026** is explicit: *"They **don't want to re-build the website** because it ranks
> quite high in the SEO space so they don't want to lose traffic."*
>
> **The website stays. It is not in scope to rebuild it.** That is the cheapest, fastest and
> lowest-risk path, and it spends **zero of the 14 days** on a marketing site.
>
> **⚠️ Revised after review.** An earlier draft of this recommended **301-redirecting**
> `/book-a-pickup` to the portal. **That was wrong.** A 301 from a ranking content page to a
> login screen loses the content signal, mismatches search intent and raises bounce rate —
> and worse, it **deletes an inbound lead channel that currently works**. Today new
> prospects find that page and fill in the form; some of them convert. Keeping the page and
> branching it preserves both the SEO and the lead. See **M5 · A.1**.

**Bonus:** it also lets us kill the **dead Cognito form still being served on their
homepage** (`02-` §4) — a live defect nobody has noticed.

---

### Scope Call 3 — Keep TransVirtual read-only for two weeks after go-live

**What the brief implies:** build it, switch it on, done.

**What we should insist on:** a **two-week read-only overlap**.

**Why this is the right call**

- Their pricing has at least one rule we cannot see: **"Extra Load Time" is auto-generated
  by TransVirtual** with fractional quantities (`06-` §5). There may be others.
- Invoicing runs **daily** at ~7 jobs/day on **7-day payment terms**. There is no quiet
  window in their calendar and no slack in their cash cycle.
- The cost is trivial — a fortnight of subscription — against the cost of being unable to
  invoice.

**What to say to Matt**

> *"We'll keep TransVirtual switched on but read-only for two weeks after we go live. It
> costs you one more month's subscription and it means that if anything about your pricing
> behaves differently to what we've reproduced, you have a fallback and a reference. We'd
> rather spend a few hundred dollars than risk a week of your invoicing."*

---

## 5. The eight things that will blow the deadline

Named here so they are managed from day 1 rather than discovered on day 11.

---

### Risk 1 — Pricing must match TransVirtual exactly ⚠️ **HIGHEST**

**The risk.** Every invoice the new system produces must match what TransVirtual would have
produced, to the cent. A pricing engine that is 98% right is a business that cannot bill.

**Why it's dangerous.** Their rate model is a three-dimensional lookup
(`Customer → Rate Card` × `Freight Item` × `Zone`) with effective dating, tier fallbacks,
per-customer component overrides, two billing methods, nine additional service types (fixed
*and* percentage), and fractional quantities. Plenty of room for silent divergence.

**Mitigation — the single highest-leverage action in the whole project:**

> **Build a pricing regression harness on Days 6–8 — and never later than Day 10.**
> ⚠️ **It moves later than ideal because days 1–3 are frontend-only (§13.1).** That is an
> accepted trade, not an oversight — but it is now the tightest constraint in the plan, for two
> reasons:
> - **MongoDB provides no database-level integrity backstop** (§6A.3), so this harness is the
>   only guard on invoice correctness
> - It must be green before migration begins on day 16
> Export the last **200–300 completed jobs with their real TransVirtual invoices**. Feed each
> job through the new engine. **Diff line-by-line** against the real invoice.
> Target: **100% match** on base price, additional services, GST and total.
> Every mismatch is either a bug in our engine or an **undocumented rule in theirs** — both
> must be found in week 1. Keep it in CI permanently so pricing can never silently regress.

Cost: roughly half a day. It is the difference between "we replaced their TMS" and "we broke
their invoicing."

---

### Risk 2 — Undocumented rules, chiefly auto-generated "Extra Load Time"

**The risk.** The Additional Service Approvals queue shows a charge
`Created By: System | Qty 3.65 | Extra Load Time | Clarendon Homes`. A fractional quantity
generated by the system means **time-on-site beyond an allowance is being billed
automatically**, computed from driver timestamps — and we do not know the rule.

✅ **Partly answered by the transcript.** We now know where the duration comes from: Matt
described the driver flow as *"you hit **Arrived** … then at the end you hit **Complete Job**.
So the time between Arrived and Complete Job, **that's the logged time for that job**."*
`[transcript 30:46]`
✅ **Mechanism now identified from the tenant (§12.2 Q4): it is TransVirtual's *demurrage
(wait time)* feature.** `Ask Driver to Confirm Onsite` is ON, which locks arrival time and
starts the demurrage clock; `ClientMobileWarnDriverOnsite15min` is ON. The charge is flat-rate
$100, approval-required, single-use per consignment, and **not driver-raisable** — hence
*Created By: System*.

⚠️ **Still unknown: the free-time threshold and the unit** (per hour? per 15-min block?). The
3.65 quantity suggests hours. Not present in Global Setup — check the rate card's additional-
service override screen next, then ask Matt only if that fails.

**Consequence if missed:** that revenue **silently stops** at cutover. Nobody notices for
weeks because nothing errors — invoices just come out smaller.

**Mitigation.** Blocking question to Matt today: what triggers it, from which timestamps,
what's the free allowance, what's the unit. If unanswered by **Day 3**, ship it as
**manual entry** and flag it explicitly in the handover as a known deferral.

---

### Risk 3 — The m²/kg field convention has drifted over three years

**The risk.** TransVirtual is a freight system with no "area" field, so PlastaGo encode m²
into freight dimensions. The invoice screenshot shows `1,800 m²` stored as
`Length 1800 × 1 × 1` so that `Cubic = 1800`. But:

- **2026 invoices:** `Weight` = real kg, `Cubic` = m² ✅
- **Feb 2025 jobs:** `Weight` = 699/538/1485 (looks like m²), `Cubic` = 1 ⚠️
- **Mid-2023 jobs:** `Weight` = 0 or 636/800, `Cubic` = 0/1/2/3 ⚠️

**The meaning of the same two columns has changed at least twice.** A naive migration
produces garbage historical reporting and could mis-price.

**Mitigation.** Resolve the convention **per era and per customer** with Matt before
migration. This is also the strongest argument for the new schema having **first-class
`area_m2` and `weight_kg`** — see M1.

---

### Risk 4 — Photo migration volume is unknown

**The risk.** Three years of job photos exist. We do not know how many, how large, or
whether TransVirtual can bulk-export them. If it can only be done one job at a time through
the UI, 5,079 jobs is not a migration — it's a wall.

**Mitigation.** **Measure the photo export on Day 1**, before anything else.
✅ **The mechanism is now proven, not just promised:** four POD export rules are **live in
production** today (they are what email completion photos to customers), so the export
pipeline demonstrably works. What is *not* yet known is **volume and throughput** for a bulk
historical pull. Create an image-export rule against a date range and measure it. If a bulk
pull is impractical, history becomes **archive-only** — and we learn that on Day 1 rather
than in week two. See §12.2 Q2.

---

### Risk 5 — Scope creep through the template designer

**The risk.** "Custom invoice templates" is the kind of requirement that expands to fill
whatever time exists. It is unbounded by nature.

**Mitigation.** Get **Scope Call 1** agreed in writing before build starts: *resolution and
branding now, WYSIWYG authoring in v1.1.* If it isn't written down and agreed, it will
consume the sprint.

---

### Risk 6 — Day-21 intake collapse (customer enrolment, M5 Part 2)

**The risk.** Today the booking form is **public** and the account field is **free text** —
anyone can book. The new portal is **authenticated**. If existing site supervisors cannot
get in on the first morning, they phone the office. Multiply by every active site and
**intake collapses on day one**, regardless of how good the software is.

**Why it's dangerous.** This failure is **silent**. A supervisor who can't log in doesn't
file a bug — they ring the office, or they give up and put the board in a skip. The revenue
just doesn't arrive, and the project looks like a failure in week one.

**Scale of the problem:** **31 accounts active in the last 12 months**, with a site-contact
population likely in the low hundreds. Large enough to matter, small enough to solve.

**Mitigation — all in M5 Part 2:**
- **Pre-seed every known user** from TransVirtual contacts + 12 months of Cognito site-contact
  emails (M5 · C.1)
- **Invitation campaign at T-5, T-1 and T+1 days**, with activation rate tracked as a
  **go-live gate** (M5 · C.2)
- **Personally onboard the top five accounts** — they are 87% of revenue (M5 · C.3)
- **Unrecognised-booker verification queue for 30 days** — never lose a job because someone
  couldn't log in (M5 · C.4)
- **Keep `/book-a-pickup` public** as a branching page, not a redirect to a login wall
  (Scope Call 2, revised)

---

### Risk 7 — ✅ RESOLVED BY DECISION: native + PWA driver app

**The risk.** Matt asked directly `[transcript 42:05]`: *"Will it allow the GPS and stuff —
even when the app is not open, if they go back to their home screen, does it still allow the
GPS tracking?"*

**Background geolocation is not reliably available to a Progressive Web App, and on iOS it is
effectively unavailable — and Troy is on an iPhone.** Continuous location with the app closed
requires a **native app**, which means an app-store build and review cycle that does not fit
inside 14 days. (It also conflicts with Matt's other requirement: *"I don't really want other
people to be able to download it"* — a PWA distributed by invite link actually satisfies that
better than a public store listing.)

**Mitigation — this is exactly why M4.2 captures GPS on status events:**

| | PWA (v1) | Native (v1.1 if needed) |
|---|---|---|
| GPS at Acknowledged / En route / **Arrived** / Complete | ✅ | ✅ |
| Verifiable arrival time + location per job | ✅ | ✅ |
| ETA against run sequence | ✅ | ✅ |
| Live moving dot with the phone in a pocket | ❌ | ✅ |

> ### ✅ DECIDED: build both, in full.
> **Flutter** for native (proper background location, offline, camera) **and a complete React
> PWA** alongside. A dedicated mobile developer covers Flutter for the full 20 days; the PWA is
> built by the web devs off the same Day-3 confirmed design.
> **Cost and mitigations in §6A.4** — chiefly: the **offline sync protocol is specified once, in
> writing**, before either implementation starts.
>
> **This closes Q6 and removes the risk** — but it creates two new ones, below: **Apple
> Developer enrolment** and **dual-surface parity**.

---

### Risk 8 — 🆕 Apple Developer enrolment and iOS distribution

**The risk.** A native iOS app cannot be sideloaded from a website. Matt does **not** want it
publicly listed (*"I don't really want other people to be able to download it"*). So
distribution is TestFlight-internal or Ad Hoc — both of which require an **Apple Developer
Program membership ($99/yr)**, and enrolment involves identity verification that **can take
days and is entirely outside our control**.

| Route | Review | Public | Notes |
|---|---|---|---|
| **TestFlight internal** (≤100 testers) | **None** | No | ✅ Best fit. ⚠️ **Builds expire after 90 days** — someone must re-upload quarterly |
| **Ad Hoc** (≤100 devices/yr) | **None** | No | ✅ Works. Each device registered by UDID; new phone = rebuild |
| App Store | Full | **Yes** | ❌ Matt doesn't want it public |

**Android is simpler:** ship the APK from their own site. Play Protect warns on install, and
there is **no auto-update** unless we build an update check.

**Mitigation:**
- **Start the Apple enrolment on Day 1**, before any code. It is the longest external lead
  time in the project and it costs nothing to have it ready early.
- **Ship the PWA first** so the drivers are never blocked waiting on Apple.
- Decide TestFlight vs Ad Hoc early — TestFlight is easier to distribute, Ad Hoc avoids the
  90-day expiry treadmill.
- **Tell Matt about the 90-day TestFlight expiry now**, not in month four.

---

### Risk 9 — 🆕 AI PO extraction accuracy (I8 + I6)

**The risk.** The automated PO-from-email pipeline is the client's *stated core pain* — the
project overview opens with *"automating the receipt of purchase orders."* It is also the only
genuinely probabilistic component in the build. Builders' POs arrive as PDFs, scans, photos of
paper and email bodies, in dozens of layouts.

**Why it's dangerous.** An extraction pipeline that is 85% accurate and **silently wrong** on
the rest is worse than manual entry, because nobody checks it. A wrong PO number means an
invoice that bounces in the builder's AP system — the exact problem we were hired to fix.

**Mitigation — design for the failure case first:**
1. **Confidence thresholds with a human queue.** Above threshold, auto-create; below, route to
   an office review queue with the source document side-by-side. **Never silently guess.**
2. **Extract, then match.** Match the extracted account/site/reference against existing records
   rather than trusting free text. A PO that can't be matched goes to the queue.
3. **Keep manual PO entry (M2.10) as a first-class path**, not a fallback. It must work on day
   one regardless of the AI.
4. **Measure it.** Log extraction confidence and correction rate from the start so accuracy is
   a number, not an opinion.
5. **Test against real POs early** — ask Matt for 20–30 recent PO emails in week 1.

---

## 6. The modules — what we are actually building

Ten modules. Each section states **what it is**, **who uses it**, **why it matters**, then
lists its feature items with a description and a concrete example.

---

### M1 · Platform Foundation

**What it is.** The data model, identity system, permissions and audit trail that everything
else sits on. Not a screen — the thing that makes the other nine modules possible.

**Who uses it.** Nobody directly. Everybody indirectly.

**Why it matters.** Four decisions here are effectively irreversible after day 2. Getting any
of them wrong means a rewrite in month three, not a patch.

#### Feature items

**1.1 — Multi-brand model (PlastaGo / EasyLift / BrickGo)**
Brand is a first-class dimension on accounts, jobs, invoices, templates, email senders and
logos — not a setting.
> **Why now, not later:** this is **already real in production**. TransVirtual holds
> `EasyLift Recycling Invoice (KG)` and `(m2)` templates, and driver Troy Holm logs in as
> `troy@easylift`. BrickGo was registered under the same ABN in April 2026. Building
> single-brand and retrofitting is a rewrite of the invoicing layer.
> **Example:** a job for an EasyLift customer produces an invoice with the EasyLift logo,
> EasyLift ABN line and EasyLift email sender, while a PlastaGo job on the same day produces
> the PlastaGo version — automatically, with no user choice involved.

**1.2 — The party model: Account ≠ Builder ≠ Site ≠ Contact**
Four distinct entities, not one "customer".
> **Proven by production data:** *iPlasta Pty Ltd* is the **account** that gets invoiced;
> *Fowler Homes*, *GJ Gardner* and *King Homes* are the **builders** whose sites are being
> serviced. *Durnco Group Pty Ltd* is the account; *Mirvac* and *Sharwood* are the builders.
> **Example:** iPlasta books a pickup at a GJ Gardner site in Oran Park. The invoice goes to
> iPlasta on iPlasta's rate card; the job record shows GJ Gardner as the on-site builder;
> the site supervisor who gets the SMS is GJ Gardner's; and the Oran Park site accumulates
> its own history across 14 pickups over the life of the build.

**1.3 — `area_m2` and `weight_kg` as first-class fields**
Dedicated, correctly-typed, correctly-named columns.
> **Why:** TransVirtual has neither, so PlastaGo overload freight dimensions and the meaning
> has drifted twice (Risk 3). **Example:** a 1,800 m² job is stored as `area_m2 = 1800`, not
> as `length = 1800, width = 1, height = 1`.

**1.4 — Job numbering continues the existing sequence**
New jobs start where TransVirtual left off (currently ~61,300).
> **Why:** three years of consignment numbers are referenced in builders' AP systems, on
> paid invoices, and in every conversation with Clarendon and Domaine. Restarting at 1 breaks
> continuity with the people who owe them money. Invoice numbers likewise continue from
> ~104,100.

**1.5 — Role model and permissions**
Seven roles, mirroring their existing TransVirtual security groups so nothing has to be
re-learned: **SuperAdmin · Operations · OfficeStaff · Allocator · Driver ·
Customer-Administrator · Customer-Site Supervisor**.
> **Example:** a Customer-Site Supervisor at GJ Gardner can book and view their own site's
> jobs but cannot see pricing, other sites, or any other builder's work. Their
> Customer-Administrator can see all of their company's sites, jobs and invoices.

**1.6 — Audit log on every state change**
Who changed what, when, from what value to what value — immutable.
> **Why:** today a shared mailbox and shared page password mean **zero accountability**.
> **Example:** *"Who changed job 61402's ready date from 12 Aug to 19 Aug?"* → answerable in
> one click, with a name and a timestamp.

**1.7 — Retention & data residency**
7-year retention floor (their Privacy Policy commits to 7; RRO14 requires 6), Australian
data residency, Australia/Sydney timezone normalisation.
> **Note:** TransVirtual currently renders their timestamps in **NZST/NZDT**. All migrated
> timestamps must be converted, with daylight saving handled correctly.

**Workflows covered:** W1, W2, W3, W16, W17, W71 (partial)

---

### M2 · Admin & Office Console

**What it is.** The desktop web application the PlastaGo office team lives in. It replaces
TransVirtual's day-to-day screens — the ones they pinned as favourites.

**Who uses it.** Matthew Browne (Operations), office staff, admin.

**Why it matters.** This is the **parity module**. If this isn't at least as good as what
they have, nothing else matters — they won't switch. Everything else is upside; this is the
price of entry.

#### Feature items

**2.1 — Create a Job** *(their #1 daily screen)*
A single form to raise a pickup: account, builder, site, customer reference/PO, ready date,
service level, freight item, expected m², bag count, notes, photos.
> **Improvement over today:** account and site are **pickers, not free text**; the address is
> **geocoded with a map pin**; and the rate card resolves and shows the **expected price
> before saving**.
> **Example:** office receives a phone booking from iPlasta. They type "iPl" → select the
> account → pick an existing site or drop a new pin → enter the customer reference → set ready
> date → enter 855 m² → save. The screen shows **"Estimated $356.80 ex GST — Sydney zone,
> $220 service + 855 m² × $0.16"** before they commit.
> *(That figure is real: it is invoice 104071, reproduced to the cent by the published rate —
> see `07-` §5A.4.)*

**2.2 — Job List** *(their #2 daily screen)* — F6
Searchable, filterable list of past, present and future jobs: by status, account, builder,
driver, date range, suburb, zone, invoice state. Every job carries a **unique job number**
continuing the existing sequence.
> **Example:** *"Show me every unallocated job with a ready date in the next 3 days in the
> Newcastle zone"* → one filter set, immediately actionable.

**2.3 — Job detail record** — F4, F5, F7
The full record: all parties, the site, the timeline of status changes with timestamps and
actors, **m² and weight**, itemised charges, photos, documents, comments, exceptions and
linked invoices.
> **Per-customer capture config:** some accounts are **m²-only** (iPlasta, Fornari, Wisdom
> all record weight = 0); others capture **both** (Clarendon, Domaine). The form adapts.
> **Example:** open job 61328 and see: booked 3 Jul by *Domaine*, allocated to *Troy Holm*,
> arrived 09:14, marked **futile** at 09:21 with reason and two photos, $120 futile charge
> raised, awaiting office review.

**2.4 — Cancel & reschedule** — F38
Cancel with a reason code, or move a job to a new date, with the customer notified
automatically and the whole change audited.
> **Business rule from their own spec:** a customer may self-serve a date change **only if
> the job is not already on a run sheet**. After that it becomes an office action.

**2.4a — The SLA clock** 🆕
`target_date = customer's ready_date + 5 business days`.
> ✅ **Corrected by Call 2.** The website says "3 to 5 working days" *from the request*. The
> operative rule is different: *"they tell us they're ready from [a date] and **we need to pick
> them up within five business days of that time**"* `[C2 07:17]`.
> **Most jobs have no time**, only a date window. A **minority have a hard time window** —
> e.g. a traffic-control permit valid *"up until 12 o'clock"*. Model both.

**2.5 — Delay and exception reason tracking** — F30, F54
Structured reason codes (not free text) on every delay, futile, cancellation and
contamination, so they become reportable.
> **Example:** end of month shows *"14 delays: 6 × site not ready, 4 × access blocked,
> 2 × crane unavailable, 2 × weather"* — actionable, and chargeable where the customer
> certified otherwise.

**2.6 — Futile Pickup Review queue** *(their #4 daily screen)*
Every driver-marked futile pickup lands here with its reason, photos, GPS and timestamp.
Office reschedules or cancels — **either way the $120 futile fee applies**, exactly as Matt
described.
> **The critical change:** this queue **chases**. Ageing badges, a dashboard counter, and a
> daily digest email. Today TransVirtual has this exact queue and **one entry has sat
> unactioned since 28 August 2025** — a year, at $120.

**2.7 — Additional Service Approvals queue** *(their #3 daily screen)*
Charges raised by drivers (contamination, extra load time) queue for office approval before
they can be invoiced, with the driver's photo evidence attached.
> **Why it matters commercially:** ~2 contamination charges per week at $90 ≈ **$9k/year**
> flows through this queue. Several are currently weeks old and unapproved.
> **Example:** Troy marks the Domaine job contaminated and photographs the timber offcuts in
> the bag. Office opens the queue, sees the photo, approves. A $90 line is added and — if
> Domaine requires a PO — the charge moves to the *Awaiting PO* queue rather than blocking
> the main invoice.

**2.8 — Customer account management** — F29
Create and maintain accounts: customer code, ABN, brand, rate card assignment, PO policy,
capture configuration (m²-only vs m²+kg), payment terms, contacts and their notification
preferences, sites.
> **Example:** setting Wisdom Properties' account applies the *Wisdom* rate card, attaches
> their bespoke *"Fuel Levy – Wisdom"* ($20) additional service, and marks them m²-only.

**2.9 — Site / project register**
Reusable geocoded sites with lot number, access notes, gate hours, induction requirements
and crane availability, so they're typed once, not once per booking.
> **Why:** their booking form's placeholder literally pleads *"Please use both Lot and Street
> Number where possible"* — because drivers get lost in greenfield estates where street
> numbers don't exist yet. Real examples from their data: `Lot 1097 (#46) Allambie Circuit`,
> `Lot 3141 Pilaster Street`.

**2.10 — PO capture, attachment and enforcement** — W46, W48
Record a PO number against a job, attach the PO document, and enforce PO presence for accounts
configured to require one. **Manual entry remains a first-class path** — it must work
regardless of the AI pipeline.

**2.12 — ⭐ Automated PO ingestion from email** 🆕 — **I6 + I8**, W46
> ⬆️ **Moved into scope by the 20-day plan.** This is the client's **stated core pain** — the
> project overview opens with *"automating the receipt of purchase orders, job allocations and
> driver notifications."*

```
Builder emails a PO  →  monitored M365 mailbox (I6)
        ↓
Mistral AI Document AI OCR (I8)  →  extract: PO number · account · site/address ·
                                     reference · m² · dates · amounts
        ↓
Match against existing Accounts / Sites / Jobs
        ↓
   ┌────────────── confidence ≥ threshold ──────────────┐
   │  auto-attach to the job (or draft a new job)       │
   └────────────────────────────────────────────────────┘
   ┌────────────── below threshold / no match ──────────┐
   │  OFFICE REVIEW QUEUE — source document shown       │
   │  side-by-side with the extracted fields            │
   └────────────────────────────────────────────────────┘
```

**Design rules, driven by Risk 9:**
- **Never silently guess.** Below-threshold extractions go to a human queue, never straight
  through.
- **Extract, then *match*.** Resolve to real Account/Site records rather than trusting free
  text — an unmatchable PO is a queue item, not a new record.
- **Log confidence and correction rate** from day one, so accuracy is a measured number.
- **Manual entry (2.10) always available**, and the system must be fully usable with the
  pipeline switched off.
- 🆕 **Ask Matt for 20–30 real PO emails in week 1** to tune against actual layouts.

> **Example:** Clarendon emails a PO PDF at 4:47pm referencing *Lot 77 Britannia Road*. The
> pipeline extracts PO `29916613/096`, matches the site to an existing Clarendon job awaiting a
> PO, attaches it, and releases the invoice — with no human touch. A scanned photo of a
> handwritten PO from a small builder scores low confidence and lands in the queue for a
> 10-second confirmation instead.

**2.11 — Job documentation & comments** — W49, W56, W68
Attach documents to a job; internal and customer-visible comment threads.

**Workflows covered:** W8, W45, W46*, W47, W48, W49, W51, W52, W55, W56, W61, W62, W65, W67,
W68, W120, W122 *(*partial)*

---

### M3 · Allocation & Dispatch

**What it is.** The board where jobs get assigned to drivers and days, and run sheets get
produced.

**Who uses it.** The Allocator / Driver Manager (in practice, Matt or office staff).

**Why it matters.** With transport bundled into the price, every wasted movement is straight
margin loss. But with only **2 active drivers and ~7 jobs/day**, this needs to be *fast and
clear*, not clever.

#### Feature items

**3.1 — Allocation board** — W100, W101, W104
Drag-and-drop or click-to-assign view: unallocated jobs on one side, drivers × days on the
other. Reassign freely; the driver is notified instantly.
> **Deliberately manual.** Automatic assignment (F58/W109) is **out** — with two drivers,
> manual allocation is faster, safer and more transparent than a rules engine. Revisit when
> the fleet grows.

**3.2 — Run sheets** — F33, W100
The day's ordered job list per driver, viewable in the office and on the driver's phone,
printable, with addresses, references, contacts and notes.
> **Example:** Troy's Tuesday run sheet: 7 jobs, Oran Park → Catherine Field → Gledswood
> Hills, with lot numbers, site contacts and expected m² per stop.

**3.3 — Geocoding and map view** — I3 (Google Maps)
Every site geocoded with a confirmed pin; jobs plotted on a map so the allocator can cluster
by geography visually.
> **Scoped honestly:** this is **visual clustering to support human decisions**, *not*
> automated route optimisation (F19), which is v1.1. A map that shows six jobs in Oran Park
> and one in Newcastle is 80% of the value at 5% of the cost.

**3.4 — Driver availability view** — W111 (simplified)
A simple per-driver capacity/availability column on the board — who's working, who's off,
how many jobs they already have.
> **Not** the full driver-availability dashboard (F40), which is v1.1. With two drivers a
> column is sufficient.

**3.5 — Delay tracking** — W108
Jobs approaching or breaching their target date are highlighted on the board.

**Workflows covered:** W100, W101, W102, W104, W108, W111*, W120, W122

---

### M4 · Driver App

**What it is.** An **offline-first driver app shipped as BOTH a native build and a PWA**.
Replaces the TransVirtual mobile app (currently v1.6.4 on Troy's iPhone and James's Samsung
S23 Ultra). **One dedicated mobile developer for the full 20 days.**

| | Flutter (native) | React PWA |
|---|---|---|
| **Background GPS** (phone in a pocket) | ✅ **The reason it exists** | ❌ |
| Foreground GPS on status events | ✅ | ✅ |
| Offline queue, camera, photos | ✅ | ✅ |
| Install friction | TestFlight / APK | Just a link |
| Iteration speed | Build + distribute | Instant |
| **Distribution** | iOS: TestFlight or Ad Hoc · Android: APK from their site | Any browser, no install |

**Approved build approach: two implementations, one contract.** **Flutter** for the native app
(Drift local DB, `flutter_background_geolocation`) and **React + Vite + `vite-plugin-pwa`** for
the PWA. They share **no code** — they share the **OpenAPI contract** and a **written offline
sync protocol** (§6A.4, §6A.9).

> **Ship the PWA first.** Drivers are then never blocked waiting on Apple enrolment (Risk 8),
> and Flutter lands as the upgrade rather than a dependency.
> ⚠️ **Every driver feature is now a two-place change.** Keep a parity checklist (§6A.4).

**Who uses it.** Two drivers today. It must be excellent for them specifically.

**Why it matters.** This is where **evidence is captured** — and evidence is what turns
disputed charges into paid charges. It is also where every data-entry error becomes a
billing error.

**Design constraints (from `05-` §5):** drivers work outdoors, one-handed, in gloves, in sun
glare, in areas with poor mobile coverage. Big targets, few taps, **must work with no signal**
and sync when it returns. A driver app that fails offline is worse than paper.

#### Feature items

**4.1 — My run sheet & job details** — W35, W31, W38
Today's jobs in order, with everything needed on site: address with lot number, map/navigate
button, site contact with tap-to-call, customer reference, notes, expected m², access notes.
> **Example:** Troy taps job 3 of 7, sees "Lot 328 / 69 Horologium Road, Austral — gate code
> 4417, crane available 7–11am, contact Dave 04xx" and taps Navigate.

**4.2 — Status updates & GPS** — F45, F11, W26, W29, W36
Each status change captures a timestamp and GPS position automatically.
> ⬆️ **F11 is now FULL, not lite.** With the native shell, **continuous background location**
> is available — so the office gets a live driver map, and customers can get a real ETA
> (F26/M5.7). The PWA still captures location at each status event as the fallback.

> **The six statuses actually used in production**, across all 5,079 jobs (`06-` §2):
> `Assigned → DriverPickupAcknowledge → InTransit → Completed → AdministrationComplete`,
> plus **`PickupFutileCompleted`** as the exception branch. **We are not building a 20-state
> machine nobody uses.**
>
> ➕ **We add one: `Arrived` / On Site.** TransVirtual has no such status, but Matt's workflow
> depends on it — it is what triggers the Site Risk Assessment (M4.8) and it starts the job
> clock: *"the time between Arrived and Complete Job, that's the logged time for that job"*
> `[transcript 30:46]`. That duration is almost certainly the basis of the **Extra Load Time**
> charge (Risk 2).

**4.3 — Capture m² and weight** — F34, W30, W44
Simple numeric entry, large keypad, per-customer configuration so drivers only see the
fields that account requires.
> **Confirmed by the client's own spec:** *"real-time weight measurement during pickups
> (simple data entry of weights)"* — no scale integration, no hardware.
>
> **These are two different quantities, not two units** (`07-` §5A):
> - **`area_m2` = the size of the job** — board *installed* in the house, usually known
>   before the pickup from the builder's order. **This is what gets priced.**
> - **`weight_kg` = the waste actually recovered.** Measured on the day. Averages ~6.8% of
>   the installed board weight in their real data.
>
> Per-customer capture config: iPlasta, Fornari and Wisdom record **m² only**; Clarendon and
> Domaine record **both**.

**4.4 — Tip-off weight & end-of-run reconciliation** 🆕 — *the Allocator's "Review tip-off
weights" workflow*
At the end of a run the driver tips the whole load off at the facility and records the
**tip-off weight** — the weighbridge or docket figure — with a photo of the docket.
> **✅ Algorithm confirmed by Matt** `[transcript 14:20–17:45]`. **Not every job can be
> weighed** — that is the whole reason this exists:
> - **~60–70% of jobs are bagged** → weighed on a **crane scale**, driver types it in
> - **~30%+ are hand-loaded** → **cannot be weighed at all**; there is no bag to lift
>
> ```
>   tip_off_total_kg                       weighbridge, per run
> − Σ crane_scale_weight (bagged jobs)     actually measured
> ─────────────────────────────────────
> = remainder_kg
> ÷ count(hand-load jobs on that run)
> ─────────────────────────────────────
> = imputed_weight_kg  per hand-load job
> ```
>
> **Matt's own example:** 5 jobs, 3 bagged @ 200 kg, tip-off 846 kg →
> `846 − 600 = 246 ÷ 2 hand-load jobs = 123 kg each`.
>
> **Purpose — explicitly NOT billing:** *"This isn't really for invoicing. This is more for us
> to understand on the back end what the average weight is for our **costing**."* Plus audit:
> *"when I get the **bill at the end of the month for all the tip-offs**, I can audit that
> against what we recorded at the time."*
>
> **What it feeds — note that billing is *not* the main driver:**
> 1. **Diversion certificates (F52 / M9.5)** — the tonnes-diverted figure on the certificate
>    **is** this number. It goes into builders' Green Star submissions and must be defensible
> 2. **Mass balance** — evidences the *"100% recycling success rate"* claim, currently
>    unevidenced
> 3. **EPA RRO14** — quantity records, 6-year retention (`04-` §2.7)
> 4. **Driver accountability** — persistent variance is an operational signal
> 5. **Billing** — ✅ **explicitly not billing.** Matt confirmed weight is estimated *from* m²
>    for pricing; the measured kg exists to make that estimate better. This usefully de-risks
>    the whole feature
>
> **Deliberately simple in v1:** driver enters the tip-off figure + docket photo; the system
> applies the deduct-and-average rule; the Allocator gets a review queue with the variance.
> **No weighbridge hardware integration.**
>
> 🔎 **New question this raised:** they receive a **monthly bill for tipping**, which means
> tipping is a *purchased service* — sitting awkwardly against the website's *"our own
> recycling facility"*. Whose site is it? See `09-` §1.

**4.5 — Photos** — F7, F14, W28, W34
Multi-photo capture, automatically timestamped, geotagged and attached to the job. Queued
locally and uploaded when signal returns. **No limit on count** — Matt was explicit.

> **Their actual photo protocol** `[transcript 20:15–21:38]`:
> 1. Front of the site · 2. The pile **before** · 3. The pile **after** ·
> 4. The site **closed** · 5. *If it can't be closed* — **the cars still on site**
>
> That last one is pure commercial defence: *"a lot of the time we get **blamed for leaving
> everything open**, so we take evidential proof that this person was still here when we
> left."*
>
> **Typical 10 photos per job, sometimes 18–20.**
>
> 🆕 **Configurable required-photo prompts** — Matt asked for *"a prompt of [what's] in the
> photos that are required, and a space to put in any others."* So: a per-site or per-job
> checklist of required shots, plus free-form extras. Cheap to build, and it standardises the
> evidence that defends their charges.

**4.6 — Mark Futile + reason** — W27
One prominent button. Choose a structured reason (job not ready / no truck access / site
closed / crane unavailable / nobody on site), add photos, submit. Job routes to the office
review queue and a **$120 futile fee** is raised.
> **This is the money loop.** The customer certified at booking that the job was ready and
> accessible (`03-` §3). Photo + GPS + timestamp at the point of failure turns a disputed
> phone call into an invoice line that survives challenge.

**4.7 — Mark Contaminated** — W27, W32
Flag contamination with type, estimated extent and mandatory photo evidence. Raises a **$90
contamination charge** into the approval queue.
> **Improvement over today:** currently it's a binary flag. We capture *what* the
> contamination was and *how much*, so it becomes reportable and defensible — and so
> repeat-offender sites can be identified.

**4.8 — Site Risk Assessment, SWMS & pre-start** — F56, F14, W37, W41 ⚠️ *bigger than it looks*
Three related things:

**(a) Driver Pre-Start Checklist** — port their existing TransVirtual mobile form.
> Chain of Responsibility under the Heavy Vehicle National Law makes pre-start checks an
> operator obligation, not just a driver one (`04-` §2.10).

**(b) Site-Specific Risk Assessment + SWMS → builder's portal** — a **5-step workflow**, not a
checklist. Matt described it precisely `[transcript 28:16–30:14]`:
> ```
> Driver taps ARRIVED
>    ↓  Site Risk Assessment form POPS UP automatically
>    ↓  Driver completes it on the spot
>    ↓  Generate PDF:  page 1 = risk assessment
>                      page 2 = standard SWMS (versioned, "updated yearly")
>    ↓  Driver SCANS THE QR CODE ON THE SITE FENCE
>    ↓  Uploads the PDF to the BUILDER'S OWN PORTAL
>    ↓  Job proceeds
> ```
> **Required by some clients for every site, before the driver may start.**
> **Scope reality:** form engine + PDF generation + PDF merge + camera QR scanning + handoff
> to an external URL — and it must work **offline**, because the driver is standing at a
> fence. This is several features, and it is the largest single item in M4.

**(c) Ad-hoc site hazard logging** with photos.

**4.9 — Vehicle defect reporting** — F43, W33
Driver logs a vehicle problem with a photo; it notifies the office and lands against the
vehicle record in M9.7.
> ⬆️ **Now part of the full F43 feature**, not a stub — see M9.7.

**4.10 — Job notes on completion** ➖ **F41 now OUT of scope**
> **F41 (structured driver feedback flagged for office review) has been dropped.** A plain
> free-text note field on the job remains — drivers can still record *"bag was half buried in
> mud, needed 20 extra minutes"* — but there is no separate review-and-triage flow. The
> **Extra Load Time** charge is system-generated from on-site duration anyway (M6.7), so the
> commercial outcome is unaffected.

**4.11 — Push notifications** — F45, W36
New job assigned, job cancelled, job details changed, run sheet updated.

**4.12 — Offline-first sync**
Everything above works with no signal. Actions queue locally, sync automatically, and the
driver can see clearly what has and hasn't synced.

**Workflows covered:** W25, W26, W27, W28, W29, W30, W31, W32, W33*, W34, W35, W36, W37,
W38, W41, W44 — plus *Allocator · Review tip-off weights* (unnumbered in the brief), via M4.4

---

### M5 · Customer Portal & Enrolment

**What it is.** A **mobile-responsive Progressive Web App** for PlastaGo's customers. Two
levels of access: **Customer Administrator** (head office — sees everything for their
company) and **Site Supervisor** (sees only their own sites).

> **This is what F21 means.** Not a native app — a portal that works beautifully on a phone.
> See §2.1.

**Who uses it.** Site supervisors at builders and plastering contractors; head-office admins
at iPlasta, Domaine, Clarendon, Fornari, Wisdom.

**Why it matters — the commercial argument.** **Five accounts are 87% of revenue; one is
34%.** Losing iPlasta removes a third of the business. TransVirtual gives those customers
**nothing** — today their entire digital experience is a public tracking URL printed on a PDF
invoice. REGYP, the 19-year-old market leader, offers nothing either (`04-` §3).

> **This module is not an efficiency feature. It is a retention weapon aimed at five named
> companies, and it is the single biggest competitive differentiator in the build.**

**How this module is organised.** Two parts:
- **Part 1 — Using the portal** (items **5.1–5.15**): what a logged-in customer can do.
- **Part 2 — Getting in** (Journeys **A / B / C**): how a human ends up able to log in at all,
  plus the safety net for when none of the routes work. *(Previously module M11.)*

---

#### Part 1 — Using the portal

**5.1 — Book a Pickup** — F9, F21, W88
Authenticated booking with saved sites. Roughly **four fields** instead of today's seventeen,
because the system already knows who they are, what their sites are and what their rate is.
> **Before:** 17 fields, 13 mandatory, account name typed by hand on a building site in the
> rain, no validation (`03-`).
> **After:** pick site → ready date → expected m² → bags → confirm. Account, builder,
> address, contact and certifications all pre-filled and verifiable.

**5.2 — Job readiness certification** — W86
The three certifications (job ready / truck accessible / free of contaminants) captured
against a **named, authenticated user** with a timestamp — instead of a typed name in a text
box.
> **Why this matters:** when the driver arrives to a job that isn't ready, the futile charge
> is backed by *"David Chen, GJ Gardner, certified on 12 Aug at 14:32 that this job would be
> ready"* — not by an unverified string.

**5.3 — Site access information** — W87, W98
Supervisors maintain their own site access notes, gate hours, induction requirements, crane
windows and contacts.
> **Directly prevents futile pickups** — which are a cost to PlastaGo and an annoyance to the
> customer, so both sides are motivated.

**5.4 — Edit / reschedule a pickup** — F38, W97
Change the ready date **while the job is not yet on a run sheet**; after that, request a
change which routes to the office.
> This rule is taken verbatim from the client's own site map.

**5.5 — Request urgent pickup / change urgency** — F28, W89, W80
Flag a job as urgent; office is alerted and the job is highlighted on the allocation board.

**5.6 — Preferred pickup times** — F46, W92
Specify preferred windows or blackout times per site or per job.

**5.7 — Live job status & dashboard** — F26, W95, W38
See exactly where every job is: booked, allocated, driver on the way, on site, completed.
> **Replaces:** phoning the office to ask. Every one of those calls is a self-inflicted cost.

**5.8 — Job history** — F18, W77, W83, W99
Every past job with full detail, searchable and filterable by site, date and reference.

**5.9 — Completed jobs with photos** — W99
The full completion record: m², weight, driver, times, and **all site photos**.
> **Beats today's experience,** which is a `mydat.info` link printed on a PDF.

**5.10 — Invoices** — F8, W72, W73
View and download outstanding and paid invoices as PDF, with PO number and job reference.

**5.11 — Monthly reports** — F1, W74, W76, W78, W82
Self-serve monthly pickup volume reports per company and per site — the report PlastaGo
currently produces and sends manually.

**5.12 — Recycling certificates** — F52, W84
Download a Certificate of Recycling for a project, a period or a job. See M9.5.

**5.13 — Upload job documents** ➖ **F32 now OUT of scope**
> Customers email documents to the office as they do today; the office attaches them via
> M2.11. Revisit in v1.1 — the upload pipeline exists, so it is a small add later.

**5.14 — Site Supervisor management** — W70
Customer Administrators add, remove and manage their own site supervisors, and control which
sites each can see.
> **Removes PlastaGo from the loop entirely** on a task that currently means a phone call.

**5.15 — Account preferences** — F29, W71, W81
Update company details, contacts and notification preferences.

**Workflows covered by Part 1:** W70, W71, W72, W73, W74, W75, W76, W77, W78, W80, W81,
W82, W83, W84*, W85, W86, W87, W88, W89, W91, W92, W95, W97, W98, W99

---

#### Part 2 — Getting in: enrolment & onboarding

> **Merged from what was previously M11.** Enrolment is the front door to this portal, so it
> belongs here rather than in a module of its own.
>
> **Why it exists:** the original scope defined an authenticated portal without defining
> **how anyone gets into it**. Today PlastaGo's front door is wide open — the Cognito form is
> public and "Your Account" is a free-text box. Replacing that with a login wall, without
> designing the way in, would **silently strangle intake on day 21**.
>
> This part is **not optional**, and §7 explains what it displaces to pay for it.
> Journey items keep their `A.x / B.x / C.x` labels (referenced elsewhere as **M5 · A.1** etc.).
>
> ⚠️ **Two of these three journeys are not literally "portal" screens** — say so plainly when
> planning the build:
> - **Journey A** (lead capture → onboarding queue → convert to account) is built in the
>   **admin console (M2)**; only the public enquiry form is customer-facing.
> - **Journey C** (pre-seeding users, invitation campaign) is executed as part of
>   **migration & cutover (M10)**.
> - **Journey B** is the only one that is purely portal.


> **Added after review.** The original scope defined an authenticated portal without
> defining **how anyone gets into it**. Today PlastaGo's front door is wide open — the
> Cognito form is public and "Your Account" is a free-text box. Replacing that with a login
> wall, without designing the way in, would **silently strangle intake on day 15**.
>
> This module is **not optional**, and §7 explains what it displaces to pay for it.

**What Part 2 is.** The three distinct paths by which a human ends up able to book a pickup —
plus the safety net for when none of them work.

**Who uses Part 2.** Prospects, existing customers' site supervisors, PlastaGo office staff.

**Why Part 2 matters.** Intake is the top of the revenue funnel. Every point of friction here is
either a lost job or a phone call to the office — and reducing phone calls is the outcome
Matt will actually judge the system by.

##### The three journeys — they are genuinely different problems

| | Journey | Volume | Right answer |
|---|---|---|---|
| **A** | **New company** → new account | **~1.6/month** (53 accounts in 38 months) | **Human-mediated.** It's a sales decision — rate negotiation, credit, terms. Do *not* automate |
| **B** | **New site supervisor** at an existing account | **High and continuous** — construction site turnover | **Frictionless self-enrolment.** This is where a login wall does the damage |
| **C** | **Existing users at cutover** | **31 active accounts**, one-time, **Day 20** | **Pre-seeded and invited before go-live** — a migration task, not a feature |

---

##### Journey A — New company becomes a customer

**Today:** they either phone 1300 395 438, or they fill in the public form with a made-up
account name and the office works out who they are. That second path means **leads arrive
disguised as jobs** — and some of them convert.

> **The trap to avoid:** if we simply lock the form behind a login, we don't just block bad
> bookings — **we delete an inbound lead channel that currently works**, on the page that
> ranks in Google. That would be a real commercial regression.

**A.1 — Keep `/book-a-pickup` public, and make it a branch**
The page stays exactly where it is on Simvoly, keeps its content and its SEO, and the dead
Cognito iframe is replaced with two clear paths:
- **"I have an account" → Book now** (deep link into the portal)
- **"New to PlastaGo" → Get started** (public enquiry form)

> **See Scope Call 2** — an earlier draft proposed a 301 redirect to the portal; keeping the
> page and branching it is strictly better for SEO *and* conversion, and preserves the lead.

**A.2 — Public enquiry form → creates a Lead, not a Job**
Company, contact, phone, email, typical volume, suburbs/region, expected frequency, how they
heard about PlastaGo. It creates a **Lead** record — deliberately *not* a job, because
nothing can be priced or scheduled until an account exists.
> **Example:** a new plastering contractor in Newcastle submits an enquiry at 9pm. It lands
> as a Lead, auto-acknowledged by email, and appears in the office's onboarding queue next
> morning with the Newcastle zone already inferred from the postcode.

**A.3 — Onboarding queue in the admin console**
Leads with status (new / contacted / quoted / won / lost), owner, and notes.
> **This is the first CRM capability PlastaGo has ever had** — and it's nearly free, because
> it's one more queue in a console that already has three. It also finally makes
> *"how many enquiries did we get and how many converted?"* answerable.

**A.4 — Convert Lead → Account wizard**
One flow: create the account, assign a rate card (named / Tier 1–4 / default), set PO policy,
capture configuration (m²-only vs m²+kg), payment terms, brand, contacts, first site — then
**send the invitation**.
> **Example:** Matt qualifies the Newcastle lead on the phone, agrees Tier 2 rates, clicks
> Convert, and the customer receives a welcome email with a link and their customer code
> before he's hung up.

**A.5 — One-off / prepaid jobs** ⚠️ *needs a decision from Matt*
Their data contains a **"PrePaid Customer"** account (5 jobs) and Recycling Near You lists
them as accepting **residential quantities**. There is a genuine casual segment — the long
tail shows ~26 accounts with fewer than 10 jobs ever.
> **v1 approach:** the public enquiry form handles these; the office books them against the
> existing "PrePaid Customer" account, as they do now. **No self-service one-off booking in
> v1** — it's 0.1% of volume and it needs payment handling.
> **This is the one place Stripe (I4) might genuinely earn its place** — see §8, where I've
> revised the reasoning behind dropping it.

---

##### Journey B — New site supervisor at an existing account ⭐ *the one that matters*

**This is the high-volume, high-risk journey.** Construction site supervisors change
constantly. If getting access is slower than the current "type your company name into a
public form", **they will phone the office instead and we will have made the problem worse.**

Three routes in, in order of how we expect them to be used:

**B.1 — Site booking link** *(expected to be the dominant route)*
Every Site carries a shareable link. Head office or PlastaGo sends it; the supervisor taps
it, enters their mobile, receives an **SMS one-time code**, and can immediately book **for
that site only**.
> **Why this fits construction:** links get shared in WhatsApp groups and site inductions.
> No app, no password, no invitation admin, no waiting.
> **Example:** Clarendon's contracts administrator pastes the Castle Hill site link into the
> site WhatsApp group. The new supervisor taps it, enters `04xx xxx xxx`, types the 6-digit
> code, and books a pickup — total elapsed time under a minute, on a phone, on site.

**B.2 — Join by customer code**
They already have customer codes — `IPL001`, `DOM001`. A supervisor enters the code plus
their mobile, verifies by SMS, and is attached to that account as a Site Supervisor.
> **Industry-familiar:** competitor REGYP already requires a **"Customer Code"** to deposit
> waste, so builders understand the concept.
> **Safety valve:** new joins can be set to require approval (by the Customer Administrator
> or PlastaGo) — configurable per account, because Clarendon may want control while a small
> contractor won't care.

**B.3 — Invitation by the Customer Administrator** — already in scope as **M5.14 / W70**
Head office adds supervisors directly and controls which sites each can see.
> **Best for organised accounts** (Clarendon, Domaine). Not sufficient on its own, because it
> depends on head office being responsive — which, at 4pm on a Friday, they aren't.

**B.4 — Email-domain auto-association** *(optional, per account)*
If a signup email matches a domain whitelisted on the account
(`@clarendonhomes.com.au`), auto-attach with Site Supervisor role.
> **Caveat, worth stating:** many site supervisors and subcontractors use personal Gmail
> addresses or only have a mobile. **This is a convenience, never the primary route** —
> which is exactly why B.1 and B.2 are mobile-first.

---

##### Journey C — Existing users at cutover ⚠️ *this is a go-live risk, not a feature*

**The failure mode:** Day 15, a Domaine supervisor goes to book a pickup, can't get in, and
phones the office. Multiply by every site. **Intake collapses on the first morning and the
project looks like a failure regardless of how good the software is.**

**C.1 — Pre-seed every known user before go-live**
Build the user list from two sources:
- **TransVirtual** — account contacts, and every distinct site-contact email on the last 12
  months of consignments
- **Cognito Forms** — every "Site Contact Email" submitted in the last 12 months

> **Scale is manageable:** 31 active accounts, and the site-contact population is likely in
> the low hundreds. This is a query and a mail merge, not a project.

**C.2 — Pre-cutover invitation campaign**
T-5 days: email + SMS to every seeded user — *"PlastaGo is moving to a new booking portal on
[date]. Here's your link. Nothing to install."*
T-1 day and T+1 day: reminders to anyone who hasn't activated.
> Track activation rate as a **go-live readiness metric**. If the top five accounts aren't
> activated, don't cut over.

**C.3 — Personally onboard the top five accounts**
iPlasta, Domaine, Clarendon, Fornari and Wisdom are **87% of revenue**. These get a phone
call and a walkthrough, not an email.
> **This is also the best sales moment of the whole project** — it's when they see the portal
> for the first time and realise nobody else in the industry offers it.

**C.4 — The safety net: unrecognised-booker verification queue** 🛟
For the **first 30 days**, someone who reaches the portal without a recognised account can
still submit a booking. It lands in a **verification queue** with a warning banner rather
than being rejected.
> **Design principle: never lose a job because someone couldn't log in.** An authenticated
> portal's characteristic failure is *silent* lost revenue — the customer doesn't complain,
> they just phone a competitor or throw the board in a skip. The queue makes that failure
> loud and recoverable.
> **Example:** a supervisor at a new GJ Gardner site books without a code. The job appears
> flagged "unverified booker"; the office recognises the site, links it to iPlasta's account,
> and the job proceeds normally. The supervisor is enrolled automatically as a side effect.

**C.5 — Office can always book on behalf**
Already in scope (**M2.1**). The phone line does not go away, and shouldn't — some
supervisors will always ring. The difference is the office now types it into a system that
prices, schedules, notifies and invoices automatically.

---

##### What we are deliberately NOT doing

| Not doing | Why |
|---|---|
| Self-service account creation with instant credit | Rates are negotiated and credit is extended. That's a business decision, ~1.6 times a month. Automating it adds risk and saves nobody time |
| Passwords | Site supervisors will not remember them. **OTP only** — email for office, SMS for site |
| Forcing head office to provision every supervisor | Depends on their responsiveness; would push people back to the phone |
| Keeping the Cognito form live "just in case" | Two intake paths = two sources of truth = the exact re-keying problem we're eliminating. **The verification queue (C.4) is the safety net instead** |

**Workflows covered by Part 2:** W8 (extended), W52, W68, W70, W71, W75, W81, W85 — plus the
previously-unmapped enrolment need behind the whole portal

---

### M6 · Pricing & Rate Card Engine

**What it is.** The engine that turns a completed job into a correctly-priced set of charge
lines. Invisible to users; the most consequential code in the system.

**Who uses it.** Nobody directly. It runs on every job.

**Why it matters.** See Risk 1. If this is wrong, the business cannot bill.

#### Feature items

**6.1 — Three-dimensional rate lookup**
`(Account → Rate Card) × Freight Item × Zone`, resolved at a point in time.
> Rate cards in production: *Clarendon and Domaine* (shared by two accounts), *Default
> Customer Rates*, *Tier 1–4*, *Test Customer*, *Wisdom Properties Group*.
> Resolution order: **named card → tier → default**.

**6.2 — Effective-dated rate schedules**
Rates are versioned with start and end dates; pricing a job always uses the rates in force on
that job's date.
> **Their current schedule runs 1 Apr 2026 → 1 Apr 2051.** Non-negotiable: reissuing or
> crediting a March invoice must use March's rates.

**6.3 — Two billing methods**
- **Variable:** `service charge (by zone) + (m² × rate per m²) + (bags × $30)`
- **Fixed price:** a flat amount per job, still varying by zone
> **Verified rates:** Sydney `$220 + $0.16/m²` · Wollongong `$250 + $0.18/m²` ·
> Newcastle `$250 + $0.20/m²`.
> **Worked example:** a 1,000 m² Wollongong job with 2 bags = `$250 + (1000 × $0.18) + (2 ×
> $30)` = **$490 + GST**.

**6.4 — Per-customer component overrides**
Matt's exact requirement: *"Different customers may have different rates for the service
charge or the weight charge component, and some customers have a fixed-price weight charge
instead of a variable one."* Each component is independently overridable.

**6.5 — Additional services — all nine, fixed and percentage**

| Charge | Rate | Type |
|---|---|---|
| Contamination Charge | $90.00 | fixed |
| Extra Load Time | $100.00 | fixed × qty (**fractional** — e.g. 3.65) |
| Fuel Levy | — | fixed |
| Fuel Levy – Wisdom | $20.00 | fixed, **customer-specific variant** |
| Fuel Levy (10%) | 10% | percentage |
| Futile Pickup | $120.00 | fixed |
| Out of Area | $2.00 | fixed × qty |
| Recycling Bags | $30.00 | fixed × qty |
| Tipping Fuel Levy (7.5%) | 7.5% | percentage |

**6.6 — Charge provenance and approval state**
Every charge records whether it was raised by a **driver** (needs approval), by the
**system** (auto-generated), or by the **office** (manual), and carries its approval state
and evidence.

**6.7 — Auto-generated Extra Load Time** ⚠️
Time-on-site beyond an allowance, computed from driver arrive/depart timestamps.
> **Rule currently unknown — see Risk 2.** If not answered by Day 3, ships as manual entry
> and is explicitly flagged.

**6.8 — Job margin view**
Income vs cost per job, reproducing the margin figure Matt reads today.
> Their current model applies a flat **$100 "Reporting Cost (Pickup Rate)"** per job and
> displays e.g. *"Nett Total (Profit Margin = 83.28%)"*. We reproduce this, and can improve
> it later with real per-vehicle cost.

**6.9 — Price check / preview tool**
Test a hypothetical job against any rate card without creating it — TransVirtual has this and
the office uses it for quoting.

**6.10 — Pricing regression harness** *(internal, but a deliverable)*
The Day 3–4 de-risking artefact from Risk 1, kept permanently in CI.

**Workflows covered:** underpins W8, W47, and all of M7

---

### M7 · Invoicing & Finance

**What it is.** Turning priced jobs into invoices, getting them to customers, and getting
them into the accounting system.

**Who uses it.** Office staff, Matt.

**Why it matters.** ~140 invoices/month, ~$470 each, **7-day payment terms**. This is the
cash cycle.

#### Feature items

**7.1 — Invoice generation** — F8
One invoice per job, generated on completion, numbered continuing from ~104,100.

**7.2 — The two-invoice workflow** — F10-adjacent, Matt's explicit requirement
Base invoice issued **immediately** on completion against the original PO. Additional charges
invoiced **separately, later**, once a new PO is received.
> **Matt's own words:** *"any additional charges require a separate PO, which can take time.
> So, to avoid delays in receiving payment for the actual job, we send the invoice for the
> job immediately upon completion and then send another invoice later for any additional
> charges once a PO is received."*
> **Example:** Job completes with a $90 contamination charge. Invoice A ($421.60) goes out
> that afternoon against PO `29916613/096`. The $90 moves to the **Awaiting PO** queue.
> Eleven days later Clarendon issues PO `29917104/012`; office enters it; Invoice B ($99 inc
> GST) is issued. Cash for the main job was never delayed.
> **Per-account rule:** accounts that don't require POs get everything on one invoice.

**7.3 — "Approved charges awaiting PO" queue**
The workflow that doesn't exist today, and where money currently leaks.
> Ageing visible, chase reminders, nothing forgotten.

**7.4 — Invoice template resolution** — Scope Call 1
The right template selected automatically by **type + priority + data filter**, exactly as
TransVirtual does it.
> **Example:** a Clarendon job resolves to *PlastaGo Recycling Invoice (kg & m2)* because
> Clarendon captures both; an iPlasta job resolves to *PlastaGo Recycling Invoice (m2 only)*.

**7.5 — Six shipped templates + branding control**
PlastaGo m² · PlastaGo kg & m² · PlastaGo m²-only · EasyLift m² · EasyLift kg · RCTI layout.
Self-service control of logo, colours, company details, payment terms, bank details, footer
and visible columns.
> All existing invoice content reproduced: ABN line, GBCA "Member 2026-2027" badge, direct
> deposit details (BSB 082-343, Acct 45 327 0863), 7-day terms, photo link, Meterage (m²) and
> Weight (kg) columns, customer reference / PO.
>
> 🆕 **A functional GAIN over TransVirtual, not just parity.** Matt: *"this system won't allow
> me to put quantities in here … in a perfect world I'd have **2 residential recycling bags at
> $30 each, equalling $60**, and then the weight charge at a rate of 16 cents per square
> metre."* `[transcript 18:08]`
> → Invoice lines must render **quantity × rate = amount**. TransVirtual cannot. Worth demoing.
>
> | Line | Qty | Rate | Amount |
> |---|---|---|---|
> | Service fee — Sydney | 1 | $220.00 | $220.00 |
> | Residential Recycling Bag | 2 | $30.00 | $60.00 |
> | Weight charge *(per m²)* | 1,000 | $0.16 | $160.00 |

**7.6 — PDF output** — F49
PDF individually and in bulk. **CSV is optional, not required.**
> ⬇️ **Simplified by Call 2.** *"Really, we do **PDF the majority of the time**… [CSV] is
> really rare, I've only come across that once, and we don't even service that customer any
> more."* `[C2 10:17]` Build PDF properly; add CSV only if asked.

**7.7 — Invoice list & bulk actions**
Search, filter by payment status and state, bulk approve, bulk send.

**7.8 — Xero integration** — F39, I1
**Push:** invoices and contacts to Xero. **Pull:** payment status back onto the invoice.
> **Scoped honestly as "2-way":** invoices out, payments in, contacts synced. **Credit notes,
> part-payments and bank reconciliation are v1.1.**
> **Immediate benefit:** their current invoice list shows payment status *"Unknown"* for
> several customers — the sync is only partly working today. Fixing that is a visible day-one
> win.

**7.9 — Customer payment history** — F39, W53
Per-account view of what's been invoiced, what's paid, what's overdue.

**Workflows covered:** W53, W72, W73, and the finance side of W8

---

### M8 · Notifications & Communications

**What it is.** The engine that proactively tells people things instead of waiting to be
asked.

**Who uses it.** Everyone — customers, drivers, office.

**Why it matters.** Matt will judge this system by **whether it reduces phone calls**. That
is the felt pain, even though the exception-evidence loop (M4) is the bigger financial win.
Build both; **demo notifications first.**

#### Feature items

**8.1 — SMS notifications** — F12, I2 (Twilio)
Job booked, allocated, driver on the way, completed, futile, rescheduled.
> **Example:** *"PlastaGo: your pickup at Lot 328 Horologium Rd is scheduled for tomorrow
> (Wed 19 Aug). Reply or log in to reschedule."*

**8.2 — Email notifications with photos** — F24
Completion confirmations including the job photos.
> ➖ **F27 (separate post-job follow-up emails) is now OUT of scope.** The completion email
> with photos already covers the customer touchpoint; a second follow-up added little.
> **This is a promise they already make** — their booking form says *"Job alerts and photos
> will be sent to this email address"* (`03-` §3). Today it's a URL on an invoice. We deliver
> it properly.

**8.3 — Upcoming job reminders + 2-way reschedule** — **F17 + F65**, W14
Automated reminder ahead of a scheduled pickup, prompting the site to confirm readiness —
**with a link that lets them reschedule in one tap if it isn't ready.**

> **The problem, in Matt's words** `[transcript 33:51–35:57]`: *"We get to some sites [and]
> the jobs aren't ready … Letting the site supervisor know — hey, remember your job's booked
> in for this day, is it ready? — would be a really good step to have, to avoid us going to
> site."*
>
> **His stated rules:** if they don't reply, **go anyway**. If they reply not-ready, they give
> a new date and the job reschedules.
>
> 💡 **The refinement worth proposing.** Matt framed this as *replying to an SMS* (F65, marked
> v2 — inbound SMS parsing is fiddly and ambiguous). **A tap-through link is cheaper and
> better:**
> > *"Job 61402 is booked for Wed 19 Aug. **Not ready? Pick a new date →**"*
>
> Opens the portal at that job's reschedule screen. No SMS parsing, no ambiguity, fully
> audited, identical for email and SMS.
>
> ✅ **F65 is now formally in scope** (the client's own list marks it *"nice-to-have v2"*, so
> treat the tap-through link as the committed implementation and true SMS-reply parsing as the
> stretch). **Matt's stated rules:** if they don't reply, **go anyway**; if they reply
> not-ready, they supply a new date and the job reschedules `[C2 33:51]`.
> **This directly attacks futile pickups — the most expensive failure mode in the business.**

**8.4 — Per-contact notification preferences**
Multiple contacts per account with roles (site / accounts / sustainability) and per-role
channel preferences.
> **Why:** today there is exactly one email — the site contact. The AP person who needs the
> invoice and the sustainability manager who needs the diversion data get nothing.

**8.5 — Driver push notifications** — F45
Covered in M4.11.

**8.6 — Office ↔ driver communication** — W50, W102
**Job-scoped comment threads** plus push notification, rather than a general chat product.
> **Scoped honestly:** full real-time chat (F20) is v1.1. With two drivers, comments on the
> job record plus a push notification covers the need and keeps the conversation attached to
> the job it's about — which is better than chat for auditability.
> ✅ **Matt confirmed the shape:** *"It's between the **office and the driver**"* — no
> driver-to-driver, no group channel. Office side = admin, allocator or office worker
> `[transcript 37:30–38:44]`.

**8.7 — Internal alerting on queues**
Daily digest and dashboard badges for the futile review, approvals and awaiting-PO queues.
> **This is the fix for the year-old unactioned futile pickup.** The system must chase.

**Workflows covered:** W5, W14, W50, W58, W102

---

### M9 · Reporting, Dashboards & Certificates

**What it is.** Fixed, well-designed reports and dashboards — **not** a custom report builder.

**Who uses it.** Matt, office staff, customers (self-serve).

**Why it matters.** Answers the five questions the owner currently cannot answer (`05-` §4).

#### Feature items

**9.1 — Monthly pickup volume report per customer** — F1, W4
Jobs, m², weight, charges, by month, by customer, by site.
> **Parity requirement.** They produce this today (`PlastaGo - Monthly Pickup Volumes`,
> `AIO`, and three versions of `Pickup Volumes`) and send it to customers. It must exist on
> day 20.

**9.2 — Daily pickup volume trends** — F2
Dashboard chart of jobs and m² per day.

**9.3 — Monthly volumes by zone** — F3
Sydney / Newcastle / Wollongong split.
> **Genuinely useful to them:** zone mix drives margin, because the rate and the drive
> distance both vary by zone.

**9.4 — Operations dashboard** — F15
Jobs by status, jobs at risk of breaching target date, futile rate, contamination rate,
completion times, unallocated jobs, queue counts.
> **Designed to answer, on one screen:** *"How many pickups are outstanding and which are
> about to breach?"*

**9.5 — Diversion Certificate** — F52, W15, W59, W84
Branded PDF certifying material diverted from landfill — **issued per job**, and also
available for a site, project or period. Generated automatically and emailed.
> ✅ **Matt named it and specified it** `[C2 18:03]`: *"Some customers reporting to **Green
> Building** Council or **NABERS** need a certificate for their site stating how much waste has
> actually been diverted… **I'd call it a diversion certificate**."*
> **Content, his words:** *"Your job of X amount of **square metres** had X amount of **waste**,
> and that has been successfully diverted from landfill."* → **both m² and tonnage.**
> **Cadence:** *"at the end of every job, a customer gets some sort of certificate"*, with the
> monthly report as supporting evidence.
> 🆕 **Blocked on a sample** — Decoded asked for one on the call so the data points are right.
> **Its headline number comes from M4.4.** The tonnes-diverted figure on the certificate is
> the **recovered weight**, reconciled against the tip-off weighbridge total — not the m²
> figure used for pricing. This is the strongest reason the tip-off reconciliation must be
> right: the certificate goes into a builder's Green Star submission and has to be
> defensible under audit (`07-` §5A).
> **The single highest-value differentiator in the build.** Their customers need auditable
> diversion evidence for **Green Star**, council **Waste Management Plans** and their own ESG
> reporting (`04-` §2.10). PlastaGo is a **GBCA member** and prints the badge on invoices,
> but has **no mechanism to issue the evidence**. Neither does TransVirtual. Neither does
> REGYP.
> **Example:** Clarendon's sustainability manager logs in and downloads *"Clarendon Homes —
> 1 Jul 2025 to 30 Jun 2026 — 412 pickups, 387,400 m², 168 tonnes diverted from landfill"* as
> a signed, branded PDF. That document is worth more to them than the recycling, and it is a
> switching cost no competitor currently matches.

**9.6 — Financial summary** ⬆️ **RESTORED to scope**
Revenue, additional services, margin by customer and by zone.
> Previously traded out to pay for enrolment. **The 20-day budget absorbs it.**

**9.7 — Vehicle register & maintenance** 🆕 — **F43**
Per vehicle: **odometer + expense log** → auto-calculated **cost per kilometre**. Plus a
**registration date with a 2-week reminder** that rolls forward on renewal.
> ✅ **Matt's exact spec** `[C2 01:10]`: *"At 49,000 km it went in for a service, what the
> service description was — A service, B service — and the price. What it ends up doing is
> calculating… **a cost per kilometre**."* And explicitly **not** wanted: *"I don't need all
> parts and labour and that breakdown. Keep it simple."*
> **Rego:** notify 2 weeks out; on renewal, log it and the date rolls forward by the registered
> period (12 / 6 / 3 months — configurable).
> **Why it matters now:** **4 of their 5 vehicles currently show service dates in the past**
> (`06-` §2). They have this module in TransVirtual and don't maintain it — so **the reminder
> is the feature**, not the register.
> Driver-reported defects (M4.9) land here.

**9.8 — Driver profiles, licences & training** 🆕 — **F53**
Per driver: **licence photo**, **white card**, **crane tickets** (class 3 / class 4), each with
an **expiry date** and an automated reminder.
> ✅ **Matt's spec** `[C2 19:42]`: reminder **1 month out**, and he preferred an
> **admin-managed licence-type register** — define the types once, set the lead time per type,
> apply against driver profiles. *"Yeah, something like that… I think that would be better."*
> **Compliance value:** Chain of Responsibility under the HVNL makes licence currency an
> operator obligation, not just the driver's (`04-` §2.10).

**9.9 — Driver performance metrics** 🆕 — **F22**
Jobs per day, on-site duration, futile rate, contamination rate, photo compliance, distance
travelled, SLA adherence — per driver, over time.
> **Now feasible because F11 is full** (M4.2) — continuous location gives real distance and
> drive-time data rather than estimates.
> ⚠️ **Two drivers.** Frame this as *operational insight and costing input*, not performance
> management — and say so when demoing it. Its real value is feeding the cost-per-km and
> job-duration models, which is where the money is.

**Workflows covered:** W4, W15, W59, W74, W76, W78, W82 — plus the *Data Analyst*
persona, whose needs are met by these fixed reports in v1 (a dedicated analytics workspace is
v1.1)

---

### M10 · Data Migration & Cutover

**What it is.** Getting three years of TransVirtual data into the new system and switching
over without breaking the business. **A module, not an afterthought.**

**Why it matters.** It is Risk 3 and Risk 4, and it is where fixed-deadline projects usually die.
**The extra six days exist partly to buy this room** — migration gets days 17–18, not an afternoon.

#### Work items

**10.1 — Prove the export on Day 1**
Before any build decision is locked, confirm TransVirtual can bulk-export consignments,
invoices, **photos**, accounts, rate cards and additional services.

**10.2 — Migration inventory**

| Object | Volume | Notes |
|---|---|---|
| Consignments (jobs) | **5,079** | 38 months |
| Accounts | **53 total** | **31 active** in last 12 months; top 5 = 87% of jobs |
| Invoices | thousands | |
| **Photos** | **~40–50k est.** | ⚠️ Biggest risk. ~8–10 per job × 5,079 ≈ 80–100 GB. **Prove bulk export Day 1** |
| Rate cards | 8 | + effective-dated schedules |
| Freight items | 19 (7 current) | Includes hook bins |
| Additional services | 9 | |
| Vehicles | 5 | |
| Users / drivers | 2 active, ~7 historical | |
| Templates | 16 | |
| Mobile forms | 1 | Driver Pre Start Checklist |

**10.3 — Resolve the m²/kg convention** (Risk 3) before transforming anything.

**10.4 — Timezone normalisation** — NZST/NZDT → Australia/Sydney.

**10.5 — Sequence continuity** — jobs continue from ~61,300; invoices from ~104,100.

**10.6 — Parallel-run validation** — the pricing harness, plus a reconciliation of migrated
totals against TransVirtual reports.

**10.7 — Cutover runbook and rollback plan** — including the two-week read-only overlap
(Scope Call 3).

**10.8 — UAT with Matt and both drivers** — Days 13–14. The drivers must physically use the
app on a real run before go-live.

---

## 6A. Technical architecture & stack

> **Status: APPROVED.** Final stack as agreed. Where a decision was contested during
> selection, the reasoning is recorded so nobody re-opens it later.

### 6A.1 The stack

| Layer | Decision |
|---|---|
| **Language** | **TypeScript** across web and API. Non-negotiable for AI-assisted codegen — types are what keep generated code coherent across ~40 screens and two client apps |
| **Database** | **MongoDB Atlas** — `ap-southeast-2` (Sydney). ⚠️ **Atlas, not DocumentDB** — transactions and change streams need a genuine replica set and full Mongo compatibility |
| **ODM** | **Mongoose + TypeScript** (Typegoose optional). ⚠️ **Not Prisma** — its Mongo connector is weakest exactly where this build needs strength: aggregation pipelines and multi-document transactions |
| **API** | **Express + TypeScript** — one service, plus BullMQ worker processes |
| **Web** | **React + Vite + TypeScript** |
| **Routing** | **React Router** *(TanStack Router if type-safe routes are wanted)* |
| **UI kit** | **Tailwind + shadcn/ui** — ⭐ the single biggest lever on the Day-3 target. Components are copied in and owned, not a black-box dependency, and they generate very reliably |
| **Grids** | **TanStack Table** — the client's entire mental model is grids; they are coming from jqGrid |
| **Data fetching** | **TanStack Query** |
| **Forms + validation** | **React Hook Form + Zod** — Zod schemas shared between web and API |
| **Charts** | Recharts |
| **Driver app** | ⭐ **BOTH, in full** — React PWA (`vite-plugin-pwa` + Workbox) **and** Flutter |
| **Queues** | **BullMQ + Redis** |
| **Object storage** | **S3 `ap-southeast-2` (Sydney)** — presigned direct uploads from the driver apps |
| **PDF generation** | **Playwright** (HTML→PDF) + **pdf-lib** for merging — see §6A.6 |
| **Auth** | OTP → short-lived JWT + refresh token. httpOnly cookie on web; **Keychain/Keystore on Flutter** |
| **Email / SMS** | **M365 SMTP** (I5) · **Twilio** (I2) |
| **Hosting** | **Render** (Singapore) — see §6A.2 |
| **CI/CD** | GitHub Actions — ⭐ **the pricing regression harness runs here** |
| **Error tracking** | ➖ **Removed by decision** — see §6A.8 |

### 6A.2 Hosting and data residency — the one thing to disclose

**Render has no Australian region.** Its regions are Oregon, Ohio, Virginia, Frankfurt and
Singapore; the closest to Sydney is **Singapore**. That matters because the client's Privacy
Policy commits to the Australian Privacy Principles and a 7-year retention floor (`02-` §6).

**The agreed split keeps all persistent data onshore:**

| Component | Location | Onshore? |
|---|---|---|
| **MongoDB Atlas** — all business data | `ap-southeast-2` **Sydney** | ✅ |
| **S3** — photos, PDFs (~80–100 GB) | `ap-southeast-2` **Sydney** | ✅ |
| Express API + BullMQ workers | Render **Singapore** | ❌ compute offshore |
| Redis — queue payloads *(transient)* | Render **Singapore** | ❌ transient only |
| Static web + driver PWA | Render CDN | — |

**Latency Sydney↔Singapore is ~90–100 ms** — irrelevant at 7 jobs/day.

> ⚠️ **Action, not a blocker:** their **Privacy Policy should disclose overseas processing**.
> It is a one-paragraph amendment under APP 8. Raise it with Matt proactively — far better than
> a builder's procurement team finding it during vendor due diligence.
>
> **If fully-onshore compute is ever required:** Fly.io and AWS (App Runner / ECS Fargate) both
> have Sydney regions. The application is portable; only the deploy target changes.

### 6A.3 ⚠️ Eight things that must be true for MongoDB to be safe

MongoDB was chosen over PostgreSQL. That is workable at this scale — transactions,
`Decimal128`, schema validators and the aggregation pipeline all exist. **But the database will
not enforce integrity for you, so these eight items are requirements, not suggestions.**

| # | Requirement | Why |
|---|---|---|
| **1** | **`Decimal128` for every monetary field** — rates, charges, GST, totals. **Never `double`** | The single highest-consequence line in the schema. GST and rounding must match TransVirtual to the cent (Risk 1) |
| **2** | **Atlas, not DocumentDB** | Transactions and change streams need a real replica set and full compatibility |
| **3** | **`withTransaction` sessions around invoice generation** | Job → charges → invoice → sequence increment must all commit or none do |
| **4** | **Collection-level `$jsonSchema` validators**, not only Mongoose schemas | Mongoose validates only writes that go *through* Mongoose. The DB validator catches everything else — belt and braces on financial collections |
| **5** | **One data-access layer; no ad-hoc queries** | Referential integrity now lives in application code, so it must live in **one place** — repository modules per aggregate, and nothing else touches the driver |
| **6** | **Compound indexes designed up front** | Two hot paths: effective-dated rate lookup `(rateCardId, freightItemId, zoneId, effectiveFrom)` and reporting `(accountId, completedAt)` / `(zone, completedAt)` |
| **7** | **Change Streams → append-only audit collection** | Satisfies M1.6. Genuinely nicer in Mongo than in SQL — take the win |
| **8** | **`$merge` rollup collections** for monthly volumes by customer and zone, recomputed nightly | Those reports are read constantly; don't re-aggregate thousands of jobs on every request |

> ### The structural consequence
> In a relational database, constraints would catch a whole class of integrity bug for free.
> Here **the test suite is doing that job.** So the **pricing regression harness stops being a
> nice-to-have and becomes structural** — Risk 1 gets *more* important, not less, and the
> harness must run on every commit from the moment the pricing engine exists.

### 6A.4 Two full driver apps — cost and mitigation

Both the React PWA and the Flutter app ship complete. Honest sizing:

| | Effort | Owner |
|---|---|---|
| **Driver PWA** | **~3–4 days** | Web devs. UI is nearly free after the Day-3 design lock — but the **offline queue (IndexedDB/Dexie + service worker), photo queue and sync conflict handling are not** |
| **Driver Flutter** | **~10–12 days** | Mobile dev (has 20) |
| **Shared sync protocol** | **~1 day, once** | Specified by one person, implemented twice |

**Flutter fits comfortably. The PWA is the pressure point** — it lands on the web devs on top of
the admin console, customer portal and enrolment.

**Two mitigations, both mandatory:**

1. **Specify the offline sync protocol once, in writing, before either implementation starts.**
   Operation log · idempotency keys · last-write-wins with server arbitration · explicit
   conflict cases · photo upload as a separate resumable queue.
   *Two implementations against one written contract is safe. Two implementations against a
   vague shared understanding is how they silently diverge.*
2. **Keep a feature-parity checklist** as a living test document. Every driver feature is now a
   two-place change, and the second place is the one that gets forgotten.

**What the PWA buys in return:** the day-one fallback while Apple enrolment clears (Risk 8), and
a driver whose phone dies can work from any browser.

### 6A.5 Repo shape

```
plastago-web/                   ← npm workspaces + Turborepo
├─ apps/
│  ├─ web/       admin console + customer portal  (one Vite app, role-based routing)
│  ├─ driver/    driver PWA                       (separate Vite app — service worker, offline shell)
│  └─ api/       Express + BullMQ workers
└─ packages/
   ├─ shared/    Zod schemas → single source of truth → generated OpenAPI
   └─ ui/        shadcn components shared by web + driver

plastago-mobile/                ← SEPARATE repo, Flutter
```

**Why two Vite apps and not three:** admin and portal share auth, session and most components,
so one app with role-based routing is simpler. The driver PWA is separate because the service
worker and offline shell need their own build configuration.

> ⚠️ **The consequence of a separate mobile repo:** the **OpenAPI spec becomes a published
> artefact**, not a shared file. Have the web repo's CI emit a **versioned spec** (and
> optionally a generated Dart client package) so the Flutter repo **pins a version** rather than
> chasing a moving target. Without this, two repos drift silently — it is the main risk of
> splitting them.

### 6A.6 One stack choice that changes scope: HTML-based PDFs

Invoices, Diversion Certificates and the SRA+SWMS pack are generated as **HTML+CSS rendered to
PDF** (Playwright), with **pdf-lib** merging the static SWMS page.

> ⭐ **This directly de-risks Scope Call 1.** Matt wants to edit invoice layouts, and his current
> tool is a binary banded report designer. Because our templates are **HTML+CSS**, a
> **constrained editor** — logo, colours, company details, terms, bank details, footer, visible
> columns, free text blocks — becomes a genuinely small feature instead of rebuilding
> Stimulsoft. **Choose this format for that reason, not only for rendering fidelity.**

### 6A.7 Express needs structure imposed on day 1

Express provides none, and AI-generated code drifts without a convention. Decide it once, write
it in the README, and generated code stays coherent:

- **`router → controller → service → repository`**, one folder per domain
- **Zod validation as middleware** on every route, sourced from `packages/shared`
- `helmet`, rate limiting, CORS allowlist
- A **central async error wrapper** — no unhandled promise rejections
- **Repository layer is the only code that touches Mongoose** (§6A.3 #5)

### 6A.8 No error tracking — the accepted gap and its mitigation

Error tracking was **removed by decision**. The honest consequence: **production failures are
invisible unless a human reports them** — and with two offline-first driver apps, the realistic
failure is a **silent sync failure** that nobody notices for days.

**Mitigation without adding a vendor:**
- **Structured JSON logs** from the API and workers, retained on Render
- **A sync-failure counter and last-successful-sync timestamp per driver device, surfaced on the
  admin dashboard (M9.4)** — so a stuck queue is visible in the product, not only in logs
- **BullMQ failed-job counts on the same dashboard** — dead-letter jobs must be seen
- Health endpoint + Render alerting on service restarts

> This is a deliberate trade, recorded so it is a known gap rather than an oversight. Revisit if
> silent sync failures actually occur.

### 6A.9 The API contract is a Day-3 deliverable

Because the frontend is built first against mock data (§13), **the API contract falls out of real
UI needs rather than being guessed.** Treat it as a first-class artefact:

- **Zod schemas in `packages/shared`** — the single source of truth
- **Generate OpenAPI** from those schemas
- **Flutter codegens its client from the OpenAPI spec** — this is the integration surface between
  the two ecosystems, and it is what makes a separate mobile codebase safe
- Mock with **MSW** during days 1–3 so the frontend is genuinely runnable at the demo
- **Freeze the contract at day 3.** Changes after that need a version bump, because two consumers
  depend on it

### 6A.10 Non-negotiables carried from the analysis

1. **Money as `Decimal128`.** Never floats. GST and rounding must match TransVirtual to the cent.
2. **`area_m2` and `weight_kg` as first-class typed fields** — never overloaded (Risk 3, M1.3).
3. **Effective-dated rate documents** with point-in-time resolution (M6.2).
4. **Append-only audit collection** fed by Change Streams (M1.6).
5. **Store UTC, render Australia/Sydney**; migration converts from NZST/NZDT (M10.4).
6. **7-year retention**; **all persistent data in Sydney** (§6A.2).
7. **Job and invoice sequences continue** from ~61,300 and ~104,100 (M1.4) — needs a transactional
   counter document, not a naive `$inc` race.
8. **Multi-brand as a first-class dimension**, not a config flag (M1.1).
9. **Presigned direct-to-S3 photo uploads** — never stream photos through the API.
10. **The pricing regression harness lives in CI and gates deploys** (Risk 1, §6A.3).

---
## 7. Scope summary — Features

### ✅ IN — the 35 agreed features

| ID | Feature | Module |
|---|---|---|
| F1 | Monthly pickup volume reports per customer | M9.1 |
| F2 | Daily pickup volume trends | M9.2 |
| F3 | Monthly pickup volumes by zone | M9.3 |
| F4 | Record and display m² and weight per job | M1.3, M2.3, M4.3 |
| F5 | Itemised job charges | M2.3, M6, M7.5 (qty × rate × amount) |
| F6 | Unique job numbers | M1.4, M2.2 |
| F7 | Link job photos to job records | M2.3, M4.5 |
| F8 | Generate invoices for jobs | M7.1 |
| F9 | Customer portal | **M5 Part 1** |
| **F11** | **GPS tracking — FULL, real-time driver location** ⬆️ | M4.2 *(native shell)* |
| F12 | Customer SMS notifications | M8.1 |
| F14 | Driver photo upload · Site Risk Assessment · SWMS PDF | M4.5, M4.8 |
| F15 | Admin dashboard — job completion times | M9.4 |
| F17 | Automated reminders about upcoming jobs | M8.3 |
| F18 | Customers view job history online | M5.8 |
| F21 | "Mobile app" for customers → **PWA portal** (§2.1) | **M5 Part 1** |
| **F22** | **Driver performance metrics** 🆕 | M9.9 |
| F24 | Real-time job completion notifications | M8.2 |
| F26 | Customer dashboard — real-time job tracking | M5.7 |
| F28 | Request urgent pickups / modify urgency | M5.5 |
| F29 | Manage customer accounts and preferences | M2.8, M5.15 |
| F30 | Track job delays and reasons | M2.5 |
| F33 | Driver schedules via Run Sheet | M3.2 |
| F34 | Weight entry during pickups | M4.3, M4.4 |
| F38 | Job cancellation and rescheduling | M2.4, M5.4 |
| F39 | Customer payment history — Xero 2-way | M7.8, M7.9 |
| **F43** | **Vehicle maintenance + cost/km + 2-week rego reminder** 🆕 | M9.7, M4.9 |
| F45 | Push notifications to drivers | M4.11 |
| **F46** | **Customers set preferred pickup times** ⬆️ *restored* | M5.6 |
| F49 | Invoices in PDF (+ CSV) | M7.6 |
| F52 | **Diversion Certificate** (PDF, emailed) | **M9.5** |
| **F53** | **Driver training / licence records + expiry reminders** 🆕 | M9.8 |
| F54 | Track job pickup delays and notifications | M2.5, M3.5 |
| F56 | Site-specific hazards / Site Risk Assessment | **M4.8** |
| **F65** | **2-way reschedule response for upcoming jobs** 🆕 | M8.3 |

**Plus, not on the client's list but required for parity or correctness:**
multi-brand support · party model · rate card engine · **tip-off weight capture &
deduct-and-average reconciliation (M4.4)** · futile review queue · additional service approvals
queue · awaiting-PO queue · two-invoice workflow · invoice template assignment · **qty × rate
invoice lines** (a gain over TransVirtual) · job margin view · price check tool · site/project
register · audit log · geocoding · **customer enrolment (M5 Part 2)** · data migration.

> ⚠️ **Customer enrolment (M5 Part 2) has no F-number but is non-negotiable.** Without it there
> is no intake on day 21 — the current booking form is public and the new portal is
> authenticated. See Risk 6.

### ➖ Dropped from the earlier 14-day scope

| ID | Feature | Why it went |
|---|---|---|
| **F27** | Post-job follow-up emails | The completion email with photos (F24) already covers the touchpoint |
| **F41** | Driver job-completion feedback flagged for review | A plain note field remains; Extra Load Time is system-generated anyway, so no commercial impact |
| **F32** | Customers submit job-related documents | Customers email the office as today; small add in v1.1 |

### ⛔ OUT — see §11 for reasons and versions

F10 (RCTI) · F13 · F19 · F20 · F27 · F31 · F32 · F35 · F40 · F41 · F55 · F57 · F58

---

## 8. Scope summary — Integrations

**Six agreed IN. Two dropped.**

| ID | Integration | Verdict | Scope |
|---|---|---|---|
| **I1** | **Xero** | ✅ **IN** | Push invoices + contacts; pull payment status. Credit notes, part-payments and bank rec → v1.1. ✅ Confirmed live (not MYOB): *"I'm not looking to replace Xero, I'm looking to interface with it"* |
| **I2** | **Twilio** | ✅ **IN** | SMS notifications + SMS OTP authentication |
| **I3** | **Google Maps Platform** | ✅ **IN** | Address autocomplete, geocoding, map pins, **live driver map** (now that F11 is full), driver navigation hand-off. **Not** route optimisation (F19 → v1.1) |
| **I5** | **Microsoft 365** | ✅ **IN** | **Outbound email via M365 SMTP** — replaces SendGrid at Matt's request. ⚠️ **Caveat to raise:** M365 SMTP is throttled (~30 msg/min, ~10k recipients/day) with weaker bounce handling than a dedicated provider. Fine at ~140 jobs/month, but a conscious choice |
| **I6** | **Microsoft 365 Outlook** | ✅ **IN** ⬆️ | **Inbound mailbox monitoring** for the PO pipeline (M2.12). Moved in from v1.1 |
| **I8** | **Mistral AI Document AI OCR** | ✅ **IN** ⬆️ | **PO extraction from email** (M2.12). Moved in from v1.1 — this is the client's stated core pain. ⚠️ **Risk 9** — must ship with confidence thresholds and a human review queue |
| ~~I4~~ | ~~Stripe~~ | ⛔ **DROPPED by the client** | Matt: *"a lot of our payments come through **direct deposit**… **I'm probably happy to take that requirement out**."* Payment is 7-day EFT against PO |
| ~~I7~~ | ~~Cognito Forms~~ | ⛔ **DROPPED — do not integrate** | We are replacing it. Two intake paths = two sources of truth. `/book-a-pickup` **stays as a public branching page** (Scope Call 2 / M5 · A.1) with the dead iframe removed |

**Also present but not on the list:** a **MYOB** account link exists in TransVirtual alongside
Xero. Confirm dead, then drop.

🆕 **A third system surfaced on Call 2:** a **separate CRM for proposals** (Matt: *"a separate
CRM that's f\*\*\*ing terrible"*). Portal-based proposals are **v2** — but identify the tool
now, since it may hold lead data and is a third subscription to retire. See Q34.

---

## 9. Scope summary — Authentication

| ID | Method | Verdict | Notes |
|---|---|---|---|
| **A1** | **Email OTP** | ✅ **IN** | Primary for office, admin and customer administrators |
| **A2** | **Phone / SMS OTP** | ✅ **IN** | Primary for **site supervisors and drivers** — the right choice for people on building sites who will never remember a password. Uses the Twilio integration already in scope |

**Also in scope:**
- **Single sign-on across all surfaces** — admin console, customer portal, **and both driver
  builds (native + PWA)**. This is what delivers Matt's *"shared user credentials"* requirement.
  ⚠️ **The native shell needs secure token storage** (Keychain / Keystore), not browser
  localStorage — a small but real addition for the mobile developer
- **Role-based access control** across the 7 roles (M1.5)
- **Single-tenant** architecture, per the client's spec
- **Session management**, device registration for drivers, and audit of all logins

---

## 10. Scope summary — User Workflows (all 109)

> **Note on the count.** The brief numbers workflows up to **W122**, but the numbering has
> gaps — there are **109 actual items**. Of those, **78 are IN** and **31 are OUT**.
>
> **Net effect of the 20-day scope change:** ➕ W103, W113, W115 come in with F22 and F43;
> ➖ W55, W58, W91 go out with F41, F27 and F32. **Total unchanged at 78.**
>
> **Read §2.3 first.** ~80 of the 109 are permutations of ~30 real screens. The IN count is
> high because one module satisfies many workflows at once — not because we are building 78
> separate things.

### ✅ IN — 78 workflows *(3 added: W103, W113, W115 · 3 removed: W55, W58, W91)*

**Administrator — 11 IN of 20**

| ID | Workflow | Module |
|---|---|---|
| W1 | Global Administrator | M1.5 |
| W2 | Manage user accounts | M1.5 |
| W3 | Configure system settings | M1, M2.8 |
| W4 | Generate monthly reports | M9.1 |
| W5 | Manage system notifications | M8.4 |
| W7 | Manage system integrations | M7.8, M8.1 |
| W8 | Manage customer accounts | M2.8 |
| W14 | Automated reminders for customers | M8.3 |
| W15 | Generate certificates of recycling | M9.5 |
| W16 | Configure user permissions | M1.5 |
| W17 | Manage system backups | M1.7 *(automated infrastructure, not a UI)* |

**Driver — 16 IN of 19**

| ID | Workflow | Module |
|---|---|---|
| W25 | Drivers (role) | M1.5, M4 |
| W26 | Log job completion | M4.2 |
| W27 | Report issues on site | M4.6, M4.7 |
| W28 | Take job photos | M4.5 |
| W29 | Update job status | M4.2 |
| W30 | Log pickup weights | M4.3 |
| W31 | Review job history | M4.1 |
| W32 | Provide feedback on job sites | M4.7 *(contamination assessment; F41 review flow dropped)* |
| W33 | Log maintenance issues on vehicles | M4.9 → **M9.7** *(now the full F43 feature)* |
| W34 | Upload job site photos | M4.5 |
| W35 | View upcoming job schedule | M4.1 |
| W36 | Receive real-time job updates | M4.11 |
| W37 | Log site-specific hazards | M4.8 |
| W38 | View real-time job status | M4.1 |
| W41 | Log job-specific hazards | M4.8 |
| W44 | Log recycling bag weight | M4.3 |

**Office Worker — 16 IN of 23**

| ID | Workflow | Module |
|---|---|---|
| W45 | Office workers (role) | M1.5 |
| W46 | Process purchase orders | M2.10 *(manual)* + **M2.12 ⬆️ automated AI extraction from email** |
| W47 | Generate job cards | M2.1 |
| W48 | Attach POs to job cards | M2.10 |
| W49 | Manage job documentation | M2.11 |
| W50 | Coordinate with drivers | M8.6 |
| W51 | Review job requests | M2.2 |
| W52 | Coordinate with customers | M8, M2.11 |
| W53 | Track customer payment history | M7.9 |
| ~~W55~~ | ~~Track job completion feedback~~ | ➖ **OUT — F41 dropped.** A plain note field remains |
| W56 | Manage job-related documentation | M2.11 |
| ~~W58~~ | ~~Automated follow-up emails post-job~~ | ➖ **OUT — F27 dropped.** Completion email with photos covers it |
| W59 | Generate certificates of recycling | M9.5 |
| W61 | Manage customer job request history | M2.2 |
| W62 | Manage job cancellation requests | M2.4 |
| W65 | Track job delays and reasons | M2.5 |
| W67 | Job cancellation and rescheduling | M2.4 |
| W68 | Assist with customer inquiries | M2.11 |

**Customer – Office Administrator — 14 IN of 15**

| ID | Workflow | Module |
|---|---|---|
| W70 | Site Supervisor management | M5.14 |
| W71 | Update customer information | M5.15 |
| W72 | View customer invoices | M5.10 |
| W73 | Review invoices | M5.10 |
| W74 | Access monthly reports | M5.11 |
| W75 | Manage customer job requests | M5.1, M5.7 |
| W76 | Review monthly reports | M5.11 |
| W77 | View historical job completion times | M5.8 |
| W78 | Request job completion reports | M5.11 *(self-serve)* |
| W80 | Manage job request prioritisation | M5.5 |
| W81 | Manage account preferences | M5.15 |
| W82 | Request job-specific reports | M5.11 *(self-serve)* |
| W83 | Manage customer job history | M5.8 |
| W84 | Request job-specific compliance reports | M9.5 *(recycling certificate; EPA reports → v1.1)* |

**Customer – Site Supervisor — 10 IN of 14**

| ID | Workflow | Module |
|---|---|---|
| W85 | Site supervisors (role) | M1.5 |
| W86 | Confirm job readiness | M5.2 |
| W87 | Provide site access information | M5.3 |
| W88 | Submit job request | M5.1 |
| W89 | Request urgent pickups | M5.5 |
| ~~W91~~ | ~~Submit job-related documents securely~~ | ➖ **OUT — F32 dropped.** Email to the office as today |
| W92 | Set preferred pickup times | M5.6 |
| W95 | Request job status updates | M5.7 *(becomes self-serve — no request needed)* |
| W97 | Request job rescheduling | M5.4 |
| W98 | Provide job site access updates | M5.3 |
| W99 | Request job completion feedback | M5.9 *(self-serve completion record)* |

**Allocator / Driver Manager — 11 IN of 18**

| ID | Workflow | Module |
|---|---|---|
| W100 | Allocate jobs to driver / create run sheets | M3.1, M3.2 |
| W101 | Review job assignments | M3.1 |
| W102 | Communicate with drivers | M8.6 |
| W104 | Reassign jobs | M3.1 |
| W108 | Track job pickup delays | M3.5 |
| W111 | Track driver availability | M3.4 *(simplified column)* |
| W120 | Track job delays and reasons | M2.5 |
| W122 | Job cancellation and rescheduling | M2.4 |
| **W103** 🆕 | Monitor driver performance | **M9.9** *(F22 now in scope)* |
| **W113** 🆕 | Manage and schedule vehicle maintenance | **M9.7** *(F43 now in scope)* |
| **W115** 🆕 | Track job-specific driver performance | **M9.9** *(F22 now in scope)* |

**Plus (from the client's PDF but unnumbered in the list):**
*Allocator · Review tip-off weights* → **M4.4** (capture + reconciliation) · M9.5 (feeds diversion certificates) — **IN**

### ⛔ OUT — 31 workflows *(+ W55, W58, W91 dropped above)*

| ID | Workflow | Version | Reason |
|---|---|---|---|
| W9 | Configure reporting settings | v1.1 | Fixed reports in v1; parameterisation later |
| W10 | Manage subcontractor job assignments | ❌ **REMOVED** | ✅ Matt: *"That can probably go, because it's a driver. **They're all subcontractors**"* `[C2 21:33]`. Ordinary driver allocation already covers it — it was never a separate workflow |
| W11 | Configure reporting templates | v1.1 | Template *authoring* — Scope Call 1 |
| W13 | Implement user feedback | — | A business process, not a software feature |
| W18 | Manage recycling centre capacity | v3 | Processing side not in scope |
| W20 | Configure automated job assignment rules | v1.1 | Only 2 drivers — manual is better |
| W22 | Configure customer support workflows | v1.1 | Ticketing not in v1 |
| W23 | Manage quality assurance processes | v2 | Undefined |
| W24 | Analyse customer feedback trends | v1.1 | Needs feedback capture (F13) first |
| W40 | Receive route optimisation updates | v1.1 | Needs routing engine (F19) |
| W42 | Receive real-time weather updates | v2 | Marked nice-to-have by client |
| W43 | Log fuel consumption | v2/v3 | Marked v2/v3 by client |
| W54 | Manage and track customer contracts | v2 | Marked v2 by client |
| W63 | Track job-specific compliance documents | v1.1 | Marked v2 by client |
| W64 | Track job-specific waste disposal locations | v3 | Marked v3 by client |
| W66 | Manage and track job-specific permits | v1.1 | Marked v2 by client |
| W69 | Manage customer feedback submissions | v1.1 | Needs F13 |
| W79 | Manage customer feedback submissions | v1.1 | Needs F13 |
| W90 | View real-time driver ETA | v1.1 | Marked "very-nice-to-have v2"; needs routing |
| W94 | Provide job site feedback | v1.1 | Needs F13 |
| W96 | Provide feedback on driver performance | v1.1 | Needs F13 |
| W107 | Optimise job allocation | v1.1 | Needs routing engine |
| W109 | Implement automatic job assignment | v1.1 | Only 2 drivers |
| W110 | Analyse job allocation efficiency | v1.1 | Needs routing data |
| W117 | Conduct site inspections | v2 | Not a software workflow as stated |
| W118 | Implement compliance training for staff | v2 | Not a software workflow as stated |
| W119 | Track job-specific waste disposal locations | v3 | Duplicate of W64 |
| W121 | Manage and track job-specific permits | v1.1 | Duplicate of W66 |
| — | **Data Analyst persona** (7 workflows in the PDF) | v1.1 | Needs met by M9 fixed reports in v1; a dedicated analytics workspace with custom report building (F31) is v1.1 |

---

## 11. Out of scope — v1.1, v2 and drop

### v1.1 — the immediate follow-on (weeks 5–8)

| ID | Feature | Why not in the 20 days |
|---|---|---|
| **F10** | **RCTI (Receiver Created Tax Invoices)** | ⚠️ **My earlier reasoning was wrong.** I said "zero active subcontractors" — in fact *"**basically all of our guys are subcontractors**"* `[transcript 23:59]`. It is still deferrable because Matt says *"we don't really use it at the moment, but we're **planning to**"* — but it is a **near-term need, not a distant one**. Mechanics now known: agreed **per-job rate**, jobs accumulate, **weekly** run, **exports to Xero as a BILL** (accounts payable), not an invoice. Driver pay rates should enter the data model early even if the RCTI run doesn't ship |

| **F13** | Customer service ratings | Client marked nice-to-have. Unblocks W24, W69, W79, W94, W96 |
| **F19** | **Route optimisation** | Client marked *"very-nice-to-have"*. **Geocoding + visual clustering ships in v1**, which is the prerequisite. 💡 **Reframe it for the v1.1 conversation:** the real driver isn't efficiency, it's **succession**. Matt: *"my allocator used to be a truck driver, he looks at a sheet of suburbs and he knows what to do … [but] he easily is 50, so in the future he may not be available"* `[transcript 36:44]`. F19 is knowledge capture for a single point of failure |
| **F20** | Office ↔ driver chat | Job comments + push notifications cover it for 2 drivers, and keep conversation attached to the job |
| **F31** | Custom report builder | A product in itself. Fixed reports in v1 |
| **F35** | **Recycling compliance tracking (EPA)** ⬇️ **moved v1.1 → v3** | ⚠️ **Corrected by Call 2.** I had this as legally-exposed and near-term. It isn't: *"the yard that we've got, **we don't operate it under an EPA licence** at this time, **we're more of a transfer station**, but we are planning to do the manual processing on-site in the future"* `[C2 08:19]`. **They are not the processor**, so RRO14 does not bind them today — a third party processes and bills them monthly. This becomes real only when processing comes in-house. **Matt's own call: v3.** See `09-` §20 |
| **F40** | Driver availability dashboard | 2 drivers. A column on the allocation board suffices |

| **F55** | Customer-visible estimated completion times | Needs the routing engine |
| **F57** | Customer complaints tracking | Needs a ticketing model |
| **F58** | Automatic job assignment → actually **proximity dispatch** | ⚠️ **I mis-scoped this.** It is not availability scheduling. Matt: *"if they're **in a certain area** and a job comes in… there's already a driver in that area"* `[C2 23:40]` — i.e. flag a late booking to a driver who is already nearby. More useful than I assumed, but it **depends on live driver location**, so it is gated on the Risk 7 / Q6 GPS decision |
| — | **Invoice template WYSIWYG designer** | Scope Call 1 — the biggest single scope trap |
| — | Xero credit notes, part-payments, bank reconciliation | |
| — | Bag asset tracking (QR/barcode, bag lifecycle) | ✅ **Matt scoped this to "version three" himself.** Real problem though: bags go free to Knauf in **pallets of 190**, ship with board orders, and *"we've **found our bags on sites that we're not servicing**"*. He wants *"we've sent out a thousand bags and we've only collected 900"* `[transcript 49:11]` |

### v2 and beyond — **versions below are Matt's own calls from Call 2**

| Item | Ver | Note |
|---|---|---|
| **Proposals / quotes in the customer portal** | **v2** | 🆕 **A third system exists** — a separate CRM he calls *"f\*\*\*ing terrible"* because it forces per-pickup line items onto open-ended multi-site proposals. Wants proposals visible in the portal to download, accept or decline. **Validates M5 Part 2 Journey A.** `09-` §27 |
| **F44 — job-specific permits** | **v2** | Client-supplied permits with time windows (traffic control near a school). *"Just another document assigned to that job."* Decoded floated a v2 AI agent to extract the permit window and auto-schedule within it |
| Customer-specific report templates | v2 | But the **monthly pickup volume report is essential in v1** — *"we have one customer in particular that requires it"* |
| F65 2-way reschedule-by-reply | v1.1 | Largely covered by the tap-through link in M8.3 |
| **Recycling centre capacity** | **v3** | Needs an EPA licence they don't hold |
| **Historical recycling rates per site** | **v3** | *"That's when the data analysis features will come in"* |
| **Waste disposal locations · recycling input/output** | **v3** | Ties to processing they don't yet operate |
| Bag asset tracking | **v3** | Matt's call |
| Weather · per-job environmental impact · fuel consumption | v2 | *"one of those AI suggestions"* |
| Processing batch / mass balance / yield · gypsum sales & stock | v3 | Depends on in-house processing |
| Knauf/DPO channel integration | v2 | |

### ❌ Removed entirely — Matt struck these on Call 2
| Item | Why |
|---|---|
| **Job-specific recycling rates** | *"We achieve **100% recycling rate** anyway. If it comes into our facility, it gets recycled"* |
| **Recycling bag usage per job** | Redundant — *"the driver is going to say how many bags are on site anyway"* |
| **Real-time job status updates** (as a discrete feature) | Redundant — everything is push-driven and real-time by design |
| **W10 subcontractor job assignments** | Redundant — all drivers are subcontractors; normal allocation covers it |

### Drop / challenge

| Item | Recommendation |
|---|---|
| **I4 — Stripe** | **Drop.** Client's own spec says *"possibly not needed – v2"*. Payment is 7-day EFT against PO; builders' AP departments do not pay by card |
| **I7 — Cognito Forms** | **Drop, do not integrate.** We are replacing it. Two intake paths = two sources of truth = the exact re-keying problem we're solving |
| **MYOB link** | Confirm dead, then drop |
| **~80 of 109 workflows as separate backlog items** | Treat as views of ~30 screens (§2.3) |

---

## 12. Question register

> **Complete and current.** Grouped by *who answers and when*, not by topic. Every question
> raised anywhere in this knowledge base appears here; answered ones stay in **§12.5** so
> nothing gets re-asked.
>
> | | | |
> |---|---|---|
> | **§12.1** 🔴 | **5** | Blocking — **ask Matt before Day 1** |
> | **§12.2** 🔧 | **2** | **We answer these ourselves** from the TransVirtual tenant |
> | **§12.3** 🟠 | **13** | Needed during week 1 |
> | **§12.4** 🟡 | **13** | Useful, answerable during the build |
> | **§12.5** ✅ | **26** | Already answered and closed |
>
> **33 open questions** of 37 raised. Numbering is stable — gaps (Q8, Q9, Q13, Q33) are
> deliberate: those are answered and live in §12.5.

### 12.1 🔴 TIER 1 — BLOCKING. Ask Matt **before Day 1**

These change architecture, scope or the plan itself, and **only Matt can answer them**.
Do not start without them. *(Five questions — Q2 and Q4 moved to §12.2; Q8 removed.)*

| # | Question | Why it blocks | Ref |
|---|---|---|---|
| **Q1** | **Do you need 3 years of history migrated, or is a read-only archive acceptable?** | **The single biggest scope lever.** "Archive is fine" removes several days from M10 | Risk 3, M10 |
| **Q3** | **What is the m²/kg field convention — per era and per customer?** | The meaning of both columns has drifted at least twice in 3 years. Blocks all migration transforms | Risk 3 |
| **Q5** | **Confirm the invoice-template split**: resolution + branding now, WYSIWYG authoring v1.1 | Unbounded scope if left open. Needs agreeing **in writing** | Risk 5, Scope Call 1 |
| **Q6** | **Do you need live background GPS** (moving dot with the phone in a pocket), or is location captured at each status event enough? | Decides **PWA vs native** for the driver app. ✅ **ANSWERED — build both** (native + PWA) | Risk 7, M4.2 |
| **Q7** | 🆕 **Who actually raises bookings today — head office, or site supervisors on site?** | If Clarendon's contracts administrator raises all ~90/month centrally, **Journey B mostly evaporates** and M5 Part 2 simplifies a lot. If it's per-site supervisors, the site-link flow is the most important screen in the build | M5 Part 2 |

> **Q2, Q4 → moved to §12.2.** Both are answerable from the TransVirtual tenant ourselves —
> no need to spend Matt's time on them.
>
> **Q8 (TransVirtual notice period) → removed.** It is a commercial matter on the client's
> side, not a build blocker. Scope Call 3 only needs Matt's *agreement* to the two-week
> overlap, not the contract date.

---

### 12.2 🔧 ANSWER OURSELVES — portal investigation, don't ask Matt

We have read access to the production tenant. These get resolved by looking, not asking.
**Findings below are already recorded** — what remains is stated explicitly.

| # | Question | What the portal already tells us | What's left |
|---|---|---|---|
| **Q2** | **Can TransVirtual bulk-export photos, and how many are there?** | ✅ **Export mechanism confirmed working in production.** `Import/Export → Data Export → Photos` exists and is rule-based. **Zero image-export rules configured today** — but **four POD export rules are live and running**: *PlastaGo Pickup Complete Photos*, *PlastaGo Futile Pickup Notification*, *EasyLift Pickup Complete Photos*, *EasyLift Futile Pickup Notification*. Those are what email photos to customers today, which **proves the export pipeline works** | Create an image-export rule against a date range and **measure actual volume + throughput on Day 1**. Estimate stands at ~40–50k images / 80–100 GB |
| **Q4** | **"Extra Load Time" — free allowance and unit?** | ✅ **Identified: it is TransVirtual's *demurrage (wait time)* feature.** Global Setup tooltip: *"…confirm if they are on site. If they are, **arrival time is locked in place and the system will start to calculate possible demurrage (wait time) charges, if configured**."* **`Ask Driver to Confirm Onsite` = ON**, and **`ClientMobileWarnDriverOnsite15min` = ON** (a 15-minute on-site warning). Charge type config: **flat rate $100**, **requires approval**, **single-use per consignment**, and **NOT driver-raisable** (`Display to driver` unchecked) — which is why the queue shows *Created By: System* | ⚠️ **The free-time threshold binding is not in Global Setup.** Likely per rate card or per customer. **Next step: check the rate card's "additional service price override" screen** (visible in Matt's emailed screenshots) before falling back to asking him |

---

### 12.3 🟠 TIER 2 — Needed during **week 1**

Each of these blocks a specific module once we reach it.

| # | Question | Why it matters | Ref |
|---|---|---|---|
| ~~Q9~~ | ~~Where do you tip off, and whose facility is it?~~ | ✅ **ANSWERED (Call 2).** **A yard run as a transfer station, no EPA licence, processing outsourced.** Only *who* the processor is remains open — see Q34 | `09-` §20 |
| **Q10** | **Is ANY current customer billed on kg?** `PlastaGo Recycling Invoice (KG)` and `EasyLift Recycling Invoice (KG)` templates exist | If yes, tip-off accuracy becomes a **billing** input, not just reporting — which raises its risk class considerably | `07-` §5A.3 |
| **Q11** | **EasyLift — which customers? Did it bill on kg while PlastaGo bills m²?** | ⚠️ **Partly answered from the portal: EasyLift is OPERATIONALLY LIVE, not legacy.** It has **two active POD export rules running in production** (*EasyLift Pickup Complete Photos*, *EasyLift Futile Pickup Notification*) alongside PlastaGo's. So multi-brand is live today, confirming M1.1. **Still to ask:** which customers, and the kg-vs-m² history | `06-` §6 |
| **Q12** | **Hook bins (5/10/15 m³) — how does that service actually run?** Delivered and left? Exchanged? Who owns the bin? | A whole service line with a dedicated 34T hooklift truck, absent from the website *and* the feature list. Different asset lifecycle to bags | `06-` §4.2 |
| ~~Q13~~ | ~~F35 "recycling compliance" — what is it?~~ | ✅ **EFFECTIVELY MOOT.** It depends on EPA-licensed processing they don't do. **Matt's own call: v3** | `09-` §20 |
| **Q14** | 🆕 **Which customers require the Site Risk Assessment + SWMS? Which builder portals do the QR codes point at?** | ⚠️ **An external dependency.** We upload a PDF into *someone else's* system. Need the target portals, whether they need auth, and what happens if the upload fails | M4.8 |
| **Q15** | 🆕 **Xero configuration:** which account codes, tax rates, and do you use tracking categories? Who invites our developers with admin rights? | Blocks M7.8. Matt confirmed on the call he'd arrange access | M7.8 |
| **Q16** | **"PrePaid Customer" — what is this account construct?** | $0 base with only exception charges invoiced. Needs its own handling, and it's the likely home for one-off/residential jobs | M5 · A.5 |
| **Q17** | **What recorded-vs-tip-off variance is acceptable** before someone investigates? | Sets the tolerance threshold on the M4.4 review queue | M4.4 |
| **Q18** | **Is tip-off per run, per day, or per load? Do drivers ever tip mid-run?** | The deduct-and-average algorithm assumes **per run**. Mid-run tipping breaks it | M4.4 |
| **Q19** | **Does anything else go in the truck?** Other materials, other brands, mixed loads? | Mixed loads would invalidate the apportionment entirely | M4.4 |
| **Q20** | **Who else has TransVirtual logins besides you and the two drivers?** | User migration and the pre-cutover invitation list | M10, M5 · C.1 |
| **Q34** | 🆕 **Which CRM do you use for proposals, and who processes your material?** | Two loose ends: a **third subscription** we didn't know about (Matt: *"a separate CRM that's f\*\*\*ing terrible"*) with possible lead data to migrate; and the identity of the third-party processor, which affects Diversion Certificate wording | `09-` §27, §20 |
| **Q35** | 🆕 **Can you send a sample Diversion Certificate?** | Decoded asked on Call 2 and it hasn't arrived. **Blocks M9.5** — we need the exact data points and wording | M9.5 |
| **Q36** | 🆕 **Which customers require the Site Risk Assessment?** | Matt: it applies *"on certain sites"*, not universally. Determines whether the SRA is a per-account or per-site flag, and how many builder QR portals we face | M4.8, Q14 |

---

### 12.4 🟡 TIER 3 — Useful, can be answered during the build

| # | Question | Why we're asking |
|---|---|---|
| **Q21** | **Invoices 104078 / 104079** — identical iPlasta jobs, same day, same 974 m², same $90 contamination. Duplicates, or two units on one site? | Migration dedupe logic |
| **Q22** | **Contamination — binary flag, or do you want type and estimated %?** | Today it's a yes/no. Grading makes it reportable and identifies repeat-offender sites |
| **Q23** | **Do you need recurring / scheduled pickups?** A large site may need one every fortnight for a year | Today that's 26 separate bookings. Cheap to add if wanted |
| **Q24** | **Does board type matter** (standard / fire-rated / wet-area / **foil-backed**)? | Foil-backed board is a known contaminant in gypsum recycling. You already capture brand (CSR/Knauf/Siniat) |
| **Q25** | **Should we capture a site contact phone number?** The current form doesn't have one | The driver is 5 minutes away and needs a gate opened — email is useless for that |
| **Q26** | **Required-photo prompts — configured per site, per customer, or globally?** | M4.5 |
| **Q27** | **Do builders ask you for diversion certificates today? How do you produce them?** | Validates M9.5, the highest-value differentiator |
| **Q28** | **Any plans outside NSW?** The booking form has a State field | Zone and pricing configurability |
| **Q29** | **BrickGo — what is it, and on what timeline?** | Confirms the multi-material dimension |
| **Q30** | **Subcontractor per-job pay rates** — where are they held today? | Prep for RCTI in v1.1; the data model should anticipate it |
| **Q31** | **Simvoly and Cognito Forms — notice periods / renewal dates?** | Decommissioning Cognito after cutover |
| **Q32** | **Who buys the recovered gypsum, and how are those sales managed?** | Entirely invisible to software. Scopes the v1.1/v2 outbound product |
| ~~Q33~~ | ~~What EPA licences do you operate under?~~ | ✅ **ANSWERED: none.** Transfer station, unlicensed, processing outsourced. F35 → v3 |
| **Q37** | 🆕 **What registration periods are in use** — 12 / 6 / 3 months? | F43 rego reminder roll-forward (v1.1) |

---

### 12.5 ✅ ANSWERED — closed, kept so they aren't re-asked

| Question | Answer | Source |
|---|---|---|
| Xero or MYOB? | **Xero.** *"I'm not looking to replace Xero, I'm looking to interface with it."* MYOB presumed dead | Call |
| How is per-job weight measured? | **Crane scale** on bagged jobs (~60–70%). Hand-load jobs (~30%) **cannot be weighed** and are imputed from the tip-off remainder | Call |
| Is weight billed? | **No.** Priced on m²; weight exists to make the m²→kg estimate better, and to audit the monthly tip bill | Call |
| Are drivers subcontractors? Is RCTI live? | **All drivers are subcontractors.** RCTI is **planned, not live** — weekly, per-job, exports to Xero as a **bill** | Call |
| Stripe / card payments? | **Dropped by Matt.** *"a lot of our payments come through direct deposit… happy to take that requirement out"* | Call |
| Email provider? | **Microsoft 365 SMTP**, not SendGrid. *(Caveat: throttling + weaker bounce handling — raised)* | Call |
| Native app or PWA? | **PWA for customers** — *"I don't think anyone's going to install a PlastaGo app."* Driver app PWA unless Q6 forces native | Call |
| **Rebuild the website?** | **✅ RESOLVED — NO.** The transcript predates the emails; the **14 Aug email governs**: keep the Simvoly site for SEO and bolt the app on. Scope Call 2 stands | Email (later) |
| What is the rate card? | Sydney `$220 + $0.16/m²` · Wollongong `$250 + $0.18/m²` · Newcastle `$250 + $0.20/m²` · bags `$30`. 8 cards, tiers 1–4, effective-dated. **Validated to the cent against 6 real invoices** | Email + tenant |
| Run sheets vs route optimisation? | **Different things.** Run sheets = *"going to be a necessity"*. Route optimisation = *"very nice to have"* (and is really succession planning) | Call |
| Bag tracking priority? | **Version 3**, Matt's own call | Call |
| Chat scope? | **Office ↔ driver only.** No driver-to-driver, no group channel | Call |
| Where does job duration come from? | **Arrived → Complete Job**, driver-tapped | Call |
| Customer feedback / ratings? | **Nice-to-have** | Call |
| Environmental impact analytics? | **v2.** *"This is not important… one of those AI suggestions"* | Call |
| Contamination dispute process? | Driver marks contaminated → **Additional Service Approvals queue** → office approves → **$90** | Tenant |
| **Where is the facility? EPA licence?** | ✅ **A yard run as a transfer station. NO EPA licence. Processing is outsourced** (hence the monthly tip bill). On-site processing is a future plan | **Call 2** |
| **What is the real SLA?** | ✅ **5 business days from the customer's ready date** — not "3–5 days from request". Most jobs have no time; a minority have a hard permit window | **Call 2** |
| **What does the Diversion Certificate contain?** | ✅ Matt's name for it. **Per job**, showing **both m² and tonnage** diverted from landfill. For Green Building Council / NABERS reporting | **Call 2** |
| **Invoice formats?** | ✅ **PDF only.** CSV was for one customer they no longer service | **Call 2** |
| **What does F43 need?** | ✅ Odometer + expense log → **cost per km**; rego reminder **2 weeks out**. No parts/labour breakdown | **Call 2** |
| **What does F53 need?** | ✅ Licence / white card / crane tickets + expiry, **1-month** reminder, admin-managed licence types | **Call 2** |
| **What is F58 really?** | ✅ **Proximity dispatch** — flag a late booking to a driver already in that area. Not availability scheduling | **Call 2** |
| **Does he want invoice-template priority + filters?** | ✅ **No.** *"I don't need this level of granularity."* Simplify to per-customer assignment. But he **does** want layout editing — see Scope Call 1 | **Call 2** |
| Volumes, accounts, drivers, fleet? | 5,079 jobs · ~135–160/mo · **53 accounts (31 active in last 12 mths, top 5 = 87%)** · 2 drivers · 5 vehicles | Tenant |

---

## 13. The 20-day plan — design lock, then two backends

> **Confirmed approach:** **days 1–3 are frontend only.** No backend, no mobile development. The
> **entire web UI** is built against mock data and shown to Matt on **day 3**. Once the design is
> confirmed, the same design is applied in Flutter and the backend is built for both frontends.

### 13.1 Why this sequencing is right — and what it costs

**What it buys:**
- **The design is locked before any backend or Flutter investment**, so rework is cheap
- **The API contract falls out of real UI needs** rather than being guessed (§6A.9)
- **Flutter mirrors a confirmed design** instead of a moving target — critical, because the
  mobile app is a separate repo and a separate language
- Matt sees something real at the 15% mark, which is the right moment for a deposit-funded
  engagement

**What it costs — state this plainly:**
> ⚠️ **The pricing regression harness moves from days 3–4 to days 6–8.** It is Risk 1, the
> highest-rated risk in the project, and it now starts later. **That is acceptable but must be
> watched: it cannot slip past day 10 (halfway).** With MongoDB carrying no database-level
> integrity guarantees (§6A.3), this harness is the only thing standing between us and a
> mis-priced invoice.

### 13.2 Days 1–3 — frontend only

| | Who | Work |
|---|---|---|
| **Web dev 1 + Web dev 2** | both | **Day 1:** design system, Tailwind/shadcn setup, PlastaGo brand applied (logo and palette are in the client's asset pack), screen inventory, **Zod schemas in `packages/shared`**. **Days 2–3:** every screen, against **MSW mock data** |
| **Mobile dev** | | ⚠️ **Apple Developer enrolment — START DAY 1** (Risk 8, longest external lead time). Flutter project scaffold, CI, device setup. **Write the offline sync protocol spec** (§6A.4) — this is design-independent, so it is the right work for these three days |

**Screens to build — roughly 43:**

| Surface | Screens |
|---|---|
| **Admin console** (~22) | Job list · job detail · create job · accounts · account detail · sites · allocation board · run sheets · futile review queue · additional-service approvals · awaiting-PO queue · PO review queue · invoice list · invoice detail · template assignment · leads/onboarding queue · vehicles · drivers/licences · reports (×4) · dashboard · settings |
| **Customer portal** (~11) | Dashboard · book a pickup · edit pickup · job history · job detail with photos · invoices · monthly reports · Diversion Certificates · site supervisors · account preferences · sites |
| **Driver PWA** (~10) | Login (OTP) · today's run sheet · job detail · status actions · weights + tip-off · photo capture · futile · contamination · Site Risk Assessment form · pre-start checklist |
| **Auth** | OTP request · OTP verify · role-based landing |

> **Judgement call — the driver screens ARE in the Day-3 demo.** They are web (a Vite PWA), and
> more importantly **Flutter will mirror them**. Starting Flutter against an unconfirmed design
> defeats the whole purpose of the design lock. It does add screens to a tight three days — if
> something has to give, cut the four report screens, not the driver app.

**Deliverables at end of day 3:**
1. ✅ Complete, navigable web UI on mock data
2. ✅ **API contract** — Zod schemas → generated OpenAPI, **frozen** (§6A.9)
3. ✅ **Offline sync protocol spec** — one document, two future implementations
4. ✅ Apple enrolment in flight

> **What "complete frontend in 3 days" means, precisely:** screens, navigation, layout, component
> library and mock data. **It does not yet mean** wired state, validation rules, error and empty
> states, optimistic updates or the offline layer — those are the expensive parts and they come
> from day 4. Say this in the demo (§13.5).

### 13.3 ★ Day 3 — the show-and-tell

**Show, in this order** — familiar first, new last:

1. **Job list and job detail** — his #1 and #2 daily screens. Parity, instantly.
2. **Create job** — with the **live price estimate** TransVirtual cannot give him.
3. **Allocation board and run sheet** — visual, and immediately legible to an ex-driver allocator.
4. **The driver PWA on an actual phone.** Hand it to him. This is the moment it becomes real —
   and it is the design Flutter will mirror, so **this is the screen set that most needs his sign-off**.
5. **The customer portal** — the thing TransVirtual has never given him.
6. **A sample invoice** with `2 × $30 = $60` line items, and a **Diversion Certificate**.

**Use the session to close open Tier 1 questions** — a screen in front of him gets answers an
email will not:

| Show him | Closes |
|---|---|
| Sample invoice + the template options | **Q5** — the authoring decision (Scope Call 1) |
| The booking flow | **Q7** — who actually raises bookings |
| A draft Diversion Certificate | **Q35** — we still do not have his sample |
| The driver screens | Design sign-off that unblocks **all Flutter work** |
| The migration plan on screen | **Q1** — history vs archive |

### 13.4 Days 4–20 — three tracks

| Days | **A — Backend** (web dev 1) | **B — Frontend wiring** (web dev 2) | **C — Flutter** (mobile dev) |
|---|---|---|---|
| **4–5** | Mongo schemas + Mongoose models · `$jsonSchema` validators · repository layer · **OTP auth + JWT** | Wire admin console to the real API · validation · error/empty states | Flutter shell · navigation · auth · **local DB (Drift)** |
| **6–8** | ⚠️ **PRICING ENGINE + REGRESSION HARNESS** — 300 real invoices, 100% match, in CI | Accounts · sites · job CRUD · allocation board | Run sheet · status flow · **Arrived → Complete clock** |
| **8–10** | Additional services · **tip-off deduct-and-average** · exception-queue logic | Exception queue UIs — futile, approvals, awaiting-PO | Weights · **tip-off entry** · photos + required-photo prompts |
| **10–12** | Invoicing · **two-invoice flow** · template assignment · **PDF generation** | Invoicing UI · customer portal wiring | **Futile · contamination · SRA → PDF + SWMS merge → QR → builder portal** |
| **12–14** | **Xero** push/pull · ⭐ **AI PO pipeline** (M365 mailbox + Mistral OCR) | **Driver PWA offline layer** — IndexedDB/Dexie, service worker, sync | **Background geolocation** · push · **native build** |
| **14–16** | PO pipeline tuning against **real PO emails** · notifications · Diversion Certificates | **M5 Part 2 enrolment** · dashboards · reports | **iOS distribution** (TestFlight/Ad Hoc) · Android APK · device testing |
| **16–18** | **MIGRATION** — accounts, jobs, invoices, photos · **parallel-run validation** | Migration QA · reconciliation vs TransVirtual reports · **F43 / F53 / F22 screens** | **Field test — both drivers work a real run on both builds** |
| **18–19** | **Invitation campaign (T-5 → T-1)** · top-5 account walkthroughs | UAT with Matt + office | UAT fixes with both drivers |
| **19–20** | Fixes · cutover runbook · **GO LIVE** | | |

> **Go-live gates — all three must be green:**
> 1. **Pricing harness passing on 300 real invoices**
> 2. **Top five accounts have activated users** (M5 · C.2)
> 3. **Both drivers have completed a real run** on the app they will actually use

### 13.5 Sequencing rules that must not be broken

1. **Apple Developer enrolment starts Day 1.** Longest external lead time, zero cost to start
   early (Risk 8).
2. **The API contract freezes at day 3.** Two consumers depend on it; changes after that need a
   version bump (§6A.9).
3. **The offline sync protocol is written before either implementation starts** — days 1–3, by
   the mobile dev (§6A.4).
4. **The pricing harness lands days 6–8 and cannot slip past day 10.** With MongoDB providing no
   integrity backstop, this is the only guard on invoice correctness (§6A.3).
5. **Real PO emails needed by day 12** — ask Matt in week 1 (Risk 9).
6. **Migration gets two full days (16–18), not an afternoon.** The extra six days over the
   original plan exist partly to buy exactly this.

### 13.6 How to frame the Day-3 demo — this matters

A complete UI at day 3 will look far more finished than the system is. Matt is an operations
director; he will see working screens and reasonably conclude the build is most of the way there.
**The risk on this project was never the interface** — it is the pricing engine, the AI
extraction, the migration and the cutover, none of which are visible.

Open the session with this:

> *"What you're seeing today is the complete look and feel, and it's real code — but it's running
> on sample data, with no engine behind it yet. That's deliberate: we wanted your sign-off on
> every screen before we build the backend twice, once for the web and once for the drivers'
> phones. The next seventeen days are the parts you can't see — making sure every invoice matches
> what TransVirtual would have produced, teaching the system to read your POs reliably, getting
> three years of jobs and photos across, and switching over without breaking your billing. That's
> where the risk is, and that's where the time goes."*

That paragraph prevents the *"but it looked finished two weeks ago"* conversation on day 17.

---
## 14. How to present this to the client

Lead with what they get. Then draw the boundary honestly.

> *"In 20 days you'll be live on a system that replaces the six screens you use in
> TransVirtual every day — creating jobs, finding jobs, approving driver charges, working
> futile pickups, invoicing, and seeing where your drivers are.*
>
> *On top of that you get two things TransVirtual has never been able to give you: a
> customer portal your five biggest accounts can log into and book, track and self-serve
> from — and automated recycling certificates they can use for Green Star.*
>
> *Your pricing will be validated against your last 300 real invoices before we switch
> anything over, and we'll keep TransVirtual read-only for a fortnight as a safety net.*
>
> *Route optimisation, the PO-reading AI, RCTI and the drag-and-drop invoice designer are
> all real and we want to build them — they're v1.1, right after go-live. Putting them into the
> first 20 days would put your invoicing at risk, and that's the one thing we won't do."*

**Anchor the commercial case on:**
- **~$9k/year** of contamination charges sitting unapproved in a queue right now
- A **futile pickup ($120) unactioned since August 2025**
- **Retention of five accounts worth 87% of revenue** — the portal is aimed at them
- **Cash cycle** — POs enforced, invoices out same-day, payment status visible

**Never anchor it on** replacing TransVirtual's subscription. The value is recovered revenue,
recovered owner-hours and customer retention — not saved licence fees.

---

## 15. Cross-references
- `09-CLIENT-CALL-FINDINGS.md` — ⭐ **highest-authority source.** The discovery call: tip-off algorithm, Site Risk Assessment workflow, RCTI mechanics, confirmed/dropped integrations
- `06-TRANSVIRTUAL-INCUMBENT-SYSTEM.md` — the incumbent, live volumes, configuration, migration inventory
- `07-PRICING-AND-BILLING-MODEL.md` — the rate engine in full, real invoice data, the template trap
- `03-BOOKING-FORM-TEARDOWN.md` — intake requirements, validated against production data
- `04-INDUSTRY-REGULATORY-COMPETITIVE.md` — EPA obligations behind F35 and the certificates
- `05-OPERATIONAL-WORKFLOW-AND-PAIN-POINTS.md` — value leakage map
