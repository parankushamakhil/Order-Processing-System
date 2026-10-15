import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

/**
 * Every request gets a correlation id, echoed as X-Request-Id and included in
 * every log line and every error envelope. That is what makes a reported
 * failure reproducible instead of anecdotal.
 */
export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  req.log = logger.child({ requestId: req.id });

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    req.log.info('request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}
