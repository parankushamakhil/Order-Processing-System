import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config/index.js';
import { AppError, NotFoundError } from '../errors/index.js';
import { attachRequestId } from '../lib/envelope.js';
import { validate } from '../middleware/validate.js';
import { Order } from '../models/index.js';
import { settlePaymentOutcome } from '../services/paymentSettlement.service.js';
import { webhookSchema } from '../validation/schemas.js';

/** Exported so tests and tooling can sign payloads exactly as the provider would. */
export function signWebhookPayload(raw) {
  return createHmac('sha256', config.WEBHOOK_SECRET).update(raw).digest('hex');
}

function verifySignature(raw, signature) {
  if (!signature) return false;
  const expected = Buffer.from(signWebhookPayload(raw));
  const provided = Buffer.from(String(signature));
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function requireValidSignature(req, res, next) {
  // HMAC over the RAW bytes, which is why app.js captures req.rawBody in the
  // JSON parser. Re-serialised JSON would not reproduce the signed bytes.
  const raw = req.rawBody ?? Buffer.from('');
  if (!verifySignature(raw, req.get('x-signature'))) {
    return next(
      new AppError('Webhook signature verification failed', {
        code: 'INVALID_SIGNATURE',
        status: 401,
      }),
    );
  }
  return next();
}

const router = Router();

/**
 * The payment provider's asynchronous answer, for charges whose outcome was not
 * known synchronously. Applying it goes through exactly the same settlement
 * functions as the inline path, so a webhook can never take a route the saga
 * would not — and because every transition is a compare-and-swap, a duplicated
 * webhook is a no-op rather than a second capture.
 */
router.post(
  '/payments/simulated',
  requireValidSignature,
  validate({ body: webhookSchema }),
  async (req, res) => {
    const { orderId, status, providerRef, providerMessage, amountMinor } = req.valid.body;

    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('ORDER_NOT_FOUND', 'Unknown order for this webhook');

    // The signature proves WHO sent this. It does not prove the amount is the
    // one we asked for, so the figure is checked rather than trusted.
    if (amountMinor != null && amountMinor !== order.pricing.totalMinor) {
      throw new AppError('The reported amount does not match the order total', {
        code: 'AMOUNT_MISMATCH',
        status: 409,
        details: {
          orderId,
          expectedAmountMinor: order.pricing.totalMinor,
          receivedAmountMinor: amountMinor,
        },
      });
    }

    const result = await settlePaymentOutcome({
      orderId,
      status,
      providerRef,
      providerMessage,
      source: 'webhook',
    });

    res.status(result.statusCode ?? 200).json(attachRequestId(result.body, req.id));
  },
);

export default router;
