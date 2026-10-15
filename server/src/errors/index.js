/**
 * One error taxonomy for the whole API. Every failure carries a stable
 * machine-readable `code`, an HTTP status, optional `details`, and whether the
 * client may safely retry. That retryability flag is part of the contract: it
 * is what tells a client which failures it can replay with the same
 * idempotency key and which it must fix first.
 */
export class AppError extends Error {
  constructor(message, { code, status, details, retryable = false, cause } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code ?? 'INTERNAL_ERROR';
    this.status = status ?? 500;
    this.details = details;
    this.retryable = retryable;
    if (cause) this.cause = cause;
    this.expected = true; // distinguishes handled failures from bugs in logs
  }
}

export class ValidationError extends AppError {
  constructor(details) {
    super('Request validation failed', {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { issues: details },
    });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { code: 'UNAUTHENTICATED', status: 401 });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted') {
    super(message, { code: 'FORBIDDEN', status: 403 });
  }
}

export class NotFoundError extends AppError {
  constructor(code = 'NOT_FOUND', message = 'Resource not found', details) {
    super(message, { code, status: 404, details });
  }
}

export class ProductNotFoundError extends NotFoundError {
  constructor(productIds) {
    super('PRODUCT_NOT_FOUND', 'One or more products do not exist or are inactive', {
      productIds,
    });
  }
}

export class IdempotencyKeyRequiredError extends AppError {
  constructor() {
    super('The Idempotency-Key header is required for this endpoint', {
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
    });
  }
}

export class IdempotencyKeyReuseError extends AppError {
  constructor() {
    super('This Idempotency-Key was already used with a different request', {
      code: 'IDEMPOTENCY_KEY_REUSE',
      status: 422,
    });
  }
}

/**
 * Insufficient stock. Carries per-item availability so the UI can show real
 * numbers rather than a bare "out of stock".
 */
export class InsufficientStockError extends AppError {
  constructor(items) {
    super('One or more items do not have enough stock', {
      code: 'OUT_OF_STOCK',
      status: 409,
      details: { items },
      retryable: true,
    });
    this.items = items;
  }
}

/** The cart total the client showed no longer matches the server's. */
export class PriceChangedError extends AppError {
  constructor(pricing) {
    super('Prices have changed since the cart was created', {
      code: 'PRICE_CHANGED',
      status: 409,
      details: { pricing },
      retryable: true,
    });
  }
}

/** A concurrent request holds the same idempotency key. */
export class CheckoutInProgressError extends AppError {
  constructor(retryAfterMs) {
    super('An identical checkout is already in progress', {
      code: 'CHECKOUT_IN_PROGRESS',
      status: 409,
      details: { retryAfterMs },
      retryable: true,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export class PaymentDeclinedError extends AppError {
  constructor({ orderId, providerCode, providerMessage } = {}) {
    super('Payment was declined', {
      code: 'PAYMENT_DECLINED',
      status: 402,
      details: { orderId, providerCode, providerMessage },
      retryable: true,
    });
  }
}

export class PaymentFailedError extends AppError {
  constructor({ orderId, providerCode, providerMessage } = {}) {
    super('The payment provider could not process the request', {
      code: 'PAYMENT_FAILED',
      status: 402,
      details: { orderId, providerCode, providerMessage },
      retryable: true,
    });
  }
}

/**
 * The order was settled by someone else while we were charging (ADR-08). The
 * customer's money may have been taken, so we record a refund obligation rather
 * than pretending nothing happened.
 */
export class OrderNotPendingError extends AppError {
  constructor({ orderId, status, refundObligation = false } = {}) {
    super('The order is no longer awaiting payment', {
      code: 'ORDER_NOT_PENDING',
      status: 409,
      details: { orderId, status, refundObligation },
      retryable: false,
    });
  }
}

export class IllegalTransitionError extends AppError {
  constructor(from, to) {
    super(`Illegal order transition ${from} -> ${to}`, {
      code: 'ILLEGAL_TRANSITION',
      status: 500,
      details: { from, to },
    });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterMs) {
    super('Too many requests', {
      code: 'RATE_LIMITED',
      status: 429,
      details: { retryAfterMs },
      retryable: true,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/** Errors for which the idempotency claim should be RELEASED, not marked failed. */
const RELEASABLE_CODES = new Set([
  'VALIDATION_ERROR',
  'PRODUCT_NOT_FOUND',
  'PRICE_CHANGED',
  'IDEMPOTENCY_KEY_REQUIRED',
]);

export function isReleasable(err) {
  return err instanceof AppError && RELEASABLE_CODES.has(err.code);
}
