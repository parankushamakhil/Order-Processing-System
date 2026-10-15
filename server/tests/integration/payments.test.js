import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Order, PaymentAttempt, PAYMENT_STATUS } from '../../src/models/index.js';
import { getGateway } from '../../src/services/payments/index.js';
import { sweepExpiredReservations } from '../../src/services/expiry.service.js';
import {
  checkoutBody,
  checkoutRequest,
  counters,
  createAdmin,
  createCustomer,
  createProduct,
  http,
  postWebhook,
  webhookPayload,
  withConfig,
} from '../helpers/factories.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attemptFor(orderId) {
  return PaymentAttempt.findOne({ idempotencyKey: String(orderId) }).lean();
}

describe('payment decline and provider failure', () => {
  it('releases the reservation when the card is declined', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 3 }],
        token: 'tok_decline',
      }),
    });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('PAYMENT_DECLINED');

    const order = await Order.findById(response.body.error.details.orderId);
    expect(order.status).toBe(ORDER_STATUS.PAYMENT_FAILED);
    expect(order.payment.status).toBe(PAYMENT_STATUS.DECLINED);
    expect(order.paymentLeaseExpiresAt).toBeNull();

    // The hold went straight back on sale.
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
    expect((await attemptFor(order._id)).status).toBe(PAYMENT_STATUS.DECLINED);
  });

  it('treats a provider outage as a failed payment, not a hang', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const response = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 2 }],
        token: 'tok_error',
      }),
    });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('PAYMENT_FAILED');
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
  });
});

describe('ambiguous payment outcome', () => {
  it('answers 202 and leaves the hold in place when the gateway goes silent', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();

    const response = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 2 }],
        token: 'tok_timeout',
      }),
    });

    expect(response.status).toBe(202);
    expect(response.body.data.pending).toBe(true);
    expect(response.body.data.pollUrl).toMatch(/^\/api\/orders\//);

    const orderId = response.body.data.order.id;
    const order = await Order.findById(orderId);
    expect(order.status).toBe(ORDER_STATUS.PENDING_PAYMENT);
    // The lease was cleared, handing the order back to the reservation deadline
    // so a lost answer cannot pin stock forever.
    expect(order.paymentLeaseExpiresAt).toBeNull();

    // Still held, not sold.
    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 2, available: 8 });
    expect((await attemptFor(orderId)).status).toBe(PAYMENT_STATUS.PENDING);
  });

  it('settles the order when the provider later reports success', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();

    const started = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 2 }],
        token: 'tok_timeout',
      }),
    });
    const orderId = started.body.data.order.id;

    const pending = getGateway().resolvePending({ orderId });
    expect(pending).toBeTruthy();

    const webhook = await postWebhook(
      webhookPayload({ orderId, providerRef: pending.providerRef, status: 'succeeded' }),
    );
    expect(webhook.status).toBe(201);

    const order = await Order.findById(orderId);
    expect(order.status).toBe(ORDER_STATUS.PAID);
    expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });
    expect((await attemptFor(orderId)).status).toBe(PAYMENT_STATUS.SUCCEEDED);

    // ADR-09: replaying the checkout reflects CURRENT state (201, not a stale 202).
    const replay = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }),
    });
    expect(replay.status).toBe(201);
    expect(replay.body.data.order.status).toBe(ORDER_STATUS.PAID);
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  it('ignores a duplicated success webhook for an order that is already paid', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();

    const started = await checkoutRequest({
      auth,
      key,
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 2 }],
        token: 'tok_timeout',
      }),
    });
    const orderId = started.body.data.order.id;
    const pending = getGateway().resolvePending({ orderId });

    const first = await postWebhook(
      webhookPayload({ orderId, providerRef: pending.providerRef, status: 'succeeded' }),
    );
    const replay = await postWebhook(
      webhookPayload({ orderId, providerRef: pending.providerRef, status: 'succeeded' }),
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);

    // Captured exactly once, and — critically — NO refund was invented for a
    // perfectly good order.
    expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });
    expect((await attemptFor(orderId)).status).toBe(PAYMENT_STATUS.SUCCEEDED);

    const admin = await createAdmin();
    const obligations = await http()
      .get('/api/admin/inventory/refund-obligations')
      .set('Authorization', admin.auth);
    expect(obligations.body.data.obligations).toHaveLength(0);
  });

  /**
   * The ADR-08 race, tested end to end: the reaper expires the order while the
   * charge is still unresolved, and the provider then reports a success. The
   * money has moved for something we cannot fulfil, so the system records an
   * explicit refund obligation instead of swallowing it.
   */
  it('records a refund obligation when a silent charge succeeds after expiry', async () => {
    await withConfig({ RESERVATION_TTL_MS: 120 }, async () => {
      const { auth } = await createCustomer();
      const product = await createProduct({ priceMinor: 1000, onHand: 10 });
      const key = randomUUID();

      const started = await checkoutRequest({
        auth,
        key,
        body: checkoutBody({
          items: [{ productId: String(product._id), quantity: 2 }],
          token: 'tok_timeout',
        }),
      });
      expect(started.status).toBe(202);
      const orderId = started.body.data.order.id;
      const pending = getGateway().resolvePending({ orderId });

      // Let the reservation lapse, then let the reaper have it.
      await sleep(160);
      const swept = await sweepExpiredReservations();
      expect(swept.released).toBe(1);
      expect((await Order.findById(orderId)).status).toBe(ORDER_STATUS.EXPIRED);
      expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });

      // NOW the provider answers, too late.
      const late = await postWebhook(
        webhookPayload({ orderId, providerRef: pending.providerRef, status: 'succeeded' }),
      );

      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('ORDER_NOT_PENDING');
      expect(late.body.error.details.refundObligation).toBe(true);

      expect((await attemptFor(orderId)).status).toBe(PAYMENT_STATUS.REFUND_REQUIRED);
      // The order was NOT resurrected and the stock was NOT captured.
      expect((await Order.findById(orderId)).status).toBe(ORDER_STATUS.EXPIRED);
      expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });

      const admin = await createAdmin();
      const obligations = await http()
        .get('/api/admin/inventory/refund-obligations')
        .set('Authorization', admin.auth);
      expect(obligations.body.data.obligations).toHaveLength(1);
      // The amount owed back is the ORDER TOTAL the customer was charged —
      // subtotal plus tax plus shipping — not the subtotal alone.
      expect(obligations.body.data.obligations[0]).toMatchObject({
        orderId,
        amountMinor: (await Order.findById(orderId)).pricing.totalMinor,
      });
      expect(obligations.body.data.obligations[0].amountMinor).toBe(2759);
    });
  });

  it('ignores a late decline for an order that is already paid', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const paid = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] }),
    });
    expect(paid.status).toBe(201);
    const orderId = paid.body.data.order.id;

    const late = await postWebhook(
      webhookPayload({ orderId, providerRef: 'sim_late_decline', status: 'declined' }),
    );
    expect([201, 409]).toContain(late.status);

    // A decline must never release stock for a sale that already succeeded.
    expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });
    expect((await Order.findById(orderId)).status).toBe(ORDER_STATUS.PAID);
    expect((await attemptFor(orderId)).status).toBe(PAYMENT_STATUS.SUCCEEDED);
  });
});

describe('webhook endpoint', () => {
  it('rejects an unsigned or badly signed payload', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });
    const created = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }),
    });

    const unsigned = await http()
      .post('/api/webhooks/payments/simulated')
      .send(webhookPayload({ orderId: created.body.data.order.id, status: 'succeeded' }));
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error.code).toBe('INVALID_SIGNATURE');

    const wronglySigned = await http()
      .post('/api/webhooks/payments/simulated')
      .set('x-signature', 'deadbeef')
      .send(webhookPayload({ orderId: created.body.data.order.id, status: 'succeeded' }));
    expect(wronglySigned.status).toBe(401);
  });

  it('404s for an unknown order', async () => {
    const response = await postWebhook(
      webhookPayload({ orderId: 'd'.repeat(24), status: 'succeeded' }),
    );
    expect(response.status).toBe(404);
  });

  it('refuses a signed webhook reporting the wrong amount', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 5 });

    const started = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 1 }],
        token: 'tok_timeout',
      }),
    });
    const orderId = started.body.data.order.id;
    const pending = getGateway().resolvePending({ orderId });

    const wrongAmount = await postWebhook(
      webhookPayload({ orderId, providerRef: pending.providerRef, status: 'succeeded', amountMinor: 1 }),
    );

    expect(wrongAmount.status).toBe(409);
    expect(wrongAmount.body.error.code).toBe('AMOUNT_MISMATCH');
    // Nothing was settled by the bad payload.
    expect((await Order.findById(orderId)).status).toBe(ORDER_STATUS.PENDING_PAYMENT);
  });
});

describe('reconciliation poll', () => {
  it('resolves an unresolved charge on demand', async () => {
    const admin = await createAdmin();
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const started = await checkoutRequest({
      auth,
      key: randomUUID(),
      body: checkoutBody({
        items: [{ productId: String(product._id), quantity: 2 }],
        token: 'tok_timeout',
      }),
    });
    const orderId = started.body.data.order.id;

    const resolved = await http()
      .post(`/api/admin/orders/${orderId}/reconcile-payment`)
      .set('Authorization', admin.auth);

    expect(resolved.status).toBe(201);
    expect((await Order.findById(orderId)).status).toBe(ORDER_STATUS.PAID);
    expect(await counters(product._id)).toEqual({ onHand: 8, reserved: 0, available: 8 });

    // Nothing left to resolve.
    const again = await http()
      .post(`/api/admin/orders/${orderId}/reconcile-payment`)
      .set('Authorization', admin.auth);
    expect(again.status).toBe(404);
  });

  it('requires an admin', async () => {
    const { auth } = await createCustomer();
    const response = await http()
      .post(`/api/admin/orders/${'a'.repeat(24)}/reconcile-payment`)
      .set('Authorization', auth);
    expect(response.status).toBe(403);
  });
});
