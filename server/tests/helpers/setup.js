import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const URI_FILE = path.resolve(here, '../../.test-mongo-uri');

// Must happen before anything imports src/config, which reads process.env at
// import time. Hence the dynamic imports below rather than top-level ones.
process.env.MONGODB_URI = fs.readFileSync(URI_FILE, 'utf8').trim();
process.env.NODE_ENV = 'test';

let mongoose;
let connectDb;
let db;
let checkInvariants;
let resetRateLimits;
let resetGateway;

/** Some tests deliberately inspect a broken state; they opt out explicitly. */
let invariantsEnabled = true;

export function setInvariantCheckEnabled(enabled) {
  invariantsEnabled = enabled;
}

export async function expectInvariants(overrides = {}) {
  const problems = await checkInvariants(overrides);
  if (problems.length > 0) {
    throw new Error(
      `Invariant violation (${problems.length}):\n${JSON.stringify(problems, null, 2)}`,
    );
  }
  return problems;
}

beforeAll(async () => {
  ({ default: mongoose } = await import('mongoose'));
  ({ connectDb } = await import('../../src/db/connect.js'));
  ({ checkInvariants } = await import('../../src/domain/invariants.js'));
  ({ resetRateLimits } = await import('../../src/middleware/rateLimit.js'));
  ({ resetGateway } = await import('../../src/services/payments/testGateway.js'));

  await connectDb(process.env.MONGODB_URI);
  db = mongoose.connection.db;

  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  if (collections.length === 0) {
    throw new Error('No collections after connectDb — validators were not applied');
  }
});

beforeEach(async () => {
  invariantsEnabled = true;
  resetRateLimits();
  resetGateway();

  // deleteMany rather than drop: dropping a collection also drops its
  // $jsonSchema validator, which would silently remove the storage-layer
  // backstop from every subsequent test.
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

/**
 * The global invariant hook.
 *
 * Every integration and concurrency test ends by asserting I1-I7, so any test
 * that leaves the database inconsistent fails even if it was checking something
 * else entirely. This is what keeps the consistency guarantee true as the
 * codebase grows, rather than only on the day it was written.
 */
afterEach(async () => {
  if (!invariantsEnabled) return;
  const problems = await checkInvariants();
  if (problems.length > 0) {
    throw new Error(
      `Test left the database inconsistent:\n${JSON.stringify(problems, null, 2)}`,
    );
  }
});

afterAll(async () => {
  const { disconnectDb } = await import('../../src/db/connect.js');
  await disconnectDb();
});
