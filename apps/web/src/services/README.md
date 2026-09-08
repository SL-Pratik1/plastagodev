# Services — the data seam

Screens never call `fetch`, a URL, or `@plastago/api-client`. They call a service
interface from [`types.ts`](./types.ts), resolved through `useServices()`.

```
component ──▶ useServices().jobs.list(query)
                       │
                       └── http/       @plastago/api-client → the real API
```

## The mocks are gone

There used to be a second branch here: `mock/`, an in-memory implementation that
kept every screen running while the backend was built. Every domain now has real
endpoints, so the folder was deleted at cutover.

That was deliberate rather than tidying. A mock kept beside a working backend is
how a screen ends up quietly reading fixtures for a month without anybody
noticing — and the moment it can be selected, somebody will select it to make a
test pass.

Two things that lived in `mock/` were not fixtures and survived the deletion:

- `currentPosition()` → [`lib/geolocation.ts`](../lib/geolocation.ts). It talks
  to the browser, not the server, so it is the same code either way.
- the seeded sign-in accounts → [`config/seeded-identities.ts`](../config/seeded-identities.ts),
  as a **development-only** tap-to-fill list. The mock's hardcoded OTP was NOT
  carried over: the code is a real one now, and advertising a fixed one would be
  worse than offering nothing.

## Where the endpoint paths live

In `http/` and nowhere else. That is the whole point of the seam: no screen,
hook, query or component knows a URL exists, which is what made the cutover one
line in `main.tsx` plus these adapters.

| Adapter                                      | Domains                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [`auth.http.ts`](./http/auth.http.ts)         | §9 — OTP sign-in, session, sign-out                                   |
| [`reference.http.ts`](./http/reference.http.ts) | lookups, users, driver roster, dashboard, audit, notifications, settings |
| [`admin.http.ts`](./http/admin.http.ts)       | customers, jobs, dispatch, invoices, reports, fleet                   |
| [`queues.http.ts`](./http/queues.http.ts)     | the five office queues (M2.6, M2.7, M7.3, M2.12, Journey A)           |
| [`portal.http.ts`](./http/portal.http.ts)     | the customer portal (M5)                                              |
| [`driver-run.http.ts`](./http/driver-run.http.ts) | the driver surface (M4)                                           |

`list-params.ts` holds the two things every adapter needs: `ListQuery` →
query-string parameters, and the `pageOf()` envelope.

## Responses are parsed, not cast

Every call passes the schema it expects from `@plastago/shared`. A contract break
therefore fails loudly at the boundary — as `CONTRACT_MISMATCH` — instead of
surfacing as `undefined` three components deep. This is the main reason the
adapters are worth the typing.

## Error handling

Everything throws [`ServiceError`](./service-error.ts) with a `ServiceErrorCode`.
The UI branches on `code`, never on an HTTP status — a component that tests
`status === 409` is coupled to a transport it should not know about.
`to-service-error.ts` is the one place HTTP becomes a `ServiceError`.

User-facing copy for each code lives in the UI layer
(`lib/error-message.ts`, `features/auth/auth-messages.ts`), because the right
wording depends on what the user was doing.

## The driver surface is different

`driverRun` writes go to the **outbox**, not to the network: M4.12 says
everything works with no signal, so a mutation resolves when it is durably
queued on the phone, not when the server has it. See
[`driver-run.types.ts`](./driver-run.types.ts) and `offline/outbox.ts`.

⚠️ One exception, and it is structural: `addPhoto` needs signal. Photo bytes go
direct to S3 under a signed URL (§6A.10 #9), a signature cannot be obtained
offline, and it expires — so it cannot be queued either. Making it work offline
needs a second queue that stores the blob and re-signs at drain time. That queue
is not built, and the adapter fails loudly rather than losing a photo.

## Adding a domain

One interface per domain on `Services`, one implementation in `http/`. Lists use
`ListQuery` / `ListResult<T>`, which mirror `PageQuerySchema` and `pageOf()` in
`@plastago/shared` so the paged envelope never diverges from the contract.
