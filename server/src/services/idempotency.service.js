import { createHash } from 'node:crypto';
import { CHECKOUT_ENDPOINT, config } from '../config/index.js';
import { IdempotencyKey, IDEMPOTENCY_STATUS } from '../models/IdempotencyKey.js';

/** Deterministic JSON: key order must not change the hash. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function hashRequest(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Canonicalise the cart: merge duplicate line items, sort by productId.
 * Two requests that mean the same thing must hash the same, otherwise a
 * legitimate retry looks like a different purchase.
 */
export function canonicalizeItems(items) {
  const merged = new Map();
  for (const item of items) {
    const id = String(item.productId);
    merged.set(id, (merged.get(id) ?? 0) + item.quantity);
  }
  return [...merged.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

/**
 * The hash covers the purchase INTENT: the canonical cart and the discount. That
 * is, *what is being bought*.
 *
 * It deliberately excludes two things:
 *
 *  - `expectedTotalMinor`, a client-side assertion rather than part of the ask.
 *    Including it would turn a stale-total retry into a key reuse error instead
 *    of the useful PRICE_CHANGED.
 *
 *  - The payment instrument (token/card). This one is subtle and it matters:
 *    `failed` claims are retryable with the SAME key precisely so a customer
 *    whose card was declined can fix their payment and try again. Hashing the
 *    token would make that retry fail as a 422 key reuse — throwing away the
 *    recovery path that the whole `failed -> retryable` state exists for. A
 *    different card is the same purchase, not a second one, and a successful
 *    purchase replays rather than re-executing, so this cannot double-charge.
 */
export function buildRequestHash({ customerId, items, discountCode = null }) {
  return hashRequest({
    customerId: String(customerId),
    items,
    discountCode,
  });
}

/**
 * Classify an existing claim (ADR-07). Order matters: retention first, then
 * intent, then state.
 */
export function classifyExisting(existing, requestHash, now = Date.now()) {
  // Retention is enforced HERE, not left to the TTL monitor, which runs
  // periodically and can lag under load. Once retention has lapsed the key is
  // free again.
  if (new Date(existing.expiresAt).getTime() <= now) return { kind: 'takeover', doc: existing };
  if (existing.requestHash !== requestHash) return { kind: 'conflict', doc: existing };
  if (existing.status === IDEMPOTENCY_STATUS.COMPLETED) return { kind: 'replay', doc: existing };
  if (existing.status === IDEMPOTENCY_STATUS.FAILED) return { kind: 'retryable', doc: existing };
  if (new Date(existing.leaseExpiresAt).getTime() > now) return { kind: 'in_flight', doc: existing };
  return { kind: 'takeover', doc: existing }; // the previous attempt died mid-flight
}

/**
 * Claim the key with a bare insert. The unique index — not an application-side
 * "check then insert" — is the arbiter, so two simultaneous requests cannot
 * both create a claim.
 *
 * Importatly this is NOT inside a transaction. Inside one, two concurrent
 * inserts of the same unique key surface as a WriteConflict, which is labelled
 * transient, so withTransaction would retry the callback; the loser would
 * discover the collision through a retry storm instead of failing fast and
 * reading the winner's state deliberately.
 */
export async function claimIdempotency({
  customerId,
  key,
  requestHash,
  endpoint = CHECKOUT_ENDPOINT,
  retryOnRace = true,
}) {
  const now = Date.now();
  try {
    const doc = await IdempotencyKey.create({
      customerId,
      endpoint,
      key,
      requestHash,
      status: IDEMPOTENCY_STATUS.PROCESSING,
      leaseExpiresAt: new Date(now + config.CLAIM_LEASE_MS),
      attempts: 1,
      expiresAt: new Date(now + config.IDEMPOTENCY_RETENTION_MS),
    });
    return { kind: 'acquired', doc };
  } catch (err) {
    if (err?.code !== 11000) throw err;

    const existing = await IdempotencyKey.findOne({ customerId, endpoint, key });
    // The claim was deleted between the duplicate error and this read (only
    // possible for a released, request-shaped failure). Retry once, then give
    // the caller a definitive answer rather than looping.
    if (!existing) {
      if (retryOnRace) {
        return claimIdempotency({ customerId, key, requestHash, endpoint, retryOnRace: false });
      }
      return { kind: 'in_flight', doc: null };
    }
    return classifyExisting(existing, requestHash, now);
  }
}

/**
 * Take over a lapsed or failed claim. This is itself a compare-and-swap, so only
 * one contender can win: the others fall through to waiting for a terminal
 * result. NOTE: `orderId` is deliberately NOT cleared — an interrupted attempt
 * may already hold a reservation, and reusing it is what prevents a retry from
 * reserving the same stock twice.
 */
export async function takeOverClaim(recordId) {
  const now = new Date();
  return IdempotencyKey.findOneAndUpdate(
    {
      _id: recordId,
      $or: [
        { status: IDEMPOTENCY_STATUS.FAILED },
        { status: IDEMPOTENCY_STATUS.PROCESSING, leaseExpiresAt: { $lte: now } },
        { status: IDEMPOTENCY_STATUS.COMPLETED, expiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: IDEMPOTENCY_STATUS.PROCESSING,
        leaseExpiresAt: new Date(now.getTime() + config.CLAIM_LEASE_MS),
      },
      $inc: { attempts: 1, takeoverCount: 1 },
    },
    { returnDocument: 'after' },
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait briefly for a concurrent request holding the same key to finish, so a
 * duplicate submission coalesces onto the winner's response instead of getting
 * a bare 409. Bounded, and the caller falls back to 409 CHECKOUT_IN_PROGRESS.
 */
export async function waitForTerminal(recordId, timeoutMs) {
  if (!recordId) return null;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const doc = await IdempotencyKey.findById(recordId);
    if (!doc) return null;
    if (doc.status !== IDEMPOTENCY_STATUS.PROCESSING) return doc;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(25, Math.max(5, deadline - Date.now())));
  }
}
