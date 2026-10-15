import { describe, expect, it } from 'vitest';
import { capture, release } from '../../src/domain/inventory.js';
import { transition } from '../../src/domain/orderState.js';
import {
  ALL_STATUSES,
  ALLOWED_TRANSITIONS,
  ORDER_STATUS,
  TERMINAL_STATUSES,
  canTransition,
} from '../../src/domain/orderStatus.js';
import { IllegalTransitionError } from '../../src/errors/index.js';
import { Order } from '../../src/models/index.js';
import { createCustomer, createPendingOrder, createProduct } from '../helpers/factories.js';

/**
 * `transition()` deliberately touches ONLY the order — inventory is moved by the
 * caller, in the same transaction. These tests therefore finish the job, which
 * is exactly what production does:
 *
 *   paid / fulfilled  -> capture (the hold becomes a sale)
 *   anything else     -> release (the hold goes back on sale)
 *
 * Doing it this way keeps the global invariant hook ACTIVE rather than opting
 * out of it. Opting out would hide the very class of bug the hook exists to
 * catch, and an earlier version of these tests failed I3 precisely because they
 * moved an order without moving its stock.
 */
async function completeStockSide(orderId) {
  const fresh = await Order.findById(orderId);
  const lines = fresh.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));

  if (fresh.status === ORDER_STATUS.PAID || fresh.status === ORDER_STATUS.FULFILLED) {
    await capture(lines);
  } else if (
    fresh.status === ORDER_STATUS.CANCELLED ||
    fresh.status === ORDER_STATUS.EXPIRED ||
    fresh.status === ORDER_STATUS.PAYMENT_FAILED
  ) {
    await release(lines);
  }
  return fresh;
}

describe('transition table', () => {
  it('makes every terminal state absorbing', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
      for (const to of ALL_STATUSES) {
        expect(canTransition(status, to)).toBe(false);
      }
    }
  });

  it('lets a pending order be settled, expired or cancelled', () => {
    expect(canTransition(ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PAID)).toBe(true);
    expect(canTransition(ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PAYMENT_FAILED)).toBe(true);
    expect(canTransition(ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.EXPIRED)).toBe(true);
    expect(canTransition(ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.CANCELLED)).toBe(true);
    expect(canTransition(ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.FULFILLED)).toBe(false);
  });

  it('only lets a paid order be fulfilled or cancelled', () => {
    expect(canTransition(ORDER_STATUS.PAID, ORDER_STATUS.FULFILLED)).toBe(true);
    expect(canTransition(ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED)).toBe(true);
    expect(canTransition(ORDER_STATUS.PAID, ORDER_STATUS.EXPIRED)).toBe(false);
    expect(canTransition(ORDER_STATUS.PAID, ORDER_STATUS.PAYMENT_FAILED)).toBe(false);
  });
});

describe('transition()', () => {
  it('refuses an illegal transition before touching the database', async () => {
    await expect(
      transition('a'.repeat(24), ORDER_STATUS.PAID, ORDER_STATUS.EXPIRED),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('applies a legal transition and records the history', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });
    const order = await createPendingOrder({ customerId: id, product, quantity: 1 });

    const paid = await transition(order._id, ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PAID, {
      reason: 'unit_test',
    });

    expect(paid.status).toBe(ORDER_STATUS.PAID);
    expect(paid.statusHistory).toHaveLength(2);
    expect(paid.statusHistory.at(-1)).toMatchObject({
      from: ORDER_STATUS.PENDING_PAYMENT,
      to: ORDER_STATUS.PAID,
      reason: 'unit_test',
    });

    await completeStockSide(order._id);
  });

  /**
   * The compare-and-swap is the reason compensations happen exactly once, so it
   * gets its own test: the second actor must receive null rather than a second
   * successful transition.
   */
  it('lets exactly one of two competing transitions win', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });
    const order = await createPendingOrder({ customerId: id, product, quantity: 1 });

    const [a, b] = await Promise.all([
      transition(order._id, ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PAID, { actor: 'a' }),
      transition(order._id, ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.CANCELLED, { actor: 'b' }),
    ]);

    const winners = [a, b].filter(Boolean);
    const losers = [a, b].filter((r) => r === null);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const fresh = await Order.findById(order._id);
    expect([ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED]).toContain(fresh.status);

    await completeStockSide(order._id);
  });

  it('returns null when the order is already settled', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });
    const order = await createPendingOrder({ customerId: id, product, quantity: 1 });

    await transition(order._id, ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PAID);
    const again = await transition(order._id, ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PAID);

    expect(again).toBeNull();

    await completeStockSide(order._id);
  });
});
