# Services — the data seam

Screens never call `fetch`, a URL, or `@plastago/api-client`. They call a service
interface from [`types.ts`](./types.ts), resolved through `useServices()`.

```
component ──▶ useServices().auth.requestCode(...)
                       │
                       ├── mock/       in-memory fixtures        ← today
                       └── http/       @plastago/api-client      ← when endpoints exist
```

## Why no endpoint paths live here

Days 1–3 are frontend-only so that **the API contract falls out of real UI needs
rather than being guessed** (§6A.9, §13.1). Writing
`POST /api/v1/auth/otp/request` into this layer now would be inventing the
contract before the screens have told us what they need — and the contract
freezes at day 3, so a guess becomes expensive.

What is committed instead is the **shape**: the method signatures in `types.ts`
and the Zod schemas in `@plastago/shared`. Those are the requirement. Paths get
chosen when the endpoints are written, and only the HTTP adapter learns them.

## Adding the real backend

1. Add the endpoint to `packages/shared/src/openapi/document.ts` (schemas are
   already in `schemas/identity.ts`) and run `npm run openapi`.
2. Create `services/http/auth.http.ts` implementing `AuthService` over
   `api.request(...)`, translating `ApiRequestError.code` → `ServiceErrorCode`.
3. Create `services/http/create-http-services.ts`.
4. In `main.tsx`, swap `createMockServices()` for `createHttpServices(api)`.

No screen changes. That is the point of the seam.

## Error handling

Everything throws [`ServiceError`](./service-error.ts) with a `ServiceErrorCode`.
The UI branches on `code`, never on an HTTP status — a component that tests
`status === 409` is coupled to a transport it does not currently use.

User-facing copy for each code lives in the UI layer
(`lib/error-message.ts`, `features/auth/auth-messages.ts`), because the right
wording depends on what the user was doing.

## Adding a domain

One interface per domain on `Services`, one implementation per adapter. Lists use
`ListQuery` / `ListResult<T>`, which mirror `PageQuerySchema` and `pageOf()` in
`@plastago/shared` so the paged envelope never diverges from the contract.
