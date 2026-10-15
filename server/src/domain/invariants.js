import { IdempotencyKey, IDEMPOTENCY_STATUS } from '../models/IdempotencyKey.js';
import { Order } from '../models/Order.js';
import { PaymentAttempt, PAYMENT_STATUS } from '../models/PaymentAttempt.js';
import { Product } from '../models/Product.js';
import { HOLDING_STATUSES, ORDER_STATUS } from './orderStatus.js';

/**
 * The invariants, executable.
 *
 * This returns a report rather than throwing so the SAME function can serve the
 * test suite (a global afterEach hook) and the admin reconciliation endpoint.
 * That is the mechanism that keeps the consistency guarantee true as the
 * codebase grows instead of only on the day it was written: any test that
 * leaves the database inconsistent fails, even if it was testing something
 * else entirely.
 *
 *  I1  available = onHand - reserved            (per product, at all times)
 *  I2  counters are never negative
 *  I3  reserved = Σ quantity over orders holding stock   <- the strong one
 *  I4  no order stranded past expiry beyond a grace period
 *  I5  a completed idempotency claim always recorded an order
 *  I6  no idempotency claim referencing a missing order
 *  I7  no payment attempt referencing a missing order
 *
 * I3 is what catches a leaked reservation, a double release or a double
 * capture — the bugs a single-request test never sees.
 */
export async function checkInvariants({ overdueGraceMs = 60_000 } = {}) {
  const problems = [];

  const [products, heldAgg] = await Promise.all([
    Product.find().lean(),
    Order.aggregate([
      { $match: { status: { $in: HOLDING_STATUSES } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.productId', quantity: { $sum: '$items.quantity' } } },
    ]),
  ]);
  const heldByProduct = new Map(heldAgg.map((r) => [String(r._id), r.quantity]));

  for (const p of products) {
    if (p.available !== p.onHand - p.reserved) {
      problems.push({
        invariant: 'I1',
        productId: String(p._id),
        sku: p.sku,
        onHand: p.onHand,
        reserved: p.reserved,
        available: p.available,
        expected: p.onHand - p.reserved,
      });
    }
    if (Math.min(p.onHand, p.reserved, p.available) < 0) {
      problems.push({
        invariant: 'I2',
        productId: String(p._id),
        sku: p.sku,
        onHand: p.onHand,
        reserved: p.reserved,
        available: p.available,
      });
    }
    const held = heldByProduct.get(String(p._id)) ?? 0;
    if (held !== p.reserved) {
      problems.push({
        invariant: 'I3',
        productId: String(p._id),
        sku: p.sku,
        heldByOrders: held,
        reservedCounter: p.reserved,
        drift: p.reserved - held,
      });
    }
  }

  // I4: an order past its expiry is only a problem if nothing is going to
  // settle it. The null case MUST be an explicit `$or`: comparison query
  // operators are type-bracketed, so `$lt: <Date>` never matches null or a
  // missing field. Without the null branch this check would miss exactly the
  // stranded orders it exists to catch (a charge whose answer never arrived).
  const overdue = new Date(Date.now() - overdueGraceMs);
  const stranded = await Order.countDocuments({
    status: ORDER_STATUS.PENDING_PAYMENT,
    reservationExpiresAt: { $lt: overdue },
    $or: [{ paymentLeaseExpiresAt: null }, { paymentLeaseExpiresAt: { $lt: overdue } }],
  });
  if (stranded > 0) {
    problems.push({
      invariant: 'I4',
      description: 'orders stranded past expiry beyond the grace period',
      count: stranded,
    });
  }

  // I5: a completed claim must have produced an order.
  const completedWithoutOrder = await IdempotencyKey.countDocuments({
    status: IDEMPOTENCY_STATUS.COMPLETED,
    orderId: null,
    'response.statusCode': { $gte: 200, $lt: 300 },
  });
  if (completedWithoutOrder > 0) {
    problems.push({
      invariant: 'I5',
      description: 'completed idempotency claims without an order',
      count: completedWithoutOrder,
    });
  }

  // I6 / I7: referential integrity without a foreign-key engine.
  const orderIds = new Set((await Order.find().select('_id').lean()).map((o) => String(o._id)));

  const claims = await IdempotencyKey.find({ orderId: { $ne: null } })
    .select('orderId')
    .lean();
  const danglingClaims = claims.filter((c) => !orderIds.has(String(c.orderId)));
  if (danglingClaims.length > 0) {
    problems.push({
      invariant: 'I6',
      description: 'idempotency claims referencing a missing order',
      count: danglingClaims.length,
    });
  }

  const attempts = await PaymentAttempt.find().select('orderId').lean();
  const danglingAttempts = attempts.filter((a) => !orderIds.has(String(a.orderId)));
  if (danglingAttempts.length > 0) {
    problems.push({
      invariant: 'I7',
      description: 'payment attempts referencing a missing order',
      count: danglingAttempts.length,
    });
  }

  return problems;
}

/**
 * The "detect and compensate" half of the charge-versus-expiry race (ADR-08).
 * Money that was taken for an order we could not fulfil becomes an explicit,
 * visible obligation instead of a silent loss.
 */
export async function getRefundObligations() {
  const attempts = await PaymentAttempt.find({
    status: { $in: [PAYMENT_STATUS.REFUND_REQUIRED] },
  })
    .populate({ path: 'orderId', select: 'orderNumber status pricing customerId' })
    .lean();
  return attempts.map((a) => ({
    paymentAttemptId: String(a._id),
    orderId: a.orderId ? String(a.orderId._id) : null,
    orderNumber: a.orderId?.orderNumber ?? null,
    orderStatus: a.orderId?.status ?? null,
    amountMinor: a.amountMinor,
    currency: a.currency,
    providerRef: a.providerRef,
    createdAt: a.createdAt,
  }));
}

export async function reconciliationReport() {
  const [problems, refundObligations, products, orders] = await Promise.all([
    checkInvariants(),
    getRefundObligations(),
    Product.find()
      .select('sku name description priceMinor onHand reserved available isActive')
      .lean(),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  return {
    consistent: problems.length === 0,
    problems,
    refundObligations,
    // Price and description come along deliberately: the operations console is
    // the one place that needs counters AND catalogue fields together, and
    // `Product.toPublic()` hides onHand/reserved from shoppers by design. One
    // snapshot also means the table and the KPI tiles can never disagree.
    inventory: products.map((p) => ({
      productId: String(p._id),
      sku: p.sku,
      name: p.name,
      description: p.description ?? '',
      priceMinor: p.priceMinor,
      onHand: p.onHand,
      reserved: p.reserved,
      available: p.available,
      isActive: p.isActive,
    })),
    ordersByStatus: Object.fromEntries(orders.map((o) => [o._id, o.count])),
    checkedAt: new Date().toISOString(),
  };
}
