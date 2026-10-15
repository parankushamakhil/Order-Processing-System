import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Order } from '../../src/models/index.js';
import {
  checkoutBody,
  checkoutRequest,
  counters,
  createBuyers,
  createProduct,
} from '../helpers/factories.js';
import { expectInvariants } from '../helpers/setup.js';

async function soldQuantity(productId) {
  const rows = await Order.aggregate([
    { $match: { status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.FULFILLED] } } },
    { $unwind: '$items' },
    { $match: { 'items.productId': productId } },
    { $group: { _id: null, quantity: { $sum: '$items.quantity' } } },
  ]);
  return rows[0]?.quantity ?? 0;
}

describe('no overselling under contention', () => {
  /**
   * The headline test.
   *
   * 200 buyers race for 10 units. The assertion that actually matters is not
   * "10 requests returned 201" — it is that the quantity RECORDED AGAINST
   * INVENTORY equals the stock that existed. That is what catches a success that
   * quietly reserved nothing.
   */
  it('sells exactly the stock: 200 concurrent buyers, 10 units', async () => {
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const buyers = await createBuyers(200);

    const responses = await Promise.all(
      buyers.map((buyer) =>
        checkoutRequest({
          auth: buyer.auth,
          key: randomUUID(),
          body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
        }),
      ),
    );

    const confirmed = responses.filter((r) => r.status === 201);
    const rejected = responses.filter(
      (r) => r.status === 409 && r.body.error.code === 'OUT_OF_STOCK',
    );

    expect(confirmed).toHaveLength(10);
    expect(rejected).toHaveLength(190);
    expect(confirmed.length + rejected.length).toBe(200);

    // The invariant that matters: stock consumed == stock that existed.
    expect(await soldQuantity(product._id)).toBe(10);

    const final = await counters(product._id);
    expect(final).toEqual({ onHand: 0, reserved: 0, available: 0 });
    expect(final.available).toBe(final.onHand - final.reserved);

    expect(await Order.countDocuments()).toBe(10);
    await expectInvariants();
  });

  it('holds the line for a single unit against 100 buyers', async () => {
    const product = await createProduct({ priceMinor: 5000, onHand: 1 });
    const buyers = await createBuyers(100);

    const responses = await Promise.all(
      buyers.map((buyer) =>
        checkoutRequest({
          auth: buyer.auth,
          key: randomUUID(),
          body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
        }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await soldQuantity(product._id)).toBe(1);
    expect(await counters(product._id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  /**
   * Multi-item carts under contention. Every buyer wants one of A AND one of B,
   * and each has 5 units, so exactly 5 can succeed. This is the test that would
   * fail if reservations of different products were not atomic: a partial
   * commitment would let more than 5 buyers through on one of the products.
   */
  it('is atomic across products in one cart: 60 buyers, 5 of each', async () => {
    const a = await createProduct({ priceMinor: 1000, onHand: 5, sku: 'MULTI-A' });
    const b = await createProduct({ priceMinor: 1000, onHand: 5, sku: 'MULTI-B' });
    const buyers = await createBuyers(60);

    const responses = await Promise.all(
      buyers.map((buyer) =>
        checkoutRequest({
          auth: buyer.auth,
          key: randomUUID(),
          body: checkoutBody({
            items: [
              { productId: String(a._id), quantity: 1 },
              { productId: String(b._id), quantity: 1 },
            ],
          }),
        }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(5);

    expect(await soldQuantity(a._id)).toBe(5);
    expect(await soldQuantity(b._id)).toBe(5);
    expect(await counters(a._id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    expect(await counters(b._id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    await expectInvariants();
  });

  it('never oversells when buyers take multiple units each', async () => {
    const product = await createProduct({ priceMinor: 1000, onHand: 20 });
    const buyers = await createBuyers(50);

    const responses = await Promise.all(
      buyers.map((buyer) =>
        checkoutRequest({
          auth: buyer.auth,
          key: randomUUID(),
          body: checkoutBody({ items: [{ productId: String(product._id), quantity: 3 }] }),
        }),
      ),
    );

    // 20 units / 3 per order = 6 whole orders, with 2 units left unsold.
    expect(responses.filter((r) => r.status === 201)).toHaveLength(6);
    expect(await soldQuantity(product._id)).toBe(18);

    const final = await counters(product._id);
    expect(final).toEqual({ onHand: 2, reserved: 0, available: 2 });

    // The two leftovers are still genuinely buyable.
    const [buyer] = await createBuyers(1);
    const last = await checkoutRequest({
      auth: buyer.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }),
    });
    expect(last.status).toBe(201);
    expect(await counters(product._id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });
});
