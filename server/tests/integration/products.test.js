import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Product } from '../../src/models/index.js';
import {
  checkoutBody,
  checkoutRequest,
  counters,
  createAdmin,
  createCustomer,
  createPendingOrder,
  createProduct,
  http,
} from '../helpers/factories.js';

describe('GET /api/products', () => {
  it('lists only active products by default, with onHand hidden', async () => {
    await createProduct({ name: 'Alpha Widget', sku: 'A1', onHand: 5, priceMinor: 100 });
    await createProduct({ name: 'Hidden Widget', sku: 'H1', onHand: 3, isActive: false });

    const response = await http().get('/api/products');
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].sku).toBe('A1');
    // A shopper has no business knowing physical stock, only what is buyable.
    expect(response.body.data.items[0]).not.toHaveProperty('onHand');
    expect(response.body.data.items[0].available).toBe(5);
  });

  it('includes inactive products on request', async () => {
    await createProduct({ name: 'Alpha', sku: 'A1', onHand: 1 });
    await createProduct({ name: 'Hidden', sku: 'H1', onHand: 1, isActive: false });

    const response = await http().get('/api/products?includeInactive=true');
    expect(response.body.data.items).toHaveLength(2);
  });

  it('filters to in-stock products', async () => {
    await createProduct({ name: 'Plenty', sku: 'P1', onHand: 4 });
    await createProduct({ name: 'None', sku: 'N1', onHand: 0 });

    const response = await http().get('/api/products?inStock=true');
    expect(response.body.data.items.map((p) => p.sku)).toEqual(['P1']);
  });

  it('searches by name and sku', async () => {
    await createProduct({ name: 'Merino Hoodie', sku: 'HOOD-1', onHand: 2 });
    await createProduct({ name: 'Cotton Cap', sku: 'CAP-1', onHand: 2 });

    const byName = await http().get('/api/products?q=hood');
    expect(byName.body.data.items.map((p) => p.sku)).toEqual(['HOOD-1']);

    const bySku = await http().get('/api/products?q=CAP-1');
    expect(bySku.body.data.items.map((p) => p.sku)).toEqual(['CAP-1']);
  });

  it('treats a regex metacharacter as a literal, not a pattern', async () => {
    await createProduct({ name: 'Special (edition)', sku: 'SP-1', onHand: 1 });
    await createProduct({ name: 'Ordinary', sku: 'OR-1', onHand: 1 });

    const response = await http().get('/api/products?q=(edition)');
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].sku).toBe('SP-1');
  });

  it('paginates', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createProduct({ name: `Item ${i}`, sku: `PG-${i}`, onHand: 1 });
    }
    const page1 = await http().get('/api/products?page=1&pageSize=2');
    const page3 = await http().get('/api/products?page=3&pageSize=2');

    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.total).toBe(5);
    expect(page1.body.data.totalPages).toBe(3);
    expect(page3.body.data.items).toHaveLength(1);
  });
});

describe('GET /api/products/:id', () => {
  it('404s for an unknown id and for an inactive product', async () => {
    const inactive = await createProduct({ onHand: 1, isActive: false });

    expect((await http().get(`/api/products/${'f'.repeat(24)}`)).status).toBe(404);
    expect((await http().get(`/api/products/${inactive._id}`)).status).toBe(404);
  });

  it('rejects a malformed id with 400, not a crash', async () => {
    const response = await http().get('/api/products/not-an-id');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('product administration', () => {
  it('requires an admin to create a product', async () => {
    const customer = await createCustomer();
    const body = { sku: 'NEW-1', name: 'New', priceMinor: 500, onHand: 3 };

    const anonymous = await http().post('/api/products').send(body);
    expect(anonymous.status).toBe(401);

    const forbidden = await http()
      .post('/api/products')
      .set('Authorization', customer.auth)
      .send(body);
    expect(forbidden.status).toBe(403);
  });

  it('creates a product with its units already available', async () => {
    const admin = await createAdmin();
    const response = await http()
      .post('/api/products')
      .set('Authorization', admin.auth)
      .send({ sku: 'NEW-1', name: 'New Thing', priceMinor: 500, onHand: 7 });

    expect(response.status).toBe(201);
    expect(response.body.data.product.available).toBe(7);
  });

  it('rejects a duplicate sku through the unique index', async () => {
    const admin = await createAdmin();
    await createProduct({ sku: 'DUPE-1' });

    const response = await http()
      .post('/api/products')
      .set('Authorization', admin.auth)
      .send({ sku: 'DUPE-1', name: 'Another', priceMinor: 100 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_KEY');
  });

  it('never lets an update set stock counters', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });

    const rejected = await http()
      .patch(`/api/products/${product._id}`)
      .set('Authorization', admin.auth)
      .send({ available: 999 });
    expect(rejected.status).toBe(400);

    const accepted = await http()
      .patch(`/api/products/${product._id}`)
      .set('Authorization', admin.auth)
      .send({ priceMinor: 1200, name: 'Renamed' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.product.priceMinor).toBe(1200);
    expect(await counters(product._id)).toEqual({ onHand: 5, reserved: 0, available: 5 });

    // The new price is what the next checkout is charged.
    const buyer = await createCustomer();
    const order = await checkoutRequest({
      auth: buyer.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    expect(order.body.data.order.pricing.subtotalMinor).toBe(1200);
  });

  it('restocks while preserving the invariant', async () => {
    const admin = await createAdmin();
    const buyer = await createCustomer();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });

    // Hold 2 units in a live reservation, then restock underneath them.
    await createPendingOrder({ customerId: buyer.id, product, quantity: 2 });

    const before = await counters(product._id);
    expect(before).toEqual({ onHand: 5, reserved: 2, available: 3 });

    const restocked = await http()
      .post(`/api/products/${product._id}/stock`)
      .set('Authorization', admin.auth)
      .send({ units: 10 });

    expect(restocked.status).toBe(200);
    const after = await counters(product._id);
    expect(after).toEqual({ onHand: 15, reserved: 2, available: 13 });
    expect(after.available).toBe(after.onHand - after.reserved);
  });

  it('rejects a nonsensical restock figure', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ onHand: 1 });

    for (const units of [0, -5, 1.5]) {
      const response = await http()
        .post(`/api/products/${product._id}/stock`)
        .set('Authorization', admin.auth)
        .send({ units });
      expect(response.status).toBe(400);
    }
  });

  /**
   * Phase 1 acceptance criterion (plan §3.4).
   *
   * `bsonType: ['int','long']` in the collection validator only holds if money
   * and stock actually round-trip as integers. The Node BSON serializer does
   * that for integral values, but relying on serializer behaviour without
   * asserting it is how a fractional price becomes a rejected write in
   * production instead of a failing test here.
   */
  describe('integer storage', () => {
    it('stores prices and counters as BSON integers, never doubles', async () => {
      const product = await createProduct({ onHand: 7, priceMinor: 1299 });

      const asDouble = await Product.collection.countDocuments({
        _id: product._id,
        $or: [
          { priceMinor: { $type: 'double' } },
          { onHand: { $type: 'double' } },
          { reserved: { $type: 'double' } },
          { available: { $type: 'double' } },
        ],
      });
      expect(asDouble).toBe(0);

      const raw = await Product.collection.findOne(
        { _id: product._id },
        { projection: { priceMinor: 1, onHand: 1 } },
      );
      expect(raw.priceMinor).toBe(1299);
      expect(Number.isInteger(raw.priceMinor)).toBe(true);
      expect(Number.isInteger(raw.onHand)).toBe(true);
    });

    it('lets the validator reject a fractional value, even a harmless-looking one', async () => {
      const product = await createProduct({ onHand: 4, priceMinor: 1000 });

      // 12.5 is non-negative, so `minimum: 0` has nothing to say about it; it is
      // the bsonType constraint that refuses to store it as a double. This is
      // exactly the stray-fractional-value case §3.4 is written to catch, and it
      // proves the validator is enforced on updateOne and not only on save().
      await expect(
        Product.collection.updateOne({ _id: product._id }, { $set: { priceMinor: 12.5 } }),
      ).rejects.toThrow(/validation/i);

      expect(await counters(product._id)).toEqual({ onHand: 4, reserved: 0, available: 4 });
    });
  });
});
