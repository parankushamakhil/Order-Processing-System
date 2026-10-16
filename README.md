# Inventory-Aware Order Processing System

A production-grade MERN-stack order processing system engineered for high-concurrency e-commerce: catalogue, real-time inventory management, transactional cart checkout, and operations console. The primary architectural guarantee is that **stock can never be oversold** under high concurrency, inventory counters stay strictly consistent across multi-item transactions, and retried, duplicated, declined, or crashed checkouts resolve to exactly one deterministic outcome with zero inventory leaks or phantom charges.

**Status: 100% Implemented, Verified, and Certified.** 190 tests across 19 test suites pass against a MongoDB replica set (`npm test` → exit code 0). The client production bundle builds with 0 warnings in 146ms, and the unified single-origin production server serves both the Express 5 REST API and the React 19 SPA. A reproducible demonstration world of 205 real-world products with verified photography, 620 orders, 487 payment attempts, and 424 idempotency claims loads with a single command (`npm run seed:demo`). Standardized strictly on **Indian Rupee (`INR` / `₹`)** across database validators, schemas, pricing calculations, domain models, and user interfaces.

---

## Submission Details

| Item | Value |
|---|---|
| **Live Production Deployment** | [https://order-processing-system-p46e.onrender.com](https://order-processing-system-p46e.onrender.com) *(Verified live: HTTP 200 OK)* |
| **GitHub Repository** | [https://github.com/parankushamakhil/Order-Processing-System](https://github.com/parankushamakhil/Order-Processing-System) |
| **Local Production URL** | `http://localhost:4000` *(run `npm run verify && npm start`)* |
| **Admin Credentials** | `admin@shop.test` / `password1234` *(Access to Operations Dashboard, Invariant Monitor, Refunds, and Concurrency Lab)* |
| **Customer Credentials** | `shopper@shop.test` / `password1234` *(Storefront catalogue, cart, discount, and order history)* |
| **Automated Test Suite** | **190 tests across 19 test suites (100% passing)**: unit, integration, concurrency, and model-based property tests |
| **Headless Judge Runner** | `npm run demo:judge` *(Autonomous 5-section evaluation harness: replica sets, contention race, idempotency, chaos recovery, telemetry)* |
| **Currency** | Strictly Indian Rupee (`INR` / `₹`) across database schemas, pricing engines, and UI |
| **Catalogue Dataset** | 205 real-world products with high-resolution photography across 10 categories |

---

## Evaluator Quick Start

### 1. Evaluate the Live Cloud Deployment
Open the live deployment in your browser:
- **Live URL:** [https://order-processing-system-p46e.onrender.com](https://order-processing-system-p46e.onrender.com)
- **Sign in as Admin:** `admin@shop.test` / `password1234`
- **Sign in as Customer:** `shopper@shop.test` / `password1234`

### 2. Local Setup & Verification (Zero-Config)
No local MongoDB installation or Docker daemon is required; `npm run dev:db` boots an in-process MongoDB replica set with multi-document transaction support:

```bash
# 1. Install dependencies
npm install

# 2. Start local single-node replica set (writes URI to server/.dev-mongo-uri)
npm run dev:db

# 3. Seed reproducible demo dataset (205 products, 620 orders, 487 payment records)
npm run seed:demo

# 4. Run automated test suites (190 tests across 19 files)
npm test

# 5. Run headless judge verification script
npm run demo:judge

# 6. Launch development server (API :4000 + Vite SPA :5173)
npm run dev
```

### 3. Run in Production Mode (Single-Origin Process)
To test the identical single-origin binary running in production:

```bash
npm run verify                          # runs all 190 server tests + builds client bundle
NODE_ENV=production npm start          # http://localhost:4000 serves both API and SPA
```

---

## Complete Evaluator Demonstration Walkthrough

Follow this 5-step walkthrough to inspect every critical feature of the system:

### Step 1: Real-Time Storefront & Catalogue Stock Awareness
1. Navigate to the storefront (`/`) as a shopper or guest.
2. Browse 205 real-world products across 10 categories (Electronics, Apparel, Kitchen, Home Office, Fitness, etc.).
3. Notice that availability is computed as `available = onHand − reserved`. Sold-out products (`available: 0`) and low-stock products (`available: 1–4`) render distinct visual indicators with disabled action buttons.

### Step 2: Idempotent Cart Checkout & Price Drift Protection
1. Add items to your cart, apply discount code `WELCOME10` (10% off), and initiate checkout.
2. The pricing engine calculates subtotal, discounts, tax (basis points), and shipping on the server.
3. If an administrator alters a product price while the cart is active, the checkout refuses with `PRICE_CHANGED` rather than silently billing a stale amount.
4. Retry or double-click checkout: the client detects the identical cart fingerprint and reuses the idempotency key; the server answers with `Idempotency-Replayed: true` and the original order, avoiding duplicate billing.

### Step 3: Concurrency Lab — Proving Zero Overselling Under Contention
1. Sign in as Administrator (`admin@shop.test` / `password1234`) and navigate to **Operations → Concurrency Lab**.
2. Select any product (or an isolated 10-unit test item).
3. Set **Concurrent Buyers = 50** (or up to 200) and **Quantity Per Buyer = 1**.
4. Select the allocation policy:
   - **Natural Database Lock Race:** Simultaneous uncoordinated checkout requests racing on the database write lock.
   - **FIFO Fair Queue:** Strict arrival-timestamp ordered admission queue.
   - **Randomized Lottery Draw:** Equal-odds randomized permutation across all waiting buyers.
5. Click **Run Concurrency Test**.
6. **Result:** Exactly 10 orders succeed, 40 buyers receive `OUT_OF_STOCK` rejections, available stock reaches exactly 0, and all invariants I1–I7 are verified held with zero overselling.

### Step 4: Contention Allocation Fairness Analytics
In the Concurrency Lab results card, inspect the **Fairness Analytics Engine**:
- **Gini Coefficient:** Quantifies allocation inequality across the buyer pool (0.00 = perfect equality, 1.00 = extreme concentration).
- **Win Spread & Ratio:** Analyzes the distribution of winners across the cohort. In FIFO mode, the win spread is tightly concentrated at the front of the queue; in Lottery mode, winners are evenly dispersed across the entire population.
- **Confirmed Buyer Indices:** Displays the exact IDs of confirmed buyers, proving authentic cohort identities.

### Step 5: Deterministic Chaos Simulation (Mid-Charge Crash Recovery)
1. In the Concurrency Lab, click **Simulate Mid-Charge Crash (Chaos F5)**.
2. This simulates an unhandled server crash immediately after payment capture but before the order state transaction commits.
3. Observe the automated recovery:
   - The hold expires and the background reaper sweeper reclaims reserved stock (`available` restored).
   - The out-of-band payment reconciliation detects the lost CAS transition and registers a tracked **Refund Obligation**.
   - Navigate to **Operations → Refunds & Reconciliations** to view the tracked obligation and execute an atomic refund with optional `?restock=true`.

---

## The Five Failure Modes (F1–F5) & Defence Mechanisms

The project addresses five fundamental failure modes inherent in distributed e-commerce:

| ID | Failure Mode | Vulnerability in Naive Systems | Solution in This System | Evidence & Verification |
|---|---|---|---|---|
| **F1** | **Lost Update / Oversell** | Concurrent `SELECT` then `UPDATE` reads stale stock, selling 10 items to 50 buyers. | Single-document conditional atomic `$inc`: `{ available: { $gte: q } }` combined with `{ $inc: { available: -q } }`. Storage layer `$jsonSchema` validator rejects negative counters. | Concurrency suite: 200 buyers racing for 10 units yields exactly 10 confirmed, 190 rejected, available: 0. |
| **F2** | **Partial Multi-Item Commit** | A 3-item cart fails on item 3, leaving items 1 and 2 reserved indefinitely. | Multi-document MongoDB transaction with a deterministic lexicographically sorted lock order, preventing deadlocks and guaranteeing all-or-nothing commits. | Cart test: failing on final item rolls back all preceding counter increments completely. |
| **F3** | **Reserved Stock Leaks** | Buyer abandons cart during payment modal; inventory stays locked forever. | Two-phase reservation TTL with lazy reclaiming on subsequent contention + background sweeping reaper every 30 seconds. | Expiry integration test: expired holds release automatically on next checkout or reaper sweep. |
| **F4** | **Duplicate Checkout Clicks** | Rapid double-clicking or network retries charge customer twice. | Idempotency claims registered outside the transaction; duplicate requests with the same key wait on the leader's in-flight promise or receive `Idempotency-Replayed: true`. | Concurrency suite: 50 concurrent requests on 1 key produce exactly 1 order and 1 payment charge. |
| **F5** | **Crash Between Charge & Record** | Gateway captures money, but server crashes before order is marked paid. | Two-phase payment lease. Out-of-band webhook/reconciliation detects expired holds, marks charge as a tracked **Refund Obligation**, and protects customer funds. | Chaos integration test: simulated crash triggers hold sweep, records refund obligation, and preserves invariants. |

### Continuous Invariant Checker (I1–I7)
Every integration and concurrency test concludes by executing `checkInvariants()` across the entire database:
- **I1:** `product.available === product.onHand - product.reserved`
- **I2:** `product.onHand >= 0 && product.reserved >= 0 && product.available >= 0`
- **I3:** `product.reserved === Σ(item.quantity for all pending_payment orders)`
- **I4:** Every paid order has exactly one successful payment attempt
- **I5:** Every pending order has an active, unexpired reservation lease
- **I6:** Every payment attempt has a corresponding order
- **I7:** Zero untracked or dangling refund obligations

---

## Architectural Decision Records Summary (ADR-01 to ADR-16)

All core architecture decisions are documented with their rationale, alternatives considered, and trade-offs:

- **ADR-01: Money as Integer Minor Units** — All monetary amounts are integer counts of minor units (`priceMinor: 2499` = ₹24.99). Eliminates IEEE-754 floating-point rounding errors (`0.1 + 0.2 !== 0.3`).
- **ADR-02: Materialised Available Counter with Database Constraints** — `onHand`, `reserved`, and `available` are stored fields protected by a MongoDB `$jsonSchema` validator with `minimum: 0` and `validationAction: 'error'`.
- **ADR-03: Conditional Atomic `$inc` as Reservation Primitive** — Stock reservation executes in one atomic query. No application-level locks required.
- **ADR-04: Multi-Document Transactions with Sorted Lock Ordering** — Cart items are sorted by `productId` before transaction acquisition to eliminate database deadlocks under concurrency.
- **ADR-05: Two-Phase Reserve → Capture Lifecycle** — Stock is reserved first, charged second, and captured third. If payment fails, reservations release cleanly without restocking sales history.
- **ADR-06: External Side Effects Outside Database Transactions** — Payment gateway HTTP calls occur outside the MongoDB transaction. Database transactions retry on transient errors; credit cards must never be double-charged.
- **ADR-07: Idempotency Claims Outside Transaction** — An idempotency claim document is written before payment to short-circuit duplicate clicks immediately.
- **ADR-08: Dual Deadlines (Reservation TTL vs. Payment Lease)** — Distinguishes cart hold expiration from payment gateway timeouts, resolving the charge-versus-expiry race condition.
- **ADR-09: Side-Effect-Free Replays with Current State Serialization** — Replaying an idempotency key returns the latest order state without re-executing transactions.
- **ADR-10: Lazy Reclaim on Contention** — Expired reservations are swept on demand during high contention, ensuring system correctness does not rely solely on cron timers.
- **ADR-11: Non-Transactional Order Numbers** — Order numbers use a dedicated atomic counter collection, preventing lock contention on the checkout path.
- **ADR-12: Replica Set Required in Test and Production** — MongoDB standalone cannot execute transactions. Tests use `mongodb-memory-server` in replica set mode; production uses MongoDB Atlas replica sets.
- **ADR-13: Direct Synchronous Saga (No Premature Outbox)** — Built as a synchronous saga with compensations. Keeps architecture lean while providing clear upgrade hooks.
- **ADR-14: Boundary Validation with Express 5 & Zod** — All request bodies, query params, and environment variables are strictly validated by Zod at the perimeter.
- **ADR-15: Contention Allocation Policies (Race vs. FIFO vs. Lottery)** — Allows operators to toggle between natural write-lock races, arrival-ordered FIFO queues, and randomized lottery draws with live Gini coefficient analysis.
- **ADR-16: Single Ledger Currency: Strict INR Standardization** — All entities standardized strictly on Indian Rupee (`INR` / `₹`), eliminating currency conversion drift.

---

## Contention Benchmark Numbers

Measured using `npm run bench` (200 concurrent buyers of 1 unit each, connection pool 50, paired A/B and B/A runs with warm-up):

| Scenario | Mode | Confirmed | Rejected | Rejected p50 Latency | Invariant Status |
|---|---|:---:|:---:|:---:|:---:|
| **Herd Contention** (200 buyers, 10 units) | Plain Transaction | 10 | 190 | 1041 ms | **100% Invariants Held (0 Oversell)** |
| **Herd Contention** (200 buyers, 10 units) | Fast-Fail Pre-Check | 10 | 190 | 992 ms | **100% Invariants Held (0 Oversell)** |
| **Drained Contention** (200 buyers, 0 units) | Plain Transaction | 0 | 200 | 328 ms | **100% Invariants Held (0 Oversell)** |
| **Drained Contention** (200 buyers, 0 units) | Fast-Fail Pre-Check | 0 | 200 | **214 ms (-34.6%)** | **100% Invariants Held (0 Oversell)** |

**Key Takeaway:** Correctness does not depend on the fast-fail optimization—the conditional `$inc` prevents overselling regardless. On drained stock drops, fast-fail pre-checking saves 34.6% of latency by rejecting from memory before paying transaction overhead.

---

## Complete API Reference

All responses conform to a unified envelope:
- **Success:** `{ data: { ... } }`
- **Error:** `{ error: { code: string, message: string, details?: any, retryable: boolean, requestId: string } }`

| Method & Path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | Public | Liveness check (does not touch database). |
| `GET /readyz` | Public | Readiness check (verifies database connectivity). |
| `GET /metrics` | Public | Prometheus text-format telemetry exposition endpoint. |
| `POST /api/auth/register` | Public | Register new customer account (role is server-enforced). |
| `POST /api/auth/login` | Public | Authenticate user and receive JWT. |
| `GET /api/auth/me` | Bearer | Retrieve authenticated user profile. |
| `GET /api/products` | Public | Paginated product catalogue with query filters (`page`, `pageSize`, `q`, `inStock`). |
| `GET /api/products/:id` | Public | Retrieve single product with real-time availability counters. |
| `POST /api/products` | Admin | Create product (enforces `available = onHand`). |
| `PATCH /api/products/:id` | Admin | Update product metadata or price. |
| `POST /api/products/:id/stock` | Admin | Restock product (atomically updates `onHand` and `available`). |
| `POST /api/checkout` | Customer | **Process checkout.** Requires `Idempotency-Key` header. Supports optional `chaosFault`. |
| `GET /api/orders` | Customer | List own orders. |
| `GET /api/orders/:id` | Owner/Admin | Retrieve order details and timeline events. |
| `POST /api/orders/:id/cancel` | Customer/Admin| Cancel pending order and atomically release reserved inventory. |
| `GET /api/admin/inventory/reconcile` | Admin | Run catalogue-wide invariant verification report. |
| `GET /api/admin/inventory/refund-obligations` | Admin | Retrieve orders with tracked refund obligations. |
| `POST /api/admin/inventory/sweep` | Admin | Manually trigger expired reservation sweeper. |
| `POST /api/admin/payments/:orderId/refund` | Admin | Issue refund. Supports `?restock=true` to restock units atomically. |
| `POST /api/admin/concurrency-lab` | Admin | Execute live concurrency stress test (`buyers`, `quantityPerBuyer`, `policy`). |
| `POST /api/admin/chaos/simulate-crash` | Admin | Simulate mid-charge crash (Chaos F5) and demonstrate automated recovery. |

---

## Assessment Criteria Mapping

| Assessment Criterion | How It Is Addressed in This Codebase | Evidence & Proof Points |
|---|---|---|
| **Problem Solving** | Prevents overselling under high concurrency without table-level bottlenecks. Solves the charge-vs-expiry race condition with two-phase leases. Supports three distinct allocation fairness policies. | [server/src/domain/inventory.js](server/src/domain/inventory.js), [server/src/services/checkout.service.js](server/src/services/checkout.service.js), Concurrency Lab UI |
| **Code Quality** | Strict domain-driven separation (`src/domain/` pure logic vs `src/services/` transactional workflows). Zero floating-point money calculations. Zod runtime validation at every boundary. | [server/src/domain/pricing.js](server/src/domain/pricing.js), [server/src/db/validators.js](server/src/db/validators.js), 100% integer minor units |
| **Technical Implementation** | Conditional atomic `$inc`, multi-document transactions with sorted locks, idempotency claims outside transactions, deterministic chaos testing, Prometheus metrics, and Single-Origin production hosting. | [server/src/lib/metrics.js](server/src/lib/metrics.js), [server/src/services/chaos.service.js](server/src/services/chaos.service.js), [render.yaml](render.yaml) |
| **Testing & Verification** | **190 tests across 19 test files (100% passing)**: unit, integration, high-concurrency races, fast-check property testing, and automated headless judge script. | `npm test` (190 passing in 103s), `npm run demo:judge` (passed in 24.5s) |
| **Design Decisions** | 16 comprehensive Architecture Decision Records (ADRs) documenting alternatives considered, reasons for rejection, and trade-offs accepted. | Integrated in Section 7 above (ADR-01 through ADR-16) |

---

## Repository Layout

```
client/                               React 19 + Vite 8 SPA
  ├── src/pages/admin/                Operations, Invariant Monitor, Refunds, and Concurrency Lab
  ├── src/hooks/useCheckout.js        Client idempotency key lifecycle & HTTP 202 bounded polling
  └── src/api.js                      Type-safe API client wrapper
server/
  ├── scripts/dev-mongo.mjs           Local single-node MongoDB replica set runner
  ├── scripts/judge-run.mjs           Autonomous 5-section headless evaluation script
  ├── scripts/bench.mjs               Contention benchmark harness
  ├── src/db/validators.js            MongoDB $jsonSchema collection validators (non-negative stock)
  ├── src/domain/                     Pure domain logic: pricing, inventory primitives, invariants
  ├── src/middleware/                 Zod validation, rate limiting, and JWT authentication
  ├── src/routes/                     Express 5 route controllers
  ├── src/services/                   Checkout saga, idempotency, expiry reaper, payments
  └── tests/                          190 tests: unit, property, integration, concurrency
package.json                          Workspace orchestrator scripts
render.yaml                           Zero-config cloud blueprint
```
