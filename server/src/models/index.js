/**
 * Barrel import so every model is registered on the Mongoose connection before
 * db/connect.js syncs indexes. Importing this file is what makes
 * `mongoose.models` complete.
 */
export { Product } from './Product.js';
export { Order } from './Order.js';
export { IdempotencyKey, IDEMPOTENCY_STATUS } from './IdempotencyKey.js';
export { PaymentAttempt, PAYMENT_STATUS } from './PaymentAttempt.js';
export { Customer, hashPassword, verifyPassword } from './Customer.js';
export { Counter, nextOrderNumber } from './Counter.js';
