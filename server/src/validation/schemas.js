import { z } from 'zod';
import { config } from '../config/index.js';
import { DISCOUNT_CODES } from '../domain/pricing.js';
import { PAYMENT_TOKENS } from '../services/payments/index.js';

/** Express route params are untrusted strings; cast them explicitly. */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'must be a 24-character hex id');

export const idempotencyKeySchema = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(200)
  // Bounded charset/blocks control characters and header-injection attempts.
  .regex(/^[A-Za-z0-9._:-]+$/, 'may only contain letters, digits, dot, colon, underscore and hyphen');

export const registerSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(200),
    name: z.string().max(200).optional(),
    // `role` is deliberately NOT accepted: allowing a client to choose its own
    // role would make the admin endpoints decorative.
  })
  .strict();

export const loginSchema = z
  .object({ email: z.string().email().max(254), password: z.string().min(8).max(200) })
  .strict();

export const checkoutSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: objectIdSchema,
            quantity: z.number().int('must be an integer').positive().max(config.MAX_LINE_QUANTITY),
          })
          .strict(),
      )
      .min(1, 'a cart must contain at least one line item')
      .max(config.MAX_CART_LINES),
    paymentMethod: z
      .object({ type: z.literal('card'), token: z.enum(PAYMENT_TOKENS) })
      .strict(),
    discountCode: z.enum(DISCOUNT_CODES).nullish(),
    // Optional client-side assertion. The server's number always wins; a
    // mismatch returns 409 PRICE_CHANGED rather than silently charging more.
    expectedTotalMinor: z.number().int().nonnegative().nullish(),
  })
  .strict();

export const productCreateSchema = z
  .object({
    sku: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    priceMinor: z.number().int().nonnegative(),
    onHand: z.number().int().nonnegative().max(1_000_000).default(0),
    // reserved/available are deliberately absent: they are owned by the
    // inventory primitives and must never be settable from the API.
  })
  .strict();

export const productUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    priceMinor: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const restockSchema = z
  .object({ units: z.number().int().positive().max(1_000_000) })
  .strict();

export const checkoutParamsSchema = z.object({ id: objectIdSchema }).strict();

export const productListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(config.MAX_PAGE_SIZE).default(20),
    q: z.string().max(200).optional(),
    inStock: z.enum(['true', 'false']).optional(),
    includeInactive: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const orderListQuerySchema = z
  .object({ status: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

export const webhookSchema = z
  .object({
    providerRef: z.string().min(1).max(200),
    orderId: objectIdSchema,
    status: z.enum(['succeeded', 'declined', 'failed']),
    // Optional, but when present it is checked against the order total so a
    // provider reporting a different figure is surfaced rather than applied.
    amountMinor: z.number().int().nonnegative().nullish(),
    providerMessage: z.string().max(500).nullish(),
  })
  .strict();
