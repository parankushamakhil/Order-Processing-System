# Verification against the implementation plan

An audit of every checkable claim against the
delivered code, performed after the build. It found **three unimplemented deliverables** and
**eight descriptions that did not match what was built**. Everything in the first group was
implemented; everything in the second was corrected in the plan.

## Result at a glance

| | Count |
|---|---|
| Claims verified as implemented **and** evidenced by a test or a run | the bulk of §1–§10 — see below |
| Promised but missing → **implemented** | 2 |
| Promised but missing → **written** | 1 (`ARCHITECTURE.md`) |
| Plan described the system inaccurately → **plan corrected** | 8 |
| Checks that could not be run | 0 |

Final state: **169 tests pass** across 16 files (16 integration + unit + property + concurrency
suites), the seed script runs its assertions clean, the benchmark completes with every scenario
correct, and the client builds.

---

## 1. Promised but not implemented — all now fixed

### 1a. Slow-query logging (§9) — was absent, and then silently inert

The plan states: *"Structured JSON logs with a `requestId` on every line, echoed as `X-Request-Id`;
slow queries logged with their duration."* The `requestId` half was real
(`middleware/context.js`). The slow-query half did not exist anywhere in the codebase.

Implemented in `db/connect.js` as driver command monitoring, with `SLOW_QUERY_MS` (default 250) added
to the config. The driver's own reported `duration` is used rather than a client-side timer, because
a client-side timer also counts time spent queued for a connection — under load, a saturated pool
would report every query as slow and drown the signal.

**The first implementation was dead code and the verification caught it.** The driver defaults
`monitorCommands` to `false`, so the listeners attached cleanly, compiled cleanly, and never fired.
Measured before the fix: `commandStarted: 0, commandSucceeded: 0`. This is the failure mode the plan
itself warns about elsewhere — a mechanism that *looks* alive. After adding
`monitorCommands: true`:

```
SLOW_QUERY_MS=0   -> {"level":"warn","msg":"slow query","command":"aggregate","durationMs":1,...}
default threshold -> no slow-query lines for a fast query
```

### 1b. The Phase 1 integer-storage assertion (§3.4, §10) — was absent

The plan makes this an explicit Phase 1 task: *"a Phase 1 seed assertion must verify it, because a
stray fractional value would be stored as a `double` and then rejected by the validator."* No such
assertion existed. The collection validators were correct and separately tested; the check that
money and stock actually round-trip as BSON integers was not.

Implemented in both places it is useful:

- `scripts/seed.js` asserts that no product stores `priceMinor`, `onHand`, `reserved` or `available`
  as a BSON `double`, and fails the seed loudly if one does. Verified by running it:
  `Integer storage: 6 product(s) checked, 0 stored as BSON double.`
- `tests/integration/products.test.js` gained two tests: one asserting the stored types, and one
  proving the validator rejects a fractional value on `updateOne` — which also demonstrates that the
  backstop is enforced on query-based updates, not only on `save()`.

### 1c. `ARCHITECTURE.md` (Phase 10) — was missing

Phase 10's deliverable list names it. Written as
architecture documentation: the process/module map, the three runtime flows, and a
**guarantee → where it is enforced → which test proves it** table, which is deliberately distinct
from the README (how to run it) and the plan (why it was built this way).

---

## 2. The plan described the system inaccurately — plan corrected

None of these were code defects; the code was right and the document had drifted. All eight are now
fixed in the plan, with the reason recorded rather than silently overwritten.

| # | Plan said | Code has |
|---|---|---|
| 1 | Product index: *text on `name`/`description`* | `{name: 1}` prefix index; the text index was **deliberately rejected** (whole-word stemming is worse for catalogue search) |
| 2 | Product index: `{available: 1, isActive: 1}` | `{isActive: 1, available: 1}` (same index, order chosen for the prefix scan) |
| 3 | `PaymentAttempt.errorCode` | `providerCode` and `providerMessage`, kept separate from the derived `status` |
| 4 | `paymentLeaseExpiresAt` set at step 7, after TX1 | set **inside TX1** — a deliberate strengthening that closes the window between committing and setting the lease |
| 5 | `priceOrder({ lines, taxRateBps, shippingRule, discount })` | `{ lines, taxRateBps, discountCode }`; shipping is module-level constants, and the plan now says why that is enough |
| 6 | `POST /api/admin/expiry/sweep` | `POST /api/admin/inventory/sweep` |
| 7 | Endpoint table omitted `/api/auth/me`, `/api/admin/inventory/refund-obligations`, `/api/admin/orders/:id/reconcile-payment`, `/api/admin/concurrency-lab` | all four exist |
| 8 | §2.1 file tree omitted `db/transaction.js`, `domain/orderStatus.js`, `domain/presentation.js`, `services/paymentSettlement.service.js`, `validation/schemas.js`; claimed `lib/` holds *requestId, money, clock* | tree now matches the tree on disk; `requestId` is middleware, and there is no `money.js`/`clock.js` |

Two further documentation corrections were made during the build rather than the audit, and are
recorded in place: the §9.1 contention section (see below) and the `$lte`/`null` predicate correction
(ADR-08), which was a real bug found by a test.

---

## 3. Verified as implemented, with evidence

Abbreviated; each item was read in the source and, where a test exists, confirmed to pass.

**§1, §2.2 — the five failure modes and eight defence layers.** All five mechanisms exist and each is
covered: the conditional `$inc` (`domain/inventory.js`), the multi-document transaction
(`db/transaction.js` with `readConcern: snapshot` / `writeConcern: majority`), reserve→capture with
compensations, the idempotency claim, and the two-phase lease with the refund-obligation path. All
eight layers are present, including the `$jsonSchema` backstop proven by a test that bypasses the
service layer.

**§2.3 — versions.** Checked against `node_modules`, not against the plan's intent: Node 24.21,
Express 5.3, Mongoose 9.11, Zod 4.6, Vitest 5.0, supertest 7.3, mongodb-memory-server 11.3, React
19.3, Vite 8.3, fast-check 4.10. Every version claim in the table is accurate.

**§3 — data model.** Product, Order, IdempotencyKey, PaymentAttempt, Customer and Counter match,
including every index the plan names (unique `sku`, unique `orderNumber`, the reaper's composite
index, `{items.productId, status}` for targeted reclaim, the unique idempotency claim, the TTL on
`expiresAt`, and `{provider, idempotencyKey}` which is what makes "charge once per order" a database
guarantee). Validators use `collMod`/`createCollection` idempotently with
`validationLevel: strict`, `validationAction: error`, `minimum: 0` on all three counters.

**§4 — primitives.** `reserve` sorts by `productId`, filters on `isActive` and `available >= q`, and
checks `matchedCount`; `release` and `capture` carry `reserved >= q` guards so a double compensation
cannot drive a counter negative. `withTransaction` is the only place a session is opened, and the
claim classification order matches ADR-07 exactly (retention → intent → state).

**§5 — the saga.** Flow verified step by step against `checkout.service.js`: canonicalisation, the
request hash (excluding the payment token, for the documented reason), claim, `422` on conflict,
replay, bounded wait for a concurrent duplicate, TX1, charge outside the transaction, TX2/TX3, and
the `202` path. `settleSuccess` treats a duplicate webhook for an already-paid order as a **no-op**
and only records a refund obligation when the order was settled some other way — the distinction the
plan draws. `settleFailure` refuses to release stock for an order that is already paid.

**§5.3 — reaper.** The `$or` predicate with the explicit `{ paymentLeaseExpiresAt: null }` branch is
present and carries the comment explaining why `$lte` would be wrong; `released++` is outside the
transaction callback; the targeted-reclaim path is reachable from checkout, bounded by
`MAX_RESERVE_ATTEMPTS`.

**§5.5 — pricing.** Pure (no DB, no clock), integer-only, tax rounded once at order level, discount
clamped to the subtotal, `engineVersion` persisted, and a structural check that the components
reconstruct the total — in production as well as in tests.

**§6 — API.** All endpoints, statuses and headers verified, including `Retry-After`,
`Idempotency-Replayed` and `X-Request-Id`. The whole of `/api/admin` is behind one
`router.use(requireAuth, requireAdmin)`. The error table was incomplete rather than wrong: ten codes
that exist were undocumented and are now listed (`PAYMENT_FAILED`, `ORDER_NOT_PENDING`,
`ORDER_CANCELLED`, `RATE_LIMITED`, `ILLEGAL_TRANSITION`, `PRICING_ERROR`, `INVARIANT_VIOLATION`,
`DUPLICATE_KEY`, `INVALID_SIGNATURE`, `AMOUNT_MISMATCH`).

**§7 — client.** Cart in `localStorage`; the idempotency key is persisted **with a cart fingerprint**
and reused across retries but regenerated when the cart changes, which is the subtle half of the
requirement; status handling covers `201`, `202` (with polling), `402`, `409 OUT_OF_STOCK` with
per-item availability, `409 CHECKOUT_IN_PROGRESS` with auto-retry, and the Concurrency Lab exists.

**§9 — operations.** Helmet, a CORS allowlist, a `100kb` body cap, a per-customer rate limit on
checkout, JWT with role checks, ownership checks, HMAC verification over raw bytes with
`timingSafeEqual` plus an amount check, graceful shutdown (stop accepting → stop the reaper → close
Mongo), and JSON logs carrying the request id.

**§10 — build order.** Phases 0–10 each have their acceptance criterion satisfied. Phase 8's "run it
5× without flakes" was executed: five consecutive concurrency runs, zero flakes.

---

## 4. Limitations, stated rather than hidden

1. **No client-side test suite.** §2.3 and ADR-12 describe Vitest as one runner for server and
   client; the tooling could run client tests, but none exist. The client is verified by building it,
   by exercising it in a browser (a real purchase, the Lab, the admin reconcile view), and by reading
   its compiled bundle — not by automated tests.
2. **No CI configuration in the repository.** "Run the concurrency suite 5× in CI" is a documented
   practice that was performed manually; nothing enforces it on future changes.
3. **The herd figure in the benchmark is near the noise floor.** Documented in
   [README.md](../README.md) and §9.1, including the methodology bug that produced two confident and
   opposite wrong answers before the pairing was added.
4. **`scripts/bench.mjs` is destructive to the database it is pointed at** — it deletes all orders,
   payment attempts and idempotency keys. Run it against a scratch database (the docs do), because
   this is a sharp edge, not a sandbox.
5. **Payments are simulated** behind a gateway interface, by design and in scope; the interface is
   the seam where a real provider drops in.
6. **Verification is by inspection, execution and tests — not by formal proof.** The claim being made
   is that every documented mechanism exists, is reachable, and is covered by a test that would fail
   if it were removed. That is a strong claim here; it is not the same as proving the design optimal.
