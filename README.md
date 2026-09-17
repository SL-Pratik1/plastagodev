# plastago-web

Monorepo for the PlastaGo platform: admin console, customer portal, driver PWA
and the API.

> ## What this is
>
> **Scaffold only — there is no business logic in this repo yet.** No jobs, no
> accounts, no pricing, no invoices, no working authentication. The stack,
> structure, tooling and conventions are in place and verified; the domain is
> not.
>
> Architecture follows `08-MVP-20-DAY-SCOPE.md` §6A. Section references
> throughout the code point back to it.

---

## Quick start

```bash
npm install
npm run dev          # everything, in parallel
```

| Surface                          | URL                                | Roles                                            |
| -------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Office console                   | http://localhost:5173              | super-admin, operations, office-staff, allocator |
| Customer portal                  | http://localhost:5175              | customer-administrator, customer-site-supervisor |
| Driver app                       | http://localhost:5176              | driver                                           |
| API                              | http://localhost:4000/api/v1       | —                                                |
| API contract                     | http://localhost:4000/openapi.json | —                                                |
| _(legacy)_ standalone driver PWA | http://localhost:5174              | —                                                |

Or one at a time: `npm run dev:api` · `npm run dev:web` · `npm run dev:driver`.

### Three surfaces, three origins

One codebase, started once per surface. In production they are three hostnames
(`console.` / `portal.` / `drivers.plastago.com.au`); locally they are three
ports. A role only ever sees its own address — ask the portal for `/admin` and
you are redirected to the console, deep link intact.

Each surface has its own Vite config in `apps/web`, so a surface is chosen by
picking a config rather than by setting an environment variable:

```bash
npm run dev            # one server, every surface, admin port — the default
npm run dev:admin      # just the console        (apps/web)
npm run dev:portal     # just the customer portal
npm run dev:driver     # just the driver app
```

The same three exist for builds: `build:admin`, `build:portal`, `build:driver`.
Each bakes its own manifest, name and icon into `dist/`, which is what a
per-origin deployment installs as its own app.

A dev server per surface costs its own memory and its own dependency pre-bundle,
so the combined default is the faster choice for a change that touches one
screen — and the split behaviour is still exercised by building a surface.

> ⚠️ **A port is not an origin, for cookies.** Browsers scope cookies by host and
> ignore the port, so the surfaces share a session locally and will not once the
> hostnames differ. Everything else — redirects, CORS, the per-surface
> manifests — behaves as it will in production.

Moving a port means moving it in three files (`PLASTAGO_PORT_*`, `CORS_ORIGINS`,
`PUBLIC_*_URL`) — nothing checks that they agree, so change all three together.
`apps/web/vite.config.ts` resolves the ports and documents the whole arrangement.

> ⚠️ **`apps/driver` is superseded.** The driver screens now live in `apps/web`
> under `/driver/*`, served on their own port. The standalone build is kept only
> until the change has been reviewed. Nothing imports it and nothing links to it.
> See _Why the driver app moved_ below.

**MongoDB is required** (or the API boots degraded — see below). Redis is
optional and off by default.

```bash
# Verify the stack end to end
curl localhost:4000/readyz
```

---

## Layout

```
plastago-web/
├─ apps/
│  ├─ web/       admin console + customer portal + driver app  (ONE codebase,
│  │             started once per surface — own port, own manifest, own SW)
│  ├─ driver/    SUPERSEDED — the standalone driver PWA, pending deletion
│  └─ api/       Express 5 + BullMQ workers
├─ packages/
│  ├─ shared/      Zod schemas → the single source of truth → generated OpenAPI
│  ├─ ui/          shadcn/ui primitives + design tokens
│  └─ api-client/   typed, schema-parsing HTTP client
└─ docs/
   └─ offline-sync-protocol.md   ← read before touching the driver apps

plastago-mobile/    SEPARATE repo — Flutter native driver app
```

**Why the three surfaces are one codebase but three addresses:** they share auth,
session and most components, so one route table with role-based routing is
simpler than maintaining three apps. They are _served_ separately because an
address is a promise about who a page is for — a builder's site supervisor and a
PlastaGo allocator have no business sharing one (§6A.5, and Matt at 29:04 asking
for exactly this for drivers).

Each server mounts only its own surface. The other two are replaced by a
redirect that carries the path across, so a link from before the split still
arrives somewhere useful. `app/router.tsx` explains why the capability guards
were not enough on their own: they stop the wrong _person_, not the wrong
_address_, and an office user opening `/admin` on the portal's hostname passes
every guard there is.

**Why the driver app moved into `apps/web`:** a browser will only ever offer to
install the page it is already on. `beforeinstallprompt` is delivered to a
document solely when that document's OWN manifest scope contains it, and there is
no API anywhere in the platform for installing somebody else's app. While the
driver screens were a separate _build_, an "Install the driver app" button could
not be made to work from the console.

The surface split does not undo that, because it splits origins rather than
codebases: the driver's origin serves the driver surface and nothing else, so the
page offering the install and the app being installed are the same thing. Each
origin gets its own manifest, which is the part a shared one got wrong — a driver
installing from their run sheet used to get an icon reading "PlastaGo" that
opened the console's landing route.

`vite.config.ts` still declines to precache the console's chunks onto a phone
(`OFFICE_ONLY_CHUNKS` — Recharts and React Hook Form, ~384 kB of charting library
a driver will never run). That is **not** redundant after the split: every
surface builds from the same `lazy-pages.tsx`, so Rollup emits every lazy chunk
into every build. Splitting that module per surface would let tree-shaking drop
them outright — worth doing, not done.

**Why `api-client` exists** (an addition to the documented layout): both browser
apps need identical request, parse and error semantics. Copying it into two apps
would guarantee drift.

---

## Stack

| Layer      | Choice                                              |
| ---------- | --------------------------------------------------- |
| Language   | TypeScript 6 (strict)                               |
| Monorepo   | npm workspaces + Turborepo                          |
| API        | Express 5 · Mongoose 9 · BullMQ 6 + Redis · Pino    |
| Database   | MongoDB Atlas — `ap-southeast-2` (Sydney)           |
| Web        | React 19 · Vite 8 (Rolldown) · React Router 8       |
| UI         | Tailwind v4 · shadcn/ui · TanStack Table · Recharts |
| Data       | TanStack Query · React Hook Form + Zod              |
| Contract   | Zod → OpenAPI 3.1 (`zod-openapi`)                   |
| Driver PWA | `vite-plugin-pwa` + Workbox · Dexie                 |
| Tests      | Vitest + supertest                                  |

> **TypeScript is pinned to 6.0.x, not 7.** `typescript-eslint` declares
> `typescript: ">=4.8.4 <6.1.0"`, so TS 7 silently disables type-aware linting.
> On a 3-dev AI-assisted build, working lint is worth more than one major
> version. One-line bump once typescript-eslint catches up.

---

## Commands

| Command             | Does                                        |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | API + one server serving all three surfaces |
| `npm run build`     | Everything, with typecheck                  |
| `npm run typecheck` | All 6 packages                              |
| `npm run lint`      | Type-aware ESLint                           |
| `npm test`          | Vitest                                      |
| `npm run openapi`   | Regenerate `apps/api/openapi/openapi.json`  |
| `npm run format`    | Prettier                                    |

Turborepo caches all of these. `--force` to bypass.

---

## Conventions that will be reviewed

### API — `router → controller → service → repository`

One folder per domain, four files, no exceptions (§6A.7). `apps/api/src/domains/health/`
is a working reference. See `apps/api/src/domains/README.md`.

- **Router** — paths and middleware only.
- **Controller** — HTTP in, HTTP out. No business rules, no Mongoose.
- **Service** — business rules. No Express, no Mongoose.
- **Repository** — the **only** file that touches Mongoose.

### The eight things that must be true for MongoDB to be safe (§6A.3)

Mongo will not enforce integrity for you. These are requirements:

1. **`Decimal128` for every monetary field. Never `double`.** GST and rounding
   must match TransVirtual to the cent.
2. Atlas, not DocumentDB.
3. `withTransaction` around invoice generation.
4. Collection-level `$jsonSchema` validators _as well as_ Mongoose schemas.
5. **One data-access layer.** No ad-hoc queries anywhere.
6. Compound indexes designed up front.
7. Change Streams → append-only audit collection.
8. `$merge` rollups for monthly reporting, recomputed nightly.

> ### The structural consequence
>
> In a relational database, constraints would catch a class of integrity bug for
> free. Here **the test suite does that job** — which is why the pricing
> regression harness (Risk 1) is structural, not a nice-to-have, and must run on
> every commit from the moment the pricing engine exists.

### The contract

Zod schemas in `packages/shared` are the source of truth. The OpenAPI document
is generated from them. **The contract freezes at day 3** — two consumers depend
on it, and one of them is a separate Flutter repo that pins a published version.

### Money

`Decimal128` in Mongo, a **decimal string** on the wire (`MoneySchema`), never a
JS `number`. JSON numbers are IEEE-754 doubles and will silently lose cents.

---

## Local services

### MongoDB

```bash
# Local standalone is fine for scaffolding
mongod --dbpath ~/data/db
```

> ⚠️ **A standalone `mongod` cannot do multi-document transactions** (§6A.3 #3).
> Before building the invoicing domain, move to Atlas or start a local replica
> set — otherwise `withTransaction` fails at exactly the point it matters most.

### Redis — optional

Off by default (`ENABLE_QUEUES=false`), so the API boots on a machine with no
Redis and `/readyz` honestly reports it as `disabled` rather than `down`.

```bash
docker run -d -p 6379:6379 redis:8-alpine
# then set ENABLE_QUEUES=true in apps/api/.env
npm run dev:api
npm --workspace @plastago/api run dev:worker    # separate process
```

---

## Known gaps — deliberate, recorded so they are not surprises

| Gap                                | Why                                                                                          | Where                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **No error tracking**              | Removed by decision. Production failures are invisible unless a human reports them           | §6A.8 — mitigated by structured logs + sync-failure counters on the dashboard                             |
| **Compute runs offshore**          | Render has no Australian region; closest is Singapore. All _persistent_ data stays in Sydney | §6A.2 — the client's Privacy Policy needs a one-paragraph APP 8 amendment. Raise it with Matt proactively |
| **Offline sync protocol unsigned** | It is a day 1–3 deliverable and blocks both driver apps                                      | `docs/offline-sync-protocol.md`                                                                           |

> ✅ **Closed: placeholder brand palette.** `packages/ui/src/styles/theme.css` now
> carries the real colours (forest `#1B3820`, recycling green `#75C37F`, tints
> `#CAE5C1` / `#E7F2E3`), Montserrat + Open Sans, and the logo in wordmark and
> glyph cuts under `apps/*/public/brand/`. Sourced from plastago.com.au's own
> tokens and the primary logo artwork, pending the client's asset pack to confirm.

---

## Before real feature work starts

1. **Start Apple Developer enrolment.** Longest external lead time in the
   project, zero cost to start early (Risk 8, §13.5 rule 1).
2. **Sign off `docs/offline-sync-protocol.md`** — blocks both driver
   implementations (§13.5 rule 3).
3. **Get the four blocking answers from Matt** (§12.1): history vs archive (Q1),
   the m²/kg convention per era and per customer (Q3), the invoice-template split
   in writing (Q5), and who actually raises bookings (Q7).
4. **Get credentials:** Atlas, Render, S3 (Sydney), Twilio, Google Maps, M365
   mailbox, Mistral, Xero admin invite.
5. **Export 200–300 real jobs with their TransVirtual invoices.** Without them
   Risk 1 — the highest-rated risk in the project — has no mitigation at all.
