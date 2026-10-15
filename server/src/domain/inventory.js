import { InsufficientStockError } from '../errors/index.js';
import { Product } from '../models/Product.js';

/**
 * The three primitives. NOTHING else in the codebase writes onHand, reserved or
 * available. Their narrowness is the point: each is small enough to be obviously
 * correct, and because each moves the counters together inside a single-document
 * atomic update, `available === onHand - reserved` holds by construction (I1).
 *
 * All three are safe to call with or without a session; when called inside the
 * checkout transaction they take the session and therefore participate in the
 * same atomic unit.
 */

/**
 * Reserve: move units from available to reserved.
 *
 * The filter and the mutation are ONE operation. MongoDB evaluates the predicate
 * and applies the $inc atomically on a single document, so two customers racing
 * for the last unit cannot both match `available >= 1` — the second update
 * re-evaluates against the already-decremented value and matches nothing. No
 * lock, no optimistic retry bookkeeping (ADR-03).
 *
 * Lines are sorted by productId first, so two multi-item carts can never
 * livelock on each other (ADR-04).
 */
export async function reserve(lines, session = null) {
  const ordered = [...lines].sort((a, b) =>
    String(a.productId).localeCompare(String(b.productId)),
  );

  for (const { productId, quantity } of ordered) {
    const result = await Product.updateOne(
      { _id: productId, isActive: true, available: { $gte: quantity } },
      { $inc: { available: -quantity, reserved: quantity } },
      { session },
    );

    // A successful database call is NOT a successful reservation. matchedCount
    // === 0 means the product is missing, inactive, or short of stock.
    if (result.matchedCount !== 1) {
      throw new InsufficientStockError([
        { productId: String(productId), requested: quantity, available: null },
      ]);
    }
  }
}

/** Release: move units back from reserved to available (compensation). */
export async function release(lines, session = null) {
  for (const { productId, quantity } of lines) {
    await Product.updateOne(
      // The guard makes release idempotent: a second release cannot drive the
      // counter negative.
      { _id: productId, reserved: { $gte: quantity } },
      { $inc: { reserved: -quantity, available: quantity } },
      { session },
    );
  }
}

/**
 * Capture: convert a hold into a committed sale.
 *
 * onHand and reserved move together; `available` is untouched, which is exactly
 * right — paying turns a hold into a sale, it does not consume availability a
 * second time. Reserve then capture is `available -= q` then
 * `onHand -= q, reserved -= q`, so I1 holds throughout.
 */
export async function capture(lines, session = null) {
  for (const { productId, quantity } of lines) {
    await Product.updateOne(
      { _id: productId, reserved: { $gte: quantity } },
      { $inc: { onHand: -quantity, reserved: -quantity } },
      { session },
    );
  }
}

/**
 * Restock: new physical units. Both counters move, so I1 is preserved, and the
 * newly arrived units become buyable immediately.
 */
export async function restock(productId, units, session = null) {
  const result = await Product.updateOne(
    { _id: productId },
    { $inc: { onHand: units, available: units } },
    { session },
  );
  return result.matchedCount === 1;
}

/**
 * Build the full per-item availability report for an OUT_OF_STOCK response.
 * A bare "out of stock" with no numbers is unusable to a UI, so every short
 * line item is explained with real figures.
 */
export async function describeAvailability(lines) {
  const ids = lines.map((l) => l.productId);
  const products = await Product.find({ _id: { $in: ids } })
    .select('sku name isActive available')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  return lines
    .map(({ productId, quantity }) => {
      const product = byId.get(String(productId));
      const available = product?.available ?? 0;
      if (product && product.isActive && available >= quantity) return null;
      return {
        productId: String(productId),
        sku: product?.sku ?? null,
        name: product?.name ?? null,
        requested: quantity,
        available,
        reason: !product ? 'not_found' : !product.isActive ? 'inactive' : 'insufficient_stock',
      };
    })
    .filter(Boolean);
}
