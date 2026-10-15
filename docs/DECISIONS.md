# Architecture Decision Record

Load-bearing decisions in the order-processing system. Each entry states the context, the decision, **the alternatives that were rejected and why**, the consequences we accepted, and the evidence behind it.

| ADR | Decision | One-line rationale |
|---|---|---|
| 01 | Money as integer minor units | Floats cannot represent money exactly |
| 02 | Materialised `available` + DB non-negative validator | A computed field cannot be updated atomically |
| 03 | Conditional atomic `$inc` as the reserve primitive | Overselling becomes impossible, not merely unlikely |
| 04 | Multi-document transaction, sorted lock order | A cart must commit wholly or not at all |
| 05 | Reserve → capture, not immediate decrement | Payment can fail; stock must come back |
| 06 | Payment outside the transaction, compensation via status CAS | Transactions retry; external side effects must not |
| 07 | Idempotency claim outside the transaction, completion inside | Fail fast on duplicates instead of retry-storming |
| 08 | Two-phase deadline: reservation TTL + payment lease | Closes the charge-versus-expiry race |
| 09 | Replay is side-effect-free but re-serialises current state | Useful replays without re-execution |
| 10 | Lazy reclaim on contention | Correctness must not depend on a scheduler |
| 11 | Order numbers from a non-transactional counter | Avoid a write hotspot in the checkout transaction |
| 12 | Vitest + supertest + `MongoMemoryReplSet` | Transactions demand a replica set, even in tests |
| 13 | No transactional outbox | Not needed at this scope; upgrade path documented |
| 14 | Express 5 + Zod at the boundary | One source of truth for input and config |

---

## ADR-01 — Represent money as integer minor units

**Context.** Orders carry prices, discounts, tax and totals. JavaScript numbers are IEEE-754 doubles.

**Decision.** Every monetary value is an integer count of minor units (`priceMinor: 2499` = $24.99), with an explicit `currency` field. No monetary value is ever a float, ever enters `parseFloat`, or ever round-trips through a string.

**Alternatives considered.**
- *Floats* — rejected: `0.1 + 0.2 !== 0.3`. A total that does not equal the sum of its lines is a defect no amount of testing makes acceptable.
- *`Decimal128`* — the legitimate alternative. Rejected here because every operation in this system is addition, multiplication by an integer quantity, and a single percentage calculation. Those are exact in integers, so `Decimal128` would add driver and serialisation friction for precision we do not need. It becomes the right answer the moment amortising divisions or per-unit fractional rates appear.

**Consequences.** Display code multiplies by 100 once at the presentation edge. Tax is computed once at order level with explicit HALF_UP rounding, so a total is always reproducible from its displayed components. Percentage inputs are basis points (`taxRateBps`), an integer.

**Evidence.** Property tests assert totals are integral, non-negative, monotonic in quantity, and satisfy `subtotal − discount + tax + shipping === total` for random carts.

---

## ADR-02 — Materialise `available`, and make the database refuse negative counters

**Context.** Overselling must be impossible. Stock needs an "available to sell" figure that a concurrent request can test and decrement without a race.

**Decision.** Store `onHand`, `reserved`, and `available` as three real fields, with `available` maintained as `onHand − reserved` by construction. Only three functions ever mutate them (`reserve`, `release`, `capture`), each in a single-document atomic update that moves the fields together. A `$jsonSchema` collection validator sets `minimum: 0` on all three and `validationAction: 'error'`.

**Alternatives considered.**
- *Compute `available` on read (`$subtract`)* — rejected: a computed field cannot appear in an atomic conditional update, so the check and the decrement would have to happen in two round trips, reintroducing exactly the read-then-write race we are trying to eliminate.
- *Rely on Mongoose schema validators* — rejected as the primary defence. Mongoose does not run schema validators on `updateOne`/`findOneAndUpdate` the way it does on `save()`, so a validator in the schema would create a false sense of safety in precisely the code path that matters. The `$jsonSchema` validator is enforced by the server on the resulting document and therefore applies to every write, from any client.
- *Use Mongoose `optimisticConcurrency`/`__v`* — rejected for inventory. Version keys detect that a *loaded document* changed before `save()`, they are not full optimistic concurrency by default, and they do not apply to query-based updates. Our correctness should not rest on a feature that behaves differently depending on which Mongoose method was used.

**Consequences.** A denormalised field can drift, so I1 is asserted continuously (§8 of the plan) rather than assumed. Adding a stock dimension means touching all three primitives deliberately — which is the desired outcome, since a fourth write path to inventory is how drift is born.

**Evidence.** A test bypasses the service layer and attempts `$inc: { available: -5 }` on a product with `available: 1`; MongoDB rejects the write. Negative stock is impossible even with the application's cooperation.

---

## ADR-03 — Reserve with one conditional atomic `$inc`

**Context.** Two customers, one unit left, simultaneous checkout. This is the failure mode the brief is built around.

**Decision.**

```js
Product.updateOne(
  { _id: productId, isActive: true, available: { $gte: quantity } },
  { $inc: { available: -quantity, reserved: quantity } }
);
// matchedCount !== 1  →  insufficient stock
```

The predicate and the mutation are one operation, evaluated atomically against a single document.

**Alternatives considered.**
- *Read, compare, write* — the bug the brief tests for. Two requests read `1`, both decide there is stock, both write `0`. Rejected outright.
- *Optimistic concurrency with retry* — workable, but it needs a version field, a retry loop, and a backoff policy, all to reimplement what the storage engine already does atomically. Rejected as more code for weaker guarantees.
- *Application-level locks / `findOneAndUpdate` with a queue* — only correct within one process. Rejected: correctness must not depend on a single-process deployment.
- *Pessimistic `findOneAndUpdate` and hold the document* — rejected: transactions already give us multi-document atomicity; an extra locking scheme adds deadlock potential for no gain.
- *`upsert: true`* — rejected explicitly: Mongoose documents that an unindexed upsert is the one case that is **not** atomic.

**Consequences.** The filter must be paired with validation that `quantity` is a positive integer — `$gte` alone happily accepts `0` or `-5`. This is enforced at the edge (ADR-14), and the primitive deliberately stays narrow so it is trivially reviewable.

**Evidence.** The 200-concurrent-buyers-for-10-units test asserts exactly 10 successes, 190 `OUT_OF_STOCK`, and Σ sold quantities `=== 10`. Layer 3 holds even if the transaction were removed, because it does not depend on one.

---

## ADR-04 — Multi-document transaction with a deterministic lock order

**Context.** A cart may hold several products. Reserving items 1 and 2 and then failing on item 3 would leave two phantom holds. The order document, the reservation, and the idempotency claim must be one unit of work.

**Decision.** Use `session.withTransaction()` with `readConcern: snapshot` / `writeConcern: majority`. Sort line items by `productId` before reserving. Throw on the first unavailable item so the whole transaction aborts.

**Alternatives considered.**
- *Sequential writes with manual rollback* — rejected: a crash between reserve and rollback leaks stock, and there is no atomic boundary to reason about.
- *Two-phase commit implemented by hand* — rejected: reinventing transactions, badly.
- *Hand-rolled retry loops around `startTransaction`/`commitTransaction`* — rejected. MongoDB's documented pattern distinguishes `TransientTransactionError` (retry the whole transaction) from `UnknownTransactionCommitResult` (retry the commit only), and getting that split wrong produces duplicate commits. `withTransaction` implements it; we should not re-implement it.
- *Enable Mongoose `transactionAsyncLocalStorage` session propagation* — rejected for now: implicit session attachment inside the one path where an accidental write outside the transaction is catastrophic is the wrong trade. Every operation receives `session` explicitly, and its absence is visible in review.

**Consequences.** Every operation in the callback must pass `session`, including reads that inform the write. No `Promise.all` inside a transaction (parallel transaction operations are undefined behaviour). No external I/O inside the callback, because the callback can re-run. `withTransaction` retries `TransientTransactionError` for a long budget, so a sustained contention storm shows up as latency rather than failure — which is why the contention numbers are measured rather than assumed.

**Refined by measuring, then corrected again.** §9.1 of the plan proposed a fast-fail pre-check as the mitigation for exactly this behaviour, on the reasoning that "most losing requests are losing by a mile". `npm run bench` says: **−34.6% on rejected requests once the product is drained**, where the pre-check replaces a whole transaction with a read, and **~5% — inside the noise floor, individual runs overlapping — under a simultaneous herd**, where most requests still observe available stock on their pre-transaction read and pay the retry loop regardless. The predicted latency signature is real and visible in both: rejected requests cluster just under the total run time, retrying until they observe the sold-out state. So the mitigation works, but it is strongest in precisely the case it was not designed around (drained stock) and weakest in the case it was (the herd).

**The number was wrong twice before it was right.** The first version of the benchmark ran the plain path first and the fast-fail path second, always. Cold JIT, cold query plan cache and cold pages are worth hundreds of milliseconds here, so run position outweighed the effect being measured, and it produced two confident and opposite conclusions from unchanged code: one run had the pre-check ~10% *worse* under a herd, four later runs had it ~24% *better*. Adding a warm-up round and measuring A/B then B/A removed the bias, cut absolute latencies by ~30%, and stabilised the delta at ~5%. The lesson is not about this optimisation: a single-run benchmark on a system with caches and a connection pool is a rumor, and the version of it that ends up in a README is rarely re-derived.

**Evidence.** A test asserts that a 3-item cart with the third item out of stock leaves every counter untouched — the abort is observed, not trusted.

---

## ADR-05 — Reserve then capture; never decrement on checkout

**Context.** Payment is simulated but can decline, time out, or be abandoned.

**Decision.** Checkout moves stock from `available` to `reserved` (`available -= q, reserved += q`). Only a confirmed charge moves it from `reserved` to sold (`onHand -= q, reserved -= q`, `available` unchanged). A failed, cancelled, or expired order releases it (`reserved -= q, available += q`).

**Alternatives considered.**
- *Decrement `onHand` immediately at checkout* — rejected: on a decline or an abandoned tab the units are gone from inventory forever with no record that they were ever held, so the shop silently sells less than it has. This is the second-most common bug in checkout implementations after the read-then-write race.
- *Take payment first, then reserve* — rejected: the customer can pay for stock that no longer exists, which is strictly worse than making them wait — it requires a refund to unwind.
- *A separate `Reservation` collection* — considered and rejected: a reservation has exactly the lifetime and the ownership of its order, so a separate collection would need joining for every read, and would allow the two to disagree. The order is the aggregate root for its own holds.

**Consequences.** Inventory now has a lifecycle (`available → reserved → sold`), which is more state to test but is also what makes the system explainable to a customer ("we are holding this for 15 minutes"). `release` and `capture` carry `reserved: { $gte: quantity }` guards so a double release cannot drive counters negative — the guard makes the compensation idempotent, and the DB validator makes a bug fail loudly instead of corrupting silently.

**Evidence.** A declined-payment test asserts the exact restock; the global invariant hook asserts I3 (`reserved` equals the sum of quantities held by `pending_payment` orders) after every scenario.

---

## ADR-06 — Payment outside the transaction; compensate via a status compare-and-swap

**Context.** The gateway is slow, unreliable, and has side effects. The transaction callback may be re-run after a transient error.

**Decision.** Charge the card **after** TX1 commits and **outside** any transaction. Apply the outcome in a new transaction that begins with a CAS on the order status:

```js
Order.findOneAndUpdate({ _id, status: 'pending_payment' }, { $set: { status: 'paid' } })
```

If it returns `null`, this actor lost the race and must not touch stock.

**Alternatives considered.**
- *Charge inside the transaction* — rejected: a retry after `TransientTransactionError` re-runs the callback, so the card could be charged twice, and holding a write lock across a multi-second network call is a contention disaster.
- *Sequence-number or timestamp-based conflict resolution* — more machinery than a status transition; the status already carries exactly the information needed about whether the order is settled.
- *A distributed lock (Redis) around checkout* — rejected as a second failure domain and a second source of truth. The CAS in the database is the lock, and it cannot disagree with the data it protects.
- *Trust the gateway webhook only, never apply the outcome inline* — rejected: it makes the common, fast path unnecessarily asynchronous and forces the client to poll for a result we already have.

**Consequences.** The saga is a sequence of compensable steps rather than one atomic operation, so the argument for correctness shifts from "the transaction is atomic" to "every transition is a CAS and every terminal state is absorbing" — which is why ADR-06 and the state machine are inseparable. Terminal states have no outgoing transitions, so a late webhook, a duplicate webhook, or a double-click cannot resurrect a settled order. The rare "charged but could not settle" case is detected and recorded as a refund obligation rather than ignored (ADR-08).

**Evidence.** The `PaymentAttempt` collection has a unique index on `idempotencyKey = orderId`, so a second charge for an order cannot even be recorded. A test races a payment success against the reaper and asserts `PaymentAttempt.status` is exactly one of `succeeded` or `refund_required` — never both, never neither.

---

## ADR-07 — Claim the idempotency key outside the transaction; complete it inside

**Context.** Clients time out and retry. Users double-click. Both present the same `Idempotency-Key` twice (or fifty times) concurrently. Exactly one order must result.

**Decision.** Two-phase:

1. **Claim** with a bare `IdempotencyKey.create(...)`, relying on a unique index over `{customerId, endpoint, key}`. Not in a transaction. A `DuplicateKeyError` classifies the existing record as `replay`, `retryable`, `in_flight`, or `takeover` by inspecting its status, lease and `requestHash`.
2. **Complete** by setting the record's terminal status and stored response **inside** the same transaction that commits the order — so "the order exists" and "the key is spent" become one fact. They can never disagree.

`status: 'failed'` remains retryable with the same key; `status: 'completed'` never re-executes.

**Alternatives considered.**
- *Claim inside the transaction* — rejected after reasoning about the interleaving: two concurrent requests inserting the same unique key inside transactions produce a `WriteConflict`, which is labelled transient, so `withTransaction` retries the callback. The loser would discover the collision through a retry storm with a long budget instead of failing immediately and reading the winner's state on purpose. The insight is that the unique index must be the arbiter, and the arbitration must happen where it is cheap.
- *"Check then insert" in application code* — rejected: it is a race. Two requests both find nothing and both proceed. The unique index is the only correct arbiter.
- *Explicit row-level lock on the key* — rejected in favour of the index, which is enforced by the server.
- *Mark `completed` before payment resolves* — rejected: the key would claim a result the system does not have.
- *Delete the claim on failure so the key is reusable* — rejected: it destroys the ability to detect reuse of a key with a *different* cart, which is the mechanism that stops a retry from silently returning an unrelated order.

**Consequences.** `requestHash` is computed over the **canonicalised** request — duplicate line items merged, lines sorted, prices excluded — not the raw body, so a client that re-serialises its JSON slightly differently still replays correctly, while one that changes the cart gets `422 IDEMPOTENCY_KEY_REUSE` instead of someone else's order. A `processing` record with a live lease makes a concurrent duplicate wait briefly (`IDEMPOTENCY_WAIT_MS`) for the terminal result, then fall back to `409 CHECKOUT_IN_PROGRESS` with `Retry-After`; a `processing` record with a **lapsed lease** is reclaimable by a takeover CAS, which is how a crashed attempt stops blocking a legitimate retry. Retention is enforced by code checking `expiresAt` on the replay path, with a TTL index as housekeeping only — the TTL monitor runs periodically and can lag under load, so its timing must never carry correctness.

**Evidence.** Two variants of one test: with waiting enabled, 50 concurrent same-key requests all return the same `201` order id and exactly one `Order` and one `PaymentAttempt` exist; with waiting disabled, exactly one `201` and 49 `409`. Both are asserted, so the policy is a promise rather than an accident.

---

## ADR-08 — Two-phase deadlines: reservation TTL and payment lease

**Context.** A charge is in flight when the reservation expires. The reaper releases the stock; the charge then succeeds. The customer paid for units that are already someone else's.

**Decision.** Two independent deadlines on the order. `reservationExpiresAt` bounds the hold. `paymentLeaseExpiresAt` is set immediately before the gateway call and cleared on resolution. The reaper requires **both** to have lapsed, and `GATEWAY_TIMEOUT_MS < PAYMENT_LEASE_MS` is enforced as a boot-time config assertion, so a charge always resolves before its own lease can expire.

**Alternatives considered.**
- *One deadline* — rejected: it cannot distinguish "this order is idle and should expire" from "this order is mid-charge and must be left alone".
- *Reaper holds a lock while charging* — rejected: it converts a rare race into a routine availability problem, since any slow gateway then blocks expiry for every order.
- *No expiry at all, reconcile manually* — rejected: abandoned carts would permanently reduce sellable stock, which is a worse failure than the one being fixed.
- *Assume the race cannot happen* — rejected: it is a real interleaving, and the honest response is to bound it and detect it, not to deny it.

**Consequences.** The window narrows to the genuinely unsolvable case: the process died mid-charge and the gateway's answer was lost. That case is handled rather than ignored. If a webhook later reports a successful charge for an order the reaper already expired, the CAS has been consumed, the order is terminal, and the system **records a refund obligation** surfaced through the admin reconciliation endpoint. This is the only place in the design where the answer is "detect and compensate" instead of "prevent", and it is documented as such rather than papered over with a lock that does not exist.

**Correction found during implementation.** This ADR originally justified the predicate `paymentLeaseExpiresAt: { $lte: now }` on the grounds that `null` and a missing field sort below dates in BSON ordering, and would therefore match. That reasoning is wrong for *query filters*. BSON sort order is not query-operator semantics: MongoDB's comparison query operators are **type-bracketed**, so `$lte: <Date>` never matches `null` or a missing field. The original predicate silently disabled expiry for exactly the orders that most needed it — a timed-out charge whose lease had been cleared — while every obvious test still passed, because those tests used real past dates. It was caught by the end-to-end reaper test, and the predicate is now an explicit `$or` containing `{ paymentLeaseExpiresAt: null }`, which correctly matches null *or* missing. The same mistake was present in the invariants checker's I4 query, where it would have hidden stranded orders instead of reporting them.

**Evidence.** A test sets `RESERVATION_TTL` mid-charge and asserts the reaper leaves the order alone while the lease is live; a chaos test kills the request between reserve and charge and asserts the reaper then restores every unit.

---

## ADR-09 — Replay is side-effect-free but re-serialises current state

**Context.** A stored response is replayed for a repeated key. Some responses (the `202` on a gateway timeout) describe an order whose state has since moved on.

**Decision.** A replay never re-executes anything. For responses that carry an order, the stored status code decision is honoured but the order body is re-serialised from current state. `Idempotency-Replayed: true` marks every replay.

**Alternatives considered.**
- *Return the stored body verbatim* — this is what Stripe does, it is byte-for-byte deterministic, and it is a legitimate choice. Rejected because our client would otherwise receive a stale `202 pending_payment` for an order that has since been paid, and the alternative (poll a second endpoint for a fact we already know) is worse UX for no gain.
- *Re-execute and overwrite* — rejected: that is the bug idempotency exists to prevent.
- *Return the stored body and require polling* — kept as the fallback contract if a byte-identical guarantee is ever needed for an integration; `GET /api/orders/:id` is authoritative regardless.

**Consequences.** Replays are not byte-identical for order-bearing responses; the divergence is limited to the order's own progression and is never a different order. Status codes for terminal outcomes (201/402) are stable. Documented so a reviewer sees a deliberate trade rather than an inconsistency.

**Evidence.** A test completes a checkout whose payment times out, then completes the payment via webhook, then replays the checkout with the same key and asserts the replayed body reflects `paid`.

---

## ADR-10 — Lazy reclaim on contention: correctness independent of the scheduler

**Context.** Expired reservations must return stock. A periodic background job is the obvious mechanism, and it is also a single point of failure: if it is misconfigured, slow, or the process was down, the shop under-sells.

**Decision.** Make the reclaim path a function callable from demand, not only from a timer. When a reservation fails with `InsufficientStockError`, the checkout service triggers a **targeted** sweep scoped to that product (`sweepExpiredReservations({ productId })`) and retries the transaction once, bounded by `MAX_RESERVE_ATTEMPTS`. The periodic reaper remains, as hygiene.

**Alternatives considered.**
- *Timer-only reaping* — rejected: it makes availability depend on operational health. Stock a crashed checkout is squatting on should return when someone needs it.
- *Synchronous release on connection close* — rejected: it cannot handle a process crash, a mobile network drop, or a user who simply closes the tab.
- *Aggressive short TTLs to minimise staleness* — rejected: it would expire legitimate in-progress checkouts and turn latency into lost sales.
- *Manual admin sweep only* — rejected as the only mechanism; kept as an operator tool.

**Consequences.** A failing checkout does slightly more work before answering `OUT_OF_STOCK`, in exchange for the property that **the system stays correct with the scheduler disabled** — only tidiness degrades. That is why `sweepExpiredReservations` takes an optional `productId` at all; the parameter exists for the demand path. The targeted sweep must be outside the transaction (writes issued while holding the failing transaction's locks would be rolled back with it), and the retry is bounded so contention cannot become a livelock.

**Evidence.** Tests disable the periodic reaper entirely and assert that a crashed checkout's stock is still recovered by a subsequent buyer, then that the retry succeeds.

---

## ADR-11 — Order numbers from a counter outside the transaction

**Context.** Orders need a human-readable identifier.

**Decision.** A dedicated `Counter` document is incremented with `findOneAndUpdate(..., { upsert: true, new: true })` **outside** the checkout transaction. Gaps are acceptable. The `{ orderNumber: 1 }` unique index still guarantees no collision.

**Alternatives considered.**
- *Increment the counter inside the checkout transaction* — rejected: every checkout on the planet writes the same document, so the counter becomes the single hottest document in the system and the transaction's write conflicts serialize all checkouts regardless of which product they buy. Purchases of unrelated products would contend with each other, which is an unnecessary ceiling.
- *Use the ObjectId as the customer-facing number* — simplest and zero-contention, but opaque and unfriendly in support conversations.
- *Derive from timestamp + random suffix* — acceptable; rejected in favour of a counter because sortable, sequential numbers are genuinely useful for reconciliation.
- *Block allocation (a process claims 1,000 numbers and hands them out from memory)* — the right answer for multi-instance throughput; noted as future work rather than built, since a single process makes the plain counter sufficient.

**Consequences.** Order numbers can have gaps after a failed transaction. This is stated because reviewers always notice gaps and always ask; gaps are unavoidable without a counter inside the transaction, and a counter inside the transaction is worse. Emphasised: the order number is a display concern, and `_id` is the identity used everywhere internally.

**Evidence.** A benchmark shows checkout throughput unaffected by unrelated-product contention while the counter is outside the transaction.

---

## ADR-12 — Vitest + supertest + `MongoMemoryReplSet`

**Context.** The guarantees in this system rest on server behaviour — atomic single-document updates, transaction abort semantics, unique index enforcement, `$jsonSchema` rejection. Mocking Mongo would test our mocks.

**Decision.** Test against a **real** MongoDB started as a **replica set** by `mongodb-memory-server`. Vitest as the single runner for server and client, supertest for HTTP-level tests driven through the real Express app.

**Alternatives considered.**
- *`mongodb-memory-server` as a standalone* — will not work. Transactions are unavailable on a standalone deployment; every transaction test would fail with an opaque error. The harness asserts replica-set mode in `beforeAll` so this fails loudly and early rather than mysteriously and late.
- *Docker Mongo for tests* — viable and closer to production, but slower to start and awkward in some CI environments. `MongoMemoryReplSet` with `wiredTiger` gives the same transaction capability in-process.
- *A `docker-compose.yml` for local development* — what the plan originally specified, and not what shipped. Docker was unavailable in the authoring environment, so the local database is `server/scripts/dev-mongo.mjs`: the same in-process replica set, launched persistently and publishing its URI to `server/.dev-mongo-uri`. The reasoning is that a bootstrap which runs on every `npm test` is verified by construction, whereas a compose file written but never started is a claim, not a capability.
- *Mocking Mongoose models* — rejected. Every property under test here (atomicity, abort, duplicate-key, validator rejection) is a property of MongoDB. Mocking them makes the suite green and the system wrong.
- *Jest* — a sound alternative; Vitest shares tooling and config with the Vite client, so one runner serves both.
- *Asserting latency in concurrency tests* — rejected explicitly. Timing assertions are how concurrency suites become flaky and lose their authority. Tests assert **counts and invariants**; the invariants hold at every moment regardless of how the requests interleave.

**Consequences.** Test setup waits for replica-set readiness, and collection validators must be applied in setup exactly as in production (`applyValidators.js` is shared, not duplicated). Concurrency tests are run repeatedly in CI; a guarantee that holds only on the first run is not a guarantee.

**Evidence.** A trivial transaction test in Phase 0 proves the harness before any application code depends on it.

---

## ADR-13 — No transactional outbox (with the upgrade path documented)

**Context.** Saga steps need to be triggered reliably. An event-driven architecture with an outbox is the textbook answer for multi-service reliability.

**Decision.** None. The checkout saga runs in-process; payment resolution arrives synchronously, via an HMAC-verified webhook, or via the expiry reaper.

**Alternatives considered.**
- *Transactional outbox + a message broker* — rejected for this scope. An outbox exists to guarantee that a state change and its emitted event are committed together when the publisher and consumer are separate processes that can crash independently. Here the "consumer" is the same process and the same transaction, so it would add an outbox collection, a relay, a broker, and a consumer to solve a problem we do not have — while introducing new failure modes (relay lag, duplicate delivery, ordering) that this system currently does not have to reason about.
- *Polling-based job queue* — the reaper already is one; a second one would duplicate it.

**Consequences.** The design does not scale horizontally to multiple services without this work, and that is accepted and stated. The upgrade path is concrete: because every state change already goes through the single `transition()` chokepoint with an appended `statusHistory` entry, that chokepoint is the natural place to emit an event, and the `statusHistory` write is already inside the transaction — so adding an outbox collection is a localised change to one function rather than an architectural rewrite. That property — every state change funnelled through one place — is precisely what makes the future upgrade cheap, and it is why the chokepoint exists even though it is not strictly required today.

---

## ADR-14 — Express 5 and Zod at the boundary

**Context.** The API must validate untrusted input rigorously, and Express 5 changes several long-standing behaviours.

**Decision.** Express 5, with every route's body, params and query validated by a Zod 4 schema in middleware before the handler runs, and configuration validated by the same library at boot.

**Alternatives considered.**
- *Manual validation in handlers* — rejected: it drifts, it is forgettable on a new route, and it is untestable in isolation from the route.
- *Joi* — capable and maintained; Zod was chosen because its schemas infer static types, so one declaration yields both runtime validation and compile-time types.
- *express-validator* — rejected: its documentation verifies Express 4.x, so adopting it on Express 5 would mean verifying compatibility in code we would rather not own.
- *Inline regex route patterns* — no longer supported in Express 5's `path-to-regexp`. Zod param validation sidesteps the change entirely and produces better error messages than a routing-level rejection.
- *Express 4* — viable and lower-risk; rejected because Express 5's automatic forwarding of rejected promises from handlers removes an entire category of bug (an unhandled rejection in an `async` handler hanging the request), and because the migration differences that matter are all in code we are writing fresh.

**Consequences.** Validation is one narrow, replaceable layer with its own unit tests, and every 400 carries field-level detail from the same schema that typed the input. Two Express 5 details are handled explicitly: `req.body` may be `undefined` when no body is sent (the schema rejects it rather than crashing), and legacy `res` signatures are not used anywhere. Route params are treated as untrusted strings and cast explicitly — Express 5 no longer offers inline regex constraints.

**Evidence.** Unit tests assert the schemas reject negative, zero and non-integer quantities, oversized carts, unknown fields, duplicate product ids, and a missing idempotency key — before any HTTP layer is involved.
