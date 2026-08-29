# Offline layer

The driver app is **offline-first, not offline-tolerant**. Drivers work in
greenfield estates with no coverage; a driver app that fails offline is worse
than paper (§M4).

## What is here

| File                   | Role                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `db.ts`                | Dexie schema — `outbox`, `uploads`, `meta`. Domain-free by design. |
| `outbox.ts`            | Enqueue + sequential drain with idempotency keys and backoff.      |
| `use-offline-state.ts` | Live queue counts and connectivity for the UI.                     |

## The one thing that must happen before real driver features are built

> **Write the offline sync protocol down, once, before either implementation
> starts** (§6A.4 mitigation 1, §13.5 rule 3).

Two implementations against one written contract is safe. Two implementations
against a vague shared understanding is how they silently diverge — and here the
second implementation is in a **different language, in a different repo**
(Flutter + Drift).

The spec must cover:

1. **Operation log** — the shape of a queued mutation and its ordering guarantee.
2. **Idempotency keys** — client-generated, sent as `idempotency-key`, and how
   long the server remembers them.
3. **Last-write-wins with server arbitration** — which clock wins, and how the
   client learns it lost.
4. **Explicit conflict cases** — job reallocated while the driver held it; job
   cancelled after they marked it arrived; two devices on one account.
5. **Photos as a separate resumable queue** — presigned direct-to-S3
   (§6A.10 #9), never streamed through the API, resumable across app restarts.

## Rules this implementation follows

- **Every write goes through `enqueue()`**, online or offline. There is no
  separate online path, so the offline path cannot rot from disuse.
- **The queue drains strictly in order and stops on the first retryable
  failure.** Skipping ahead would let "completed" land before "arrived", which
  corrupts the on-site duration the Extra Load Time charge is computed from.
- **API responses are never cached by the service worker.** Offline reads come
  from IndexedDB. A stale run sheet that looks live is worse than no run sheet.
- **The driver can always see queue state.** A queue draining invisibly is
  indistinguishable from a stuck one, and with no error-tracking vendor
  (§6A.8) the driver is the only person who can report it.

## Parity checklist

Every driver feature is now a **two-place change** — React PWA and Flutter — and
the second place is the one that gets forgotten. Keep a living parity checklist
(§6A.4 mitigation 2) and treat it as a test document, not a wiki page.
