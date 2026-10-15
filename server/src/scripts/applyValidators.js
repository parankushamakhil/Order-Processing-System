/**
 * Applies the $jsonSchema collection validators.
 *
 * Idempotent and version-independent: it uses collMod / createCollection rather
 * than relying on Mongoose schema options, so dev, CI, tests and production all
 * get exactly the same storage-layer constraints.
 *
 * Run directly (`npm run apply-validators`) or as a deploy step. connectDb()
 * also invokes it on every boot, so a fresh environment cannot start serving
 * without the anti-oversell backstop in place.
 */
import { COLLECTION_VALIDATORS } from '../db/validators.js';

export async function applyValidatorsTo(db) {
  const applied = [];
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  for (const [name, validator] of Object.entries(COLLECTION_VALIDATORS)) {
    if (existing.has(name)) {
      await db.command({
        collMod: name,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await db.createCollection(name, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }
    applied.push(name);
  }

  return applied;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isDirectRun) {
  const { connectDb } = await import('../db/connect.js');
  const { disconnectDb } = await import('../db/connect.js');
  const mongoose = (await import('mongoose')).default;

  await connectDb();
  const applied = await applyValidatorsTo(mongoose.connection.db);
  process.stdout.write(`Applied validators to: ${applied.join(', ')}\n`);
  await disconnectDb();
}
