import mongoose from 'mongoose';

/**
 * The ONE place a session is opened or ended (ADR-04).
 *
 * Every transaction in the system — checkout TX1, the payment outcome
 * transactions, the reaper, cancellation — goes through here, so session
 * lifetime and read/write concerns are decided once instead of per call site,
 * and no code path can leak a session.
 *
 * `session.withTransaction()` is used rather than hand-rolled retry loops
 * because MongoDB's documented error handling requires distinguishing
 * TransientTransactionError (retry the whole transaction) from
 * UnknownTransactionCommitResult (retry the commit only). Getting that split
 * wrong produces duplicate commits; the helper implements it correctly.
 *
 * The callback may be re-run after a transient error. That is why callers must
 * keep shared state (counters, accumulators, external calls) OUTSIDE the
 * callback and derive it from the return value instead.
 */
export async function withTransaction(fn, options = {}) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(fn, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      ...options,
    });
  } finally {
    await session.endSession();
  }
}
