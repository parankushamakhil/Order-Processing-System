import { createApp } from './app.js';
import { config, serveClient } from './config/index.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { logger } from './lib/logger.js';
import { startReaper, stopReaper } from './services/expiry.service.js';

const app = createApp();

try {
  await connectDb();
} catch (err) {
  // Startup errors are already enriched with operator hints inside connectDb().
  // Log clearly and exit non-zero so the platform restarts the process (or
  // stops retrying a misconfiguration that will never fix itself).
  logger.error('startup failed: could not connect to the database', {
    error: err.message,
  });
  process.exit(1);
}
startReaper();

const server = app.listen(config.PORT, () => {
  // PORT=0 means "let the OS pick", so the configured value is not the port the
  // process is reachable on. Log the bound one — a startup line that says 0 is a
  // startup line that tells nobody where the server is.
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.PORT;

  logger.info('api listening', {
    port,
    ...(port === config.PORT ? {} : { requestedPort: config.PORT }),
    env: config.NODE_ENV,
    serveClient: serveClient,
    reservationTtlMs: config.RESERVATION_TTL_MS,
    paymentLeaseMs: config.PAYMENT_LEASE_MS,
  });
});

/**
 * Graceful shutdown: stop accepting, drain in-flight requests, close the
 * database. A checkout interrupted mid-flight does not leak its reservation —
 * the payment lease lapses and the reaper (or the next buyer's lazy reclaim)
 * returns the stock.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  stopReaper();

  const force = setTimeout(() => {
    logger.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(async () => {
    await disconnectDb();
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { reason: reason?.message ?? String(reason) });
});
