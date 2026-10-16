import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { capture, describeAvailability, release, reserve, restock } from '../../src/domain/inventory.js';
import { InsufficientStockError } from '../../src/errors/index.js';
import { Product } from '../../src/models/index.js';
import { counters, createProduct } from '../helpers/factories.js';
import { setInvariantCheckEnabled } from '../helpers/setup.js';

const line = (product, quantity) => ({ productId: product._id, quantity });

/**
 * `reserve()` alone leaves stock held with NO order behind it — a state the
 * application never produces, because the saga always writes the reservation
 * and the order in the same transaction. These primitive-level tests therefore
 * release their holds, so the global invariant hook (which asserts I3) can stay
 * ACTIVE for this file rather than being switched off for it. The order-level
 * tests in tests/integration and tests/concurrency verify I3 with real orders.
 */
const undo = (product, quantity) => release([line(product, quantity)]);

describe('reserve', () => {
  it('moves units from available to reserved, preserving I1', async () => {
    const product = await createProduct({ onHand: 10 });
    await reserve([line(product, 3)]);

    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 3, available: 7 });

    await undo(product, 3);
  });

  it('refuses more than is available and leaves the counters untouched', async () => {
    const product = await createProduct({ onHand: 2 });

    await expect(reserve([line(product, 3)])).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await counters(product._id)).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('refuses the last unit to the second of two claimants', async () => {
    const product = await createProduct({ onHand: 1 });
    await reserve([line(product, 1)]);

    await expect(reserve([line(product, 1)])).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await counters(product._id)).toEqual({ onHand: 1, reserved: 1, available: 0 });

    await undo(product, 1);
  });

  it('refuses an inactive product', async () => {
    const product = await createProduct({ onHand: 5, isActive: false });
    await expect(reserve([line(product, 1)])).rejects.toBeInstanceOf(InsufficientStockError);
  });
});

describe('release and capture', () => {
  it('release returns units to sale', async () => {
    const product = await createProduct({ onHand: 10 });
    await reserve([line(product, 4)]);
    await release([line(product, 4)]);

    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
  });

  it('capture converts a hold into a sale without consuming availability twice', async () => {
    const product = await createProduct({ onHand: 10 });
    await reserve([line(product, 4)]);
    await capture([line(product, 4)]);

    expect(await counters(product._id)).toEqual({ onHand: 6, reserved: 0, available: 6 });
  });

  /**
   * Both compensations carry a `reserved: { $gte: quantity }` guard, so a
   * duplicated release or capture is a no-op rather than a corruption.
   */
  it('a duplicated release cannot drive counters negative', async () => {
    const product = await createProduct({ onHand: 10 });
    await reserve([line(product, 4)]);

    await release([line(product, 4)]);
    await release([line(product, 4)]); // second one must not fire

    expect(await counters(product._id)).toEqual({ onHand: 10, reserved: 0, available: 10 });
  });

  it('a duplicated capture cannot drive counters negative', async () => {
    const product = await createProduct({ onHand: 10 });
    await reserve([line(product, 4)]);

    await capture([line(product, 4)]);
    await capture([line(product, 4)]);

    expect(await counters(product._id)).toEqual({ onHand: 6, reserved: 0, available: 6 });
  });
});

describe('restock', () => {
  it('adds physical units and makes them buyable immediately', async () => {
    const product = await createProduct({ onHand: 5 });
    await reserve([line(product, 2)]);

    await restock(product._id, 10);

    const after = await counters(product._id);
    expect(after.onHand).toBe(15);
    expect(after.available).toBe(13);
    expect(after.available).toBe(after.onHand - after.reserved);

    await undo(product, 2);
  });

  it('reports a missing product rather than creating one', async () => {
    expect(await restock(new mongoose.Types.ObjectId(), 5)).toBe(false);
  });
});

describe('describeAvailability', () => {
  it('explains every short line item with real numbers', async () => {
    const plenty = await createProduct({ onHand: 10, sku: 'PLENTY' });
    const scarce = await createProduct({ onHand: 1, sku: 'SCARCE' });
    const inactive = await createProduct({ onHand: 5, sku: 'INACTIVE', isActive: false });

    const report = await describeAvailability([
      line(plenty, 2),
      line(scarce, 4),
      line(inactive, 1),
      { productId: new mongoose.Types.ObjectId(), quantity: 1 },
    ]);

    expect(report.map((r) => r.reason)).toEqual([
      'insufficient_stock',
      'inactive',
      'not_found',
    ]);
    expect(report[0]).toMatchObject({ requested: 4, available: 1, sku: 'SCARCE' });
    expect(report[2].available).toBe(0);
  });
});

describe('storage-layer backstop (ADR-02)', () => {
  /**
   * The point of this test is that the guarantee does not depend on application
   * cooperation. It bypasses the primitives entirely and asks MongoDB directly
   * for something impossible.
   */
  it('makes a negative counter impossible, even for a direct write', async () => {
    const product = await createProduct({ onHand: 1 });

    setInvariantCheckEnabled(false); // this test deliberately inspects a broken write

    let rejected = false;
    try {
      await Product.collection.updateOne({ _id: product._id }, { $inc: { available: -5 } });
    } catch (err) {
      rejected = true;
      expect(err.message).toMatch(/validation/i);
    }

    expect(rejected).toBe(true);
    // The document is untouched: the write was refused, not partially applied.
    expect(await counters(product._id)).toEqual({ onHand: 1, reserved: 0, available: 1 });

    setInvariantCheckEnabled(true);
  });

  it('still allows a legitimate conditional decrement', async () => {
    const product = await createProduct({ onHand: 2 });

    const result = await Product.updateOne(
      { _id: product._id, available: { $gte: 2 } },
      { $inc: { available: -2, reserved: 2 } },
    );

    expect(result.matchedCount).toBe(1);
    expect(await counters(product._id)).toEqual({ onHand: 2, reserved: 2, available: 0 });

    await undo(product, 2);
  });

  it('refuses an order document with a negative total', async () => {
    setInvariantCheckEnabled(false);
    const { Order } = await import('../../src/models/index.js');
    const { id } = { id: new mongoose.Types.ObjectId() };

    let rejected = false;
    try {
      await Order.collection.insertOne({
        orderNumber: 'BAD-1',
        customerId: id,
        status: 'pending_payment',
        currency: 'INR',
        items: [
          {
            productId: new mongoose.Types.ObjectId(),
            sku: 'X',
            name: 'X',
            quantity: 1,
            unitPriceMinor: 100,
            lineTotalMinor: 100,
          },
        ],
        pricing: { subtotalMinor: 100, totalMinor: -1 },
        reservationExpiresAt: new Date(),
      });
    } catch (err) {
      rejected = true;
      expect(err.message).toMatch(/validation/i);
    }

    expect(rejected).toBe(true);
    setInvariantCheckEnabled(true);
  });
});
