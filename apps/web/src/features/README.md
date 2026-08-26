# `features/`

One folder per domain, holding everything that domain needs on the client:

```
features/<domain>/
├─ api.ts          apiRequest calls, typed by schemas from @plastago/shared
├─ queries.ts      useQuery / useMutation hooks + invalidation
├─ components/     components used only by this domain
└─ schemas.ts      form-only schemas (anything the API sees lives in @plastago/shared)
```

**`pages/` holds routes; `features/` holds the domain logic they compose.** A page
should read as a layout of feature components, not as a place where data fetching
and business rules live.

**Where a schema belongs:** if the API ever sees it, it goes in
`@plastago/shared` — never duplicated here. Only genuinely client-only shapes
(a multi-step wizard's local draft state, a filter panel) live in `schemas.ts`.

Folders to come, mirroring the API domains: `auth`, `accounts`, `jobs`,
`allocation`, `invoicing`, `reporting`.

---

## ⚠️ Deviation while the frontend runs ahead of the API

`api.ts` does **not** exist yet in any feature folder, and `features/auth/` is
built without one. Data access lives in [`../services/`](../services/README.md)
instead — an interface per domain, resolved through `useServices()`, backed today
by in-memory fixtures.

**Why:** days 1–3 are frontend-only precisely so the contract falls out of real
UI needs rather than being guessed (§6A.9, §13.1). A per-feature `api.ts` has to
name endpoints to exist, and the contract freezes at day 3 — so writing
`POST /api/v1/auth/otp/request` today would be committing to a guess. The service
interface states the _requirement_ without the path.

**What this looks like when the API lands:** the HTTP adapter goes in
`services/http/<domain>.http.ts`, and `features/<domain>/queries.ts` is added
over it for TanStack Query hooks and invalidation. `api.ts` may not be needed at
all — the adapter is that layer, shared rather than per-feature so the driver PWA
gets identical semantics.

Worth a decision before the second domain is built: keep the shared service
container, or move to per-feature `api.ts` as originally documented here.
