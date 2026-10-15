import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';

/**
 * Customers exist so that idempotency keys can be scoped per customer and every
 * order read can be ownership-checked. Passwords are hashed with scrypt from the
 * Node standard library rather than pulling in a native bcrypt dependency.
 */
const customerSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, default: '', maxlength: 200 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  },
  { timestamps: true, versionKey: false, collection: 'customers' },
);

customerSchema.index({ email: 1 }, { unique: true, name: 'email_unique' });

const KEY_LEN = 64;

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(plain, salt, KEY_LEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(plain, stored) {
  const [scheme, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = scryptSync(plain, salt, KEY_LEN);
  const expectedBuf = Buffer.from(expected, 'hex');
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

customerSchema.methods.toPublic = function toPublic() {
  return { id: String(this._id), email: this.email, name: this.name, role: this.role };
};

export const Customer = mongoose.model('Customer', customerSchema);
