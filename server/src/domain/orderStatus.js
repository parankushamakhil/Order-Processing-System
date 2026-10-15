/**
 * The order lifecycle. Kept in its own module with no imports so the model, the
 * state machine and the reaper can all share it without a circular dependency.
 *
 * Two terminal-ish states deserve a note:
 *  - `expired`   the reservation lapsed before payment resolved (the reaper).
 *  - `cancelled` an explicit actor ended it (admin, customer).
 * They are distinct because they have different causes and different customer
 * messaging, even though both release stock.
 */
export const ORDER_STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment',
  PAID: 'paid',
  PAYMENT_FAILED: 'payment_failed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  FULFILLED: 'fulfilled',
});

export const ALL_STATUSES = Object.freeze(Object.values(ORDER_STATUS));

/**
 * Stock-holding states. An order in one of these holds `reserved` units, which
 * is exactly the invariant I3 asserts: for every product,
 * `reserved === Σ quantity over orders whose status is in HOLDING_STATUSES`.
 */
export const HOLDING_STATUSES = Object.freeze([ORDER_STATUS.PENDING_PAYMENT]);

export const TERMINAL_STATUSES = Object.freeze([
  ORDER_STATUS.PAYMENT_FAILED,
  ORDER_STATUS.EXPIRED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.FULFILLED,
]);

/**
 * Terminal states have no outgoing transitions, which is what makes a late
 * webhook or a double-click unable to resurrect a settled order.
 * `paid -> cancelled` is allowed because a refund has to come from somewhere.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [ORDER_STATUS.PENDING_PAYMENT]: [
    ORDER_STATUS.PAID,
    ORDER_STATUS.PAYMENT_FAILED,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.CANCELLED,
  ],
  [ORDER_STATUS.PAID]: [ORDER_STATUS.FULFILLED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PAYMENT_FAILED]: [],
  [ORDER_STATUS.EXPIRED]: [],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.FULFILLED]: [],
});

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}
