import { IllegalTransitionError } from '../errors/index.js';
import { Order } from '../models/Order.js';
import { TERMINAL_STATUSES, canTransition } from './orderStatus.js';

/**
 * The ONE chokepoint for order status changes.
 *
 * Every transition in the system — the checkout saga, the payment webhook, the
 * reaper, admin cancellation — goes through here. Two properties follow:
 *
 *  1. `findOneAndUpdate({ _id, status: from }, ...)` is an atomic
 *     compare-and-swap on a single document. If two actors (a payment success
 *     and the reaper, say) try to move the same order out of `pending_payment`
 *     concurrently, exactly one matches. The loser receives `null` and knows it
 *     must not touch stock. That is what makes compensations happen exactly
 *     once — no distributed lock, no idempotency ledger.
 *
 *  2. Appending `statusHistory` here means the audit trail cannot be bypassed,
 *     and this function is the natural place to emit an event if a
 *     transactional outbox is ever added (ADR-13).
 *
 * @returns the updated document, or null if the CAS did not match.
 */
export async function transition(orderId, from, to, patch = {}, session = null) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);

  const { reason = null, actor = 'system', ...rest } = patch;

  return Order.findOneAndUpdate(
    { _id: orderId, status: from },
    {
      $set: { status: to, ...rest },
      $push: { statusHistory: { from, to, at: new Date(), reason, actor } },
    },
    { returnDocument: 'after', session },
  );
}

/**
 * Terminal states have no outgoing transitions, so this is how a late or
 * duplicated webhook discovers that the order was already settled elsewhere.
 */
export function isSettled(order) {
  return Boolean(order) && TERMINAL_STATUSES.includes(order.status);
}
