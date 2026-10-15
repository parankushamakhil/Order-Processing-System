import mongoose from 'mongoose';

/**
 * Order-number allocation (ADR-11). Deliberately OUTSIDE the checkout
 * transaction: every checkout on the planet would otherwise write this one
 * document, making it the hottest document in the system and serialising all
 * checkouts regardless of which product they buy.
 *
 * Gaps are therefore possible after a failed transaction. That is accepted and
 * stated: a gap is a display artefact, and `_id` is the identity used
 * internally everywhere. Gaps are unavoidable without a counter inside the
 * transaction, and a counter inside the transaction is strictly worse.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false, collection: 'counters' },
);

export const Counter = mongoose.model('Counter', counterSchema);

export async function nextOrderNumber() {
  const doc = await Counter.findOneAndUpdate(
    { _id: 'order' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  return `ORD-${String(doc.seq).padStart(6, '0')}`;
}
