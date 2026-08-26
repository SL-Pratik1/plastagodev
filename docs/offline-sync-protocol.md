# Offline sync protocol

> **Status: DRAFT — must be agreed and signed off before either driver
> implementation starts** (§6A.4 mitigation 1, §13.5 rule 3).
>
> This document is the **single contract** that two independent
> implementations follow:
>
> | Implementation | Repo                       | Local store       |
> | -------------- | -------------------------- | ----------------- |
> | React PWA      | `plastago-web/apps/driver` | Dexie / IndexedDB |
> | Flutter native | `plastago-mobile`          | Drift / SQLite    |
>
> _Two implementations against one written contract is safe. Two implementations
> against a vague shared understanding is how they silently diverge_ — and here
> the second one is in a different language, in a different repo.
>
> **What is already implemented** (in the PWA, and mirrored in the Drift schema)
> is marked ✅. **What still needs a decision** is marked ❓ — those are the gaps
> to close in the day 1–3 window.

---

## 1. Principles

1. **Every write goes through the outbox**, online or offline. There is no
   separate online path, so the offline path cannot rot from disuse. ✅
2. **The driver can always see queue state.** A queue draining invisibly is
   indistinguishable from a stuck one, and with no error-tracking vendor
   (§6A.8) the driver is the only person who can report it. ✅
3. **API responses are never cached by the service worker.** Offline reads come
   from the local database. A stale run sheet that looks live is worse than no
   run sheet. ✅
4. **Never lose driver-captured evidence.** Photos, GPS and timestamps taken on
   site cannot be recreated. Signing out, a token expiry, or a schema migration
   must not clear the queue. ✅

---

## 2. The operation log

An operation is an intent to mutate, recorded locally first.

| Field            | Type                                   | Notes                                                      |
| ---------------- | -------------------------------------- | ---------------------------------------------------------- |
| `idempotencyKey` | UUID v4                                | Client-generated. Sent as the `idempotency-key` header. ✅ |
| `method`         | `POST` \| `PATCH` \| `PUT` \| `DELETE` | ✅                                                         |
| `path`           | string                                 | Versioned API path. ✅                                     |
| `body`           | JSON                                   | ✅                                                         |
| `createdAt`      | UTC ISO-8601                           | The ordering key. ✅                                       |
| `attempts`       | int                                    | ✅                                                         |
| `status`         | `pending` \| `syncing` \| `failed`     | ✅                                                         |
| `lastError`      | string?                                | Surfaced to the driver. ✅                                 |
| `nextAttemptAt`  | UTC ISO-8601?                          | Backoff gate. ✅                                           |

### Ordering guarantee

**Operations replay strictly in `createdAt` order, and the drain STOPS on the
first retryable failure.** ✅

This is not a performance choice. Skipping ahead would let a later action land
before an earlier one — `Completed` arriving before `Arrived` — which corrupts
the on-site duration that the **Extra Load Time** charge is computed from
(Risk 2, M6.7). A wrong duration is a wrong invoice.

### Backoff

Exponential from 2 s, doubling, capped at 5 minutes. Maximum 8 attempts, after
which the operation stays `failed` and is surfaced for manual attention. ✅

❓ **Decision needed:** what happens at attempt 8? Options: hold indefinitely and
alert the office; or expose a "retry now" action to the driver. Recommendation:
both — the office queue is the safety net, the driver button is the fast path.

---

## 3. Idempotency

The client generates the key; the server must honour it.

**Server contract** ❓ _— to implement with the auth/jobs domains:_

- On receiving `idempotency-key`, look up a completed request with that key.
- If found, return the **original response** with the original status code. Do
  not re-execute.
- If not found, execute inside the same transaction that records the key
  (§6A.3 #3) — so a crash between "did the work" and "recorded the key" is
  impossible.
- ❓ **Retention window:** how long are keys remembered? A driver can be offline
  for a full shift. **Recommendation: 7 days**, comfortably longer than any
  plausible offline period, and cheap at ~7 jobs/day.

---

## 4. Conflict resolution

**Last-write-wins with server arbitration.** The server's clock is
authoritative; a device clock is never trusted for ordering across devices.

The client sends `createdAt` for audit, not for arbitration.

### Conflict cases that must be handled explicitly

❓ _Each needs a decision. These are the ones that actually happen:_

| #   | Case                                                                    | Proposed handling                                                                                                                                               |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Job **reallocated** to another driver while this driver held it offline | Server rejects with `409 CONFLICT`. Non-retryable. Driver told plainly: "Job 61402 was reassigned." Captured photos are still uploaded and attached to the job. |
| 2   | Job **cancelled** after the driver marked it arrived                    | Accept the status events (they are evidence), but block completion. The futile/attendance charge decision goes to the office queue.                             |
| 3   | **Two devices, one account** — driver's phone plus a spare              | Accept both; server orders by receipt time. Flag divergence for the office.                                                                                     |
| 4   | Driver edits a weight offline; office edits it too                      | Server wins. Client shows the corrected value on next sync with a note that it changed.                                                                         |
| 5   | Same operation replayed after a **timeout** the client never saw        | Idempotency key returns the original response. §3.                                                                                                              |

> ⚠️ **Case 1 and 2 are why "last-write-wins" alone is not a specification.**
> Blindly overwriting would let a driver's stale offline action resurrect a
> cancelled job. Every conflict class needs a named outcome.

---

## 5. Photos and documents — a separate queue

Files use their **own resumable queue**, not the operation log. ✅

Why separate: a 4 MB photo on a weak cell must not block a 200-byte status
change. A driver whose status updates are stuck behind a photo upload looks
offline to the office when they are not.

- Files go **presigned direct-to-S3** and never stream through the API
  (§6A.10 #9).
- The local row stores a **file path**, not the bytes. ✅
- Uploads are resumable across app restarts and must survive the app being
  killed mid-upload.
- An operation may reference files by `idempotencyKey`; the server tolerates the
  operation arriving **before** its files and links them on arrival.

❓ **Decisions needed:** presigned URL TTL (recommendation: 24 h, re-requested on
expiry); whether to downscale on device before upload (recommendation: yes —
10–20 photos per job at full resolution is a lot of mobile data, and the evidence
value does not need 12 MP).

---

## 6. Reads while offline

- Today's run sheet and job detail are cached in the local database on each
  successful sync.
- Every offline read is visibly marked with **when it was last refreshed**. A
  driver must never mistake yesterday's run sheet for today's.
- ❓ **Decision needed:** how far ahead to pre-cache. Recommendation: today plus
  tomorrow — enough for an early start with no signal, small enough to sync fast.

---

## 7. Observability

Error tracking was removed by decision (§6A.8), so the sync path must report on
itself **inside the product**:

- `lastSuccessfulSyncAt` per device ✅
- `syncFailureCount` per device ✅
- Both surfaced on the **admin dashboard** (M9.4) — so a stuck queue is visible
  to the office, not only in logs. ❓ _endpoint not yet built_

> The realistic failure mode here is a **silent sync failure that nobody notices
> for days**. These two counters are the entire defence.

---

## 8. Sign-off

| Role                | Name | Date |
| ------------------- | ---- | ---- |
| Author (mobile dev) |      |      |
| Backend             |      |      |
| Web / PWA           |      |      |

**Do not start either implementation until all ❓ items above are resolved and
this page is signed.**
