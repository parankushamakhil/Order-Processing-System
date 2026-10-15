import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IdempotencyKey } from '../../src/models/index.js';
import { Order, PaymentAttempt } from '../../src/models/index.js';
import {
  checkoutBody,
  checkoutRequest,
  counters,
  createCustomer,
  createProduct,
  http,
} from '../helpers/factories.js';

describe('idempotent checkout', () => {
  it('replays a completed checkout without re-executing it', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();
    const body = checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] });

    const first = await checkoutRequest({ auth, key, body });
    const second = await checkoutRequest({ auth, key, body });
    const third = await checkoutRequest({ auth, key, body });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(201);
    expect(second.body.data.order.id).toBe(first.body.data.order.id);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body.data.replayed).toBe(true);
    expect(third.body.data.order.id).toBe(first.body.data.order.id);

    expect(await Order.countDocuments()).toBe(1);
    expect(await PaymentAttempt.countDocuments()).toBe(1);
    expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });
  });

  it('refuses the same key used for a different cart', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();

    const first = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    expect(first.status).toBe(201);

    const conflicting = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 5 }] }),
    });

    expect(conflicting.status).toBe(422);
    expect(conflicting.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
    // The original order is untouched and no second order was created.
    expect(await Order.countDocuments()).toBe(1);
    expect(await counters(product._id)).toEqual({ onHand: 9, reserved: 0, available: 9 });
  });

  it('scopes keys per customer, so two shoppers may use the same key', async () => {
    const alice = await createCustomer();
    const bob = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const sharedKey = 'shared-key-0001';

    const body = checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] });
    const a = await checkoutRequest({ auth: alice.auth, key: sharedKey, body });
    const b = await checkoutRequest({ auth: bob.auth, key: sharedKey, body });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.order.id).not.toBe(b.body.data.order.id);
    expect(await Order.countDocuments()).toBe(2);
  });

  /**
   * The recovery requirement. A declined purchase leaves a `failed` claim, which
   * stays retryable with the SAME key — including after the customer switches to
   * a working card, because the instrument is not part of the request hash.
   */
  it('recovers a declined checkout when retried with the same key', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();

    const declined = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 2 }],
        token: 'tok_decline',
      }),
    });

    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe('PAYMENT_DECLINED');
    // The hold came straight back.
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });

    const retried = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 2 }],
        token: 'tok_success',
      }),
    });

    expect(retried.status).toBe(201);
    expect(retried.body.data.order.status).toBe('paid');
    expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });
    expect(await Order.countDocuments()).toBe(2); // the failed one plus the retry
  });

  it('releases the key when the request itself was wrong', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();

    const bad = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({ items: [{ productId: 'c'.repeat(24), quantity: 1 }] }),
    });
    expect(bad.status).toBe(404);
    // Nothing was spent, so the key was released rather than burned.
    expect(await IdempotencyKey.countDocuments()).toBe(0);

    const fixed = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    expect(fixed.status).toBe(201);
  });

  it('rejects an out-of-stock attempt but lets the same key retry after a restock', async () => {
    const { auth } = await createCustomer();
    const admin = await createCustomer({ role: 'admin' });
    const product = await createProduct({ priceMinor: 1000, onHand: 1 });
    const key = randomUUID();
    const body = checkoutBody({ items: [{ productId: String(product._id), quantity: 3 }] });

    const short = await checkoutRequest({ auth, key, body });
    expect(short.status).toBe(409);

    const claim = await IdempotencyKey.findOne({ key });
    expect(claim.status).toBe('failed');

    // Restock through the real admin endpoint, then retry with the same key.
    const restocked = await http()
      .post(`/api/products/${product._id}/stock`)
      .set('Authorization', admin.auth)
      .send({ units: 5 });
    expect(restocked.status).toBe(200);

    const retried = await checkoutRequest({ auth, key, body });
    expect(retried.status).toBe(201);
    expect(await counters(product._id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });

  it('sets a terminal claim to completed and stores its status code', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });
    const key = randomUUID();

    await checkoutRequest({
      auth,
      key,
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    const claim = await IdempotencyKey.findOne({ key });
    expect(claim.status).toBe('completed');
    expect(claim.response.statusCode).toBe(201);
    expect(claim.orderId).toBeTruthy();
    expect(claim.requestHash).toHaveLength(64);
  });
});
