import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Order, PaymentAttempt, PAYMENT_STATUS, Product } from '../../src/models/index.js';
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

describe('Concurrency Lab', () => {
  it('requires an admin', async () => {
    const customer = await createCustomer();
    const product = await createProduct({ onHand: 5 });

    const anonymous = await http()
      .post('/api/admin/concurrency-lab')
      .send({ productId: String(product._id), buyers: 5 });
    expect(anonymous.status).toBe(401);

    const forbidden = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', customer.auth)
      .send({ productId: String(product._id), buyers: 5 });
    expect(forbidden.status).toBe(403);
  });

  it('sells exactly the available stock and reports no oversell', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const response = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: String(product._id), buyers: 120, quantityPerBuyer: 1 });

    expect(response.status).toBe(200);
    const lab = response.body.data;

    expect(lab.tally.confirmed).toBe(10);
    expect(lab.tally.outOfStock).toBe(110);
    expect(lab.tally.other).toBe(0);
    expect(lab.expectedConfirmed).toBe(10);
    expect(lab.soldQuantity).toBe(10);
    expect(lab.oversold).toBe(false);
    expect(lab.invariantsHeld).toBe(true);
    expect(lab.finalCounters).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  /**
   * The regression that a real bug produced: an earlier purchase of the same
   * product was counted toward the lab's total, so 11 units "sold" against 10
   * available and the lab announced OVERSOLD — a false alarm that makes the
   * guarantee look broken exactly when it is holding. The count must be scoped
   * to the buyers the run created.
   */
  it('does not count sales made before the run', async () => {
    const admin = await createAdmin();
    const earlierBuyer = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    // A normal earlier purchase: 1 unit, leaving 9 available.
    const earlier = await checkoutRequest({
      auth: earlierBuyer.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    expect(earlier.status).toBe(201);
    expect((await counters(product._id)).available).toBe(9);

    const response = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: String(product._id), buyers: 60, quantityPerBuyer: 1 });

    const lab = response.body.data;
    expect(lab.initialAvailable).toBe(9);
    expect(lab.tally.confirmed).toBe(9);
    expect(lab.soldQuantity).toBe(9); // NOT 10 — the earlier sale is excluded
    expect(lab.oversold).toBe(false);
    expect(lab.invariantsHeld).toBe(true);
  });

  it('respects multi-unit carts when computing expected confirmations', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ priceMinor: 1000, onHand: 20 });

    const response = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: String(product._id), buyers: 40, quantityPerBuyer: 3 });

    const lab = response.body.data;
    expect(lab.expectedConfirmed).toBe(6); // floor(20 / 3)
    expect(lab.tally.confirmed).toBe(6);
    expect(lab.soldQuantity).toBe(18);
    expect(lab.oversold).toBe(false);
    expect(lab.finalCounters).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('supports fifo policy and computes fairness metrics with confirmed buyer indices', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });

    const response = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: String(product._id), buyers: 20, quantityPerBuyer: 1, policy: 'fifo' });

    expect(response.status).toBe(200);
    const lab = response.body.data;
    expect(lab.tally.confirmed).toBe(5);
    expect(lab.oversold).toBe(false);
    expect(lab.invariantsHeld).toBe(true);
    expect(lab.fairness).toBeDefined();
    expect(lab.fairness.policy).toBe('fifo');
    expect(typeof lab.fairness.gini).toBe('number');
    expect(typeof lab.fairness.winSpread.range).toBe('number');
    expect(Array.isArray(lab.fairness.confirmedBuyerIndices)).toBe(true);
    expect(lab.fairness.confirmedBuyerIndices.length).toBe(5);
  });

  it('supports lottery policy and prevents overselling', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ priceMinor: 1000, onHand: 3 });

    const response = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: String(product._id), buyers: 15, quantityPerBuyer: 1, policy: 'lottery' });

    expect(response.status).toBe(200);
    const lab = response.body.data;
    expect(lab.tally.confirmed).toBe(3);
    expect(lab.oversold).toBe(false);
    expect(lab.invariantsHeld).toBe(true);
    expect(lab.fairness.policy).toBe('lottery');
    expect(lab.fairness.confirmedBuyerIndices.length).toBe(3);
  });

  it('validates its input', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ onHand: 5 });

    const tooMany = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: String(product._id), buyers: 100000 });
    expect(tooMany.status).toBe(400);

    const unknownField = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: String(product._id), buyers: 5, token: 'tok_success' });
    expect(unknownField.status).toBe(400);

    const missing = await http()
      .post('/api/admin/concurrency-lab')
      .set('Authorization', admin.auth)
      .send({ productId: 'b'.repeat(24), buyers: 5 });
    expect(missing.status).toBe(404);
  });
});

describe('operations endpoints', () => {
  it('sweeps expired reservations on demand', async () => {
    const admin = await createAdmin();
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 6, priceMinor: 1000 });
    await createPendingOrder({
      customerId: id,
      product,
      quantity: 2,
      reservationTtlMs: -5000,
      paymentLeaseMs: -5000,
    });

    const response = await http()
      .post('/api/admin/inventory/sweep')
      .set('Authorization', admin.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.released).toBe(1);
    expect(response.body.data.invariants).toEqual([]);
    expect(await counters(product._id)).toEqual({ onHand: 6, reserved: 0, available: 6 });
  });

  it('reports a reconciliation dashboard that includes reserved stock', async () => {
    const admin = await createAdmin();
    const buyer = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });

    await createPendingOrder({ customerId: buyer.id, product, quantity: 4 });

    const response = await http()
      .get('/api/admin/inventory/reconcile')
      .set('Authorization', admin.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.consistent).toBe(true);
    const row = response.body.data.inventory.find((p) => p.sku === product.sku);
    expect(row).toMatchObject({ onHand: 10, reserved: 4, available: 6 });
    expect(response.body.data.ordersByStatus[ORDER_STATUS.PENDING_PAYMENT]).toBe(1);
  });

  it('marks a refund obligation as refunded, once', async () => {
    const admin = await createAdmin();
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });

    const paid = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    const orderId = paid.body.data.order.id;

    const first = await http()
      .post(`/api/admin/payments/${orderId}/refund`)
      .set('Authorization', admin.auth);
    expect(first.status).toBe(200);
    expect(first.body.data.refund.orderId).toBe(orderId);

    const attempt = await PaymentAttempt.findOne({ idempotencyKey: String(orderId) });
    expect(attempt.status).toBe(PAYMENT_STATUS.REFUNDED);

    const updatedOrder = await Order.findById(orderId);
    expect(updatedOrder.payment.status).toBe('refunded');
    expect(updatedOrder.statusHistory.some((h) => h.reason === 'payment_refunded')).toBe(true);

    // Idempotent: a second refund does not issue another one.
    const second = await http()
      .post(`/api/admin/payments/${orderId}/refund`)
      .set('Authorization', admin.auth);
    expect(second.body.data.refund.alreadyRefunded).toBe(true);
  });

  it('refunds an order and restocks units atomically when restock=true', async () => {
    const admin = await createAdmin();
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });

    const paid = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }),
    });
    const orderId = paid.body.data.order.id;

    let p = await Product.findById(product._id);
    expect(p.onHand).toBe(3);
    expect(p.available).toBe(3);

    const refundRes = await http()
      .post(`/api/admin/payments/${orderId}/refund?restock=true`)
      .set('Authorization', admin.auth);
    expect(refundRes.status).toBe(200);
    expect(refundRes.body.data.restocked).toBe(true);

    p = await Product.findById(product._id);
    expect(p.onHand).toBe(5);
    expect(p.available).toBe(5);

    const updatedOrder = await Order.findById(orderId);
    expect(updatedOrder.payment.status).toBe('refunded');
    expect(
      updatedOrder.statusHistory.some((h) => h.reason === 'payment_refunded_and_restocked'),
    ).toBe(true);
  });

  it('simulates a mid-charge crash (chaos F5) and creates a refund obligation cleanly', async () => {
    const admin = await createAdmin();
    await createProduct({ onHand: 10, priceMinor: 1000 });

    const response = await http()
      .post('/api/admin/chaos/simulate-crash')
      .set('Authorization', admin.auth);

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.faultCaught).toContain('crash_after_charge');
    expect(data.settlementLostCas).toBe(true);
    expect(data.refundObligationRecorded).toBe(true);
    expect(data.invariantsHeld).toBe(true);

    // Clean up refund obligation by issuing the refund so the afterEach invariant check passes
    const refundRes = await http()
      .post(`/api/admin/payments/${data.orderId}/refund`)
      .set('Authorization', admin.auth);
    expect(refundRes.status).toBe(200);
  });
});

