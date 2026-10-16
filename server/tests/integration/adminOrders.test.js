import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Customer, IDEMPOTENCY_STATUS, PAYMENT_STATUS } from '../../src/models/index.js';
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

/** A well-formed id that belongs to nothing. */
const absentId = 'a'.repeat(24);

describe('admin order queue', () => {
  it('is admin-only', async () => {
    const customer = await createCustomer();

    const anonymous = await http().get('/api/admin/orders');
    expect(anonymous.status).toBe(401);

    const forbidden = await http().get('/api/admin/orders').set('Authorization', customer.auth);
    expect(forbidden.status).toBe(403);

    // The list is not the only door into the queue; the detail read is guarded too.
    const forbiddenDetail = await http()
      .get(`/api/admin/orders/${absentId}`)
      .set('Authorization', customer.auth);
    expect(forbiddenDetail.status).toBe(403);
  });

  it('lists an order with the customer who placed it', async () => {
    const admin = await createAdmin();
    const { customer, auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 20 });

    const created = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }),
    });
    expect(created.status).toBe(201);
    const order = created.body.data.order;

    const response = await http().get('/api/admin/orders').set('Authorization', admin.auth);
    expect(response.status).toBe(200);

    const page = response.body.data;
    expect(page.total).toBe(1);
    expect(page.totalPages).toBe(1);
    expect(page.items).toHaveLength(1);

    const [row] = page.items;
    expect(row.orderNumber).toBe(order.orderNumber);
    expect(row.status).toBe(ORDER_STATUS.PAID);
    expect(row.pricing.totalMinor).toBe(order.pricing.totalMinor);
    expect(row.items.map((item) => item.sku)).toEqual([product.sku]);

    // A queue is only useful if it says WHO is waiting, not just that someone is.
    expect(row.customer).toEqual({
      id: String(customer._id),
      email: customer.email,
      name: customer.name,
      role: 'customer',
    });
  });

  it('filters by status, and rejects a status that is not real', async () => {
    const admin = await createAdmin();
    const paidBuyer = await createCustomer();
    const declinedBuyer = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 20 });

    const paid = await checkoutRequest({
      auth: paidBuyer.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    expect(paid.status).toBe(201);

    const declined = await checkoutRequest({
      auth: declinedBuyer.auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 1 }],
        token: 'tok_decline',
      }),
    });
    expect(declined.status).toBe(402);

    const paidOnly = await http()
      .get('/api/admin/orders?status=paid')
      .set('Authorization', admin.auth);
    expect(paidOnly.body.data.total).toBe(1);
    expect(paidOnly.body.data.items[0].status).toBe(ORDER_STATUS.PAID);

    const failedOnly = await http()
      .get('/api/admin/orders?status=payment_failed')
      .set('Authorization', admin.auth);
    expect(failedOnly.body.data.total).toBe(1);
    expect(failedOnly.body.data.items[0].customer.id).toBe(String(declinedBuyer.customer._id));

    const noneHolding = await http()
      .get('/api/admin/orders?status=pending_payment')
      .set('Authorization', admin.auth);
    expect(noneHolding.body.data.total).toBe(0);

    // A typo must fail loudly rather than quietly returning an empty page.
    const typo = await http()
      .get('/api/admin/orders?status=paid_d')
      .set('Authorization', admin.auth);
    expect(typo.status).toBe(400);
    expect(typo.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('searches by order number and by customer', async () => {
    const admin = await createAdmin();
    const alice = await createCustomer();
    const bob = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 20 });

    const aliceOrder = await checkoutRequest({
      auth: alice.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    await checkoutRequest({
      auth: bob.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    const search = (term) =>
      http()
        .get(`/api/admin/orders?q=${encodeURIComponent(term)}`)
        .set('Authorization', admin.auth);

    const byNumber = await search(aliceOrder.body.data.order.orderNumber);
    expect(byNumber.body.data.total).toBe(1);
    expect(byNumber.body.data.items[0].customer.email).toBe(alice.customer.email);

    const byEmail = await search(bob.customer.email.toUpperCase());
    expect(byEmail.body.data.total).toBe(1);
    expect(byEmail.body.data.items[0].customer.id).toBe(String(bob.customer._id));

    const noMatch = await search('no-such-order-anywhere');
    expect(noMatch.body.data.total).toBe(0);

    // A regex metacharacter must be treated as a literal: unescaped, this is a
    // SyntaxError inside the RegExp engine and a 500 rather than an empty page.
    const metacharacter = await search('(');
    expect(metacharacter.status).toBe(200);
    expect(metacharacter.body.data.total).toBe(0);
  });

  it('paginates without repeating or dropping an order', async () => {
    const admin = await createAdmin();
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 500, onHand: 50 });

    for (let i = 0; i < 3; i += 1) {
      const created = await checkoutRequest({
        auth,
        key: randomUUID(),
        body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
      });
      expect(created.status).toBe(201);
    }

    const first = await http()
      .get('/api/admin/orders?page=1&pageSize=2')
      .set('Authorization', admin.auth);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.total).toBe(3);
    expect(first.body.data.totalPages).toBe(2);

    const second = await http()
      .get('/api/admin/orders?page=2&pageSize=2')
      .set('Authorization', admin.auth);
    expect(second.body.data.items).toHaveLength(1);

    const ids = [...first.body.data.items, ...second.body.data.items].map((o) => o.id);
    expect(new Set(ids).size).toBe(3);

    // Beyond the cap is a validation error, not a thousand-row response.
    const tooBig = await http()
      .get('/api/admin/orders?pageSize=101')
      .set('Authorization', admin.auth);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.code).toBe('VALIDATION_ERROR');

    // An unknown key is rejected rather than silently ignored.
    const unknownKey = await http()
      .get('/api/admin/orders?limit=5')
      .set('Authorization', admin.auth);
    expect(unknownKey.status).toBe(400);
  });

  it('keeps the row when the customer behind it is gone', async () => {
    const admin = await createAdmin();
    const { customer, auth } = await createCustomer();
    const product = await createProduct({ onHand: 3 });

    await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    await Customer.deleteOne({ _id: customer._id });

    const response = await http().get('/api/admin/orders').set('Authorization', admin.auth);
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    // A dangling reference must not blank out the operations view.
    expect(response.body.data.items[0].customer).toBeNull();
  });
});

describe('admin order detail', () => {
  it('returns the order with its charge attempt, claim and timeline', async () => {
    const admin = await createAdmin();
    const { customer, auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 2500, onHand: 10 });
    const key = randomUUID();

    const created = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }),
    });
    const orderId = created.body.data.order.id;

    const response = await http()
      .get(`/api/admin/orders/${orderId}`)
      .set('Authorization', admin.auth);
    expect(response.status).toBe(200);

    const { order, paymentAttempts, idempotencyClaims } = response.body.data;
    expect(order.id).toBe(orderId);
    expect(order.customer.id).toBe(String(customer._id));
    expect(order.idempotencyKey).toBe(key);
    expect(order.statusHistory.length).toBeGreaterThanOrEqual(1);

    expect(paymentAttempts).toHaveLength(1);
    expect(paymentAttempts[0].status).toBe(PAYMENT_STATUS.SUCCEEDED);
    expect(paymentAttempts[0].amountMinor).toBe(order.pricing.totalMinor);
    expect(paymentAttempts[0].providerRef).toBeTruthy();

    // The claim is what makes a retried checkout auditable after the fact.
    expect(idempotencyClaims).toHaveLength(1);
    expect(idempotencyClaims[0].key).toBe(key);
    expect(idempotencyClaims[0].status).toBe(IDEMPOTENCY_STATUS.COMPLETED);
    expect(idempotencyClaims[0].responseStatusCode).toBe(201);
  });

  it('404s an unknown order and 400s a malformed id', async () => {
    const admin = await createAdmin();

    const missing = await http()
      .get(`/api/admin/orders/${absentId}`)
      .set('Authorization', admin.auth);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ORDER_NOT_FOUND');

    const malformed = await http()
      .get('/api/admin/orders/not-an-id')
      .set('Authorization', admin.auth);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('fulfills a paid order, and rejects fulfilling an unpaid order', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const created = await checkoutRequest({
      auth: customer.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }),
    });
    expect(created.status).toBe(201);
    const orderId = created.body.data.order.id;

    // Fulfill the paid order
    const fulfilled = await http()
      .post(`/api/admin/orders/${orderId}/fulfill`)
      .set('Authorization', admin.auth);
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.data.order.status).toBe(ORDER_STATUS.FULFILLED);

    // Cannot fulfill twice (terminal state)
    const second = await http()
      .post(`/api/admin/orders/${orderId}/fulfill`)
      .set('Authorization', admin.auth);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ORDER_NOT_PAID');
  });

  it('allows a customer to cancel their own pending order, releasing inventory', async () => {
    const customer = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const order = await createPendingOrder({
      customerId: customer.id,
      product,
      quantity: 3,
    });
    expect((await counters(product._id)).reserved).toBe(3);

    const cancelled = await http()
      .post(`/api/orders/${order._id}/cancel`)
      .set('Authorization', customer.auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.order.status).toBe(ORDER_STATUS.CANCELLED);

    // Inventory hold was released
    const after = await counters(product._id);
    expect(after.reserved).toBe(0);
    expect(after.available).toBe(10);
  });

  it('forbids a customer from cancelling another customer\'s pending order', async () => {
    const owner = await createCustomer();
    const attacker = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const order = await createPendingOrder({
      customerId: owner.id,
      product,
      quantity: 1,
    });

    const forbidden = await http()
      .post(`/api/orders/${order._id}/cancel`)
      .set('Authorization', attacker.auth);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });
});
