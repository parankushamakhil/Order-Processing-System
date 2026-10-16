/**
 * Headless Judge Run Script
 *
 * Runs a complete, automated verification demonstration for assessors/judges
 * without requiring browser interaction or manual UI clicking.
 *
 * Usage:
 *   npm run demo:judge
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { config } from '../src/config/index.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { checkInvariants, getRefundObligations } from '../src/domain/invariants.js';
import { metrics } from '../src/lib/metrics.js';
import { Customer, IdempotencyKey, Order, PaymentAttempt, PAYMENT_STATUS, Product } from '../src/models/index.js';
import { checkout } from '../src/services/checkout.service.js';
import { sweepExpiredReservations } from '../src/services/expiry.service.js';
import { getGateway } from '../src/services/payments/index.js';
import { settlePaymentOutcome, settleSuccess } from '../src/services/paymentSettlement.service.js';

let replSet = null;

async function setupDatabase() {
  process.stdout.write('\n=== 1. INITIALIZING DATABASE & ENVIRONMENT ===\n');
  try {
    await connectDb(config.MONGODB_URI);
    process.stdout.write(`Connected to MongoDB: ${config.MONGODB_URI}\n`);
  } catch (err) {
    process.stdout.write(`Local MongoDB not found (${err.message}). Starting ephemeral in-memory replica set...\n`);
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    const baseUri = replSet.getUri();
    const url = new URL(baseUri);
    url.pathname = '/judge';
    await connectDb(url.toString());
    process.stdout.write(`Connected to in-memory replica set: ${url.toString()}\n`);
  }

  // Clear only judge test records so demo dataset is preserved
  const judgeCustomers = await Customer.find({ email: /@judge\.local$/ }).select('_id');
  const judgeCustomerIds = judgeCustomers.map((c) => c._id);
  const judgeOrders = await Order.find({ customerId: { $in: judgeCustomerIds } }).select('_id idempotencyKey');
  const judgeOrderIds = judgeOrders.map((o) => o._id);
  const judgeKeys = judgeOrders.map((o) => o.idempotencyKey).filter(Boolean);

  await Promise.all([
    Product.deleteMany({ sku: /^JUDGE-/ }),
    Order.deleteMany({ _id: { $in: judgeOrderIds } }),
    IdempotencyKey.deleteMany({
      $or: [
        { orderId: { $in: judgeOrderIds } },
        { key: { $in: judgeKeys } },
        { key: /^chaos-/ },
        { key: /^judge-/ },
      ],
    }),
    PaymentAttempt.deleteMany({ orderId: { $in: judgeOrderIds } }),
    Customer.deleteMany({ email: /@judge\.local$/ }),
  ]);
  metrics.reset();
  process.stdout.write('Environment reset and ready.\n');
}

async function testContentionAndInvariants() {
  process.stdout.write('\n=== 2. HIGH CONTENTION CONCURRENCY TEST (50 BUYERS VS 10 UNITS) ===\n');
  const product = await Product.create({
    sku: 'JUDGE-HOT-DROP',
    name: 'Limited Edition Drop',
    description: 'High contention test product',
    priceMinor: 149900, // ₹1,499.00
    currency: 'INR',
    onHand: 10,
    reserved: 0,
    available: 10,
  });

  const buyers = await Customer.insertMany(
    Array.from({ length: 50 }, (_, i) => ({
      email: `buyer_${i}@judge.local`,
      name: `Buyer ${i}`,
      passwordHash: 'dummy-hash',
      role: 'customer',
    })),
  );

  process.stdout.write(`Simulating 50 concurrent checkout attempts for 10 available units of ${product.sku} (INR)...\n`);
  const t0 = Date.now();

  const results = await Promise.allSettled(
    buyers.map((buyer) =>
      checkout({
        customerId: String(buyer._id),
        idempotencyKey: randomUUID(),
        input: {
          items: [{ productId: String(product._id), quantity: 1 }],
          paymentMethod: { type: 'card', token: 'tok_success' },
        },
      }),
    ),
  );

  const durationMs = Date.now() - t0;
  let succeeded = 0;
  let rejectedOutOfStock = 0;
  let otherErrors = 0;

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.statusCode === 201) {
      succeeded++;
    } else {
      const code = r.reason?.code ?? r.value?.body?.error?.code;
      if (code === 'OUT_OF_STOCK') {
        rejectedOutOfStock++;
      } else {
        otherErrors++;
      }
    }
  }

  process.stdout.write(`Results in ${durationMs}ms:\n`);
  process.stdout.write(`  - Confirmed orders:   ${succeeded} (Expected: 10)\n`);
  process.stdout.write(`  - Out-of-stock fails: ${rejectedOutOfStock} (Expected: 40)\n`);
  process.stdout.write(`  - Other errors:       ${otherErrors}\n`);

  if (succeeded !== 10 || rejectedOutOfStock !== 40) {
    throw new Error(`Contention outcome mismatch: expected 10 confirmed & 40 out-of-stock, got ${succeeded} & ${rejectedOutOfStock}`);
  }

  const updatedProduct = await Product.findById(product._id).lean();
  process.stdout.write(`Product state: onHand=${updatedProduct.onHand}, reserved=${updatedProduct.reserved}, available=${updatedProduct.available}\n`);

  const invariantProblems = await checkInvariants();
  if (invariantProblems.length === 0) {
    process.stdout.write('  [PASS] All invariants I1-I7 verified strictly held (Zero oversell, zero stock drift).\n');
  } else {
    process.stderr.write(`  [FAIL] Invariant violations: ${JSON.stringify(invariantProblems, null, 2)}\n`);
    throw new Error('Invariant violation detected');
  }
}

async function testIdempotency() {
  process.stdout.write('\n=== 3. IDEMPOTENCY RECORD & REPLAY TEST ===\n');
  const buyer = await Customer.create({
    email: 'idempotent_buyer@judge.local',
    name: 'Idempotency Test User',
    passwordHash: 'dummy',
    role: 'customer',
  });

  const product = await Product.create({
    sku: 'JUDGE-IDEM-ITEM',
    name: 'Idempotency Product',
    description: 'Testing exact replays',
    priceMinor: 49900, // ₹499.00
    currency: 'INR',
    onHand: 5,
    reserved: 0,
    available: 5,
  });

  const fixedKey = 'judge-key-' + randomUUID();
  const input = {
    items: [{ productId: String(product._id), quantity: 1 }],
    paymentMethod: { type: 'card', token: 'tok_success' },
  };

  // 1st attempt: Execute
  const first = await checkout({ customerId: String(buyer._id), idempotencyKey: fixedKey, input });
  const orderId1 = first.body.data.order.id;
  process.stdout.write(`1st execution: status=${first.statusCode}, replayed=${first.replayed}, orderId=${orderId1}\n`);

  // 2nd attempt: Replay
  const second = await checkout({ customerId: String(buyer._id), idempotencyKey: fixedKey, input });
  const orderId2 = second.body.data.order.id;
  process.stdout.write(`2nd execution: status=${second.statusCode}, replayed=${second.replayed}, orderId=${orderId2}\n`);

  if (orderId1 === orderId2 && second.replayed === true) {
    process.stdout.write('  [PASS] Idempotency confirmed: identical order returned with zero duplicate writes.\n');
  } else {
    throw new Error('Idempotency failure: replay mismatch');
  }
}

async function testChaosFaultInjection() {
  process.stdout.write('\n=== 4. DETERMINISTIC CHAOS FAULT INJECTION (MID-CHARGE CRASH) ===\n');
  const buyer = await Customer.create({
    email: 'chaos_buyer@judge.local',
    name: 'Chaos Test User',
    passwordHash: 'dummy',
    role: 'customer',
  });

  const product = await Product.create({
    sku: 'JUDGE-CHAOS-ITEM',
    name: 'Crash-Proof Product',
    description: 'Testing crash recovery',
    priceMinor: 89900, // ₹899.00
    currency: 'INR',
    onHand: 5,
    reserved: 0,
    available: 5,
  });

  const chaosKey = 'chaos-' + randomUUID();
  let faultFired = false;
  try {
    await checkout({
      customerId: String(buyer._id),
      idempotencyKey: chaosKey,
      input: {
        items: [{ productId: String(product._id), quantity: 1 }],
        paymentMethod: { type: 'card', token: 'tok_success' },
      },
      chaosFault: 'crash_after_charge',
    });
  } catch (err) {
    if (err.code !== 'CHAOS_FAULT') {
      throw err;
    }
    faultFired = true;
    process.stdout.write(`  Simulated crash caught: "${err.message}"\n`);
  }

  if (!faultFired) {
    throw new Error('Chaos fault did not trigger: checkout completed without expected injected crash');
  }

  // Find the created order and verify its hold
  const chaosOrder = await Order.findOne({ idempotencyKey: chaosKey });
  if (!chaosOrder) throw new Error('Order was not created in TX1');

  const attempt = await PaymentAttempt.findOne({ idempotencyKey: String(chaosOrder._id) });
  if (!attempt || !attempt.providerRef) throw new Error('Payment was not charged by gateway');

  // Simulate expiry by fast-forwarding lease & reservation timestamps past TTL
  await Order.updateOne(
    { _id: chaosOrder._id },
    {
      $set: {
        reservationExpiresAt: new Date(Date.now() - 5000),
        paymentLeaseExpiresAt: new Date(Date.now() - 5000),
      },
    },
  );

  // Run the reaper reconciliation to recover from the crash: reclaims reservation
  process.stdout.write('Triggering reaper sweep & reconciliation...\n');
  await sweepExpiredReservations({ productIds: [product._id] });

  // Out-of-band settlement arrives (via webhook or reconciliation), losing CAS because order expired
  const settlement = await settleSuccess({
    orderId: chaosOrder._id,
    providerRef: attempt.providerRef,
    source: 'reconcile',
  });
  if (!settlement.lost) {
    throw new Error('Expected status CAS to be lost because order was expired');
  }

  const obligations = await getRefundObligations();
  process.stdout.write(`Active refund obligations tracked: ${obligations.length}\n`);
  if (obligations.length === 0) {
    throw new Error('Expected refund obligation to be recorded, but none found');
  }

  // Admin resolves the refund
  await getGateway().refund({ orderId: chaosOrder._id, amountMinor: attempt.amountMinor });
  await PaymentAttempt.updateOne(
    { _id: attempt._id },
    { $set: { status: PAYMENT_STATUS.REFUNDED } },
  );
  await Order.updateOne(
    { _id: chaosOrder._id },
    { $set: { 'payment.status': PAYMENT_STATUS.REFUNDED } },
  );

  const invariantProblems = await checkInvariants();
  if (invariantProblems.length === 0) {
    process.stdout.write('  [PASS] Mid-charge crash handled: stock released, invariants held, refund obligation tracked & resolved.\n');
  } else {
    throw new Error('Invariant problems after chaos recovery');
  }
}

async function printTelemetrySnapshot() {
  process.stdout.write('\n=== 5. LIVE CONTENTION TELEMETRY SNAPSHOT ===\n');
  const snapshot = metrics.getSnapshot();
  process.stdout.write(`  - Checkout Attempts:        ${snapshot.counters.attempts}\n`);
  process.stdout.write(`  - Checkout Successes:       ${snapshot.counters.success}\n`);
  process.stdout.write(`  - Out-of-Stock Rejections:  ${snapshot.counters.rejections?.out_of_stock ?? 0}\n`);
  process.stdout.write(`  - Transaction Retries:      ${snapshot.counters.retries}\n`);
  process.stdout.write(`  - Idempotency Replays:      ${snapshot.counters.replays}\n`);
  process.stdout.write(`  - Latency p50 / p95:        ${snapshot.latencies.p50}ms / ${snapshot.latencies.p95}ms\n`);
}

async function main() {
  const start = Date.now();
  process.stdout.write('========================================================================\n');
  process.stdout.write('  INVENTORY-AWARE ORDER PROCESSING SYSTEM — HEADLESS JUDGE VERIFICATION  \n');
  process.stdout.write('  Currency: INR (₹) Strictly Standardized Across Whole Stack             \n');
  process.stdout.write('========================================================================\n');

  try {
    await setupDatabase();
    await testContentionAndInvariants();
    await testIdempotency();
    await testChaosFaultInjection();
    await printTelemetrySnapshot();

    process.stdout.write('\n========================================================================\n');
    process.stdout.write(`  ALL DEMO & VERIFICATION CHECKS PASSED SUCCESSFULLY in ${Date.now() - start}ms! \n`);
    process.stdout.write('========================================================================\n\n');
  } finally {
    await disconnectDb();
    if (replSet) await replSet.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`\nJudge run failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
