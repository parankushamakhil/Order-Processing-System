import { Router } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '../errors/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { Order } from '../models/index.js';
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

export default router;
