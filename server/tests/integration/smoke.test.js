import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Order, PaymentAttempt } from '../../src/models/index.js';
import {
  checkoutBody,
  checkoutRequest,
  createAdmin,
  createCustomer,
  createProduct,
  http,
} from '../helpers/factories.js';
import { expectInvariants } from '../helpers/setup.js';

describe('wiring', () => {
  it('serves liveness and readiness', async () => {
    const health = await http().get('/healthz');
    expect(health.status).toBe(200);

    const ready = await http().get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.data.ready).toBe(true);
  });

  it('registers, logs in and rejects a wrong password', async () => {
    const email = `reg_${Date.now()}@example.com`;
    const registered = await http()
      .post('/api/auth/register')
      .send({ email, password: 'password1234', name: 'Reg' });
    expect(registered.status).toBe(201);
    expect(registered.body.data.token).toBeTruthy();
    // The role is never client-supplied.
    expect(registered.body.data.customer.role).toBe('customer');

    const bad = await http()
      .post('/api/auth/login')
      .send({ email, password: 'password9999' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('UNAUTHENTICATED');

    const good = await http()
      .post('/api/auth/login')
      .send({ email, password: 'password1234' });
    expect(good.status).toBe(200);
  });

  it('completes a checkout, commits the sale and replays idempotently', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });
    const key = randomUUID();
    const body = checkoutBody({ items: [{ productId: String(product._id), quantity: 2 }] });

    const first = await checkoutRequest({ auth, key, body });
    expect(first.status).toBe(201);
    expect(first.body.data.order.status).toBe(ORDER_STATUS.PAID);
    expect(first.body.data.replayed).toBe(false);
    // 2 x 1000 = 2000 subtotal, 8% tax = 160, shipping free over the threshold
    // is NOT met here, so 599 flat applies.
    expect(first.body.data.order.pricing.subtotalMinor).toBe(2000);
    expect(first.body.data.order.pricing.taxMinor).toBe(160);
    expect(first.body.data.order.pricing.totalMinor).toBe(2759);

    const orderId = first.body.data.order.id;

    // A replay must not create a second order or charge twice.
    const second = await checkoutRequest({ auth, key, body });
    expect(second.status).toBe(201);
    expect(second.body.data.order.id).toBe(orderId);
    expect(second.headers['idempotency-replayed']).toBe('true');

    expect(await Order.countDocuments()).toBe(1);
    expect(await PaymentAttempt.countDocuments()).toBe(1);

    const after = await product.constructor.findById(product._id);
    expect({ onHand: after.onHand, reserved: after.reserved, available: after.available }).toEqual({
      onHand: 8,
      reserved: 0,
      available: 8,
    });

    await expectInvariants();
  });

  it('requires an idempotency key', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct();
    const response = await http()
      .post('/api/checkout')
      .set('Authorization', auth)
      .send(checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  /**
   * The app's own origin must never be treated as cross-origin.
   *
   * Vite's built SPA loads its script and stylesheet with `crossorigin`, so the
   * browser sends an Origin header on those same-origin requests. An allowlist
   * that only recognises "no Origin header" as same-origin therefore 403s the
   * application's own assets — and every API-style test still passes, because
   * curl and supertest send no Origin at all. This test sends one.
   */
  it('accepts an Origin equal to its own host, and still refuses a foreign one', async () => {
    const own = await http()
      .get('/healthz')
      .set('Host', 'supply.example.com')
      .set('Origin', 'https://supply.example.com');
    expect(own.status).toBe(200);

    // A different port is a different origin, so it must be judged by the
    // allowlist like any other cross-origin caller.
    const otherPort = await http()
      .get('/healthz')
      .set('Host', 'supply.example.com')
      .set('Origin', 'https://supply.example.com:8443');
    expect(otherPort.status).toBe(403);
    expect(otherPort.body.error.code).toBe('FORBIDDEN');

    const foreign = await http()
      .get('/healthz')
      .set('Host', 'supply.example.com')
      .set('Origin', 'https://evil.example.test');
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('FORBIDDEN');

    // A configured allowlist entry is still honoured from another host.
    const allowed = await http()
      .get('/healthz')
      .set('Host', 'api.internal')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.status).toBe(200);
  });

  it('reports a reconciliation dashboard to an admin only', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer();
    await createProduct();

    const denied = await http()
      .get('/api/admin/inventory/reconcile')
      .set('Authorization', customer.auth);
    expect(denied.status).toBe(403);

    const allowed = await http()
      .get('/api/admin/inventory/reconcile')
      .set('Authorization', admin.auth);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.consistent).toBe(true);
    expect(allowed.body.data.inventory.length).toBe(1);
  });

  it('serves operational telemetry (JSON) and Prometheus metrics', async () => {
    const admin = await createAdmin();

    const prom = await http().get('/metrics');
    expect(prom.status).toBe(200);
    expect(prom.text).toContain('checkout_attempts_total');
    expect(prom.text).toContain('transaction_retries_total');

    const telemetry = await http()
      .get('/api/admin/telemetry')
      .set('Authorization', admin.auth);
    expect(telemetry.status).toBe(200);
    expect(telemetry.body.data.counters).toHaveProperty('attempts');
    expect(telemetry.body.data.counters).toHaveProperty('retries');
    expect(telemetry.body.data.latencies).toHaveProperty('p50');
  });

  it('increments rate_limited counter in metrics when rate limit is tripped', async () => {
    const { auth } = await createCustomer();
    const product = await createProduct({ priceMinor: 1000, onHand: 10 });

    const originalLimit = config.CHECKOUT_RATE_LIMIT_PER_MIN;
    config.CHECKOUT_RATE_LIMIT_PER_MIN = 2;
    try {
      const promises = Array.from({ length: 6 }, (_, i) =>
        http()
          .post('/api/checkout')
          .set('Authorization', auth)
          .set('Idempotency-Key', `smoke-rate-${randomUUID()}-${i}`)
          .send(checkoutBody({ items: [{ productId: String(product._id), quantity: 1 }] })),
      );
      await Promise.all(promises);

      const prom = await http().get('/metrics');
      expect(prom.text).toMatch(/checkout_rejections_total\{reason="rate_limited"\} [1-9]\d*/);
    } finally {
      config.CHECKOUT_RATE_LIMIT_PER_MIN = originalLimit;
    }
  });
});
