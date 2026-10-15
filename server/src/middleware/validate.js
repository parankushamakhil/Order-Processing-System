import { ValidationError } from '../errors/index.js';

function toIssues(zodError) {
  return zodError.issues.map((i) => ({
    path: (i.path ?? []).join('.'),
    message: i.message,
    code: i.code,
  }));
}

/**
 * Validate with Zod before the handler runs, so no handler ever touches an
 * unvalidated body (ADR-14, defence layer 1).
 *
 * Parsed results are attached to `req.valid` rather than overwriting
 * `req.body`/`req.query`. In Express 5 `req.query` is a lazily-computed getter,
 * so assigning to it is not reliably safe, and a single explicit location for
 * validated input is easier to grep for than three mutated ones.
 */
export function validate(schemas) {
  return function validateMiddleware(req, res, next) {
    try {
      req.valid = {};
      if (schemas.body) req.valid.body = schemas.body.parse(req.body ?? {});
      if (schemas.params) req.valid.params = schemas.params.parse(req.params ?? {});
      if (schemas.query) req.valid.query = schemas.query.parse(req.query ?? {});
      next();
    } catch (err) {
      if (err?.name === 'ZodError') return next(new ValidationError(toIssues(err)));
      return next(err);
    }
  };
}
