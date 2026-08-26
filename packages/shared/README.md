# `@plastago/shared`

**The single source of truth for the API contract (§6A.9).**

Zod schemas live here. The API validates with them, the React apps infer their
types from them, and the OpenAPI document is _generated_ from them — it is never
hand-written.

## Layout

```
src/
├─ constants.ts          infrastructure constants (timezone, region, roles, API prefix)
├─ schemas/
│  ├─ primitives.ts      ObjectId, ISO date/time, Money, idempotency key
│  ├─ envelope.ts        the single ApiError shape + error codes
│  ├─ pagination.ts      PageQuery / PageMeta / pageOf() factory
│  └─ health.ts          liveness + readiness contract
└─ openapi/
   ├─ document.ts        the OpenAPI 3.1 document — add new paths here
   └─ helpers.ts         jsonResponse() / errorResponses()
```

## Adding a domain to the contract

1. `src/schemas/<domain>.ts` — request and response schemas. Give each reusable
   object an `id` via `.meta({ id: 'Thing' })` so it becomes a named component.
2. Export it from `src/index.ts`.
3. Declare the paths in `src/openapi/document.ts`.
4. `npm run openapi` from the repo root to regenerate `apps/api/openapi/openapi.json`.

## Two rules that are not negotiable

- **Money is a decimal string on the wire, `Decimal128` in Mongo, never a float**
  (§6A.10 #1). `MoneySchema` enforces the wire format.
- **The contract freezes at day 3.** Two consumers depend on it — the web apps and
  the separate Flutter repo, which pins a published version. Breaking changes after
  the freeze require bumping `API_VERSION`.
