================================================================================
INVENTORY-AWARE ORDER PROCESSING SYSTEM
================================================================================

A MERN-stack order processing system: products, inventory, customer orders, checkout. The hard
requirement is that stock can never be oversold under concurrency, that inventory records stay
internally consistent, and that a checkout which is retried, duplicated, declined or interrupted
still reaches exactly one correct outcome.

Status: implemented and verified. 178 tests across 17 files pass against a real MongoDB replica
set (`npm test` -> exit 0), and the concurrency suite runs with zero flakes. The client builds cleanly, and the whole stack — API and built SPA — serves from a single production
process, verified in a browser as well as by curl. A reproducible demo world of 205 real-world products with images,
620 orders, 487 payment attempts and 424 idempotency claims loads with one command
(`npm run seed:demo`).

Documentation references:
- Architectural decisions and trade-offs: docs/DECISIONS.md
- How to deploy it, and how to verify the deploy: docs/DEPLOYMENT.md

--------------------------------------------------------------------------------
SUBMISSION DETAILS
--------------------------------------------------------------------------------

Item                    Value
--------------------------------------------------------------------------------
GitHub Repository       https://github.com/parankushamakhil/Order-Processing-System
Live Deployment URL     https://your-app-name.onrender.com (see docs/DEPLOYMENT.md for Render deployment)
Admin Login             admin@shop.test / password1234 (Access to Operations & Concurrency Lab)
Customer Login          shopper@shop.test / password1234 (Storefront & isolated cart checkout)
Test Suite              178 tests across 17 files (100% passing)
Catalogue Data          205 real-world products with high-resolution photography across 10 categories
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
LIVE DEPLOYMENT
--------------------------------------------------------------------------------

Live URL: <paste your deployed Render URL here>

Deployment is zero-config using the checked-in blueprint render.yaml connected to a free
MongoDB Atlas cluster. The full walkthrough, environment variables and post-deploy smoke checklist
are in docs/DEPLOYMENT.md.

Once it is running, the URL above is a single origin for the API and the UI — which is why there
is no CORS configuration to get wrong, and why SERVE_CLIENT defaults to on in production.

Demo accounts:
Created by `npm run seed:demo`. They share one password because they are throwaway credentials for a
demonstration:

Role                                                          Email                 Password
------------------------------------------------------------------------------------------------
Administrator — sees Operations and the Concurrency Lab       admin@shop.test       password1234
Customer                                                      shopper@shop.test     password1234
------------------------------------------------------------------------------------------------

48 more customers exist at <first>.<last><n>@demo.shop.test, same password.


What to look at, in order:
1. Catalogue — 205 real-world products with high-resolution photography and live availability (onHand - reserved), including a sold-out band and a low-stock band, so the empty and scarce states are real rather than hypothetical.
2. Cart -> checkout — the line items, discount, tax and shipping are computed on the server; the totals in the response are the ones that were charged. Change a price in the database and the checkout refuses with PRICE_CHANGED rather than silently charging a stale total.
3. Place the same cart twice (or interrupt it by reload) — the retry returns the first order with Idempotency-Replayed: true and one charge, never a second order.
4. Operations -> Concurrency Lab (admin) — set a product to 10 units, fire 200 buyers, and read the table: 10 confirmed, 190 rejected OUT_OF_STOCK, available: 0, invariants clean. Verified on the production build: 200 buyers against 100 units -> exactly 100 confirmed, 100 rejected, 0 other errors, counters drained to 0, invariants held. The central claim, demonstrated rather than asserted.
5. Operations — the invariant badge (available = onHand - reserved, across the whole catalogue) and the reconciliation report, so the guarantees are visible on live data, not only in a test file.


--------------------------------------------------------------------------------
QUICK START
--------------------------------------------------------------------------------

```bash
npm install
npm run dev:db       # local single-node replica set; writes server/.dev-mongo-uri
npm run seed:demo    # 205 products, 620 orders, 487 payments, 424 claims
npm run dev          # API :4000 + client :5173
```

Then open http://localhost:5173 and sign in as admin@shop.test / password1234. No export is
needed: dev:db writes the URI it chose to server/.dev-mongo-uri, and the API reads .env
(if present) before validating its configuration, so cp .env.example .env is enough to override
anything. A real environment variable always wins over the file, which is what makes the same code
run unchanged on a host with no .env at all.

No Docker or system mongod is needed — npm run dev:db starts the same
mongodb-memory-server replica set the test suite uses, because a standalone Mongo cannot run
transactions at all, and transactions are load-bearing here. Any single-node replica set works —
nothing but MONGODB_URI is hard-coded.

```bash
npm test                 # 178 tests: unit + property + integration + concurrency
npm run test:concurrency # the headline suite, verbose
npm run bench            # contention numbers (see below)
npm run verify           # server tests + client production build
```

Run it the way production runs it:
One process, one port, API and SPA together — the same command the host runs:

```bash
npm run build                          # builds client/dist
NODE_ENV=production npm start          # http://localhost:4000 serves both
```

SERVE_CLIENT defaults to on when NODE_ENV=production, so there is no second service and no CORS
between the two halves.


--------------------------------------------------------------------------------
DEMONSTRATION DATA
--------------------------------------------------------------------------------

npm run seed:demo builds a reproducible world from a fixed RNG seed (so the numbers below are
the numbers you will get), then asserts invariants I1–I7 before exiting — a broken generator fails
the seed instead of quietly producing a demo that misrepresents the system.

The last verified run, in ~2 seconds:
- Products: 205 — diverse real-world products with verified photography across Apparel, Footwear, Electronics, Kitchen, Home Office, Bags, Grooming, Fitness, Outdoors, and Furniture, priced $14.00–$349.00
- Stock spread: Real distribution: sold out, low stock (1–4), thin (5–19), healthy (20–99), and deep (100+) — so every availability state renders live
- Orders: 620 across all statuses: 275 fulfilled · 105 paid · 69 payment_failed · 61 expired · 62 pending_payment · 47 cancelled
- Payment attempts: 487 — 380 succeeded · 46 declined · 23 error · 17 refund_required · 15 refunded · 6 pending
- Idempotency claims: 424, both completed and failed, cross-referenced to their orders
- Customers: 50, including the two demo accounts (admin@shop.test and shopper@shop.test)
- Reserved: 122 units held by open orders

Three details make it more than a faker dump:
- The orders are priced by the real pricing engine. Line items go through priceOrder(), so the seeded history carries the same discounts, tax and shipping the checkout path would produce — not plausible-looking numbers invented alongside it.
- Counters are derived, not invented. reserved is summed from the orders that hold stock and available follows from it, so available = onHand - reserved and reserved = Sum(open-order quantities) (I1, I3) hold by construction.
- Payment state uses the domain's vocabulary, mapped explicitly from the attempts.

Knobs: SEED_DEMO_SCALE=3 (more history), SEED_DEMO_RANDOM_SEED=7 (a different but still
reproducible world), SEED_DEMO_CUSTOMERS=200, SEED_DEMO_KEEP=true (append instead of replace).

The Concurrency Lab writes its own data by design; re-run npm run seed:demo afterwards to return
to a pristine history.


--------------------------------------------------------------------------------
THE FIVE FAILURE MODES, AND WHERE EACH IS SOLVED
--------------------------------------------------------------------------------

The brief tests for overselling. Overselling is only the first of five ways this system can be
wrong, and each one needs its own mechanism:

#   Failure mode                     Mechanism                                                                                                Evidence
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
F1  Lost update / oversell           Conditional single-document atomic $inc: { available: { $gte: q } } and { $inc: { available: -q } }     200 concurrent checkouts for 10 units -> exactly 10 sales
F2  Partial multi-item commit        Multi-document transaction with a deterministic lock order                                              3-item cart failing on item 3 leaves every counter untouched
F3  Reserved stock leaks             Reserve -> capture/release saga + reservation TTL + lazy reclaim                                         Crashed checkout's stock returns without the reaper running
F4  Duplicate / retried checkout     Idempotency keys: unique claim outside the transaction, completed inside it                             50 concurrent same-key requests -> one order, one charge
F5  Crash between charge and record  Two-phase payment lease + compensating refund path                                                      Charged-but-unsettled is recorded as a refund obligation, never ignored

Plus a sixth mechanism: an executable invariant checker (available = onHand - reserved, counters never negative, reserved = Sum(quantities held by pending orders)) that runs after every integration and concurrency test.


What makes this different:
- Eight layers of defence, from Zod at the edge down to a $jsonSchema validator that makes negative stock impossible at the storage layer even if application code is wrong — and a test that bypasses the service layer and proves it.
- Concurrency tests assert counts and invariants, never timing. Timing assertions are how concurrency suites become flaky and lose their authority.
- The honest race is documented. The charge-versus-expiry window is narrowed with two deadlines and, where it remains unsolvable, detected and compensated rather than papered over (§5.4, ADR-08).
- Contention is measured, not asserted.


--------------------------------------------------------------------------------
MEASURED CONTENTION
--------------------------------------------------------------------------------

npm run bench, 200 concurrent buyers of 1 unit each, connection pool 50. Each mode is measured
twice, in opposite orders, after a warm-up round:

Scenario                                      Mode                   Confirmed   Rejected   Rejected p50
--------------------------------------------------------------------------------------------------------
herd — 200 buyers, 10 units, all at once      plain transaction      10          190        1041 ms
                                              fast-fail pre-check    10          190        992 ms
drained — 200 buyers, 0 units                 plain transaction      0           200        328 ms
                                              fast-fail pre-check    0           200        214 ms (-34.6%)
--------------------------------------------------------------------------------------------------------

Every one of the eight runs is correct regardless of the flag: exactly 10 sales for 10 units,
Sum(sold) = 10, available = onHand - reserved, zero invariant problems. Correctness does not depend
on the optimisation, which is the point — the pre-check is advisory and the conditional $inc is
what prevents overselling.


--------------------------------------------------------------------------------
A BUG WORTH READING
--------------------------------------------------------------------------------

While implementing the reaper, a query used paymentLeaseExpiresAt: { $lte: now } on the theory
that null sorts below dates. That is true of sort order and false of query operators: MongoDB
comparison operators are type-bracketed, so $lte: <Date> never matches null or a missing
field. The predicate therefore silently disabled expiry for exactly the orders that needed it most —
a timed-out charge whose lease had been cleared — while every obvious test still passed. It was
caught by an end-to-end reaper test, and the same mistake was found in the invariants checker, where
it would have hidden stranded orders instead of reporting them. Full write-up in ADR-08.

A second one, found only by opening the deployed build in a browser. Vite emits crossorigin on the
module script and stylesheet of the built SPA, so the browser sends an Origin header on those
same-origin requests. The CORS middleware treated "has an Origin header" as "is cross-origin",
looked it up in the allowlist, and answered 403 with the API's JSON error envelope — meaning the
production build loaded no CSS and no JavaScript at all. Every API test passed, every curl
check passed, /healthz was green: curl sends no Origin header, so the broken path was
invisible to the exact tools used to verify the deploy. The fix is a same-origin check before the
allowlist, and the regression test sends an Origin equal to the request's own host.


--------------------------------------------------------------------------------
API REFERENCE
--------------------------------------------------------------------------------

One envelope everywhere: success is { data: ... }, failure is
{ error: { code, message, details?, retryable, requestId } }. The code is stable and
machine-readable, and retryable is part of the contract — it tells a client which failures may be
replayed with the same idempotency key and which must be fixed first. X-Request-Id is echoed on
every response and appears in the structured logs.

Method & path                                Auth          Notes
------------------------------------------------------------------------------------------------------------------------------------
GET /healthz                                 —             Liveness. Deliberately does not touch the database.
GET /readyz                                  —             Readiness: 503 unless the database answers a ping.
POST /api/auth/register                      —             Role is never client-supplied.
POST /api/auth/login                         —             One message for "no such user" and "wrong password".
GET /api/auth/me                             bearer        Current user payload
GET /api/products                            —             page, pageSize, q (name/SKU), inStock, includeInactive.
GET /api/products/:id                        —             Single product lookup
POST /api/products                           admin         Arrives with available = onHand, so I1 holds from the first document.
PATCH /api/products/:id                      admin         Price and metadata only — stock is never set through a generic update.
POST /api/products/:id/stock                 admin         Restock; onHand and available move in one atomic update.
POST /api/checkout                           customer      Requires an Idempotency-Key header. Returns 201 with replayed: false / true.
GET /api/orders                              customer      Own orders only; optional status, limit.
GET /api/orders/:id                          owner/admin   Ownership enforced on every read — no IDOR.
GET /api/admin/inventory/reconcile           admin         Runs the invariant checks over the whole catalogue.
GET /api/admin/inventory/refund-obligations  admin         Money taken, order unfulfilled.
POST /api/admin/inventory/sweep              admin         Trigger the reaper now (it also runs on a timer).
POST /api/admin/orders/:id/cancel            admin         Only while awaiting payment, so no refund is implied.
POST /api/admin/orders/:id/reconcile-payment admin         Ask the provider what happened to a charge we never got an answer for.
POST /api/admin/payments/:orderId/refund     admin         Idempotent: refunding twice reports alreadyRefunded.
POST /api/admin/concurrency-lab              admin         The demonstration endpoint.
POST /api/webhooks/payments                  HMAC          Signed over the raw body (verified before parsing).
------------------------------------------------------------------------------------------------------------------------------------

Error codes, by status: VALIDATION_ERROR · IDEMPOTENCY_KEY_REQUIRED (400) · UNAUTHENTICATED
(401) · PAYMENT_DECLINED · PAYMENT_FAILED (402) · FORBIDDEN (403) · PRODUCT_NOT_FOUND ·
ORDER_NOT_FOUND · ROUTE_NOT_FOUND (404) · OUT_OF_STOCK · PRICE_CHANGED ·
CHECKOUT_IN_PROGRESS · ORDER_NOT_PENDING (409) · IDEMPOTENCY_KEY_REUSE (422) · RATE_LIMITED
(429) · INTERNAL_ERROR (500).


--------------------------------------------------------------------------------
DEPLOYMENT AT A GLANCE
--------------------------------------------------------------------------------

Item            Details
------------------------------------------------------------------------------------------------------------------------------------
Shape           One Node process serving /api/* and the built SPA; one MongoDB.
Database        Must be a replica set — standalone MongoDB cannot run transactions. Atlas free clusters are replica sets.
Config          Environment variables only, validated by Zod at boot. No secret is ever committed.
Host defaults   NODE_ENV=production => SERVE_CLIENT=true, so there is no CORS between the halves and one URL is the whole app.
Build           npm ci --include=dev && npm run build && npm run seed:demo
Health          /healthz for liveness, /readyz for readiness.
Full guide      docs/DEPLOYMENT.md — including the four curl checks that catch the ways this deploy actually fails.
------------------------------------------------------------------------------------------------------------------------------------


--------------------------------------------------------------------------------
REPOSITORY LAYOUT
--------------------------------------------------------------------------------

server/scripts/dev-mongo.mjs   local replica set for dev
server/scripts/bench.mjs       contention benchmark
server/src/config/loadEnv.js   reads .env before config is validated (env vars win)
server/src/domain/             pure logic: pricing, inventory primitives, state machine, invariants
server/src/services/           checkout saga, idempotency, expiry, payments
server/src/scripts/seedDemo.js reproducible demonstration world (I1-I7 asserted at the end)
server/tests/                  unit · property · integration · concurrency
client/                        React 19 + Vite 8 SPA, incl. the Concurrency Lab
client/public/theme-init.js    pre-paint theme, extracted so a strict CSP can stay on
docs/DECISIONS.md              the ADRs
docs/DEPLOYMENT.md             Atlas + Render walkthrough and the post-deploy checks
render.yaml                    blueprint deployment path for Render
.github/workflows/ci.yml       server tests + client build on every push
================================================================================
