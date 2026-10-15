import { describe, expect, it } from 'vitest';
import {
  checkoutSchema,
  idempotencyKeySchema,
  productCreateSchema,
  productUpdateSchema,
  registerSchema,
  restockSchema,
  webhookSchema,
} from '../../src/validation/schemas.js';

const productId = 'a'.repeat(24);
const validCart = {
  items: [{ productId, quantity: 2 }],
  paymentMethod: { type: 'card', token: 'tok_success' },
};

describe('checkout schema', () => {
  it('accepts a well-formed cart', () => {
    expect(checkoutSchema.parse(validCart).items).toHaveLength(1);
  });

  it('accepts the optional discount and expected total', () => {
    const parsed = checkoutSchema.parse({
      ...validCart,
      discountCode: 'SAVE10',
      expectedTotalMinor: 1234,
    });
    expect(parsed.discountCode).toBe('SAVE10');
    expect(parsed.expectedTotalMinor).toBe(1234);
  });

  it.each([
    ['a missing cart', { paymentMethod: { type: 'card', token: 'tok_success' } }],
    ['an empty cart', { ...validCart, items: [] }],
    ['a zero quantity', { ...validCart, items: [{ productId, quantity: 0 }] }],
    ['a negative quantity', { ...validCart, items: [{ productId, quantity: -1 }] }],
    ['a fractional quantity', { ...validCart, items: [{ productId, quantity: 1.5 }] }],
    ['a string quantity', { ...validCart, items: [{ productId, quantity: '2' }] }],
    ['an absurd quantity', { ...validCart, items: [{ productId, quantity: 1e9 }] }],
    ['a malformed product id', { ...validCart, items: [{ productId: 'nope', quantity: 1 }] }],
    ['a missing payment method', { items: validCart.items }],
    ['an unknown payment token', { ...validCart, paymentMethod: { type: 'card', token: 'tok_magic' } }],
    ['a non-card payment type', { ...validCart, paymentMethod: { type: 'crypto', token: 'tok_success' } }],
    ['an unknown discount code', { ...validCart, discountCode: 'FREESTUFF' }],
    ['a negative expected total', { ...validCart, expectedTotalMinor: -5 }],
    ['an unknown top-level field', { ...validCart, priceMinor: 1 }],
    ['a client-supplied total on a line item', { ...validCart, items: [{ productId, quantity: 1, unitPriceMinor: 1 }] }],
  ])('rejects %s', (_label, input) => {
    expect(checkoutSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a cart with too many lines', () => {
    const items = Array.from({ length: 51 }, (_v, i) => ({
      productId: i.toString(16).padStart(24, '0'),
      quantity: 1,
    }));
    expect(checkoutSchema.safeParse({ ...validCart, items }).success).toBe(false);
  });
});

describe('idempotency key', () => {
  it('accepts a uuid', () => {
    expect(idempotencyKeySchema.parse('3f8c1e9a-1b2c-4d5e-8f90-a1b2c3d4e5f6')).toBeTruthy();
  });

  it.each([
    ['too short', 'abc'],
    ['with whitespace', 'has a space'],
    ['with a control character', 'bad\nkey'],
    ['far too long', 'k'.repeat(201)],
  ])('rejects a key that is %s', (_label, key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe('product schema', () => {
  it('accepts a new product', () => {
    expect(productCreateSchema.parse({ sku: 'S1', name: 'Thing', priceMinor: 100 }).onHand).toBe(0);
  });

  // The API must not be able to set inventory counters directly: they are owned
  // by the primitives that keep I1 true.
  it.each([
    ['available', { sku: 'S1', name: 'T', priceMinor: 1, available: 5 }],
    ['reserved', { sku: 'S1', name: 'T', priceMinor: 1, reserved: 5 }],
    ['priceMinor as a float', { sku: 'S1', name: 'T', priceMinor: 1.5 }],
  ])('rejects a payload that sets %s', (_label, input) => {
    expect(productCreateSchema.safeParse(input).success).toBe(false);
  });

  it('will not let an update change stock counters', () => {
    expect(productUpdateSchema.safeParse({ onHand: 999 }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ available: 999 }).success).toBe(false);
    expect(productUpdateSchema.parse({ priceMinor: 500 }).priceMinor).toBe(500);
  });

  it('requires a positive restock figure', () => {
    expect(restockSchema.safeParse({ units: 0 }).success).toBe(false);
    expect(restockSchema.safeParse({ units: -3 }).success).toBe(false);
    expect(restockSchema.safeParse({ units: 5 }).success).toBe(true);
  });
});

describe('auth schema', () => {
  it('rejects a short password', () => {
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
  });

  // Letting a client choose its own role would make every admin endpoint
  // decorative, so the field is not merely ignored — it is rejected.
  it('rejects a client-supplied role', () => {
    expect(
      registerSchema.safeParse({ email: 'a@b.co', password: 'password1234', role: 'admin' }).success,
    ).toBe(false);
  });
});

describe('webhook schema', () => {
  it('accepts a signed-provider-shaped payload', () => {
    expect(
      webhookSchema.safeParse({
        orderId: 'a'.repeat(24),
        providerRef: 'sim_1',
        status: 'succeeded',
        amountMinor: 100,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown resolution status', () => {
    expect(
      webhookSchema.safeParse({
        orderId: 'a'.repeat(24),
        providerRef: 'sim_1',
        status: 'maybe',
        amountMinor: 100,
      }).success,
    ).toBe(false);
  });
});
