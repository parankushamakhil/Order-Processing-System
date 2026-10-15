import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../db/transaction.js';
import { release } from '../domain/inventory.js';
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
import { checkout } from '../services/checkout.service.js';
import { sweepExpiredReservations } from '../services/expiry.service.js';
import { settlePaymentOutcome } from '../services/paymentSettlement.service.js';
import { getGateway } from '../services/payments/index.js';
import { objectIdSchema } from '../validation/schemas.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const idParams = z.object({ id: objectIdSchema }).strict();

router.get('/inventory/reconcile', async (req, res) => {
  res.json({ data: await reconciliationReport() });
});

router.get('/inventory/refund-obligations', async (req, res) => {
  res.json({ data: { obligations: await getRefundObligations() } });
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

router.post(
  '/payments/:orderId/refund',
  validate({ params: z.object({ orderId: objectIdSchema }).strict() }),
  async (req, res) => {
    const { orderId } = req.valid.params;
    const attempt = await PaymentAttempt.findOne({ idempotencyKey: String(orderId) });
    if (!attempt) throw new NotFoundError('PAYMENT_NOT_FOUND', 'No payment attempt for this order');

    if (attempt.status === PAYMENT_STATUS.REFUNDED) {
      return res.json({ data: { refund: { orderId, alreadyRefunded: true } } });
    }

    const refund = await getGateway().refund({ orderId, amountMinor: attempt.amountMinor });
    await PaymentAttempt.updateOne(
      { _id: attempt._id },
      { $set: { status: PAYMENT_STATUS.REFUNDED } },
    );
    return res.json({ data: { refund } });
  },
);

const labSchema = z
  .object({
    productId: objectIdSchema,
    buyers: z.number().int().min(1).max(500).default(200),
    quantityPerBuyer: z.number().int().min(1).max(10).default(1),
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
router.post('/concurrency-lab', validate({ body: labSchema }), async (req, res) => {
  const { productId, buyers, quantityPerBuyer } = req.valid.body;

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
      name: 'Lab Buyer',
      passwordHash: 'scrypt$lab$not-a-real-password',
      role: 'customer',
    })),
  );

  const startedAt = Date.now();
  const settled = await Promise.allSettled(
    labBuyers.map((buyer) =>
      checkout({
        customerId: buyer._id,
        idempotencyKey: `lab-${tag}-${String(buyer._id)}`,
        input: {
          items: [{ productId, quantity: quantityPerBuyer }],
          paymentMethod: { type: 'card', token: 'tok_success' },
          discountCode: null,
        },
      }),
    ),
  );
  const durationMs = Date.now() - startedAt;

  const tally = { confirmed: 0, outOfStock: 0, other: 0, otherCodes: [] };
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const code = outcome.value.body?.error?.code;
      if (outcome.value.statusCode === 201) tally.confirmed += 1;
      else if (code === 'OUT_OF_STOCK') tally.outOfStock += 1;
      else {
        tally.other += 1;
        if (tally.otherCodes.length < 5) tally.otherCodes.push(code ?? `HTTP_${outcome.value.statusCode}`);
      }
    } else {
      const code = outcome.reason?.code ?? 'UNKNOWN';
      if (code === 'OUT_OF_STOCK') tally.outOfStock += 1;
      else {
        tally.other += 1;
        if (tally.otherCodes.length < 5) tally.otherCodes.push(code);
      }
    }
  }

  // Scoped to THE BUYERS THIS RUN CREATED, not to all history for the product.
  // An unscoped Sum counts sales made before the lab started and reports a false
  // "oversold" — which is worse than no indicator at all, because it makes the
  // guarantee look broken exactly when it is holding. (Found by using the UI.)
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
      initialAvailable,
      expectedConfirmed,
      durationMs,
      tally,
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
      note: 'Driven through the checkout service directly (bypasses HTTP) so the measurement reflects concurrency behaviour rather than the loopback stack.',
    },
  });
});

export default router;
