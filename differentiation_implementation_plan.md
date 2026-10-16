# Implementation Plan: Assessment Differentiation & Technical Hardening

**Project:** Inventory-Aware Order Processing System  
**Objective:** Transform an already robust, 100% verified order processing system into a standout, top-ranked assessment submission by addressing submission hygiene, making hidden guarantees watchable, and proving resilience through adversarial testing.  
**Baseline State:** 178 / 178 tests passing across 17 files; clean production build; zero oversells under 200 concurrent buyers.

---

## 1. Architectural Strategy & Phasing Overview

Competitors at this level will have passing tests and basic transactions. To win decisively, this plan executes across three focused phases:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 0: Submission Hygiene & Consistency Alignment (Immediate)        │
│  - Eliminate placeholder URLs in README.md                             │
│  - Fix broken Windows file:/// paths in DEMONSTRATION_GUIDE.md & track │
│  - Align Currency (unify USD / INR across models, config & UI)         │
│  - Fix Order & Payment status synchronization on refund               │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Phase 1: High-Differentiator Capabilities (The "Unfair Advantage")     │
│  - T1.1: Live Contention Telemetry (`/metrics` + live UI stream)       │
│  - T1.2: Deterministic Fault Injection & Chaos Harness (proves F5)     │
│  - T1.5: Append-Only Order Event Timeline UI                           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Phase 2: Novel Mechanisms & Edge Polish                                │
│  - T1.3: Allocation Fairness under Contention (FIFO vs Lottery)        │
│  - T1.4: Model-Based Saga Interleaving Property Tests (`fast-check`)   │
│  - Complete HTTP 202 Async Payment Polling on Client                   │
│  - Operational Order Fulfillment (`POST /api/admin/orders/:id/fulfill`)│
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Phase 3: Headless Judge Mode & End-to-End Verification                 │
│  - One-command headless verification script (`npm run demo:judge`)     │
│  - Full regression suite execution (178 existing + new test suites)    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Submission Hygiene & Consistency Alignment

*Estimated effort: 1–2 hours. Goal: Eliminate every defect that could lose points during the first 60 seconds of review.*

### Task 0.1: Clean up Deployment Placeholders in `README.md`
- **File:** [README.md](file:///d:/Inventory%20Aware%20Order%20Processing%20System/README.md)
- **Problem:** Lines 26 and 36 contain literal placeholders (`` `https://your-app-name.onrender.com` `` and `‹paste your deployed Render URL here›`).
- **Action:**
  - If a live Render deployment URL is available, insert the live URL.
  - If local review is expected, document the single-origin production command (`NODE_ENV=production npm run build && npm start` $\rightarrow$ `http://localhost:4000`) and note Render blueprint deployment instructions with zero placeholders.

### Task 0.2: Normalize and Track `docs/DEMONSTRATION_GUIDE.md`
- **File:** [docs/DEMONSTRATION_GUIDE.md](file:///d:/Inventory%20Aware%20Order%20Processing%20System/docs/DEMONSTRATION_GUIDE.md)
- **Problem:** Contains 11 hardcoded Windows absolute paths (`file:///c:/Users/paran/OneDrive/Desktop/...`) that break on any evaluator's machine or GitHub. The file is also untracked in git.
- **Action:**
  - Replace all absolute paths with repository-relative Markdown links (e.g. `[ADR-03](DECISIONS.md)`, `[Concurrency Lab](../client/src/pages/admin/ConcurrencyLabPanel.jsx)`).
  - Remove fragile hardcoded line number anchors (e.g. `#L52`, `#L156`) in favor of clear section/file anchors.
  - Track the file in git (`git add docs/DEMONSTRATION_GUIDE.md`).

### Task 0.3: Currency Alignment (Resolve USD vs INR Drift)
- **Files:**
  - [server/src/models/Product.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/server/src/models/Product.js)
  - [server/src/models/Order.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/server/src/models/Order.js)
  - [server/src/config/index.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/server/src/config/index.js)
  - [client/src/lib/format.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/lib/format.js)
- **Problem:** Backend models strictly pin `enum: ['USD']`, while `client/src/lib/format.js` overrides `USD` to display as `₹` (INR), creating a visible contradiction between the database schema and the rendered UI.
- **Action:**
  - Add `CURRENCY` to server config (defaulting to `'USD'`, supporting `['USD', 'INR']`).
  - Expand model enum to `['USD', 'INR']`.
  - Update `client/src/lib/format.js` to render currency symbols based on the configured/active currency (`$` for USD, `₹` for INR).
  - Add a short note in [docs/DECISIONS.md](file:///d:/Inventory%20Aware%20Order%20Processing%20System/docs/DECISIONS.md) documenting multi-currency support and standard formatting.

### Task 0.4: Fix Refund Synchronization on Order Model
- **File:** [server/src/routes/admin.routes.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/server/src/routes/admin.routes.js#L240-L258)
- **Problem:** The refund endpoint `POST /api/admin/payments/:orderId/refund` marks `PaymentAttempt.status = 'refunded'`, but leaves `Order.payment.status` and `Order.status` untouched.
- **Action:**
  - Within a transaction, update `Order.payment.status = 'refunded'`, record a transition entry in `statusHistory`, and optionally support a query parameter `?restock=true` that atomically invokes `restock()` to return items to `onHand` and `available`.
  - Update client UI in [RefundsPanel.jsx](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/pages/admin/RefundsPanel.jsx) and [OrdersPanel.jsx](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/pages/admin/OrdersPanel.jsx) to reflect the refunded status.

---

## Phase 1: High-Differentiator Capabilities (The "Unfair Advantage")

*Estimated effort: 4–6 hours. Goal: Turn abstract guarantees into watchable, verifiable demonstrations.*

### Task 1.1: Live Contention Telemetry & Prometheus `/metrics` (T1.1)
- **Concept:** Every submission logs; almost none measures. Expose real-time operational telemetry that shows *why* contention behaves the way it does.
- **Components:**
  1. **In-Memory Metrics Registry:** Create `server/src/lib/metrics.js` to track:
     - `checkout_attempts_total` (counter)
     - `checkout_success_total` (counter)
     - `checkout_rejections_total{reason}` (counter: `out_of_stock`, `price_changed`, `in_progress`, `rate_limited`)
     - `transaction_retries_total` (counter: `TransientTransactionError` / write conflicts)
     - `idempotency_replays_total` (counter)
     - `reservation_reclaims_total{trigger}` (counter: `lazy_demand`, `timer_sweep`)
     - `checkout_latency_ms` (summary/histogram: p50, p95, p99)
  2. **API Endpoint:** Add `GET /metrics` returning Prometheus-compatible text format.
  3. **Admin UI Telemetry:**
     - Add a live telemetry panel or telemetry drawer to [ConcurrencyLabPanel.jsx](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/pages/admin/ConcurrencyLabPanel.jsx).
     - When firing 200 buyers, display a live dashboard of retry counts, reject reasons, and latency percentiles alongside the final count.
- **Proof Value:** Directly visualizes the difference between plain transactions and `fast-fail` pre-checks in real time.

### Task 1.2: Deterministic Chaos / Fault-Injection Harness (T1.2)
- **Concept:** Convert failure mode F5 ("crash between charge and settlement") from a theoretical claim into an executable, repeatable proof.
- **Components:**
  1. **Injection Seam:** Create `server/src/services/chaos.service.js` with toggleable fault points driven by an optional header (`x-chaos-injection`) or environment config:
     - `crash_before_charge`: aborts before external payment is called.
     - `gateway_timeout`: forces external payment into a timeout.
     - `crash_after_charge_before_settle`: simulates process crash immediately after gateway returns 200, before TX2 commits.
     - `delay_settlement_past_lease`: holds settlement until payment lease expires.
  2. **Automated Test Suite:** Create `server/tests/integration/chaos.test.js`:
     - Test each injection point.
     - Assert that no reservations leak.
     - Assert that invariants $I_1$–$I_7$ pass after every failure.
     - Prove that when `crash_after_charge_before_settle` occurs, a **Refund Obligation** is created and surfaced in the admin dashboard.
  3. **Demo UI:** Add a "Simulate Chaos / Mid-Charge Crash" button in the admin interface to demonstrate live recovery with one click.

### Task 1.3: Append-Only Order Event Timeline UI (T1.5)
- **Concept:** Provide a visual narrative of an order's lifecycle, rendering every transition, branch, and compensation path.
- **Components:**
  1. **Event Model / History Expansion:**
     - Ensure each order's `statusHistory` records actor, reason, prior state, new state, and duration.
  2. **Timeline Component:**
     - Create `client/src/components/OrderTimeline.jsx`.
     - Render an accessible vertical timeline in the order details modal:
       - 🟢 `Idempotency Claim Created` (key hash verified)
       - 🟢 `Server-Side Pricing Calculated` (discounts & tax applied)
       - 🟢 `Inventory Reserved (TX1)` (atomic conditional $inc)
       - 🟡 `Payment Authorization Leased` (lease expires in $T$ seconds)
       - 🟢 `Payment Settled (TX2)` or 🔴 `Payment Declined $\rightarrow$ Compensating Stock Release (TX3)`
     - When a refund obligation or replay occurs, render the exact branch point in color-coded badges.

---

## Phase 2: Novel Mechanisms & Edge Polish

*Estimated effort: 3–4 hours. Goal: Answer the questions other candidates don't even ask.*

### Task 2.1: Allocation Fairness under Contention (T1.3)
- **Concept:** When 200 buyers compete for 10 units, who wins? Standard implementations let arbitrary database lock-acquisition order decide. Introduce an explicit allocation fairness comparison.
- **Components:**
  - Add an optional policy selector in `ConcurrencyLabPanel.jsx`:
    1. **Best-Effort Lock Race (Standard):** Natural concurrent write competition.
    2. **Fair FIFO Admission:** Requests queued by arrival timestamp before transaction execution.
    3. **Fair Randomized Lottery:** Equal-odds admission among concurrent arrivals.
  - Display win distribution statistics (Gini coefficient / win spread) across buyer IDs in the lab results.
  - Document as an Architecture Decision Record (ADR-15: Contention Allocation Policies).

### Task 2.2: Model-Based Saga Interleaving Tests (`fast-check`) (T1.4)
- **Concept:** Elevate property-based testing from pure pricing calculations to the stateful checkout saga.
- **Components:**
  - Create `server/tests/property/saga.property.test.js` using `fast-check`.
  - Generate randomized sequences of operations:
    `[Reserve, Expire, Settle, Cancel, Replay, Restock, Duplicate]`
  - Assert that after every sequence prefix, invariants $I_1$–$I_7$ remain completely intact.

### Task 2.3: Client-Side HTTP 202 Async Payment Polling
- **Files:**
  - [client/src/hooks/useCheckout.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/hooks/useCheckout.js)
  - [client/src/pages/CartPage.jsx](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/pages/CartPage.jsx)
- **Problem:** If a payment times out and returns HTTP 202 with `pollUrl`, the client shows a toast, does not poll, and leaves items in the cart.
- **Action:**
  - When `data.pending === true`, launch an automated polling loop on `data.pollUrl` (interval 1.5s, max attempts 10).
  - Clear the cart once the order transitions to `paid` or display a clear resolution card if it transitions to `payment_failed` or `refund_required`.

### Task 2.4: Admin Fulfillment & Customer Self-Service Cancellation
- **Backend:**
  - Add `POST /api/admin/orders/:id/fulfill` in [admin.routes.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/server/src/routes/admin.routes.js) (transitions `PAID` $\rightarrow$ `FULFILLED`).
  - Add `POST /api/orders/:id/cancel` in [order.routes.js](file:///d:/Inventory%20Aware%20Order%20Processing%20System/server/src/routes/order.routes.js) (allows a customer to cancel their own `PENDING_PAYMENT` order, releasing stock immediately).
- **Frontend:**
  - Add "Mark as Fulfilled" action button in [OrdersPanel.jsx](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/pages/admin/OrdersPanel.jsx).
  - Add "Cancel Order" button in [OrdersPage.jsx](file:///d:/Inventory%20Aware%20Order%20Processing%20System/client/src/pages/OrdersPage.jsx) for pending orders.

---

## Phase 3: Headless Judge Mode & End-to-End Verification

*Estimated effort: 1–2 hours. Goal: Guaranteed effortless evaluation for any reviewer.*

### Task 3.1: One-Command Judge Verification Script
- **Create:** `server/scripts/judge-run.mjs`
- **Command:** `npm run demo:judge`
- **Functionality:**
  1. Bootstraps single-node replica set in memory.
  2. Seeds the reproducible demonstration world.
  3. Executes a 200-buyer concurrency run.
  4. Runs the chaos injection test.
  5. Validates invariants $I_1$–$I_7$.
  6. Prints an executive summary table with exact metrics, latencies, and invariant status in the terminal.

### Task 3.2: Full Regression & Build Verification
- Execute `cmd /c npm test` $\rightarrow$ verify all 178 existing tests + new chaos & property suites pass.
- Execute `cmd /c npm run build` $\rightarrow$ verify SPA production bundle builds with zero warnings.
- Run `npm run bench` $\rightarrow$ verify contention benchmarks match published results.

---

## 4. Work Breakdown & Execution Schedule

| Priority | Task | Target Output | Risk / Complexity |
|:---:|---|---|:---:|
| **P0** | **0.1 README Placeholders** | Clean `README.md` with zero placeholder text | Low |
| **P0** | **0.2 DEMONSTRATION_GUIDE.md** | Relative paths, tracked in git | Low |
| **P0** | **0.3 Currency Alignment** | Unified USD/INR across schemas & client formatter | Low |
| **P0** | **0.4 Refund Sync** | Order updated on refund + optional restock | Low |
| **P1** | **1.1 Live Telemetry** | `/metrics` endpoint + Concurrency Lab live charts | Medium |
| **P1** | **1.2 Chaos Harness** | `chaos.test.js` proving F5 mid-charge crash recovery | Medium |
| **P1** | **1.5 Order Timeline UI** | Interactive visual state timeline in Admin UI | Low-Medium |
| **P2** | **2.1 Allocation Fairness** | Policy toggle in Concurrency Lab (FIFO / Lottery) | Medium |
| **P2** | **2.3 Client 202 Polling** | Automated settlement resolution in Cart | Low |
| **P2** | **2.4 Fulfillment & Cancel** | Complete operational state transitions | Low |
| **P3** | **3.1 Judge Run Script** | `npm run demo:judge` headless evaluator script | Low |
