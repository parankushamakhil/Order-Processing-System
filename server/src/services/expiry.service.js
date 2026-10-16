import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import { release } from '../domain/inventory.js';
import { transition } from '../domain/orderState.js';
import { ORDER_STATUS } from '../domain/orderStatus.js';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { IdempotencyKey, IDEMPOTENCY_STATUS } from '../models/IdempotencyKey.js';
import { Order } from '../models/Order.js';

/**
 * Return the stock held by orders whose reservation has lapsed.
 *
 * Exactly-once and crash-safe for two reasons:
 *  1. The status transition and the stock release are in the SAME transaction,
 *     so an order can never be marked expired without its stock coming back.
 *  2. The transition is a compare-and-swap, so if the reaper, a concurrent
 *     user-triggered reclaim and a payment success all fire at once, only one
 *     wins and only one adjustment happens.
 *
 * `productId`/`productIds` exist so this can be called from the DEMAND path, not
 * only from a timer (ADR-10). That is what makes correctness independent of the
 * scheduler: if the timer is misconfigured, slow, or the process was down, a
 * buyer's failed reservation still triggers a targeted reclaim.
 */
export async function sweepExpiredReservations({
  limit = null,
  productId = null,
  productIds = null,
} = {}) {
  const batchSize = limit ?? config.REAPER_BATCH_SIZE;
  const now = new Date();

  const query = {
    status: ORDER_STATUS.PENDING_PAYMENT,
    reservationExpiresAt: { $lte: now },
    // An order is expirable only if it is NOT mid-charge. `paymentLeaseExpiresAt`
    // is either null (no charge started, or the answer was lost) or a date, so
    // this MUST be written as an $or.
    //
    // It cannot be `{ $lte: now }`. MongoDB's comparison query operators are
    // TYPE-BRACKETED: `$lte: <Date>` does not match null or a missing field,
    // even though null sorts below dates in BSON order. Writing it as $lte
    // silently disabled expiry for precisely the orders that need it most —
    // timed-out charges with no lease — and was caught by the reaper test, not
    // by reasoning. `{ field: null }` correctly matches null OR missing.
    $or: [{ paymentLeaseExpiresAt: null }, { paymentLeaseExpiresAt: { $lte: now } }],
  };

  const ids = productIds ?? (productId ? [productId] : null);
  if (ids?.length) query['items.productId'] = { $in: ids };

  const candidates = await Order.find(query).limit(batchSize).select('_id items').lean();

  let released = 0;
  const orderIds = [];

  for (const candidate of candidates) {
    const expiredOrder = await withTransaction(async (session) => {
      const expired = await transition(
        candidate._id,
        ORDER_STATUS.PENDING_PAYMENT,
        ORDER_STATUS.EXPIRED,
        { reason: 'reservation_expired', actor: 'reaper', paymentLeaseExpiresAt: null },
        session,
      );
      if (!expired) return null; // someone else settled this order — adjust nothing

      await release(
        candidate.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        session,
      );

      // A claim still PROCESSING belongs to an attempt that died before it could
      // spend itself, so make it retryable rather than leaving the customer
      // blocked behind a key that can never resolve.
      await IdempotencyKey.updateMany(
        { orderId: candidate._id, status: IDEMPOTENCY_STATUS.PROCESSING },
        { $set: { status: IDEMPOTENCY_STATUS.FAILED, leaseExpiresAt: new Date() } },
        { session },
      );

      return expired;
    });

    // Counted OUTSIDE the callback: a transaction callback can be re-run after a
    // transient error, so mutating anything shared inside it double-counts.
    if (expiredOrder) {
      released += 1;
      orderIds.push(String(candidate._id));
    }
  }

  if (released > 0) {
    metrics.inc('reservation_reclaims_total', { trigger: ids?.length ? 'lazy_demand' : 'timer_sweep' }, released);
    logger.info('released expired reservations', {
      released,
      scanned: candidates.length,
      targeted: Boolean(ids?.length),
    });
  }

  return { scanned: candidates.length, released, orderIds };
}

let timer = null;

/** Periodic hygiene. Deliberately NOT required for correctness. */
export function startReaper() {
  if (timer) return timer;
  timer = setInterval(() => {
    sweepExpiredReservations().catch((err) => {
      logger.error('reaper sweep failed', { error: err?.message });
    });
  }, config.REAPER_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export function stopReaper() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
