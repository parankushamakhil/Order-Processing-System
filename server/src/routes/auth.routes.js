import { Router } from 'express';
import { UnauthenticatedError } from '../errors/index.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { Customer, hashPassword, verifyPassword } from '../models/index.js';
import { loginSchema, registerSchema } from '../validation/schemas.js';

const router = Router();

// No pre-flight "does this email exist" check: the unique index is the arbiter,
// so a concurrent double-registration cannot slip through the gap between a
// check and an insert. The duplicate-key error is translated centrally.
router.post('/register', validate({ body: registerSchema }), async (req, res) => {
  const { email, password, name } = req.valid.body;
  const customer = await Customer.create({
    email: email.toLowerCase(),
    name: name ?? '',
    passwordHash: hashPassword(password),
    role: 'customer', // never client-supplied
  });
  res.status(201).json({ data: { customer: customer.toPublic(), token: signToken(customer) } });
});

router.post('/login', validate({ body: loginSchema }), async (req, res) => {
  const { email, password } = req.valid.body;
  const customer = await Customer.findOne({ email: email.toLowerCase() });
  // One message for both cases, so the endpoint does not confirm which emails
  // are registered.
  if (!customer || !verifyPassword(password, customer.passwordHash)) {
    throw new UnauthenticatedError('Invalid email or password');
  }
  res.json({ data: { customer: customer.toPublic(), token: signToken(customer) } });
});

router.get('/me', requireAuth, async (req, res) => {
  const customer = await Customer.findById(req.auth.customerId);
  if (!customer) throw new UnauthenticatedError();
  res.json({ data: { customer: customer.toPublic() } });
});

export default router;
