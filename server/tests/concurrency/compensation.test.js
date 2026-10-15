import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Order, PaymentAttempt, PAYMENT_STATUS } from '../../src/models/index.js';
import { sweepExpiredReservations } from '../../src/services/expiry.service.js';
import { settleSuccess } from '../../src/services/paymentSettlement.service.js';
import {
  counters,
  createCustomer,
  createPendingOrder,
  createProduct,
  postWebhook,
  webhookPayload,
} from '../helpers/factories.js';
import { expectInvariants } from '../helpers/setup.js';

const LAPSED = -5_000;

describe('exactly-once compensation', () => {
  /**
   * The hardest interleaving in the system: the reaper wants to expire the order
   * and hand the stock back, while a payment success wants to settle it and
   * capture the stock. Both begin with the same compare-and-swap, so only one
   * can act — and which one wins is genuinely non-deterministic, so the test
   * asserts the OUTCOME SPACE rather than a single fixed result.
   *
   * Repeated because a single run only samples one ordering.
   */
  it('lets exactly one of the reaper and a payment success act, every time', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { id } = await createCustomer();
      const product = await createProduct({ onHand: 10, priceMinor: 1000 });
      const order = await createPendingOrder({
        customerId: id,
        product,
        quantity: 4,
        reservationTtlMs: LAPSED,
        paymentLeaseMs: LAPSED,
      });

      await Promise.all([
        sweepExpiredReservations().catch(() => {}),
        settleSuccess({ orderId: order._id, providerRef: `sim_race_${round}`, source: 'test' }),
      ]);

      const final = await Order.findById(order._id);
      const attempt = await PaymentAttempt.findOne({ idempotencyKey: String(order._id) });
      const finalCounters = await counters(product._id);

      if (final.status === ORDER_STATUS.PAID) {
        // Payment won: the hold became a sale, and the money is accounted for.
        expect(attempt.status).toBe(PAYMENT_STATUS.SUCCEEDED);
        expect(finalCounters).toEqual({ onHand: 6, reserved: 0, available: 6 });
      } else {
        // The reaper won: the stock came back, and the late charge is an
        // explicit obligation rather than a silent loss.
        expect(final.status).toBe(ORDER_STATUS.EXPIRED);
        expect(attempt.status).toBe(PAYMENT_STATUS.REFUND_REQUIRED);
        expect(finalCounters).toEqual({ onHand: 10, reserved: 0, available: 10 });
      }

      // Either way the stock moved exactly once, never twice, and I1 still holds.
      expect(finalCounters.reserved).toBe(0);
      expect(finalCounters.available).toBe(finalCounters.onHand - finalCounters.reserved);
    }

    await expectInvariants();
  });

  it('releases exactly once even when several reapers run at the same moment', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });
    await createPendingOrder({
      customerId: id,
      product,
      quantity: 3,
      reservationTtlMs: LAPSED,
      paymentLeaseMs: LAPSED,
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => sweepExpiredReservations()),
    );

    const totalReleased = results.reduce((sum, r) => sum + r.released, 0);
    expect(totalReleased).toBe(1);
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
    await expectInvariants();
  });

  it('captures once when the same success webhook arrives many times at once', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });
    const { checkoutRequest, checkoutBody } = await import('../helpers/factories.js');
    const { randomUUID } = await import('node:crypto');

    const started = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 3 }],
        token: 'tok_timeout',
      }),
    });
    const orderId = started.body.data.order.id;

    const { getGateway } = await import('../../src/services/payments/index.js');
    const pending = getGateway().resolvePending({ orderId });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        postWebhook(
          webhookPayload({ orderId, providerRef: pending.providerRef, status: 'succeeded' }),
        ),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);

    // Captured exactly once: onHand fell by 3, not by 24.
    expect(await counters(product._id)).toEqual({ onHand: 7, reserved: 0, available: 7 });
    expect(await PaymentAttempt.countDocuments()).toBe(1);
    expect((await PaymentAttempt.findOne()).status).toBe(PAYMENT_STATUS.SUCCEEDED);
    expect((await Order.findById(orderId)).status).toBe(ORDER_STATUS.PAID);
    await expectInvariants();
  });
});
