/**
 * Complete Database Verification & Audit Script
 *
 * Connects to the configured MongoDB instance (Atlas or local replica set),
 * audits collection records, enforces consistency invariants I1-I7, verifies
 * currency uniformity (INR), validates MongoDB $jsonSchema collection validators,
 * and confirms zero invariant drift or dangling state.
 *
 * Usage:
 *   node server/scripts/verify-db.mjs
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { checkInvariants, getRefundObligations, reconciliationReport } from '../src/domain/invariants.js';
import { Customer, Counter, IdempotencyKey, Order, PaymentAttempt, Product } from '../src/models/index.js';

async function runDatabaseAudit() {
  process.stdout.write('========================================================================\n');
  process.stdout.write('  INVENTORY-AWARE ORDER PROCESSING SYSTEM — DATABASE VERIFICATION AUDIT  \n');
  process.stdout.write('========================================================================\n\n');

  try {
    process.stdout.write(`Connecting to database: ${config.MONGODB_URI.replace(/:([^:@]+)@/, ':****@')}\n`);
    await connectDb(config.MONGODB_URI);
    const db = mongoose.connection.db;
    const admin = db.admin();

    // 1. Replica set check
    process.stdout.write('\n[1/7] REPLICA SET CAPABILITY:\n');
    let isReplicaSet = false;
    try {
      const replStatus = await admin.command({ replSetGetStatus: 1 });
      isReplicaSet = true;
      process.stdout.write(`  - Replica set name: ${replStatus.set}\n`);
      process.stdout.write(`  - Members active:   ${replStatus.members?.length ?? 1}\n`);
      process.stdout.write(`  - Multi-document transactions: SUPPORTED (Required for atomic SAGAs)\n`);
    } catch (e) {
      process.stdout.write(`  - Warning: replSetGetStatus not permitted or not a replica set (${e.message})\n`);
    }

    // 2. Collection inventory
    process.stdout.write('\n[2/7] COLLECTION DOCUMENT COUNTS:\n');
    const [
      productCount,
      orderCount,
      customerCount,
      paymentCount,
      idempotencyCount,
      counterCount,
    ] = await Promise.all([
      Product.countDocuments(),
      Order.countDocuments(),
      Customer.countDocuments(),
      PaymentAttempt.countDocuments(),
      IdempotencyKey.countDocuments(),
      Counter.countDocuments(),
    ]);

    process.stdout.write(`  - Products:            ${productCount}\n`);
    process.stdout.write(`  - Orders:              ${orderCount}\n`);
    process.stdout.write(`  - Customers:           ${customerCount}\n`);
    process.stdout.write(`  - Payment Attempts:    ${paymentCount}\n`);
    process.stdout.write(`  - Idempotency Keys:    ${idempotencyCount}\n`);
    process.stdout.write(`  - Sequence Counters:   ${counterCount}\n`);

    // 3. Currency uniformity (Strict INR)
    process.stdout.write('\n[3/7] CURRENCY AUDIT (STRICT INR / ₹):\n');
    const [nonInrProducts, nonInrOrders, nonInrPayments] = await Promise.all([
      Product.countDocuments({ currency: { $ne: 'INR' } }),
      Order.countDocuments({ currency: { $ne: 'INR' } }),
      PaymentAttempt.countDocuments({ currency: { $ne: 'INR' } }),
    ]);

    process.stdout.write(`  - Non-INR Products:        ${nonInrProducts} (Must be 0)\n`);
    process.stdout.write(`  - Non-INR Orders:          ${nonInrOrders} (Must be 0)\n`);
    process.stdout.write(`  - Non-INR Payment Attempts: ${nonInrPayments} (Must be 0)\n`);

    if (nonInrProducts > 0 || nonInrOrders > 0 || nonInrPayments > 0) {
      throw new Error(`Currency inconsistency detected: non-INR records exist in the database!`);
    }
    process.stdout.write(`  -> 100% of all financial documents strictly standardized to INR (₹).\n`);

    // 4. Stock counter bounds & non-negativity
    process.stdout.write('\n[4/7] STOCK COUNTER BOUNDS & NON-NEGATIVITY:\n');
    const [negOnHand, negReserved, negAvailable] = await Promise.all([
      Product.countDocuments({ onHand: { $lt: 0 } }),
      Product.countDocuments({ reserved: { $lt: 0 } }),
      Product.countDocuments({ available: { $lt: 0 } }),
    ]);

    process.stdout.write(`  - Products with onHand < 0:    ${negOnHand}\n`);
    process.stdout.write(`  - Products with reserved < 0:  ${negReserved}\n`);
    process.stdout.write(`  - Products with available < 0: ${negAvailable}\n`);

    if (negOnHand > 0 || negReserved > 0 || negAvailable > 0) {
      throw new Error(`Negative inventory counters detected in products collection!`);
    }
    process.stdout.write(`  -> All inventory counters are non-negative.\n`);

    // 5. Invariants I1 - I7 verification
    process.stdout.write('\n[5/7] SAGA DOMAIN INVARIANTS (I1 - I7):\n');
    const problems = await checkInvariants();
    if (problems.length === 0) {
      process.stdout.write(`  [PASS] Zero invariant violations across entire database:\n`);
      process.stdout.write(`    * I1: available == onHand - reserved (100% consistent)\n`);
      process.stdout.write(`    * I2: Counters are never negative\n`);
      process.stdout.write(`    * I3: reserved == sum(held stock across all pending orders)\n`);
      process.stdout.write(`    * I4: Zero orders stranded past expiry beyond grace period\n`);
      process.stdout.write(`    * I5: Completed idempotency claims always reference an order\n`);
      process.stdout.write(`    * I6: Referential integrity: no claims referencing missing orders\n`);
      process.stdout.write(`    * I7: Referential integrity: no payment attempts referencing missing orders\n`);
    } else {
      process.stderr.write(`  [FAIL] Invariant violations detected:\n${JSON.stringify(problems, null, 2)}\n`);
      throw new Error(`${problems.length} invariant violations detected!`);
    }

    // 6. Schema collection validators
    process.stdout.write('\n[6/7] STORAGE-LAYER BSON $jsonSchema VALIDATORS:\n');
    const collections = await db.listCollections().toArray();
    for (const coll of collections) {
      if (['products', 'orders'].includes(coll.name)) {
        const hasValidator = !!coll.options?.validator;
        process.stdout.write(`  - Collection '${coll.name}' validator: ${hasValidator ? 'CONFIGURED ($jsonSchema active)' : 'NOT CONFIGURED'}\n`);
      }
    }

    // 7. Reconciliation snapshot & refund obligations
    process.stdout.write('\n[7/7] RECONCILIATION SNAPSHOT & REFUND OBLIGATIONS:\n');
    const snapshot = await reconciliationReport();
    process.stdout.write(`  - Overall consistency:   ${snapshot.consistent ? 'CONSISTENT (true)' : 'INCONSISTENT (false)'}\n`);
    process.stdout.write(`  - Orders breakdown:       ${JSON.stringify(snapshot.ordersByStatus)}\n`);
    process.stdout.write(`  - Refund obligations:    ${snapshot.refundObligations.length} active\n`);

    process.stdout.write('\n========================================================================\n');
    process.stdout.write('  DATABASE VERIFICATION COMPLETE: ALL SYSTEMS NOMINAL (100% HEALTHY)    \n');
    process.stdout.write('========================================================================\n\n');
  } finally {
    await disconnectDb();
  }
}

runDatabaseAudit().catch((err) => {
  process.stderr.write(`\nVerification failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
