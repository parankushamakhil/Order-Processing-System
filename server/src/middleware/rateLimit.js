import { RateLimitedError } from '../errors/index.js';

/**
 * Idempotency keys protect correctness. Rate limiting protects the database
 * from a client that retries badly. Both are needed; they solve different
 * problems.
 *
 * In-memory sliding window: correct for a single process, which is the stated
 * deployment. A multi-instance deployment moves this to Redis with the same
 * interface — noted rather than pretended.
 */
const buckets = new Map();

export function rateLimit({ limit, windowMs = 60_000, keyFn }) {
  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

    if (hits.length >= limit) {
      const retryAfterMs = windowMs - (now - hits[0]);
      buckets.set(key, hits);
      return next(new RateLimitedError(Math.max(1, retryAfterMs)));
    }

    hits.push(now);
    buckets.set(key, hits);
    return next();
  };
}

/** Test hook: keeps the counter from leaking across test cases. */
export function resetRateLimits() {
  buckets.clear();
}
