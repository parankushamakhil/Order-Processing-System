import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DISCOUNT_CODES,
  FREE_SHIPPING_THRESHOLD_MINOR,
  SHIPPING_FLAT_MINOR,
  priceOrder,
  roundHalfUp,
} from '../../src/domain/pricing.js';

const arbLine = fc.record({
  unitPriceMinor: fc.integer({ min: 0, max: 100_000 }),
  quantity: fc.integer({ min: 1, max: 5 }),
});

const arbCart = fc
  .array(arbLine, { minLength: 1, maxLength: 6 })
  .map((lines) =>
    lines.map((l, i) => ({ productId: i.toString(16).padStart(24, '0'), ...l })),
  );

const arbDiscount = fc.constantFrom(null, ...DISCOUNT_CODES);

describe('pricing engine properties', () => {
  it('always produces integral, non-negative, reconstructable totals', () => {
    fc.assert(
      fc.property(arbCart, arbDiscount, (lines, discountCode) => {
        const r = priceOrder({ lines, discountCode });

        // Everything is an integer number of minor units.
        for (const value of [
          r.subtotalMinor,
          r.discountMinor,
          r.taxMinor,
          r.shippingMinor,
          r.totalMinor,
        ]) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }

        // The components always reconstruct the total, so a customer can add up
        // what they were shown and land on the number they pay.
        expect(r.subtotalMinor - r.discountMinor + r.taxMinor + r.shippingMinor).toBe(
          r.totalMinor,
        );

        // The subtotal is exactly the sum of the lines.
        const expectedSubtotal = lines.reduce(
          (sum, l) => sum + l.unitPriceMinor * l.quantity,
          0,
        );
        expect(r.subtotalMinor).toBe(expectedSubtotal);

        // A discount can never exceed the subtotal, so the total can never be
        // negative from a coupon.
        expect(r.discountMinor).toBeLessThanOrEqual(r.subtotalMinor);

        // Tax is the documented rate, rounded HALF_UP exactly once.
        expect(r.taxMinor).toBe(
          roundHalfUp(((r.subtotalMinor - r.discountMinor) * r.taxRateBps) / 10_000),
        );

        // Shipping is one of exactly two documented values.
        expect([0, SHIPPING_FLAT_MINOR]).toContain(r.shippingMinor);
        if (r.subtotalMinor - r.discountMinor >= FREE_SHIPPING_THRESHOLD_MINOR) {
          expect(r.shippingMinor).toBe(0);
        }

        // The total is never below the discounted subtotal, because tax and
        // shipping are both non-negative.
        expect(r.totalMinor).toBeGreaterThanOrEqual(r.subtotalMinor - r.discountMinor);
      }),
      { numRuns: 400 },
    );
  });

  /**
   * Monotonicity is asserted on the SUBTOTAL and TAX, not on the total.
   *
   * The total is deliberately not monotonic in quantity: crossing the
   * free-shipping threshold drops 599 of shipping at once, so a very cheap extra
   * item can lower the total. That is correct commercial behaviour, and
   * pretending otherwise would make this test wrong.
   */
  it('increases the subtotal and never decreases tax when a quantity grows', () => {
    fc.assert(
      fc.property(
        arbCart.filter((lines) => lines.every((l) => l.unitPriceMinor >= 1)),
        arbDiscount,
        fc.integer({ min: 0, max: 5 }),
        (lines, discountCode, index) => {
          const i = index % lines.length;
          const grown = lines.map((l, k) => (k === i ? { ...l, quantity: l.quantity + 1 } : l));

          const before = priceOrder({ lines, discountCode });
          const after = priceOrder({ lines: grown, discountCode });

          expect(after.subtotalMinor).toBeGreaterThan(before.subtotalMinor);
          // Tax is computed on (subtotal - discount), both of which only grow.
          expect(after.taxMinor).toBeGreaterThanOrEqual(before.taxMinor);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is order-independent: the same lines in any sequence give the same total', () => {
    fc.assert(
      fc.property(arbCart, (lines) => {
        const forward = priceOrder({ lines });
        const reversed = priceOrder({ lines: [...lines].reverse() });
        expect(reversed.totalMinor).toBe(forward.totalMinor);
        expect(reversed.taxMinor).toBe(forward.taxMinor);
      }),
      { numRuns: 200 },
    );
  });
});
