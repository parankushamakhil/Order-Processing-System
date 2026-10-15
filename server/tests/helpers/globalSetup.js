import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const URI_FILE = path.resolve(here, '../../.test-mongo-uri');

/**
 * A REAL MongoDB, started as a REPLICA SET.
 *
 * This is not optional. Multi-document transactions are unavailable on a
 * standalone deployment, so every transaction test would fail with an opaque
 * "Transaction numbers are only allowed on a replica set member or mongos".
 * Starting a replica set is therefore a gate: it is proven before any
 * application code depends on it, and the probe below fails loudly here rather
 * than mysteriously in the first test that needs a transaction.
 *
 * The URI reaches the workers through a file, because globalSetup and the test
 * workers are separate processes.
 */
export default async function globalSetup() {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  const uri = replSet.getUri();
  fs.writeFileSync(URI_FILE, uri, 'utf8');

  // Prove transactions work before any test relies on them.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  const Probe = mongoose.models.Probe ?? mongoose.model('Probe', new mongoose.Schema({ ok: Boolean }));
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Probe.create([{ ok: true }], { session });
    });
  } catch (err) {
    await session.endSession().catch(() => {});
    await mongoose.disconnect();
    await replSet.stop();
    throw new Error(
      `Replica set started but transactions do not work, so the whole suite would be ` +
        `meaningless. Original error: ${err?.message}`,
    );
  }
  await session.endSession();
  await mongoose.disconnect();

  return async () => {
    await replSet.stop();
    if (fs.existsSync(URI_FILE)) fs.rmSync(URI_FILE);
  };
}
