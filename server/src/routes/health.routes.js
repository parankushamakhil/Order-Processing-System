import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

/**
 * Liveness + readiness in one endpoint.
 *
 * Why check the database here instead of a separate /readyz:
 * Platform probes (Render, Docker HEALTHCHECK, Kubernetes) almost always poll a
 * single path. If that path ignores the database, a container that lost its
 * MongoDB connection is considered healthy and keeps receiving traffic — which
 * means every checkout crashes with a connection error until a human notices.
 *
 * The ping is a single driver round-trip (~1 ms on a warm connection). The cost
 * is negligible against a 15-30 s probe interval.
 */
router.get('/healthz', async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  let dbOk = false;
  try {
    if (connected) {
      await mongoose.connection.db.admin().command({ ping: 1 });
      dbOk = true;
    }
  } catch {
    dbOk = false;
  }

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    data: {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected' : 'unreachable',
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

/** Readiness: alias kept for operators who probe /readyz explicitly. */
router.get('/readyz', async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  let ping = false;
  try {
    if (connected) {
      await mongoose.connection.db.admin().command({ ping: 1 });
      ping = true;
    }
  } catch {
    ping = false;
  }
  const ready = connected && ping;
  res.status(ready ? 200 : 503).json({
    data: { ready, database: { connected, ping } },
  });
});

export default router;
