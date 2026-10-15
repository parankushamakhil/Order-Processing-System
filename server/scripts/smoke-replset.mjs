// Phase 0 gate: prove the two riskiest environmental assumptions before any
// feature code depends on them.
//   1. A MongoDB replica set can run here (transactions are unavailable without one).
//   2. $jsonSchema with minimum: 0 actually rejects a negative counter — the
//      storage-layer backstop that makes overselling impossible (ADR-02).
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});
console.log('replica set up:', rs.getUri());

await mongoose.connect(rs.getUri());
const db = mongoose.connection.db;

// --- check 1: multi-document transaction works ---
const Tx = mongoose.model('SmokeTx', new mongoose.Schema({ n: Number, tag: String }));
await Tx.create({ n: 1, tag: 'a' });
const session = await mongoose.startSession();
try {
  await session.withTransaction(async () => {
    await Tx.updateOne({ tag: 'a' }, { $inc: { n: 1 } }, { session });
    await Tx.create([{ n: 99, tag: 'b' }], { session });
  });
} finally {
  await session.endSession();
}
const txRows = await Tx.find().sort({ n: 1 }).lean();
console.log('check 1 transactions:', txRows.map((r) => `${r.tag}=${r.n}`).join(' '));

// --- check 2: transaction abort rolls back every write ---
const s2 = await mongoose.startSession();
try {
  await s2.withTransaction(async () => {
    await Tx.updateOne({ tag: 'a' }, { $inc: { n: 100 } }, { session: s2 });
    throw new Error('deliberate abort');
  });
} catch {
  /* expected */
} finally {
  await s2.endSession();
}
const afterAbort = await Tx.findOne({ tag: 'a' }).lean();
console.log('check 2 abort rolled back:', afterAbort.n === 2 ? 'yes' : `NO (n=${afterAbort.n})`);

// --- check 3: $jsonSchema minimum:0 rejects a negative counter ---
await db.createCollection('smoke_products', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['available'],
      properties: { available: { bsonType: ['int', 'long'], minimum: 0 } },
    },
  },
  validationLevel: 'strict',
  validationAction: 'error',
});
const products = db.collection('smoke_products');
await products.insertOne({ available: 1 });
console.log('check 3a stored type:', (await products.findOne({})).available?.constructor?.name ?? typeof (await products.findOne({})).available);

let rejected = false;
try {
  await products.updateOne({}, { $inc: { available: -5 } });
} catch (err) {
  rejected = true;
  console.log('check 3b negative counter rejected:', err.message.slice(0, 90));
}
if (!rejected) {
  const doc = await products.findOne({});
  console.log('check 3b FAILED — counter went to', doc.available);
}
console.log('check 3c valid decrement still allowed:', (await products.updateOne({ available: { $gte: 1 } }, { $inc: { available: -1 } })).matchedCount === 1);

await mongoose.disconnect();
await rs.stop();

if (txRows.length === 2 && afterAbort.n === 2 && rejected) {
  console.log('\nGATE PASSED');
  process.exit(0);
}
console.log('\nGATE FAILED');
process.exit(1);
