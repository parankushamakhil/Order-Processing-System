import { describe, expect, it } from 'vitest';
import {
  DISCOUNTS,
  FREE_SHIPPING_THRESHOLD_MINOR,
  PRICING_ENGINE_VERSION,
  PricingError,
  SHIPPING_FLAT_MINOR,
  TAX_RATE_BPS,
  priceOrder,
  roundHalfUp,
} from '../../src/domain/pricing.js';

const line = (unitPriceMinor, quantity = 1) => ({
  productId: 'x'.repeat(24),
  quantity,
  unitPriceMinor,
});

describe('pricing engine', () => {
  it('computes the subtotal exactly, in integer minor units', () => {
    const result = priceOrder({ lines: [line(2499, 3)] });
    expect(result.subtotalMinor).toBe(7497);
    // 7497 >= the free-shipping threshold, so no shipping is charged.
    expect(result.taxMinor).toBe(600); // 7497 * 0.08 = 599.76 -> 600
    expect(result.shippingMinor).toBe(0);
    expect(result.totalMinor).toBe(8097);
    expect(result.engineVersion).toBe(PRICING_ENGINE_VERSION);
  });

  it('never involves a float in the total', () => {
    // The classic failure: 0.1 + 0.2 !== 0.3. Integer minor units make it moot.
    const result = priceOrder({ lines: [line(10, 3)], taxRateBps: 0 });
    expect(result.subtotalMinor).toBe(30);
    expect(Number.isInteger(result.totalMinor)).toBe(true);
  });

  it('rounds HALF_UP explicitly rather than relying on a language default', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(0.4999)).toBe(0);
    // 4 * 12.5% = 0.5 exactly, which must round up, not to zero.
    const result = priceOrder({ lines: [line(4)], taxRateBps: 1250 });
    expect(result.taxMinor).toBe(1);
  });

  it('charges flat shipping below the threshold and none above it', () => {
    const below = priceOrder({ lines: [line(FREE_SHIPPING_THRESHOLD_MINOR - 1)] });
    expect(below.shippingMinor).toBe(SHIPPING_FLAT_MINOR);

    const at = priceOrder({ lines: [line(FREE_SHIPPING_THRESHOLD_MINOR)] });
    expect(at.shippingMinor).toBe(0);
  });

  it('applies a percentage discount before tax', () => {
    const result = priceOrder({ lines: [line(1000)], discountCode: 'SAVE10' });
    expect(result.discountMinor).toBe(100);
    expect(result.taxMinor).toBe(72); // 900 * 8%
    expect(result.shippingMinor).toBe(SHIPPING_FLAT_MINOR);
    expect(result.totalMinor).toBe(900 + 72 + SHIPPING_FLAT_MINOR);
  });

  it('clamps a fixed discount to the subtotal so a total can never go negative', () => {
    const result = priceOrder({ lines: [line(300)], discountCode: 'FLAT5' });
    expect(result.discountMinor).toBe(300); // clamped from 500
    expect(result.taxMinor).toBe(0);
    expect(result.shippingMinor).toBe(0); // nothing to ship
    expect(result.totalMinor).toBe(0);
  });

  it('always lets the components reconstruct the total', () => {
    for (const code of [null, ...Object.keys(DISCOUNTS)]) {
      const result = priceOrder({ lines: [line(1999, 2), line(349, 3)], discountCode: code });
      expect(
        result.subtotalMinor - result.discountMinor + result.taxMinor + result.shippingMinor,
      ).toBe(result.totalMinor);
      expect(result.totalMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses the documented default tax rate', () => {
    expect(TAX_RATE_BPS).toBe(800);
    expect(priceOrder({ lines: [line(1000)] }).taxRateBps).toBe(800);
  });

  describe('rejects input that would corrupt a price', () => {
    it.each([
      ['an empty cart', { lines: [] }],
      ['a missing cart', {}],
      ['a zero quantity', { lines: [line(1000, 0)] }],
      ['a negative quantity', { lines: [line(1000, -2)] }],
      ['a fractional quantity', { lines: [line(1000, 1.5)] }],
      ['a fractional price', { lines: [{ ...line(1000), unitPriceMinor: 10.5 }] }],
      ['a negative price', { lines: [line(-1)] }],
      ['an unknown discount code', { lines: [line(1000)], discountCode: 'NOPE' }],
    ])('%s', (_label, input) => {
      expect(() => priceOrder(input)).toThrow(PricingError);
    });
  });
});
