import { AppError } from '../errors/index.js';

/**
 * The pricing engine. Pure: no database, no clock, no request. That is what
 * makes it a genuine unit-test target and lets tax/shipping rules be tested
 * independently of HTTP and of MongoDB.
 *
 * Every value is an integer count of minor units. `0.1 + 0.2 !== 0.3` is not an
 * acceptable property for a checkout (ADR-01).
 */
export const PRICING_ENGINE_VERSION = 'v1';

export const TAX_RATE_BPS = 800; // 8.00%
export const SHIPPING_FLAT_MINOR = 599;
export const FREE_SHIPPING_THRESHOLD_MINOR = 5000;

/** A tiny discount catalogue, so discount rules are testable without a CMS. */
export const DISCOUNTS = Object.freeze({
  SAVE10: { code: 'SAVE10', type: 'percentage', bps: 1000 }, // 10%
  SAVE25: { code: 'SAVE25', type: 'percentage', bps: 2500 }, // 25%
  FLAT5: { code: 'FLAT5', type: 'fixed', minor: 500 }, // $5.00
});

export const DISCOUNT_CODES = Object.freeze(Object.keys(DISCOUNTS));

/** A pricing failure means a data bug (e.g. a non-integer price in the DB). */
export class PricingError extends AppError {
  constructor(message, details) {
    super(message, { code: 'PRICING_ERROR', status: 500, details });
  }
}

/** Explicit HALF_UP: never rely on a language default for money rounding. */
export function roundHalfUp(value) {
  return Math.floor(value + 0.5);
}

function assertInteger(name, value) {
  if (!Number.isInteger(value)) {
    throw new PricingError(`${name} must be an integer number of minor units`, { name, value });
  }
  return value;
}

export function discountFor(code) {
  if (!code) return null;
  const found = DISCOUNTS[code];
  if (!found) throw new PricingError('Unknown discount code', { code });
  return found;
}

function computeDiscount(discount, subtotalMinor) {
  if (!discount) return 0;
  const raw =
    discount.type === 'percentage'
      ? roundHalfUp((subtotalMinor * discount.bps) / 10_000)
      : discount.minor;
  // Clamped to the subtotal, so a discount can never produce a negative total.
  return Math.max(0, Math.min(raw, subtotalMinor));
}

/**
 * @param {{ lines: Array<{productId: string, quantity: number, unitPriceMinor: number}>,
 *           taxRateBps?: number, discountCode?: string|null }} input
 */
export function priceOrder({ lines, taxRateBps = TAX_RATE_BPS, discountCode = null }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new PricingError('Cannot price an empty cart', { lines });
  }

  let subtotalMinor = 0;
  for (const line of lines) {
    const { productId, quantity, unitPriceMinor } = line;
    assertInteger('quantity', quantity);
    assertInteger('unitPriceMinor', unitPriceMinor);
    if (quantity <= 0) throw new PricingError('quantity must be positive', { productId, quantity });
    if (unitPriceMinor < 0) {
      throw new PricingError('unitPriceMinor cannot be negative', { productId, unitPriceMinor });
    }
    subtotalMinor += unitPriceMinor * quantity;
  }
  assertInteger('subtotalMinor', subtotalMinor);
  assertInteger('taxRateBps', taxRateBps);

  const discount = discountFor(discountCode);
  const discountMinor = computeDiscount(discount, subtotalMinor);
  const taxableMinor = subtotalMinor - discountMinor;

  // Tax is rounded ONCE at order level, never per line: per-line rounding
  // accumulates drift and yields a total that cannot be reproduced from the
  // figures the customer is shown.
  const taxMinor = roundHalfUp((taxableMinor * taxRateBps) / 10_000);
  const shippingMinor =
    taxableMinor === 0 || taxableMinor >= FREE_SHIPPING_THRESHOLD_MINOR ? 0 : SHIPPING_FLAT_MINOR;
  const totalMinor = taxableMinor + taxMinor + shippingMinor;

  const result = {
    subtotalMinor,
    discountMinor,
    taxMinor,
    shippingMinor,
    totalMinor,
    taxRateBps,
    discountCode: discount?.code ?? null,
    engineVersion: PRICING_ENGINE_VERSION,
  };

  // Structural invariant, checked in production as well as in tests: the total
  // must always be reproducible from its displayed components, so a customer
  // can add up what they were shown and land on the number they paid.
  if (subtotalMinor - discountMinor + taxMinor + shippingMinor !== totalMinor) {
    throw new PricingError('Pricing components do not reconstruct the total', result);
  }
  if (totalMinor < 0 || !Number.isInteger(totalMinor)) {
    throw new PricingError('Total must be a non-negative integer', result);
  }

  return result;
}
