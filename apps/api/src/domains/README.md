# Domains

**One folder per domain. Four files per domain. No exceptions** (§6A.7).

```
domains/<domain>/
├─ <domain>.router.ts        paths + middleware. No logic.
├─ <domain>.controller.ts    HTTP in / HTTP out. No business rules, no Mongoose.
├─ <domain>.service.ts       business rules. No Express, no Mongoose.
├─ <domain>.repository.ts    the ONLY file that touches Mongoose (§6A.3 #5).
└─ <domain>.model.ts         Mongoose schema + model (add when the domain persists).
```

`health/` is a working reference implementation of the pattern — read it before
adding a domain.

## Why the layering is strict

MongoDB enforces no referential integrity, so integrity lives in application
code — which means it must live in **exactly one place per aggregate** (§6A.3 #5).
The moment a controller or service issues its own query, that guarantee is gone
and nobody can tell by reading a file whether it still holds.

## Rules that will be reviewed

1. **Only the repository imports `mongoose`.** Lint for it if it starts drifting.
2. **Every route that takes input uses `validate()`** with a schema from
   `@plastago/shared`. No hand-rolled checks.
3. **Every async controller is wrapped in `asyncHandler`.**
4. **Money is `Decimal128`** in the model and a decimal string on the wire
   (§6A.10 #1). Never `Number`.
5. **Multi-tenant reads are scoped by role** — a Site Supervisor query must be
   constrained in the repository, not filtered in the controller.
6. **Writes that span documents use `withTransaction`** (§6A.3 #3).

## Domains to come

Named here so folder names stay consistent as the team fans out. Each maps to a
module in `08-MVP-20-DAY-SCOPE.md`:

| Folder          | Module                                           |
| --------------- | ------------------------------------------------ |
| `auth`          | M1.5 — OTP, JWT, sessions, RBAC                  |
| `accounts`      | M2.8 — Account / Builder / Site / Contact (M1.2) |
| `jobs`          | M2.1–M2.5                                        |
| `allocation`    | M3                                               |
| `pricing`       | M6 — plus the regression harness (Risk 1)        |
| `invoicing`     | M7                                               |
| `notifications` | M8                                               |
| `reporting`     | M9                                               |
| `documents`     | photos, PDFs, S3 presigning                      |
| `audit`         | M1.6 — change-stream-fed, append-only            |
