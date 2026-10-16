/**
 * Seeds a demo catalogue and the accounts the UI needs.
 *
 * Idempotent by SKU/email, so running it twice does not duplicate the catalogue.
 * `SEED_RESET=true` wipes orders and payment data first, which is what you want
 * before re-running a concurrency demo.
 */
import { connectDb, disconnectDb } from '../db/connect.js';
import { Counter, Customer, hashPassword, Product } from '../models/index.js';
import mongoose from 'mongoose';

const CATALOGUE = [
  { sku: 'SKU-TEE-001', name: 'Merino Wool Tee', priceMinor: 7900, onHand: 24 },
  { sku: 'SKU-TEE-002', name: 'Heavyweight Cotton Tee', priceMinor: 3900, onHand: 60 },
  { sku: 'SKU-HOOD-001', name: 'Loopback Hoodie', priceMinor: 12900, onHand: 8 },
  { sku: 'SKU-CAP-001', name: 'Six-Panel Cap', priceMinor: 2900, onHand: 120 },
  { sku: 'SKU-SOCK-001', name: 'Ribbed Socks (3-pack)', priceMinor: 1900, onHand: 200 },
  { sku: 'SKU-LAST-001', name: 'Last One Standing (limited)', priceMinor: 24900, onHand: 10 },
];

const ACCOUNTS = [
  { email: 'admin@shop.test', password: 'password1234', name: 'Admin', role: 'admin' },
  { email: 'shopper@shop.test', password: 'password1234', name: 'Sam Shopper', role: 'customer' },
];

/**
 * Phase 1 acceptance check (plan §3.4): money and stock must be stored as BSON
 * int/long, never as a double.
 *
 * This is asserted rather than assumed. The Node BSON serializer encodes an
 * integral number in int32 range as int32, which is why `bsonType: ['int','long']`
 * holds — but that is a property of the serializer, not of our code, and a stray
 * fractional price would be stored as a double and then rejected by the
 * collection validator. Discovering that here beats discovering it as a 500 on
 * the checkout path.
 */
async function assertIntegerStorage() {
  const asDouble = await Product.collection.countDocuments({
    $or: [
      { priceMinor: { $type: 'double' } },
      { onHand: { $type: 'double' } },
      { reserved: { $type: 'double' } },
      { available: { $type: 'double' } },
    ],
  });

  if (asDouble > 0) {
    throw new Error(
      `${asDouble} product document(s) store money or stock as a BSON double. ` +
        'Integers must round-trip as int32/int64, or the $jsonSchema validator will ' +
        'reject every subsequent write to those counters.',
    );
  }
  return asDouble;
}

async function main() {
  await connectDb();

  if (process.env.SEED_RESET === 'true') {
    const { Order, PaymentAttempt, IdempotencyKey } = await import('../models/index.js');
    await Promise.all([
      Order.deleteMany({}),
      PaymentAttempt.deleteMany({}),
      IdempotencyKey.deleteMany({}),
      Counter.deleteMany({}),
    ]);
    process.stdout.write('Reset orders, payments, idempotency claims and counters.\n');
  }

  for (const entry of CATALOGUE) {
    const existing = await Product.findOne({ sku: entry.sku });
    if (existing) {
      // Restock to the intended figure while preserving I1 for units already held.
      await Product.updateOne(
        { _id: existing._id },
        { $set: { onHand: existing.reserved + entry.onHand, available: entry.onHand } },
      );
      continue;
    }
    await Product.create({
      ...entry,
      description: 'Seeded demo product',
      currency: 'INR',
      reserved: 0,
      available: entry.onHand,
      isActive: true,
    });
  }

  for (const account of ACCOUNTS) {
    const existing = await Customer.findOne({ email: account.email });
    if (existing) continue;
    await Customer.create({
      email: account.email,
      name: account.name,
      passwordHash: hashPassword(account.password),
      role: account.role,
    });
  }

  const products = await Product.find().sort({ sku: 1 }).lean();
  process.stdout.write('\nSeeded catalogue:\n');
  for (const p of products) {
    process.stdout.write(
      `  ${p.sku.padEnd(16)} ${String(p.priceMinor).padStart(6)}c   onHand=${String(p.onHand).padStart(4)}  reserved=${String(p.reserved).padStart(3)}  available=${String(p.available).padStart(4)}\n`,
    );
  }
  const asDouble = await assertIntegerStorage();
  process.stdout.write(
    `\nInteger storage: ${products.length} product(s) checked, ${asDouble} stored as BSON double.\n`,
  );

  process.stdout.write('\nAccounts (password: password1234):\n');
  for (const a of ACCOUNTS) process.stdout.write(`  ${a.role.padEnd(9)} ${a.email}\n`);
  process.stdout.write('\nTip: the "Concurrency Lab" in the admin UI uses SKU-LAST-001.\n');

  await mongoose.disconnect();
  await disconnectDb();
}

main().catch((err) => {
  process.stderr.write(`Seed failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
