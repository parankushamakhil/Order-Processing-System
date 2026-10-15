import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

/** Liveness: the process is up. Deliberately does not touch the database. */
router.get('/healthz', (req, res) => {
  res.json({ data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()) } });
});

/** Readiness: the process can serve traffic, i.e. the database answers. */
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
