import { logger } from '../../lib/logger.js';

/**
 * A simulated payment gateway.
 *
 * Modelled as a genuinely external, slow, unreliable, eventually-consistent side
 * effect — because that is the only way the surrounding code stays correct when
 * a real gateway is dropped in. Specifically it can:
 *   - take a configurable amount of time (latency),
 *   - decline,
 *   - fail hard,
 *   - and, most importantly, accept the request and then never answer in time,
 *     leaving the caller with an ambiguous outcome that must be resolved later.
 *
 * Behaviour is driven deterministically by the payment token, so tests are not
 * probabilistic. `tok_random` opts into randomness for soak runs.
 */

export class GatewayError extends Error {
  constructor({ providerRef = null, code = 'provider_error', message = 'Gateway error' } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.providerRef = providerRef;
    this.code = code;
    this.expected = true;
  }
}

export class GatewayTimeoutError extends Error {
  constructor({ providerRef = null, timeoutMs = 0 } = {}) {
    super(`The payment gateway did not answer within ${timeoutMs}ms`);
    this.name = 'GatewayTimeoutError';
    this.providerRef = providerRef;
    this.timeoutMs = timeoutMs;
    this.expected = true;
  }
}

export const PAYMENT_TOKENS = Object.freeze([
  'tok_success',
  'tok_decline',
  'tok_timeout',
  'tok_error',
  'tok_random',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decideOutcome(token, failureRate) {
  switch (token) {
    case 'tok_success':
      return 'succeeded';
    case 'tok_decline':
      return 'declined';
    case 'tok_error':
      return 'error';
    case 'tok_timeout':
      return 'timeout';
    case 'tok_random':
      return Math.random() < failureRate ? 'declined' : 'succeeded';
    default:
      return 'error';
  }
}

function withTimeout(promise, timeoutMs, makeError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createSimulatedGateway({ latencyMs = 40, failureRate = 0 } = {}) {
  let refSeq = 0;
  /** providerRef -> unresolved charge, resolvable later ("the webhook arrives"). */
  const pendingByRef = new Map();
  const refunds = [];

  return {
    provider: 'simulated',

    latencyMs,
    failureRate,

    /**
     * @returns resolves with { providerRef, status, ... } or rejects with
     *          GatewayTimeoutError / GatewayError. It never resolves with an
     *          "unknown" status: ambiguity is expressed as a timeout.
     */
    async charge({ orderId, amountMinor, currency, token, idempotencyKey, timeoutMs }) {
      const providerRef = `sim_${idempotencyKey}_${++refSeq}`;
      const outcome = decideOutcome(token, failureRate);

      const work = (async () => {
        await sleep(latencyMs);

        if (outcome === 'timeout') {
          // The gateway HAS accepted the request; we simply never learn the
          // answer synchronously. The real outcome is revealed later via
          // resolvePending() (i.e. a webhook or a reconciliation poll).
          pendingByRef.set(providerRef, {
            providerRef,
            orderId: String(orderId),
            amountMinor,
            currency,
            token,
            finalStatus: 'succeeded',
          });
          logger.warn('simulated gateway withholding its answer', { providerRef, orderId: String(orderId) });
          return new Promise(() => {}); // hangs until the caller's timeout fires
        }

        if (outcome === 'error') {
          throw new GatewayError({
            providerRef,
            code: 'provider_unavailable',
            message: 'The payment provider is unavailable',
          });
        }

        return {
          providerRef,
          status: outcome,
          providerCode: outcome === 'declined' ? 'card_declined' : null,
          providerMessage: outcome === 'declined' ? 'The card was declined' : null,
          latencyMs,
        };
      })();

      // Guard against an unhandled rejection if the race below has already
      // timed out and `work` rejects afterwards.
      work.catch(() => {});

      return withTimeout(work, timeoutMs, () => new GatewayTimeoutError({ providerRef, timeoutMs }));
    },

    /** Ops/test hook: what the provider would eventually tell us. One-shot. */
    resolvePending({ orderId = null, providerRef = null } = {}) {
      for (const [ref, entry] of pendingByRef) {
        if ((providerRef && ref === providerRef) || (orderId && entry.orderId === String(orderId))) {
          pendingByRef.delete(ref);
          return { ...entry };
        }
      }
      return null;
    },

    /** Test hook: choose whether the withheld answer was really a success. */
    setPendingStatus({ orderId, status }) {
      for (const entry of pendingByRef.values()) {
        if (entry.orderId === String(orderId)) {
          entry.finalStatus = status;
          return true;
        }
      }
      return false;
    },

    listPending() {
      return [...pendingByRef.values()];
    },

    async refund({ orderId, amountMinor }) {
      const refundRef = `refund_${orderId}_${++refSeq}`;
      refunds.push({ refundRef, orderId: String(orderId), amountMinor, at: new Date() });
      logger.warn('simulated refund issued', { orderId: String(orderId), amountMinor });
      // orderId is echoed back: a refund record that does not identify the order
      // it belongs to is not a useful record for the operator who has to apply it.
      return { refundRef, orderId: String(orderId), status: 'refunded', amountMinor };
    },

    listRefunds() {
      return [...refunds];
    },
  };
}
