import mongoose from 'mongoose';

export const PAYMENT_STATUS = Object.freeze({
  INITIATED: 'initiated',
  SUCCEEDED: 'succeeded',
  DECLINED: 'declined',
  ERROR: 'error',
  PENDING: 'pending',
  REFUND_REQUIRED: 'refund_required',
  REFUNDED: 'refunded',
});

/**
 * A payment attempt, one per order.
 *
 * The unique index on { provider, idempotencyKey } — where idempotencyKey is the
 * order id — is what turns "charge exactly once per order" from an aspiration
 * into a database guarantee: a second charge attempt for an order cannot even
 * be recorded.
 *
 * The attempt is created BEFORE the gateway call, so its providerRef gives the
 * webhook something to correlate against even when the charge times out and we
 * never learn the answer synchronously.
 */
const paymentAttemptSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    provider: { type: String, required: true, default: 'simulated' },
    idempotencyKey: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'INR' },
    status: { type: String, enum: Object.values(PAYMENT_STATUS), required: true },
    providerRef: { type: String, default: null },
    providerCode: { type: String, default: null },
    providerMessage: { type: String, default: null },
    latencyMs: { type: Number, default: null },
    attempts: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, collection: 'payment_attempts' },
);

paymentAttemptSchema.index(
  { provider: 1, idempotencyKey: 1 },
  { unique: true, name: 'one_charge_per_order' },
);
paymentAttemptSchema.index({ orderId: 1 }, { name: 'by_order' });
paymentAttemptSchema.index({ providerRef: 1 }, { name: 'by_provider_ref' });

export const PaymentAttempt = mongoose.model('PaymentAttempt', paymentAttemptSchema);
