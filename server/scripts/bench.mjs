/**
 * Contention benchmark.
 *
 * The plan committed to MEASURING the hot-document bottleneck rather than
 * asserting anything about it. This runs the same scenarios twice — with the
 * fast-fail pre-check on and off — and prints the numbers, so the claim in the
 * README is evidence rather than optimism.
 *
 * Runs through the checkout SERVICE (the same code path the HTTP route uses),
 * because the thing being measured is database contention, not the loopback
 * stack.
 *
 * Two scenarios, because "contention" is not one shape of load:
 *
 *   herd     — 200 buyers arrive at once for 10 units. Most requests run a
 *              transaction that collides on the hot product document, and the
 *              driver's withTransaction loop re-runs each one until it observes
 *              the sold-out state. No pre-check can help here: every request
 *              reads availability BEFORE any of the writes land, so at that
 *              instant the stock genuinely IS available.
 *   drained  — stock is already gone and 200 buyers keep arriving (the shape a
 *              sold-out drop actually has). Here the pre-check can reject from
 *              a stale-but-accurate read without opening a transaction at all,
 *              which is the case it was written for.
 *
 *   npm run bench
 *   BENCH_BUYERS=500 BENCH_STOCK=25 npm run bench
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { checkInvariants } from '../src/domain/invariants.js';
import { Customer, IdempotencyKey, Order, PaymentAttempt, Product } from '../src/models/index.js';
import { checkout } from '../src/services/checkout.service.js';

const BUYERS = Number(process.env.BENCH_BUYERS ?? 200);
const HERD_STOCK = Number(process.env.BENCH_STOCK ?? 10);

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

async function resetWorld(sku, stock) {
  const benchCustomers = await Customer.find({ email: /@bench\.local$/ }).select('_id');
  const benchCustomerIds = benchCustomers.map((c) => c._id);
  const benchOrders = await Order.find({ customerId: { $in: benchCustomerIds } }).select('_id');
  const benchOrderIds = benchOrders.map((o) => o._id);

  await Promise.all([
    Product.deleteMany({ sku: /^BENCH-/ }),
    Order.deleteMany({ customerId: { $in: benchCustomerIds } }),
    PaymentAttempt.deleteMany({ orderId: { $in: benchOrderIds } }),
    IdempotencyKey.deleteMany({
      $or: [{ orderId: { $in: benchOrderIds } }, { key: /^bench-/ }],
    }),
    Customer.deleteMany({ email: /@bench\.local$/ }),
  ]);

  let product = await Product.findOne({ sku });
  if (!product) {
    product = await Product.create({
      sku,
      name: 'Benchmark Product',
      description: 'Created by scripts/bench.mjs',
      priceMinor: 1000,
      currency: 'INR',
      onHand: stock,
      reserved: 0,
      available: stock,
      isActive: true,
    });
  } else {
    // Reset the counters directly: consistent by construction, and it keeps the
    // $jsonSchema validator in play.
    await Product.collection.updateOne(
      { _id: product._id },
      { $set: { onHand: stock, reserved: 0, available: stock } },
    );
  }
  return product;
}

async function makeBuyers(count) {
  const docs = await Customer.insertMany(
    Array.from({ length: count }, (_, i) => ({
      email: `bench_${Date.now().toString(36)}_${i}@bench.local`,
      name: 'Bench Buyer',
      passwordHash: 'scrypt$bench$not-a-real-password',
      role: 'customer',
    })),
  );
  return docs.map((doc) => doc._id);
}

async function run({ scenario, label, fastFail, sku, stock }) {
  config.CHECKOUT_FAST_FAIL = fastFail;

  const product = await resetWorld(sku, stock);
  const buyers = await makeBuyers(BUYERS);

  const startedAt = process.hrtime.bigint();
  const samples = new Array(buyers.length);
  const tally = { confirmed: 0, outOfStock: 0, other: 0 };

  await Promise.all(
    buyers.map(async (customerId, index) => {
      const begin = process.hrtime.bigint();
      let accepted = false;
      try {
        const result = await checkout({
          customerId,
          idempotencyKey: `bench-${sku}-${index}-${Date.now().toString(36)}`,
          input: {
            items: [{ productId: product._id, quantity: 1 }],
            paymentMethod: { type: 'card', token: 'tok_success' },
            discountCode: null,
          },
        });
        if (result.statusCode === 201) {
          tally.confirmed += 1;
          accepted = true;
        } else if (result.body?.error?.code === 'OUT_OF_STOCK') tally.outOfStock += 1;
        else tally.other += 1;
      } catch (err) {
        if (err?.code === 'OUT_OF_STOCK') tally.outOfStock += 1;
        else tally.other += 1;
      } finally {
        samples[index] = { ms: Number(process.hrtime.bigint() - begin) / 1e6, accepted };
      }
    }),
  );

  const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const all = samples.map((s) => s.ms).sort((a, b) => a - b);
  const okSamples = samples.filter((s) => s.accepted).map((s) => s.ms).sort((a, b) => a - b);
  const rejSamples = samples.filter((s) => !s.accepted).map((s) => s.ms).sort((a, b) => a - b);

  const after = await Product.findById(product._id).lean();
  const sold = await Order.aggregate([
    { $match: { status: { $in: ['paid', 'fulfilled'] } } },
    { $unwind: '$items' },
    { $match: { 'items.productId': product._id } },
    { $group: { _id: null, quantity: { $sum: '$items.quantity' } } },
  ]);
  const problems = await checkInvariants();

  const expected = Math.min(BUYERS, stock);
  const consistent =
    tally.confirmed === expected &&
    (sold[0]?.quantity ?? 0) === expected &&
    after.available === after.onHand - after.reserved &&
    problems.length === 0;

  return {
    scenario,
    label,
    tally,
    sold: sold[0]?.quantity ?? 0,
    counters: { onHand: after.onHand, reserved: after.reserved, available: after.available },
    totalMs,
    throughput: (BUYERS / totalMs) * 1000,
    all: { p50: percentile(all, 0.5), p95: percentile(all, 0.95), p99: percentile(all, 0.99) },
    rejected: { n: rejSamples.length, p50: percentile(rejSamples, 0.5), p95: percentile(rejSamples, 0.95) },
    confirmed: { n: okSamples.length, p50: percentile(okSamples, 0.5), p95: percentile(okSamples, 0.95) },
    consistent,
    invariantProblems: problems.length,
  };
}

const fmt = (ms) => `${ms.toFixed(0)}ms`;
const fmtCell = (bucket) => (bucket.n === 0 ? '—' : fmt(bucket.p50));
const pad = (value, width) => String(value).padStart(width);

const SCENARIOS = [
  { scenario: 'herd', stock: HERD_STOCK, skuPlain: 'BENCH-HERD-PLAIN', skuFast: 'BENCH-HERD-FAST' },
  { scenario: 'drained', stock: 0, skuPlain: 'BENCH-DRAIN-PLAIN', skuFast: 'BENCH-DRAIN-FAST' },
];

/**
 * Position bias is real and it is not hypothetical: whichever mode runs FIRST in
 * a process pays for cold JIT, cold plan cache and cold page cache, so a bench
 * that always runs `plain` then `fast` will report fast-fail winning even when
 * it does nothing. The first version of this script had exactly that bug and it
 * produced a confident, wrong conclusion.
 *
 * So each scenario is measured in BOTH orders — A/B then B/A — and the reported
 * per-mode figure is the mean of its two runs, which cancels the position
 * effect. A warm-up round runs first and is never measured.
 */
const ORDERS = [
  [
    { label: 'plain transaction', fastFail: false, sku: 'Plain' },
    { label: 'fast-fail pre-check', fastFail: true, sku: 'Fast' },
  ],
  [
    { label: 'fast-fail pre-check', fastFail: true, sku: 'Fast' },
    { label: 'plain transaction', fastFail: false, sku: 'Plain' },
  ],
];

const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

async function main() {
  await connectDb();
  const poolSize = mongoose.connection.getClient().options?.maxPoolSize ?? 'default';

  process.stdout.write(
    `\nContention benchmark — ${BUYERS} concurrent buyers, 1 unit each, connection pool ${poolSize}\n` +
      `Mongo: ${config.MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}\n` +
      `Note: rejected requests are dominated by the driver's withTransaction retry loop,\n` +
      `      so "all p50" clusters near the end of the run when the herd is large.\n\n`,
  );

  // Warm-up: never measured, exists so the first measured run is not the cold one.
  await run({ scenario: 'warmup', label: 'warm-up', fastFail: false, sku: 'BENCH-WARMUP', stock: 25 });

  const results = [];
  for (const spec of SCENARIOS) {
    for (const order of ORDERS) {
      for (const mode of order) {
        results.push(
          await run({
            ...spec,
            label: mode.label,
            fastFail: mode.fastFail,
            sku: spec[mode.sku === 'Plain' ? 'skuPlain' : 'skuFast'],
          }),
        );
      }
    }
  }

  const header = ['scenario', 'mode', 'confirmed', 'rejected', 'ok p50', 'rej p50', 'rej p95', 'all p50', 'all p99', 'total'];
  const widths = [11, 20, 11, 10, 9, 9, 9, 9, 9, 10];
  process.stdout.write(
    header.map((h, i) => (i === 0 ? h.padEnd(widths[i]) : pad(h, widths[i]))).join('') + '\n',
  );
  process.stdout.write(`${'-'.repeat(widths.reduce((a, b) => a + b, 0))}\n`);

  for (const r of results.filter((x) => x.scenario !== 'warmup')) {
    process.stdout.write(
      r.scenario.padEnd(widths[0]) +
        r.label.padEnd(widths[1]) +
        pad(r.tally.confirmed, widths[2]) +
        pad(r.tally.outOfStock, widths[3]) +
        pad(fmtCell(r.confirmed), widths[4]) +
        pad(fmt(r.rejected.p50), widths[5]) +
        pad(fmt(r.rejected.p95), widths[6]) +
        pad(fmt(r.all.p50), widths[7]) +
        pad(fmt(r.all.p99), widths[8]) +
        pad(fmt(r.totalMs), widths[9]) +
        '\n',
    );
  }

  process.stdout.write('\nCorrectness (both modes must hold, in every scenario):\n');
  for (const r of results) {
    process.stdout.write(
      `  ${r.scenario}/${r.label}: ${r.consistent ? 'CORRECT' : 'FAILED'} — ` +
        `confirmed=${r.tally.confirmed}, sold=${r.sold}, ` +
        `final=${r.counters.onHand}/${r.counters.reserved}/${r.counters.available}, ` +
        `other=${r.tally.other}, invariant problems=${r.invariantProblems}\n`,
    );
  }

  process.stdout.write('\nEffect of the pre-check (mean of two runs in opposite orders):\n');
  for (const { scenario } of SCENARIOS) {
    const rows = results.filter((r) => r.scenario === scenario);
    const plainRuns = rows.filter((r) => r.label === 'plain transaction');
    const fastRuns = rows.filter((r) => r.label === 'fast-fail pre-check');
    const plainRej = mean(plainRuns.map((r) => r.rejected.p50));
    const fastRej = mean(fastRuns.map((r) => r.rejected.p50));
    const plainAll = mean(plainRuns.map((r) => r.all.p50));
    const fastAll = mean(fastRuns.map((r) => r.all.p50));
    const rejDelta = plainRej > 0 ? ((plainRej - fastRej) / plainRej) * 100 : 0;
    process.stdout.write(
      `  ${scenario}: rejected-request p50 ${fmt(plainRej)} -> ${fmt(fastRej)} ` +
        `(${rejDelta >= 0 ? '−' : '+'}${Math.abs(rejDelta).toFixed(1)}%), ` +
        `all-request p50 ${fmt(plainAll)} -> ${fmt(fastAll)}\n`,
    );
  }
  process.stdout.write(
    '\nA negative delta means the pre-check helped (it replaces a full transaction with a\n' +
      'read for requests that observe sold-out stock). Individual rows above are single runs\n' +
      'and will disagree with each other; only the paired means are a conclusion.\n\n',
  );

  try {
    // results summary printed above
  } finally {
    const benchCustomers = await Customer.find({ email: /@bench\.local$/ }).select('_id');
    const benchCustomerIds = benchCustomers.map((c) => c._id);
    const benchOrders = await Order.find({ customerId: { $in: benchCustomerIds } }).select('_id');
    const benchOrderIds = benchOrders.map((o) => o._id);
    await Promise.all([
      Product.deleteMany({ sku: /^BENCH-/ }),
      Order.deleteMany({ customerId: { $in: benchCustomerIds } }),
      PaymentAttempt.deleteMany({ orderId: { $in: benchOrderIds } }),
      IdempotencyKey.deleteMany({
        $or: [{ orderId: { $in: benchOrderIds } }, { key: /^bench-/ }],
      }),
      Customer.deleteMany({ email: /@bench\.local$/ }),
    ]);
    await disconnectDb();
  }
  process.exit(results.every((r) => r.consistent) ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Bench failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
