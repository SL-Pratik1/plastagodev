# Zone QA scripts

Manual QA for dynamic zones (M6.3), written during the change and kept because
each one covers something the unit suite cannot: they drive the **running app**
over HTTP and, in `screens.cjs`, through a real browser.

They are re-runnable. Anything that would collide with a previous pass — a zone
slug, a schedule start date — is generated per run, so a second pass is not a
different test.

## Running them

The dev servers must be up, and the database seeded:

```
npm run check:ports
npm --workspace @plastago/api run seed:all
npm run dev
```

Then, from the repo root:

```
node scripts/qa/zones.cjs                    # create, rename, reorder, retire
node scripts/qa/permissions-and-suburbs.cjs  # the super-admin gate, suburb CRUD
node scripts/qa/end-to-end.cjs               # a job booked in a brand-new zone
node scripts/qa/screens.cjs                  # the admin screens, in a browser
```

⚠️ They sign in by reading the one-time code out of the API's own log, which
only works while `MAIL_PROVIDER=stub`. `zones.cjs` and the others expect a
session cookie jar at `%TEMP%/qa.txt`; `permissions-and-suburbs.cjs` creates its
own for the operations user.

## What each one is actually protecting

- **zones.cjs** — the rules that are easy to regress by "tidying up": a retired
  zone is still nameable, its slug can never be reissued, a partial reorder is
  refused, and a schedule must price every LIVE zone but not a retired one.
- **permissions-and-suburbs.cjs** — that zone administration is stricter than
  the rest of Settings, and that `operations` keeps everything else.
- **end-to-end.cjs** — the whole point of the feature: add a zone, point a
  suburb at it, book a job, and get the right money. It also covers the
  back-dated quote, which is the one that fails if a zone copies only its
  current rates.
- **screens.cjs** — that no screen leaks a raw ObjectId where a zone name
  belongs, and that nothing 500s.
