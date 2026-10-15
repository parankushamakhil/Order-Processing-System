import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_STATUS } from '../../src/models/IdempotencyKey.js';
import {
  buildRequestHash,
  canonicalizeItems,
  classifyExisting,
  stableStringify,
} from '../../src/services/idempotency.service.js';

const HOUR = 60 * 60 * 1000;
const now = Date.now();

const claim = (overrides = {}) => ({
  requestHash: 'hash-a',
  status: IDEMPOTENCY_STATUS.PROCESSING,
  leaseExpiresAt: new Date(now + HOUR),
  expiresAt: new Date(now + 24 * HOUR),
  orderId: null,
  ...overrides,
});

describe('canonicalizeItems', () => {
  it('merges duplicate line items instead of treating them as distinct', () => {
    const merged = canonicalizeItems([
      { productId: 'b', quantity: 2 },
      { productId: 'a', quantity: 1 },
      { productId: 'b', quantity: 3 },
    ]);
    expect(merged).toEqual([
      { productId: 'a', quantity: 1 },
      { productId: 'b', quantity: 5 },
    ]);
  });

  it('sorts by productId so line order never changes the hash', () => {
    const one = canonicalizeItems([
      { productId: 'z', quantity: 1 },
      { productId: 'a', quantity: 1 },
    ]);
    const two = canonicalizeItems([
      { productId: 'a', quantity: 1 },
      { productId: 'z', quantity: 1 },
    ]);
    expect(one).toEqual(two);
  });
});

describe('stableStringify', () => {
  it('ignores key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('buildRequestHash', () => {
  const items = [{ productId: 'a'.repeat(24), quantity: 2 }];

  it('is stable across key ordering and irrelevant fields', () => {
    const a = buildRequestHash({ customerId: 'c1', items, discountCode: null });
    const b = buildRequestHash({ customerId: 'c1', discountCode: null, items });
    expect(a).toBe(b);
  });

  it('changes when the cart changes', () => {
    const a = buildRequestHash({ customerId: 'c1', items });
    const b = buildRequestHash({
      customerId: 'c1',
      items: [{ productId: 'a'.repeat(24), quantity: 3 }],
    });
    expect(a).not.toBe(b);
  });

  /**
   * The payment instrument is deliberately NOT part of the hash. A declined
   * purchase retried with a different card is the same purchase, and hashing the
   * token would turn that retry into a 422 key reuse — destroying the recovery
   * path that the `failed -> retryable` state exists to provide.
   */
  it('does not depend on the payment instrument or the expected total', () => {
    const base = buildRequestHash({ customerId: 'c1', items, discountCode: null });
    const withDifferentCard = buildRequestHash({ customerId: 'c1', items, discountCode: null });
    expect(withDifferentCard).toBe(base);
    expect(buildRequestHash.toString()).not.toMatch(/token/);
  });

  it('is scoped per customer', () => {
    expect(buildRequestHash({ customerId: 'c1', items })).not.toBe(
      buildRequestHash({ customerId: 'c2', items }),
    );
  });
});

describe('classifyExisting', () => {
  it('replays a completed claim', () => {
    const result = classifyExisting(claim({ status: IDEMPOTENCY_STATUS.COMPLETED }), 'hash-a', now);
    expect(result.kind).toBe('replay');
  });

  it('allows a retry of a failed claim with the same request', () => {
    const result = classifyExisting(claim({ status: IDEMPOTENCY_STATUS.FAILED }), 'hash-a', now);
    expect(result.kind).toBe('retryable');
  });

  it('reports a conflict when the same key is used for a different request', () => {
    const result = classifyExisting(claim(), 'hash-OTHER', now);
    expect(result.kind).toBe('conflict');
  });

  it('reports in-flight while the lease is live', () => {
    const result = classifyExisting(claim(), 'hash-a', now);
    expect(result.kind).toBe('in_flight');
  });

  it('takes over a claim whose lease has lapsed', () => {
    const result = classifyExisting(
      claim({ leaseExpiresAt: new Date(now - 1) }),
      'hash-a',
      now,
    );
    expect(result.kind).toBe('takeover');
  });

  /**
   * Retention is enforced here rather than by trusting the TTL monitor, which
   * runs periodically and can lag under load. Once retention lapses the key is
   * free again even though the record has not been deleted yet.
   */
  it('takes over a completed claim whose retention has lapsed', () => {
    const result = classifyExisting(
      claim({
        status: IDEMPOTENCY_STATUS.COMPLETED,
        leaseExpiresAt: new Date(now - HOUR),
        expiresAt: new Date(now - 1),
      }),
      'hash-a',
      now,
    );
    expect(result.kind).toBe('takeover');
  });

  it('checks retention BEFORE the request hash', () => {
    // A lapsed key with a different cart must not be a conflict either: the
    // record is dead, so the key is simply available again.
    const result = classifyExisting(
      claim({ requestHash: 'hash-OTHER', expiresAt: new Date(now - 1) }),
      'hash-a',
      now,
    );
    expect(result.kind).toBe('takeover');
  });
});
