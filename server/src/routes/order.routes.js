import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../db/transaction.js';
import { release } from '../domain/inventory.js';
import { transition } from '../domain/orderState.js';
import { ORDER_STATUS } from '../domain/orderStatus.js';
import { AppError, ForbiddenError, NotFoundError } from '../errors/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { IdempotencyKey, IDEMPOTENCY_STATUS, Order } from '../models/index.js';
import { objectIdSchema, orderListQuerySchema } from '../validation/schemas.js';

const router = Router();

router.get('/', requireAuth, validate({ query: orderListQuerySchema }), async (req, res) => {
  const filter = { customerId: req.auth.customerId };
  if (req.valid.query.status) filter.status = req.valid.query.status;

  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(req.valid.query.limit);
  res.json({ data: { items: orders.map((o) => o.toPublic()) } });
});

router.get(
  '/:id',
  requireAuth,
  validate({ params: z.object({ id: objectIdSchema }).strict() }),
  async (req, res) => {
    const order = await Order.findById(req.valid.params.id);
    if (!order) throw new NotFoundError('ORDER_NOT_FOUND', 'Order not found');

    // Ownership is enforced on every read: no IDOR. A 403 rather than a 404 is
    // deliberate here because the id is not guessable in practice and the
    // distinction is useful to the legitimate owner's client.
    const isOwner = String(order.customerId) === String(req.auth.customerId);
    if (!isOwner && req.auth.role !== 'admin') {
      throw new ForbiddenError('You do not have access to this order');
    }

    res.json({ data: { order: order.toPublic() } });
  },
);

router.post(
  '/:id/cancel',
  requireAuth,
  validate({ params: z.object({ id: objectIdSchema }).strict() }),
  async (req, res) => {
    const { id } = req.valid.params;
    const order = await Order.findById(id);
    if (!order) throw new NotFoundError('ORDER_NOT_FOUND', 'Order not found');

    const isOwner = String(order.customerId) === String(req.auth.customerId);
    if (!isOwner && req.auth.role !== 'admin') {
      throw new ForbiddenError('You do not have access to this order');
    }

    const cancelled = await withTransaction(async (session) => {
      const result = await transition(
        id,
        ORDER_STATUS.PENDING_PAYMENT,
        ORDER_STATUS.CANCELLED,
        { reason: 'cancelled_by_customer', actor: 'customer', paymentLeaseExpiresAt: null },
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
  },
);

export default router;

