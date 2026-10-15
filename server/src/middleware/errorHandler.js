import { AppError, CheckoutInProgressError, NotFoundError, RateLimitedError } from '../errors/index.js';
import { isReplicaSetError } from '../db/connect.js';

export function notFoundHandler(req, res, next) {
  next(new NotFoundError('ROUTE_NOT_FOUND', `No route matches ${req.method} ${req.path}`));
}

function envelope(err, requestId) {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      retryable: Boolean(err.retryable),
      requestId,
    },
  };
}

/**
 * The single error boundary. Every failure leaves the API in the same shape:
 * { error: { code, message, details?, retryable, requestId } }.
 *
 * Expected failures (our AppError taxonomy) are logged at warn with their code;
 * anything else is a bug, is logged with its stack, and is reported to the
 * client as a generic INTERNAL_ERROR so internals never leak.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args)
export function errorHandler(err, req, res, next) {
  const requestId = req.id ?? null;

  if (err instanceof AppError && err.expected) {
    req.log?.warn('handled error', {
      code: err.code,
      status: err.status,
      details: err.details,
    });
    const retryAfterMs =
      err instanceof CheckoutInProgressError || err instanceof RateLimitedError
        ? err.retryAfterMs
        : null;
    if (retryAfterMs != null) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    }
    return res.status(err.status).json(envelope(err, requestId));
  }

  // Zod failures that escaped the validate() middleware.
  if (err?.name === 'ZodError' && Array.isArray(err.issues)) {
    return res.status(400).json(
      envelope(
        new AppError('Request validation failed', {
          code: 'VALIDATION_ERROR',
          status: 400,
          details: {
            issues: err.issues.map((i) => ({
              path: (i.path ?? []).join('.'),
              message: i.message,
              code: i.code,
            })),
          },
        }),
        requestId,
      ),
    );
  }

  // Unique-index violation, e.g. duplicate SKU or a second charge attempt.
  if (err?.code === 11000) {
    req.log?.warn('duplicate key', { keyValue: err.keyValue, collection: err?.message });
    return res.status(409).json({
      error: {
        code: 'DUPLICATE_KEY',
        message: 'A record with those values already exists',
        details: { keyValue: err.keyValue ?? null },
        retryable: false,
        requestId,
      },
    });
  }

  // $jsonSchema rejection — the storage-layer backstop firing (ADR-02).
  if (err?.code === 121 || /Document failed validation/.test(err?.message ?? '')) {
    req.log?.error('collection validator rejected a write', { message: err.message });
    return res.status(500).json({
      error: {
        code: 'INVARIANT_VIOLATION',
        message: 'The write was rejected by a database invariant',
        retryable: false,
        requestId,
      },
    });
  }

  // Replica-set requirement violated at runtime (e.g. Atlas tier downgrade, or a
  // developer pointing at a standalone mongod). The server cannot serve checkout
  // until this is resolved; 503 is more accurate than 500 and the code tells the
  // operator exactly what is wrong.
  if (isReplicaSetError(err)) {
    req.log?.error('transaction attempted against a non-replica-set MongoDB', {
      error: err.message,
    });
    return res.status(503).json({
      error: {
        code: 'REPLICA_SET_REQUIRED',
        message:
          'This operation requires a MongoDB replica set. ' +
          'Locally: run `npm run dev:db`. ' +
          'In production: use MongoDB Atlas or start mongod with --replSet.',
        retryable: false,
        requestId,
      },
    });
  }

  req.log?.error('unhandled error', {
    error: err?.message,
    name: err?.name,
    stack: err?.stack,
  });
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      retryable: true,
      requestId,
    },
  });
}
