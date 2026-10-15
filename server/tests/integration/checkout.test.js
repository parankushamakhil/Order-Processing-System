import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/transaction.js';
import { reserve } from '../../src/domain/inventory.js';
import { InsufficientStockError } from '../../src/errors/index.js';
import { Order } from '../../src/models/index.js';
import {
  checkoutBody,
  checkoutRequest,
  counters,
  createCustomer,
  createProduct,
  http,
} from '../helpers/factories.js';

const line = (product, quantity) => ({ productId: product._id, quantity });

describe('POST /api/checkout — pricing', () => {
  it('prices entirely server-side from the catalogue', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    expect(response.status).toBe(201);
    expect(response.body.data.order.pricing).toMatchObject({
      subtotalMinor: 1000,
      taxMinor: 80, // 8%
      shippingMinor: 599, // below the free-shipping threshold
      totalMinor: 1679,
      currency: 'USD',
    });
  });

  it('sums multiple lines and drops shipping above the threshold', async () => {
    const { auth } = await createCustomer();
    const a = await createProduct({ priceMinor: 1000, onHand: 5 });
    const b = await createProduct({ priceMinor: 2000, onHand: 5 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [
          { productId: String(a._id), quantity: 1 },
          { productId: String(b._id), quantity: 2 },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(response.body.data.order.pricing).toMatchObject({
      subtotalMinor: 5000,
      taxMinor: 400,
      shippingMinor: 0,
      totalMinor: 5400,
    });
  });

  it('applies a discount before tax', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 1 }],
        discountCode: 'SAVE10',
      }),
    });

    expect(response.status).toBe(201);
    expect(response.body.data.order.pricing).toMatchObject({
      subtotalMinor: 1000,
      discountMinor: 100,
      taxMinor: 72,
      totalMinor: 1571,
    });
  });

  it('merges duplicate line items into one line', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [
          { productId: String(product._id), quantity: 1 },
          { productId: String(product._id), quantity: 2 },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(response.body.data.order.items).toHaveLength(1);
    expect(response.body.data.order.items[0].quantity).toBe(3);
    expect(response.body.data.order.pricing.subtotalMinor).toBe(3000);
  });

  it('returns PRICE_CHANGED when the client total no longer matches', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });
    const key = randomUUID();

    const stale = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 1 }],
        expectedTotalMinor: 9999,
      }),
    });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
    expect(stale.body.error.details.pricing.totalMinor).toBe(1679);

    // Nothing was reserved and the key was released, so a corrected retry with
    // the SAME key works rather than being rejected as a reuse.
    expect(await counters(product._id)).toEqual({ onHand: 5, reserved: 0, available: 5 });
    const corrected = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 1 }],
        expectedTotalMinor: 1679,
      }),
    });
    expect(corrected.status).toBe(201);
  });
});

describe('POST /api/checkout — stock', () => {
  it('rejects an out-of-stock request with per-item availability', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ onHand: 1, priceMinor: 1000 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 3 }] }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OUT_OF_STOCK');
    expect(response.body.error.retryable).toBe(true);
    expect(response.body.error.details.items).toEqual([
      expect.objectContaining({ requested: 3, available: 1, reason: 'insufficient_stock' }),
    ]);

    expect(await counters(product._id)).toEqual({ onHand: 1, reserved: 0, available: 1 });
    expect(await Order.countDocuments()).toBe(0);
  });

  it('rejects an unknown or inactive product', async () => {
    const { auth } = await createCustomer();
    const inactive = await createProduct({ onHand: 5, isActive: false });

    const unknown = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: 'b'.repeat(24), quantity: 1 }] }),
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('PRODUCT_NOT_FOUND');

    const dead = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(inactive._id), quantity: 1 }] }),
    });
    expect(dead.status).toBe(404);
  });

  /**
   * The F2 property, tested deterministically rather than raced: `reserve`
   * throws on the first unavailable line, so the transaction aborts and every
   * reservation it already made is rolled back. A 3-item cart whose last item is
   * out of stock reserves precisely zero units.
   *
   * (The HTTP path usually fast-fails this before opening a transaction, which is
   * why the guarantee is asserted here at the transaction level.)
   */
  it('reserves nothing when any line of a multi-item cart fails', async () => {
    const a = await createProduct({ onHand: 10, priceMinor: 100 });
    const b = await createProduct({ onHand: 10, priceMinor: 100 });
    const empty = await createProduct({ onHand: 0, priceMinor: 100 });

    await expect(
      withTransaction(async (session) => {
        await reserve([line(a, 2), line(b, 2), line(empty, 1)], session);
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect(await counters(a._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
    expect(await counters(b._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
    expect(await counters(empty._id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  it('reports every short line item at once on a multi-item cart', async () => {
    const { auth } = await createCustomer();
    const ok = await createProduct({ onHand: 10, priceMinor: 100 });
    const shortA = await createProduct({ onHand: 1, priceMinor: 100 });
    const shortB = await createProduct({ onHand: 0, priceMinor: 100 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [
          { productId: String(ok._id), quantity: 1 },
          { productId: String(shortA._id), quantity: 2 },
          { productId: String(shortB._id), quantity: 1 },
        ],
      }),
    });

    expect(response.status).toBe(409);
    const reported = response.body.error.details.items.map((i) => i.productId);
    expect(reported).toHaveLength(2);
    expect(reported).toContain(String(shortA._id));
    expect(reported).toContain(String(shortB._id));
    expect(await Order.countDocuments()).toBe(0);
  });
});

describe('POST /api/checkout — authorisation and input', () => {
  it('requires authentication', async () => {
    const product = await createProduct();
    const response = await http()
      .post('/api/checkout')
      .set('Idempotency-Key', randomUUID())
      .send(checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }));
    expect(response.status).toBe(401);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct();

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: {
        ...checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
        totalMinor: 1, // an attempted client-side price
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed idempotency key', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct();

    const response = await checkoutRequest({
      auth,
      key: 'bad key with spaces',
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    expect(response.status).toBe(400);
  });
});

describe('GET /api/orders', () => {
  it('never exposes another customer order', async () => {
    const owner = await createCustomer();
    const stranger = await createCustomer();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });

    const created = await checkoutRequest({
      auth: owner.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    const orderId = created.body.data.order.id;

    const denied = await http()
      .get(`/api/orders/${orderId}`)
      .set('Authorization', stranger.auth);
    expect(denied.status).toBe(403);

    const allowed = await http()
      .get(`/api/orders/${orderId}`)
      .set('Authorization', owner.auth);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.order.id).toBe(orderId);

    // The stranger's own list is empty: ownership is enforced by query, not just
    // by the single-order route.
    const list = await http().get('/api/orders').set('Authorization', stranger.auth);
    expect(list.body.data.items).toHaveLength(0);
  });
});
