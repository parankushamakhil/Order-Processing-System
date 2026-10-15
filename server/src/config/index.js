// Must come first: it populates process.env from `.env` before the schema below
// reads it. Real environment variables take precedence over the file.
import './loadEnv.js';
import { z } from 'zod';

/**
 * Every tunable in the system lives here and is validated at boot, so a missing
 * MONGODB_URI or a nonsensical RESERVATION_TTL fails at startup rather than at
 * 3am on the checkout path.
 *
 * NOTE for tests: services read `config.X` at call time rather than destructuring
 * at import time, so a test can mutate this object to exercise timing-dependent
 * paths without re-importing modules.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // 0 is accepted and means "let the OS pick an ephemeral port", which is
    // useful for local runs and for anything that binds a port to discover it.
    PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    MONGODB_URI: z
      .string()
      .min(1)
      .default('mongodb://127.0.0.1:27017/orders?replicaSet=rs0'),
    JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
    JWT_TTL: z.string().default('2h'),
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
    // Serve the built client from this process. On by default in production,
    // where one URL for the API and the SPA is the difference between a deploy
    // that works and a deploy with two moving parts and a CORS problem.
    // Off in dev (Vite serves it) and off in tests, where a catch-all static
    // handler would change what a 404 means.
    SERVE_CLIENT: z
      .enum(['true', 'false'])
      .default(() => (process.env.NODE_ENV === 'production' ? 'true' : 'false'))
      .transform((value) => value === 'true'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    // Commands slower than this are logged with their duration (§9).
    SLOW_QUERY_MS: z.coerce.number().int().min(0).default(250),

    // ---- inventory / checkout timing ----
    RESERVATION_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    PAYMENT_LEASE_MS: z.coerce.number().int().positive().default(30 * 1000),
    GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 1000),
    CLAIM_LEASE_MS: z.coerce.number().int().positive().default(30 * 1000),
    IDEMPOTENCY_WAIT_MS: z.coerce.number().int().min(0).default(2 * 1000),
    IDEMPOTENCY_RETENTION_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
    MAX_RESERVE_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
    // Plan 9.1 mitigation 2: answer an obviously-doomed request without opening
    // a transaction or contending for a write lock. Advisory only — correctness
    // still rests on the conditional $inc inside the transaction. Exposed as a
    // flag so `npm run bench` can MEASURE the difference instead of asserting it.
    // Parsed as an explicit enum because z.coerce.boolean() treats the string
    // "false" as true (it is non-empty), which is a classic configuration trap.
    CHECKOUT_FAST_FAIL: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    // ---- reaper ----
    REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 1000),
    REAPER_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(100),

    // ---- simulated gateway ----
    PAYMENT_LATENCY_MS: z.coerce.number().int().min(0).default(40),
    PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    WEBHOOK_SECRET: z.string().min(8).default('dev-webhook-secret'),

    // ---- limits ----
    MAX_CART_LINES: z.coerce.number().int().min(1).default(50),
    MAX_LINE_QUANTITY: z.coerce.number().int().min(1).default(100),
    CHECKOUT_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(600),
    MAX_PAGE_SIZE: z.coerce.number().int().min(1).default(100),
  })
  .superRefine((cfg, ctx) => {
    // ADR-08: a charge must always resolve before its own lease can lapse,
    // otherwise the reaper can expire an order that is mid-charge.
    if (cfg.GATEWAY_TIMEOUT_MS >= cfg.PAYMENT_LEASE_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['GATEWAY_TIMEOUT_MS'],
        message:
          `GATEWAY_TIMEOUT_MS (${cfg.GATEWAY_TIMEOUT_MS}) must be strictly less than ` +
          `PAYMENT_LEASE_MS (${cfg.PAYMENT_LEASE_MS})`,
      });
    }
  });

/**
 * An environment variable that is present but EMPTY is treated as unset.
 *
 * Without this, `.default()` never applies (Zod only defaults `undefined`, not
 * `''`) and a value like `PORT=` or `LOG_LEVEL=` becomes `0` or an invalid enum.
 * Deployment platforms and shells routinely export empty placeholders, so this
 * is a real failure mode rather than a hypothetical one — it was hit by this
 * project on its first test run.
 */
function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
  );
}

const parsed = schema.safeParse(cleanEnv(process.env));

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Fail fast and loudly: a misconfigured process must not start serving.
  process.stderr.write(`Invalid configuration:\n${detail}\n`);
  throw new Error('Invalid configuration');
}

export const config = parsed.data;

export const isTest = config.NODE_ENV === 'test';
export const isProd = config.NODE_ENV === 'production';
export const corsOrigins = config.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const serveClient = config.SERVE_CLIENT;

export const CHECKOUT_ENDPOINT = 'POST /api/checkout';
