import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../db/transaction.js';
import { release, restock } from '../domain/inventory.js';
import { checkInvariants, getRefundObligations, reconciliationReport } from '../domain/invariants.js';
import { transition } from '../domain/orderState.js';
import { ORDER_STATUS } from '../domain/orderStatus.js';
import { AppError, NotFoundError } from '../errors/index.js';
import { attachRequestId } from '../lib/envelope.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  Customer,
  IdempotencyKey,
  IDEMPOTENCY_STATUS,
  Order,
  PaymentAttempt,
  PAYMENT_STATUS,
  Product,
} from '../models/index.js';
import { adminOrderListQuerySchema } from '../validation/schemas.js';
import { checkout } from '../services/checkout.service.js';
import { sweepExpiredReservations } from '../services/expiry.service.js';
import { settlePaymentOutcome, settleSuccess } from '../services/paymentSettlement.service.js';
import { getGateway } from '../services/payments/index.js';
import { objectIdSchema } from '../validation/schemas.js';
import { metrics } from '../lib/metrics.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const idParams = z.object({ id: objectIdSchema }).strict();

/** A user-supplied search term must never reach the RegExp engine raw. */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An order plus whoever placed it, for the admin order list.
 *
 * `customerId` is populated on this path, so it may be a document (normal), a
 * raw id (not populated) or null (the customer was deleted) — all three must be
 * survivable, because a deleted customer must not blank out the operations view.
 */
function toAdminOrderRow(order) {
  const populated = order.customerId;
  const customer =
    populated && typeof populated === 'object' && populated.email
      ? {
          id: String(populated._id),
          email: populated.email,
          name: populated.name ?? '',
          role: populated.role ?? 'customer',
        }
      : null;

  return { ...order.toPublic(), customer };
}

/**
 * The order queue.
 *
 * GET /api/orders is deliberately customer-scoped, so without this an operator
 * could see aggregate counts but never the individual order they needed to act
 * on — leaving cancel, reconcile and refund unreachable from the console even
 * though the endpoints existed.
 */
router.get('/orders', validate({ query: adminOrderListQuerySchema }), async (req, res) => {
  const { status, q, page, pageSize } = req.valid.query;

  const filter = {};
  if (status) filter.status = status;

  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    // Orders store a customer ref, not an address, so a customer match has to be
    // resolved to ids first. Capped deliberately: an unbounded $in built from a
    // broad search term is a slow query waiting to happen.
    const matches = await Customer.find({ $or: [{ email: pattern }, { name: pattern }] })
      .select('_id')
      .limit(500)
      .lean();
    filter.$or = [
      { orderNumber: pattern },
      { customerId: { $in: matches.map((c) => c._id) } },
    ];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate({ path: 'customerId', select: 'email name role' }),
    Order.countDocuments(filter),
  ]);

  res.json({
    data: {
      items: orders.map(toAdminOrderRow),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  });
});

/**
 * One order in full: the financial record, its transition history, and the two
 * side-records that explain a retried or failed checkout — the charge attempts
 * and the idempotency claims. Those are what make a duplicate or an interrupted
 * checkout auditable after the fact instead of merely asserted.
 */
router.get('/orders/:id', validate({ params: idParams }), async (req, res) => {
  const { id } = req.valid.params;

  const order = await Order.findById(id).populate({
    path: 'customerId',
    select: 'email name role',
  });
  if (!order) throw new NotFoundError('ORDER_NOT_FOUND', 'Order not found');

  const [attempts, claims] = await Promise.all([
    PaymentAttempt.find({ orderId: order._id }).sort({ createdAt: 1 }).lean(),
    IdempotencyKey.find({ orderId: order._id }).sort({ createdAt: 1 }).lean(),
  ]);

  res.json({
    data: {
      order: {
        ...toAdminOrderRow(order),
        statusHistory: order.statusHistory,
        failureReason: order.failureReason,
        paymentLeaseExpiresAt: order.paymentLeaseExpiresAt,
        idempotencyKey: order.idempotencyKey,
      },
      paymentAttempts: attempts.map((a) => ({
        id: String(a._id),
        provider: a.provider,
        status: a.status,
        amountMinor: a.amountMinor,
        currency: a.currency,
        providerRef: a.providerRef,
        providerCode: a.providerCode,
        providerMessage: a.providerMessage,
        latencyMs: a.latencyMs,
        attempts: a.attempts,
        createdAt: a.createdAt,
      })),
      idempotencyClaims: claims.map((c) => ({
        id: String(c._id),
        key: c.key,
        endpoint: c.endpoint,
        status: c.status,
        attempts: c.attempts,
        takeoverCount: c.takeoverCount,
        responseStatusCode: c.response?.statusCode ?? null,
        leaseExpiresAt: c.leaseExpiresAt,
        expiresAt: c.expiresAt,
        createdAt: c.createdAt,
      })),
    },
  });
});

router.get('/inventory/reconcile', async (req, res) => {
  res.json({ data: await reconciliationReport() });
});

router.get('/inventory/refund-obligations', async (req, res) => {
  res.json({ data: { obligations: await getRefundObligations() } });
});

/** Live operational telemetry snapshot (T1.1) */
router.get('/telemetry', async (req, res) => {
  res.json({ data: metrics.getSnapshot() });
});

router.post('/telemetry/reset', async (req, res) => {
  metrics.reset();
  res.json({ data: metrics.getSnapshot() });
});

/** Operator trigger for the reaper. It also runs on demand and on a timer. */
router.post('/inventory/sweep', async (req, res) => {
  const result = await sweepExpiredReservations();
  res.json({ data: { ...result, invariants: await checkInvariants() } });
});

router.post('/orders/:id/cancel', validate({ params: idParams }), async (req, res) => {
  const { id } = req.valid.params;
  const order = await Order.findById(id);
  if (!order) throw new NotFoundError('ORDER_NOT_FOUND', 'Order not found');

  const cancelled = await withTransaction(async (session) => {
    const result = await transition(
      id,
      ORDER_STATUS.PENDING_PAYMENT,
      ORDER_STATUS.CANCELLED,
      { reason: 'cancelled_by_admin', actor: 'admin', paymentLeaseExpiresAt: null },
      session,
    );
    if (!result) return null;

    await release(
      order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      session,
    );
    await IdempotencyKey.updateMany(
      { orderId: id, status: IDEMPOTENCY_STATUS.PROCESSING },
      { $set: { status: IDEMPOTENCY_STATUS.FAILED, leaseExpiresAt: new Date() } },
      { session },
    );
    return result;
  });

  if (!cancelled) {
    const current = await Order.findById(id).lean();
    throw new AppError('Only an order awaiting payment can be cancelled without a refund', {
      code: 'ORDER_NOT_PENDING',
      status: 409,
      details: { orderId: id, orderStatus: current?.status ?? null },
    });
  }

  res.json({ data: { order: cancelled.toPublic() } });
});

router.post('/orders/:id/fulfill', validate({ params: idParams }), async (req, res) => {
  const { id } = req.valid.params;
  const order = await Order.findById(id);
  if (!order) throw new NotFoundError('ORDER_NOT_FOUND', 'Order not found');

  const fulfilled = await transition(
    id,
    ORDER_STATUS.PAID,
    ORDER_STATUS.FULFILLED,
    { reason: 'order_fulfilled', actor: 'admin' },
  );

  if (!fulfilled) {
    const current = await Order.findById(id).lean();
    throw new AppError('Only a paid order can be marked fulfilled', {
      code: 'ORDER_NOT_PAID',
      status: 409,
      details: { orderId: id, orderStatus: current?.status ?? null },
    });
  }

  res.json({ data: { order: fulfilled.toPublic() } });
});


/**
 * Reconciliation poll: ask the provider what happened to a charge whose answer
 * we never received. This is the realistic resolution path for a timed-out
 * charge when no webhook arrives.
 */
router.post('/orders/:id/reconcile-payment', validate({ params: idParams }), async (req, res) => {
  const { id } = req.valid.params;
  const pending = getGateway().resolvePending({ orderId: id });
  if (!pending) {
    throw new NotFoundError('NO_PENDING_PAYMENT', 'No unresolved charge for this order');
  }

  const result = await settlePaymentOutcome({
    orderId: id,
    status: pending.finalStatus,
    providerRef: pending.providerRef,
    source: 'reconcile',
  });
  res.status(result.statusCode ?? 200).json(attachRequestId(result.body, req.id));
});

const refundQuerySchema = z
  .object({
    restock: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();

router.post(
  '/payments/:orderId/refund',
  validate({
    params: z.object({ orderId: objectIdSchema }).strict(),
    query: refundQuerySchema,
  }),
  async (req, res) => {
    const { orderId } = req.valid.params;
    const { restock: shouldRestock } = req.valid.query;
    const attempt = await PaymentAttempt.findOne({ idempotencyKey: String(orderId) });
    if (!attempt) throw new NotFoundError('PAYMENT_NOT_FOUND', 'No payment attempt for this order');

    if (attempt.status === PAYMENT_STATUS.REFUNDED) {
      return res.json({ data: { refund: { orderId, alreadyRefunded: true } } });
    }

    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('ORDER_NOT_FOUND', 'Order not found');

    // Gateway refund executes outside transaction so external side-effects are not repeated on retry
    const refund = await getGateway().refund({ orderId, amountMinor: attempt.amountMinor });

    // Database updates are committed atomically within a single transaction
    await withTransaction(async (session) => {
      await PaymentAttempt.updateOne(
        { _id: attempt._id },
        { $set: { status: PAYMENT_STATUS.REFUNDED } },
        { session },
      );

      await Order.updateOne(
        { _id: orderId },
        {
          $set: { 'payment.status': PAYMENT_STATUS.REFUNDED },
          $push: {
            statusHistory: {
              from: order.status,
              to: order.status,
              at: new Date(),
              reason: shouldRestock ? 'payment_refunded_and_restocked' : 'payment_refunded',
              actor: 'admin',
            },
          },
        },
        { session },
      );

      // Return units to onHand and available if captured stock is being restocked
      if (shouldRestock && (order.status === ORDER_STATUS.PAID || order.status === ORDER_STATUS.FULFILLED)) {
        for (const item of order.items) {
          await restock(item.productId, item.quantity, session);
        }
      }
    });

    return res.json({ data: { refund, restocked: Boolean(shouldRestock) } });
  },
);

const labSchema = z
  .object({
    productId: objectIdSchema,
    buyers: z.number().int().min(1).max(500).default(200),
    quantityPerBuyer: z.number().int().min(1).max(10).default(1),
    policy: z.enum(['race', 'fifo', 'lottery']).default('race'),
  })
  .strict();

/**
 * The Concurrency Lab.
 *
 * Fires N genuinely concurrent checkouts at one product and reports the tally,
 * the final counters and a live invariant check — so the anti-oversell guarantee
 * can be WATCHED rather than taken on trust from the test suite.
 *
 * It drives the checkout service directly rather than over HTTP: the service is
 * where every guarantee lives, and routing 200 requests through loopback would
 * measure the HTTP stack more than the concurrency behaviour. Lab buyers are
 * inserted without password hashing, which would otherwise dominate the runtime.
 */
function calculateGini(values) {
  if (!values || values.length === 0) return 0;
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;

  let cumulativeSum = 0;
  for (let i = 0; i < n; i++) {
    cumulativeSum += (i + 1) * sorted[i];
  }
  const gini = (2 * cumulativeSum) / (n * sum) - (n + 1) / n;
  return Math.max(0, Math.min(1, Math.round(gini * 1000) / 1000));
}

router.post('/concurrency-lab', validate({ body: labSchema }), async (req, res) => {
  const { productId, buyers, quantityPerBuyer, policy } = req.valid.body;

  const product = await Product.findById(productId);
  if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found');

  const initialAvailable = product.available;
  const expectedConfirmed = Math.floor(
    Math.min(buyers * quantityPerBuyer, initialAvailable) / quantityPerBuyer,
  );

  const tag = `lab${Date.now().toString(36)}`;
  const labBuyers = await Customer.insertMany(
    Array.from({ length: buyers }, (_, i) => ({
      email: `${tag}_${i}@lab.local`,
      name: `Lab Buyer ${i + 1}`,
      passwordHash: 'scrypt$lab$not-a-real-password',
      role: 'customer',
    })),
  );

  // Carry stable buyer identity (1-indexed) into all policies
  const buyerEntries = labBuyers.map((buyer, i) => ({
    buyer,
    buyerNumber: i + 1,
  }));

  let admissionOrder = [...buyerEntries];
  if (policy === 'lottery') {
    // Randomized lottery admission order (T1.3)
    for (let i = admissionOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [admissionOrder[i], admissionOrder[j]] = [admissionOrder[j], admissionOrder[i]];
    }
  }

  const startedAt = Date.now();
  let settled;

  const executeBuyer = async (entry) => {
    try {
      const res = await checkout({
        customerId: entry.buyer._id,
        idempotencyKey: `lab-${tag}-${String(entry.buyer._id)}`,
        input: {
          items: [{ productId, quantity: quantityPerBuyer }],
          paymentMethod: { type: 'card', token: 'tok_success' },
          discountCode: null,
        },
      });
      return { status: 'fulfilled', value: res, buyerNumber: entry.buyerNumber };
    } catch (err) {
      return { status: 'rejected', reason: err, buyerNumber: entry.buyerNumber };
    }
  };

  if (policy === 'fifo') {
    // Fair FIFO Admission: arrival-ordered pipeline with bounded concurrency (5 workers)
    // Preserves arrival order while allowing concurrent database contention
    settled = [];
    const queue = [...admissionOrder];
    const workers = Array.from({ length: 5 }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;
        const result = await executeBuyer(entry);
        settled.push(result);
      }
    });
    await Promise.all(workers);
  } else {
    // Simultaneous concurrent execution (natural race or randomized lottery)
    settled = await Promise.all(admissionOrder.map((entry) => executeBuyer(entry)));
  }

  const durationMs = Date.now() - startedAt;

  const tally = { confirmed: 0, outOfStock: 0, other: 0, otherCodes: [] };
  const confirmedBuyerIndices = [];

  settled.forEach((outcome) => {
    if (outcome.status === 'fulfilled') {
      const code = outcome.value.body?.error?.code;
      if (outcome.value.statusCode === 201) {
        tally.confirmed += 1;
        confirmedBuyerIndices.push(outcome.buyerNumber);
      } else if (code === 'OUT_OF_STOCK') {
        tally.outOfStock += 1;
      } else {
        tally.other += 1;
        if (tally.otherCodes.length < 5) tally.otherCodes.push(code ?? `HTTP_${outcome.value.statusCode}`);
      }
    } else {
      const code = outcome.reason?.code ?? 'UNKNOWN';
      if (code === 'OUT_OF_STOCK') {
        tally.outOfStock += 1;
      } else {
        tally.other += 1;
        if (tally.otherCodes.length < 5) tally.otherCodes.push(code);
      }
    }
  });

  // Sort confirmed buyer numbers for readability
  confirmedBuyerIndices.sort((a, b) => a - b);

  // Compute allocation fairness metrics (T1.3)
  const unitsPerBuyer = Array(buyers).fill(0);
  for (const bNum of confirmedBuyerIndices) {
    if (bNum >= 1 && bNum <= buyers) {
      unitsPerBuyer[bNum - 1] += quantityPerBuyer;
    }
  }

  const gini = calculateGini(unitsPerBuyer);
  const minBuyer = confirmedBuyerIndices.length > 0 ? Math.min(...confirmedBuyerIndices) : 0;
  const maxBuyer = confirmedBuyerIndices.length > 0 ? Math.max(...confirmedBuyerIndices) : 0;
  const spreadRange = confirmedBuyerIndices.length > 0 ? maxBuyer - minBuyer + 1 : 0;
  const spreadRatio = buyers > 0 ? Math.round((spreadRange / buyers) * 100) / 100 : 0;

  const fairness = {
    policy,
    gini,
    confirmedBuyerIndices: confirmedBuyerIndices.slice(0, 50),
    winSpread: {
      min: minBuyer,
      max: maxBuyer,
      range: spreadRange,
      spreadRatio,
    },
    summary:
      policy === 'fifo'
        ? 'FIFO Admission: allocation concentrated at front of arrival queue (low spread).'
        : policy === 'lottery'
          ? 'Lottery Draw: equal-odds randomized admission dispersed across cohort (wide spread).'
          : 'Natural Lock Race: allocation determined by database write-lock acquisition.',
  };

  const labBuyerIds = labBuyers.map((buyer) => buyer._id);

  const [after, problems, soldAgg] = await Promise.all([
    Product.findById(productId).lean(),
    checkInvariants(),
    Order.aggregate([
      {
        $match: {
          status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.FULFILLED] },
          customerId: { $in: labBuyerIds },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.productId': product._id } },
      { $group: { _id: null, quantity: { $sum: '$items.quantity' } } },
    ]),
  ]);

  const soldQuantity = soldAgg[0]?.quantity ?? 0;

  res.json({
    data: {
      productId: String(productId),
      sku: product.sku,
      buyers,
      quantityPerBuyer,
      policy,
      fairness,
      initialAvailable,
      expectedConfirmed,
      durationMs,
      tally,
      confirmedBuyerIndices: confirmedBuyerIndices.slice(0, 50),
      finalCounters: {
        onHand: after.onHand,
        reserved: after.reserved,
        available: after.available,
      },
      soldQuantity,
      /** Units this run sold must never exceed the stock it started with. */
      oversold: soldQuantity > initialAvailable,
      invariantsHeld: problems.length === 0,
      invariantProblems: problems,
      telemetry: metrics.getSnapshot(),
      note: 'Driven through the checkout service directly (bypasses HTTP) so the measurement reflects concurrency behaviour rather than the loopback stack.',
    },
  });
});

/**
 * Live Chaos Injection Endpoint (T1.2).
 * Simulates a mid-charge crash (F5), proves hold reclamation, and demonstrates
 * detection of the refund obligation in one click.
 */
router.post('/chaos/simulate-crash', async (req, res) => {
  const product = await Product.findOne({ isActive: true, available: { $gte: 2 } });
  if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Need at least one active product with stock >= 2');

  let buyer = await Customer.findOne({ role: 'customer' });
  if (!buyer && req.auth?.customerId) {
    buyer = await Customer.findById(req.auth.customerId);
  }
  if (!buyer) throw new NotFoundError('BUYER_NOT_FOUND', 'Need at least one customer or admin user');
  const chaosKey = `chaos-live-${Date.now()}`;

  let faultCaught = null;
  try {
    await checkout({
      customerId: String(buyer._id),
      idempotencyKey: chaosKey,
      input: {
        items: [{ productId: String(product._id), quantity: 1 }],
        paymentMethod: { type: 'card', token: 'tok_success' },
        discountCode: null,
      },
      chaosFault: 'crash_after_charge',
    });
  } catch (err) {
    faultCaught = err.message;
  }

  const order = await Order.findOne({ idempotencyKey: chaosKey });
  const attempt = order ? await PaymentAttempt.findOne({ idempotencyKey: String(order._id) }) : null;

  // Fast-forward hold to past TTL so reaper reclaims
  if (order) {
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          reservationExpiresAt: new Date(Date.now() - 5000),
          paymentLeaseExpiresAt: new Date(Date.now() - 5000),
        },
      },
    );
  }

  const sweep = await sweepExpiredReservations({ productIds: [product._id] });

  // Out-of-band settlement detects expired hold and triggers refund obligation
  let settlement = null;
  if (order && attempt?.providerRef) {
    settlement = await settleSuccess({
      orderId: order._id,
      providerRef: attempt.providerRef,
      source: 'reconcile',
    });
  }

  const obligations = await getRefundObligations();
  const problems = await checkInvariants();

  res.json({
    data: {
      faultCaught,
      orderId: order?._id,
      orderNumber: order?.orderNumber,
      attemptStatus: attempt?.status,
      unitsReleased: sweep.released,
      settlementLostCas: settlement?.lost ?? false,
      refundObligationRecorded: obligations.some((o) => String(o.orderId) === String(order?._id)),
      invariantsHeld: problems.length === 0,
      invariantProblems: problems,
    },
  });
});

export default router;
