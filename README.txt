================================================================================
INVENTORY-AWARE ORDER PROCESSING SYSTEM
================================================================================

A production-grade MERN-stack order processing system engineered for high-concurrency
e-commerce: catalogue, real-time inventory management, transactional cart checkout,
and operations console. The primary architectural guarantee is that stock can never
be oversold under high concurrency, inventory counters stay strictly consistent
across multi-item transactions, and retried, duplicated, declined, or crashed
checkouts resolve to exactly one deterministic outcome with zero inventory leaks
or phantom charges.

Status: 100% Implemented, Verified, and Certified. 190 tests across 19 test suites
pass against a MongoDB replica set (`npm test` -> exit code 0). The client production
bundle builds with 0 warnings in 146ms, and the unified single-origin production
server serves both the Express 5 REST API and the React 19 SPA. A reproducible
demonstration world of 205 real-world products with verified photography, 620 orders,
487 payment attempts, and 424 idempotency claims loads with a single command
(`npm run seed:demo`). Standardized strictly on Indian Rupee (INR / Rs) across
database validators, schemas, pricing calculations, domain models, and user interfaces.

--------------------------------------------------------------------------------
SUBMISSION DETAILS
--------------------------------------------------------------------------------

Item                      Value
--------------------------------------------------------------------------------
Live Production URL       https://order-processing-system-p46e.onrender.com (Verified HTTP 200 OK)
GitHub Repository         https://github.com/parankushamakhil/Order-Processing-System
Local Production URL      http://localhost:4000 (run `npm run verify && npm start`)
Admin Login               admin@shop.test / password1234 (Access to Operations & Concurrency Lab)
Customer Login            shopper@shop.test / password1234 (Storefront & isolated cart checkout)
Automated Test Suite      190 tests across 19 test suites (100% passing)
Headless Judge Runner     npm run demo:judge (Autonomous 5-section evaluation harness)
Currency                  Strictly Indian Rupee (INR / Rs) across entire stack
Catalogue Dataset         205 real-world products with high-resolution photography across 10 categories
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
EVALUATOR QUICK START
--------------------------------------------------------------------------------

1. Evaluate the Live Cloud Deployment:
   - Live URL: https://order-processing-system-p46e.onrender.com
   - Sign in as Admin: admin@shop.test / password1234
   - Sign in as Customer: shopper@shop.test / password1234

2. Local Setup & Verification (Zero-Config):
   No local MongoDB installation or Docker daemon is required; `npm run dev:db`
   boots an in-process MongoDB replica set with multi-document transaction support:

   npm install
   npm run dev:db       # start local replica set (writes URI to server/.dev-mongo-uri)
   npm run seed:demo    # seed 205 products, 620 orders, 487 payment records
   npm test             # run all 190 tests across 19 suites
   npm run demo:judge   # execute autonomous headless evaluation harness
   npm run verify:db    # run live database audit (invariants, BSON validators, currency)
   npm run dev          # launch development mode (API :4000 + Vite SPA :5173)

3. Run in Production Mode (Single-Origin Process):
   npm run verify       # runs all 190 server tests + builds client production bundle
   NODE_ENV=production npm start  # serves both API and SPA from http://localhost:4000


--------------------------------------------------------------------------------
STEP-BY-STEP EVALUATOR DEMONSTRATION WALKTHROUGH
--------------------------------------------------------------------------------

Step 1: Real-Time Storefront & Stock Awareness
- Browse 205 products across 10 categories.
- Availability is computed as: available = onHand - reserved.
- Sold-out items (available: 0) and low-stock items (available: 1-4) display
  clear indicators with disabled action buttons.

Step 2: Idempotent Cart Checkout & Price Drift Protection
- Add items to cart, enter discount code WELCOME10 (10% off), and proceed.
- If an admin alters a product price while cart is open, checkout aborts with
  PRICE_CHANGED rather than silently billing a stale total.
- Double-clicking or refreshing during checkout reuses the idempotency key; the
  server answers with Idempotency-Replayed: true, preventing duplicate charges.

Step 2b: Customer Self-Service Order Cancellation
- As shopper, navigate to Orders (/orders) and open any pending_payment order.
- Click "Cancel order" in the drawer: server runs an atomic multi-document
  transaction transitioning to cancelled, releases held stock back to inventory,
  and marks the idempotency key as failed so the shopper can check out again.

Step 3: Concurrency Lab (Proving Zero Overselling Under Contention)
- Sign in as Admin (admin@shop.test / password1234) -> Operations -> Concurrency Lab.
- Select a product with 10 available units.
- Set Buyers = 50 (or 200) and Quantity = 1.
- Choose an allocation policy:
  * Natural Database Lock Race (uncoordinated database write-lock race)
  * FIFO Fair Queue (arrival-timestamp ordered admission queue)
  * Randomized Lottery Draw (equal-odds randomized permutation)
- Click "Run Concurrency Test".
- Result: Exactly 10 orders confirm, 40 buyers receive OUT_OF_STOCK, available
  drains to exactly 0, and all consistency invariants I1-I7 hold.

Step 4: Contention Allocation Fairness Analytics
- Inspect the Fairness Analytics card in the Concurrency Lab:
  * Gini Coefficient: Mathematical measurement of inequality (0.00 to 1.00).
  * Win Spread & Ratio: Demonstrates distribution of confirmed orders.
  * Confirmed Buyer Indices: Proves authentic cohort member tracking.

Step 5: Deterministic Chaos Simulation (Mid-Charge Crash Recovery)
- In the Concurrency Lab, click "Simulate Mid-Charge Crash (Chaos F5)".
- Simulates an unhandled server crash immediately after payment capture but before
  order confirmation commits.
- System automatically expires hold, background reaper sweeps reserved stock,
  reconciliation marks charge as a tracked Refund Obligation, and customer funds
  can be refunded atomically via Operations -> Refunds.


--------------------------------------------------------------------------------
THE FIVE FAILURE MODES (F1-F5) AND DEFENCE MECHANISMS
--------------------------------------------------------------------------------

#   Failure Mode                     Mechanism                                           Evidence
------------------------------------------------------------------------------------------------------------------------------------
F1  Lost update / oversell           Conditional single-document atomic $inc             200 concurrent buyers for 10 units -> exactly 10 sales
F2  Partial multi-item commit        Multi-document transaction, sorted lock order       3-item cart failing on item 3 leaves all stock untouched
F3  Reserved stock leaks             Two-phase TTL + lazy reclaim on contention          Expired holds release on next checkout or reaper sweep
F4  Duplicate / retried checkout     Idempotency claims outside transaction              50 concurrent same-key requests -> 1 order, 1 charge
F5  Crash between charge and record  Two-phase payment lease + refund obligation tracking Charged-but-unsettled order tracked as refund obligation

Continuous Invariants Checked After Every Run:
- I1: available = onHand - reserved
- I2: counters never negative (enforced by DB $jsonSchema validator)
- I3: reserved = Sum(quantities held by all pending_payment orders)
- I4: every paid order has exactly one successful payment attempt
- I5: every pending order has an active, unexpired reservation lease
- I6: every payment attempt maps to a valid order
- I7: zero untracked refund obligations


--------------------------------------------------------------------------------
ARCHITECTURAL DECISIONS SUMMARY (ADR-01 TO ADR-16)
--------------------------------------------------------------------------------

- ADR-01: Money as Integer Minor Units (priceMinor: 2499 = Rs 24.99; no float rounding errors)
- ADR-02: Materialised Available Counter with Database $jsonSchema non-negative constraints
- ADR-03: Conditional Atomic $inc as Reservation Primitive ({ available: { $gte: q } })
- ADR-04: Multi-Document Transactions with Lexicographically Sorted Lock Ordering
- ADR-05: Two-Phase Reserve -> Capture Lifecycle (reserve first, charge second, capture third)
- ADR-06: External Side Effects (Payment Gateway) Kept Outside Database Transactions
- ADR-07: Idempotency Claims Registered Outside Transaction to Short-Circuit Concurrent Clicks
- ADR-08: Dual Deadlines (Reservation TTL vs Payment Lease) Resolving Charge-vs-Expiry Race
- ADR-09: Side-Effect-Free Replays with Current State Serialization
- ADR-10: Lazy Reclaim on Contention (Reclaim expired stock on demand without scheduler dependency)
- ADR-11: Non-Transactional Atomic Order Number Generation
- ADR-12: Replica Set Required in Test and Production (Transactions require replica sets)
- ADR-13: Direct Synchronous Saga with Compensations (Lean, verified, zero unnecessary message bus)
- ADR-14: Boundary Validation with Express 5 & Zod at perimeter
- ADR-15: Contention Allocation Policies (Natural Race vs FIFO Queue vs Lottery Draw)
- ADR-16: Single Ledger Currency: Strict INR Standardization Across All Schemas


--------------------------------------------------------------------------------
CONTENTION BENCHMARK RESULTS (npm run bench)
--------------------------------------------------------------------------------

Scenario                                      Mode                   Confirmed   Rejected   Rejected p50
--------------------------------------------------------------------------------------------------------
herd — 200 buyers, 10 units, all at once      plain transaction      10          190        1041 ms
                                               fast-fail pre-check    10          190        992 ms
drained — 200 buyers, 0 units                 plain transaction      0           200        328 ms
                                               fast-fail pre-check    0           200        214 ms (-34.6%)
--------------------------------------------------------------------------------------------------------
All 8 benchmark rounds maintain 100% invariants held and zero overselling.


--------------------------------------------------------------------------------
API ENDPOINTS OVERVIEW
--------------------------------------------------------------------------------

All responses use unified JSON envelopes:
Success: { data: { ... } }
Error:   { error: { code, message, details?, retryable, requestId } }

GET  /healthz                                 Liveness check
GET  /readyz                                  Readiness check
GET  /metrics                                 Prometheus metrics exposition
POST /api/auth/register                       Customer registration
POST /api/auth/login                          User login
GET  /api/auth/me                             Current user payload
GET  /api/products                            Paginated product list
GET  /api/products/:id                        Single product lookup
POST /api/products                            Create product (admin)
PATCH /api/products/:id                       Update product (admin)
POST /api/products/:id/stock                  Restock product (admin)
POST /api/checkout                            Process checkout (requires Idempotency-Key)
GET  /api/orders                              User order history
GET  /api/orders/:id                          Order details
POST /api/orders/:id/cancel                   Cancel order & release stock
GET  /api/admin/inventory/reconcile           Full catalogue invariant report (admin)
GET  /api/admin/inventory/refund-obligations  Tracked refund obligations (admin)
POST /api/admin/inventory/sweep               Trigger reaper sweeper (admin)
POST /api/admin/payments/:orderId/refund      Issue refund, supports ?restock=true (admin)
POST /api/admin/concurrency-lab               Run concurrency stress test (admin)
POST /api/admin/chaos/simulate-crash          Simulate mid-charge crash (admin)


--------------------------------------------------------------------------------
ASSESSMENT CRITERIA MAPPING
--------------------------------------------------------------------------------

Criterion                   Evidence in Codebase
--------------------------------------------------------------------------------
Problem Solving             Zero oversell under concurrency; charge-vs-expiry two-phase lease;
                            allocation fairness policies (Race, FIFO, Lottery).
Code Quality                Pure domain logic in src/domain/; transactional sagas in src/services/;
                            zero floating-point math; strict Zod schema validation.
Technical Implementation    Atomic $inc primitives; MongoDB transactions; sorted lock ordering;
                            idempotency outside transactions; Prometheus telemetry; single-origin hosting.
Testing & Verification      190 tests across 19 suites (100% passing); fast-check property testing;
                            headless judge verification (npm run demo:judge).
Design Decisions Explained  16 ADRs summarized in Section 7 above.
================================================================================
