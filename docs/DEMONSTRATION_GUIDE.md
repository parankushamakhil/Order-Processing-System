# Complete Demonstration & Assessment Walkthrough Guide

**Project:** Inventory-Aware Order Processing System  
**Stack:** Node.js (Express 5) · MongoDB (Replica Set + Transactions) · React 19 + Vite 8 SPA  
**Submission Focus:** Concurrency Safety, Invariant Consistency, Idempotency, and Enterprise Reliability

---

## 1. Executive Summary & Evaluation Alignment

This document serves as the **complete demonstration script and evaluation guide** for presenting the Inventory-Aware Order Processing System. It maps every capability directly to the assessment evaluation criteria:

| Assessment Evaluation Criteria | How This Project Demonstrates It | Evidence / Proof Point |
|---|---|---|
| **Problem-Solving** | Prevents overselling under high-concurrency race conditions without table locks or deadlocks. Solves the charge-vs-expiry race condition with a two-phase lease. Supports multiple allocation fairness policies (Race, FIFO, Lottery). | [ADR-03](DECISIONS.md), [ADR-08](DECISIONS.md), [Concurrency Lab](../client/src/pages/admin/ConcurrencyLabPanel.jsx) |
| **Code Quality** | Strict domain-driven separation: pure domain logic (`src/domain/`), transactional sagas (`src/services/`), Zod contract validation, zero floating-point money. Pure INR (`₹`) across entire database and UI. | Zero `parseFloat` on money, 100% integer minor units, immutable status transitions, strict BSON validators |
| **Technical Implementation** | Conditional atomic `$inc`, multi-document MongoDB transactions with sorted lock ordering, two-phase payment leases, idempotency claims, deterministic chaos injection, and Prometheus telemetry. | [checkout.service.js](../server/src/services/checkout.service.js), [inventory.js](../server/src/domain/inventory.js), [metrics.js](../server/src/lib/metrics.js) |
| **Testing & Verification** | 185 tests across 19 test files (unit, property-based, integration, and high-load concurrency suites), automated contention benchmarking, and headless judge verification. | `npm test` (185 passing), `npm run demo:judge` (autonomous verification), `npm run bench` |
| **Design Decisions** | 14 comprehensive Architecture Decision Records (ADRs) documenting alternatives considered, reasons for rejection, and accepted trade-offs. | [docs/DECISIONS.md](DECISIONS.md) |

---

## 2. Quick Demo Setup & Credentials

### Local Start (One-Line Database + Demo World)
```bash
# 1. Install dependencies
npm install

# 2. Start local replica set & populate reproducible demo world (205 products, 620 orders)
npm run dev:db
npm run seed:demo

# 3. Launch both API (:4000) and Client (:5173)
npm run dev
```

### Demonstration Accounts
| Role | Email | Password | Access / Capabilities |
|---|---|---|---|
| **Administrator** | `admin@shop.test` | `password1234` | Full Operations dashboard, live Invariant Monitor, Refunds & Reconciliations, and the **Concurrency Lab** |
| **Customer (Shopper)** | `shopper@shop.test` | `password1234` | Catalogue browsing, isolated cart, discount application, checkout, and personal order history |

---

## 3. Step-by-Step Live Demonstration Walkthrough

Follow this 7-step sequence during a live demo or video walkthrough:

### Step 1: The Storefront & Real-Time Stock Awareness
- **URL**: `http://localhost:5173` (or live deployed URL)
- **Login**: `shopper@shop.test`
- **What to Demonstrate**:
  1. Navigate to the **Catalogue** (`/shop`).
  2. Point out the diverse, real-world catalogue of 205 items across 10 categories with high-resolution photography.
  3. Highlight the **stock meters**:
     - *Healthy stock* (Green meter, e.g. 50+ available).
     - *Scarce stock* (Amber warning meter, e.g., 2 units remaining).
     - *Sold out* (Red badge, "Out of stock", Add to Cart button disabled).
  4. **Key Talking Point**: *"Availability is not a static flag. It is materialised as `available = onHand - reserved`. The UI dynamically reflects real stock and protects users from attempting to buy sold-out goods."*

---

### Step 2: Server-Side Price Calculation & Cart Rules
- **What to Demonstrate**:
  1. Add items to cart and open **Cart** (`/cart`).
  2. Test discount codes:
     - `SAVE10` (10% off subtotal).
     - `SAVE25` (25% off subtotal).
     - `FLAT5` (Flat ₹5.00 discount).
  3. Observe line totals, taxes (800 basis points / 8%), and conditional shipping:
     - Free shipping threshold applied automatically when subtotal exceeds ₹50.00.
  4. **Key Talking Point (ADR-01 & Security)**: *"Prices are NEVER calculated or trusted from client-side payloads. The client only sends product IDs, quantities, and discount codes. The server prices every line from verified product records using integer minor units (paise/cents), completely eliminating floating-point rounding errors (`0.1 + 0.2 !== 0.3`)."*

---

### Step 3: Checkout Workflow & Two-Phase Inventory Saga
- **What to Demonstrate**:
  1. Click **Pay ₹XX.XX**.
  2. Notice the instant transition to the **Order Confirmation** modal with Order Number (e.g. `ORD-000621`), status `Paid`, and full pricing breakdown.
  3. Check the item in the catalogue: available units have automatically decreased.
  4. **Key Talking Point (ADR-04 & ADR-05)**:
     - *"Stock reservation follows a two-phase saga: first reserve within an atomic multi-document transaction, then invoke payment gateway simulation, and finally capture or release."*
     - *"Multi-item carts sort product IDs before locking, guaranteeing deadlocks cannot happen even when multiple buyers purchase overlapping items in reverse order."*

---

### Step 4: Duplicate & Retried Checkout (Idempotency Key Defense)
- **What to Demonstrate**:
  1. Show Network tab in browser DevTools during checkout: every checkout request includes an `Idempotency-Key: <UUID>` header.
  2. In the event of network disruption, double-clicking the pay button, or page reloads:
     - The backend checks for an in-flight or completed idempotency claim.
     - If already processed, it safely replays the exact response with header `Idempotency-Replayed: true` without creating a duplicate order or charging the card a second time.
  3. **Key Talking Point (ADR-07)**: *"Idempotency claims are claimed outside the transaction to fail fast on concurrent duplicate requests, but marked complete inside the checkout transaction."*

---

### Step 5: Handling Failed Payments & Automatic Expiry Reaper
- **What to Demonstrate**:
  1. Use the Command Palette (`Ctrl+K` or search bar) to jump to simulated card errors (e.g. `tok_declined`).
  2. Attempting a checkout with a declined card results in `PAYMENT_DECLINED`.
  3. The reserved inventory is immediately released back to `available` stock via a compensating transaction.
  4. **The Reaper**: If a user abandons checkout or crashes mid-payment, the background inventory sweeper automatically reclaims expired reservations when `reservationExpiresAt` elapses.

---

### Step 6: The Headline Demo — **The Concurrency Lab**
- **Login**: `admin@shop.test`
- **Navigation**: Click **Operations** in sidebar $\rightarrow$ Select **Concurrency Lab** tab.
- **What to Demonstrate**:
  1. Point to the setup:
     - Product: Select the scarcest product (e.g., `SKU-LAST-001`, or any item).
     - Reset stock: Set available stock to exactly **10 units**.
     - Concurrent buyers: Select **200 buyers** (1 unit each).
  2. Click **Fire 200 concurrent checkouts**.
  3. Watch the live elapsed timer while 200 simultaneous database transactions execute.
  4. Inspect the results:
     - **Confirmed**: Exactly **10** (Green).
     - **Rejected**: Exactly **190** with `OUT_OF_STOCK` (Red).
     - **Oversold**: **No** (Green badge: *"Exactly 10 sales, and not one more"*).
     - **Invariants**: **Hold** (All 7 consistency invariants intact).
     - **Final Counters**: `onHand: 10`, `reserved: 0`, `available: 0`.
  5. **Key Talking Point (ADR-03)**: *"This is the central proof of the system. We didn't use table-level locks that grind the database to a halt. We used single-document atomic conditional updates (`{ available: { $gte: quantity } }`) backed by MongoDB `$jsonSchema` non-negative constraints. Overselling is mathematically impossible."*

---

### Step 7: Operations & Reconciliations Dashboard
- **What to Demonstrate**:
  1. **Overview Panel**: Displays the live **Invariant Monitor**:
     - Evaluates 7 core system invariants across all 205 products and 600+ orders.
     - Reports 0 broken invariants.
  2. **Orders Queue**: Filter orders by status (`Awaiting payment`, `Paid`, `Fulfilled`, `Cancelled`, `Expired`).
  3. **Refund Obligations**: Shows payment reconciliation. If an external payment webhook succeeds after an order was cancelled or expired, the system captures the money as a *Refund Obligation*, preventing lost revenue or unaccounted merchant balances.

---

## 4. The Five Failure Modes (F1–F5) & Architectural Solutions

| # | Real-World Failure Mode | How This System Solves It | Code Location |
|---|---|---|---|
| **F1** | **Lost Update / Oversell**<br>Two simultaneous checkouts read stock 1, both write stock 0, selling 2 units. | Conditional atomic update: `{ _id, available: { $gte: quantity } }` with `{ $inc: { available: -quantity, reserved: quantity } }`. Database collection schema enforces `available >= 0`. | [domain/inventory.js](../server/src/domain/inventory.js) |
| **F2** | **Partial Multi-Item Commit**<br>Cart has Item A and Item B; Item A succeeds but Item B is out of stock. | Multi-document MongoDB transaction. All items reserve together or rollback entirely. Item IDs are sorted alphabetically before locking to prevent deadlocks. | [services/checkout.service.js](../server/src/services/checkout.service.js) |
| **F3** | **Reserved Stock Leaks**<br>Customer closes browser while awaiting payment, stranding stock indefinitely. | Two deadlines (`reservationExpiresAt` + `paymentLeaseExpiresAt`). Periodic sweeper (`inventorySweep`) + lazy reclaim on contention automatically release holds. | [services/expiry.service.js](../server/src/services/expiry.service.js) |
| **F4** | **Duplicate / Retried Checkout**<br>User double-clicks "Pay" or network retries, causing double charge. | Unique `Idempotency-Key` stored with atomic status tracking (`in_progress` $\rightarrow$ `completed`). Retries return cached order with `Idempotency-Replayed: true`. | [services/idempotency.service.js](../server/src/services/idempotency.service.js) |
| **F5** | **Crash Between Charge & Record**<br>Payment gateway successfully charges card, but server crashes before order is marked paid. | Asynchronous webhook reconciliation with HMAC signature verification. Webhooks cross-reference `providerRef` and transition order to `paid` or log `refund_required`. | [routes/webhook.routes.js](../server/src/routes/webhook.routes.js) |

---

## 5. Automated Verification & Testing Proof

You can demonstrate the automated test suites live in terminal:

```bash
# Run all 178 tests across 17 test suites (Unit, Property, Integration, Concurrency)
npm test

# Run the dedicated concurrency suite
npm run test:concurrency

# Run contention benchmark (measuring p50 response under 200 simultaneous buyers)
npm run bench

# Verify full production build
npm run verify
```

### Invariant Test Suite (Executable Architecture)
Every test run automatically executes `checkInvariants()` in a global `afterEach` hook, guaranteeing that no test ever leaves the database in an inconsistent state:
- **I1**: `available === onHand - reserved` (always holds across all products).
- **I2**: Counters are never negative (`min(onHand, reserved, available) >= 0`).
- **I3**: Total `reserved` equals the exact sum of quantities held by open orders.
- **I4**: No order is stranded past expiry without cancellation.
- **I5 & I6**: Every completed idempotency claim references a valid order.
- **I7**: Every payment attempt correlates with a valid order.

---

## 6. Live Deployment & Submission Summary

- **GitHub Repository**: Submit the link to your repository.
- **Live Deployment URL**: Single-origin deployment on Render / Cloud Host (API + built client hosted together via `SERVE_CLIENT=true`).
- **Documentation Included**:
  - `README.txt` / `README.md`: Complete setup and architecture reference.
  - `docs/DECISIONS.md`: 14 Architecture Decision Records (ADRs).
  - `docs/DEPLOYMENT.md`: Step-by-step production deployment & MongoDB Atlas replica-set guide.
  - `docs/VERIFICATION.md`: Exhaustive verification log of code implementation vs specifications.
  - `docs/DEMONSTRATION_GUIDE.md`: This comprehensive evaluation guide.
