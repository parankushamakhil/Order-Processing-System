/**
 * A persistent local MongoDB REPLICA SET for development.
 *
 * There is no Docker or system mongod in this environment, and a standalone
 * server cannot run transactions at all — so the same mongodb-memory-server
 * binary that backs the test suite also backs local development. Run it, then
 * point the API at the URI it prints.
 *
 * It writes the URI to server/.dev-mongo-uri so a second process can pick it up
 * without copying anything by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const URI_FILE = path.resolve(here, '../.dev-mongo-uri');
const DB_PATH = path.resolve(here, '../.dev-mongo-data');

fs.mkdirSync(DB_PATH, { recursive: true });

const replSet = await MongoMemoryReplSet.create({
  replSet: {
    count: 1,
    storageEngine: 'wiredTiger',
    dbPath: DB_PATH,
  },
});

const baseUri = replSet.getUri();

// MongoMemoryReplSet.getUri() returns the base URI without a database path
// (e.g. mongodb://127.0.0.1:PORT/?replicaSet=testset). Without the explicit
// /orders path the server and every seed script each land in the default 'test'
// database — they work, but they are all talking to the wrong place.
const url = new URL(baseUri);
url.pathname = '/orders';
const uri = url.toString();

fs.writeFileSync(URI_FILE, uri, 'utf8');

process.stdout.write(`\nDEV MONGO READY\nURI_FILE=${URI_FILE}\nURI=${uri}\n\n`);

const shutdown = async (signal) => {
  process.stdout.write(`\nStopping dev mongo (${signal})…\n`);
  // doCleanup: false keeps the data directory for the next run.
  await replSet.stop({ doCleanup: false });
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
