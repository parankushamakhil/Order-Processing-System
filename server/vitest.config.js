import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Concurrency tests share one database and one Mongo instance, so files run
    // serially, in a single fork. A guarantee that only holds when tests are
    // isolated from each other is not the guarantee we are trying to prove.
    //
    // singleFork also means one Mongo connection for the whole run, which
    // removes a real race: two workers booting simultaneously would both try to
    // create the same collection with a validator.
    pool: 'forks',
    fileParallelism: false,
    forks: { singleFork: true },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    globalSetup: ['./tests/helpers/globalSetup.js'],
    setupFiles: ['./tests/helpers/setup.js'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-secret-value-0123456789',
      WEBHOOK_SECRET: 'test-webhook-secret',
      // Small but non-zero, so the concurrent paths are actually exercised.
      PAYMENT_LATENCY_MS: '5',
      PAYMENT_FAILURE_RATE: '0',
      // Long enough that concurrent duplicates coalesce onto the winner's
      // response instead of racing to a 409.
      IDEMPOTENCY_WAIT_MS: '5000',
      MAX_RESERVE_ATTEMPTS: '2',
    },
  },
});
