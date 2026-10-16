import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkInvariants, getRefundObligations } from '../../src/domain/invariants.js';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Order, PaymentAttempt, PAYMENT_STATUS, Product } from '../../src/models/index.js';
import { sweepExpiredReservations } from '../../src/services/expiry.service.js';
import { settleSuccess } from '../../src/services/paymentSettlement.service.js';
import {
  checkoutBody,
  createAdmin,
  createCustomer,
  createProduct,
  http,
} from '../helpers/factories.js';

describe('Deterministic Chaos & Crash Recovery (T1.2 - Proving F5)', () => {
  it('recovers cleanly when the process crashes before the charge is attempted', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1500, onHand: 5 });
    const key = randomUUID();

    // 1. Send checkout with chaos injection right before the card is charged
    const response = await http()
      .post('/api/checkout')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .set('x-chaos-fault', 'crash_before_charge')
      .send(checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }));

    expect(response.status).toBe(500);

    // 2. The order was created in TX1 and holds reservation
    const order = await Order.findOne({ idempotencyKey: key });
    expect(order).toBeTruthy();
    expect(order.status).toBe(ORDER_STATUS.PENDING_PAYMENT);

    // Verify hold: available = 3, reserved = 2
    let p = await Product.findById(product._id);
    expect(p.available).toBe(3);
    expect(p.reserved).toBe(2);

    // 3. Fast-forward past expiry and sweep
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          reservationExpiresAt: new Date(Date.now() - 5000),
          paymentLeaseExpiresAt: new Date(Date.now() - 5000),
        },
      },
    );

    const sweepResult = await sweepExpiredReservations({ productIds: [product._id] });
    expect(sweepResult.released).toBe(1);

    // 4. Stock returned cleanly: available = 5, reserved = 0
    p = await Product.findById(product._id);
    expect(p.available).toBe(5);
    expect(p.reserved).toBe(0);

    // Invariants clean
    const problems = await checkInvariants();
    expect(problems).toHaveLength(0);
  });

  it('detects and compensates when process crashes after money was charged (F5)', async () => {
    const admin = await createAdmin();
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 2500, onHand: 4 });
    const key = randomUUID();

    // 1. Trigger checkout with crash injected immediately after external gateway succeeds
    const response = await http()
      .post('/api/checkout')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .set('x-chaos-fault', 'crash_after_charge')
      .send(checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }));

    expect(response.status).toBe(500);

    // 2. The gateway charged money: payment attempt exists and providerRef was recorded
    const order = await Order.findOne({ idempotencyKey: key });
    expect(order).toBeTruthy();
    expect(order.status).toBe(ORDER_STATUS.PENDING_PAYMENT);

    const attempt = await PaymentAttempt.findOne({ idempotencyKey: String(order._id) });
    expect(attempt).toBeTruthy();
    expect(attempt.providerRef).toBeTruthy();

    // 3. Process died, so TX2 never committed. Order reservation lapses.
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          reservationExpiresAt: new Date(Date.now() - 5000),
          paymentLeaseExpiresAt: new Date(Date.now() - 5000),
        },
      },
    );

    // Reaper sweeps expired hold, returning physical stock
    await sweepExpiredReservations({ productIds: [product._id] });
    const p = await Product.findById(product._id);
    expect(p.available).toBe(4);
    expect(p.reserved).toBe(0);

    const expiredOrder = await Order.findById(order._id);
    expect(expiredOrder.status).toBe(ORDER_STATUS.EXPIRED);

    // 4. Out-of-band settlement (via webhook / operator reconciliation) arrives
    const settlement = await settleSuccess({
      orderId: order._id,
      providerRef: attempt.providerRef,
      source: 'reconcile',
    });

    // CAS on status lost because order was expired!
    expect(settlement.lost).toBe(true);

    // 5. This orphan charge is captured as an explicit Refund Obligation
    const obligations = await getRefundObligations();
    expect(obligations.some((o) => String(o.orderId) === String(order._id))).toBe(true);

    // 6. Admin inspects and refunds via API
    const refundRes = await http()
      .post(`/api/admin/payments/${order._id}/refund`)
      .set('Authorization', admin.auth);

    expect(refundRes.status).toBe(200);

    // Invariants verified
    const problems = await checkInvariants();
    expect(problems).toHaveLength(0);
  });
});
