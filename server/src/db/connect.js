import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import '../models/index.js'; // registers every model before indexes are synced
import { applyValidators } from './validators.js';

export async function connectDb(uri = config.MONGODB_URI, options = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  // Guard: a URI without a database name (e.g. mongodb://host/?replicaSet=rs0)
  // silently writes to MongoDB's default 'test' database. Fail loudly here so
  // the operator hears about it at startup, not at 3am when the orders
  // collection is mysteriously empty.
  try {
    const parsed = new URL(uri);
    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (!dbName) {
      throw new Error(
        `MONGODB_URI has no database name in its path. ` +
          `Append the name before the query string, e.g. ...mongodb.net/orders?...`,
      );
    }
  } catch (uriErr) {
    // Re-throw URL parse errors with context too.
    if (!uriErr.message.includes('MONGODB_URI')) {
      throw new Error(`MONGODB_URI is not a valid URL: ${uri}`);
    }
    throw uriErr;
  }

  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 20_000,
      // 200 concurrent checkout requests each hold a connection briefly; the
      // default pool of 100 would queue them behind each other and inflate p95.
      maxPoolSize: 50,
      // Required for the slow-query log below. The driver defaults
      // `monitorCommands` to FALSE, so the listeners are silently inert without
      // this — measured, not assumed: with it off, `commandSucceeded` fires zero
      // times and the slow-query log is dead code that looks alive.
      monitorCommands: true,
      ...options,
    });
  } catch (err) {
    // Surface the single most common deployment mistake with an actionable hint
    // instead of a 20-second timeout and an opaque MongoDB driver stack trace.
    if (isReplicaSetError(err) || /requires a replica set/i.test(err?.message ?? '')) {
      throw new Error(
        `MongoDB must be a replica set for transactions. ` +
          `Locally: run \`npm run dev:db\`. ` +
          `In production: use MongoDB Atlas (any tier) or start mongod with --replSet rs0. ` +
          `Original error: ${err.message}`,
      );
    }
    if (/ECONNREFUSED|getaddrinfo|failed to connect/i.test(err?.message ?? '')) {
      throw new Error(
        `Could not reach MongoDB at ${uri}. ` +
          `Locally: is \`npm run dev:db\` running? ` +
          `In production: check MONGODB_URI and network-access rules. ` +
          `Original error: ${err.message}`,
      );
    }
    throw err;
  }

  // Order matters: the collections must exist (with validators) before indexes
  // are built, so a test suite cannot accidentally run without the backstop.
  await applyValidators(mongoose.connection.db);
  await syncIndexes();
  attachSlowQueryLogging(mongoose.connection);

  logger.info('database connected', { db: mongoose.connection.name });
  return mongoose.connection;
}

const monitoredClients = new WeakSet();

/**
 * Slow-query logging (plan §9), via the driver's command monitoring.
 *
 * The driver's own `duration` is used rather than a client-side timer wrapped
 * around the call. Two reasons: it measures what the SERVER spent, which is what
 * a slow-query log is for, and a client-side timer would also include time
 * queued waiting for a free connection — so under load, a saturated connection
 * pool would report every query as slow and drown the signal this exists to
 * provide.
 *
 * Threshold is `SLOW_QUERY_MS` (default 250 ms).
 */
export function attachSlowQueryLogging(connection = mongoose.connection) {
  const client = connection.getClient?.();
  if (!client || monitoredClients.has(client)) return connection;
  monitoredClients.add(client);

  const report = (event) => {
    if (typeof event?.duration !== 'number' || event.duration < config.SLOW_QUERY_MS) return;
    logger.warn('slow query', {
      command: event.commandName,
      durationMs: Math.round(event.duration),
      database: event.databaseName,
      // The driver's own id, so this can be correlated with driver-level traces.
      driverRequestId: event.requestId,
    });
  };

  client.on('commandSucceeded', report);
  client.on('commandFailed', report);
  return connection;
}

export async function syncIndexes() {
  const synced = [];
  for (const [name, model] of Object.entries(mongoose.models)) {
    await model.syncIndexes();
    synced.push(name);
  }
  logger.debug('indexes synced', { models: synced });
  return synced;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export function isReplicaSetError(err) {
  return /Transaction numbers are only allowed on a replica set/i.test(err?.message ?? '');
}
