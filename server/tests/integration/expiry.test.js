import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { IdempotencyKey, IDEMPOTENCY_STATUS, Order } from '../../src/models/index.js';
import { sweepExpiredReservations } from '../../src/services/expiry.service.js';
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

const LAPSED = -5_000; // already in the past

describe('sweepExpiredReservations', () => {
  it('releases an expired hold and settles the order', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });
    const order = await createPendingOrder({
      customerId: id,
      product,
      quantity: 3,
      reservationTtlMs: LAPSED,
      paymentLeaseMs: LAPSED,
    });

    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 3, available: 7 });

    const result = await sweepExpiredReservations();

    expect(result.released).toBe(1);
    expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.EXPIRED);
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
  });

  it('is idempotent: a second sweep releases nothing more', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });
    await createPendingOrder({
      customerId: id,
      product,
      quantity: 3,
      reservationTtlMs: LAPSED,
      paymentLeaseMs: LAPSED,
    });

    const first = await sweepExpiredReservations();
    const second = await sweepExpiredReservations();

    expect(first.released).toBe(1);
    expect(second.released).toBe(0);
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
  });

  it('leaves an unexpired reservation alone', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });
    await createPendingOrder({
      customerId: id,
      product,
      quantity: 2,
      reservationTtlMs: 60_000,
      paymentLeaseMs: 60_000,
    });

    const result = await sweepExpiredReservations();

    expect(result.released).toBe(0);
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 2, available: 8 });
  });

  /**
   * ADR-08. An order whose reservation has nominally lapsed but whose payment
   * lease is still live may be mid-charge. Expiring it would sell the units out
   * from under a payment that is about to succeed.
   */
  it('never expires an order with a live payment lease, even past its reservation', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });
    const order = await createPendingOrder({
      customerId: id,
      product,
      quantity: 2,
      reservationTtlMs: LAPSED,
      paymentLeaseMs: 60_000,
    });

    const result = await sweepExpiredReservations();

    expect(result.released).toBe(0);
    expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.PENDING_PAYMENT);
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 2, available: 8 });
  });

  it('makes a claim left by a dead attempt retryable', async () => {
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 10, priceMinor: 1000 });
    const order = await createPendingOrder({
      customerId: id,
      product,
      quantity: 1,
      reservationTtlMs: LAPSED,
      paymentLeaseMs: LAPSED,
    });

    await IdempotencyKey.create({
      customerId: id,
      endpoint: 'POST /api/checkout',
      key: 'stranded-claim-1',
      requestHash: 'x'.repeat(64),
      status: IDEMPOTENCY_STATUS.PROCESSING,
      leaseExpiresAt: new Date(Date.now() - 1000),
      orderId: order._id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await sweepExpiredReservations();

    const claim = await IdempotencyKey.findOne({ key: 'stranded-claim-1' });
    expect(claim.status).toBe(IDEMPOTENCY_STATUS.FAILED);
  });
});

describe('lazy reclaim on the demand path (ADR-10)', () => {
  /**
   * The headline property: correctness does NOT depend on the scheduler. The
   * periodic reaper is never run here. A buyer simply tries to check out and the
   * expired hold blocking them is reclaimed on the spot.
   */
  it('recovers stock from a crashed checkout without the reaper running', async () => {
    const crashed = await createCustomer();
    const buyer = await createCustomer();
    const product = await createProduct({ onHand: 1, priceMinor: 1000 });

    // A crashed checkout: it holds the only unit and its deadlines have passed.
    const abandoned = await createPendingOrder({
      customerId: crashed.id,
      product,
      quantity: 1,
      reservationTtlMs: LAPSED,
      paymentLeaseMs: LAPSED,
    });

    expect(await counters(product._id)).toEqual({ onHand: 1, reserved: 1, available: 0 });

    // No sweep call, no timer: the checkout itself must free the stock.
    const response = await checkoutRequest({
      auth: buyer.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    expect(response.status).toBe(201);
    expect((await Order.findById(abandoned._id)).status).toBe(ORDER_STATUS.EXPIRED);
    expect(await counters(product._id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  it('still refuses when the stock is genuinely gone', async () => {
    const crashed = await createCustomer();
    const buyer = await createCustomer();
    const product = await createProduct({ onHand: 1, priceMinor: 1000 });

    await createPendingOrder({
      customerId: crashed.id,
      product,
      quantity: 1,
      reservationTtlMs: 60_000, // a LIVE hold is not reclaimable
      paymentLeaseMs: 60_000,
    });

    const response = await checkoutRequest({
      auth: buyer.auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OUT_OF_STOCK');
    expect(await counters(product._id)).toEqual({ onHand: 1, reserved: 1, available: 0 });
  });
});

describe('cancellation', () => {
  it('releases the hold when an admin cancels', async () => {
    const admin = await createAdmin();
    const { id } = await createCustomer();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });
    const order = await createPendingOrder({ customerId: id, product, quantity: 2 });

    const response = await http()
      .post(`/api/admin/orders/${order._id}/cancel`)
      .set('Authorization', admin.auth);

    expect(response.status).toBe(200);
    expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.CANCELLED);
    expect(await counters(product._id)).toEqual({ onHand: 5, reserved: 0, available: 5 });
  });

  it('refuses to cancel an order that already holds a completed sale', async () => {
    const admin = await createAdmin();
    const { auth } = await createCustomer();
    const product = await createProduct({ onHand: 5, priceMinor: 1000 });

    const paid = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });
    const orderId = paid.body.data.order.id;

    const response = await http()
      .post(`/api/admin/orders/${orderId}/cancel`)
      .set('Authorization', admin.auth);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ORDER_NOT_PENDING');
    expect(await counters(product._id)).toEqual({ onHand: 4, reserved: 0, available: 4 });
  });
});
