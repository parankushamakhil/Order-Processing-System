# Verification Report — `differentiation_implementation_plan.md`

**Date:** 16 October 2026
**Scope:** Does the plan's every task exist, work, and hold up under adversarial reading?
**Method:** Read every file the plan names plus every file it implies, then executed the
suites, the build, the judge script and the advertised deployment URL. Findings are
evidence-backed; commands and their output are quoted inline.

---

## 1. Bottom line

**The plan is roughly two-thirds delivered, and the parts that are delivered are mostly
good.** The anti-oversell core, the telemetry wiring, the chaos *tests*, the fulfill/cancel
endpoints and the timeline audit trail are real, tested and defensible.

It is **not** implemented "perfectly, correctly, and without loopholes." There are
**four defects that a reviewer will find**, one of which breaks the plan's own headline
deliverable on first run:

| # | Severity | Defect |
|---|---|---|
| 1 | **Blocking** | `npm run demo:judge` — the Phase 3 flagship — **crashes** on its in-memory fallback path. Reproduced below. |
| 2 | **High** | The judge script's chaos step **cannot fail**. It prints success even when nothing was injected. |
| 3 | **High** | README.md now advertises a live URL that returns **HTTP 404**. The placeholder was swapped for a dead link. |
| 4 | **High** | The "public repo" claim in `README.md` is unverified, and two tracked documentation files still carry the original placeholder text. |

Everything else is **partial-but-honest** (documented deviations) or **cosmetic** (a specified
file path that was inlined instead).

### Verified green

| Check | Command | Result |
|---|---|---|
| Full test suite | `npm test` | **185 passed / 185**, 19 files, `EXIT=0` (baseline was 178) |
| Production build | `npm run build` | `EXIT=0`, zero warnings, 44 modules |
| Chaos integration tests | `npx vitest run tests/integration/chaos.test.js` | **2 passed** |
| Saga property tests | `npx vitest run tests/property/saga.property.test.js` | **1 passed** |
| Demo-guide link integrity | script over all `](…)` targets | **12 relative links, 0 broken** |

---

## 2. Phase 0 — Submission hygiene

### 0.1 README placeholders — **PARTIAL, and the fix introduced a new defect**

`README.md` lines 27 and 39 no longer contain placeholders. Line 27 now reads:

> `| **Live Deployment URL** | \`https://order-processing-system.onrender.com\` *(see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for Render deployment)* |`

**But that URL does not serve the application.** Verified twice:

```
$ curl -s -o /dev/null -w "HTTP %{http_code} after %{time_total}s\n" --max-time 15 \
    https://order-processing-system.onrender.com/healthz
HTTP 000 after 15.004806s

$ curl ... --max-time 75 https://order-processing-system.onrender.com/healthz
HTTP 404 after 24.404961s
```

DNS does resolve (`216.24.57.18`, Render's proxy), so this is not a typo in a hostname — the
host exists and the platform answers, but **there is no application there.** A Render free-tier
cold start would eventually return `200`, not a proxy `404`. Whatever the cause (service
deleted, suspended, or renamed), the README now points a reviewer at a dead endpoint.

This matters more than the placeholder it replaced. `‹paste your deployed Render URL here›`
reads as *"not yet deployed"*; a plausible-looking live URL that 404s reads as *"claimed to be
deployed and isn't"* — a credibility problem rather than a completeness one.

**Also unfixed:** `README.txt` (tracked, and **not** in the changed-file set) still contains both
original placeholders on lines 27 and 39:

```
README.txt:27: Live Deployment URL     https://your-app-name.onrender.com (see docs/DEPLOYMENT.md ...)
README.txt:39: Live URL: <paste your deployed Render URL here>
```

`git status --porcelain README.txt` is empty, confirming the file was never touched.

**Action:** either deploy and verify the URL returns `200`, or revert both files to an explicit
"local-only, one-command" statement. Do not ship an unverified URL in a submission table.

### 0.2 DEMONSTRATION_GUIDE.md — **DONE**

- `file:///` link count: **11 → 0**. Verified: `grep -c "file:///"` returns `0`.
- All **12** relative links resolve (`[ADR-03](DECISIONS.md)`, `[webhook.routes.js](../server/src/routes/webhook.routes.js)`, …) — checked programmatically against the filesystem, **0 broken**.
- Fragile hardcoded anchors (`#L52`) are gone.
- The file **is now staged in git** (`git status` shows `AM docs/DEMONSTRATION_GUIDE.md`), so it will be part of the submission.

Only nit: nothing in this body of work is **committed**. Every change is staged or unstaged in the
working tree. If the submission is `git archive` or a fresh clone, none of it exists. Worth an
explicit commit before submitting.

### 0.3 Currency alignment — **OUTCOME ACHIEVED, but by a different mechanism than specified**

The plan prescribed four artifacts:

1. Add `CURRENCY` to server config (default `'USD'`, supporting `['USD','INR']`) — **not present.** I read the entire config schema (125 lines): there is no `CURRENCY` key.
2. Expand model enums to `['USD','INR']` — **not done.** Both are single-valued INR:
   ```js
   // server/src/models/Product.js:27
   currency: { type: String, required: true, enum: ['INR'], default: 'INR' },
   // server/src/models/Order.js:72
   currency: { type: String, required: true, enum: ['INR'], default: 'INR' },
   ```
3. Make the client formatter currency-driven — **done, in the honest direction:**
   ```js
   // client/src/lib/format.js:5
   const symbol = currency === 'INR' ? '₹' : `${currency} `;
   ```
   A `USD` order would now render as `USD 12.00`, not as a fabricated `₹`. The original lie (`enum: ['USD']` in the schema while the UI printed `₹` for both) is genuinely gone.
4. Document multi-currency in `docs/DECISIONS.md` — **not done.** `DECISIONS.md` ends at **ADR-14**; there is no currency entry.

The drifted-record problem is **fixed**, and standardising on INR is arguably the better call —
multi-currency with a single ledger currency is a feature that adds surface area without adding
credibility. But the plan as written was not followed, and the `$jsonSchema` validators were also
switched (`enum: ['USD']` → `enum: ['INR']` in `server/src/db/validators.js`), so the choice is at
least consistent across the schema *and* the storage-layer backstop. Record it in DECISIONS and this
item is closed.

### 0.4 Refund synchronisation — **PARTIAL, and non-atomic where the plan demanded atomicity**

**Landed:** `POST /api/admin/payments/:orderId/refund` now writes back to the order, which was the
actual bug:

```js
// server/src/routes/admin.routes.js
await Order.updateOne({ _id: orderId }, {
  $set: { 'payment.status': PAYMENT_STATUS.REFUNDED },
  $push: { statusHistory: { from: order.status, to: order.status, at: new Date(),
                            reason: 'payment_refunded', actor: 'admin' } },
});
```

**Gaps:**

- **No transaction.** The plan said *"within a transaction, update `Order.payment.status`…"*. The real
  sequence is three independent writes: `gateway.refund()` → `PaymentAttempt.updateOne` →
  `Order.updateOne`. A crash between the last two leaves the **attempt `refunded` while the order still
  reports `refund_required`** — and the admin UI keys off `refund_required` (see
  `OrdersPanel.jsx:162`), so the order keeps advertising a refund that has already been paid out.
  The plan's own wording identified atomicity as the requirement; the implementation does not provide it.
- **`?restock=true` is not implemented.** `restock()` is never invoked from the refund path, and the
  route validates `params` only — there is no query schema, so the parameter is silently ignored. The
  "return items to `onHand` and `available`" capability is simply absent.
- **`RefundsPanel.jsx` was not touched.** It is absent from the 32-file diff. The plan explicitly
  named it as needing an update.
- The `statusHistory` entry uses `from === to`, so it is a *same-state event*, not a transition.
  Honest, but any consumer that assumes history entries are transitions will misread it.

---

## 3. Phase 1 — High-differentiator capabilities

### 1.1 Live contention telemetry — **IMPLEMENTED, with one permanently-dead counter**

This is the best-executed part of the plan. `server/src/lib/metrics.js` is a real registry with
`inc`, `observeDuration`, a bounded 2000-sample latency window, `getSnapshot()` for JSON and
`toPrometheus()` for text. `GET /metrics` is mounted (`app.use(healthRoutes)` in `app.js:140`) and
asserted by a test (`smoke.test.js:154`). `GET /api/admin/telemetry` + `POST …/telemetry/reset`
exist, and the Concurrency Lab returns a snapshot inline so the panel can render it live.

Wiring verified by enumerating **every** call site (`grep -rn "metrics\.inc\|observeDuration" server/src`):

| Metric | Wired at |
|---|---|
| `checkout_attempts_total` | `checkout.service.js:55` |
| `checkout_success_total` | `checkout.service.js:121` |
| `checkout_rejections_total{reason}` | `checkout.service.js:74,96,113,127,129,131,133` |
| `transaction_retries_total` | `db/transaction.js:30` |
| `idempotency_replays_total` | `checkout.service.js:80,93,110` |
| `reservation_reclaims_total{trigger}` | `expiry.service.js:95` (correctly splits `lazy_demand` / `timer_sweep`) |
| `checkout_duration_ms` | `checkout.service.js:122,125` |

Note `transaction_retries_total` is incremented **inside** the transaction callback but *before* `fn(s)`
— correct, since it counts callback re-runs, and correct that it exists on a shared `tries` counter
outside the callback.

**Defect — the `rate_limited` counter can never move.** The registry declares it:

```js
checkout_rejections_total: { out_of_stock: 0, price_changed: 0, checkout_in_progress: 0,
                             rate_limited: 0, other: 0 },
```

and the plan lists `rate_limited` as a required reason. But **nothing increments it**: rate limiting
lives in `middleware/rateLimit.js`, which does not import `metrics`. So `/metrics` exports a series
that is structurally guaranteed to stay `0` forever. Either wire it in the middleware or drop it —
a metric that cannot move is worse than no metric, because it implies coverage that isn't there.

**Minor:** percentile selection is `sorted[floor((pct/100) * n)]`, so "p50" of `n` samples is actually
the `n/2 + 1`-th value — an approximation, acceptable at this scope but worth a comment. Samples are
also not labelled by policy, so a `fifo` run and a `race` run share one latency pool (see 2.1).

### 1.2 Deterministic chaos harness — **PARTIAL: 2 of 4 fault points, no demo button**

**Landed, and it is genuinely strong.** The seam is real and correctly reachable:

- `server/src/services/chaos.service.js` — `check(step)` throws a `CHAOS_FAULT` error; `setFault`/`clear`.
- `checkout.routes.js` translates the header: `const chaosFault = req.get('x-chaos-fault') || null;`
- `checkout.service.js` accepts it (`chaosFault = null`), calls `chaos.setFault()`, and injects at the two real saga boundaries — **before** the gateway call (`chargeAndSettle`) and **after** a successful charge (immediately before `settleSuccess`). The `finally { if (chaosFault) chaos.clear(); }` is correct.
- `tests/integration/chaos.test.js` **passes** and is not a tautology. It asserts: a `500`; the order still `pending_payment` **with the hold intact** (`available 3 / reserved 2`); the reaper returning all 5 units (`released: 1`); that the out-of-band `settleSuccess` **loses the CAS** (`lost: true`) because the order already expired; that a `refund_required` **obligation is created** and returned by `getRefundObligations()`; and that `checkInvariants()` is clean afterwards. That is a proper proof of the charge-versus-expiry race.
- `paymentSettlement.service.js` really does record the obligation on CAS loss (`status: PAYMENT_STATUS.REFUND_REQUIRED`) with a comment explaining that it upserts precisely so "money moved" cannot be lost.

**Gaps:**

- **Two of the plan's four fault points are missing.** Implemented: `crash_before_charge`, `crash_after_charge`. Not implemented as injection points: **`gateway_timeout`** and **`delay_settlement_past_lease`**. A timeout can be produced by the simulated gateway's `tok_timeout`, and a lapsed lease is exercised by the expiry tests, but neither is a *chaos fault* — you cannot deterministically inject them at a named saga step, which was the point.
- **No "Simulate Chaos / Mid-Charge Crash" button.** The plan required one in the admin UI. `grep -ri chaos client/` returns **nothing** — no API method, no button, no reference. The plan's third component is simply absent.
- **Naming:** the plan says `crash_after_charge_before_settle`; the code says `crash_after_charge`. Same semantics, but the header value an evaluator would copy from the plan will not work.

### 1.3 (T1.5) Order event timeline — **IMPLEMENTED, but inlined, and one promised element is missing**

The plan said *"Create `client/src/components/OrderTimeline.jsx`."* That file **does not exist**.
The component is a local function inside the file it is used in:

```
client/src/pages/admin/OrdersPanel.jsx:577   <OrderTimeline order={order} attempts={attempts} claims={claims} />
client/src/pages/admin/OrdersPanel.jsx:618   function OrderTimeline({ order, attempts = [], claims = [] }) {
```

The functionality is real and covers most of the plan's narrative: ingestion & idempotency (key,
status, attempts, takeovers) → TX1 pricing snapshot + reservation → payment lease with a live/ released
state → one step per gateway attempt with amount/ref `providerRef`/latency → each `statusHistory` entry
badged `Stock Committed (TX2)` / `Stock Released (TX3)` / `Fulfilled`, with actor, reason and timestamp.

**Missing versus the plan:**
- No dedicated **"Server-Side Pricing Calculated (discounts & tax applied)"** step — pricing is folded into the TX1 step and its discount/tax detail is not surfaced here.
- No explicit **"exact branch point"** rendering for a refund obligation or a replay. The plan promised the branch point be *shown*; the timeline shows transitions but does not call out where the saga diverged.

Functionally this is a good audit trail. Structurally it deviates from the specified path, and the
"branch point" deliverable is not there.

---

## 4. Phase 2 — Novel mechanisms

### 2.1 Allocation fairness — **PRESENT IN THE UI, but the substance does not support the claim**

This is the plan's most original idea and the part most likely to be questioned, so it deserves the
most scrutiny. What exists:

- `labSchema` accepts `policy: z.enum(['race','fifo','lottery']).default('race')` (`admin.routes.js`).
- The UI exposes it, labelled **"Allocation Policy (T1.3 Fairness)"**, with the three options (`ConcurrencyLabPanel.jsx:201`).

**Five problems:**

1. **No Gini coefficient, no win-spread statistic.** The plan's explicit deliverable — *"Display win distribution statistics (Gini coefficient / win spread) across buyer IDs"* — is **absent**. A case-insensitive search for `gini` across all `*.js`/`*.jsx`/`*.mjs` source returns **0 matches**; the only occurrence anywhere in the repo is the plan file itself (line 151), plus this report. `fairness` appears in the UI only as prose labels (`ConcurrencyLabPanel.jsx:201,372`), never as a computed statistic.
2. **The "winning buyer IDs" it does show are wrong.** The server collects them as:
   ```js
   settled.forEach((outcome, idx) => { ... confirmedBuyerIndices.push(idx + 1); });
   ```
   `settled` is the result array of `buyerOrder`. For `lottery`, `buyerOrder` has been **shuffled** first, so `idx + 1` is the winner's *position in the shuffled array*, not the buyer's identity. The UI then labels these `Buyer #{idx}` — so "Buyer #3" carries no relationship to the third buyer. The identity mapping the feature exists to report is destroyed by the shuffle that creates the lottery.
3. **`fifo` proves nothing.** It is implemented as a fully serial `await` loop, so the result is *deterministically* the first N buyers in array order — always badges `1..N`. A fairness metric that always reports a perfectly fair result because the policy removed contention is not a measurement.
4. **The three policies are not comparable.** Because `fifo` serialises, its `durationMs`, rejection mix and retry counts are measured under a completely different load profile from `race`/`lottery`. The comparison the selector invites is not like-for-like, so it cannot support a conclusion. (This also contaminates the shared latency pool — see 1.1.)
5. **No ADR-15, and no tests.** `grep -n "ADR-15"` matches **only the plan file**; `DECISIONS.md` ends at ADR-14. And `grep -rn "policy" server/tests` returns **nothing** — the five Concurrency Lab tests in `admin.test.js` never exercise `fifo` or `lottery`.

**Verdict:** the feature is surface-deep. It is selectable and it changes how the lab runs, but the
statistics it reports are misleading and the decision record it was supposed to produce does not exist.

### 2.2 Model-based saga property tests — **IMPLEMENTED, but the stated method was not followed**

`server/tests/property/saga.property.test.js` exists, uses `fast-check`, and **passes** (21.9 s). It
generates action plans over six types (`checkout_success`, `checkout_decline`, `checkout_timeout`,
`sweep`, `reconcile`, `fulfill`), runs each against a fresh product, and asserts `checkInvariants()`
is clean plus three counter relations.

**Three deviations that materially weaken it:**

1. **`numRuns: 5`.** Five random plans of 4–8 actions each. Two of the six action types (`reconcile`,
   `fulfill`) are conditional — they no-op unless a matching prior state happens to exist in the in-memory
   `orders` array. With five runs, most generated plans will not reach the interesting interleavings. This
   is a smoke test wearing a property test's name; a meaningful sample here is in the hundreds, and the
   45 s timeout has plenty of headroom (the run takes 21.9 s at `numRuns: 5`).
2. **Invariants are checked once at the end, not after every prefix.** The plan's stated assertion was
   *"after every sequence prefix, invariants I₁–I₇ remain completely intact."* The implementation checks
   only the final state, so a transient violation that self-heals — exactly the class of bug a saga
   interleaving test exists to find — would pass.
3. **The three trailing counter assertions are near-tautological.** `onHand >= 0`, `reserved >= 0`,
   `available >= 0` are already implied by I2, and `onHand === available + reserved` restates I1. They add
   no coverage.

Credit where due: the file correctly routes through `settlePaymentOutcome` for `reconcile`, so the
asynchronous resolution path *is* covered when it fires, and the invariant checker it calls is the real,
seven-invariant, whole-database one.

### 2.3 Client HTTP 202 polling — **IMPLEMENTED, with three deviations**

`useCheckout.js` adds an effect that polls while `result.pending`, clears the cart on `paid`, and stops
when the order leaves `pending_payment`. `presentation.js` does return `pending: true` and
`pollUrl: '/api/orders/:id'` for `PENDING_PAYMENT`, so the trigger is real, and `CartPage.jsx` renders
the "Awaiting provider — polling for resolution" state.

**Deviations:**
- **No maximum attempt count.** The plan specified `max attempts 10`. The effect is an uncapped
  `setInterval(…, 1500)`. It does terminate in practice — the reaper will expire the order and move it out
  of `pending_payment` — but it is unbounded by design, and there is no backoff or give-up state.
- **It polls the order endpoint, not `data.pollUrl`.** `pollUrl` is stored in component state and **never
  read**. Functionally equivalent (they are the same resource), but the field is dead code and the plan's
  contract is not honoured literally.
- No explicit "resolution card" for `payment_failed` / `refund_required` as the plan requested — the panel
  reflects the order's terminal state but does not distinguish those two outcomes with dedicated copy.

### 2.4 Admin fulfillment & customer cancellation — **IMPLEMENTED WELL**

This is the cleanest task in the plan.

- **`POST /api/admin/orders/:id/fulfill`** — CAS `PAID → FULFILLED` via `transition()`, with a `409 ORDER_NOT_PAID` carrying the current status when the CAS misses. Correctly refuses `EXPIRED`/`CANCELLED`.
- **`POST /api/orders/:id/cancel`** — customer-scoped, `PENDING_PAYMENT → CANCELLED`, releases stock through the `release()` primitive **inside** the same transaction, flips PROCESSING idempotency claims to retryable, and returns `409 ORDER_NOT_PENDING` otherwise. Stock is returned immediately, not left to the reaper.
- **UI:** "Mark as fulfilled" (`OrdersPanel.jsx:348`, gated on `canFulfill = status === 'paid'`) and "Cancel order" (`OrdersPage.jsx:283` → `api.cancelMyOrder`). `api.js` exposes both.
- **Tests:** `adminOrders.test.js` gained 11 tests covering the queue and these transitions.

Two notes, neither a hole: the customer route authorises `isOwner || admin`, so an admin can also reach
cancellation through the customer path (broadening, not a bypass). And both handlers read `order.items`
outside the transaction — safe here because the CAS still guards the write, but it is the kind of thing
worth a comment.

---

## 5. Phase 3 — Judge mode & end-to-end verification

### 3.1 Judge script — **IMPLEMENTED BUT BROKEN IN ITS HEADLINE PATH**

This is the most consequential finding in the report, because the plan presents this script as the
effortless-evaluation payoff.

**(a) The in-memory bootstrap — the plan's first stated step — crashes.** `judge-run.mjs` does:

```js
replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const uri = replSet.getUri();
await connectDb(uri);          // judge-run.mjs:36
```

`MongoMemoryReplSet.getUri()` returns a **base URI with no database name**, and `connectDb` has an
explicit guard that rejects exactly that. Reproduced:

```
$ MONGODB_URI="mongodb://127.0.0.1:59999/judge?replicaSet=rs0" npm run demo:judge
=== 1. INITIALIZING DATABASE & ENVIRONMENT ===
Local MongoDB not found (Could not reach MongoDB at mongodb://127.0.0.1:59999/judge?replicaSet=rs0 ...).
Starting ephemeral in-memory replica set...

Judge run failed: Error: MONGODB_URI has no database name in its path. Append the name before the
query string, e.g. ...mongodb.net/orders?...
    at connectDb (file:///D:/.../server/src/db/connect.js:18:13)
    at setupDatabase (file:///D:/.../server/scripts/judge-run.mjs:36:11)
JUDGE_EXIT=1
```

**The repository already contains the fix, and the judge script did not use it.** `tests/helpers/globalSetup.js`
documents this exact trap and works around it:

> `MongoMemoryReplSet.getUri()` returns the base URI without a database path (e.g.
> `mongodb://127.0.0.1:PORT/?replicaSet=testset`). Without an explicit `/dbname` the connectDb guard
> rejects it with "MONGODB_URI has no database name". Use `test` …

```js
const url = new URL(baseUri);
url.pathname = '/test';
const uri = url.toString();
```

So the pattern was known, written down, and shipped one directory away. Consequence: **`npm run demo:judge`
works only when an external MongoDB with a database name in `MONGODB_URI` is reachable.** The
"bootstraps a single-node replica set in memory" claim — step 1 of the plan's Task 3.1 — fails on first run.

**(b) The chaos step is unfalsifiable.** Note the `try/catch`:

```js
try {
  await checkout({ ..., chaosFault: 'crash_after_charge' });
  throw new Error('Expected chaos failure did not trigger');
} catch (err) {
  process.stdout.write(`  Simulated crash caught: "${err.message}"\n`);
}
```

If the injection does nothing, `checkout` returns normally, the script throws its own error, the same
`catch` swallows it, and it prints `Simulated crash caught: Expected chaos failure did not trigger` —
then proceeds to a green **`ALL DEMO & VERIFICATION CHECKS PASSED`**. There is no path from "chaos is
broken" to a non-zero exit. The step cannot fail, so it proves nothing about the seam it claims to prove.

**(c) The counts are printed, never asserted.** Step 2 prints `Confirmed orders: N (Expected: 10)` but
never compares `N` to 10 and never compares the rejection count to 40. It relies entirely on
`checkInvariants()`. An off-by-one in confirmations that still left the counters balanced would print a
mismatch and still PASS.

**(d) The reset is destructive and unscoped.** `setupDatabase()` does:

```js
Product.deleteMany({ sku: /^JUDGE-/ }),   // scoped — fine
Order.deleteMany({}),                     // ALL orders
IdempotencyKey.deleteMany({}),            // ALL claims
PaymentAttempt.deleteMany({}),            // ALL attempts
Customer.deleteMany({ email: /@judge\.local$/ }),
```

Three of the five are **unscoped**. Because `loadEnv.js` preferentially loads the repository-root `.env`
(which exists — I confirmed the file is present) and real environment variables win over it, running
`npm run demo:judge` in a configured checkout will connect to the **real** database and **delete the
entire demo dataset** — including the 487 payment attempts and the seeded orders that `README.md`
advertises as the thing to look at. This is why I ran the script with `MONGODB_URI` overridden to an
unreachable port rather than letting it touch the configured database.

`server/scripts/bench.mjs` has the same unscoped-delete pattern in `resetWorld()`. That one is
**pre-existing** (the only change to `bench.mjs` in this work is `currency: 'USD' → 'INR'`), but
`judge-run.mjs` is new code that copied the hazard into a script a reviewer is *invited* to run.

**Other deviations:** it does not seed the reproducible demo world (the plan's step 2) — it invents three
ad-hoc `JUDGE-*` products; it runs **50** buyers against 10 units where the plan specified 200; and it
prints `p50 / p95` for a latency pool that the whole run shares.

### 3.2 Full regression & build — **DONE**

| Check | Result |
|---|---|
| `npm test` | **185 passed (185)**, 19 files, 98.58 s, `EXIT=0` |
| `npm run build` | `EXIT=0`, 44 modules, `dist/assets/index-BzsHk7mf.js` 350.61 kB (gzip 103.70 kB), **zero warnings** |
| `npm run bench` | **Not run.** It performs the same unscoped `deleteMany({})` and I would not point it at the real database. Its only change in this work is the currency constant, so the README's published figures were not re-derived. |

Test count moved **178 → 185** (+7): 2 chaos, 1 saga property, and additions to `smoke.test.js`
(`/metrics` + telemetry), `adminOrders.test.js` (fulfill/cancel) and the Concurrency Lab tests. All green.

---

## 6. Loophole register

Ordered by how likely a reviewer is to hit it.

| # | Loophole | Where | Why it matters |
|---|---|---|---|
| 1 | Chaos step in the judge run cannot fail | `judge-run.mjs` `testChaosFaultInjection` | A verification step that always reports success is worse than no step; it manufactures confidence |
| 2 | `demo:judge` fallback crashes on first run | `judge-run.mjs:36` vs `globalSetup.js` | The plan's flagship deliverable fails in the exact scenario it was written for |
| 3 | Judge/bench reset deletes all orders, claims and attempts | `judge-run.mjs` `setupDatabase`, `bench.mjs` `resetWorld` | Data loss on a configured checkout; destroys the demo dataset reviewers are told to inspect |
| 4 | Advertised live URL returns 404 | `README.md:27,39` | Reads as "claimed deployed, isn't" |
| 5 | Buyer IDs in the fairness result are shuffled positions | `admin.routes.js` `confirmedBuyerIndices.push(idx + 1)` | The one statistic the feature exists to report is wrong, and mislabelled in the UI |
| 6 | `rate_limited` counter can never increment | `lib/metrics.js` vs `middleware/rateLimit.js` | Exports a series implying coverage that does not exist |
| 7 | Refund writes are not atomic | `admin.routes.js` refund handler | Crash between writes leaves the order advertising a refund already paid out |
| 8 | Saga invariants checked once, not per prefix | `saga.property.test.js` | Transient violations — the target class — pass |
| 9 | `numRuns: 5` | `saga.property.test.js` | Effectively a smoke test; conditional actions rarely fire |
| 10 | FIFO serialises instead of queueing | `admin.routes.js` lab handler | Removes the contention it claims to allocate fairly; not comparable to `race`/`lottery` |
| 11 | No Gini / win-spread, no ADR-15, no policy tests | `ConcurrencyLabPanel.jsx`, `DECISIONS.md`, `server/tests` | The plan's stated evidence for T1.3 is absent |
| 12 | Two of four chaos fault points missing | `checkout.service.js` | `gateway_timeout` and `delay_settlement_past_lease` are not injectable at named steps |
| 13 | No chaos UI button | `client/` | Plan Task 1.2 component 3 absent entirely |
| 14 | `?restock=true` absent on refund | `admin.routes.js` | Plan Task 0.4 capability not built; param silently ignored |
| 15 | `pollUrl` dead; polling uncapped | `useCheckout.js` | Dead field; no max-attempts/backoff as specified |
| 16 | `OrderTimeline.jsx` does not exist | inlined in `OrdersPanel.jsx:618` | Specified artifact missing; "branch point" rendering not delivered |
| 17 | Placeholders remain in `README.txt` | `README.txt:27,39` | Second tracked file carries the original defect |
| 18 | Nothing is committed | working tree | A fresh clone / archive contains none of this work |

---

## 7. Verdict per task

| Task | Plan says | Reality | Verdict |
|---|---|---|---|
| 0.1 README placeholders | clean, zero placeholders | README.md swapped in a **404** URL; README.txt untouched | **Failed** |
| 0.2 Demo guide | relative links, tracked | 0 `file:///`, 12 links all valid, staged | **Done** |
| 0.3 Currency | config `CURRENCY`, `['USD','INR']`, DECISIONS note | standardised on **INR only**; drift fixed; no config key, no ADR note | **Done differently** |
| 0.4 Refund sync | in a transaction, `?restock=true`, UI | order updated ✔ but **3 separate writes**; no restock; RefundsPanel untouched | **Partial** |
| 1.1 Telemetry | `/metrics` + live UI | real registry, wired, tested; `rate_limited` dead | **Done** (one nit) |
| 1.2 Chaos | 4 fault points, tests, UI button | 2 fault points, **good tests**, no UI button | **Partial** |
| 1.3 Timeline | `OrderTimeline.jsx`, branch points | inlined, substantive, no branch-point rendering | **Partial** |
| 2.1 Fairness | FIFO/lottery, **Gini/spread**, ADR-15 | policies exist; no Gini, wrong IDs, serial FIFO, no ADR, no tests | **Partial / cosmetic** |
| 2.2 Saga property tests | invariants after **every prefix** | end-state only, `numRuns: 5` | **Partial** |
| 2.3 Client 202 polling | `pollUrl`, max 10 attempts | polls order endpoint, uncapped, `pollUrl` dead | **Partial** |
| 2.4 Fulfill & cancel | endpoints + buttons | endpoints, UI, tests — all correct | **Done** |
| 3.1 Judge script | one-command, in-memory bootstrap | **crashes on fallback**; chaos step unfalsifiable; destructive reset | **Failed** |
| 3.2 Regression & build | 178 + new suites, clean build | **185/185, build clean**; bench not run | **Done** |

**Score (13 tasks): 5 delivered, 6 partial, 2 failed.** One of the 5 (0.3, currency) was achieved by a different route than the plan specified.

---

## 8. Recommended repairs, in order

1. **Fix the judge script's in-memory URI** — take the three lines already written in `tests/helpers/globalSetup.js` and set `url.pathname = '/judge'` before `connectDb`. One-line bug, blocks the flagship deliverable.
2. **Make the judge chaos step falsifiable** — assert the thrown error's `code === 'CHAOS_FAULT'` (or set a flag and fail the step when no fault fired). Never let "expected failure did not trigger" be swallowed by the same `catch`.
3. **Scope the destructive resets** — replace `Order.deleteMany({})` / `IdempotencyKey.deleteMany({})` / `PaymentAttempt.deleteMany({})` with ownership-scoped deletes (e.g. by the `JUDGE-`/`bench-` buyer ids), or refuse to run at all unless the target database name ends in `_demo`/`_bench`. Add a confirmation banner naming the database it is about to wipe.
4. **Resolve the README URL** — either deploy it and verify `200`, or state plainly that the project runs locally via one command. Fix `README.txt` at the same time, or delete the duplicate file.
5. **Correct or remove the fairness statistics** — map winners back to real buyer indices (record `String(buyer._id)` alongside the outcome instead of positional `idx`), compute an actual Gini coefficient, and make `fifo` a *concurrent* arrival-ordered admission rather than a serial loop so the three policies are comparable.
6. **Wrap the refund in a transaction** and add `?restock=true`; add the DECISIONS note for currency and **ADR-15** for allocation policy.
7. **Strengthen the property test** — `numRuns: 50+`, assert `checkInvariants()` after **each** action, not only at the end.
8. **Wire or delete `rate_limited`** in `/metrics`.

## 9. What not to change

The parts a reviewer will respect most are already right, and none of them need work:

- The **anti-oversell core** — conditional `$inc`, `$jsonSchema` non-negativity backstop, 185 green tests including 200-concurrent-buyers-for-10-units asserting *stock consumed equals stock that existed*, not merely "10 requests returned 201".
- The **chaos integration tests** — the strongest new artifact in the plan. They prove the charge-versus-expiry race end to end, including the `lost: true` CAS and the resulting refund obligation.
- **Fulfill/cancel** — correct CAS semantics, correct `409`s, stock returned through the primitive inside the transaction.
- The **`$or: [null, …]` type-bracketing fix** documented in `expiry.service.js` and `invariants.js` — a real, subtle bug found by a test rather than by reasoning, and explained in the code.
- The **paired A/B-then-B/A benchmark** and the README's account of getting its own number wrong twice. Declining to re-run `bench` is a limitation of this verification, not a defect in it.
