# Architecture

How the running system fits together, and — more usefully — **where each guarantee is actually
enforced, and which test proves it.** The design rationale lives in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); the rejected alternatives live in
[docs/DECISIONS.md](docs/DECISIONS.md). This document is the runtime view.

## Processes

| Process | What it is | Notes |
|---|---|---|
| `server` | Express 5 API, one Node process | Holds the JWT, the saga, the reaper timer |
| `mongod` | A **single-node replica set** | Mandatory: a standalone cannot run transactions |
| `client` | Vite dev server serving the React SPA | Talks to the API over CORS |

The replica set is not a production nicety here — it is a correctness requirement, so `connectDb`
and the test harness both assume one, and `scripts/dev-mongo.mjs` exists to provide it without
Docker.

## Module map, and the rule that keeps it honest

```
routes/      thin HTTP translation: auth guard -> rate limit -> Zod -> handler
services/    orchestration: the checkout saga, idempotency, expiry, settlement
domain/      pure or near-pure logic; takes an optional Mongo `session`
models/      schemas, indexes, and the `.toPublic()` presentation boundary
db/          connection, the ONE session helper, the $jsonSchema validators
```

**Routes never touch models, and `domain/` never touches `req`/`res`.** Two consequences worth the
discipline: the pricing engine and the state machine are unit-testable with zero infrastructure, and
the checkout saga reads as a sequence of compensable steps instead of being buried in a controller.

## Flow 1 — checkout

```
POST /api/checkout   Idempotency-Key: <uuid>   Authorization: Bearer <jwt>
 │
 ├─ requireAuth -> rateLimit(per customer) -> validate(checkoutSchema)
 ├─ canonicalise the cart (merge duplicates, sort) -> sha256 requestHash
 ├─ CLAIM the key with a bare insert, OUTSIDE any transaction
 │     unique index {customerId, endpoint, key} is the arbiter
 │     -> replay | retryable | takeover | conflict(422) | in_flight(409 after a bounded wait)
 ├─ load the catalogue; price SERVER-SIDE (client prices are never read)
 ├─ fast-fail pre-check (advisory; see the measurement in the plan) + targeted reclaim if short
 ├─ expectedTotalMinor mismatch -> 409 PRICE_CHANGED
 ├─ TX1  reserve(items) + Order(status=pending_payment) + claim.orderId     [atomic]
 │       paymentLeaseExpiresAt is set HERE, inside TX1 (see note below)
 ├─ CHARGE the gateway, outside any transaction, timeoutMs < lease
 │     accepted  -> TX2  CAS pending_payment->paid, capture(items), claim->completed   201
 │     declined  -> TX3  CAS pending_payment->payment_failed, release(items), claim->failed  402
 │     timeout   -> lease cleared, order left pending, claim->completed with a poll URL  202
 └─ on failure: finalizeFailure -> release the claim (request-shaped) or mark it failed (business)
```

Two details that are easy to get wrong and are therefore deliberate:

- **The claim is completed inside the same transaction that commits the order.** "The order exists"
  and "the key is spent" cannot disagree.
- **The payment lease is taken at order creation, inside TX1**, rather than after it. The plan
  originally had it as a separate write immediately before the charge; moving it one step earlier
  closes the window between TX1 committing and the lease being set, during which the reaper could
  expire an order whose payment was imminent. One write instead of two, and strictly safer.

## Flow 2 — out-of-band resolution

A `202` means the gateway accepted the charge and then went silent. Two things can resolve it, and
both call the *same* function, so neither can take a route the inline saga would not:

- `POST /api/webhooks/payments/simulated` — HMAC over the raw bytes (`timingSafeEqual`), plus an
  amount check against the order total (`AMOUNT_MISMATCH` if it disagrees). A signature proves who
  sent it, not that the amount is right.
- `POST /api/admin/orders/:id/reconcile-payment` — the operator's path.

Both funnel into `settleSuccess`/`settleFailure`, whose first act is a compare-and-swap on the order
status. A duplicate webhook for an already-paid order is a **no-op**, not a fabricated refund. A
charge that lands after the reaper expired the order is recorded as an explicit refund obligation,
surfaced by `GET /api/admin/inventory/refund-obligations`.

## Flow 3 — expiry and reclaim

Stock is released from two directions, and the second one is the important one:

- **Timer (hygiene).** `startReaper()` sweeps every `REAPER_INTERVAL_MS`. It expires only orders
  whose reservation **and** payment lease have both lapsed, and it does the status CAS and the stock
  release in one transaction.
- **Demand (correctness).** When a reservation fails for want of stock, the checkout service runs a
  **targeted** sweep for that cart's products and retries once, bounded by `MAX_RESERVE_ATTEMPTS`.
  So a crashed checkout's hold comes back at the moment someone needs it. With the timer disabled,
  the system is still correct — only tidier.

## Where each guarantee lives

| # | Guarantee | Enforced in | Proven by |
|---|---|---|---|
| F1 | Stock can never be oversold | `domain/inventory.js` — conditional `$inc` in one operation | `tests/concurrency/oversell.test.js` (200 buyers, 10 units) |
| F2 | A cart commits wholly or not at all | `services/checkout.service.js` TX1 + `db/transaction.js` | partial-failure test: 3-item cart reserves zero |
| F3 | Failed/abandoned holds return their stock | `services/expiry.service.js` + `paymentSettlement.service.js` | `tests/integration/expiry.test.js`, `tests/concurrency/compensation.test.js` |
| F4 | A retry produces exactly one order | `services/idempotency.service.js` + the unique index | `tests/concurrency/duplicate.test.js` (50-way), `tests/integration/idempotency.test.js` |
| F5 | A crash mid-charge is detected, not ignored | two-phase lease + refund obligation | `tests/integration/payments.test.js` |
| — | Negative counters are impossible *at the database* | `db/validators.js` `$jsonSchema` | `tests/unit/inventory.test.js` bypasses the service layer |
| — | Money is exact | `domain/pricing.js` (integers only, tax rounded once) | `tests/unit/pricing.test.js`, `tests/property/pricing.property.test.js` |
| — | Counters stay consistent | `domain/invariants.js` (I1–I7), run in a global `afterEach` | every integration and concurrency test |
| — | Compensations happen exactly once | `domain/orderState.js` — the status CAS | reaper-vs-payment race test |

Each row is a *mechanism plus its evidence*, because a guarantee without a test that would fail if
the mechanism were removed is a claim, not a property.

## Operational surface

- **Config** (`config/index.js`) — every tunable, Zod-validated at boot. Bad configuration fails at
  startup, not at 3am on the checkout path. Cross-field rules are asserted too: `GATEWAY_TIMEOUT_MS <
  PAYMENT_LEASE_MS`, so a charge always resolves before its own lease can lapse. An env var that is
  present but **empty** is treated as unset, because shells and platforms export empty placeholders.
- **Logging** (`lib/logger.js`, `middleware/context.js`) — JSON lines, one per event, with the
  request's `requestId` on every line and echoed as `X-Request-Id`. Commands slower than
  `SLOW_QUERY_MS` are logged with the **server's** own reported duration (`db/connect.js`), not a
  client-side timer that would also count time spent queued for a connection.
- **Shutdown** (`server.js`) — stop accepting, drain in-flight requests, stop the reaper, close
  Mongo. An interrupted checkout is not a leaked reservation, because the demand path reclaims it.
- **Limits** — per-customer rate limit on `/api/checkout`, `100kb` JSON body cap, Helmet, a CORS
  allowlist, and `MAX_CART_LINES`/`MAX_LINE_QUANTITY` at the schema.
- **Security** — JWT with role checks, ownership checks on every order read, HMAC webhooks, no price
  accepted from the client, and every write path taking its input through Zod in middleware, so no
  raw request body reaches a query.

## Reading order

1. [README.md](README.md) — run it and see the Concurrency Lab.
2. `domain/inventory.js` and `domain/orderState.js` — the two primitives everything else rests on.
3. `services/checkout.service.js` — the saga, in the order it executes.
4. `docs/DECISIONS.md` — why, and what was rejected.
5. [docs/VERIFICATION.md](docs/VERIFICATION.md) — what was checked against the plan, and what was
   found wanting.
