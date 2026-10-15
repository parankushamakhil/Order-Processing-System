import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { ForbiddenError, UnauthenticatedError } from '../errors/index.js';

export function signToken(customer) {
  return jwt.sign(
    { sub: String(customer._id), role: customer.role, email: customer.email },
    config.JWT_SECRET,
    { expiresIn: config.JWT_TTL },
  );
}

/**
 * Auth is deliberately minimal, but it is present because idempotency keys are
 * scoped per customer and every order read is ownership-checked. Without an
 * identity there is no correct answer to "whose order is this?".
 */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return next(new UnauthenticatedError());

  try {
    const payload = jwt.verify(match[1], config.JWT_SECRET);
    req.auth = { customerId: String(payload.sub), role: payload.role, email: payload.email };
    return next();
  } catch {
    return next(new UnauthenticatedError('Invalid or expired token'));
  }
}

export function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') return next(new ForbiddenError('Admin role required'));
  return next();
}
