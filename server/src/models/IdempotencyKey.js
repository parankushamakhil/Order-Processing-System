import mongoose from 'mongoose';

export const IDEMPOTENCY_STATUS = Object.freeze({
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/**
 * The idempotency claim (ADR-07).
 *
 * The unique index — not an application-side "check then insert" — is the
 * concurrency arbiter. Two simultaneous requests cannot both create a claim.
 *
 * `expiresAt` carries a TTL index, but retention is ALSO enforced by code
 * reading `expiresAt` on the replay path: MongoDB's TTL monitor runs
 * periodically and can lag under load, so its timing must never carry
 * correctness.
 */
const idempotencyKeySchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    endpoint: { type: String, required: true },
    key: { type: String, required: true },
    // Hash of the canonicalised request, so a replay is distinguishable from a
    // reuse of the same key with different intent.
    requestHash: { type: String, required: true },
    status: { type: String, enum: Object.values(IDEMPOTENCY_STATUS), required: true },

    // Lease: if the process holding this claim dies, the claim becomes
    // reclaimable once the lease lapses instead of blocking the customer forever.
    leaseExpiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 1 },
    takeoverCount: { type: Number, default: 0 },

    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    response: {
      statusCode: { type: Number, default: null },
      body: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, collection: 'idempotency_keys' },
);

idempotencyKeySchema.index(
  { customerId: 1, endpoint: 1, key: 1 },
  { unique: true, name: 'claim_unique' },
);
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'retention_ttl' });
idempotencyKeySchema.index({ orderId: 1 }, { name: 'by_order' });

export const IdempotencyKey = mongoose.model('IdempotencyKey', idempotencyKeySchema);
