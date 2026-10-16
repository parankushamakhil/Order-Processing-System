import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/index.js';
import { withTransaction } from '../../src/db/transaction.js';
import { reserve } from '../../src/domain/inventory.js';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { priceOrder } from '../../src/domain/pricing.js';
import { signToken } from '../../src/middleware/auth.js';
import { Customer, hashPassword, Order, Product } from '../../src/models/index.js';
import { signWebhookPayload } from '../../src/routes/webhook.routes.js';

let appInstance = null;

/** One app per process, created exactly as production does. */
export function app() {
  if (!appInstance) appInstance = createApp();
  return appInstance;
}

export function http() {
  return request(app());
}

let seq = 0;
const unique = (prefix) => `${prefix}_${Date.now().toString(36)}_${++seq}`;

export const TEST_PASSWORD = 'password1234';

export async function createCustomer({ role = 'customer', password = TEST_PASSWORD } = {}) {
  const customer = await Customer.create({
    email: `${unique(role)}@example.com`,
    name: 'Test User',
    passwordHash: hashPassword(password),
    role,
  });
  const token = signToken(customer);
  return { customer, token, auth: `Bearer ${token}`, id: String(customer._id) };
}

export const createAdmin = () => createCustomer({ role: 'admin' });

/**
 * Bulk-insert buyers without password hashing.
 *
 * `createCustomer` runs scrypt, which is correct for real accounts but would
 * dominate a 200-way concurrency test. These buyers only ever need a valid
 * identity and a token.
 */
export async function createBuyers(count) {
  const tag = `buyer_${Date.now().toString(36)}`;
  const docs = await Customer.insertMany(
    Array.from({ length: count }, (_, i) => ({
      email: `${tag}_${i}@example.com`,
      name: 'Bulk Buyer',
      passwordHash: 'scrypt$bulk$not-a-real-password',
      role: 'customer',
    })),
  );
  return docs.map((c) => ({ id: String(c._id), auth: `Bearer ${signToken(c)}` }));
}

/** Temporarily override config for a test, restoring it even on failure. */
export async function withConfig(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = config[key];
    config[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) config[key] = value;
  }
}

export async function createProduct({
  priceMinor = 2499,
  onHand = 10,
  sku = unique('SKU'),
  name = 'Test Product',
  isActive = true,
} = {}) {
  const product = await Product.create({
    sku,
    name,
    description: 'A product used by the test suite',
    priceMinor,
    currency: 'INR',
    onHand,
    reserved: 0,
    // I1 holds from the very first document.
    available: onHand,
    isActive,
  });
  return product;
}

/** Build only the fields the strict schema allows, omitting the absent ones. */
export function checkoutBody({
  items,
  token = 'tok_success',
  discountCode = null,
  expectedTotalMinor = null,
} = {}) {
  const body = { items, paymentMethod: { type: 'card', token } };
  if (discountCode != null) body.discountCode = discountCode;
  if (expectedTotalMinor != null) body.expectedTotalMinor = expectedTotalMinor;
  return body;
}

export function checkoutRequest({ auth, key, body }) {
  return http()
    .post('/api/checkout')
    .set('Authorization', auth)
    .set('Idempotency-Key', key)
    .send(body);
}

/**
 * Build a pending order that already holds its reservation, WITHOUT going
 * through the saga. Reaper, expiry and compensation tests need to plant a
 * specific state (a lapsed hold, an in-flight charge) rather than race to it.
 */
export async function createPendingOrder({
  customerId,
  product,
  quantity = 1,
  reservationTtlMs = 60_000,
  paymentLeaseMs = 30_000,
  idempotencyKey = null,
} = {}) {
  const lines = [{ productId: product._id, quantity, unitPriceMinor: product.priceMinor }];
  const pricing = priceOrder({ lines });
  const now = Date.now();

  return withTransaction(async (session) => {
    await reserve(lines, session);
    const [order] = await Order.create(
      [
        {
          orderNumber: `TEST-${Date.now().toString(36)}-${++seq}`,
          customerId,
          status: ORDER_STATUS.PENDING_PAYMENT,
          currency: 'INR',
          items: [
            {
              productId: product._id,
              sku: product.sku,
              name: product.name,
              quantity,
              unitPriceMinor: product.priceMinor,
              lineTotalMinor: product.priceMinor * quantity,
            },
          ],
          pricing,
          payment: { provider: 'simulated', status: 'none', attempts: 0 },
          reservationExpiresAt: new Date(now + reservationTtlMs),
          paymentLeaseExpiresAt: new Date(now + paymentLeaseMs),
          idempotencyKey,
          statusHistory: [
            {
              from: 'none',
              to: ORDER_STATUS.PENDING_PAYMENT,
              at: new Date(now),
              reason: 'test_seed',
              actor: 'test',
            },
          ],
        },
      ],
      { session },
    );
    return order;
  });
}

export async function counters(productId) {
  const product = await Product.findById(productId).lean();
  return { onHand: product.onHand, reserved: product.reserved, available: product.available };
}

/** Posts a webhook signed exactly as the provider would sign it. */
export function postWebhook(payload) {
  const raw = JSON.stringify(payload);
  return http()
    .post('/api/webhooks/payments/simulated')
    .set('Content-Type', 'application/json')
    .set('x-signature', signWebhookPayload(Buffer.from(raw)))
    .send(raw);
}

export function webhookPayload({ orderId, providerRef, status = 'succeeded', amountMinor = null }) {
  const payload = {
    orderId: String(orderId),
    providerRef: providerRef ?? `sim_${orderId}_manual`,
    status,
  };
  // Omitted unless explicitly supplied: a default of 0 would now be a genuine
  // AMOUNT_MISMATCH against any real order total.
  if (amountMinor != null) payload.amountMinor = amountMinor;
  return payload;
}
