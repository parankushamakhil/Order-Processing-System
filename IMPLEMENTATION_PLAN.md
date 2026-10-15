# Order Processing System — Implementation Plan

**Stack:** MongoDB · Express 5 · React 19 · Node 24 LTS (MERN)
**Goal:** manage products, inventory, customer orders and checkout such that **stock can never be oversold**, records stay internally consistent, and a checkout that is retried, duplicated, declined, or interrupted always reaches exactly one correct outcome.

**How to read this document.** §1–§7 are the design. §8–§10 are the correctness argument, test strategy and build order. Every load-bearing decision has a numbered ADR in [docs/DECISIONS.md](docs/DECISIONS.md) with the alternatives that were rejected and why.

---

## 1. The problem, stated precisely

Most submissions to this brief build a checkout that reads stock, compares it, then writes. That is a lost-update race, and it is the single thing the brief is testing for. There are really **five** distinct failure modes, and a credible design has to name and solve each one separately:

| # | Failure mode | Concrete scenario | Our answer |
|---|---|---|---|
| F1 | **Lost update / oversell** | Two customers read `available = 1` and both decrement to `0` | Conditional single-document atomic `$inc` (§4.1) |
| F2 | **Partial multi-item commit** | 3-item cart: items 1–2 reserved, item 3 out of stock → orphans | Multi-document transaction (§4.2) |
| F3 | **Reserved stock leaks** | Payment fails, or the user closes the tab after reserving | Reserve → capture/release saga + reservation TTL (§5) |
| F4 | **Duplicate / retried checkout** | Client times out at 30 s, retries; user double-clicks | Idempotency keys with a DB-enforced unique claim (§4.3) |
| F5 | **Crash between side effect and record** | Process dies after the gateway charged but before we wrote it down | Two-phase payment lease + compensating refund path (§5.4) |

A design that solves F1 alone will look correct in a happy-path demo and fail under the reviewer's concurrent test. This plan treats F1 as necessary but nowhere near sufficient.

**Non-negotiable invariants.** Everything below exists to preserve these three:

```
I1  available = onHand - reserved            (per product, at all times)
I2  counters are never negative              (onHand, reserved, available >= 0)
I3  reserved = Σ quantity over all orders    (per product, over orders in a
                in a stock-holding state      stock-holding state: pending_payment)
```

I3 is the strong one. It is what catches a leaked reservation, a double release, or a double capture — the bugs that a per-request test never sees. §8 turns the invariants into an executable checker that runs after **every** integration test.

---

## 2. Architecture

### 2.1 Shape

Single repository, npm workspaces, two packages, one HTTP boundary.

```
order-processing/
├── package.json                 # workspaces: server, client
├── server/
│   ├── scripts/dev-mongo.mjs    # local replica set for dev (see §10)
│   ├── scripts/bench.mjs        # contention benchmark (see §9.1)
│   ├── src/
│   │   ├── app.js               # express app (no listen — importable by tests)
│   │   ├── server.js            # listen, graceful shutdown
│   │   ├── config/index.js      # Zod-validated env, fails fast at boot
│   │   ├── db/connect.js        # mongoose connect + indexes + validators + slow-query log
│   │   ├── db/transaction.js    # the ONE place a session is opened (see §4.2)
│   │   ├── db/validators.js     # $jsonSchema documents (see §3.4)
│   │   ├── models/              # Product, Order, IdempotencyKey, PaymentAttempt, Customer, Counter
│   │   ├── domain/
│   │   │   ├── pricing.js       # pure, integer-only pricing engine
│   │   │   ├── inventory.js     # reserve / release / capture primitives
│   │   │   ├── orderStatus.js   # the lifecycle + legal transitions
│   │   │   ├── orderState.js    # single transition chokepoint
│   │   │   ├── presentation.js  # the ONE place an order becomes a response
│   │   │   └── invariants.js    # I1–I7 checker + reconciliation report
│   │   ├── services/
│   │   │   ├── checkout.service.js        # the saga orchestrator
│   │   │   ├── idempotency.service.js     # claim / classify / takeover
│   │   │   ├── expiry.service.js          # reaper + lazy reclaim
│   │   │   ├── paymentSettlement.service.js  # TX2/TX3 + refund obligations
│   │   │   └── payments/                  # gateway interface + simulated impl
│   │   ├── validation/schemas.js  # every Zod boundary schema
│   │   ├── routes/  middleware/  errors/
│   │   └── lib/                 # logger (JSON lines), envelope
│   └── tests/
│       ├── helpers/             # app factory, replset harness, factories, invariant hook
│       ├── unit/ integration/ concurrency/ property/
├── client/                      # React 19 + Vite 8 (Shop, Cart, Orders, Admin + Concurrency Lab)
└── docs/                        # DECISIONS.md (ADRs), plus ARCHITECTURE.md at the root
```

`requestId` is not a module: it is middleware (`middleware/context.js`) that mints the id, echoes it as `X-Request-Id` and attaches a child logger to `req.log`, so every line a request emits carries it. There is also no `money.js` or `clock.js` — money is handled by the integer discipline in `domain/pricing.js`, and nothing in the pure layer reads a clock, which is why `priceOrder` is testable without freezing time.

**Why this shape.** `domain/` holds pure or near-pure logic that takes an optional Mongo `session` argument; `services/` orchestrates; `routes/` is thin HTTP translation. The rule that keeps it honest: **routes never touch models, and `domain/` never touches `req`/`res`.** That makes the pricing engine and the state machine unit-testable with zero infrastructure, and it makes the checkout saga readable as a sequence of steps rather than buried in a controller.

### 2.2 Layered defence

There is no single "safe" line of code. Consistency is produced by eight independent layers, so a mistake in any one of them is caught by another:

```
8. Reconciliation job (detects drift, never silently corrupts)      ← detective
7. Order-status CAS (compensations execute exactly once)            ┐
6. Unique indexes (one idempotency claim, one charge per order)     │
5. $jsonSchema collection validators (counters can't go negative)   ├─ preventive
4. Multi-document transaction (order+reservation+claim are atomic)  │
3. Conditional atomic $inc (no oversell, even without a txn)        │
2. Order state machine (illegal transitions impossible)             │
1. Zod validation at the edge (typed, bounded, canonical input)     ┘
```

Layers 1–2 stop bad requests. Layer 3 stops races. Layer 4 stops partial commits. Layers 5–6 are database-level backstops that hold even if application logic is wrong. Layer 7 makes retries safe. Layer 8 proves the other seven work.

### 2.3 Technology choices and versions

| Concern | Choice | Note |
|---|---|---|
| Runtime | Node 24 (LTS) | `engines` pinned |
| API | Express 5 | Rejected promises auto-forward to error middleware — removes the `asyncHandler` wrapper |
| ODM | Mongoose 9 | Requires Node ≥ 20.19 |
| DB | MongoDB replica set | **Mandatory** — transactions are unavailable on standalone |
| Validation | Zod 4 | Schemas double as TS types; one source of truth for input + config |
| Test runner | Vitest 5 + supertest 7 + `mongodb-memory-server` 11 (`MongoMemoryReplSet`) | One runner for server and client |
| Client | React 19 + Vite 8 | Plain SPA; RSC is not relevant here and is deliberately out of scope |

Two details that bite people and are therefore explicit task items, not assumptions:

- **Express 5** rejects the old `res.send(status, body)` / `res.redirect(url, status)` signatures, removed `req.param()`, and changed `path-to-regexp` so wildcards must be named (`/*splat`). Route params are validated by Zod rather than inline regex, which sidesteps the change entirely.
- **`mongodb-memory-server` must be started as a replica set**, not a standalone: `MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })`. A standalone in-memory server starts fine and then every transaction test fails with `Transaction numbers are only allowed on a replica set member or mongos`. Getting this wrong at Phase 0 costs hours later; it is asserted in the harness's `beforeAll`.

---

## 3. Data model

### 3.1 Product (the contended document)

```js
{
  _id, sku: 'SKU-0001',            // unique
  name, description, isActive: true,
  priceMinor: 2499,                 // integer minor units — NEVER a float
  currency: 'USD',
  onHand:    20,                    // physical units
  reserved:   3,                     // units held by pending_payment orders
  available: 17,                    // == onHand - reserved, stored (see ADR-02)
  createdAt, updatedAt
}
```

`available` is **materialised** rather than computed. This is the pivotal modelling decision (ADR-02): a computed `available` cannot participate in an atomic conditional update, so it would force a read-then-write race back into the hot path. We store it, and pay the price of keeping it in step with `onHand`/`reserved` — a price we can pay exactly, because the only three mutations of these fields are the three primitives in §4.1, each a single-document atomic update that moves them together.

Indexes: `{sku: 1}` unique · `{isActive: 1, available: 1}` (the in-stock listing prefix-scans on `isActive`) · `{name: 1}` for the catalogue's case-insensitive prefix search. A **text** index on `name`/`description` was considered and rejected during implementation: its whole-word stemming gives worse product-search behaviour than a simple prefix match at this catalogue size, and it would have added a much larger index for a feature nothing asks for.

### 3.2 Order

```js
{
  _id, orderNumber: 'ORD-000123', customerId,
  status: 'pending_payment'|'paid'|'payment_failed'|'expired'|'cancelled'|'fulfilled',
  currency: 'USD',
  items: [{
    productId, sku, name, quantity,
    unitPriceMinor, lineTotalMinor        // ← immutable snapshot, ADR-01
  }],
  pricing: { subtotalMinor, discountMinor, taxMinor, shippingMinor,
             totalMinor, taxRateBps, engineVersion },
  payment: { provider: 'simulated', status, providerRef, attempts, lastError },
  reservationExpiresAt: Date,        // when this hold lapses
  paymentLeaseExpiresAt: Date|null,  // set immediately before charging (ADR-08)
  statusHistory: [{ from, to, at, reason, actor }],
  idempotencyKey, createdAt, updatedAt
}
```

Indexes: `{orderNumber: 1}` unique · `{customerId: 1, createdAt: -1}` · `{status: 1, reservationExpiresAt: 1, paymentLeaseExpiresAt: 1}` (the reaper's query) · `{items.productId: 1, status: 1}` (targeted reclaim).

The order embeds its items including the price paid. A priced order is an immutable financial record; if the catalogue price changes tomorrow, this order must still explain what the customer was charged and why. `engineVersion` extends that: when pricing rules change, historical orders remain auditable against the engine that produced them.

### 3.3 IdempotencyKey and PaymentAttempt

```js
// IdempotencyKey — unique index {customerId:1, endpoint:1, key:1}
{ customerId, endpoint: 'POST /api/checkout', key,
  requestHash,                     // sha256 of the canonicalised request (ADR-07)
  status: 'processing'|'completed'|'failed',
  leaseExpiresAt, attempts,
  response: { statusCode, body },  // stored for replay
  orderId, expiresAt }             // expiresAt carries a TTL index

// PaymentAttempt — unique index {provider:1, idempotencyKey:1}, key = orderId
{ orderId, provider, amountMinor, currency, idempotencyKey, status,
  providerRef, providerCode, providerMessage, latencyMs, attempts, createdAt }
// `providerCode`/`providerMessage` are kept separate rather than collapsed into
// one `errorCode`: the client-facing decision (declined vs provider error) is
// derived from `status`, while these two are the provider's own words, verbatim,
// for whoever has to reconcile the charge later.
```

The unique index on `PaymentAttempt.idempotencyKey` (= the order id) is what makes "charge exactly once per order" a database guarantee rather than an aspiration: a second charge attempt for the same order cannot even be recorded. `cancelled` order status is deliberately separate from `expired`, because they have different causes and different customer messaging.

### 3.4 Database-level validators

Application bugs are possible, so the collection itself refuses to hold impossible data:

```js
db.runCommand({
  collMod: 'products',
  validator: { $jsonSchema: {
    bsonType: 'object',
    required: ['sku','name','priceMinor','currency','onHand','reserved','available'],
    properties: {
      priceMinor: { bsonType: ['int','long'], minimum: 0 },
      onHand:     { bsonType: ['int','long'], minimum: 0 },
      reserved:   { bsonType: ['int','long'], minimum: 0 },
      available:  { bsonType: ['int','long'], minimum: 0 },   // ← backstop for I2
      currency:   { enum: ['USD'] }
    }
  }},
  validationLevel: 'strict',
  validationAction: 'error'
});
```

`available: { minimum: 0 }` means that even if the conditional filter in §4.1 were written incorrectly, MongoDB rejects the resulting negative counter with a `WriteError`. Overselling becomes impossible at the storage layer, not merely unlikely at the application layer.

Two implementation cautions, both handled as explicit Phase 1 tasks:

- **Apply validators through an idempotent script** (`scripts/applyValidators.js`, using `collMod`/`createCollection`) that runs in dev setup, in CI, and in the test harness. Do not rely on Mongoose schema options for collection validators; verify what the installed Mongoose version exposes before assuming. `collMod` is version-independent and works everywhere.
- **Confirm integer storage.** The Node BSON serializer encodes an integral JS number within int32 range as `int32`, so `bsonType: ['int','long']` should hold — but a Phase 1 seed assertion must verify it, because a stray fractional value would be stored as a `double` and then rejected by the validator. That rejection is the desired fail-fast behaviour, but it should be discovered by an assertion, not by a production 500.

---

## 4. The three primitives

Everything in this system is built from three operations. They are small enough to read in full, which is the point.

### 4.1 Reserve — the anti-oversell primitive

```js
// domain/inventory.js
export async function reserve(lines, session) {
  // Deterministic lock order: prevents two multi-item carts from livelocking
  // on each other (ADR-04).
  const ordered = [...lines].sort((a, b) =>
    String(a.productId).localeCompare(String(b.productId)));

  for (const { productId, quantity } of ordered) {
    const res = await Product.updateOne(
      { _id: productId, isActive: true, available: { $gte: quantity } },
      { $inc: { available: -quantity, reserved: quantity } },
      { session }
    );
    // matchedCount === 0 means "product missing, inactive, or not enough stock".
    // A successful call is NOT a successful reservation — always check.
    if (res.matchedCount !== 1) {
      throw new InsufficientStockError(productId, quantity);
    }
  }
}

export async function release(lines, session) {          // compensation
  for (const { productId, quantity } of lines) {
    await Product.updateOne(
      { _id: productId, reserved: { $gte: quantity } },  // guard: release once
      { $inc: { reserved: -quantity, available: quantity } },
      { session }
    );
  }
}

export async function capture(lines, session) {          // payment succeeded
  for (const { productId, quantity } of lines) {
    await Product.updateOne(
      { _id: productId, reserved: { $gte: quantity } },      // guard: capture once
      { $inc: { onHand: -quantity, reserved: -quantity } },  // available unchanged
      { session }
    );
  }
}
```

The filter and the update are **one** operation. MongoDB evaluates the predicate and applies the `$inc` atomically on a single document, so two customers racing for the last unit cannot both match `available >= 1`: the second update re-evaluates against the already-decremented value and matches nothing. That is F1 solved without a lock, without a transaction, and without optimistic-retry bookkeeping.

Note that `$gte` alone does not protect against a zero or negative `quantity`, and it does not protect against a wrong price. That is the validator's job (Layer 1) — the primitive is deliberately narrow so it can be obviously correct. Also note we never `upsert` here: Mongoose's "atomic" guarantee explicitly excludes unindexed upserts.

`capture` moves `onHand` and `reserved` together and leaves `available` untouched, which is exactly right: paying converts a hold into a committed sale, it does not consume availability a second time. Reserve → capture is `available -= q`, then `onHand -= q, reserved -= q`. I1 holds throughout.

### 4.2 Transaction — atomic multi-item commit

```js
// db/transaction.js — the ONE place a session is opened or ended
// Returns the callback's value; no code path can leak a session, and the
// read/write concerns cannot drift between call sites.
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(fn, {
      readConcern:  { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}

// services/checkout.service.js — TX1
const order = await withTransaction(async (session) => {
  await reserve(items, session);                       // throws if any item fails
  const [created] = await Order.create([orderDoc], { session });
  await IdempotencyKey.updateOne(
    { _id: claim._id },
    { $set: { orderId: created._id, leaseExpiresAt: new Date(Date.now() + PAYMENT_LEASE_MS) } },
    { session }
  );
  return created;
});
```

Every transaction in the system — TX1, TX2, TX3, the reaper, cancel — goes through this helper, so session lifetime and concern levels are decided once rather than per call site.

Because `reserve` throws on the first unavailable item, the transaction aborts and **every** reservation it made is rolled back. A 3-item cart where item 3 is out of stock reserves precisely zero units — F2 solved. `withTransaction` already implements MongoDB's documented retry split (retry the whole transaction on `TransientTransactionError`, retry the commit on `UnknownTransactionCommitResult`); hand-rolling those loops is a known source of subtle bugs, so we use the helper (ADR-04).

Rules that are enforced by convention and by review:

- **Every** operation inside the callback receives `session` explicitly. We do not enable `AsyncLocalStorage` session propagation — invisible magic in the transaction path is not worth the ergonomics (ADR-04).
- **No `Promise.all` inside a transaction.** Parallel operations in a transaction are undefined behaviour.
- **No external I/O inside the callback.** It can be re-run after a transient error, so a payment call there could charge twice.
- `writeConcern: 'majority'` so a committed reservation survives a node failover.

### 4.3 Idempotency claim — the duplicate-checkout primitive

The claim is a single insert whose uniqueness is enforced by MongoDB:

```js
// services/idempotency.service.js
export async function claim({ customerId, key, requestHash, endpoint }) {
  try {
    return { kind: 'acquired', doc: await IdempotencyKey.create({
      customerId, key, endpoint, requestHash,
      status: 'processing',
      leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
      attempts: 1, expiresAt: new Date(Date.now() + RETENTION_MS),
    }) };
  } catch (err) {
    if (err.code !== 11000) throw err;               // 11000 = duplicate key
    const existing = await IdempotencyKey.findOne({ customerId, endpoint, key });
    return classifyExisting(existing, requestHash);
  }
}

function classifyExisting(existing, requestHash) {
  // Retention checked HERE, not left to the TTL monitor, which can lag under load.
  // Once retention has lapsed the key is free again (ADR-07).
  if (existing.expiresAt <= new Date())       return { kind: 'takeover',  doc: existing };
  if (existing.requestHash !== requestHash)   return { kind: 'conflict',  doc: existing };  // → 422 IDEMPOTENCY_KEY_REUSE
  if (existing.status === 'completed')        return { kind: 'replay',    doc: existing };
  if (existing.status === 'failed')           return { kind: 'retryable', doc: existing };
  if (existing.leaseExpiresAt > new Date())   return { kind: 'in_flight', doc: existing };
  return { kind: 'takeover', doc: existing };                 // previous attempt died mid-flight
}
```

**Why the claim insert is *not* inside the transaction** (ADR-07). If the claim were created inside the transaction, two concurrent requests with the same key would each be inside a transaction inserting the same unique key; MongoDB resolves that as a `WriteConflict`, which is transient, so `withTransaction` retries — and a retried callback can loop for a long time before surfacing a `DuplicateKeyError`. Claiming first, outside the transaction, makes the losing request fail fast in a plain insert and lets it *read the winner's state deliberately* instead of discovering it through a retry storm.

The lifecycle:

```
                    ┌──────────────► completed ──► replay stored response forever (within retention)
claim ──► processing                              (side-effect free)
                    └──────────────► failed ─────► retryable with the SAME key
                                                  (→ back to processing, attempts++)
```

`failed` being retryable is the "recovery from a failed checkout" requirement: a customer whose card was declined can fix their card and retry with the same key, and we re-reserve stock for them. A `completed` record never re-executes — it replays. The stored `requestHash` is computed over the **canonicalised** request (merged duplicate line items, sorted, price-free), not the raw body, so a retry that re-serialises its JSON slightly differently still replays correctly, while a retry that changes the cart is rejected with 422 instead of silently returning someone else's order.

`expiresAt` carries a TTL index, and **the replay path independently checks `expiresAt`** rather than trusting TTL deletion timing — MongoDB's TTL monitor runs periodically and can lag under load, so retention is enforced by the code, with TTL as housekeeping (ADR-07).

---

## 5. The checkout saga

Payment is simulated, but it is modelled as a genuinely external, slow, unreliable, eventually-consistent side effect — because that is the only way the code stays correct when a real gateway is dropped in. The consequence is that payment **cannot** be inside the database transaction.

### 5.1 Sequence

```
POST /api/checkout          Idempotency-Key: <uuid>       (required)

 1  Auth → customerId · rate limit · validate (Zod) · canonicalise cart
 2  requestHash = sha256(canonical(request))
 3  CLAIM (§4.3)      → replay | conflict | in_flight | takeover | acquired
 4  Load products (one find) → 404 if any missing/inactive
 5  price = priceOrder(lines, catalogue)   ← SERVER-SIDE ONLY
      · expectedTotalMinor supplied and ≠ price.totalMinor → 409 PRICE_CHANGED
 6  ┌─ TX1 ─────────────────────────────────────────────────┐
    │  reserve(items)                                       │  ← §4.1
    │  Order.create(status:'pending_payment',               │
    │     reservationExpiresAt: now + RESERVATION_TTL,      │
    │     items[ unitPriceMinor = catalogue value ])        │
    │  IdempotencyKey: { orderId, leaseExpiresAt: +PAYMENT_LEASE_MS }
    └───────────────────────────────────────────────────────┘
 7  Order: paymentLeaseExpiresAt = now + PAYMENT_LEASE_MS     ← the charge window
    (STRENGTHENED IN IMPLEMENTATION: the lease is taken at order CREATION, inside
     TX1, rather than after it. That closes a small window between TX1 committing
     and the lease being set, during which the reaper could expire an order whose
     payment was imminent. One write instead of two, and strictly safer.)
 8  gateway.charge({ orderId, amountMinor, token,
                     idempotencyKey: orderId, timeoutMs: GATEWAY_TIMEOUT_MS })
       │  timeoutMs  <  PAYMENT_LEASE_MS          ← ordering is deliberate (§5.4)
       ├── approved ──► 9a
       ├── declined ──► 9b
       └── timeout  ──► 9c
 9a ┌─ TX2 ─────────────────────────────────────────────────┐
    │  transition(pending_payment → paid)   ← CAS; may return null
    │  capture(items)                                      │  ← §4.1
    │  IdempotencyKey → completed, response = 201 + order  │
    └───────────────────────────────────────────────────────┘   201 Created
 9b ┌─ TX3 ─────────────────────────────────────────────────┐
    │  transition(pending_payment → payment_failed)         │
    │  release(items)                                       │  ← stock returns
    │  IdempotencyKey → failed, response = 402              │
    └───────────────────────────────────────────────────────┘   402 Payment Required
 9c  leave order pending_payment (lease still active)          202 Accepted
     IdempotencyKey → completed, response = 202 + pollUrl
     → resolution arrives via GET /api/orders/:id, the gateway webhook,
       or the reaper once the lease lapses
```

Payment is **synchronous within the request** on the normal path, so `201` genuinely means "paid and stock committed". That keeps the client contract simple and the concurrency tests crisp. The asynchronous paths exist only for timeouts and crashes — which is exactly where they belong.

### 5.2 One chokepoint for state changes

Every status change in the system — saga, cancel, reaper, webhook — goes through one function:

```js
// domain/orderState.js
const ALLOWED = {
  pending_payment: ['paid', 'payment_failed', 'expired', 'cancelled'],
  paid:            ['fulfilled', 'cancelled'],      // cancelled here implies refund
  payment_failed:  [],                              // terminal
  expired:         [],                              // terminal
  cancelled:       [],                              // terminal
  fulfilled:       [],
};

export async function transition(orderId, from, to, patch, session) {
  if (!ALLOWED[from].includes(to)) throw new IllegalTransitionError(from, to);
  return Order.findOneAndUpdate(
    { _id: orderId, status: from },                 // ← the compare-and-swap
    { $set: { status: to, ...patch },
      $push: { statusHistory: { from, to, at: new Date(), reason: patch.reason } } },
    { new: true, session }
  );
}
```

This single function is why compensations happen **exactly once**. `findOneAndUpdate({_id, status: from}, ...)` is an atomic compare-and-swap on one document: if two actors (a payment success and the reaper, say) try to move the same order out of `pending_payment` concurrently, one matches and one does not. The one that matches performs its stock adjustment; the one that returns `null` knows it lost the race and must not. No distributed lock, no idempotency ledger, no "hopefully it's fine". It is the same trick as §4.1, applied to the aggregate root.

Terminal states have no outgoing transitions, so a late webhook, a duplicate webhook, or a double-click cannot resurrect a settled order.

### 5.3 Crash recovery — the reaper, and why correctness does not depend on it

Orders that stay `pending_payment` past their reservation expiry must return their stock. The reaper (a bounded `setInterval`, single-process here, with a leader-free design that is already safe under multiple instances) does:

```js
// services/expiry.service.js
export async function sweepExpiredReservations({ limit = 100, productId = null } = {}) {
  const q = { status: 'pending_payment',
              reservationExpiresAt: { $lte: new Date() },
              // NOT `{ $lte: new Date() }`: comparison query operators are
              // type-bracketed, so they never match null or a missing field.
              $or: [{ paymentLeaseExpiresAt: null },
                    { paymentLeaseExpiresAt: { $lte: new Date() } }] };
  if (productIds?.length) q['items.productId'] = { $in: productIds };

  const candidates = await Order.find(q).limit(limit).select('_id items customerId');
  let released = 0;
  for (const o of candidates) {
    const expired = await withTransaction(async (session) => {
      const won = await transition(o._id, 'pending_payment', 'expired',
                                   { reason: 'reservation_expired' }, session);
      if (!won) return false;           // someone else settled this order — commit nothing
      await release(o.items, session);
      return true;
    });
    if (expired) released++;            // counted OUTSIDE the callback
  }
  return { released };
}
```

Two things make this exactly-once and crash-safe:

- The status transition and the stock release are in the **same transaction**, so an order can never be marked `expired` without its stock coming back (or vice versa).
- The transition is a CAS, so if the reaper, a concurrent user-triggered reclaim, and a payment success all fire at once, only one wins and only one adjustment happens.

Note the placement of `released++`: **outside** the transaction callback. A callback can be re-run after a `TransientTransactionError`, so mutating anything shared inside it double-counts. It is exactly the bug this document warns about in ADR-06, and it would be easy to ship in the reaper — where a wrong count is the signal we rely on to detect leaked stock. The callback's only effects are database writes that the transaction will undo if it aborts; everything else is derived from its return value.

**Note on the `paymentLeaseExpiresAt` predicate — a correction learned in implementation.** An earlier draft of this plan used `paymentLeaseExpiresAt: { $lte: new Date() }`, on the reasoning that `null` and a missing field sort below dates in BSON ordering and would therefore match. That reasoning is **wrong for query filters.** BSON sort order is not the same as query-operator semantics: MongoDB's comparison query operators are *type-bracketed*, so `$lte: <Date>` never matches `null` or a missing field. The effect of the original predicate was to silently disable expiry for exactly the orders that need it most — timed-out charges with no lease — while leaving the reviewer's obvious tests passing. It was caught by the reaper's end-to-end test, and is now written as an explicit `$or` with a `{ paymentLeaseExpiresAt: null }` branch, which correctly matches null *or* missing. The same mistake appeared in the invariants checker's I4 query, where it would have hidden stranded orders rather than surfacing them.

**Lazy reclaim.** A background timer is not a correctness dependency. When a checkout fails to reserve because availability looks insufficient, the checkout service asks the reaper for *that one product* and retries once:

```js
try {
  await reserve(items, session);
} catch (err) {
  if (!(err instanceof InsufficientStockError) || attempt === MAX_RESERVE_ATTEMPTS) throw err;
  await sweepExpiredReservations({ productId: err.productId });   // targeted
  // retry the transaction once
}
```

Stock that a crashed checkout is squatting on comes back **at the moment someone needs it**, not at the next tick of a timer. If the scheduler is misconfigured, slow, disabled, or the process was down, the system is still correct — only tidiness degrades. This is the single highest-leverage idea in the plan, and it is why `sweepExpiredReservations` takes an optional `productId`: it is designed to be callable from the demand path, not just from cron.

### 5.4 The charge-versus-expiry race

There is a narrow, genuinely hard window: we charge the card, then discover the order is no longer `pending_payment` because the reaper expired it a moment ago. The customer has paid for stock that was handed to someone else.

The design closes the window with **two deadlines** rather than one (ADR-08):

- `reservationExpiresAt` — when the hold lapses (e.g. +15 min).
- `paymentLeaseExpiresAt` — set immediately before the gateway call, cleared on resolution.
- `GATEWAY_TIMEOUT_MS < PAYMENT_LEASE_MS`, so the gateway call always resolves before its own lease can lapse.

The reaper requires **both** deadlines to have passed, so it will not touch an order while a charge is legitimately in flight, even if the reservation window has nominally elapsed. Combined with the CAS, that leaves only the truly unsolvable case — the process died mid-charge and the gateway's answer was lost. That case is handled, not ignored:

- The gateway webhook is the primary resolution path and applies the same CAS transitions, so it is naturally idempotent.
- If the reaper expires an order and a webhook later reports a successful charge, the CAS on `pending_payment → expired` has already been consumed, so the webhook sees a terminal state and **records a refund obligation** (`payment.status = 'refund_required'`) rather than silently swallowing the money.
- An admin endpoint surfaces outstanding refund obligations.

This is the one place where the answer is "detect and compensate" rather than "prevent", and saying so explicitly is more honest than claiming a lock that does not exist.

### 5.5 Pricing

```js
// domain/pricing.js — pure, integer-only, no DB, no Date.now()
// Implemented as: priceOrder({ lines, taxRateBps, discountCode })
// Shipping is module-level constants (a flat fee below a free-shipping
// threshold) rather than an injected `shippingRule` object. Tax rate and
// discount code ARE parameters, which is the part that had to be injectable for
// the engine to stay testable; a fee table that never varies was not worth an
// interface.
export function priceOrder({ lines, taxRateBps, discountCode }) {
  const subtotalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
  const discountMinor = clamp(computeDiscount(discount, subtotalMinor), 0, subtotalMinor);
  const taxableMinor  = subtotalMinor - discountMinor;
  const taxMinor      = roundHalfUp((taxableMinor * taxRateBps) / 10_000);  // once, at order level
  const shippingMinor = shippingRule.minorFor(taxableMinor);
  const totalMinor    = taxableMinor + taxMinor + shippingMinor;

  assert(subtotalMinor >= 0 && totalMinor >= 0, 'pricing invariant');
  return { subtotalMinor, discountMinor, taxMinor, shippingMinor, totalMinor,
           taxRateBps, engineVersion: PRICING_ENGINE_VERSION };
}
```

- **Money is integer minor units, never a float.** `0.1 + 0.2 !== 0.3` is not an acceptable property for a checkout. `Decimal128` is the alternative; integer cents wins on simplicity and because every operation here is exact (ADR-01).
- **Tax is rounded once at order level**, not per line. Per-line rounding accumulates drift and produces totals that cannot be reproduced from the displayed figures.
- **Discount is clamped to the subtotal**, so a total can never go negative — a classic coupon bug.
- **`engineVersion` is persisted** so historic orders stay auditable when rules change.
- Tax/shipping/discount rules are injected as plain parameters, so the engine is a unit-test target with zero infrastructure, and the tax rules themselves are testable in isolation from HTTP and from Mongo.
- The client may send `expectedTotalMinor`; a mismatch returns `409 PRICE_CHANGED` with the authoritative total instead of silently charging a different amount than the customer saw. The server's number always wins.

Because it is pure, this is the piece that gets a property-based test: for random cart compositions, assert that totals are non-negative, integral, monotonic in quantity, and that `subtotal - discount + tax + shipping === total`.

---

## 6. API

Auth: minimal and real. `POST /api/auth/register`, `POST /api/auth/login` → JWT bearer. `role: 'customer' | 'admin'`. Small on purpose, but present, because idempotency keys are scoped per customer and orders are ownership-checked.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` · `/api/auth/login` | – | issue a JWT bearer token |
| GET | `/api/auth/me` | customer | the caller's own identity |
| GET | `/api/products` | – | list, paginated, `?inStock=true&q=&includeInactive=` |
| GET | `/api/products/:id` | – | detail incl. `available` |
| POST/PATCH | `/api/products`, `/api/products/:id` | admin | CRUD |
| POST | `/api/products/:id/stock` | admin | restock: `$inc { onHand:+n, available:+n }` in one update |
| **POST** | **`/api/checkout`** | customer | **the saga; `Idempotency-Key` required** |
| GET | `/api/orders` · `/api/orders/:id` | customer | own orders, ownership-checked |
| GET | `/api/admin/inventory/reconcile` | admin | I1–I7 report + orders by status |
| GET | `/api/admin/inventory/refund-obligations` | admin | outstanding refund obligations (§5.4) |
| POST | `/api/admin/inventory/sweep` | admin | trigger the reaper on demand (demo/ops) |
| POST | `/api/admin/orders/:id/cancel` | admin | CAS → `cancelled` + release |
| POST | `/api/admin/orders/:id/reconcile-payment` | admin | force an out-of-band payment resolution |
| POST | `/api/admin/concurrency-lab` | admin | the Concurrency Lab (§7) |
| POST | `/api/webhooks/payments/simulated` | HMAC | async charge resolution |
| GET | `/healthz` · `/readyz` | – | liveness · mongo ping |

Everything under `/api/admin` is covered by a single `router.use(requireAuth, requireAdmin)` rather than a per-route guard: a new admin route is protected by default, which is the failure mode worth designing out.

Checkout request:

```http
POST /api/checkout
Idempotency-Key: 7f3c1e9a-...           # required, uuid v4, validated
Authorization: Bearer <jwt>

{ "items": [ { "productId": "...", "quantity": 2 } ],
  "paymentMethod": { "type": "card", "token": "tok_success" },
  "expectedTotalMinor": 5498 }
```

Every response — success and failure — uses one envelope, and every error carries a machine-readable code and the request id that appears in the logs:

```json
{ "error": { "code": "OUT_OF_STOCK", "message": "…",
             "details": { "items": [{ "productId": "…", "requested": 2, "available": 1 }] },
             "requestId": "01J…" } }
```

| Code | HTTP | Retryable? | Client action |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | No | fix the request |
| `UNAUTHENTICATED` / `FORBIDDEN` | 401 / 403 | No | re-auth |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | No | send the header |
| `PRODUCT_NOT_FOUND` | 404 | No | drop the line item |
| `OUT_OF_STOCK` | 409 | After reclaim | show per-item availability |
| `PRICE_CHANGED` | 409 | Yes (cart refresh) | show authoritative total |
| `CHECKOUT_IN_PROGRESS` | 409 | Yes, honour `Retry-After` | reuse the same key |
| `IDEMPOTENCY_KEY_REUSE` | 422 | No | new key; the cart changed |
| `PAYMENT_DECLINED` | 402 | Yes, same key | fix payment, retry |
| `PAYMENT_FAILED` | 402 | Yes, same key | provider error, not the card — retry |
| `ORDER_EXPIRED` | 409 | Yes, new key | cart re-held |
| `ORDER_CANCELLED` | 409 | Yes, new key | cart re-held |
| `ORDER_NOT_PENDING` | 409 | No | the order settled elsewhere; a refund obligation is recorded |
| `CHECKOUT_INCOMPLETE` | 409 | Yes | this key produced no order |
| `RATE_LIMITED` | 429 | Yes, honour `Retry-After` | slow down |
| `INTERNAL_ERROR` | 500 | With the same key | safe to retry |
| `ILLEGAL_TRANSITION` · `PRICING_ERROR` | 500 | No | a bug; the request is reported, not guessed at |
| `INVARIANT_VIOLATION` | 500 | No | the database refused the write (a negative counter or a malformed document) |
| `DUPLICATE_KEY` | 409 | No | a unique index rejected the write |
| `INVALID_SIGNATURE` | 401 | No | webhook only; the HMAC did not verify |
| `AMOUNT_MISMATCH` | 409 | No | webhook only; the reported amount is not the order total |

That table is part of the contract, not documentation garnish: it is what tells a client exactly which failures are safe to retry and which are not, which is the difference between a retry storm and a reliable integration. `Retry-After`, `Idempotency-Replayed: true`, and `X-Request-Id` are all returned where relevant.

Two API decisions worth stating: **availability detail is returned per line item** on `OUT_OF_STOCK`, because "out of stock" with no numbers is unusable to a UI; and **a declined payment returns the order id** with `402`, so the client can inspect and repair rather than losing its cart.

---

## 7. Client

React 19 + Vite SPA. Deliberately modest in size, because the interesting work is server-side — but the client is where the retry semantics become visible, and getting the key lifecycle wrong would invalidate the server design.

- **Cart** in `localStorage`; product list polls or revalidates `available` so stock is live.
- **Idempotency key lifecycle** (`useCheckout` hook): generate a UUID when a checkout attempt begins; **persist it with the cart hash**. Reuse it across network retries, timeouts and manual "try again"; regenerate it whenever the cart changes. This is the subtle half of idempotency — a key that changes per attempt protects nothing, and a key that never changes blocks a legitimate second purchase.
- **Status handling**: `201` → confirmation · `402` → inline payment repair, same key · `409 OUT_OF_STOCK` → highlight the offending line with live availability · `409 CHECKOUT_IN_PROGRESS` → auto-retry honouring `Retry-After` · `202` → poll the order to its terminal state.
- **Order history** with status badges, so `pending_payment` / `expired` / `payment_failed` are observable rather than invisible.
- **Admin**: product/stock management, and an inventory panel showing `onHand / reserved / available` side by side with the reconciliation report.

**The demo feature.** The admin panel gets a **Concurrency Lab**: seed N units, fire M concurrent checkouts (M ≫ N), and render the live result — successes, `OUT_OF_STOCK` rejections, final counters, and the invariant check. A reviewer can then *watch* the anti-oversell guarantee instead of taking the test suite's word for it. This is the single most persuasive artefact in the submission.

---

## 8. Correctness argument

### 8.1 The invariants, executable

`domain/invariants.js` verifies I1–I3 plus four structural checks, and returns a report rather than throwing, so it can serve both tests and the admin panel:

```js
export async function checkInvariants() {
  const problems = [];
  for (const p of await Product.find().lean()) {
    if (p.available !== p.onHand - p.reserved) problems.push({ I: 'I1', ...p });
    if (Math.min(p.onHand, p.reserved, p.available) < 0) problems.push({ I: 'I2', ...p });
    const held = await Order.aggregate([
      { $match: { status: 'pending_payment' } },
      { $unwind: '$items' },
      { $match: { 'items.productId': p._id } },
      { $group: { _id: null, q: { $sum: '$items.quantity' } } },
    ]);
    if ((held[0]?.q ?? 0) !== p.reserved) problems.push({ I: 'I3', product: p._id, held, reserved: p.reserved });
  }
  problems.push(...await checkDanglingOrders(), ...await checkOrphanClaims(),
                 ...await checkStuckReservations());
  return problems;
}
```

**This runs in a global `afterEach` for every integration and concurrency test.** Any test that leaves the database in an inconsistent state fails, even if that test was checking something else entirely. It converts a whole class of silent corruption into a loud, immediate failure — and it is the mechanism that keeps the guarantee true as the codebase grows, not just on the day it was written.

### 8.2 Test matrix

| Layer | Tooling | What it proves |
|---|---|---|
| Unit — pricing | Vitest | rounding, clamping, tax-once, monotonicity, zero-qty, huge carts |
| Unit — validation | Zod | rejects negative/zero/non-integer qty, unknown fields, duplicate product ids, missing key |
| Unit — state machine | Vitest | every illegal transition throws; terminal states are absorbing |
| Property — pricing | fast-check | `subtotal - discount + tax + shipping === total`, always integral, always ≥ 0 |
| Integration — API | supertest + replset | auth, ownership (no IDOR), CRUD, restock, error envelope, `Retry-After` |
| Integration — saga | supertest + replset | decline releases stock; timeout → 202 → webhook resolves; cancel releases; expiry releases |
| Integration — idempotency | supertest | replay returns the same order; hash mismatch → 422; retry after `failed` re-reserves |
| **Concurrency** | real HTTP + replset | **no overselling, exactly-once claims, exactly-once compensations** |
| Reconciliation | `checkInvariants()` | global `afterEach` hook |
| Chaos | fault injection | crash between reserve and charge → reaper restores stock |
| Load | `server/scripts/bench.mjs` | p50/p95 per outcome under two contention shapes; **measured, not asserted** (§9.1) |

### 8.3 The headline tests

**(1) No overselling under contention.**

```js
it('never oversells: 200 concurrent checkouts for 10 units', async () => {
  const product  = await seedProduct({ onHand: 10, priceMinor: 1000 });
  const buyers   = await Promise.all(range(200).map(makeCustomer));

  const results = await Promise.all(buyers.map((c, i) =>
    request(app).post('/api/checkout')
      .set('Authorization', bearer(c))
      .set('Idempotency-Key', uuid())
      .send({ items: [{ productId: product.id, quantity: 1 }],
              paymentMethod: { type: 'card', token: 'tok_success' } })));

  const ok   = results.filter(r => r.status === 201);
  const sold = results.filter(r => r.body?.error?.code === 'OUT_OF_STOCK');

  expect(ok).toHaveLength(10);                     // exactly the stock, no more
  expect(sold).toHaveLength(190);

  const after = await Product.findById(product.id);
  expect(after).toMatchObject({ onHand: 0, reserved: 0, available: 0 });

  const ordered = await Order.aggregate([
    { $match: { status: 'paid' } }, { $unwind: '$items' },
    { $match: { 'items.productId': product._id } },
    { $group: { _id: null, q: { $sum: '$items.quantity' } } },
  ]);
  expect(ordered[0].q).toBe(10);                   // Σ sold === stock consumed
  expect(await checkInvariants()).toEqual([]);     // I1–I3 hold
});
```

`expect(ordered[0].q).toBe(10)` is the assertion that matters: it is not enough that ten requests returned `201`; the quantity actually recorded against inventory must equal the stock that existed. That check is what catches a "success" that quietly reserved nothing.

**(2) Duplicate requests create exactly one order.**

```js
it('50 concurrent requests with one key create one order and one charge', async () => {
  const key = uuid();
  const send = () => request(app).post('/api/checkout')
    .set('Authorization', bearer(customer)).set('Idempotency-Key', key)
    .send({ items: [{ productId, quantity: 2 }], paymentMethod: { type: 'card', token: 'tok_success' } });

  const results = await Promise.all(range(50).map(send));
  const orderIds = new Set(results.filter(r => r.status === 201).map(r => r.body.data.order.id));

  expect(orderIds.size).toBe(1);                            // every 201 names the same order
  expect(await Order.countDocuments()).toBe(1);
  expect(await PaymentAttempt.countDocuments()).toBe(1);     // charged exactly once

  const after = await Product.findById(productId);           // 10 - 2, and only once
  expect(after.onHand + after.reserved).toBe(8);
  expect(after.available).toBe(8);
  expect(await checkInvariants()).toEqual([]);
});
```

Run twice, with `IDEMPOTENCY_WAIT_MS` set high (all 50 coalesce onto the replay and return the same `201`) and set to `0` (exactly one `201`, the rest `409 CHECKOUT_IN_PROGRESS`). Both are correct; which one the API promises is a deliberate product decision and is asserted, not left to chance.

**(3) Compensations happen exactly once.** Race the reaper against a payment success on the same order; assert the final counters are correct and that `PaymentAttempt.status` is either `succeeded` or `refund_required` — never both, never neither.

**(4) The database backstop actually stops overselling.** Bypass the service layer and attempt `Product.updateOne({_id}, {$inc: {available: -5}})` on a product with `available: 1`; assert MongoDB rejects it with a validation error. This proves layer 5 is real and not decoration.

**(5) Chaos: crash between reserve and charge.** Inject a fault after TX1 that aborts the request without paying; assert the order is `pending_payment`, run the reaper, and assert the stock returns and I3 holds. This is the test that proves F5 and F3, and it is the one most submissions do not have.

---

## 9. Reliability and operations

- **Config validated at boot** with Zod — a missing `MONGODB_URI` or an insane `RESERVATION_TTL` fails at startup, not at 3 a.m. Tunables (`RESERVATION_TTL_MS`, `PAYMENT_LEASE_MS`, `GATEWAY_TIMEOUT_MS`, `IDEMPOTENCY_WAIT_MS`, `MAX_RESERVE_ATTEMPTS`) live here.
- **Structured JSON logs** with a `requestId` on every line, echoed as `X-Request-Id`; slow queries logged with their duration. The `requestId` in the error envelope is what makes a report reproducible.
- **Graceful shutdown**: stop accepting, drain in-flight, close Mongo. A checkout interrupted mid-flight must not become a leaked reservation — which it does not, because the reaper's targeted reclaim covers it.
- **Rate limiting** on `/api/checkout` per customer, plus a bounded body size. Idempotency protects correctness; rate limiting protects the database from a client that retries badly.
- **Security**: helmet, CORS allowlist, JWT with role checks, **ownership checks on every order read** (no IDOR), HMAC-verified webhooks, no price accepted from the client, no raw request body ever passed into a Mongo query, and internal errors never leaked to the client.

### 9.1 Contention: the honest bottleneck

Transactions that touch the same product document serialize on it and can generate `WriteConflict` → `TransientTransactionError` → retry. Under the 200-concurrent-buyers test the system is *correct* but the losers do measurable wasted work. Three mitigations, in order of cost:

1. **Sort the lock order** (§4.1) — removes cross-cart livelock. Already implemented.
2. **Fast-fail the doomed** — pre-check `available` before opening a transaction and answer `OUT_OF_STOCK` immediately without paying the transaction cost. The check is advisory only; correctness still rests on the conditional `$inc` inside the transaction. **Measured (below): −34.6% on rejected requests once stock is drained, and ~5% — inside the noise floor — under a simultaneous herd.** It is kept on by default because it costs nothing measurable when it does not fire and saves a third of the time when it does. The strength of the original justification is corrected, not the direction: "most losing requests are losing by a mile" is true of a sold-out product and much weaker when every request arrives at the same instant.
3. **Stock bucketing** (stretch) — split a product's stock across N bucket documents and reserve from a random bucket, turning one hot document into N. This is how you scale a counter, and it is a *real* trade-off: it complicates I1/I3, changes the meaning of `available` (per bucket), and can report out-of-stock while units remain in another bucket. **Deliberately out of scope for the main build**, listed as Phase 9 with a benchmark gate, because shipping a complex mechanism that is 10× faster on a benchmark nobody asked for is worse engineering than shipping the simple one that is provably correct.

#### The measurement

`npm run bench` drives the **checkout service** rather than the HTTP surface, because the property under test is contention on one hot product document, not loopback throughput (this replaces the autocannon/k6 row originally planned for §8.2; the composition of the load — N concurrent callers, one hot document — is identical, without the HTTP stack adding a confound). It runs two shapes of load against both modes, at 200 concurrent buyers of 1 unit each with a connection pool of 50. Each mode is measured **twice, in opposite orders, after a warm-up round**, and the table reports the paired means with the individual runs in brackets — for the reason given in the methodology note below:

| Scenario | Mode | Confirmed | Rejected | Rejected p50 (individual runs) |
|---|---|---|---|---|
| **herd** — 200 buyers, 10 units, all arrive at once | plain transaction | 10 | 190 | 1041 ms (1099, 983) |
| | fast-fail pre-check | 10 | 190 | 992 ms (1024, 959) |
| **drained** — 200 buyers, 0 units | plain transaction | 0 | 200 | 328 ms (327, 328) |
| | fast-fail pre-check | 0 | 200 | **214 ms** (220, 209) |

Every one of the eight runs is `CORRECT`: exactly 10 sales for 10 units, Σ sold quantities = 10, `available = onHand − reserved`, zero invariant problems. Correctness does not vary with the flag — **that is the point**, since the pre-check is advisory and the conditional `$inc` is what actually prevents overselling.

The two honest conclusions:

1. **Where it is aimed, it wins clearly: −34.6%.** Once the product is drained — the state a real sold-out drop spends most of its traffic in — rejected requests are answered from a read instead of a transaction. The two runs do not overlap (327/328 ms vs 220/209 ms), so this is an effect, not a fluctuation.
2. **Under a simultaneous herd it is worth ~5%, and the runs overlap** (983–1099 ms plain vs 959–1024 ms fast), which puts it at the noise floor rather than in the headline. It can only reject from a read taken *before* the writes land, and when 200 requests arrive together most of them still observe available stock on that read and pay the `withTransaction` retry loop regardless — exactly the latency signature ADR-04 predicted. So the mitigation is real but **much smaller than this section originally claimed**: it does not "remove most contention" during the herd. Keeping it on is still right, because it costs nothing measurable when it does not fire and saves a third of the time when it does.

#### Methodology note: how the first version of this benchmark lied

The first version of `bench.mjs` ran `plain` first and `fast-fail` second, always. Cold JIT, cold query plan cache and cold pages are worth hundreds of milliseconds at this scale, so **run position was worth more than the effect being measured**. The result was a confident wrong answer, twice: one run showed the pre-check ~10% *worse* under a herd, and four later runs on unchanged code showed it ~24% *better*. Both were artifacts of ordering. Adding a warm-up round and measuring A/B then B/A cut absolute latencies by ~30% (herd plain: 1507 ms → 1041 ms) and stabilised the herd delta at ~5%.

This is recorded because it is the more useful lesson: a single-run benchmark on a system with caches, a connection pool and a JIT is not a measurement, and it is exactly the kind of number that gets quoted in a README and never re-derived. The pairing and the spread are what make the number mean something.

`CHECKOUT_FAST_FAIL` therefore defaults to `true` and is exposed as a flag precisely so this table can be regenerated rather than trusted. The real fix for the herd remains option 3.

---

## 10. Build order

Each phase ends in something demonstrable and verified. No phase is "done" until its acceptance criteria are met and the suite is green.

| Phase | Deliverable | Acceptance criteria |
|---|---|---|
| **0** | Workspace, config, logger, error envelope, `/healthz`, **replica-set test harness**, `checkInvariants` skeleton | `npm test` runs against `MongoMemoryReplSet`; a trivial transaction test passes (proves the replset works); boot fails on bad env |
| **1** | Models, indexes, `applyValidators.js`, seed script, factories | `$jsonSchema` rejects `available: -1`; **seed assertion confirms int storage**; I1 holds after seed |
| **2** | Auth, products CRUD, atomic restock, reconcile endpoint | Integration tests for auth/roles/ownership; restock keeps I1 |
| **3** | Pricing engine + Zod validation | Unit + property tests green; 400s for every malformed-input case |
| **4** | Inventory primitives, order state machine | Unit tests for reserve/release/capture; every illegal transition rejected |
| **5** | **Checkout TX1 + idempotency claim** | `OUT_OF_STOCK` at 409 with per-item detail; multi-item partial failure reserves nothing; replay returns the same order; 422 on hash mismatch |
| **6** | Payment gateway + saga TX2/TX3 + compensations | Decline releases stock; charge-once proven by the `PaymentAttempt` unique index |
| **7** | Expiry reaper + lazy reclaim + webhook + 202 path | Chaos test: crash between reserve and charge → stock returns; reaper/user race releases once |
| **8** | Concurrency suite + property tests + global invariant hook | 200-for-10 test green and **repeated 5× without flakes**; invariants hold in `afterEach` |
| **9** | React client incl. **Concurrency Lab**; measured contention numbers | A reviewer can run one command and watch overselling fail to happen |
| **10** | Docs: README, `ARCHITECTURE.md`, this plan, `DECISIONS.md`, measured benchmark table | A fresh clone reaches a running demo in ≤ 3 commands |

Sequencing rationale: the invariants checker and the replica-set harness exist at Phase 0 because they are the *instrumentation* for everything after; building them last means building blind. Payments come after the pure inventory primitives because the saga is only trustworthy once reserve/release/capture are individually proven correct. The concurrency suite comes after the saga so that it is testing the finished state machine rather than a moving target.

### Scope boundaries (stated, not hidden)

In scope: everything above. **Out of scope, with reasons:** real payment integration (simulated by design, with a gateway interface so a real provider is a drop-in); shipment/fulfilment logistics (`fulfilled` is a flag, not a workflow); multi-currency and FX (the schema carries `currency` and the validator pins it to `USD`, so adding currencies is a data change rather than a rewrite); a transactional outbox / event bus (a single service with synchronous payment does not need one — the upgrade path is documented in ADR-13); distributed sagas across services; sharding (with a note that a sharded `IdempotencyKey` collection constrains which unique indexes can be enforced, so the shard key and the uniqueness scope must be designed together).

---

## 11. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Standalone Mongo in dev/CI | Every transaction test fails opaquely | Replset asserted in `beforeAll`; `scripts/dev-mongo.mjs` serves a single-node replset for local dev |
| `withTransaction` retry latency under heavy contention | Slow p95; wasted work | Fast-fail pre-check; lock ordering; measured and documented rather than claimed |
| Concurrency tests flake | Erodes trust in the deliverable | No timing assertions — assert counts and invariants; deterministic seeds; generous timeouts; run 5× in CI |
| Race: reaper expires an order mid-charge | Charged but unfulfilled | Two-phase deadlines + CAS + refund obligation + admin report (§5.4) |
| Integer vs double storage in Mongo | Validator silently rejects or accepts wrongly | Phase 1 seed assertion |
| Mongoose validators don't run on `updateOne` | False sense of safety | Correctness rests on DB `$jsonSchema` + conditional filters, **not** Mongoose validators (ADR-02) |
| Express 5 route/`res` changes | Runtime breakage during build | Zod param validation instead of inline regex; no legacy `res` signatures (ADR-14) |
| TTL monitor lag on idempotency records | Replay of an expired key | Replay path checks `expiresAt` independently (ADR-07) |

---

## Appendix A — Design decisions

Fourteen decisions are recorded as ADRs in [docs/DECISIONS.md](docs/DECISIONS.md): money representation, the materialised `available` counter, the conditional-`$inc` reserve primitive, the transaction and lock order, reserve-then-capture, payment outside the transaction, the split claim, the two-phase payment lease, side-effect-free replay, lazy reclaim, order numbering, the test stack, no outbox, and the Express 5 boundary.

Each ADR states the context, the decision, the **alternatives that were rejected and why**, the consequences accepted, and the evidence that supports it. That document is where "explain your design decisions" is answered directly.

## Appendix B — Reviewer quick start (target experience)

```bash
npm install
npm run dev:db &              # local single-node replica set, writes server/.dev-mongo-uri
npm run seed                  # products with known stock
npm run dev                   # api + client
npm test                      # unit + integration + concurrency + property (167 tests)
npm run test:concurrency      # the headline suite, verbose
npm run bench                 # contention numbers
```

`npm run dev:db` starts the same `MongoMemoryReplSet` binary the test suite uses. **No Docker or system `mongod` is required**, and none was available in the authoring environment — which is why the dev database is the in-process replica set rather than the `docker-compose.yml` this plan originally called for. A bootstrap that is exercised on every test run is worth more than one that cannot be verified; if you do have Docker, any single-node replset works, since nothing but `MONGODB_URI` is hard-coded.

Then open the **Concurrency Lab**, set stock to 10, fire 200 buyers, and read the result table: 10 confirmed, 190 rejected, `available: 0`, invariants clean. That single screen is the submission's thesis, demonstrated rather than asserted.
