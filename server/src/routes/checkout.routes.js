import { Router } from 'express';
import { config } from '../config/index.js';
import { IdempotencyKeyRequiredError } from '../errors/index.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { checkout } from '../services/checkout.service.js';
import { attachRequestId } from '../lib/envelope.js';
import { checkoutSchema, idempotencyKeySchema } from '../validation/schemas.js';

const router = Router();

/**
 * POST /api/checkout — the endpoint this whole system exists to make reliable.
 *
 * Middleware order matters: authenticate first (so the rate limiter can key on a
 * customer), then limit, then validate, and only then enter the saga.
 */
router.post(
  '/',
  requireAuth,
  rateLimit({
    limit: config.CHECKOUT_RATE_LIMIT_PER_MIN,
    keyFn: (req) => `checkout:${req.auth?.customerId ?? req.ip}`,
  }),
  validate({ body: checkoutSchema }),
  async (req, res) => {
    const rawKey = req.get('idempotency-key');
    if (!rawKey) throw new IdempotencyKeyRequiredError();

    // Validated, not just checked: a header is untrusted input like any other.
    const idempotencyKey = idempotencyKeySchema.parse(rawKey);

    const result = await checkout({
      customerId: req.auth.customerId,
      idempotencyKey,
      input: req.valid.body,
    });

    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    res.status(result.statusCode).json(attachRequestId(result.body, req.id));
  },
);

export default router;
