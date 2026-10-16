import { logger } from '../lib/logger.js';

/**
 * Collection validators: the storage-layer backstop (ADR-02, defence layer 5).
 *
 * Application bugs are possible, so the collection itself refuses to hold
 * impossible data. `available: { minimum: 0 }` means that even if the
 * conditional filter in domain/inventory.js were written incorrectly, MongoDB
 * rejects the resulting negative counter with a WriteError.
 *
 * Verified empirically before this code was written: a naive
 * `$inc: { available: -5 }` against a document with `available: 1` is rejected
 * with "Document failed validation", while a legitimate conditional decrement
 * still succeeds.
 *
 * Applied through an idempotent script rather than Mongoose schema options,
 * because `collMod` is version-independent and works in dev, CI, tests and
 * production identically.
 */

const intOrLong = { bsonType: ['int', 'long'] };

export const PRODUCT_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['sku', 'name', 'priceMinor', 'currency', 'onHand', 'reserved', 'available'],
    properties: {
      sku: { bsonType: 'string', minLength: 1 },
      name: { bsonType: 'string', minLength: 1 },
      priceMinor: { ...intOrLong, minimum: 0 },
      currency: { enum: ['INR'] },
      onHand: { ...intOrLong, minimum: 0 },
      reserved: { ...intOrLong, minimum: 0 },
      // The anti-oversell backstop: an inventory counter can never go negative.
      available: { ...intOrLong, minimum: 0 },
      isActive: { bsonType: 'bool' },
    },
  },
};

export const ORDER_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['customerId', 'status', 'items', 'pricing', 'currency'],
    properties: {
      currency: { enum: ['INR'] },
      items: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['productId', 'quantity', 'unitPriceMinor', 'lineTotalMinor'],
          properties: {
            quantity: { ...intOrLong, minimum: 1 },
            unitPriceMinor: { ...intOrLong, minimum: 0 },
            lineTotalMinor: { ...intOrLong, minimum: 0 },
          },
        },
      },
      pricing: {
        bsonType: 'object',
        required: ['subtotalMinor', 'totalMinor'],
        properties: {
          subtotalMinor: { ...intOrLong, minimum: 0 },
          discountMinor: { ...intOrLong, minimum: 0 },
          taxMinor: { ...intOrLong, minimum: 0 },
          shippingMinor: { ...intOrLong, minimum: 0 },
          // A priced order can never have a negative total (ADR-01).
          totalMinor: { ...intOrLong, minimum: 0 },
        },
      },
    },
  },
};

export const COLLECTION_VALIDATORS = {
  products: PRODUCT_VALIDATOR,
  orders: ORDER_VALIDATOR,
};

async function collectionExists(db, name) {
  return Boolean(await db.listCollections({ name }, { nameOnly: true }).hasNext());
}

/**
 * Idempotent: safe to run on every boot and in every test setup.
 * `validationAction: 'error'` in all environments — a corrupted inventory
 * record is worse than a failed request. (Use 'warn' only during a rolling
 * migration that must backfill existing documents.)
 */
export async function applyValidators(db = null) {
  const database = db ?? (await import('mongoose')).default.connection.db;
  if (!database) throw new Error('applyValidators requires a connected database');

  const settings = { validationLevel: 'strict', validationAction: 'error' };
  const applied = [];

  for (const [name, validator] of Object.entries(COLLECTION_VALIDATORS)) {
    if (await collectionExists(database, name)) {
      await database.command({ collMod: name, validator, ...settings });
    } else {
      try {
        await database.createCollection(name, { validator, ...settings });
      } catch (err) {
        // NamespaceExists (code 48): another process created it between the
        // check and the create. That is exactly the condition we would have
        // handled by using collMod, so fall through to it rather than failing
        // a boot because two instances started at the same moment.
        if (err?.codeName !== 'NamespaceExists' && err?.code !== 48) throw err;
        await database.command({ collMod: name, validator, ...settings });
      }
    }
    applied.push(name);
  }
  logger.debug('collection validators applied', { collections: applied });
  return applied;
}
