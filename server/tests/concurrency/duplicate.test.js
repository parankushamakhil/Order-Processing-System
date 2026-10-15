import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Order, PaymentAttempt } from '../../src/models/index.js';
import {
  checkoutBody,
  checkoutRequest,
  counters,
  createCustomer,
  createProduct,
  withConfig,
} from '../helpers/factories.js';
import { expectInvariants } from '../helpers/setup.js';

const nonReplaySuccesses = (responses) =>
  responses.filter((r) => r.status === 201 && r.body.data?.replayed === false);

describe('duplicate checkout requests', () => {
  /**
   * Fifty simultaneous requests with one key. Exactly one execution must occur,
   * however many responses come back — and every response must name the same
   * order, so the client never sees a second purchase it did not intend.
   */
  it('creates one order and one charge for 50 concurrent requests on one key', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();
    const body = checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => checkoutRequest({ auth, key, body })),
    );

    const orderIds = new Set(responses.map((r) => r.body.data?.order?.id).filter(Boolean));

    expect(nonReplaySuccesses(responses)).toHaveLength(1);
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(orderIds.size).toBe(1);

    expect(await Order.countDocuments()).toBe(1);
    expect(await PaymentAttempt.countDocuments()).toBe(1);
    expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });
    await expectInvariants();
  });

  /**
   * The same 50 requests with the coalescing wait switched off. The winner is
   * unchanged; the losers are told to come back rather than silently creating a
   * second order. Asserting on the number of EXECUTIONS (not on the number of
   * 201s) keeps this deterministic, since a loser may legitimately observe the
   * winner's completed result before its own request is handled.
   */
  it('still executes once when duplicates cannot wait for the winner', async () => {
    await withConfig({ IDEMPOTENCY_WAIT_MS: 0 }, async () => {
      const { auth } = await createCustomer();
      const product = await createProduct({ priceMinor: 1000, onHand: 10 });
      const key = randomUUID();
      const body = checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] });

      const responses = await Promise.all(
        Array.from({ length: 50 }, () => checkoutRequest({ auth, key, body })),
      );

      expect(nonReplaySuccesses(responses)).toHaveLength(1);

      for (const response of responses) {
        if (response.status === 201) continue;
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('CHECKOUT_IN_PROGRESS');
        expect(response.body.error.retryable).toBe(true);
        expect(response.headers['retry-after']).toBeDefined();
      }

      expect(await Order.countDocuments()).toBe(1);
      expect(await PaymentAttempt.countDocuments()).toBe(1);
      expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });
      await expectInvariants();
    });
  });

  it('treats distinct keys as distinct purchases', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 30 });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        checkoutRequest({
          auth,
          key: randomUUID(),
          body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
        }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(20);
    expect(await Order.countDocuments()).toBe(20);
    // 20 units sold from 30: the key dedupes, it does not serialise intent.
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
    await expectInvariants();
  });

  it('lets the same key be used concurrently by different customers independently', async () => {
    const product = await createProduct({ priceMinor: 1000, onHand: 20 });
    const buyers = await Promise.all([createCustomer(), createCustomer(), createCustomer()]);
    const sharedKey = 'race-shared-key-1';

    const responses = await Promise.all(
      buyers.map((buyer) =>
        checkoutRequest({
          auth: buyer.auth,
          key: sharedKey,
          body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
        }),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body.data.order.id)).size).toBe(3);
    expect(await counters(product._id)).toEqual({
      onHand: 17,
      reserved: 0,
      available: 17,
    });
  });
});
